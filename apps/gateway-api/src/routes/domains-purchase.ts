import { randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  AwsRoute53ContactDetail,
  AwsRoute53DomainPrice,
  AwsRoute53DomainsInventorySource,
  AwsRoute53RegisterDomainInput,
  AwsRoute53RegisterDomainResult
} from "../../../../packages/adapters/src/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveArtifactSnapshot,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import type {
  OpenClawWorkspace,
  OpenClawWorkspaceFileRef
} from "../openclaw-workspace.ts";
import {
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken
} from "../approval-guard.ts";
import { readRequestBody } from "../request-body.ts";
import { validateDomainNaming } from "../services/naming-validator.ts";

export interface Route53DomainPurchaseAdapter {
  isLive(): boolean;
  isPurchaseEnabled(): boolean;
  listPrices(tlds?: string[]): Promise<AwsRoute53DomainPrice[]>;
  listOwnedDomains?(): Promise<Array<{ domainName: string }>>;
  registerDomain(input: AwsRoute53RegisterDomainInput): Promise<AwsRoute53RegisterDomainResult>;
  currentSource(responseOk?: boolean, errorMessage?: string): AwsRoute53DomainsInventorySource;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface Route53DomainRegisterDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: Route53DomainPurchaseAdapter;
  workspace: OpenClawWorkspace;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface Route53DomainRegisterBody {
  domain?: unknown;
  years?: unknown;
  autoRenew?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
}

interface DomainsInventory {
  domains?: Array<{
    domain: string;
    registrar?: string;
    status?: string;
    operationId?: string;
    registeredAt?: string;
    expectedExpiry?: string;
    costUsd?: number;
    errorMessage?: string;
  }>;
}

const approvalMaxAgeMs = 15 * 60 * 1000;
const skillName = "register_domain_route53";
const monthlySpendLocks = new Map<string, Promise<void>>();

export async function handleRoute53DomainRegisterHttp(
  deps: Route53DomainRegisterDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<Route53DomainRegisterBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const years = normalizeYears(body.years);
  const autoRenew = typeof body.autoRenew === "boolean" ? body.autoRenew : false;
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const source = deps.adapter.currentSource(true);
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
        registrar: "aws-route53",
        score: naming.score,
        blockedReasons: naming.blockedReasons,
        hint: "POST /v1/skills/suggest-safe-domain"
      }
    });

    json(deps.response, 422, {
      ok: false,
      status: "blocked",
      error: "domain_naming_high_risk",
      details: {
        domain,
        score: naming.score,
        blockedReasons: naming.blockedReasons,
        hint: "Llama POST /v1/skills/suggest-safe-domain para obtener alternativas validadas."
      }
    });
    return;
  }

  const blockers: string[] = [];
  if (!deps.adapter.isLive()) blockers.push("aws_route53_credentials_missing");

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) blockers.push("approval_not_found_or_expired");

  let monthlyCapUsd: number | null = null;
  let adminContact: AwsRoute53ContactDetail | null = null;
  let costUsd: number | null = null;

  const alreadyOwned = blockers.length === 0
    ? await adapterAlreadyOwnsDomain(deps.adapter, domain).catch(() => false)
    : false;
  if (alreadyOwned) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, years, autoRenew, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        status: "idempotent_already_owned",
        registrar: "aws-route53",
        costUsd: 0,
        approvalArtifactId: approval?.artifactId
      }
    });
    await safeUpdateDomainInventory(deps.workspace, {
      domain,
      operationId: "idempotent_already_owned",
      expectedExpiry: undefined,
      costUsd: 0,
      registeredAt: now.toISOString(),
      status: "owned"
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
      metadata: {
        registrar: "aws-route53",
        status: "idempotent_already_owned",
        costUsd: 0,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });

    json(deps.response, 200, {
      ok: true,
      domain,
      status: "idempotent_already_owned",
      operationId: "idempotent_already_owned",
      costUsd: 0,
      workspace
    });
    return;
  }

  if (!deps.adapter.isPurchaseEnabled()) blockers.push("purchase_flag_disabled");

  monthlyCapUsd = parsePositiveMoney(env.AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD);
  if (monthlyCapUsd === null) blockers.push("monthly_cap_missing");

  const contactResult = parseAdminContact(env.DELIVRIX_ADMIN_CONTACT_JSON);
  adminContact = contactResult.ok ? contactResult.contact : null;
  if (!contactResult.ok) blockers.push(contactResult.blocker);

  if (blockers.length === 0) {
    try {
      const annualCostUsd = registrationCostForTld(await deps.adapter.listPrices([domainTld(domain)]), domainTld(domain));
      costUsd = annualCostUsd === null ? null : roundUsd(annualCostUsd * years);
      if (annualCostUsd === null) {
        blockers.push("registration_price_unavailable");
      }
    } catch (error) {
      blockers.push("registration_price_unavailable");
    }
  }

  let monthSpendUsd = 0;

  if (blockers.length > 0) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, years, autoRenew, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        sourceKind: source.kind,
        monthlyCapUsd,
        costUsd,
        monthSpendUsd,
        approvalMatched: Boolean(approval)
      }
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
      metadata: {
        registrar: "aws-route53",
        blockers,
        sourceKind: source.kind,
        monthlyCapUsd,
        costUsd,
        monthSpendUsd,
        workspacePath: workspace?.path
      }
    });

    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      domain,
      blockers,
      costUsd,
      monthlyCapUsd,
      source,
      workspace
    });
    return;
  }

  const reservation = await reserveRoute53MonthlySpend({
    workspace: deps.workspace,
    domain,
    now,
    monthlyCapUsd: monthlyCapUsd as number,
    costUsd: costUsd as number
  });
  monthSpendUsd = reservation.monthSpendUsd;
  if (!reservation.ok) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, years, autoRenew, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers: reservation.blockers,
        sourceKind: source.kind,
        monthlyCapUsd,
        costUsd,
        monthSpendUsd,
        projectedSpendUsd: reservation.projectedSpendUsd,
        approvalMatched: Boolean(approval)
      }
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
      metadata: {
        registrar: "aws-route53",
        blockers: reservation.blockers,
        sourceKind: source.kind,
        monthlyCapUsd,
        costUsd,
        monthSpendUsd,
        projectedSpendUsd: reservation.projectedSpendUsd,
        workspacePath: workspace?.path
      }
    });

    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      domain,
      blockers: reservation.blockers,
      costUsd,
      monthlyCapUsd,
      monthSpendUsd,
      projectedSpendUsd: reservation.projectedSpendUsd,
      source,
      workspace
    });
    return;
  }

  try {
    const result = await deps.adapter.registerDomain({
      domain,
      years,
      autoRenew,
      adminContact: adminContact as AwsRoute53ContactDetail,
      privacyProtection: true
    });
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, years, autoRenew, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        operationId: result.operationId,
        expectedExpiry: result.expectedExpiry,
        registrar: "aws-route53",
        costUsd,
        approvalArtifactId: approval?.artifactId
      }
    });
    await safeUpdateDomainInventory(deps.workspace, {
      domain,
      operationId: result.operationId,
      expectedExpiry: result.expectedExpiry,
      costUsd: costUsd ?? undefined,
      registeredAt: now.toISOString()
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.registered",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        registrar: "aws-route53",
        operationId: result.operationId,
        costUsd,
        currency: "USD",
        years,
        autoRenew,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        monthlyCapUsd,
        monthSpendUsd,
        projectedSpendUsd: reservation.projectedSpendUsd,
        reservationOperationId: reservation.operationId,
        workspacePath: workspace?.path
      }
    });

    json(deps.response, 200, {
      ok: true,
      domain,
      operationId: result.operationId,
      expectedExpiry: result.expectedExpiry,
      costUsd,
      status: "pending",
      reservationOperationId: reservation.operationId,
      workspace
    });
  } catch (error) {
    await safeMarkDomainPurchaseNeedsReconciliation(deps.workspace, {
      domain,
      operationId: reservation.operationId,
      registeredAt: now.toISOString(),
      costUsd: costUsd ?? undefined,
      errorMessage: errorMessage(error)
    });
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, years, autoRenew, actorId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        error: errorMessage(error),
        sourceKind: source.kind
      }
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
      metadata: {
        registrar: "aws-route53",
        errorMessage: errorMessage(error),
        costUsd,
        workspacePath: workspace?.path
      }
    });
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      domain,
      error: "route53_register_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export class Route53DomainPurchaseInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "Route53DomainPurchaseInputError";
  }
}

