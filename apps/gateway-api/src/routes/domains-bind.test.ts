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
import { approvalTokenHash } from "../approval-guard.ts";
import {
  buildDomainBindRecords,
  handleDomainBindError,
  handleDomainBindHttp,
  type DomainBindDnsAdapter
} from "./domains-bind.ts";

const fixedNow = new Date("2026-05-28T10:00:00.000Z");

test("buildDomainBindRecords creates canonical smtp A and root MX records", () => {
  assert.deepEqual(buildDomainBindRecords("delivrix-mail.com", "192.0.2.44"), [
    {
      name: "smtp.delivrix-mail.com.",
      type: "A",
      ttl: 300,
      values: ["192.0.2.44"]
    },
    {
      name: "delivrix-mail.com.",
      type: "MX",
      ttl: 300,
      values: ["10 smtp.delivrix-mail.com."]
    }
  ]);
});

test("POST /v1/domains/bind blocks without DNS writes, approval, zone, and server IP", async () => {
  const route = await routeHarness({
    dnsAdapter: mockDnsAdapter({ isLive: () => false, isWriteEnabled: () => false }),
    canvasState: canvasState([]),
    env: { DOMAIN_BIND_ENABLE: "false" }
  });

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    taskId: "task-bind-blocked"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "aws_route53_dns_credentials_missing",
    "domain_bind_flag_disabled",
    "dns_write_flag_disabled",
    "route53_zone_missing",
    "server_ip_missing"
  ].sort());
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.domain.bind_blocked");
});

test("POST /v1/domains/bind upserts MX and A records from workspace inventory", async () => {
  const upserts: AwsRoute53DnsRecordInput[] = [];
  const route = await routeHarness({
    dnsAdapter: mockDnsAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      upsertRecord: async (_zoneId, record) => {
        upserts.push(record);
        return { changeId: `C${upserts.length}` };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-bind-plan",
      executionId: "exec-bind-123",
      approvedAt: "2026-05-28T09:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-bind-plan", "exec-bind-123");
  await route.workspace.updateInventoryJson("domains.json", () => ({
    dnsZones: [{
      domain: "delivrix-mail.com",
      zoneId: "Z123"
    }]
  }));
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      ipv4: "192.0.2.44"
    }]
  }));

  const response = await route({
    domain: "Delivrix-Mail.COM.",
    serverSlug: "mail-delivrix-test",
    actorId: "operator/juanes",
    approvalToken: "exec-bind-123",
    taskId: "task-bind-domain"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "pending_propagation");
  assert.equal(response.body.serverIp, "192.0.2.44");
  assert.deepEqual(upserts.map((record) => [record.name, record.type]), [
    ["smtp.delivrix-mail.com.", "A"],
    ["delivrix-mail.com.", "MX"]
  ]);
  assert.equal(response.body.mxHost, "smtp.delivrix-mail.com");

  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.domain.bound_to_server");

  const inventory = await route.workspace.readInventoryJson<{
    bindings: Array<{ domain: string; serverSlug: string; serverIp: string; status: string }>;
  }>("domains.json");
  assert.equal(inventory?.bindings[0].domain, "delivrix-mail.com");
  assert.equal(inventory?.bindings[0].serverSlug, "mail-delivrix-test");
  assert.equal(inventory?.bindings[0].status, "pending_propagation");
  assert.ok(route.canvasEvents.some((event) => event.type === "oc.action.now" && event.kind === "api"));
});

test("POST /v1/domains/bind resolves Route53 zone from AWS fallback when workspace inventory is empty", async () => {
  const upsertZones: string[] = [];
  const route = await routeHarness({
    dnsAdapter: mockDnsAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      listHostedZones: async () => [{
        zoneId: "ZAWSFALLBACK1",
        name: "delivrix-mail.com.",
        nameServers: ["ns-1.awsdns.com"]
      }],
      upsertRecord: async (zoneId, record) => {
        upsertZones.push(zoneId);
        return { changeId: `C${record.type}` };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-bind-plan",
      executionId: "exec-bind-aws-zone",
      approvedAt: "2026-05-28T09:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-bind-plan", "exec-bind-aws-zone");
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      ipv4: "192.0.2.44"
    }]
  }));

  const response = await route({
    domain: "delivrix-mail.com",
    serverSlug: "mail-delivrix-test",
    actorId: "operator/juanes",
    approvalToken: "exec-bind-aws-zone",
    taskId: "task-bind-aws-zone"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "pending_propagation");
  assert.deepEqual(upsertZones, ["ZAWSFALLBACK1", "ZAWSFALLBACK1"]);
});

