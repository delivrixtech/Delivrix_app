import type { IncomingMessage, ServerResponse } from "node:http";
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
  }>;
}

const approvalMaxAgeMs = 15 * 60 * 1000;
const skillName = "register_domain_route53";

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

  const blockers: string[] = [];
  if (!deps.adapter.isLive()) blockers.push("aws_route53_credentials_missing");
  if (!deps.adapter.isPurchaseEnabled()) blockers.push("purchase_flag_disabled");

  const monthlyCapUsd = parsePositiveMoney(env.AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD);
  if (monthlyCapUsd === null) blockers.push("monthly_cap_missing");

  const contactResult = parseAdminContact(env.DELIVRIX_ADMIN_CONTACT_JSON);
  const adminContact = contactResult.ok ? contactResult.contact : null;
  if (!contactResult.ok) blockers.push(contactResult.blocker);

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) blockers.push("approval_not_found_or_expired");

  let costUsd: number | null = null;
  if (blockers.length === 0) {
    try {
      costUsd = registrationCostForTld(await deps.adapter.listPrices([domainTld(domain)]), domainTld(domain));
      if (costUsd === null) {
        blockers.push("registration_price_unavailable");
      }
    } catch (error) {
      blockers.push("registration_price_unavailable");
    }
  }

  let monthSpendUsd = 0;
  if (blockers.length === 0 && monthlyCapUsd !== null && costUsd !== null) {
    monthSpendUsd = await currentRoute53MonthSpend(deps.workspace, now);
    if (monthSpendUsd + costUsd > monthlyCapUsd) {
      blockers.push("monthly_cap_exceeded");
    }
  }

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

  const alreadyOwned = await adapterAlreadyOwnsDomain(deps.adapter, domain).catch(() => false);
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
      workspace
    });
  } catch (error) {
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
    return total + entry.costUsd;
  }, 0);
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
        ...(typeof input.costUsd === "number" ? { costUsd: input.costUsd } : {})
      });
      return { domains };
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
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Route53DomainPurchaseInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Route53 domain registration error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}
