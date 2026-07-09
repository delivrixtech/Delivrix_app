import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { CanvasLiveStateSnapshot } from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  handleSendRealEmailHttp,
  type SendRealEmailParams
} from "./send-email.ts";
import type {
  SmtpSshCommandInput,
  SmtpSshRunner
} from "./smtp-provisioning.ts";

const fixedNow = new Date("2026-05-31T18:00:00.000Z");
const approvalArtifactId = "artifact-send-real-email";
const approvalToken = "exec-send-real-email";
const safeBody = "Operational relay confirmation from Delivrix infrastructure.";

test("POST /v1/skills/send-real-email sends through swaks and stores redacted audit", async () => {
  const route = await routeHarness();
  const response = await route(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.deliveryStatus, "sent");
  assert.match(response.body.messageId, /^<delivrix-[a-z0-9-]{1,80}@sender\.example>$/);
  assert.equal(response.body.preValidations.spfPresent, true);
  assert.equal(response.body.preValidations.dkimPresent, true);
  assert.equal(response.body.preValidations.dmarcPresent, true);
  assert.equal(response.body.preValidations.postfixRunning, true);
  assert.equal(response.commands.every((command) => command.serverSlug === "mail-sender-example"), true);
  assert.equal(response.commands.some((command) => command.command.startsWith("swaks --to")), true);
  assert.equal(response.commands.some((command) => command.command.includes("/usr/sbin/sendmail")), false);

  const event = (await route.auditLog.list()).at(-1);
  assert.equal(event?.action, "oc.smtp.real_email_sent");
  assert.equal(event?.metadata.toAddressDomain, "operator.example");
  assert.equal(typeof event?.metadata.toAddressHash, "string");
  assert.equal(event?.metadata.subject, "Delivrix relay readiness report");
  assert.equal(event?.metadata.bodyLength, safeBody.length);
  assert.equal(typeof event?.metadata.bodyHash, "string");
  assert.equal("body" in (event?.metadata ?? {}), false);
  assert.equal("toAddress" in (event?.metadata ?? {}), false);
});

test("schema blocks subject spam flag words before SSH", async () => {
  const route = await routeHarness();
  const response = await route(validBody({ subject: "Quarterly test report" }));

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "subject_contains_spam_flag_word");
  assert.equal(response.commands.length, 0);
});

test("schema blocks body spam flag words before SSH", async () => {
  const route = await routeHarness();
  const response = await route(validBody({ body: "Lorem ipsum content that should never leave the handler." }));

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "body_contains_spam_flag_word");
  assert.equal(response.commands.length, 0);
});

test("missing SPF blocks before SSH", async () => {
  const route = await routeHarness({
    resolveTxt: async (domain) => {
      if (domain === "sender.example") return [["not-spf"]];
      if (domain === "default._domainkey.sender.example") return [["v=DKIM1; p=abc"]];
      if (domain === "_dmarc.sender.example") return [["v=DMARC1; p=none"]];
      return [];
    }
  });
  const response = await route(validBody());

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "email_auth_incomplete");
  assert.deepEqual(response.body.details, { spf: false, dkim: true, dmarc: true });
  assert.equal(response.commands.length, 0);
});

test("missing DKIM blocks with details before SSH", async () => {
  const route = await routeHarness({
    resolveTxt: async (domain) => {
      if (domain === "sender.example") return [["v=spf1 ip4:192.0.2.44 -all"]];
      if (domain === "default._domainkey.sender.example") return [["no-dkim"]];
      if (domain === "_dmarc.sender.example") return [["v=DMARC1; p=none"]];
      return [];
    }
  });
  const response = await route(validBody());

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "email_auth_incomplete");
  assert.deepEqual(response.body.details, { spf: true, dkim: false, dmarc: true });
  assert.equal(response.commands.length, 0);
});

test("non-default DKIM selector is used for prevalidation", async () => {
  const queried: string[] = [];
  const route = await routeHarness({
    resolveTxt: async (domain) => {
      queried.push(domain);
      if (domain === "sender.example") return [["v=spf1 ip4:192.0.2.44 -all"]];
      if (domain === "s2026a._domainkey.sender.example") return [["v=DKIM1; p=abc"]];
      if (domain === "_dmarc.sender.example") return [["v=DMARC1; p=none"]];
      return [];
    }
  });
  const response = await route(validBody({ selector: "s2026a" }));

  assert.equal(response.statusCode, 200);
  assert.equal(queried.includes("s2026a._domainkey.sender.example"), true);
  assert.equal(queried.includes("default._domainkey.sender.example"), false);
});