export function handleRoute53DomainPurchaseError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof Route53DomainPurchaseInputError) {
    json(response, error.statusCode, {
      error: "invalid_route53_domain_register_request",
      message: error.message
    });
    return true;
  }
  if (error instanceof SyntaxError) {
    json(response, 400, {
      error: "invalid_json",
      message: "Request body must be valid JSON."
    });
    return true;
  }
  return false;
}

async function findRecentApproval(input: {
  auditLog: AuditSink;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  approvalToken: string;
  now: Date;
  maxAgeMs: number;
}): Promise<CanvasLiveArtifactSnapshot | null> {
  const state = await input.readCanvasState();
  const auditApproval = await findRecentAuditApproval({
    auditLog: input.auditLog,
    approvalToken: input.approvalToken,
    now: input.now,
    maxAgeMs: input.maxAgeMs
  });
  if (!auditApproval) {
    return null;
  }

  for (const artifact of state.artifacts) {
    if (artifactMatchesAuditApproval({
      artifact,
      approvalEvent: auditApproval,
      approvalToken: input.approvalToken,
      now: input.now,
      maxAgeMs: input.maxAgeMs
    })) {
      return artifact;
    }
  }
  return null;
}

async function findRecentAuditApproval(input: {
  auditLog: AuditSink;
  approvalToken: string;
  now: Date;
  maxAgeMs: number;
}): Promise<AuditEvent | null> {
  if (!input.auditLog.list) {
    return null;
  }
  const events = await input.auditLog.list();
  for (const event of events.toReversed()) {
    if (!auditApprovalMatchesToken(event, input.approvalToken)) {
      continue;
    }
    const approvedAt = Date.parse(event.occurredAt);
    if (!Number.isFinite(approvedAt)) {
      continue;
    }
    const ageMs = input.now.getTime() - approvedAt;
    if (ageMs >= 0 && ageMs <= input.maxAgeMs) {
      return event;
    }
  }
  return null;
}

