import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  AwsRoute53DomainOperationDetail,
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
  waitForRoute53DomainRegistration,
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
    domain: "delivrixops.com",
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
  assert.match(snapshot.files[0], /register_domain_route53-delivrixops.com-blocked\.md$/);
});

test("POST /v1/domains/route53/register blocks high-risk naming before Route53 calls", async () => {
  let listPricesCalled = false;
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => true,
      listPrices: async () => {
        listPricesCalled = true;
        return [{
          tld: "com",
          registration: { amount: 14, currency: "USD" },
          renewal: { amount: 14, currency: "USD" }
        }];
      },
      registerDomain: async () => {
        registerCalled = true;
        return { operationId: "should-not-run", expectedExpiry: fixedNow.toISOString() };
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

  const response = await route({
    domain: "delivrix-notify.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "domain_naming_high_risk");
  assert.ok(response.body.details.blockedReasons.includes("contains_notify"));
  assert.equal(listPricesCalled, false);
  assert.equal(registerCalled, false);

  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.domain.purchase_blocked_naming");
  assert.equal(events.at(-1)?.decision, "reject");
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
    domain: "DelivrixOps.COM.",
    years: 1,
    autoRenew: true,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "pending");
  assert.equal(response.body.domain, "delivrixops.com");
  assert.equal(response.body.operationId, "op-demo-123");
  assert.equal(response.body.costUsd, 14);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, "delivrixops.com");
  assert.equal(calls[0].privacyProtection, true);

  const events = await route.auditLog.list();
  assert.equal(events.length, 2);
  const registered = events.at(-1);
  assert.equal(registered?.action, "oc.domain.registered");
  assert.equal(registered?.humanApproved, true);
  assert.equal(registered?.metadata.operationId, "op-demo-123");

  const inventory = await route.workspace.readInventoryJson<{ domains: Array<{ domain: string; operationId: string }> }>("domains.json");
  assert.deepEqual(inventory?.domains, [{
    domain: "delivrixops.com",
    registrar: "aws-route53",
    status: "pending",
    operationId: "op-demo-123",
    expectedExpiry: "2027-05-29T11:00:00.000Z",
    registeredAt: fixedNow.toISOString(),
    costUsd: 14
  }]);
});

test("POST /v1/domains/route53/register reports unavailable domain distinctly", async () => {
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => true,
      listPrices: async () => [{
        tld: "com",
        registration: { amount: 14, currency: "USD" },
        renewal: { amount: 14, currency: "USD" }
      }],
      registerDomain: async () => {
        throw new Error("AWS Route 53 Domains API returned 400 Bad Request: DomainUnavailable: domain is not available for registration");
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
  await appendDomainApproval(route.auditLog);

  const response = await route({
    domain: "taken-delivrixops.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "domain_unavailable");
  assert.match(response.body.message, /DomainUnavailable/);
  assert.equal((await route.auditLog.list()).at(-1)?.metadata.error, "domain_unavailable");
  const inventory = await route.workspace.readInventoryJson<{ domains: Array<{ domain: string; status: string; costUsd: number; errorMessage?: string }> }>("domains.json");
  assert.equal(inventory?.domains[0].domain, "taken-delivrixops.com");
  assert.equal(inventory?.domains[0].status, "failed");
  assert.equal(inventory?.domains[0].costUsd, 14);
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
      listOwnedDomains: async () => [{ domainName: "delivrixops.com" }],
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
    domain: "delivrixops.com",
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

test("POST /v1/domains/route53/register fails closed when ownership inventory cannot be read", async () => {
  let registerCalled = false;
  let pricesCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => true,
      listOwnedDomains: async () => {
        throw new Error("route53 inventory unavailable");
      },
      listPrices: async () => {
        pricesCalled = true;
        return [{
          tld: "com",
          registration: { amount: 14, currency: "USD" },
          renewal: { amount: 14, currency: "USD" }
        }];
      },
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
  await appendDomainApproval(route.auditLog);

  const response = await route({
    domain: "delivrixops.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["ownership_inventory_unavailable"]);
  assert.equal(pricesCalled, false);
  assert.equal(registerCalled, false);
  assert.equal((await route.auditLog.list()).at(-1)?.decision, "reject");
});

test("POST /v1/domains/route53/register idempotent owned bypasses purchase-only blockers", async () => {
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => false,
      listOwnedDomains: async () => [{ domainName: "delivrixops.com" }],
      registerDomain: async () => {
        registerCalled = true;
        return {
          operationId: "should-not-run",
          expectedExpiry: "2027-05-29T11:00:00.000Z"
        };
      }
    }),
    env: {},
    canvasState: canvasState([{
      artifactId: "artifact-domain-plan",
      executionId: "exec-approved-123",
      approvedAt: "2026-05-29T10:58:00.000Z"
    }])
  });
  await appendDomainApproval(route.auditLog);

  const response = await route({
    domain: "delivrixops.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "idempotent_already_owned");
  assert.equal(response.body.costUsd, 0);
  assert.equal(registerCalled, false);
});

test("POST /v1/domains/route53/register reserves monthly cap before concurrent provider call", async () => {
  const calls: AwsRoute53RegisterDomainInput[] = [];
  let releaseRegister!: () => void;
  let markRegisterStarted!: () => void;
  const registerStarted = new Promise<void>((resolve) => {
    markRegisterStarted = resolve;
  });
  const registerHold = new Promise<void>((resolve) => {
    releaseRegister = resolve;
  });
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
        markRegisterStarted();
        await registerHold;
        return {
          operationId: "op-concurrent-1",
          expectedExpiry: "2027-05-29T11:00:00.000Z"
        };
      }
    }),
    env: {
      AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD: "20",
      DELIVRIX_ADMIN_CONTACT_JSON: JSON.stringify(route53Contact())
    },
    canvasState: canvasState([{
      artifactId: "artifact-domain-plan",
      executionId: "exec-approved-123",
      approvedAt: "2026-05-29T10:58:00.000Z"
    }])
  });
  await appendDomainApproval(route.auditLog);

  const first = route({
    domain: "delivrixops.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });
  await registerStarted;

  const second = await route({
    domain: "delivrixcare.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(second.statusCode, 409);
  assert.deepEqual(second.body.blockers, ["monthly_cap_exceeded"]);
  assert.equal(second.body.monthSpendUsd, 14);
  assert.equal(second.body.projectedSpendUsd, 28);
  assert.equal(calls.length, 1);

  releaseRegister();
  const firstResponse = await first;
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(calls.length, 1);
});

test("POST /v1/domains/route53/register keeps failed provider reservation for reconciliation", async () => {
  let registerCalls = 0;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => true,
      listPrices: async () => [{
        tld: "com",
        registration: { amount: 14, currency: "USD" },
        renewal: { amount: 14, currency: "USD" }
      }],
      registerDomain: async () => {
        registerCalls += 1;
        throw new Error("route53 timeout after submit");
      }
    }),
    env: {
      AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD: "20",
      DELIVRIX_ADMIN_CONTACT_JSON: JSON.stringify(route53Contact())
    },
    canvasState: canvasState([{
      artifactId: "artifact-domain-plan",
      executionId: "exec-approved-123",
      approvedAt: "2026-05-29T10:58:00.000Z"
    }])
  });
  await appendDomainApproval(route.auditLog);

  const first = await route({
    domain: "delivrixops.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });
  assert.equal(first.statusCode, 502);

  const inventory = await route.workspace.readInventoryJson<{ domains: Array<{ domain: string; status: string; costUsd: number; errorMessage?: string }> }>("domains.json");
  assert.equal(inventory?.domains[0].domain, "delivrixops.com");
  assert.equal(inventory?.domains[0].status, "needs_reconciliation");
  assert.equal(inventory?.domains[0].costUsd, 14);
  assert.equal(inventory?.domains[0].errorMessage, "route53 timeout after submit");

  const second = await route({
    domain: "delivrixcare.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(second.statusCode, 409);
  assert.deepEqual(second.body.blockers, ["monthly_cap_exceeded"]);
  assert.equal(registerCalls, 1);
});

test("POST /v1/domains/route53/register fails closed for existing reserved purchase without re-registering", async () => {
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
      registerDomain: async () => {
        registerCalled = true;
        return { operationId: "should-not-run", expectedExpiry: fixedNow.toISOString() };
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
  await appendDomainApproval(route.auditLog);
  await route.workspace.updateInventoryJson("domains.json", () => ({
    domains: [{
      domain: "delivrixops.com",
      registrar: "aws-route53",
      status: "purchase_reserved",
      operationId: "route53-reservation-existing",
      registeredAt: fixedNow.toISOString(),
      costUsd: 14
    }]
  }));

  const response = await route({
    domain: "delivrixops.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.blockers[0], "domain_purchase_reconciliation_required");
  assert.equal(response.body.inventoryStatus, "purchase_reserved");
  assert.equal(response.body.operationId, "route53-reservation-existing");
  assert.equal(registerCalled, false);
});

test("POST /v1/domains/route53/register reconciles successful pending operation without re-registering", async () => {
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => true,
      getOperationDetail: async () => ({
        operationId: "op-existing-success",
        status: "SUCCESSFUL",
        type: "REGISTER_DOMAIN",
        domainName: "delivrixops.com",
        message: "Operation completed"
      }),
      registerDomain: async () => {
        registerCalled = true;
        return { operationId: "should-not-run", expectedExpiry: fixedNow.toISOString() };
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
  await appendDomainApproval(route.auditLog);
  await route.workspace.updateInventoryJson("domains.json", () => ({
    domains: [{
      domain: "delivrixops.com",
      registrar: "aws-route53",
      status: "pending",
      operationId: "op-existing-success",
      registeredAt: fixedNow.toISOString(),
      expectedExpiry: "2027-05-29T11:00:00.000Z",
      costUsd: 14
    }]
  }));

  const response = await route({
    domain: "delivrixops.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "idempotent_already_owned");
  assert.equal(response.body.operationStatus, "SUCCESSFUL");
  assert.equal(registerCalled, false);

  const inventory = await route.workspace.readInventoryJson<{ domains: Array<{ domain: string; status: string; costUsd: number }> }>("domains.json");
  assert.equal(inventory?.domains[0].status, "owned");
  assert.equal(inventory?.domains[0].costUsd, 14);
  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.domain.register_reconciled");
  assert.equal(events.at(-1)?.decision, "allow");
});

test("POST /v1/domains/route53/register keeps in-progress pending operation blocked without re-registering", async () => {
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isPurchaseEnabled: () => true,
      getOperationDetail: async () => ({
        operationId: "op-existing-progress",
        status: "IN_PROGRESS",
        type: "REGISTER_DOMAIN",
        domainName: "delivrixops.com"
      }),
      registerDomain: async () => {
        registerCalled = true;
        return { operationId: "should-not-run", expectedExpiry: fixedNow.toISOString() };
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
  await appendDomainApproval(route.auditLog);
  await route.workspace.updateInventoryJson("domains.json", () => ({
    domains: [{
      domain: "delivrixops.com",
      registrar: "aws-route53",
      status: "pending",
      operationId: "op-existing-progress",
      registeredAt: fixedNow.toISOString(),
      costUsd: 14
    }]
  }));

  const response = await route({
    domain: "delivrixops.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["domain_purchase_still_pending"]);
  assert.equal(response.body.operationStatus, "IN_PROGRESS");
  assert.equal(registerCalled, false);
});

test("waitForRoute53DomainRegistration polls Route53 until SUCCESSFUL and marks inventory owned", async () => {
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "route53-registration-wait-")),
    now: () => fixedNow
  });
  await workspace.updateInventoryJson("domains.json", () => ({
    domains: [{
      domain: "delivrixops.com",
      registrar: "aws-route53",
      status: "pending",
      operationId: "op-wait-success",
      registeredAt: fixedNow.toISOString(),
      expectedExpiry: "2027-05-29T11:00:00.000Z",
      costUsd: 14
    }]
  }));
  const statuses = ["IN_PROGRESS", "SUCCESSFUL"];
  const operations: string[] = [];

  const result = await waitForRoute53DomainRegistration({
    adapter: mockAdapter({
      isLive: () => true,
      getOperationDetail: async (operationId) => {
        operations.push(operationId);
        return {
          operationId,
          status: statuses.shift() ?? "SUCCESSFUL",
          type: "REGISTER_DOMAIN",
          domainName: "delivrixops.com"
        };
      }
    }),
    workspace,
    domain: "delivrixops.com",
    operationId: "op-wait-success",
    maxWaitMs: 90_000,
    pollIntervalMs: 30_000,
    now: () => fixedNow,
    sleep: async () => undefined
  });

  assert.equal(result.status, "owned");
  assert.equal(result.attempts, 2);
  assert.deepEqual(operations, ["op-wait-success", "op-wait-success"]);
  const inventory = await workspace.readInventoryJson<{ domains: Array<{ domain: string; status: string; operationId: string }> }>("domains.json");
  assert.equal(inventory?.domains[0].status, "owned");
  assert.equal(inventory?.domains[0].operationId, "op-wait-success");
});

test("waitForRoute53DomainRegistration times out pending Route53 operations without marking owned", async () => {
  let nowMs = fixedNow.getTime();
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "route53-registration-timeout-")),
    now: () => new Date(nowMs)
  });
  await workspace.updateInventoryJson("domains.json", () => ({
    domains: [{
      domain: "delivrixops.com",
      registrar: "aws-route53",
      status: "pending",
      operationId: "op-wait-timeout",
      registeredAt: fixedNow.toISOString(),
      costUsd: 14
    }]
  }));

  const result = await waitForRoute53DomainRegistration({
    adapter: mockAdapter({
      isLive: () => true,
      getOperationDetail: async (operationId) => ({
        operationId,
        status: "IN_PROGRESS",
        type: "REGISTER_DOMAIN",
        domainName: "delivrixops.com"
      })
    }),
    workspace,
    domain: "delivrixops.com",
    operationId: "op-wait-timeout",
    maxWaitMs: 60_000,
    pollIntervalMs: 30_000,
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.status === "blocked" ? result.blockers : [], ["domain_registration_failed"]);
  assert.equal(result.attempts, 3);
  assert.equal(result.durationMs, 60_000);
  const inventory = await workspace.readInventoryJson<{ domains: Array<{ status: string; operationId: string }> }>("domains.json");
  assert.equal(inventory?.domains[0].status, "pending");
  assert.equal(inventory?.domains[0].operationId, "op-wait-timeout");
});

test("POST /v1/domains/route53/register counts legacy monthly spend in domains inventory", async () => {
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
      registerDomain: async () => {
        registerCalled = true;
        return {
          operationId: "should-not-run",
          expectedExpiry: "2027-05-29T11:00:00.000Z"
        };
      }
    }),
    env: {
      AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD: "20",
      DELIVRIX_ADMIN_CONTACT_JSON: JSON.stringify(route53Contact())
    },
    canvasState: canvasState([{
      artifactId: "artifact-domain-plan",
      executionId: "exec-approved-123",
      approvedAt: "2026-05-29T10:58:00.000Z"
    }])
  });
  await appendDomainApproval(route.auditLog);
  await route.workspace.updateInventoryJson("domains.json", () => ({
    domains: [{
      domain: "legacydelivrixops.com",
      registrar: "aws-route53",
      status: "pending",
      operationId: "op-legacy",
      registeredAt: fixedNow.toISOString(),
      costUsd: 14
    }]
  }));

  const response = await route({
    domain: "delivrixcare.com",
    years: 1,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["monthly_cap_exceeded"]);
  assert.equal(response.body.monthSpendUsd, 14);
  assert.equal(registerCalled, false);
});

test("POST /v1/domains/route53/register reserves the full multi-year registration cost", async () => {
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
      registerDomain: async () => {
        registerCalled = true;
        return {
          operationId: "should-not-run",
          expectedExpiry: "2028-05-29T11:00:00.000Z"
        };
      }
    }),
    env: {
      AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD: "20",
      DELIVRIX_ADMIN_CONTACT_JSON: JSON.stringify(route53Contact())
    },
    canvasState: canvasState([{
      artifactId: "artifact-domain-plan",
      executionId: "exec-approved-123",
      approvedAt: "2026-05-29T10:58:00.000Z"
    }])
  });
  await appendDomainApproval(route.auditLog);

  const response = await route({
    domain: "delivrixops.com",
    years: 2,
    autoRenew: false,
    actorId: "operator/juanes",
    approvalToken: "exec-approved-123"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["monthly_cap_exceeded"]);
  assert.equal(response.body.costUsd, 28);
  assert.equal(response.body.projectedSpendUsd, 28);
  assert.equal(registerCalled, false);
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
    getOperationDetail: async (): Promise<AwsRoute53DomainOperationDetail> => {
      throw new Error("getOperationDetail mock not implemented");
    },
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

async function appendDomainApproval(
  auditLog: LocalFileAuditLog,
  artifactId = "artifact-domain-plan",
  executionId = "exec-approved-123"
): Promise<void> {
  await auditLog.append({
    id: "audit-approved",
    occurredAt: "2026-05-29T10:58:00.000Z",
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