test("idempotency key suppresses duplicate real send before SSH", async () => {
  const route = await routeHarness();
  await appendSentEvent(route.auditLog, {
    occurredAt: "2026-05-31T17:59:30.000Z",
    idempotencyKey: "run-idem-1",
    runId: "run-idem-1",
    messageId: "<delivrix-existing@sender.example>"
  });

  const response = await route(validBody({
    idempotencyKey: "run-idem-1",
    runId: "run-idem-1"
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.messageId, "<delivrix-existing@sender.example>");
  assert.equal(response.body.postfixLogTail, "idempotent_replay_suppressed");
  assert.equal(response.commands.length, 0);
});

test("failed send (decision reject) is not replayed by idempotency", async () => {
  const route = await routeHarness();
  await appendSentEvent(route.auditLog, {
    occurredAt: "2026-05-31T17:59:30.000Z",
    idempotencyKey: "run-idem-2",
    runId: "run-idem-2",
    messageId: "<delivrix-failed@sender.example>",
    decision: "reject"
  });

  const response = await route(validBody({
    idempotencyKey: "run-idem-2",
    runId: "run-idem-2"
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.notEqual(response.body.messageId, "<delivrix-failed@sender.example>");
  assert.notEqual(response.body.postfixLogTail, "idempotent_replay_suppressed");
  assert.equal(response.commands.some((command) => command.command.startsWith("swaks --to")), true);
});

test("successful send reconciles failed run-states of the sending domain", async () => {
  const route = await routeHarness();
  await writeFailedRunState(route.workspace, "run-ghost", "sender.example");
  await writeFailedRunState(route.workspace, "run-other-domain", "otro.example");

  const response = await route(validBody());
  assert.equal(response.statusCode, 200);

  const reconciledRaw = await readRunStateRaw(route.workspace, "run-ghost");
  assert.equal(reconciledRaw.status, "completed");
  assert.equal((reconciledRaw.reconciledBy as { source?: string }).source, "send_real_email");
  assert.equal(reconciledRaw.retryableFailure, undefined);
  assert.equal(reconciledRaw.failureCategory, undefined);
  assert.equal(reconciledRaw.finalDeliveryStatus, "delivered");

  const untouched = await readRunStateRaw(route.workspace, "run-other-domain");
  assert.equal(untouched.status, "failed");

  const reconcileAudit = (await route.auditLog.list()).find((event) => event.action === "oc.smtp.run_state_reconciled");
  assert.ok(reconcileAudit);
  assert.equal(reconcileAudit.metadata.runId, "run-ghost");
  assert.equal(reconcileAudit.metadata.previousStatus, "failed");
  assert.equal(reconcileAudit.metadata.domain, "sender.example");
});

test("failed send does NOT reconcile failed run-states", async () => {
  const route = await routeHarness({
    runnerFactory: (commands) => mockRunner(commands, {
      sendStdout: "550 5.1.1 recipient rejected",
      sendExitCode: 1
    })
  });
  await writeFailedRunState(route.workspace, "run-ghost", "sender.example");

  const response = await route(validBody());
  assert.equal(response.statusCode, 502);

  const raw = await readRunStateRaw(route.workspace, "run-ghost");
  assert.equal(raw.status, "failed");
  assert.equal((await route.auditLog.list()).some((event) => event.action === "oc.smtp.run_state_reconciled"), false);
});

test("idempotent replay also reconciles failed run-states of the domain", async () => {
  const route = await routeHarness();
  await appendSentEvent(route.auditLog, {
    occurredAt: "2026-05-31T17:59:30.000Z",
    idempotencyKey: "run-idem-3",
    runId: "run-idem-3",
    messageId: "<delivrix-existing@sender.example>"
  });
  await writeFailedRunState(route.workspace, "run-ghost", "sender.example");

  const response = await route(validBody({
    idempotencyKey: "run-idem-3",
    runId: "run-idem-3"
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.postfixLogTail, "idempotent_replay_suppressed");

  const raw = await readRunStateRaw(route.workspace, "run-ghost");
  assert.equal(raw.status, "completed");
  assert.equal(raw.finalEmailMessageId, "<delivrix-existing@sender.example>");
  const reconcileAudit = (await route.auditLog.list()).find((event) => event.action === "oc.smtp.run_state_reconciled");
  assert.ok(reconcileAudit);
});

test("Postfix not running blocks before send command", async () => {
  const route = await routeHarness({
    runnerFactory: (commands) => mockRunner(commands, {
      run: async (input) => {
        commands.push(input);
        if (input.command.startsWith("systemctl is-active postfix")) {
          return { stdout: "inactive", stderr: "", exitCode: 3 };
        }
        throw new Error("send command should not run");
      }
    })
  });
  const response = await route(validBody());

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "postfix_not_running");
  assert.equal(response.commands.length, 1);
  assert.equal(response.commands[0].command.startsWith("systemctl is-active postfix"), true);
});

test("rate limit rejects the sixth email in the same hour before SSH", async () => {
  const route = await routeHarness();
  await appendSentEvents(route.auditLog, 5);

  const response = await route(validBody());

  assert.equal(response.statusCode, 429);
  assert.equal(response.body.error, "rate_limit_exceeded");
  assert.deepEqual(response.body.details, { maxPerHour: 5, recentCount: 5 });
  assert.equal(response.commands.length, 0);
});

test("writes rate-limit reservation before the sent audit event", async () => {
  const route = await routeHarness();
  const response = await route(validBody());

  assert.equal(response.statusCode, 200);
  const events = await route.auditLog.list();
  const reservationIndex = events.findIndex((event) => event.action === "oc.smtp.real_email_rate_limit_reserved");
  const sentIndex = events.findIndex((event) => event.action === "oc.smtp.real_email_sent");
  const reservation = events[reservationIndex];
  const sent = events[sentIndex];

  assert.equal(reservationIndex > -1, true);
  assert.equal(sentIndex > reservationIndex, true);
  assert.equal(sent?.metadata.rateLimitReservationEventId, reservation?.id);
});

test("concurrent rate reservation blocks before a second SSH send", async () => {
  let releaseSend!: () => void;
  let markSendStarted!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    markSendStarted = resolve;
  });
  const sendHold = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const route = await routeHarness({
    runnerFactory: (commands) => mockRunner(commands, {
      run: async (input) => {
        commands.push(input);
        if (input.command.startsWith("systemctl is-active postfix")) {
          return { stdout: "active\nLISTEN 0 4096 0.0.0.0:25", stderr: "", exitCode: 0 };
        }
        if (input.command.startsWith("command -v swaks")) {
          return { stdout: "SWAKS_AVAILABLE\n", stderr: "", exitCode: 0 };
        }
        if (input.command.startsWith("swaks --to")) {
          markSendStarted();
          await sendHold;
          return { stdout: "250 2.0.0 Ok: queued as ABC123", stderr: "", exitCode: 0 };
        }
        if (input.command.startsWith("tail -200 /var/log/mail.log")) {
          return {
            stdout: "postfix/smtp[42]: from=<ops@sender.example>, to=<recipient@operator.example>, status=sent",
            stderr: "",
            exitCode: 0
          };
        }
        throw new Error(`Unexpected SSH command: ${input.command}`);
      }
    })
  });
  await appendSentEvents(route.auditLog, 4);

  const first = route(validBody());
  await sendStarted;

  const second = await route(validBody());

  assert.equal(second.statusCode, 429);
  assert.equal(second.body.error, "rate_limit_exceeded");
  assert.deepEqual(second.body.details, { maxPerHour: 5, recentCount: 5 });
  assert.equal(route.commands.filter((command) => command.command.startsWith("swaks --to")).length, 1);

  releaseSend();
  assert.equal((await first).statusCode, 200);
});

test("counts reserved completed sends only once for hourly rate limit", async () => {
  const route = await routeHarness();
  const reservation = await appendRateLimitReservation(route.auditLog);
  await appendSentEvent(route.auditLog, {
    occurredAt: "2026-05-31T17:57:00.000Z",
    reservationEventId: reservation.id
  });
  await appendSentEvents(route.auditLog, 3);

  const response = await route(validBody());

  assert.equal(response.statusCode, 200);
});

test("burner recipient is blocked before DNS and SSH", async () => {
  const dnsCalls: string[] = [];
  const route = await routeHarness({
    resolveTxt: async (domain) => {
      dnsCalls.push(domain);
      return [];
    }
  });
  const response = await route(validBody({ toAddress: "recipient@mailinator.com" }));

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "recipient_burner");
  assert.equal(dnsCalls.length, 0);
  assert.equal(response.commands.length, 0);
});

test("swaks 550 rejection returns 502 and emits redacted audit", async () => {
  const route = await routeHarness({
    runnerFactory: (commands) => mockRunner(commands, {
      sendStdout: "550 5.1.1 recipient rejected",
      sendExitCode: 1
    })
  });
  const response = await route(validBody());

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.deliveryStatus, "rejected");

  const event = (await route.auditLog.list()).at(-1);
  assert.equal(event?.action, "oc.smtp.real_email_sent");
  assert.equal(event?.decision, "reject");
  assert.equal(event?.metadata.deliveryStatus, "rejected");
  assert.equal("body" in (event?.metadata ?? {}), false);
  assert.equal("toAddress" in (event?.metadata ?? {}), false);
});

test("response postfix log tail redacts sender and recipient", async () => {
  const route = await routeHarness();
  const response = await route(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.postfixLogTail.includes("ops@sender.example"), false);
  assert.equal(response.body.postfixLogTail.includes("recipient@operator.example"), false);
  assert.equal(response.body.postfixLogTail.includes("from=<REDACTED>"), true);
  assert.equal(response.body.postfixLogTail.includes("to=<REDACTED>"), true);
});

test("invalid approval token blocks before DNS and SSH", async () => {
  const dnsCalls: string[] = [];
  const route = await routeHarness({
    approved: false,
    resolveTxt: async (domain) => {
      dnsCalls.push(domain);
      return validDns(domain);
    }
  });
  const response = await route(validBody());

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "approval_invalid");
  assert.equal(dnsCalls.length, 0);
  assert.equal(response.commands.length, 0);
});

test("subject shell characters stay in stdin and never in SSH command", async () => {
  const route = await routeHarness();
  const response = await route(validBody({ subject: "'; rm -rf / #" }));

  assert.equal(response.statusCode, 200);
  const sendCommand = response.commands.find((command) => command.command.startsWith("swaks --to"));
  assert.ok(sendCommand);
  assert.equal(sendCommand.command.includes("rm -rf"), false);
  assert.equal(sendCommand.stdin?.includes("Subject: '; rm -rf / #"), true);
});

test("sendmail fallback is used when swaks is missing", async () => {
  const route = await routeHarness({
    runnerFactory: (commands) => mockRunner(commands, { swaksAvailable: false })
  });
  const response = await route(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.commands.some((command) => command.command.startsWith("/usr/sbin/sendmail -f")), true);
  assert.equal(response.commands.some((command) => command.command.startsWith("swaks --to")), false);
});

test("kill switch blocks send_real_email before approval lookup effects beyond reads", async () => {
  const route = await routeHarness({ killSwitchEnabled: true });
  const response = await route(validBody());

  assert.equal(response.statusCode, 423);
  assert.equal(response.body.error, "kill_switch_armed");
  assert.equal(response.commands.length, 0);
});

async function routeHarness(input: {
  approved?: boolean;
  killSwitchEnabled?: boolean;
  resolveTxt?: (domain: string) => Promise<string[][]>;
  runnerFactory?: (commands: SmtpSshCommandInput[]) => SmtpSshRunner;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "send-email-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  await workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-sender-example",
      hostname: "mail.sender.example",
      ipv4: "192.0.2.44",
      status: "running"
    }]
  }));

  const approved = input.approved ?? true;
  if (approved) {
    await appendApproval(auditLog, approvalArtifactId, approvalToken);
  }
  const state = approved
    ? canvasState([{ artifactId: approvalArtifactId, executionId: approvalToken, approvedAt: "2026-05-31T17:59:00.000Z" }])
    : canvasState([]);
  const commands: SmtpSshCommandInput[] = [];
  const sshRunner = input.runnerFactory?.(commands) ?? mockRunner(commands);

  const route = async (body: unknown): Promise<{
    statusCode: number;
    body: any;
    commands: SmtpSshCommandInput[];
  }> => {
    const response = captureResponse();
    await handleSendRealEmailHttp({
      request: requestWithJson(body),
      response: response as unknown as ServerResponse,
      auditLog,
      sshRunner,
      workspace,
      readCanvasState: () => state,
      readKillSwitch: () => ({ enabled: input.killSwitchEnabled ?? false }),
      resolveTxt: input.resolveTxt ?? validDns,
      now: () => fixedNow
    });
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body),
      commands: [...commands]
    };
  };

  return Object.assign(route, { auditLog, workspace, commands });
}

