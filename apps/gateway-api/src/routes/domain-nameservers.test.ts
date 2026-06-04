import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  AwsRoute53DomainsInventorySource,
  AwsRoute53HostedZoneSummary,
  AwsRoute53ResourceRecordSet,
  AwsRoute53UpdateDomainNameserversResult
} from "../../../../packages/adapters/src/index.ts";
import type { CanvasLiveEvent, CanvasLiveStateSnapshot } from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  handleDomainNameserverUpdateError,
  handleDomainNameserverUpdateHttp,
  type DomainNameserverDnsAdapter,
  type DomainNameserverRegistrarAdapter
} from "./domain-nameservers.ts";

const fixedNow = new Date("2026-06-04T17:00:00.000Z");

test("POST /v1/domains/route53/nameservers/update blocks without ApprovalGate", async () => {
  let updateCalled = false;
  const route = await routeHarness({
    registrarAdapter: mockRegistrarAdapter({
      updateDomainNameservers: async () => {
        updateCalled = true;
        return { operationId: "should-not-run" };
      }
    }),
    dnsAdapter: mockDnsAdapter(),
    canvasState: canvasState([])
  });

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    taskId: "task-ns-blocked"
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.blockers.includes("approval_not_found_or_expired"), true);
  assert.equal(updateCalled, false);
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.domain.nameservers_update_blocked");
});

