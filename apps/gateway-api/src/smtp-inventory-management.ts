import type { OpenClawWorkspace } from "./openclaw-workspace.ts";
import type { SmtpCredentialPublicMetadata } from "./smtp-credentials.ts";

export type SmtpInventoryEntryStatus = "configured" | "superseded" | "retired" | "archived";

export interface SmtpProvisioningServer {
  serverSlug: string;
  domain: string;
  serverIp: string;
  selector: string;
  status: SmtpInventoryEntryStatus;
  tlsStatus?: string;
  smtpAuthStatus?: string;
  smtpCredential?: SmtpCredentialPublicMetadata;
  configuredAt?: string;
  updatedAt?: string;
  supersededAt?: string;
  supersededBy?: string;
  retiredAt?: string;
  retiredBy?: string;
  retiredReason?: string;
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
}

export interface SmtpProvisioningInventory {
  servers?: SmtpProvisioningServer[];
}

export interface SmtpInventoryLiveServer {
  serverSlug: string;
  ipv4?: string;
  status?: string;
  providerId?: string;
  accountId?: string;
  accountLabel?: string;
  accountHealthStatus?: string;
  lifecycleStatus?: string;
}

export interface SmtpInventoryMutationResult {
  ok: boolean;
  status: string;
  dryRun: boolean;
  changed: boolean;
  domain?: string;
  serverSlug?: string;
  canonicalServerSlug?: string;
  retiredServerSlugs?: string[];
  supersededServerSlugs?: string[];
  reason?: string;
  plan?: Record<string, unknown>;
  error?: string;
}

interface CompletedSmtpRunSignal {
  runId: string;
  domain: string;
  serverSlug: string;
  completedAt?: string;
  updatedAt?: string;
}

export async function upsertConfiguredSmtpInventoryEntry(
  workspace: OpenClawWorkspace,
  input: SmtpProvisioningServer,
  now: () => Date = () => new Date()
): Promise<void> {
  const updatedAt = now().toISOString();
  const domain = normalizeDomain(input.domain);
  await workspace.updateInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json", (current) => {
    const servers = (current?.servers ?? [])
      .filter((server) => !sameEntry(server, input))
      .map((server) => {
        if (normalizeDomain(server.domain) !== domain || server.serverSlug === input.serverSlug || server.status !== "configured") {
          return server;
        }
        return {
          ...server,
          status: "superseded" as const,
          supersededAt: updatedAt,
          supersededBy: input.serverSlug,
          updatedAt
        };
      });
    servers.push({
      ...input,
      domain,
      status: "configured",
      updatedAt: input.updatedAt ?? updatedAt
    });
    return { ...(current ?? {}), servers };
  });
}

export async function inspectSmtpInventory(input: {
  workspace: OpenClawWorkspace;
  domain?: string;
  serverSlug?: string;
  status?: SmtpInventoryEntryStatus;
  liveServers?: SmtpInventoryLiveServer[];
}): Promise<Record<string, unknown>> {
  const inventory = await input.workspace.readInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json").catch(() => null);
  const liveBySlug = liveServerMap(input.liveServers ?? []);
  const domainFilter = input.domain ? normalizeDomain(input.domain) : undefined;
  const servers = (inventory?.servers ?? [])
    .filter((entry) => domainFilter ? normalizeDomain(entry.domain) === domainFilter : true)
    .filter((entry) => input.serverSlug ? entry.serverSlug === input.serverSlug : true)
    .filter((entry) => input.status ? entry.status === input.status : true)
    .map((entry) => inventoryEntryView(entry, liveBySlug))
    .sort((left, right) =>
      String(left.domain).localeCompare(String(right.domain)) ||
      String(left.serverSlug).localeCompare(String(right.serverSlug))
    );
  const domains = domainGroups(inventory?.servers ?? [], liveBySlug, domainFilter);
  const ambiguousDomains = domains
    .filter((group) => group.configuredCount > 1)
    .map((group) => ({
      domain: group.domain,
      configuredCount: group.configuredCount,
      configuredServerSlugs: group.configuredServerSlugs,
      liveConfiguredServerSlugs: group.liveConfiguredServerSlugs
    }));

  return {
    ok: ambiguousDomains.length === 0,
    totals: {
      entries: servers.length,
      configured: servers.filter((entry) => entry.status === "configured").length,
      superseded: servers.filter((entry) => entry.status === "superseded").length,
      retired: servers.filter((entry) => entry.status === "retired").length,
      archived: servers.filter((entry) => entry.status === "archived").length,
      ambiguousDomains: ambiguousDomains.length,
      liveServers: liveBySlug.size
    },
    ambiguousDomains,
    domains,
    servers
  };
}