function mockRunner(
  commands: SmtpSshCommandInput[],
  options: {
    isConfigured?: () => boolean;
    swaksAvailable?: boolean;
    sendStdout?: string;
    sendExitCode?: number;
    run?: (input: SmtpSshCommandInput) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  } = {}
): SmtpSshRunner {
  return {
    isConfigured: options.isConfigured ?? (() => true),
    run: options.run ?? (async (input) => {
      commands.push(input);
      if (input.command.startsWith("systemctl is-active postfix")) {
        return { stdout: "active\nLISTEN 0 4096 0.0.0.0:25", stderr: "", exitCode: 0 };
      }
      if (input.command.startsWith("command -v swaks")) {
        return {
          stdout: options.swaksAvailable === false ? "SWAKS_MISSING\n" : "SWAKS_AVAILABLE\n",
          stderr: "",
          exitCode: 0
        };
      }
      if (input.command.startsWith("swaks --to") || input.command.startsWith("/usr/sbin/sendmail -f")) {
        return {
          stdout: options.sendStdout ?? "250 2.0.0 Ok: queued as ABC123",
          stderr: "",
          exitCode: options.sendExitCode ?? 0
        };
      }
      if (input.command.startsWith("tail -200 /var/log/mail.log")) {
        return {
          stdout: "postfix/smtp[42]: from=<ops@sender.example>, to=<recipient@operator.example>, status=sent",
          stderr: "",
          exitCode: 0
        };
      }
      throw new Error(`Unexpected SSH command: ${input.command}`);
    })
  };
}

