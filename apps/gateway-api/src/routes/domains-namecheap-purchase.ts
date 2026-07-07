import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  NamecheapInventoryResult,
  NamecheapRegisterDomainResult
} from "../../../../packages/adapters/src/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import type {
  OpenClawWorkspace,
  OpenClawWorkspaceFileRef
} from "../openclaw-workspace.ts";
import { readRequestBody } from "../request-body.ts";
import { validateDomainNaming } from "../services/naming-validator.ts";
import { approvalMaxAgeMs, findRecentApproval } from "./domains-purchase.ts";

/**
 * Registro de dominios vía Namecheap — camino accionable v1 (compra).
 *
 * Handler paralelo al de Route53 (`domains-purchase.ts`), replicando su
 * secuencia de gates contra la forma (síncrona) del adapter Namecheap. NO toca
 * el camino Route53. Fail-closed por defecto: sin `NAMECHEAP_ENABLE_PURCHASE`,
 * sin credenciales, sin ApprovalGate reciente, sin cap → bloquea sin llamar a
 * la API. El cap de gasto mensual es Namecheap-scoped (filtra por
 * `registrar === "namecheap"` en el `domains.json` compartido).
 */

export interface NamecheapPurchaseAdapter {
  readonly accountId: string;
  readonly accountLabel: string;
  isLive(): boolean;
  purchaseEnabled(): boolean;
  listInventory(): Promise<NamecheapInventoryResult>;
  registerDomain(input: {
    domainName: string;
    years?: number;
    whoisPrivacy?: boolean;
  }): Promise<NamecheapRegisterDomainResult>;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface NamecheapDomainRegisterDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  /** Resuelve la cuenta Namecheap destino por accountId (default: primera). */
  resolveAdapter: (accountId?: string) => NamecheapPurchaseAdapter | null;
  workspace: OpenClawWorkspace;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface NamecheapDomainRegisterBody {
  domain?: unknown;
  years?: unknown;
  whoisPrivacy?: unknown;
  accountId?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
}

interface DomainsInventory {
  domains?: Array<{
    domain: string;
    registrar?: string;
    status?: string;
    registeredAt?: string;
    costUsd?: number;
    transactionId?: string;
    accountId?: string;
    errorMessage?: string;
  }>;
}

const skillName = "register_domain_namecheap";
const registrar = "namecheap";

export class NamecheapDomainPurchaseInputError extends Error {}

export async function handleNamecheapDomainRegisterHttp(
  deps: NamecheapDomainRegisterDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<NamecheapDomainRegisterBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const years = normalizeYears(body.years);
  const whoisPrivacy = typeof body.whoisPrivacy === "boolean" ? body.whoisPrivacy : true;
  const requestedAccountId = typeof body.accountId === "string" && body.accountId.trim()
    ? body.accountId.trim()
    : undefined;
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");

  // Gate de naming (compartido con Route53 — registrar-agnóstico).
  const naming = validateDomainNaming(domain);
  if (!naming.passes) {
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.purchase_blocked_naming",
      targetType: "domain",
      targetId: domain,
      riskLevel: "high",
      decision: "reject",
      humanApproved: false,
      metadata: {
        registrar,
        score: naming.score,
        blockedReasons: naming.blockedReasons,
        hint: "POST /v1/skills/suggest-safe-domain"
      }
    });
    json(deps.response, 422, {
      ok: false,
      status: "blocked",
      error: "domain_naming_high_risk",
      details: { domain, score: naming.score, blockedReasons: naming.blockedReasons }
    });
    return;
  }

  const adapter = deps.resolveAdapter(requestedAccountId);
  const blockers: string[] = [];
  if (!adapter) {
    blockers.push("namecheap_account_not_found");
  }
  if (adapter && !adapter.isLive()) blockers.push("namecheap_credentials_missing");
  if (adapter && !adapter.purchaseEnabled()) blockers.push("purchase_flag_disabled");

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) blockers.push("approval_not_found_or_expired");

  // Idempotencia: si el dominio ya es propiedad de esta cuenta, no re-comprar.
  if (adapter && blockers.length === 0) {
    const owned = await namecheapDomainOwned(adapter, domain);
    if (owned) {
      const workspace = await safeWriteExecution(deps.workspace, {
        skill: skillName,
        params: { domain, years, accountId: adapter.accountId, actorId },
        outcome: "success",
        durationMs: Date.now() - startedAt,
        evidence: { status: "idempotent_already_owned", registrar, costUsd: 0, accountId: adapter.accountId }
      });
      await safeUpdateDomainInventory(deps.workspace, {
        domain,
        status: "owned",
        registeredAt: now.toISOString(),
        costUsd: 0,
        accountId: adapter.accountId
      });
      await deps.auditLog.append({
        actorType: "operator",
        actorId,
        action: "oc.domain.register_idempotent",
        targetType: "domain",
        targetId: domain,
        riskLevel: "critical",
        decision: "allow",
        humanApproved: true,
        approverIds: [actorId],
        metadata: { registrar, status: "idempotent_already_owned", costUsd: 0, accountId: adapter.accountId, approvalToken }
      });
      json(deps.response, 200, { ok: true, domain, status: "idempotent_already_owned", costUsd: 0, accountId: adapter.accountId, workspace });
      return;
    }
  }

  // Cap de gasto mensual Namecheap-scoped.
  const monthlyCapUsd = parsePositiveMoney(env.NAMECHEAP_DOMAINS_MONTHLY_CAP_USD);
  if (monthlyCapUsd === null) blockers.push("monthly_cap_missing");
  const estimatedCostUsd = roundUsd(
    (parsePositiveMoney(env.NAMECHEAP_DOMAINS_DEFAULT_COST_USD) ?? 15) * years
  );
  if (monthlyCapUsd !== null) {
    const monthSpend = await currentNamecheapMonthSpend(deps.workspace, now);
    if (monthSpend + estimatedCostUsd > monthlyCapUsd) blockers.push("monthly_cap_exceeded");
  }

  if (blockers.length > 0 || !adapter) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, years, accountId: requestedAccountId, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: { blockers, registrar, approvalMatched: Boolean(approval) }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.register_blocked",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: { registrar, blockers, accountId: requestedAccountId, workspacePath: workspace?.path }
    });
    json(deps.response, 409, { ok: false, status: "blocked", domain, blockers, workspace });
    return;
  }

  // Ejecución real (todos los gates pasaron).
  let result: NamecheapRegisterDomainResult;
  try {
    result = await adapter.registerDomain({ domainName: domain, years, whoisPrivacy });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, years, accountId: adapter.accountId, actorId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: { registrar, error: errorMessage(error) }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.register_failed",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: { registrar, accountId: adapter.accountId, error: errorMessage(error), workspacePath: workspace?.path }
    });
    json(deps.response, 502, { ok: false, status: "failed", domain, error: "namecheap_register_failed", message: errorMessage(error), workspace });
    return;
  }

  if (result.status !== "registered") {
    // El adapter cortó (flag/creds) o falló. Reflejar sin exponer secretos.
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.register_blocked",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: { registrar, accountId: adapter.accountId, status: result.status, blockedReason: result.blockedReason }
    });
    json(deps.response, 409, { ok: false, status: result.status, domain, blockedReason: result.blockedReason });
    return;
  }

  const costUsd = typeof result.chargedAmountUsd === "number" ? roundUsd(result.chargedAmountUsd) : estimatedCostUsd;
  const workspace = await safeWriteExecution(deps.workspace, {
    skill: skillName,
    params: { domain, years, accountId: adapter.accountId, actorId },
    outcome: "success",
    durationMs: Date.now() - startedAt,
    evidence: { status: "registered", registrar, costUsd, transactionId: result.transactionId, accountId: adapter.accountId }
  });
  await safeUpdateDomainInventory(deps.workspace, {
    domain,
    status: "owned",
    registeredAt: now.toISOString(),
    costUsd,
    transactionId: result.transactionId,
    accountId: adapter.accountId
  });
  await deps.auditLog.append({
    actorType: "operator",
    actorId,
    action: "oc.domain.register",
    targetType: "domain",
    targetId: domain,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [actorId],
    metadata: { registrar, accountId: adapter.accountId, costUsd, transactionId: result.transactionId, approvalToken, workspacePath: workspace?.path }
  });

  json(deps.response, 200, {
    ok: true,
    domain,
    status: "registered",
    registrar,
    accountId: adapter.accountId,
    costUsd,
    transactionId: result.transactionId,
    workspace
  });
}

