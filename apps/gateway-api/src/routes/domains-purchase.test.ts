import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  AwsRoute53DomainPrice,
  AwsRoute53DomainsInventorySource,
  AwsRoute53RegisterDomainInput,
  AwsRoute53RegisterDomainResult
} from "../../../../packages/adapters/src/index.ts";
import type { CanvasLiveStateSnapshot } from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import {
  handleRoute53DomainPurchaseError,
  handleRoute53DomainRegisterHttp,
  type Route53DomainPurchaseAdapter
} from "./domains-purchase.ts";

const fixedNow = new Date("2026-05-29T11:00:00.000Z");

test("POST /v1/domains/route53/register blocks when hard gates are missing", async () => {
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => false,
      isPurchaseEnabled: () => false,
      registerDomain: async () => {
        registerCalled = true;
        return { operationId: "should-not-run", expectedExpiry: fixedNow.toISOString() };
      }
    }),
    env: {},
    canvasState: canvasState([])
  });

  const response = await route({
    domain: "delivrix-mail.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-missing"
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.status, "blocked");
  assert.deepEqual(response.body.blockers.sort(), [
    "admin_contact_missing",
    "approval_not_found_or_expired",
    "aws_route53_credentials_missing",
    "monthly_cap_missing",
    "purchase_flag_disabled"
  ].sort());
  assert.equal(registerCalled, false);

  const events = await route.auditLog.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.domain.register_blocked");
  assert.equal(events[0].decision, "reject");

  const snapshot = await route.workspace.snapshot();
  assert.equal(snapshot.files.length, 1);
  assert.match(snapshot.files[0], /register_domain_route53-delivrix-mail.com-blocked\.md$/);
});

test("POST /v1/domains/route53/register registers after approval, cap, contact, and price checks", async () => {
  const calls: AwsRoute53RegisterDomainInput[] = [];
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => true,
      listPrices: async () => [{
        tld: "com",
        registration: { amount: 14, currency: "USD" },
        renewal: { amount: 14, currency: "USD" }
      }],
      registerDomain: async (input) => {
        calls.push(input);
        return {
          operationId: "op-demo-123",
          expectedExpiry: "2027-05-29T11:00:00.000Z"
        };
      }
    }),
    env: {
      AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD: "50",
      DELIVRIX_ADMIN_CONTACT_JSON: JSON.stringify(route53Contact())
    },
    canvasState: canvasState([{
      artifactId: "artifact-domain-plan",
      executionId: "exec-approved-123",
      approvedAt: "2026-05-29T10:58:00.000Z"
    }])
  });
  await route.auditLog.append({
    id: "audit-approved",
    occurredAt: "2026-05-29T10:58:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: "artifact-domain-plan",
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: {
      executionId: "exec-approved-123",
      approvalTokenHash: approvalTokenHash("exec-approved-123"),
      blockCount: 1
    }
  });

  const response = await route({
    domain: "Delivrix-Mail.COM.",
    years: 1,
    autoRenew: true,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "pending");
  assert.equal(response.body.domain, "delivrix-mail.com");
  assert.equal(response.body.operationId, "op-demo-123");
  assert.equal(response.body.costUsd, 14);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, "delivrix-mail.com");
  assert.equal(calls[0].privacyProtection, true);

  const events = await route.auditLog.list();
  assert.equal(events.length, 2);
  const registered = events.at(-1);
  assert.equal(registered?.action, "oc.domain.registered");
  assert.equal(registered?.humanApproved, true);
  assert.equal(registered?.metadata.operationId, "op-demo-123");

  const inventory = await route.workspace.readInventoryJson<{ domains: Array<{ domain: string; operationId: string }> }>("domains.json");
  assert.deepEqual(inventory?.domains, [{
    domain: "delivrix-mail.com",
    registrar: "aws-route53",
    status: "pending",
    operationId: "op-demo-123",
    expectedExpiry: "2027-05-29T11:00:00.000Z",
    registeredAt: fixedNow.toISOString(),
    costUsd: 14
  }]);
});

test("POST /v1/domains/route53/register is idempotent when domain is already owned", async () => {
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => true,
      listPrices: async () => [{
        tld: "com",
        registration: { amount: 14, currency: "USD" },
        renewal: { amount: 14, currency: "USD" }
      }],
      listOwnedDomains: async () => [{ domainName: "delivrix-mail.com" }],
      registerDomain: async () => {
        registerCalled = true;
        return {
          operationId: "should-not-run",
          expectedExpiry: "2027-05-29T11:00:00.000Z"
        };
      }
    }),
    env: {
      AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD: "50",
      DELIVRIX_ADMIN_CONTACT_JSON: JSON.stringify(route53Contact())
    },
    canvasState: canvasState([{
      artifactId: "artifact-domain-plan",
      executionId: "exec-approved-123",
      approvedAt: "2026-05-29T10:58:00.000Z"
    }])
  });
  await route.auditLog.append({
    id: "audit-approved",
    occurredAt: "2026-05-29T10:58:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: "artifact-domain-plan",
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: {
      executionId: "exec-approved-123",
      approvalTokenHash: approvalTokenHash("exec-approved-123"),
      blockCount: 1
    }
  });

  const response = await route({
    domain: "delivrix-mail.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "idempotent_already_owned");
  assert.equal(response.body.costUsd, 0);
  assert.equal(registerCalled, false);
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.domain.register_idempotent");
});

async function routeHarness(input: {
  adapter: Route53DomainPurchaseAdapter;
  env: Record<string, string | undefined>;
  canvasState: CanvasLiveStateSnapshot;
}) {
  const dir = await mkdtemp(join(tmpdir(), "route53-register-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });

  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleRoute53DomainRegisterHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        adapter: input.adapter,
        workspace,
        readCanvasState: () => input.canvasState,
        env: input.env,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleRoute53DomainPurchaseError(error, response as unknown as ServerResponse)) {
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

function mockAdapter(overrides: Partial<Route53DomainPurchaseAdapter> = {}): Route53DomainPurchaseAdapter {
  return {
    isLive: () => true,
    isPurchaseEnabled: () => false,
    listPrices: async (): Promise<AwsRoute53DomainPrice[]> => [],
    registerDomain: async (): Promise<AwsRoute53RegisterDomainResult> => {
      throw new Error("registerDomain mock not implemented");
    },
    currentSource: (responseOk = true, errorMessage?: string): AwsRoute53DomainsInventorySource => ({
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53domains.us-east-1.amazonaws.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {})
    }),
    ...overrides
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/domains/route53/register",
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
      taskId: "task-domain-plan",
      kind: "proposal",
      title: "Comprar dominio",
      editable: true,
      createdAt: "2026-05-29T10:57:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}

function route53Contact() {
  return {
    FirstName: "Delivrix",
    LastName: "Ops",
    ContactType: "COMPANY",
    OrganizationName: "Delivrix",
    AddressLine1: "123 Demo Street",
    City: "Bogota",
    State: "Bogota",
    CountryCode: "CO",
    ZipCode: "110111",
    PhoneNumber: "+57.3000000000",
    Email: "ops@example.com"
  };
}
