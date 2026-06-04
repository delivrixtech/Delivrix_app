import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  AwsRoute53DnsChangeResult,
  AwsRoute53DnsRecordInput,
  AwsRoute53DnsSource,
  AwsRoute53HostedZoneResult,
  AwsRoute53HostedZoneSummary,
  AwsRoute53ResourceRecordSet
} from "../../../../packages/adapters/src/index.ts";
import type {
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { AutoRollbackManager } from "../auto-rollback.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import {
  handleRoute53DnsError,
  handleRoute53HostedZoneDeleteHttp,
  handleRoute53DnsUpsertHttp,
  type Route53HostedZoneDeleteAdapter,
  type Route53DnsAdapter
} from "./domains-dns.ts";

const fixedNow = new Date("2026-05-27T12:00:00.000Z");

test("POST /v1/domains/route53/dns/upsert blocks without live writes and approval", async () => {
  let createCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => false,
      isWriteEnabled: () => false,
      createHostedZone: async () => {
        createCalled = true;
        return { zoneId: "ZSHOULDNOTRUN", nameServers: [] };
      }
    }),
    canvasState: canvasState([])
  });

  const response = await route({
    domain: "delivrix-mail.com",
    records: [{ name: "@", type: "TXT", ttl: 300, values: ["v=spf1 ip4:192.0.2.10 -all"] }],
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    taskId: "task-dns-blocked"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "aws_route53_dns_credentials_missing",
    "dns_write_flag_disabled"
  ].sort());
  assert.equal(createCalled, false);
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.dns.records_update_blocked");
  assert.ok(route.canvasEvents.some((event) => event.type === "oc.action.now" && event.kind === "file"));
});