async function validDns(domain: string): Promise<string[][]> {
  if (domain === "sender.example") return [["v=spf1 ip4:192.0.2.44 -all"]];
  if (domain === "default._domainkey.sender.example") return [["v=DKIM1; p=abc"]];
  if (domain === "_dmarc.sender.example") return [["v=DMARC1; p=none"]];
  return [];
}

function validBody(overrides: Partial<SendRealEmailParams> = {}): SendRealEmailParams {
  return {
    fromAddress: "ops@sender.example",
    toAddress: "recipient@operator.example",
    subject: "Delivrix relay readiness report",
    body: safeBody,
    serverSlug: "mail-sender-example",
    actorId: "operator/juanes",
    approvalToken,
    ...overrides
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: "2026-05-31T17:59:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: {
      executionId,
      approvalTokenHash: approvalTokenHash(executionId),
      blockCount: 1
    }
  });
}

async function writeFailedRunState(workspace: OpenClawWorkspace, runId: string, chosenDomain: string): Promise<void> {
  await workspace.writeWorkspaceFileAtomic(`inventory/smtp-runs/${runId}.json`, `${JSON.stringify({
    schemaVersion: "smtp-run-state/v1",
    runId,
    status: "failed",
    chosenDomain,
    lastCompletedStep: 13,
    retryableFailure: true,
    failureCategory: "send_retry_exhausted",
    updatedAt: "2026-05-31T10:00:00.000Z",
    steps: {}
  }, null, 2)}\n`);
}

