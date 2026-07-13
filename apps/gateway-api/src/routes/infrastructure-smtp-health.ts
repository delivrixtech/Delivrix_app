import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import type {
  SmtpProvisioningInventory,
  SmtpProvisioningServer,
  SmtpInventoryEntryStatus
} from "../smtp-inventory-management.ts";
import {
  buildSmtpHealthIssue,
  type SmtpHealthIssue,
  type SmtpHealthIssueSeverity
} from "./smtp-health-issue-catalog.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

/**
 * PR-09 — Builder PURO de salud SMTP por cuenta (drill-down "Ver detalle", read-only).
 *
 * Cruza las fuentes de `runtime/openclaw-workspace/inventory/` (domains.json, smtp-provisioning.json,
 * smtp-credentials.json, webdock-servers.json, smtp-runs/*.json) con la flota viva del provider y el
 * estado de warmup para clasificar cada SMTP de la cuenta en estados operativos. Sin escrituras, sin
 * SSH: es una función pura sobre snapshots ya leídos. Las credenciales se REDACTAN (nunca se expone
 * username completo ni el material cifrado).
 */

export type SmtpUnitState =
  | "active"
  | "down"
  | "error"
  | "no_smtp"
  | "orphan_domain_no_smtp"
  | "server_no_domain"
  | "credential_no_server"
  | "pending_registration";

export interface SmtpHealthEvidence {
  source: "smtp-runs" | "provisioning" | "credential" | "live" | "domains" | "route53" | "warmup";
  detail?: string;
  runId?: string;
  runStatus?: string;
  lastCompletedStep?: number;
  budgetSpentUsd?: number;
}

export interface SmtpHealthUnit {
  state: SmtpUnitState;
  domain?: string;
  serverSlug?: string;
  serverIp?: string;
  smtpHost?: string;
  /** Estado de la credencial: "configured"/"superseded"/… o "none". NUNCA el username ni el secreto. */
  credentialStatus?: string;
  tlsStatus?: string;
  liveStatus?: string;
  warmup?: { status: string; day?: number };
  evidence: SmtpHealthEvidence[];
  issues: SmtpHealthIssue[];
}

export interface AccountSmtpHealthSummary {
  active: number;
  down: number;
  error: number;
  orphans: number;
  noSmtp: number;
  pendingRegistration: number;
  total: number;
}

export interface AccountSmtpHealth {
  providerId: string;
  accountId: string;
  accountLabel?: string;
  generatedAt: string;
  dataSource: "live" | "cache";
  summary: AccountSmtpHealthSummary;
  units: SmtpHealthUnit[];
  unattachedOrphans: SmtpHealthUnit[];
}

export interface SmtpHealthLiveServer {
  slug: string;
  ipv4?: string;
  status?: string;
  accountId?: string;
}

export interface DomainsInventoryRecord {
  domain: string;
  registrar?: string;
  status?: string;
  costUsd?: number;
  registeredAt?: string;
}

export interface DomainBindingRecord {
  domain: string;
  serverSlug?: string;
  serverIp?: string;
  status?: string;
}

export interface DomainsInventory {
  domains?: DomainsInventoryRecord[];
  bindings?: DomainBindingRecord[];
}

export interface SmtpCredentialRecord {
  domain: string;
  serverSlug: string;
  host?: string;
  status?: string;
}

export interface SmtpCredentialsInventory {
  smtpCredentials?: SmtpCredentialRecord[];
}

export interface WebdockServersInventoryRecord {
  slug: string;
  ipv4?: string;
  status?: string;
}

export interface WebdockServersInventory {
  servers?: WebdockServersInventoryRecord[];
}

export interface SmtpRunRecord {
  runId: string;
  status?: string;
  chosenDomain?: string;
  serverSlug?: string;
  providerId?: string;
  budgetSpentUsd?: number;
  lastCompletedStep?: number;
  params?: { brand?: string };
}

export interface WarmupStatusByDomain {
  [domain: string]: { status?: string; day?: number };
}

