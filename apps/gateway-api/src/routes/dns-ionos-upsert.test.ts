import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  IonosDnsActuatorError,
  type IonosDnsRecordWriteInput,
  type IonosDnsUpsertResult,
  type IonosDnsCreateZoneResult
} from "../../../../packages/adapters/src/index.ts";
import type { CanvasLiveStateSnapshot } from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import {
  handleIonosDnsUpsertError,
  handleIonosDnsUpsertHttp,
  type IonosDnsUpsertAdapter
} from "./dns-ionos-upsert.ts";

const fixedNow = new Date("2026-05-28T15:00:00.000Z");

test("POST /v1/dns/ionos/upsert blocks when writes disabled, credentials missing and approval is absent", async () => {
  let createCalled = false;
  let upsertCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => false,
      isWriteEnabled: () => false,
      createZone: async () => {
        createCalled = true;
        return { zoneId: "no", nameservers: [] };
      },
      upsertRecords: async () => {
        upsertCalled = true;
        return { rrsetIds: [], idempotent: false };
      }
    }),
    canvasState: canvasState([])
  });

  const response = await route({
    body: {
      zone: "delivrix-mail.com",
      records: [{ name: "mail.delivrix-mail.com", type: "A", content: "203.0.113.10" }],
      actorId: "operator/juanes",
      approvalToken: "exec-missing"
    }
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.status, "blocked");
  assert.deepEqual(
    [...response.body.blockers].sort(),
    ["approval_not_found_or_expired", "ionos_dns_credentials_missing", "writes_disabled"].sort()
  );
  assert.equal(createCalled, false);
  assert.equal(upsertCalled, false);

  const events = await route.auditLog.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.dns.ionos.upsert_blocked");
});

test("POST /v1/dns/ionos/upsert applies records and emits oc.dns.ionos.upserted on happy path", async () => {
  const upsertCalls: Array<{ zoneId: string; records: IonosDnsRecordWriteInput[] }> = [];
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      createZone: async (): Promise<IonosDnsCreateZoneResult> => ({
        zoneId: "zone-cloud-1",
        nameservers: ["ns-1.ionos.com", "ns-2.ionos.com"]
      }),
      upsertRecords: async (zoneId, records): Promise<IonosDnsUpsertResult> => {
        upsertCalls.push({ zoneId, records: [...records] });
        return { rrsetIds: ["rrset-1"], idempotent: false };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-ionos-plan",
      executionId: "exec-approved-ionos",
      approvedAt: "2026-05-28T14:58:00.000Z"
    }])
  });
  await route.auditLog.append({
    id: "audit-approved",
    occurredAt: "2026-05-28T14:58:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: "artifact-ionos-plan",
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: {
      executionId: "exec-approved-ionos",
      approvalTokenHash: approvalTokenHash("exec-approved-ionos"),
      blockCount: 1
    }
  });

  const response = await route({
    body: {
      zone: "Delivrix-Mail.COM.",
      records: [{
        name: "mail.delivrix-mail.com",
        type: "A",
        content: "203.0.113.10",
        ttl: 300
      }],
      actorId: "operator/juanes",
      approvalToken: "exec-approved-ionos"
    },
    headers: { "idempotency-key": "demo-replay-001" }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "applied");
  assert.equal(response.body.zone, "delivrix-mail.com");
  assert.equal(response.body.zoneId, "zone-cloud-1");
  assert.deepEqual(response.body.rrsetIds, ["rrset-1"]);
  assert.deepEqual(response.body.nameservers, ["ns-1.ionos.com", "ns-2.ionos.com"]);
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].zoneId, "zone-cloud-1");

  const events = await route.auditLog.list();
  const upserted = events.at(-1);
  assert.equal(upserted?.action, "oc.dns.ionos.upserted");
  assert.equal(upserted?.metadata.zoneId, "zone-cloud-1");
  assert.equal(upserted?.metadata.idempotencyKey, "demo-replay-001");
  assert.equal(upserted?.metadata.recordCount, 1);
});