async function readRunStateRaw(workspace: OpenClawWorkspace, runId: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(workspace.getRootDir(), "inventory", "smtp-runs", `${runId}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function appendSentEvents(auditLog: LocalFileAuditLog, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await appendSentEvent(auditLog, {
      occurredAt: new Date(fixedNow.getTime() - (index + 1) * 60_000).toISOString()
    });
  }
}

async function appendSentEvent(
  auditLog: LocalFileAuditLog,
  input: { occurredAt: string; reservationEventId?: string; idempotencyKey?: string; runId?: string; messageId?: string; decision?: "allow" | "reject" }
): Promise<void> {
  await auditLog.append({
    occurredAt: input.occurredAt,
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.smtp.real_email_sent",
    targetType: "webdock_server",
    targetId: "mail-sender-example",
    riskLevel: "critical",
    decision: input.decision ?? "allow",
    humanApproved: true,
    metadata: {
      serverSlug: "mail-sender-example",
      deliveryStatus: "sent",
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.reservationEventId ? { rateLimitReservationEventId: input.reservationEventId } : {})
    }
  });
}

async function appendRateLimitReservation(auditLog: LocalFileAuditLog) {
  return auditLog.append({
    occurredAt: "2026-05-31T17:56:30.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.smtp.real_email_rate_limit_reserved",
    targetType: "webdock_server",
    targetId: "mail-sender-example",
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    metadata: {
      serverSlug: "mail-sender-example",
      maxPerHour: 5,
      recentCountBefore: 3
    }
  });
}

function canvasState(approvals: Array<{
  artifactId: string;
  executionId: string;
  approvedAt: string;
}>): CanvasLiveStateSnapshot {
  return {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: approvals.map((approval) => ({
      artifactId: approval.artifactId,
      taskId: "task-send-real-email",
      kind: "proposal",
      title: "Send real email",
      editable: true,
      createdAt: "2026-05-31T17:58:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/skills/send-real-email",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  setHeader: (name: string, value: string) => void;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    headers: {},
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}
