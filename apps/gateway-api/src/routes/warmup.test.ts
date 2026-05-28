import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  handleWarmupStartError,
  handleWarmupStartHttp
} from "./warmup.ts";
import type {
  SmtpSshCommandInput,
  SmtpSshRunner
} from "./smtp-provisioning.ts";

const fixedNow = new Date("2026-05-28T11:00:00.000Z");

test("POST /v1/warmup/start blocks without send flag, runner, approval, server IP, and exactly 3 seeds", async () => {
  const route = await routeHarness({
    sshRunner: mockRunner({ isConfigured: () => false }),
    canvasState: canvasState([])
  });

  const response = await route({
    domain: "delivrix-mail.com",
    seedInboxes: ["seed1@example.com"],
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    taskId: "task-warmup-blocked"
  }, { WARMUP_ENABLE_SEND: "false" });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "seed_inboxes_must_be_exactly_3",
    "server_ip_missing",
    "warmup_send_flag_disabled",
    "warmup_ssh_runner_missing"
  ].sort());
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.warmup.start_blocked");
});

test("POST /v1/warmup/start sends three seed messages and stores redacted progress", async () => {
  const commands: SmtpSshCommandInput[] = [];
  const route = await routeHarness({
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "queued", stderr: "", exitCode: 0 };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-warmup-plan",
      executionId: "exec-warmup-123",
      approvedAt: "2026-05-28T10:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-warmup-plan", "exec-warmup-123");
  await route.workspace.updateInventoryJson("domains.json", () => ({
    bindings: [{
      domain: "delivrix-mail.com",
      serverSlug: "mail-delivrix-test",
      serverIp: "192.0.2.44"
    }]
  }));

  const response = await route({
    domain: "Delivrix-Mail.COM.",
    seedInboxes: [
      "seed.one@gmail.com",
      "seed.two@outlook.com",
      "seed.three@delivrix.com"
    ],
    actorId: "operator/juanes",
    approvalToken: "exec-warmup-123",
    taskId: "task-warmup-start"
  }, { WARMUP_ENABLE_SEND: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "started");
  assert.equal(response.body.sent.length, 3);
  assert.equal(response.body.sent[0].to, "se***@gmail.com");
  assert.equal(commands.length, 3);
  assert.equal(commands.every((command) => command.command === "/usr/sbin/sendmail -t -f 'noreply@delivrix-mail.com'"), true);
  assert.equal(commands.every((command) => command.stdin?.includes("Subject: Delivrix warmup seed")), true);

  const events = await route.auditLog.list();
  const started = events.at(-1);
  assert.equal(started?.action, "oc.warmup.seed_sent");
  assert.deepEqual(started?.metadata.seedDomains, ["gmail.com", "outlook.com", "delivrix.com"]);
  assert.equal(JSON.stringify(started?.metadata).includes("seed.one"), false);

  const inventory = await route.workspace.readInventoryJson<{
    runs: Array<{ domain: string; seedCount: number; sent: Array<{ seedHash: string; seedDomain: string }> }>;
  }>("warmup-progress.json");
  assert.equal(inventory?.runs[0].domain, "delivrix-mail.com");
  assert.equal(inventory?.runs[0].seedCount, 3);
  assert.equal(inventory?.runs[0].sent[0].seedDomain, "gmail.com");
  assert.equal("seed.one@gmail.com" in (inventory?.runs[0] ?? {}), false);
  assert.ok(route.canvasEvents.some((event) => event.type === "oc.action.now" && event.kind === "command"));
});

test("POST /v1/warmup/start falls back to three env seed inboxes", async () => {
  const commands: SmtpSshCommandInput[] = [];
  const route = await routeHarness({
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "queued", stderr: "", exitCode: 0 };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-warmup-plan",
      executionId: "exec-warmup-env",
      approvedAt: "2026-05-28T10:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-warmup-plan", "exec-warmup-env");
  await route.workspace.updateInventoryJson("domains.json", () => ({
    bindings: [{
      domain: "delivrix-mail.com",
      serverSlug: "mail-delivrix-test",
      serverIp: "192.0.2.44"
    }]
  }));

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-warmup-env",
    taskId: "task-warmup-env"
  }, {
    WARMUP_ENABLE_SEND: "true",
    WARMUP_DEFAULT_SEED_INBOXES: "seed.one@mailtrap.io, seed.two@mailtrap.io, seed.three@mailtrap.io"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.sent.length, 3);
  assert.equal(commands.length, 3);
  assert.equal(commands[0].stdin?.includes("To: seed.one@mailtrap.io"), true);
});

async function routeHarness(input: {
  sshRunner: SmtpSshRunner;
  canvasState: CanvasLiveStateSnapshot;
}) {
  const dir = await mkdtemp(join(tmpdir(), "warmup-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (
    body: unknown,
    env: Record<string, string | undefined> = { WARMUP_ENABLE_SEND: "true" }
  ): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleWarmupStartHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        sshRunner: input.sshRunner,
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        readCanvasState: () => input.canvasState,
        env,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleWarmupStartError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return Object.assign(route, { auditLog, workspace, canvasEvents });
}

function mockRunner(overrides: Partial<SmtpSshRunner> = {}): SmtpSshRunner {
  return {
    isConfigured: () => true,
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    ...overrides
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: "2026-05-28T10:59:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: { executionId, blockCount: 1 }
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
      taskId: "task-warmup-plan",
      kind: "proposal",
      title: "Warmup seed",
      editable: true,
      createdAt: "2026-05-28T10:58:00.000Z",
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
    url: "/v1/warmup/seed",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}
