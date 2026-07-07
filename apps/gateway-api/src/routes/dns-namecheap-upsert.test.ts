import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { DnsProvider, DnsRecordSpec, DnsUpsertResult, DnsZoneResult } from "../../../../packages/adapters/src/index.ts";
import type { CanvasLiveStateSnapshot } from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import {
  handleNamecheapDnsUpsertError,
  handleNamecheapDnsUpsertHttp,
  type NamecheapDnsProviderResolver
} from "./dns-namecheap-upsert.ts";

const fixedNow = new Date("2026-07-07T15:00:00.000Z");
const DOMAIN = "corpfiling-ops.com";
const SMTP_RECORDS = [
  { name: `mail.${DOMAIN}`, type: "A", content: "203.0.113.20", ttl: 300 },
  { name: DOMAIN, type: "MX", content: "mail.corpfiling-ops.com.", prio: 10 },
  { name: DOMAIN, type: "TXT", content: "v=spf1 ip4:203.0.113.20 -all" }
];

test("POST /v1/dns/namecheap/upsert blocks with no writes/creds/approval and never calls the provider", async () => {
  let upsertCalled = false;
  const route = await routeHarness({
    provider: mockProvider({
      isLive: () => false,
      isWriteEnabled: () => false,
      upsertRecords: async () => { upsertCalled = true; return { changeIds: [] }; }
    }),
    canvasState: canvasState([])
  });

  const response = await route({
    body: { domain: DOMAIN, records: SMTP_RECORDS, actorId: "operator/juanes", approvalToken: "exec-missing" }
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.status, "blocked");
  assert.deepEqual(
    [...response.body.blockers].sort(),
    ["approval_not_found_or_expired", "namecheap_dns_credentials_missing", "writes_disabled"].sort()
  );
  assert.equal(upsertCalled, false);
  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.dns.namecheap.upsert_blocked");
});

test("blocks with namecheap_account_not_found when the resolver returns null", async () => {
  const route = await routeHarnessResolve(() => null, canvasState([]));
  const response = await route({
    body: { domain: DOMAIN, records: SMTP_RECORDS, actorId: "operator/juanes", approvalToken: "x", accountId: "namecheap-9" }
  });
  assert.equal(response.statusCode, 409);
  assert.ok(response.body.blockers.includes("namecheap_account_not_found"));
});

test("happy path: ensureZone + upsert + oc.dns.namecheap.upserted, records reach the provider", async () => {
  const calls: Array<{ zoneId: string; records: DnsRecordSpec[] }> = [];
  const route = await routeHarness({
    provider: mockProvider({
      ensureZone: async (d): Promise<DnsZoneResult> => ({ zoneId: d, nameServers: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"] }),
      upsertRecords: async (zoneId, records): Promise<DnsUpsertResult> => { calls.push({ zoneId, records: [...records] }); return { changeIds: [zoneId], idempotent: false }; }
    }),
    canvasState: canvasState([{ artifactId: "a", executionId: "exec-ok", approvedAt: "2026-07-07T14:58:00.000Z" }])
  });
  await approve(route.auditLog);

  const response = await route({
    body: { domain: "Corpfiling-Ops.COM.", records: SMTP_RECORDS, actorId: "operator/juanes", approvalToken: "exec-ok" }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "applied");
  assert.equal(response.body.domain, DOMAIN);
  assert.ok(response.body.nameservers[0].includes("registrar-servers.com"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].zoneId, DOMAIN);
  assert.deepEqual(calls[0].records[0], { name: `mail.${DOMAIN}`, type: "A", ttl: 300, values: ["203.0.113.20"] });
  assert.deepEqual(calls[0].records[1], { name: DOMAIN, type: "MX", values: ["mail.corpfiling-ops.com."], prio: 10 });
  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.dns.namecheap.upserted");
  assert.equal(events.at(-1)?.decision, "allow");
});

test("rejects unsupported record type with 422 before touching the provider", async () => {
  let upsertCalled = false;
  const route = await routeHarness({
    provider: mockProvider({ upsertRecords: async () => { upsertCalled = true; return { changeIds: [] }; } }),
    canvasState: canvasState([{ artifactId: "a", executionId: "exec-ok", approvedAt: "2026-07-07T14:58:00.000Z" }])
  });
  await approve(route.auditLog);
  const response = await route({
    body: { domain: DOMAIN, records: [{ name: DOMAIN, type: "SRV", content: "x" }], actorId: "operator/juanes", approvalToken: "exec-ok" }
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "invalid_namecheap_dns_upsert_request");
  assert.equal(upsertCalled, false);
});

// --- helpers ---------------------------------------------------------------

function mockProvider(overrides: Partial<DnsProvider> = {}): DnsProvider {
  return {
    providerId: "namecheap",
    isLive: () => true,
    isWriteEnabled: () => true,
    ensureZone: async (d) => ({ zoneId: d, nameServers: [] }),
    upsertRecords: async () => ({ changeIds: [] }),
    listRecords: async () => [],
    ...overrides
  };
}

async function approve(auditLog: LocalFileAuditLog): Promise<void> {
  await auditLog.append({
    id: "audit-approved",
    occurredAt: "2026-07-07T14:58:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: "a",
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: { executionId: "exec-ok", approvalTokenHash: approvalTokenHash("exec-ok"), blockCount: 1 }
  });
}

async function routeHarness(input: { provider: DnsProvider; canvasState: CanvasLiveStateSnapshot }) {
  return routeHarnessResolve(() => input.provider, input.canvasState);
}

async function routeHarnessResolve(resolveProvider: NamecheapDnsProviderResolver, canvas: CanvasLiveStateSnapshot) {
  const dir = await mkdtemp(join(tmpdir(), "namecheap-dns-upsert-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({ rootDir: join(dir, "workspace"), now: () => fixedNow });

  const route = async (call: { body: unknown }): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleNamecheapDnsUpsertHttp({
        request: requestWithJson(call.body),
        response: response as unknown as ServerResponse,
        auditLog,
        resolveProvider,
        workspace,
        readCanvasState: () => canvas,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleNamecheapDnsUpsertError(error, response as unknown as ServerResponse)) throw error;
    }
    return { statusCode: response.statusCode, body: JSON.parse(response.body) };
  };
  return Object.assign(route, { auditLog, workspace });
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/dns/namecheap/upsert",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void { this.statusCode = statusCode; },
    end(payload: string): void { this.body = payload; }
  };
}

function canvasState(approvals: Array<{ artifactId: string; executionId: string; approvedAt: string }>): CanvasLiveStateSnapshot {
  return {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: approvals.map((approval) => ({
      artifactId: approval.artifactId,
      taskId: "task-namecheap-dns",
      kind: "proposal",
      title: "Upsert Namecheap DNS",
      editable: true,
      createdAt: "2026-07-07T14:57:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}