test("POST /v1/domains/route53/nameservers/update updates registrar to verified Route53 zone", async () => {
  const updates: Array<{ domain: string; nameservers: string[] }> = [];
  const route = await routeHarness({
    registrarAdapter: mockRegistrarAdapter({
      getDomainNameservers: async () => ["ns-old-1.example.net", "ns-old-2.example.net"],
      updateDomainNameservers: async (domain, nameservers) => {
        updates.push({ domain, nameservers });
        return { operationId: "op-ns-123" };
      }
    }),
    dnsAdapter: mockDnsAdapter(),
    canvasState: canvasState([{
      artifactId: "artifact-ns-plan",
      executionId: "exec-ns-123",
      approvedAt: "2026-06-04T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-ns-plan", "exec-ns-123");

  const response = await route({
    domain: "Delivrix-Mail.COM.",
    zoneId: "Z1234567890",
    nameservers: ["ns-2.awsdns.net.", "ns-1.awsdns.com"],
    actorId: "operator/juanes",
    approvalToken: "exec-ns-123",
    taskId: "task-ns-update"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "updated");
  assert.equal(response.body.operationId, "op-ns-123");
  assert.deepEqual(updates, [{
    domain: "delivrix-mail.com",
    nameservers: ["ns-1.awsdns.com", "ns-2.awsdns.net"]
  }]);
  const event = (await route.auditLog.list()).at(-1);
  assert.equal(event?.action, "oc.domain.nameservers_updated");
  assert.equal(event?.metadata.operationId, "op-ns-123");
});

test("POST /v1/domains/route53/nameservers/update blocks empty Route53 zone before registrar mutation", async () => {
  let updateCalled = false;
  const route = await routeHarness({
    registrarAdapter: mockRegistrarAdapter({
      updateDomainNameservers: async () => {
        updateCalled = true;
        return { operationId: "should-not-run" };
      }
    }),
    dnsAdapter: mockDnsAdapter({
      listResourceRecordSets: async () => [{
        name: "delivrix-mail.com.",
        type: "NS",
        ttl: 172800,
        values: ["ns-1.awsdns.com.", "ns-2.awsdns.net."]
      }]
    }),
    canvasState: canvasState([{
      artifactId: "artifact-ns-plan",
      executionId: "exec-ns-empty",
      approvedAt: "2026-06-04T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-ns-plan", "exec-ns-empty");

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-ns-empty",
    taskId: "task-ns-empty"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["zone_missing_smtp_a_mx"]);
  assert.equal(updateCalled, false);
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.domain.nameservers_update_blocked");
});

test("POST /v1/domains/route53/nameservers/update blocks smtp MX without matching A before registrar mutation", async () => {
  let updateCalled = false;
  const route = await routeHarness({
    registrarAdapter: mockRegistrarAdapter({
      updateDomainNameservers: async () => {
        updateCalled = true;
        return { operationId: "should-not-run" };
      }
    }),
    dnsAdapter: mockDnsAdapter({
      listResourceRecordSets: async () => [
        {
          name: "delivrix-mail.com.",
          type: "NS",
          ttl: 172800,
          values: ["ns-1.awsdns.com.", "ns-2.awsdns.net."]
        },
        {
          name: "delivrix-mail.com.",
          type: "MX",
          ttl: 300,
          values: ["10 smtp.delivrix-mail.com."]
        }
      ]
    }),
    canvasState: canvasState([{
      artifactId: "artifact-ns-plan",
      executionId: "exec-ns-missing-a",
      approvedAt: "2026-06-04T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-ns-plan", "exec-ns-missing-a");

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-ns-missing-a",
    taskId: "task-ns-missing-a"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["zone_missing_smtp_a_mx"]);
  assert.equal(response.body.smtpSetup.hasTargetMx, true);
  assert.equal(response.body.smtpSetup.hasTargetA, false);
  assert.equal(updateCalled, false);
});

test("POST /v1/domains/route53/nameservers/update tolerates one legacy mail zone when no smtp zone exists", async () => {
  const updates: Array<{ domain: string; nameservers: string[] }> = [];
  const route = await routeHarness({
    registrarAdapter: mockRegistrarAdapter({
      getDomainNameservers: async () => ["ns-old-1.example.net", "ns-old-2.example.net"],
      updateDomainNameservers: async (domain, nameservers) => {
        updates.push({ domain, nameservers });
        return { operationId: "op-ns-legacy" };
      }
    }),
    dnsAdapter: mockDnsAdapter({
      listResourceRecordSets: async (): Promise<AwsRoute53ResourceRecordSet[]> => [
        {
          name: "delivrix-mail.com.",
          type: "NS",
          ttl: 172800,
          values: ["ns-1.awsdns.com.", "ns-2.awsdns.net."]
        },
        {
          name: "mail.delivrix-mail.com.",
          type: "A",
          ttl: 300,
          values: ["192.0.2.44"]
        },
        {
          name: "delivrix-mail.com.",
          type: "MX",
          ttl: 300,
          values: ["10 mail.delivrix-mail.com."]
        }
      ]
    }),
    canvasState: canvasState([{
      artifactId: "artifact-ns-plan",
      executionId: "exec-ns-legacy",
      approvedAt: "2026-06-04T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-ns-plan", "exec-ns-legacy");

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-ns-legacy",
    taskId: "task-ns-legacy"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "updated");
  assert.equal(response.body.operationId, "op-ns-legacy");
  assert.equal(updates.length, 1);
});

async function routeHarness(input: {
  registrarAdapter: DomainNameserverRegistrarAdapter;
  dnsAdapter: DomainNameserverDnsAdapter;
  canvasState: CanvasLiveStateSnapshot;
  killSwitch?: { enabled: boolean };
}) {
  const dir = await mkdtemp(join(tmpdir(), "domain-nameservers-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleDomainNameserverUpdateHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        registrarAdapter: input.registrarAdapter,
        dnsAdapter: input.dnsAdapter,
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        readCanvasState: () => input.canvasState,
        readKillSwitch: () => input.killSwitch ?? { enabled: false },
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleDomainNameserverUpdateError(error, response as unknown as ServerResponse)) {
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

function mockRegistrarAdapter(overrides: Partial<DomainNameserverRegistrarAdapter> = {}): DomainNameserverRegistrarAdapter {
  return {
    isLive: () => true,
    isNameserverUpdateEnabled: () => true,
    currentSource: (responseOk = true, errorMessage?: string): AwsRoute53DomainsInventorySource => ({
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53domains.us-east-1.amazonaws.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {})
    }),
    getDomainNameservers: async () => ["ns-old-1.example.net", "ns-old-2.example.net"],
    updateDomainNameservers: async (): Promise<AwsRoute53UpdateDomainNameserversResult> => {
      throw new Error("updateDomainNameservers mock not implemented");
    },
    ...overrides
  };
}

function mockDnsAdapter(overrides: Partial<DomainNameserverDnsAdapter> = {}): DomainNameserverDnsAdapter {
  return {
    isLive: () => true,
    isWriteEnabled: () => false,
    currentSource: (responseOk = true, errorMessage?: string) => ({
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53.amazonaws.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {}),
      writeEnabled: false
    }),
    createHostedZone: async () => {
      throw new Error("createHostedZone should not be called for nameserver update");
    },
    listHostedZones: async (): Promise<AwsRoute53HostedZoneSummary[]> => [{
      zoneId: "Z1234567890",
      name: "delivrix-mail.com.",
      nameServers: []
    }],
    listResourceRecordSets: async (): Promise<AwsRoute53ResourceRecordSet[]> => [
      {
        name: "delivrix-mail.com.",
        type: "NS",
        ttl: 172800,
        values: ["ns-1.awsdns.com.", "ns-2.awsdns.net."]
      },
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
    ],
    ...overrides
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: "2026-06-04T16:59:00.000Z",
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
      taskId: "task-ns-plan",
      kind: "proposal",
      title: "Actualizar nameservers",
      editable: true,
      createdAt: "2026-06-04T16:58:00.000Z",
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
    url: "/v1/domains/route53/nameservers/update",
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
