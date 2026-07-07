import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  NamecheapInventoryResult,
  NamecheapRegisterDomainResult
} from "../../../../packages/adapters/src/index.ts";
import type { CanvasLiveStateSnapshot } from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import {
  handleNamecheapDomainPurchaseError,
  handleNamecheapDomainRegisterHttp,
  type NamecheapPurchaseAdapter
} from "./domains-namecheap-purchase.ts";

const fixedNow = new Date("2026-07-07T11:00:00.000Z");

test("POST /v1/domains/namecheap/register bloquea sin flag/creds/aprobación/cap sin llamar a la API", async () => {
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => false,
      purchaseEnabled: () => false,
      registerDomain: async () => {
        registerCalled = true;
        return { accountId: "namecheap-1", domainName: "x", status: "registered" };
      }
    }),
    env: {},
    canvasState: canvasState([])
  });

  const response = await route({
    domain: "delivrixops.com",
    years: 1,
    actorId: "operator/juanes",
    approvalToken: "exec-missing"
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.status, "blocked");
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "monthly_cap_missing",
    "namecheap_credentials_missing",
    "purchase_flag_disabled"
  ].sort());
  assert.equal(registerCalled, false);
  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.domain.register_blocked");
});

test("bloquea dominio de alto riesgo con 422 sin tocar la API", async () => {
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({ registerDomain: async () => { registerCalled = true; return anyRegistered(); } }),
    env: { NAMECHEAP_ENABLE_PURCHASE: "true", NAMECHEAP_DOMAINS_MONTHLY_CAP_USD: "100" },
    canvasState: canvasState([])
  });
  const response = await route({ domain: "free-viagra-casino-loans.com", years: 1, actorId: "operator/juanes", approvalToken: "x" });
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "domain_naming_high_risk");
  assert.equal(registerCalled, false);
});

test("cap excedido bloquea", async () => {
  const route = await routeHarness({
    adapter: mockAdapter({ purchaseEnabled: () => true }),
    env: { NAMECHEAP_ENABLE_PURCHASE: "true", NAMECHEAP_DOMAINS_MONTHLY_CAP_USD: "5", NAMECHEAP_DOMAINS_DEFAULT_COST_USD: "15" },
    canvasState: canvasState([{ artifactId: "a", executionId: "exec-ok", approvedAt: "2026-07-07T10:58:00.000Z" }])
  });
  await appendDomainApproval(route.auditLog, "a", "exec-ok");
  const response = await route({ domain: "delivrixops.com", years: 1, actorId: "operator/juanes", approvalToken: "exec-ok" });
  assert.equal(response.statusCode, 409);
  assert.ok(response.body.blockers.includes("monthly_cap_exceeded"));
});

test("dominio ya poseído responde idempotente sin comprar", async () => {
  let registerCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      purchaseEnabled: () => true,
      listInventory: async () => inventoryWith(["delivrixops.com"]),
      registerDomain: async () => { registerCalled = true; return anyRegistered(); }
    }),
    env: { NAMECHEAP_ENABLE_PURCHASE: "true", NAMECHEAP_DOMAINS_MONTHLY_CAP_USD: "100" },
    canvasState: canvasState([{ artifactId: "a", executionId: "exec-ok", approvedAt: "2026-07-07T10:58:00.000Z" }])
  });
  await appendDomainApproval(route.auditLog, "a", "exec-ok");
  const response = await route({ domain: "delivrixops.com", years: 1, actorId: "operator/juanes", approvalToken: "exec-ok" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "idempotent_already_owned");
  assert.equal(response.body.costUsd, 0);
  assert.equal(registerCalled, false);
});