test("POST /v1/domains/route53/dns/upsert creates zone, upserts records, writes workspace and audit", async () => {
  const upserts: AwsRoute53DnsRecordInput[] = [];
  let createCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      listHostedZones: async () => [],
      createHostedZone: async (domain) => {
        createCalled = true;
        return {
          zoneId: domain === "delivrix-mail.com" ? "Z123" : "ZOTHER",
          nameServers: ["ns-1.awsdns.com", "ns-2.awsdns.net"]
        };
      },
      upsertRecord: async (_zoneId, record) => {
        upserts.push(record);
        return { changeId: `C${upserts.length}` };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-dns-plan",
      executionId: "exec-dns-123",
      approvedAt: "2026-05-27T11:58:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-dns-plan", "exec-dns-123");

  const response = await route({
    domain: "Delivrix-Mail.COM.",
    records: [
      { name: "@", type: "TXT", ttl: 300, values: ["v=spf1 ip4:192.0.2.10 -all"] },
      { name: "mail", type: "A", ttl: 300, values: ["192.0.2.10"] }
    ],
    actorId: "operator/juanes",
    approvalToken: "exec-dns-123",
    taskId: "task-dns-upsert"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(createCalled, true);
  assert.equal(response.body.zoneId, "Z123");
  assert.deepEqual(response.body.changes.map((change: { changeId: string }) => change.changeId), ["C1", "C2"]);
  assert.equal(upserts[0].name, "delivrix-mail.com.");
  assert.equal(upserts[1].name, "mail.delivrix-mail.com.");

  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.dns.records_updated");
  assert.equal(events.at(-1)?.metadata.recordCount, 2);

  const inventory = await route.workspace.readInventoryJson<{ dnsZones: Array<{ domain: string; zoneId: string }> }>("domains.json");
  assert.deepEqual(inventory?.dnsZones, [{
    domain: "delivrix-mail.com",
    zoneId: "Z123",
    nameServers: ["ns-1.awsdns.com", "ns-2.awsdns.net"],
    updatedAt: fixedNow.toISOString(),
    records: [
      {
        name: "delivrix-mail.com.",
        type: "TXT",
        ttl: 300,
        values: ["v=spf1 ip4:192.0.2.10 -all"],
        changeId: "C1",
        updatedAt: fixedNow.toISOString()
      },
      {
        name: "mail.delivrix-mail.com.",
        type: "A",
        ttl: 300,
        values: ["192.0.2.10"],
        changeId: "C2",
        updatedAt: fixedNow.toISOString()
      }
    ]
  }]);
  assert.equal(route.canvasEvents.filter((event) => event.type === "oc.action.now" && event.kind === "api").length, 3);
});

test("POST /v1/domains/route53/dns/upsert reuses existing AWS zone when workspace inventory is empty", async () => {
  let createCalled = false;
  const upsertZones: string[] = [];
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      listHostedZones: async () => [{
        zoneId: "ZEXISTING123",
        name: "delivrix-mail.com.",
        nameServers: []
      }],
      listResourceRecordSets: async () => [{
        name: "delivrix-mail.com.",
        type: "NS",
        ttl: 172800,
        values: ["ns-1.awsdns.com.", "ns-2.awsdns.net."]
      }],
      createHostedZone: async () => {
        createCalled = true;
        return { zoneId: "ZSHOULDNOTCREATE", nameServers: [] };
      },
      upsertRecord: async (zoneId, record) => {
        upsertZones.push(zoneId);
        return { changeId: `C-${record.type}` };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-dns-plan",
      executionId: "exec-dns-reuse",
      approvedAt: "2026-05-27T11:58:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-dns-plan", "exec-dns-reuse");

  const response = await route({
    domain: "delivrix-mail.com",
    records: [{ name: "mail", type: "A", ttl: 300, values: ["192.0.2.10"] }],
    actorId: "operator/juanes",
    approvalToken: "exec-dns-reuse",
    taskId: "task-dns-reuse"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.zoneId, "ZEXISTING123");
  assert.equal(response.body.zoneResolution.source, "aws-single");
  assert.equal(createCalled, false);
  assert.deepEqual(upsertZones, ["ZEXISTING123"]);
});

test("POST /v1/domains/route53/dns/upsert fail-closes ambiguous AWS zones without creating duplicate", async () => {
  let createCalled = false;
  let upsertCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      listHostedZones: async () => [
        { zoneId: "ZONEAMBIGUOUS1", name: "delivrix-mail.com.", nameServers: ["ns-1.awsdns.com"] },
        { zoneId: "ZONEAMBIGUOUS2", name: "delivrix-mail.com.", nameServers: ["ns-2.awsdns.net"] }
      ],
      listResourceRecordSets: async () => [{
        name: "delivrix-mail.com.",
        type: "NS",
        ttl: 172800,
        values: ["ns-1.awsdns.com."]
      }],
      createHostedZone: async () => {
        createCalled = true;
        return { zoneId: "ZSHOULDNOTCREATE", nameServers: [] };
      },
      upsertRecord: async () => {
        upsertCalled = true;
        return { changeId: "CSHOULDNOTUPSERT" };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-dns-plan",
      executionId: "exec-dns-ambiguous",
      approvedAt: "2026-05-27T11:58:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-dns-plan", "exec-dns-ambiguous");

  const response = await route({
    domain: "delivrix-mail.com",
    records: [{ name: "mail", type: "A", ttl: 300, values: ["192.0.2.10"] }],
    actorId: "operator/juanes",
    approvalToken: "exec-dns-ambiguous",
    taskId: "task-dns-ambiguous"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["zone_ambiguous_manual_review"]);
  assert.equal(createCalled, false);
  assert.equal(upsertCalled, false);
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.dns.records_update_blocked");
});

test("POST /v1/domains/route53/dns/upsert prefers canonical smtp zone over legacy mail zone", async () => {
  const upsertZones: string[] = [];
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      listHostedZones: async () => [
        { zoneId: "ZLEGACYMAIL", name: "controldelivrix.app.", nameServers: ["ns-mail.awsdns.com"] },
        { zoneId: "ZCANONICALSMTP", name: "controldelivrix.app.", nameServers: ["ns-smtp.awsdns.net"] }
      ],
      listResourceRecordSets: async (zoneId) => zoneId === "ZCANONICALSMTP"
        ? [
            { name: "controldelivrix.app.", type: "NS", ttl: 172800, values: ["ns-smtp.awsdns.net."] },
            { name: "smtp.controldelivrix.app.", type: "A", ttl: 300, values: ["45.136.70.47"] },
            { name: "controldelivrix.app.", type: "MX", ttl: 300, values: ["10 smtp.controldelivrix.app."] }
          ]
        : [
            { name: "controldelivrix.app.", type: "NS", ttl: 172800, values: ["ns-mail.awsdns.com."] },
            { name: "mail.controldelivrix.app.", type: "A", ttl: 300, values: ["45.136.70.47"] },
            { name: "controldelivrix.app.", type: "MX", ttl: 300, values: ["10 mail.controldelivrix.app."] }
          ],
      createHostedZone: async () => {
        throw new Error("createHostedZone should not run when canonical smtp zone exists");
      },
      upsertRecord: async (zoneId, record) => {
        upsertZones.push(zoneId);
        return { changeId: `C-${record.type}` };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-dns-plan",
      executionId: "exec-dns-smtp-prefer",
      approvedAt: "2026-05-27T11:58:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-dns-plan", "exec-dns-smtp-prefer");

  const response = await route({
    domain: "controldelivrix.app",
    records: [{ name: "smtp", type: "A", ttl: 300, values: ["45.136.70.47"] }],
    actorId: "operator/juanes",
    approvalToken: "exec-dns-smtp-prefer",
    taskId: "task-dns-smtp-prefer"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.zoneId, "ZCANONICALSMTP");
  assert.equal(response.body.zoneResolution.smtpSetup, "canonical");
  assert.deepEqual(response.body.zoneResolution.cleanupSuggested, [{
    zoneId: "ZLEGACYMAIL",
    name: "controldelivrix.app.",
    reason: "duplicate_route53_hosted_zone"
  }]);
  assert.deepEqual(upsertZones, ["ZCANONICALSMTP"]);
});

test("POST /v1/domains/route53/dns/upsert auto-rolls back when propagation times out", async () => {
  let nowMs = fixedNow.getTime();
  const snapshotDir = await mkdtemp(join(tmpdir(), "route53-rollback-"));
  const rollbackManager = new AutoRollbackManager({
    snapshotDir,
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      nowMs += ms;
    },
    dnsPolicy: { propagationTimeoutMs: 1, pollIntervalMs: 1 }
  });
  const upserts: AwsRoute53DnsRecordInput[] = [];
  const deletes: AwsRoute53DnsRecordInput[] = [];
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      createHostedZone: async () => ({
        zoneId: "Z123",
        nameServers: ["ns-1.awsdns.com"]
      }),
      listResourceRecordSets: async () => [{
        name: "delivrix-mail.com.",
        type: "TXT",
        ttl: 300,
        values: ["v=spf1 -all"]
      }],
      upsertRecord: async (_zoneId, record) => {
        upserts.push(record);
        return { changeId: `C${upserts.length}` };
      },
      deleteRecord: async (_zoneId, record) => {
        deletes.push(record);
        return { changeId: `D${deletes.length}` };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-dns-plan",
      executionId: "exec-dns-rollback",
      approvedAt: "2026-05-27T11:58:00.000Z"
    }]),
    autoRollbackManager: rollbackManager,
    awaitAutoRollbackCheck: true,
    dnsDigFn: async () => []
  });
  await appendApproval(route.auditLog, "artifact-dns-plan", "exec-dns-rollback");

  const response = await route({
    domain: "delivrix-mail.com",
    records: [{ name: "mail", type: "A", ttl: 300, values: ["192.0.2.10"] }],
    actorId: "operator/juanes",
    approvalToken: "exec-dns-rollback",
    taskId: "task-dns-rollback"
  });
  await waitForMicrotasks();

  assert.equal(response.statusCode, 200);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].name, "mail.delivrix-mail.com.");
  assert.ok(upserts.some((record) => record.name === "delivrix-mail.com." && record.values[0] === "v=spf1 -all"));
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.dns.auto_rolled_back");
});