export async function resolveAmbiguousSmtpDomain(input: {
  workspace: OpenClawWorkspace;
  domain: string;
  keepServerSlug?: string;
  liveServers: SmtpInventoryLiveServer[];
  actorId: string;
  reason?: string;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<SmtpInventoryMutationResult> {
  const domain = normalizeDomain(input.domain);
  const inventory = await readSmtpInventory(input.workspace);
  const configured = inventory.servers.filter((server) => normalizeDomain(server.domain) === domain && server.status === "configured");
  if (configured.length <= 1) {
    return {
      ok: true,
      status: "not_ambiguous",
      dryRun: input.dryRun === true,
      changed: false,
      domain,
      canonicalServerSlug: configured[0]?.serverSlug,
      retiredServerSlugs: []
    };
  }

  const liveBySlug = liveServerMap(input.liveServers);
  const completedRunSignals = input.keepServerSlug
    ? []
    : await readCompletedSmtpRunSignals(input.workspace, domain);
  const canonical = chooseCanonicalServer(configured, liveBySlug, input.keepServerSlug, completedRunSignals);
  if (!canonical.ok) {
    return {
      ok: false,
      status: canonical.error,
      dryRun: input.dryRun === true,
      changed: false,
      domain,
      error: canonical.error
    };
  }

  const superseded = configured
    .filter((server) => server.serverSlug !== canonical.server.serverSlug)
    .map((server) => server.serverSlug);
  const plan = {
    action: "resolve_ambiguous_domain",
    domain,
    canonicalServerSlug: canonical.server.serverSlug,
    canonicalEvidence: canonical.evidence,
    supersededServerSlugs: superseded,
    previousStatuses: configured.map((server) => ({ serverSlug: server.serverSlug, status: server.status })),
    sideEffects: "local-state-only"
  };
  if (input.dryRun === true) {
    return {
      ok: true,
      status: "dry_run",
      dryRun: true,
      changed: false,
      domain,
      canonicalServerSlug: canonical.server.serverSlug,
      supersededServerSlugs: superseded,
      plan
    };
  }

  const updatedAt = (input.now?.() ?? new Date()).toISOString();
  await input.workspace.updateInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json", (current) => {
    const servers = (current?.servers ?? []).map((server) => {
      if (normalizeDomain(server.domain) !== domain || server.status !== "configured" || server.serverSlug === canonical.server.serverSlug) {
        return server;
      }
      return {
        ...server,
        status: "superseded" as const,
        supersededAt: updatedAt,
        supersededBy: canonical.server.serverSlug,
        updatedAt
      };
    });
    return { ...(current ?? {}), servers };
  });

  return {
    ok: true,
    status: "resolved",
    dryRun: false,
    changed: superseded.length > 0,
    domain,
    canonicalServerSlug: canonical.server.serverSlug,
    supersededServerSlugs: superseded,
    reason: input.reason,
    plan
  };
}

export async function retireSmtpInventoryEntry(input: {
  workspace: OpenClawWorkspace;
  domain: string;
  serverSlug: string;
  liveServers: SmtpInventoryLiveServer[];
  actorId: string;
  reason: string;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<SmtpInventoryMutationResult> {
  const domain = normalizeDomain(input.domain);
  const inventory = await readSmtpInventory(input.workspace);
  const entry = inventory.servers.find((server) => sameDomainServer(server, domain, input.serverSlug));
  if (!entry) {
    return { ok: false, status: "entry_not_found", dryRun: input.dryRun === true, changed: false, domain, serverSlug: input.serverSlug, error: "entry_not_found" };
  }
  const plan = {
    action: "retire_smtp_entry",
    domain,
    serverSlug: input.serverSlug,
    previousStatus: entry.status,
    liveServerExists: liveServerMap(input.liveServers).has(input.serverSlug),
    sideEffects: "local-state-only"
  };
  if (input.dryRun === true) {
    return { ok: true, status: "dry_run", dryRun: true, changed: false, domain, serverSlug: input.serverSlug, plan };
  }
  const retiredAt = (input.now?.() ?? new Date()).toISOString();
  await input.workspace.updateInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json", (current) => ({
    ...(current ?? {}),
    servers: (current?.servers ?? []).map((server) => {
      if (!sameDomainServer(server, domain, input.serverSlug)) return server;
      return {
        ...server,
        status: "retired" as const,
        retiredAt,
        retiredBy: input.actorId,
        retiredReason: input.reason,
        updatedAt: retiredAt
      };
    })
  }));
  return { ok: true, status: "retired", dryRun: false, changed: true, domain, serverSlug: input.serverSlug, reason: input.reason, plan };
}