test("POST /v1/dns/ionos/upsert blocks with approval_not_found_or_expired when token has no audit event", async () => {
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      createZone: async () => ({ zoneId: "should-not-run", nameservers: [] }),
      upsertRecords: async () => ({ rrsetIds: [], idempotent: false })
    }),
    canvasState: canvasState([])
  });

  const response = await route({
    body: {
      zone: "delivrix-mail.com",
      records: [{ name: "mail", type: "A", content: "203.0.113.10" }],
      actorId: "operator/juanes",
      approvalToken: "exec-not-approved"
    }
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.status, "blocked");
  assert.ok(response.body.blockers.includes("approval_not_found_or_expired"));
});

test("POST /v1/dns/ionos/upsert returns 502 when actuator throws IonosDnsActuatorError", async () => {
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      createZone: async () => ({ zoneId: "zone-cloud-1", nameservers: [] }),
      upsertRecords: async () => {
        throw new IonosDnsActuatorError("Failed to create record: 422 TTL out of range", {
          statusCode: 422,
          code: "validation_failed",
          requestId: "req-abc-123"
        });
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-ionos-plan",
      executionId: "exec-approved-ionos",
      approvedAt: "2026-05-28T14:58:00.000Z"
    }])
  });
  await route.auditLog.append({
    id: "audit-approved",
    occurredAt: "2026-05-28T14:58:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: "artifact-ionos-plan",
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: {
      executionId: "exec-approved-ionos",
      approvalTokenHash: approvalTokenHash("exec-approved-ionos"),
      blockCount: 1
    }
  });

  const response = await route({
    body: {
      zone: "delivrix-mail.com",
      records: [{ name: "mail", type: "A", content: "203.0.113.10" }],
      actorId: "operator/juanes",
      approvalToken: "exec-approved-ionos"
    }
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.status, "failed");
  assert.equal(response.body.error, "ionos_dns_upsert_failed");
  assert.equal(response.body.upstreamStatus, 422);
  assert.equal(response.body.code, "validation_failed");
  assert.equal(response.body.requestId, "req-abc-123");

  const events = await route.auditLog.list();
  const failed = events.at(-1);
  assert.equal(failed?.action, "oc.dns.ionos.upsert_failed");
  assert.equal(failed?.metadata.upstreamStatus, 422);
  assert.equal(failed?.metadata.requestId, "req-abc-123");
});

async function routeHarness(input: {
  adapter: IonosDnsUpsertAdapter;
  canvasState: CanvasLiveStateSnapshot;
}) {
  const dir = await mkdtemp(join(tmpdir(), "ionos-dns-upsert-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });

  const route = async (call: {
    body: unknown;
    headers?: Record<string, string>;
  }): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleIonosDnsUpsertHttp({
        request: requestWithJson(call.body, call.headers ?? {}),
        response: response as unknown as ServerResponse,
        auditLog,
        adapter: input.adapter,
        workspace,
        readCanvasState: () => input.canvasState,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleIonosDnsUpsertError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return Object.assign(route, { auditLog, workspace });
}

function mockAdapter(overrides: Partial<IonosDnsUpsertAdapter> = {}): IonosDnsUpsertAdapter {
  return {
    isLive: () => true,
    isWriteEnabled: () => true,
    writeApiKindLabel: () => "cloud-dns",
    createZone: async () => ({ zoneId: "zone-default", nameservers: [] }),
    upsertRecords: async () => ({ rrsetIds: [], idempotent: false }),
    ...overrides
  };
}

function requestWithJson(body: unknown, headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/dns/ionos/upsert",
    headers: { "content-type": "application/json", ...headers }
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
      taskId: "task-ionos-plan",
      kind: "proposal",
      title: "Upsert IONOS DNS",
      editable: true,
      createdAt: "2026-05-28T14:57:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}