test("DELETE /v1/domains/route53/hosted-zones/:zoneId blocks without DNS writes and approval", async () => {
  let deleteCalled = false;
  const route = await deleteRouteHarness({
    adapter: mockDeleteAdapter({
      isLive: () => false,
      isWriteEnabled: () => false,
      deleteHostedZone: async () => {
        deleteCalled = true;
        return { zoneId: "ZSHOULDNOTRUN", deletedRecords: [] };
      }
    }),
    canvasState: canvasState([])
  });

  const response = await route("Z123", {
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    reason: "cleanup smoke",
    taskId: "task-zone-delete-blocked"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "aws_route53_dns_credentials_missing",
    "dns_write_flag_disabled"
  ].sort());
  assert.equal(deleteCalled, false);
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.dns.hosted_zone_delete_blocked");
});

test("DELETE /v1/domains/route53/hosted-zones/:zoneId deletes zone and removes active inventory", async () => {
  const deletedZones: string[] = [];
  const route = await deleteRouteHarness({
    adapter: mockDeleteAdapter({
      deleteHostedZone: async (zoneId) => {
        deletedZones.push(zoneId);
        return {
          zoneId,
          deleteChangeId: "CZONE",
          deletedRecords: [{
            name: "_delivrix-smoke.delivrix-mail.com.",
            type: "TXT",
            ttl: 300,
            values: ["codex-smoke=1"],
            changeId: "CRECORD"
          }]
        };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-zone-delete",
      executionId: "exec-zone-delete-123",
      approvedAt: "2026-05-27T11:58:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-zone-delete", "exec-zone-delete-123");
  await route.workspace.updateInventoryJson("domains.json", () => ({
    dnsZones: [{
      domain: "delivrix-mail.com",
      zoneId: "Z123",
      nameServers: ["ns-1.awsdns.com"],
      updatedAt: fixedNow.toISOString(),
      records: []
    }]
  }));

  const response = await route("Z123", {
    actorId: "operator/juanes",
    approvalToken: "exec-zone-delete-123",
    reason: "cleanup smoke",
    taskId: "task-zone-delete"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.zoneId, "Z123");
  assert.equal(response.body.domain, "delivrix-mail.com");
  assert.equal(response.body.deletedRecordCount, 1);
  assert.deepEqual(deletedZones, ["Z123"]);

  const inventory = await route.workspace.readInventoryJson<{
    dnsZones: Array<{ zoneId: string }>;
    deletedDnsZones: Array<{ zoneId: string; reason: string; deletedRecords: Array<{ changeId: string }> }>;
  }>("domains.json");
  assert.equal(inventory?.dnsZones.length, 0);
  assert.equal(inventory?.deletedDnsZones[0].zoneId, "Z123");
  assert.equal(inventory?.deletedDnsZones[0].reason, "cleanup smoke");
  assert.equal(inventory?.deletedDnsZones[0].deletedRecords[0].changeId, "CRECORD");
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.dns.hosted_zone_deleted");
});

async function routeHarness(input: {
  adapter: Route53DnsAdapter;
  canvasState: CanvasLiveStateSnapshot;
  autoRollbackManager?: AutoRollbackManager;
  awaitAutoRollbackCheck?: boolean;
  dnsDigFn?: (domain: string, type: string) => Promise<string[]>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "route53-dns-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleRoute53DnsUpsertHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        adapter: input.adapter,
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        autoRollbackManager: input.autoRollbackManager,
        awaitAutoRollbackCheck: input.awaitAutoRollbackCheck,
        dnsDigFn: input.dnsDigFn,
        readCanvasState: () => input.canvasState,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleRoute53DnsError(error, response as unknown as ServerResponse)) {
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

function mockAdapter(overrides: Partial<Route53DnsAdapter> = {}): Route53DnsAdapter {
  return {
    isLive: () => true,
    isWriteEnabled: () => false,
    currentSource: (responseOk = true, errorMessage?: string): AwsRoute53DnsSource => ({
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53.amazonaws.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {}),
      writeEnabled: false
    }),
    createHostedZone: async (): Promise<AwsRoute53HostedZoneResult> => {
      throw new Error("createHostedZone mock not implemented");
    },
    listHostedZones: async (): Promise<AwsRoute53HostedZoneSummary[]> => [],
    listResourceRecordSets: async (): Promise<AwsRoute53ResourceRecordSet[]> => {
      throw new Error("listResourceRecordSets mock not implemented");
    },
    upsertRecord: async (): Promise<AwsRoute53DnsChangeResult> => {
      throw new Error("upsertRecord mock not implemented");
    },
    ...overrides
  };
}

async function deleteRouteHarness(input: {
  adapter: Route53HostedZoneDeleteAdapter;
  canvasState: CanvasLiveStateSnapshot;
}) {
  const dir = await mkdtemp(join(tmpdir(), "route53-zone-delete-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (zoneId: string, body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleRoute53HostedZoneDeleteHttp({
        request: requestWithJson(body, `/v1/domains/route53/hosted-zones/${zoneId}`, "DELETE"),
        response: response as unknown as ServerResponse,
        auditLog,
        adapter: input.adapter,
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        readCanvasState: () => input.canvasState,
        now: () => fixedNow
      }, zoneId);
    } catch (error) {
      if (!handleRoute53DnsError(error, response as unknown as ServerResponse)) {
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

function mockDeleteAdapter(overrides: Partial<Route53HostedZoneDeleteAdapter> = {}): Route53HostedZoneDeleteAdapter {
  return {
    isLive: () => true,
    isWriteEnabled: () => true,
    currentSource: (responseOk = true, errorMessage?: string): AwsRoute53DnsSource => ({
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53.amazonaws.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {}),
      writeEnabled: true
    }),
    deleteHostedZone: async () => {
      throw new Error("deleteHostedZone mock not implemented");
    },
    ...overrides
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: "2026-05-27T11:58:00.000Z",
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
      taskId: "task-dns-plan",
      kind: "proposal",
      title: "Actualizar DNS",
      editable: true,
      createdAt: "2026-05-27T11:57:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}

function requestWithJson(body: unknown, url = "/v1/domains/route53/dns/upsert", method = "POST"): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method,
    url,
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

async function waitForMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
