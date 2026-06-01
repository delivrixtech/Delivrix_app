import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import { dispatchSkillHandler } from "../skill-dispatcher.ts";
import type { ApprovalToken } from "../security/approval-token.ts";
import {
  createAuditApprovalGuard,
  handleWaitForDnsPropagationHttp,
  handleWaitForDnsPropagationReadOnlyHttp,
  pollDnsRecord,
  type ApprovalGuard,
  type DnsResolver
} from "./dns-wait.ts";

const fixedNow = new Date("2026-05-31T17:00:00.000Z");
const actorId = "operator/juanes";

test("pollDnsRecord resolves A record on first attempt", async () => {
  let nowMs = fixedNow.getTime();
  const result = await pollDnsRecord({
    domain: "delivrix.test",
    expectedRecord: { type: "A", value: "1.2.3.4" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    dns: dnsResolver({ resolve4: async () => ["1.2.3.4"] }),
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.lastSeen, "1.2.3.4");
});

test("pollDnsRecord succeeds after three polls", async () => {
  let nowMs = fixedNow.getTime();
  let attempts = 0;
  const sleeps: number[] = [];
  const result = await pollDnsRecord({
    domain: "delivrix.test",
    expectedRecord: { type: "A", value: "1.2.3.4" },
    maxWaitMs: 120_000,
    pollIntervalMs: 30_000,
    dns: dnsResolver({
      resolve4: async () => {
        attempts += 1;
        if (attempts === 1) return [];
        if (attempts === 2) throw dnsError("ENOTFOUND");
        return ["1.2.3.4"];
      }
    }),
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [30_000, 30_000]);
  assert.equal(result.durationMs, 60_000);
});

test("pollDnsRecord times out without propagation", async () => {
  let nowMs = fixedNow.getTime();
  const result = await pollDnsRecord({
    domain: "missing.delivrix.test",
    expectedRecord: { type: "A", value: "1.2.3.4" },
    maxWaitMs: 90_000,
    pollIntervalMs: 30_000,
    dns: dnsResolver({ resolve4: async () => { throw dnsError("ENOTFOUND"); } }),
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.error, "domain_nxdomain");
  assert.equal(result.lastSeen, "(nxdomain)");
  assert.equal(result.durationMs, 90_000);
});

test("pollDnsRecord reports value mismatch", async () => {
  let nowMs = fixedNow.getTime();
  const result = await pollDnsRecord({
    domain: "delivrix.test",
    expectedRecord: { type: "A", value: "1.2.3.4" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    dns: dnsResolver({ resolve4: async () => ["9.9.9.9"] }),
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "value_mismatch");
  assert.equal(result.lastSeen, "9.9.9.9");
});

test("pollDnsRecord resolves NS record with normalized trailing dot", async () => {
  let nowMs = fixedNow.getTime();
  const result = await pollDnsRecord({
    domain: "delivrix.test",
    expectedRecord: { type: "NS", value: "ns-1.awsdns-01.com" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    dns: dnsResolver({ resolveNs: async () => ["ns-1.awsdns-01.com."] }),
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.lastSeen, "ns-1.awsdns-01.com");
});

test("pollDnsRecord supports contains matcher for Route53 NS propagation", async () => {
  let nowMs = fixedNow.getTime();
  const result = await pollDnsRecord({
    domain: "delivrix.test",
    expectedRecord: { type: "NS", value: "contains:awsdns" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    dns: dnsResolver({ resolveNs: async () => ["ns-123.awsdns-45.org."] }),
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.lastSeen, "ns-123.awsdns-45.org");
});

test("pollDnsRecord resolves MX record by exchange", async () => {
  let nowMs = fixedNow.getTime();
  const result = await pollDnsRecord({
    domain: "delivrix.test",
    expectedRecord: { type: "MX", value: "mail.example.com" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    dns: dnsResolver({ resolveMx: async () => [{ priority: 10, exchange: "mail.example.com." }] }),
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.lastSeen, "mail.example.com");
});

test("POST /v1/skills/wait-for-dns-propagation rejects invalid domain", async () => {
  const response = await callRoute({
    ...validBody(),
    domain: "no-tld"
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_params");
});

test("POST /v1/skills/wait-for-dns-propagation rejects maxWaitMs above hard cap", async () => {
  const response = await callRoute({
    ...validBody(),
    maxWaitMs: 1_800_001
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_params");
});

test("POST /v1/skills/wait-for-dns-propagation rejects pollIntervalMs below rate limit", async () => {
  const response = await callRoute({
    ...validBody(),
    pollIntervalMs: 29_999
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_params");
});

test("POST /v1/skills/wait-for-dns-propagation rejects invalid approval before polling", async () => {
  let dnsCalls = 0;
  const response = await callRoute(validBody(), {
    approvalGuard: { verify: async () => ({ ok: false, rejectReason: "approval_not_found_or_expired" }) },
    dns: dnsResolver({
      resolve4: async () => {
        dnsCalls += 1;
        return ["1.2.3.4"];
      }
    })
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "approval_invalid");
  assert.equal(dnsCalls, 0);
});

test("POST /v1/skills/wait-for-dns-propagation audits propagation metadata", async () => {
  const auditLog = new MemoryAuditLog();
  const response = await callRoute(validBody(), {
    auditLog,
    dns: dnsResolver({ resolve4: async () => ["1.2.3.4"] })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const event = (await auditLog.list()).at(-1);
  assert.equal(event?.action, "oc.dns.propagation_check");
  assert.equal(event?.actorId, actorId);
  assert.equal(event?.metadata.domain, "delivrix.test");
  assert.equal(event?.metadata.expectedRecordType, "A");
  assert.equal(event?.metadata.expectedRecordValue, "1.2.3.4");
  assert.equal(event?.metadata.attempts, 1);
  assert.equal(event?.metadata.lastSeen, "1.2.3.4");
  assert.equal(event?.metadata.ok, true);
  assert.equal(response.body.eventId, event?.id);
});

test("POST /v1/skills/wait-for-dns-propagation/read-only audits without approval fields", async () => {
  const auditLog = new MemoryAuditLog();
  const response = await callReadOnlyRoute({
    domain: "delivrix.test",
    expectedRecord: { type: "A", value: "1.2.3.4" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    actorId
  }, {
    auditLog,
    dns: dnsResolver({ resolve4: async () => ["1.2.3.4"] })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const event = (await auditLog.list()).at(-1);
  assert.equal(event?.action, "oc.dns.propagation_check");
  assert.equal(event?.actorId, actorId);
  assert.equal(event?.humanApproved, false);
  assert.equal(event?.metadata.readOnly, true);
  assert.equal(response.body.eventId, event?.id);
});

test("POST /v1/skills/wait-for-dns-propagation/read-only returns DNS blockers as data", async () => {
  const auditLog = new MemoryAuditLog();
  const response = await callReadOnlyRoute({
    domain: "missing.delivrix.test",
    expectedRecord: { type: "A", value: "1.2.3.4" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    actorId
  }, {
    auditLog,
    dns: dnsResolver({ resolve4: async () => { throw dnsError("ENOTFOUND"); } })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "domain_nxdomain");
  const event = (await auditLog.list()).at(-1);
  assert.equal(event?.decision, "reject");
  assert.equal(event?.metadata.ok, false);
  assert.equal(event?.metadata.readOnly, true);
});

test("POST /v1/skills/wait-for-dns-propagation respects kill switch", async () => {
  let dnsCalls = 0;
  const response = await callRoute(validBody(), {
    readKillSwitch: async () => ({ enabled: true }),
    dns: dnsResolver({
      resolve4: async () => {
        dnsCalls += 1;
        return ["1.2.3.4"];
      }
    })
  });

  assert.equal(response.statusCode, 423);
  assert.equal(response.body.error, "kill_switch_armed");
  assert.equal(dnsCalls, 0);
});

test("createAuditApprovalGuard accepts a recent ApprovalGate artifact token", async () => {
  const auditLog = new MemoryAuditLog();
  auditLog.seedApproval("approval-token-1", "approval-execution-1");
  const guard = createAuditApprovalGuard({
    auditLog,
    readCanvasState: () => canvasStateForApproval("approval-execution-1"),
    now: () => fixedNow
  });

  const result = await guard.verify({
    approvalToken: "approval-token-1",
    actorId
  });

  assert.equal(result.ok, true);
  assert.equal(typeof result.eventId, "string");
});

test("dispatcher exposes dns_propagation_wait alias with ApprovalGate guard", async () => {
  const auditLog = new MemoryAuditLog();
  const approvalToken = dispatcherApprovalToken();
  auditLog.seedApproval(approvalToken.tokenId, "approval-execution-dispatcher");

  const result = await dispatchSkillHandler({
    skill: "dns_propagation_wait",
    params: {
      domain: "delivrix.test",
      expectedRecord: { type: "NS", value: "ns-1.awsdns-01.com" },
      maxWaitMs: 30_000,
      pollIntervalMs: 30_000
    },
    actorId,
    approvalToken,
    deps: {
      auditLog,
      readCanvasState: () => canvasStateForApproval("approval-execution-dispatcher"),
      dnsResolver: dnsResolver({ resolveNs: async () => ["ns-1.awsdns-01.com"] }),
      readKillSwitch: () => ({ enabled: false }),
      now: () => fixedNow
    } as any
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal((result.summary as { ok: boolean }).ok, true);
});

test("wait DNS integration gates Webdock create until propagation is confirmed", async () => {
  const phases: string[] = [];
  let nowMs = fixedNow.getTime();
  let dnsAttempts = 0;

  phases.push(await fakeRegisterDomain());
  const wait = await callRoute(validBody({
    expectedRecord: { type: "NS", value: "ns-1.awsdns-01.com" },
    maxWaitMs: 90_000,
    pollIntervalMs: 30_000
  }), {
    dns: dnsResolver({
      resolveNs: async () => {
        dnsAttempts += 1;
        return dnsAttempts < 2 ? [] : ["ns-1.awsdns-01.com"];
      }
    }),
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    }
  });
  assert.equal(wait.statusCode, 200);
  assert.equal(wait.body.attempts, 2);

  if (wait.body.ok) {
    phases.push(await fakeCreateWebdockServer());
  }

  assert.deepEqual(phases, ["register_domain_route53", "create_webdock_server"]);
});

async function callRoute(
  body: unknown,
  options: {
    auditLog?: MemoryAuditLog;
    approvalGuard?: ApprovalGuard;
    dns?: DnsResolver;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    readKillSwitch?: () => Promise<{ enabled: boolean }> | { enabled: boolean };
  } = {}
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  await handleWaitForDnsPropagationHttp({
    request: requestWithJson(body),
    response: response as unknown as ServerResponse,
    auditLog: options.auditLog ?? new MemoryAuditLog(),
    approvalGuard: options.approvalGuard ?? { verify: async () => ({ ok: true, eventId: "approval-event-1" }) },
    dns: options.dns ?? dnsResolver(),
    now: options.now ?? (() => fixedNow.getTime()),
    sleep: options.sleep ?? (async () => undefined),
    readKillSwitch: options.readKillSwitch
  });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

async function callReadOnlyRoute(
  body: unknown,
  options: {
    auditLog?: MemoryAuditLog;
    dns?: DnsResolver;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    readKillSwitch?: () => Promise<{ enabled: boolean }> | { enabled: boolean };
  } = {}
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  await handleWaitForDnsPropagationReadOnlyHttp({
    request: requestWithJson(body),
    response: response as unknown as ServerResponse,
    auditLog: options.auditLog ?? new MemoryAuditLog(),
    dns: options.dns ?? dnsResolver(),
    now: options.now ?? (() => fixedNow.getTime()),
    sleep: options.sleep ?? (async () => undefined),
    readKillSwitch: options.readKillSwitch
  });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domain: "delivrix.test",
    expectedRecord: { type: "A", value: "1.2.3.4" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    actorId,
    approvalToken: "approval-token-1",
    ...overrides
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url: "/v1/skills/wait-for-dns-propagation",
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

function dnsResolver(overrides: Partial<DnsResolver> = {}): DnsResolver {
  return {
    resolve4: async () => [],
    resolveNs: async () => [],
    resolveMx: async () => [],
    ...overrides
  };
}

function dnsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function dispatcherApprovalToken(): ApprovalToken {
  return {
    tokenId: "approval-token-dispatcher",
    actionId: "wait_for_dns_propagation",
    targetType: "domain",
    targetId: "delivrix.test",
    approverId: actorId,
    issuedAt: fixedNow.toISOString(),
    expiresAt: new Date(fixedNow.getTime() + 5 * 60 * 1000).toISOString(),
    nonce: "nonce",
    signature: "signature"
  };
}

async function fakeRegisterDomain(): Promise<string> {
  return "register_domain_route53";
}

async function fakeCreateWebdockServer(): Promise<string> {
  return "create_webdock_server";
}

class MemoryAuditLog {
  private readonly events: AuditEvent[] = [];

  constructor(seedApproval = false) {
    if (seedApproval) {
      this.seedApproval("approval-token-1", "approval-execution-1");
    }
  }

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: input.id ?? randomUUID(),
      occurredAt: input.occurredAt ?? fixedNow.toISOString(),
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      riskLevel: input.riskLevel,
      metadata: input.metadata,
      decision: input.decision ?? "allow",
      rejectReason: input.rejectReason ?? null,
      humanApproved: input.humanApproved ?? false,
      approverIds: input.approverIds ?? [],
      killSwitchState: input.killSwitchState ?? "unknown",
      rollbackToken: input.rollbackToken ?? null,
      schemaVersion: "2026-05-18.v1",
      promptVersion: input.promptVersion ?? null,
      modelVersion: input.modelVersion ?? null,
      evidenceRefs: input.evidenceRefs ?? [],
      prevHash: input.prevHash ?? "GENESIS",
      hash: input.hash ?? "a".repeat(64)
    };
    this.events.push(event);
    return event;
  }

  async list(): Promise<AuditEvent[]> {
    return [...this.events];
  }

  seedApproval(token: string, executionId: string): void {
    this.events.push({
      id: randomUUID(),
      occurredAt: fixedNow.toISOString(),
      actorType: "operator",
      actorId,
      action: "oc.artifact.approved",
      targetType: "domain",
      targetId: "delivrix.test",
      riskLevel: "low",
      metadata: {
        executionId,
        approvalTokenHash: approvalTokenHash(token)
      },
      decision: "allow",
      rejectReason: null,
      humanApproved: true,
      approverIds: [actorId],
      killSwitchState: "unknown",
      rollbackToken: null,
      schemaVersion: "2026-05-18.v1",
      promptVersion: null,
      modelVersion: null,
      evidenceRefs: [],
      prevHash: "GENESIS",
      hash: "a".repeat(64)
    });
  }
}

export function canvasStateForApproval(executionId = "approval-execution-1"): CanvasLiveStateSnapshot {
  return {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: [{
      artifactId: "artifact-dns-wait",
      taskId: "task-dns-wait",
      kind: "proposal",
      title: "Approve DNS wait",
      editable: true,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      approvalStatus: "approved",
      approvedBy: actorId,
      approvedAt: fixedNow.toISOString(),
      executionId,
      blocks: []
    }]
  };
}