export interface BuildAccountSmtpHealthInput {
  providerId: string;
  accountId: string;
  accountLabel?: string;
  dataSource?: "live" | "cache";
  /** Flota viva de ESTA cuenta (fetch del provider ya realizado). */
  liveServers: SmtpHealthLiveServer[];
  /** Slugs vivos en TODAS las cuentas del provider (para no marcar orphan una credencial de otra cuenta). */
  allLiveServerSlugs?: string[];
  domainsInventory?: DomainsInventory | null;
  provisioningInventory?: SmtpProvisioningInventory | null;
  credentialsInventory?: SmtpCredentialsInventory | null;
  webdockServersInventory?: WebdockServersInventory | null;
  smtpRuns?: SmtpRunRecord[];
  warmupByDomain?: WarmupStatusByDomain;
  /** Dominios con >1 server configured (de inspectSmtpInventory().ambiguousDomains). */
  ambiguousDomains?: string[];
  /** runIds con lock huérfano vigente (pid muerto). */
  staleLockRunIds?: string[];
  now?: Date;
}

const runningLiveStatuses = new Set(["running", "active", "ok"]);
const okTlsStatuses = new Set(["ok", "valid", "issued", "active"]);
const pendingDomainStatuses = new Set(["pending", "needs_reconciliation", "provisioning", "in_progress"]);