export async function reassignSmtpDomainServer(input: {
  workspace: OpenClawWorkspace;
  domain: string;
  fromServerSlug: string;
  toServerSlug: string;
  liveServers: SmtpInventoryLiveServer[];
  actorId: string;
  reason: string;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<SmtpInventoryMutationResult> {
  const domain = normalizeDomain(input.domain);
  const inventory = await readSmtpInventory(input.workspace);
  const source = inventory.servers.find((server) => sameDomainServer(server, domain, input.fromServerSlug) && server.status === "configured");
  if (!source) {
    return { ok: false, status: "source_entry_not_found", dryRun: input.dryRun === true, changed: false, domain, serverSlug: input.fromServerSlug, error: "source_entry_not_found" };
  }
  const liveTarget = liveServerMap(input.liveServers).get(input.toServerSlug);
  if (!liveTarget) {
    return { ok: false, status: "target_server_not_live", dryRun: input.dryRun === true, changed: false, domain, serverSlug: input.toServerSlug, error: "target_server_not_live" };
  }
  const targetEntry = inventory.servers.find((server) => sameDomainServer(server, domain, input.toServerSlug));
  const target = {
    ...(targetEntry ?? source),
    serverSlug: input.toServerSlug,
    serverIp: liveTarget.ipv4 ?? targetEntry?.serverIp ?? source.serverIp,
    domain,
    status: "configured" as const,
    updatedAt: (input.now?.() ?? new Date()).toISOString()
  };
  const plan = {
    action: "reassign_domain_server",
    domain,
    fromServerSlug: input.fromServerSlug,
    toServerSlug: input.toServerSlug,
    previousStatuses: inventory.servers
      .filter((server) => normalizeDomain(server.domain) === domain)
      .map((server) => ({ serverSlug: server.serverSlug, status: server.status })),
    targetServerIp: target.serverIp,
    sideEffects: "local-state-only"
  };
  const superseded = inventory.servers
    .filter((server) => normalizeDomain(server.domain) === domain && server.status === "configured" && server.serverSlug !== input.toServerSlug)
    .map((server) => server.serverSlug);
  if (input.fromServerSlug === input.toServerSlug) {
    return {
      ok: true,
      status: "not_changed",
      dryRun: input.dryRun === true,
      changed: false,
      domain,
      canonicalServerSlug: input.toServerSlug,
      supersededServerSlugs: [],
      reason: input.reason,
      plan
    };
  }
  if (input.dryRun === true) {
    return { ok: true, status: "dry_run", dryRun: true, changed: false, domain, canonicalServerSlug: input.toServerSlug, supersededServerSlugs: superseded, plan };
  }
  await upsertConfiguredSmtpInventoryEntry(input.workspace, target, input.now);
  return {
    ok: true,
    status: "reassigned",
    dryRun: false,
    changed: true,
    domain,
    canonicalServerSlug: input.toServerSlug,
    supersededServerSlugs: superseded,
    reason: input.reason,
    plan
  };
}

export async function updateSmtpInventoryEntry(input: {
  workspace: OpenClawWorkspace;
  domain: string;
  serverSlug: string;
  patch: Partial<Pick<SmtpProvisioningServer, "selector" | "status" | "tlsStatus" | "smtpAuthStatus">>;
  liveServers: SmtpInventoryLiveServer[];
  actorId: string;
  reason?: string;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<SmtpInventoryMutationResult> {
  const domain = normalizeDomain(input.domain);
  const inventory = await readSmtpInventory(input.workspace);
  const entry = inventory.servers.find((server) => sameDomainServer(server, domain, input.serverSlug));
  if (!entry) {
    return { ok: false, status: "entry_not_found", dryRun: input.dryRun === true, changed: false, domain, serverSlug: input.serverSlug, error: "entry_not_found" };
  }
  if (input.patch.status === "configured" && !liveServerMap(input.liveServers).has(input.serverSlug)) {
    return { ok: false, status: "server_not_live", dryRun: input.dryRun === true, changed: false, domain, serverSlug: input.serverSlug, error: "server_not_live" };
  }
  const updatedEntry = {
    ...entry,
    ...input.patch,
    domain,
    updatedAt: (input.now?.() ?? new Date()).toISOString()
  };
  const plan = {
    action: "update_smtp_entry",
    domain,
    serverSlug: input.serverSlug,
    patch: input.patch,
    previousStatus: entry.status,
    previousValues: {
      selector: entry.selector,
      status: entry.status,
      tlsStatus: entry.tlsStatus,
      smtpAuthStatus: entry.smtpAuthStatus
    },
    sideEffects: "local-state-only"
  };
  if (input.dryRun === true) {
    return { ok: true, status: "dry_run", dryRun: true, changed: false, domain, serverSlug: input.serverSlug, plan };
  }
  if (updatedEntry.status === "configured") {
    await upsertConfiguredSmtpInventoryEntry(input.workspace, updatedEntry, input.now);
  } else {
    await input.workspace.updateInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json", (current) => ({
      ...(current ?? {}),
      servers: (current?.servers ?? []).map((server) => sameDomainServer(server, domain, input.serverSlug) ? updatedEntry : server)
    }));
  }
  return { ok: true, status: "updated", dryRun: false, changed: true, domain, serverSlug: input.serverSlug, reason: input.reason, plan };
}

async function readSmtpInventory(workspace: OpenClawWorkspace): Promise<SmtpProvisioningInventory & { servers: SmtpProvisioningServer[] }> {
  const inventory = await workspace.readInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json").catch(() => null);
  return { ...(inventory ?? {}), servers: inventory?.servers ?? [] };
}

function chooseCanonicalServer(
  configured: SmtpProvisioningServer[],
  liveBySlug: Map<string, SmtpInventoryLiveServer>,
  keepServerSlug?: string,
  completedRunSignals: CompletedSmtpRunSignal[] = []
): { ok: true; server: SmtpProvisioningServer; evidence: Record<string, unknown> } | { ok: false; error: string } {
  if (keepServerSlug) {
    const explicit = configured.find((server) => server.serverSlug === keepServerSlug);
    if (!explicit) return { ok: false, error: "requested_server_not_configured_for_domain" };
    if (!liveBySlug.has(keepServerSlug)) return { ok: false, error: "requested_server_not_live" };
    return { ok: true, server: explicit, evidence: { source: "explicit_keep_server_slug" } };
  }
  const liveConfigured = configured.filter((server) => liveBySlug.has(server.serverSlug));
  if (liveConfigured.length === 1) {
    return { ok: true, server: liveConfigured[0], evidence: { source: "single_live_configured_server" } };
  }
  if (liveConfigured.length > 1) {
    const completedBySlug = new Map(completedRunSignals.map((signal) => [signal.serverSlug, signal]));
    const completedLive = liveConfigured.filter((server) => completedBySlug.has(server.serverSlug));
    if (completedLive.length === 1) {
      const signal = completedBySlug.get(completedLive[0].serverSlug);
      return {
        ok: true,
        server: completedLive[0],
        evidence: {
          source: "completed_smtp_run",
          runId: signal?.runId,
          completedAt: signal?.completedAt,
          updatedAt: signal?.updatedAt
        }
      };
    }
    const tieBreakCandidates = completedLive.length > 1 ? completedLive : liveConfigured;
    const byTimestamp = chooseMostRecentInventoryEntry(tieBreakCandidates);
    if (byTimestamp) {
      return {
        ok: true,
        server: byTimestamp,
        evidence: {
          source: completedLive.length > 1 ? "completed_smtp_run_timestamp_tiebreak" : "inventory_timestamp_tiebreak"
        }
      };
    }
  }
  return { ok: false, error: "canonical_server_required" };
}

async function readCompletedSmtpRunSignals(
  workspace: OpenClawWorkspace,
  domain: string
): Promise<CompletedSmtpRunSignal[]> {
  const snapshot = await workspace.snapshot().catch(() => ({ files: [] as string[] }));
  const signals: CompletedSmtpRunSignal[] = [];
  for (const path of snapshot.files) {
    if (!path.startsWith("inventory/smtp-runs/") || !path.endsWith(".json")) continue;
    const raw = await workspace.readWorkspaceFile(path).catch(() => "");
    const parsed = safeJsonRecord(raw);
    if (!parsed || parsed.status !== "completed") continue;
    const chosenDomain = stringValue(parsed.chosenDomain);
    const serverSlug = stringValue(parsed.serverSlug);
    const runId = stringValue(parsed.runId);
    if (!chosenDomain || !serverSlug || !runId) continue;
    if (normalizeDomain(chosenDomain) !== domain) continue;
    signals.push({
      runId,
      domain,
      serverSlug,
      ...optionalStringField("completedAt", completedAtFromRunState(parsed)),
      ...optionalStringField("updatedAt", stringValue(parsed.updatedAt))
    });
  }
  return signals;
}

function completedAtFromRunState(state: Record<string, unknown>): string | undefined {
  const direct = stringValue(state.completedAt);
  if (direct) return direct;
  const steps = isRecord(state.steps) ? state.steps : {};
  const completed = Object.values(steps)
    .filter(isRecord)
    .map((step) => stringValue(step.completedAt))
    .filter((value): value is string => value !== undefined)
    .sort();
  return completed.at(-1) ?? stringValue(state.updatedAt);
}

function chooseMostRecentInventoryEntry(entries: SmtpProvisioningServer[]): SmtpProvisioningServer | null {
  const scored = entries
    .map((entry) => ({
      entry,
      timestamp: Math.max(timestampMs(entry.configuredAt) ?? Number.NEGATIVE_INFINITY, timestampMs(entry.updatedAt) ?? Number.NEGATIVE_INFINITY)
    }))
    .filter((item): item is { entry: SmtpProvisioningServer; timestamp: number } => item.timestamp !== Number.NEGATIVE_INFINITY)
    .sort((left, right) => right.timestamp - left.timestamp);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].timestamp === scored[1].timestamp) return null;
  return scored[0].entry;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function safeJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function optionalStringField(key: string, value: string | undefined): Record<string, string> {
  return value ? { [key]: value } : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function domainGroups(
  entries: SmtpProvisioningServer[],
  liveBySlug: Map<string, SmtpInventoryLiveServer>,
  domainFilter?: string
): Array<Record<string, unknown> & {
  domain: string;
  configuredCount: number;
  configuredServerSlugs: string[];
  liveConfiguredServerSlugs: string[];
}> {
  const grouped = new Map<string, SmtpProvisioningServer[]>();
  for (const entry of entries) {
    const domain = normalizeDomain(entry.domain);
    if (domainFilter && domain !== domainFilter) continue;
    grouped.set(domain, [...(grouped.get(domain) ?? []), entry]);
  }
  return [...grouped.entries()]
    .map(([domain, domainEntries]) => {
      const configured = domainEntries.filter((entry) => entry.status === "configured");
      return {
        domain,
        total: domainEntries.length,
        configuredCount: configured.length,
        configuredServerSlugs: configured.map((entry) => entry.serverSlug),
        liveConfiguredServerSlugs: configured.filter((entry) => liveBySlug.has(entry.serverSlug)).map((entry) => entry.serverSlug),
        statuses: statusCounts(domainEntries)
      };
    })
    .sort((left, right) => left.domain.localeCompare(right.domain));
}

function inventoryEntryView(entry: SmtpProvisioningServer, liveBySlug: Map<string, SmtpInventoryLiveServer>): Record<string, unknown> {
  const live = liveBySlug.get(entry.serverSlug);
  return {
    serverSlug: entry.serverSlug,
    domain: normalizeDomain(entry.domain),
    serverIp: entry.serverIp,
    selector: entry.selector,
    status: entry.status,
    tlsStatus: entry.tlsStatus,
    smtpAuthStatus: entry.smtpAuthStatus,
    hasCredential: entry.smtpCredential?.hasCredential === true,
    configuredAt: entry.configuredAt,
    updatedAt: entry.updatedAt,
    supersededAt: entry.supersededAt,
    supersededBy: entry.supersededBy,
    retiredAt: entry.retiredAt,
    retiredBy: entry.retiredBy,
    retiredReason: entry.retiredReason,
    existsInLiveInventory: live !== undefined,
    liveStatus: live?.status,
    liveIpv4: live?.ipv4,
    providerId: live?.providerId,
    accountId: live?.accountId,
    accountLabel: live?.accountLabel,
    accountHealthStatus: live?.accountHealthStatus,
    lifecycleStatus: live?.lifecycleStatus
  };
}

function statusCounts(entries: SmtpProvisioningServer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}

function liveServerMap(liveServers: SmtpInventoryLiveServer[]): Map<string, SmtpInventoryLiveServer> {
  return new Map(liveServers.map((server) => [server.serverSlug, server]));
}

function sameEntry(left: SmtpProvisioningServer, right: SmtpProvisioningServer): boolean {
  return sameDomainServer(left, normalizeDomain(right.domain), right.serverSlug);
}

function sameDomainServer(entry: SmtpProvisioningServer, domain: string, serverSlug: string): boolean {
  return normalizeDomain(entry.domain) === domain && entry.serverSlug === serverSlug;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}