async function currentRoute53MonthSpend(workspace: OpenClawWorkspace, now: Date): Promise<number> {
  const inventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  const month = now.toISOString().slice(0, 7);
  return (inventory?.domains ?? []).reduce((total, entry) => {
    if (entry.registrar !== "aws-route53" || typeof entry.costUsd !== "number") {
      return total;
    }
    if (!entry.registeredAt?.startsWith(month)) {
      return total;
    }
    if (!route53DomainSpendCountsTowardCap(entry.status)) {
      return total;
    }
    return total + entry.costUsd;
  }, 0);
}

type Route53MonthlySpendReservation =
  | {
      ok: true;
      operationId: string;
      monthSpendUsd: number;
      projectedSpendUsd: number;
    }
  | {
      ok: false;
      blockers: string[];
      monthSpendUsd: number;
      projectedSpendUsd: number;
    };

async function reserveRoute53MonthlySpend(input: {
  workspace: OpenClawWorkspace;
  domain: string;
  now: Date;
  monthlyCapUsd: number;
  costUsd: number;
}): Promise<Route53MonthlySpendReservation> {
  const locked = await withRoute53MonthSpendLock(input.workspace, input.now, async () => {
    const monthSpendUsd = await currentRoute53MonthSpend(input.workspace, input.now);
    const projectedSpendUsd = roundUsd(monthSpendUsd + input.costUsd);
    if (projectedSpendUsd > input.monthlyCapUsd) {
      return {
        ok: false as const,
        blockers: ["monthly_cap_exceeded"],
        monthSpendUsd,
        projectedSpendUsd
      };
    }

    const operationId = `route53-reservation-${randomUUID()}`;
    const inventoryRef = await safeUpdateDomainInventory(input.workspace, {
      domain: input.domain,
      operationId,
      costUsd: input.costUsd,
      registeredAt: input.now.toISOString(),
      status: "purchase_reserved"
    });
    if (!inventoryRef) {
      return {
        ok: false as const,
        blockers: ["monthly_cap_reservation_failed"],
        monthSpendUsd,
        projectedSpendUsd
      };
    }

    return {
      ok: true as const,
      operationId,
      monthSpendUsd,
      projectedSpendUsd
    };
  });

  return locked ?? {
    ok: false,
    blockers: ["monthly_cap_lock_unavailable"],
    monthSpendUsd: 0,
    projectedSpendUsd: input.costUsd
  };
}

async function withRoute53MonthSpendLock<T>(
  workspace: OpenClawWorkspace,
  now: Date,
  callback: () => Promise<T>
): Promise<T | null> {
  const month = now.toISOString().slice(0, 7);
  const key = `${workspace.getRootDir()}:${month}`;
  const previous = monthlySpendLocks.get(key) ?? Promise.resolve();
  let releaseLocalLock!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLocalLock = resolve;
  });
  const queued = previous.then(() => current);
  monthlySpendLocks.set(key, queued);

  await previous;
  let releaseFileLock: (() => Promise<void>) | null = null;

  try {
    releaseFileLock = await acquireRoute53MonthSpendFileLock(workspace, month);
    if (!releaseFileLock) {
      return null;
    }
    return await callback();
  } finally {
    if (releaseFileLock) {
      await releaseFileLock();
    }
    releaseLocalLock();
    if (monthlySpendLocks.get(key) === queued) {
      monthlySpendLocks.delete(key);
    }
  }
}