test("happy path: todos los gates pasan → registered + inventario registrar:namecheap", async () => {
  const route = await routeHarness({
    adapter: mockAdapter({
      accountId: "namecheap-1",
      purchaseEnabled: () => true,
      listInventory: async () => inventoryWith([]),
      registerDomain: async () => ({ accountId: "namecheap-1", domainName: "delivrixops.com", status: "registered", transactionId: "tx-9", chargedAmountUsd: 9.06 })
    }),
    env: { NAMECHEAP_ENABLE_PURCHASE: "true", NAMECHEAP_DOMAINS_MONTHLY_CAP_USD: "100" },
    canvasState: canvasState([{ artifactId: "a", executionId: "exec-ok", approvedAt: "2026-07-07T10:58:00.000Z" }])
  });
  await appendDomainApproval(route.auditLog, "a", "exec-ok");
  const response = await route({ domain: "delivrixops.com", years: 1, actorId: "operator/juanes", approvalToken: "exec-ok" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "registered");
  assert.equal(response.body.registrar, "namecheap");
  assert.equal(response.body.accountId, "namecheap-1");
  assert.equal(response.body.costUsd, 9.06);
  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.domain.register");
  assert.equal(events.at(-1)?.decision, "allow");
  const inv = await route.workspace.readInventoryJson<{ domains?: Array<{ domain: string; registrar?: string }> }>("domains.json");
  assert.equal(inv?.domains?.find((d) => d.domain === "delivrixops.com")?.registrar, "namecheap");
});

test("resolveAdapter=null → bloquea con namecheap_account_not_found", async () => {
  const route = await routeHarnessResolve(() => null, { NAMECHEAP_ENABLE_PURCHASE: "true", NAMECHEAP_DOMAINS_MONTHLY_CAP_USD: "100" });
  const response = await route({ domain: "delivrixops.com", years: 1, actorId: "operator/juanes", approvalToken: "x" });
  assert.equal(response.statusCode, 409);
  assert.ok(response.body.blockers.includes("namecheap_account_not_found"));
});

// --- helpers ---------------------------------------------------------------

function anyRegistered(): NamecheapRegisterDomainResult {
  return { accountId: "namecheap-1", domainName: "delivrixops.com", status: "registered" };
}

function inventoryWith(domains: string[]): NamecheapInventoryResult {
  return {
    accountId: "namecheap-1",
    accountLabel: "Namecheap",
    accountStatus: "active",
    domains: domains.map((domainName) => ({ domainName, tld: domainName.split(".").at(-1) ?? "", status: "active" })),
    source: { kind: "live", apiBase: "https://api.namecheap.com/xml.response", fetchedAt: fixedNow.toISOString(), responseOk: true }
  };
}

function mockAdapter(overrides: Partial<NamecheapPurchaseAdapter> = {}): NamecheapPurchaseAdapter {
  return {
    accountId: "namecheap-1",
    accountLabel: "Namecheap",
    isLive: () => true,
    purchaseEnabled: () => false,
    listInventory: async () => inventoryWith([]),
    registerDomain: async () => { throw new Error("registerDomain mock not implemented"); },
    ...overrides
  };
}

async function routeHarness(input: {
  adapter: NamecheapPurchaseAdapter;
  env: Record<string, string | undefined>;
  canvasState: CanvasLiveStateSnapshot;
}) {
  return routeHarnessResolve(() => input.adapter, input.env, input.canvasState);
}

async function routeHarnessResolve(
  resolveAdapter: (accountId?: string) => NamecheapPurchaseAdapter | null,
  env: Record<string, string | undefined>,
  canvas: CanvasLiveStateSnapshot = canvasState([])
) {
  const dir = await mkdtemp(join(tmpdir(), "namecheap-register-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({ rootDir: join(dir, "workspace"), now: () => fixedNow });

  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleNamecheapDomainRegisterHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        resolveAdapter,
        workspace,
        readCanvasState: () => canvas,
        env,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleNamecheapDomainPurchaseError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return { statusCode: response.statusCode, body: JSON.parse(response.body) };
  };
  return Object.assign(route, { auditLog, workspace });
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/domains/namecheap/register",
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

async function appendDomainApproval(auditLog: LocalFileAuditLog, artifactId: string, executionId: string): Promise<void> {
  await auditLog.append({
    id: "audit-approved",
    occurredAt: "2026-07-07T10:58:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: { executionId, approvalTokenHash: approvalTokenHash(executionId), blockCount: 1 }
  });
}

function canvasState(approvals: Array<{ artifactId: string; executionId: string; approvedAt: string }>): CanvasLiveStateSnapshot {
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
      createdAt: "2026-07-07T10:57:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}