export function handleNamecheapDomainPurchaseError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof NamecheapDomainPurchaseInputError) {
    json(response, 400, { ok: false, error: "invalid_request", message: error.message });
    return true;
  }
  return false;
}

// --- helpers (self-contained; el cap es Namecheap-scoped) --------------------

async function namecheapDomainOwned(adapter: NamecheapPurchaseAdapter, domain: string): Promise<boolean> {
  try {
    const inventory = await adapter.listInventory();
    return inventory.domains.some((entry) => normalizeDomainName(entry.domainName) === domain);
  } catch {
    return false;
  }
}

async function currentNamecheapMonthSpend(workspace: OpenClawWorkspace, now: Date): Promise<number> {
  const inventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  const month = now.toISOString().slice(0, 7);
  return (inventory?.domains ?? []).reduce((total, entry) => {
    if (entry.registrar !== registrar || typeof entry.costUsd !== "number") return total;
    if (!entry.registeredAt?.startsWith(month)) return total;
    return total + entry.costUsd;
  }, 0);
}

async function safeUpdateDomainInventory(
  workspace: OpenClawWorkspace,
  input: { domain: string; status: string; registeredAt: string; costUsd?: number; transactionId?: string; accountId?: string }
): Promise<OpenClawWorkspaceFileRef | null> {
  try {
    return await workspace.updateInventoryJson<DomainsInventory>("domains.json", (current) => {
      const domains = (current?.domains ?? []).filter((entry) => entry.domain !== input.domain);
      domains.push({
        domain: input.domain,
        registrar,
        status: input.status,
        registeredAt: input.registeredAt,
        ...(typeof input.costUsd === "number" ? { costUsd: input.costUsd } : {}),
        ...(input.transactionId ? { transactionId: input.transactionId } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {})
      });
      return { ...(current ?? {}), domains };
    });
  } catch {
    return null;
  }
}

async function safeWriteExecution(
  workspace: OpenClawWorkspace,
  input: Parameters<OpenClawWorkspace["writeExecutionRecord"]>[0]
): Promise<OpenClawWorkspaceFileRef | null> {
  try {
    return await workspace.writeExecutionRecord(input);
  } catch {
    return null;
  }
}

function parsePositiveMoney(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeYears(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new NamecheapDomainPurchaseInputError("years must be a number.");
  const years = Math.trunc(parsed);
  if (years < 1 || years > 10) throw new NamecheapDomainPurchaseInputError("years must be between 1 and 10.");
  return years;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NamecheapDomainPurchaseInputError(`${field} is required.`);
  }
  return value.trim();
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new NamecheapDomainPurchaseInputError(`Invalid domain name: ${value}`);
  }
  return normalized;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) throw new NamecheapDomainPurchaseInputError("Request body is required.");
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Namecheap domain registration error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