async function acquireRoute53MonthSpendFileLock(
  workspace: OpenClawWorkspace,
  month: string
): Promise<(() => Promise<void>) | null> {
  await workspace.ensureBase();
  const lockRoot = join(workspace.getRootDir(), "inventory", ".locks");
  await mkdir(lockRoot, { recursive: true });
  const lockDir = join(lockRoot, `route53-monthly-cap-${month}.lock`);

  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rmdir(lockDir).catch(() => undefined);
      };
    } catch (error) {
      if (!isFileAlreadyExistsError(error)) {
        return null;
      }
      await sleep(20);
    }
  }
  return null;
}

function route53DomainSpendCountsTowardCap(status: string | undefined): boolean {
  return status !== "released" && status !== "failed";
}

async function safeUpdateDomainInventory(
  workspace: OpenClawWorkspace,
  input: {
    domain: string;
    operationId: string;
    expectedExpiry?: string;
    costUsd?: number;
    registeredAt: string;
    status?: string;
    errorMessage?: string;
  }
): Promise<OpenClawWorkspaceFileRef | null> {
  try {
    return await workspace.updateInventoryJson<DomainsInventory>("domains.json", (current) => {
      const domains = (current?.domains ?? [])
        .filter((entry) => entry.domain !== input.domain);
      domains.push({
        domain: input.domain,
        registrar: "aws-route53",
        status: input.status ?? "pending",
        operationId: input.operationId,
        registeredAt: input.registeredAt,
        ...(input.expectedExpiry ? { expectedExpiry: input.expectedExpiry } : {}),
        ...(typeof input.costUsd === "number" ? { costUsd: input.costUsd } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {})
      });
      return { domains };
    });
  } catch {
    return null;
  }
}

async function safeMarkDomainPurchaseNeedsReconciliation(
  workspace: OpenClawWorkspace,
  input: {
    domain: string;
    operationId: string;
    costUsd?: number;
    registeredAt: string;
    errorMessage: string;
  }
): Promise<OpenClawWorkspaceFileRef | null> {
  return safeUpdateDomainInventory(workspace, {
    domain: input.domain,
    operationId: input.operationId,
    costUsd: input.costUsd,
    registeredAt: input.registeredAt,
    status: "needs_reconciliation",
    errorMessage: input.errorMessage
  });
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

function parseAdminContact(raw: string | undefined):
  | { ok: true; contact: AwsRoute53ContactDetail }
  | { ok: false; blocker: string } {
  if (!raw?.trim()) {
    return { ok: false, blocker: "admin_contact_missing" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AwsRoute53ContactDetail>;
    const required = [
      "FirstName",
      "LastName",
      "ContactType",
      "AddressLine1",
      "City",
      "CountryCode",
      "ZipCode",
      "PhoneNumber",
      "Email"
    ] as const;
    for (const field of required) {
      if (typeof parsed[field] !== "string" || parsed[field]?.trim().length === 0) {
        return { ok: false, blocker: "admin_contact_invalid" };
      }
    }
    return { ok: true, contact: parsed as AwsRoute53ContactDetail };
  } catch {
    return { ok: false, blocker: "admin_contact_invalid" };
  }
}

async function adapterAlreadyOwnsDomain(
  adapter: Route53DomainPurchaseAdapter,
  domain: string
): Promise<boolean> {
  if (!adapter.listOwnedDomains) return false;
  const owned = await adapter.listOwnedDomains();
  return owned.some((entry) => normalizeDomainName(entry.domainName) === domain);
}

function registrationCostForTld(prices: AwsRoute53DomainPrice[], tld: string): number | null {
  const price = prices.find((entry) => entry.tld === tld);
  return typeof price?.registration?.amount === "number" ? price.registration.amount : null;
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
  if (!Number.isFinite(parsed)) {
    throw new Route53DomainPurchaseInputError("years must be a number.");
  }
  const years = Math.trunc(parsed);
  if (years < 1 || years > 10) {
    throw new Route53DomainPurchaseInputError("years must be between 1 and 10.");
  }
  return years;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Route53DomainPurchaseInputError(`${field} is required.`);
  }
  return value.trim();
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new Route53DomainPurchaseInputError(`Invalid domain name: ${value}`);
  }
  return normalized;
}

function domainTld(domain: string): string {
  return domain.split(".").at(-1) ?? "";
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new Route53DomainPurchaseInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Route53 domain registration error";
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}