export function buildAccountSmtpHealth(input: BuildAccountSmtpHealthInput): AccountSmtpHealth {
  const now = input.now ?? new Date();
  const provisioning = input.provisioningInventory?.servers ?? [];
  const credentials = input.credentialsInventory?.smtpCredentials ?? [];
  const domains = input.domainsInventory?.domains ?? [];
  const bindings = input.domainsInventory?.bindings ?? [];
  const smtpRuns = input.smtpRuns ?? [];
  const ambiguous = new Set((input.ambiguousDomains ?? []).map(normalizeDomain));
  const staleLocks = new Set(input.staleLockRunIds ?? []);
  const warmupByDomain = input.warmupByDomain ?? {};

  const liveBySlug = new Map<string, SmtpHealthLiveServer>();
  for (const server of input.liveServers) {
    if (server.slug) liveBySlug.set(server.slug, server);
  }
  const allLiveSlugs = new Set(input.allLiveServerSlugs ?? input.liveServers.map((server) => server.slug));
  const webdockSlugs = new Set((input.webdockServersInventory?.servers ?? []).map((server) => server.slug));

  const configuredBySlug = new Map<string, SmtpProvisioningServer>();
  for (const entry of provisioning) {
    if (entry.status === "configured") configuredBySlug.set(entry.serverSlug, entry);
  }
  const bindingBySlug = new Map<string, DomainBindingRecord>();
  for (const binding of bindings) {
    if (binding.serverSlug) bindingBySlug.set(binding.serverSlug, binding);
  }
  const credentialBySlug = new Map<string, SmtpCredentialRecord>();
  for (const credential of credentials) {
    if (credential.serverSlug) credentialBySlug.set(credential.serverSlug, credential);
  }

  // Dominios owned que ya tienen algún SMTP configured (globalmente): no son huérfanos.
  const configuredDomains = new Set(provisioning.filter((entry) => entry.status === "configured").map((entry) => normalizeDomain(entry.domain)));

  const failedRunsByDomain = new Map<string, SmtpRunRecord[]>();
  const failedRunsBySlug = new Map<string, SmtpRunRecord[]>();
  for (const run of smtpRuns) {
    if (run.status !== "failed") continue;
    if (run.chosenDomain) pushToMap(failedRunsByDomain, normalizeDomain(run.chosenDomain), run);
    if (run.serverSlug) pushToMap(failedRunsBySlug, run.serverSlug, run);
  }

  const units: SmtpHealthUnit[] = [];
  const unattachedOrphans: SmtpHealthUnit[] = [];

  // 1) Una unidad por server vivo de la cuenta.
  for (const server of input.liveServers) {
    const slug = server.slug;
    const prov = configuredBySlug.get(slug);
    const binding = bindingBySlug.get(slug);
    const domain = prov ? normalizeDomain(prov.domain) : binding ? normalizeDomain(binding.domain) : undefined;
    const credential = credentialBySlug.get(slug) ?? prov?.smtpCredential;
    const running = isRunning(server.status);
    const evidence: SmtpHealthEvidence[] = [{
      source: "live",
      detail: `status=${server.status ?? "unknown"}`
    }];
    const issues: SmtpHealthIssue[] = [];

    if (!prov && !domain) {
      // Server vivo sin dominio ni SMTP → huérfano.
      issues.push(buildSmtpHealthIssue("server_without_domain", { serverSlug: slug }));
      unattachedOrphans.push(finalizeUnit({
        state: "server_no_domain",
        serverSlug: slug,
        ...(server.ipv4 ? { serverIp: server.ipv4 } : {}),
        liveStatus: server.status ?? "unknown",
        evidence,
        issues
      }));
      continue;
    }

    if (!prov) {
      // Dominio bound pero sin provisioning: candidato a provisionar.
      units.push(finalizeUnit({
        state: "no_smtp",
        ...(domain ? { domain } : {}),
        serverSlug: slug,
        ...(server.ipv4 ? { serverIp: server.ipv4 } : {}),
        liveStatus: server.status ?? "unknown",
        credentialStatus: credential?.status ?? "none",
        evidence: [...evidence, { source: "domains", detail: "bound sin entry SMTP configured" }],
        issues,
        ...(domain && warmupByDomain[domain] ? { warmup: normalizeWarmup(warmupByDomain[domain]) } : {})
      }));
      continue;
    }

    evidence.push({ source: "provisioning", detail: `status=configured tls=${prov.tlsStatus ?? "unknown"}` });
    const failedRuns = domain ? failedRunsByDomain.get(domain) ?? [] : [];
    let state: SmtpUnitState;
    if (!running) {
      state = "down";
      issues.push(buildSmtpHealthIssue("smtp_server_down", { serverSlug: slug }));
    } else if (domain && ambiguous.has(domain)) {
      state = "error";
      issues.push(buildSmtpHealthIssue("ambiguous_domain_multi_server", { domain }));
    } else if (failedRuns.length > 0) {
      state = "error";
      const run = failedRuns[0]!;
      evidence.push(runEvidence(run));
      if (staleLocks.has(run.runId)) {
        issues.push(buildSmtpHealthIssue("stale_run_lock", { runId: run.runId }));
      } else {
        issues.push(buildSmtpHealthIssue("domain_purchased_without_smtp", {
          domain: domain ?? run.chosenDomain,
          runId: run.runId,
          lastCompletedStep: run.lastCompletedStep,
          costUsd: domainCost(domains, domain)
        }));
      }
    } else if (isTlsBad(prov.tlsStatus)) {
      state = "error";
      issues.push(buildSmtpHealthIssue("smtp_server_down", { serverSlug: slug }));
    } else {
      state = "active";
    }

    units.push(finalizeUnit({
      state,
      ...(domain ? { domain } : {}),
      serverSlug: slug,
      serverIp: server.ipv4 ?? prov.serverIp,
      ...(credential?.host || smtpHostForDomain(domain) ? { smtpHost: credential?.host ?? smtpHostForDomain(domain) } : {}),
      credentialStatus: credential?.status ?? "none",
      ...(prov.tlsStatus ? { tlsStatus: prov.tlsStatus } : {}),
      liveStatus: server.status ?? "unknown",
      evidence,
      issues,
      ...(domain && warmupByDomain[domain] ? { warmup: normalizeWarmup(warmupByDomain[domain]) } : {})
    }));
  }

  // 2) Huérfanos no adjuntos a un server vivo de la cuenta.
  const seenOrphanDomains = new Set<string>();
  for (const run of smtpRuns) {
    if (!runBelongsToAccount(run, input.providerId, input.accountId)) continue;
    const domain = run.chosenDomain ? normalizeDomain(run.chosenDomain) : undefined;
    if (!domain || seenOrphanDomains.has(domain)) continue;
    if (configuredDomains.has(domain)) continue;
    const domainRecord = domains.find((record) => normalizeDomain(record.domain) === domain);
    const owned = domainRecord?.status === "owned";
    const pending = domainRecord ? pendingDomainStatuses.has(String(domainRecord.status)) : false;
    const paidFailedRuns = (failedRunsByDomain.get(domain) ?? []).filter((candidate) => (candidate.budgetSpentUsd ?? 0) > 0);
    if (!owned && !pending) continue;
    if (paidFailedRuns.length === 0 && !pending) continue;
    seenOrphanDomains.add(domain);
    const evidence: SmtpHealthEvidence[] = [];
    const issues: SmtpHealthIssue[] = [];
    const referenceRun = paidFailedRuns[0] ?? run;
    evidence.push(runEvidence(referenceRun));
    if (pending) {
      evidence.push({ source: "route53", detail: "registration pending" });
      issues.push(buildSmtpHealthIssue("domain_registration_pending", { domain }));
      unattachedOrphans.push(finalizeUnit({
        state: "pending_registration",
        domain,
        ...(referenceRun.serverSlug ? { serverSlug: referenceRun.serverSlug } : {}),
        evidence,
        issues
      }));
      continue;
    }
    if (staleLocks.has(referenceRun.runId)) {
      issues.push(buildSmtpHealthIssue("stale_run_lock", { runId: referenceRun.runId }));
    }
    issues.push(buildSmtpHealthIssue("domain_purchased_without_smtp", {
      domain,
      runId: referenceRun.runId,
      lastCompletedStep: referenceRun.lastCompletedStep,
      costUsd: domainRecord?.costUsd ?? domainCost(domains, domain)
    }));
    unattachedOrphans.push(finalizeUnit({
      state: "orphan_domain_no_smtp",
      domain,
      ...(referenceRun.serverSlug ? { serverSlug: referenceRun.serverSlug } : {}),
      evidence,
      ...(warmupByDomain[domain] ? { warmup: normalizeWarmup(warmupByDomain[domain]) } : {}),
      issues
    }));
  }

  // 3) Credenciales que apuntan a un server inexistente (attribute a la cuenta por prefijo de provider).
  for (const credential of credentials) {
    const slug = credential.serverSlug;
    if (!slug || allLiveSlugs.has(slug) || webdockSlugs.has(slug)) continue;
    if (!slugBelongsToAccount(slug, input.providerId)) continue;
    const domain = normalizeDomain(credential.domain);
    unattachedOrphans.push(finalizeUnit({
      state: "credential_no_server",
      domain,
      serverSlug: slug,
      credentialStatus: credential.status ?? "unknown",
      ...(credential.host ? { smtpHost: credential.host } : {}),
      evidence: [{ source: "credential", detail: `serverSlug=${slug} ausente de la flota viva` }],
      issues: [buildSmtpHealthIssue("credential_without_server", { domain, serverSlug: slug })]
    }));
  }

  const summary = summarize(units, unattachedOrphans);
  return {
    providerId: input.providerId,
    accountId: input.accountId,
    ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
    generatedAt: now.toISOString(),
    dataSource: input.dataSource ?? "live",
    summary,
    units,
    unattachedOrphans
  };
}