test("POST /v1/domains/bind rejects timestamp fragments as unresolved domains before DNS writes", async () => {
  const upserts: AwsRoute53DnsRecordInput[] = [];
  const route = await routeHarness({
    dnsAdapter: mockDnsAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      upsertRecord: async (_zoneId, record) => {
        upserts.push(record);
        return { changeId: `C${upserts.length}` };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-bind-plan",
      executionId: "exec-bind-bad-domain",
      approvedAt: "2026-05-28T09:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-bind-plan", "exec-bind-bad-domain");
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      ipv4: "192.0.2.44"
    }]
  }));

  const response = await route({
    domain: "37.842Z",
    serverSlug: "mail-delivrix-test",
    zoneId: "Z123",
    actorId: "operator/juanes",
    approvalToken: "exec-bind-bad-domain",
    taskId: "task-bind-bad-domain"
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.blockers.includes("entity_not_resolved"), true);
  assert.equal(response.body.entityResolution.failures[0].reason, "timestamp_fragment_is_not_domain");
  assert.equal(upserts.length, 0);
  const events = await route.auditLog.list();
  assert.equal(events.some((event) => event.action === "oc.guard.entity_not_resolved"), true);
  assert.equal(events.at(-1)?.action, "oc.domain.bind_blocked");
});

test("POST /v1/domains/bind blocks serverSlug that is absent from inventory", async () => {
  const route = await routeHarness({
    dnsAdapter: mockDnsAdapter({ isLive: () => true, isWriteEnabled: () => true }),
    canvasState: canvasState([{
      artifactId: "artifact-bind-plan",
      executionId: "exec-bind-missing-server",
      approvedAt: "2026-05-28T09:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-bind-plan", "exec-bind-missing-server");
  await route.workspace.updateInventoryJson("domains.json", () => ({
    dnsZones: [{
      domain: "delivrix-mail.com",
      zoneId: "Z123"
    }]
  }));

  const response = await route({
    domain: "delivrix-mail.com",
    serverSlug: "missing-server",
    actorId: "operator/juanes",
    approvalToken: "exec-bind-missing-server",
    taskId: "task-bind-missing-server"
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.blockers.includes("entity_not_resolved"), true);
  assert.equal(response.body.blockers.includes("server_ip_missing"), true);
  assert.equal(response.body.entityResolution.failures[0].reason, "server_slug_not_in_inventory");
});

async function routeHarness(input: {
  dnsAdapter: DomainBindDnsAdapter;
  canvasState: CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "domain-bind-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleDomainBindHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        dnsAdapter: input.dnsAdapter,
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        readCanvasState: () => input.canvasState,
        env: input.env ?? { DOMAIN_BIND_ENABLE: "true" },
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleDomainBindError(error, response as unknown as ServerResponse)) {
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

function mockDnsAdapter(overrides: Partial<DomainBindDnsAdapter> = {}): DomainBindDnsAdapter {
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
    upsertRecord: async (): Promise<AwsRoute53DnsChangeResult> => {
      throw new Error("upsertRecord mock not implemented");
    },
    createHostedZone: async (): Promise<AwsRoute53HostedZoneResult> => {
      throw new Error("createHostedZone mock not implemented");
    },
    listHostedZones: async (): Promise<AwsRoute53HostedZoneSummary[]> => [{
      zoneId: "Z123",
      name: "delivrix-mail.com.",
      nameServers: ["ns-1.awsdns.com"]
    }],
    listResourceRecordSets: async (): Promise<AwsRoute53ResourceRecordSet[]> => [{
      name: "delivrix-mail.com.",
      type: "NS",
      ttl: 172800,
      values: ["ns-1.awsdns.com."]
    }],
    ...overrides
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: "2026-05-28T09:59:00.000Z",
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
      taskId: "task-bind-plan",
      kind: "proposal",
      title: "Bind dominio",
      editable: true,
      createdAt: "2026-05-28T09:58:00.000Z",
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
    url: "/v1/domains/bind",
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
