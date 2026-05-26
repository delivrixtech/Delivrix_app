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
  AwsRoute53HostedZoneResult
} from "../../../../packages/adapters/src/index.ts";
import type {
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  handleRoute53DnsError,
  handleRoute53DnsUpsertHttp,
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
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      createHostedZone: async (domain) => ({
        zoneId: domain === "delivrix-mail.com" ? "Z123" : "ZOTHER",
        nameServers: ["ns-1.awsdns.com", "ns-2.awsdns.net"]
      }),
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

async function routeHarness(input: {
  adapter: Route53DnsAdapter;
  canvasState: CanvasLiveStateSnapshot;
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
    upsertRecord: async (): Promise<AwsRoute53DnsChangeResult> => {
      throw new Error("upsertRecord mock not implemented");
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

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/domains/route53/dns/upsert",
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