function summarize(units: SmtpHealthUnit[], orphans: SmtpHealthUnit[]): AccountSmtpHealthSummary {
  const all = [...units, ...orphans];
  const count = (state: SmtpUnitState): number => all.filter((unit) => unit.state === state).length;
  const orphanStates: SmtpUnitState[] = ["orphan_domain_no_smtp", "server_no_domain", "credential_no_server"];
  return {
    active: count("active"),
    down: count("down"),
    error: count("error"),
    orphans: all.filter((unit) => orphanStates.includes(unit.state)).length,
    noSmtp: count("no_smtp"),
    pendingRegistration: count("pending_registration"),
    total: all.length
  };
}

function finalizeUnit(unit: SmtpHealthUnit): SmtpHealthUnit {
  return {
    ...unit,
    issues: [...unit.issues].sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
  };
}

function severityRank(severity: SmtpHealthIssueSeverity): number {
  switch (severity) {
    case "critical": return 3;
    case "error": return 2;
    case "warning": return 1;
    default: return 0;
  }
}

function runEvidence(run: SmtpRunRecord): SmtpHealthEvidence {
  return {
    source: "smtp-runs",
    runId: run.runId,
    ...(run.status ? { runStatus: run.status } : {}),
    ...(run.lastCompletedStep === undefined ? {} : { lastCompletedStep: run.lastCompletedStep }),
    ...(run.budgetSpentUsd === undefined ? {} : { budgetSpentUsd: run.budgetSpentUsd })
  };
}

function runBelongsToAccount(run: SmtpRunRecord, providerId: string, accountId: string): boolean {
  const runProvider = (run.providerId ?? "").toLowerCase();
  if (!runProvider) return false;
  return runProvider === accountId.toLowerCase() || runProvider === providerId.toLowerCase();
}

function slugBelongsToAccount(slug: string, providerId: string): boolean {
  return slug.toLowerCase().startsWith(`${providerId.toLowerCase()}-`);
}

function domainCost(domains: DomainsInventoryRecord[], domain?: string): number | undefined {
  if (!domain) return undefined;
  const record = domains.find((candidate) => normalizeDomain(candidate.domain) === domain);
  return record?.costUsd;
}

function smtpHostForDomain(domain?: string): string | undefined {
  return domain ? `smtp.${domain}` : undefined;
}

function normalizeWarmup(warmup: { status?: string; day?: number }): { status: string; day?: number } {
  return {
    status: warmup.status ?? "unknown",
    ...(warmup.day === undefined ? {} : { day: warmup.day })
  };
}

function isRunning(status?: string): boolean {
  return runningLiveStatuses.has(String(status ?? "").toLowerCase());
}

function isTlsBad(tlsStatus?: string): boolean {
  if (!tlsStatus) return false;
  const normalized = tlsStatus.toLowerCase();
  if (okTlsStatuses.has(normalized)) return false;
  if (normalized.includes("pending") || normalized.includes("attempted")) return false;
  return normalized.includes("fail") || normalized.includes("error") || normalized.includes("expired");
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// HTTP wiring (read-only). El endpoint GET /v1/infrastructure/accounts/:provider/:account/smtp-health
// reúne los snapshots (workspace + fetch live + warmup) y delega en el builder puro.
// ---------------------------------------------------------------------------

export interface AccountSmtpHealthRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  readBoundaryToken?: string;
  providerId: string;
  accountId: string;
  loadInput: () => Promise<Omit<BuildAccountSmtpHealthInput, "providerId" | "accountId">>;
  now?: () => Date;
}

export async function handleAccountSmtpHealthHttp(deps: AccountSmtpHealthRouteDependencies): Promise<void> {
  const auth = authorizeSensitiveRead(deps.request, { readBoundaryToken: deps.readBoundaryToken }, "infrastructure_smtp_health");
  if (!auth.ok) {
    return sendJson(deps.response, auth.statusCode, {
      error: auth.error,
      message: "Missing or invalid read-boundary token for infrastructure SMTP health read."
    });
  }
  try {
    const loaded = await deps.loadInput();
    const health = buildAccountSmtpHealth({
      providerId: deps.providerId,
      accountId: deps.accountId,
      ...loaded
    });
    return sendJson(deps.response, 200, health);
  } catch {
    return sendJson(deps.response, 503, {
      error: "infrastructure_smtp_health_unavailable",
      generatedAt: (deps.now?.() ?? new Date()).toISOString()
    });
  }
}

/**
 * Lector tolerante a JSON parcial de los inventarios del workspace (patrón `catch(() => null)` de
 * inspectSmtpInventory). Nunca lanza por un JSON a medio escribir por un run en vuelo.
 */
export async function readSmtpHealthWorkspaceInventories(workspace: OpenClawWorkspace): Promise<{
  domainsInventory: DomainsInventory | null;
  provisioningInventory: SmtpProvisioningInventory | null;
  credentialsInventory: SmtpCredentialsInventory | null;
  webdockServersInventory: WebdockServersInventory | null;
}> {
  const [domainsInventory, provisioningInventory, credentialsInventory, webdockServersInventory] = await Promise.all([
    workspace.readInventoryJsonOrNull<DomainsInventory>("domains.json"),
    workspace.readInventoryJsonOrNull<SmtpProvisioningInventory>("smtp-provisioning.json"),
    workspace.readInventoryJsonOrNull<SmtpCredentialsInventory>("smtp-credentials.json"),
    workspace.readInventoryJsonOrNull<WebdockServersInventory>("webdock-servers.json")
  ]);
  return { domainsInventory, provisioningInventory, credentialsInventory, webdockServersInventory };
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
