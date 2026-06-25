export type ProviderKind = "compute" | "dns" | "domain-registrar" | "physical";
export type ProviderStatus = "active" | "paused" | "error" | "planned";
export type ProviderFetchSourceKind = "live" | "mock";

export interface InventoryItem {
  id: string;
  kind: string;
  displayName: string;
  status: string;
  detail?: Record<string, unknown>;
}

export interface Provider {
  id: string;
  displayName: string;
  kind: ProviderKind;
  status: ProviderStatus;
  statusLabel?: string;
  itemCount: number;
  lastFetched: string | null;
  fetchSourceKind: ProviderFetchSourceKind | null;
  errorReason?: string;
  capabilities: string[];
  items?: InventoryItem[];
}

export type InfrastructureInventoryProvider = Provider;

export type InfrastructureAccountLifecycleStatus =
  | "active"
  | "paused"
  | "unauthorized"
  | "suspended"
  | "disabled"
  | "retired";

export type InfrastructureAccountHealth =
  | "healthy"
  | "unauthorized"
  | "suspended_candidate"
  | "degraded"
  | "retired";

export interface InfrastructureAccountHealthItem {
  providerId: string;
  providerKind: string;
  accountId: string;
  accountLabel: string;
  health: InfrastructureAccountHealth;
  lifecycleStatus: InfrastructureAccountLifecycleStatus;
  responseOk: boolean;
  httpStatus?: number;
  errorCode?: string;
  errorReason?: string;
  liveItemCount: number;
  lastKnownItemCount?: number;
  lastFetched: string | null;
  retiredAt?: string;
  retiredReason?: string;
}

export interface InfrastructureAccountHealthReport {
  accounts: InfrastructureAccountHealthItem[];
  unhealthyCount: number;
  retiredCount: number;
}

export interface InfrastructureOrphanReport {
  confirmedSenderNodeOrphans: InventoryItem[];
  uncertainBecauseAccountDown: InfrastructureAccountHealthItem[];
  providerServersWithoutSenderNode: InventoryItem[];
}

export interface InfrastructureInventoryResponse {
  generatedAt: string;
  itemTotal: number;
  providers: Provider[];
  accountHealth?: InfrastructureAccountHealthReport;
  orphanReport?: InfrastructureOrphanReport;
}

export interface BuildInfrastructureInventoryInput {
  providers?: Provider[];
  accountHealth?: InfrastructureAccountHealthReport;
  orphanReport?: InfrastructureOrphanReport;
  now?: Date;
}

export function buildInfrastructureInventoryResponse(
  input: BuildInfrastructureInventoryInput = {}
): InfrastructureInventoryResponse {
  const providers = (input.providers ?? []).map(normalizeProvider);
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    itemTotal: providers.reduce((sum, provider) => sum + provider.itemCount, 0),
    providers,
    ...(input.accountHealth ? { accountHealth: normalizeAccountHealthReport(input.accountHealth) } : {}),
    ...(input.orphanReport ? { orphanReport: normalizeOrphanReport(input.orphanReport) } : {})
  };
}

function normalizeProvider(provider: Provider): Provider {
  const itemCount = Number.isFinite(provider.itemCount)
    ? Math.max(0, Math.trunc(provider.itemCount))
    : provider.items?.length ?? 0;

  return {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    status: provider.status,
    statusLabel: provider.statusLabel ?? providerStatusLabel(provider),
    itemCount,
    lastFetched: provider.lastFetched,
    fetchSourceKind: provider.fetchSourceKind,
    ...(provider.errorReason ? { errorReason: provider.errorReason } : {}),
    capabilities: [...provider.capabilities],
    ...(provider.items ? { items: provider.items.map(normalizeItem) } : {})
  };
}

function normalizeItem(item: InventoryItem): InventoryItem {
  return {
    id: item.id,
    kind: item.kind,
    displayName: item.displayName,
    status: item.status,
    ...(item.detail ? { detail: { ...item.detail } } : {})
  };
}

function normalizeAccountHealthReport(report: InfrastructureAccountHealthReport): InfrastructureAccountHealthReport {
  const accounts = report.accounts.map((account) => ({
    providerId: account.providerId,
    providerKind: account.providerKind,
    accountId: account.accountId,
    accountLabel: account.accountLabel,
    health: account.health,
    lifecycleStatus: account.lifecycleStatus,
    responseOk: account.responseOk,
    ...(account.httpStatus ? { httpStatus: account.httpStatus } : {}),
    ...(account.errorCode ? { errorCode: account.errorCode } : {}),
    ...(account.errorReason ? { errorReason: account.errorReason } : {}),
    liveItemCount: Math.max(0, Math.trunc(account.liveItemCount)),
    ...(account.lastKnownItemCount === undefined ? {} : { lastKnownItemCount: Math.max(0, Math.trunc(account.lastKnownItemCount)) }),
    lastFetched: account.lastFetched,
    ...(account.retiredAt ? { retiredAt: account.retiredAt } : {}),
    ...(account.retiredReason ? { retiredReason: account.retiredReason } : {})
  }));
  return {
    accounts,
    unhealthyCount: Math.max(0, Math.trunc(report.unhealthyCount)),
    retiredCount: Math.max(0, Math.trunc(report.retiredCount))
  };
}

function normalizeOrphanReport(report: InfrastructureOrphanReport): InfrastructureOrphanReport {
  return {
    confirmedSenderNodeOrphans: report.confirmedSenderNodeOrphans.map(normalizeItem),
    uncertainBecauseAccountDown: normalizeAccountHealthReport({
      accounts: report.uncertainBecauseAccountDown,
      unhealthyCount: 0,
      retiredCount: 0
    }).accounts,
    providerServersWithoutSenderNode: report.providerServersWithoutSenderNode.map(normalizeItem)
  };
}

function providerStatusLabel(provider: Provider): string {
  if (provider.errorReason === "not_online_yet") {
    return "Aún offline";
  }
  switch (provider.status) {
    case "active":
      return "Activo";
    case "paused":
      return "Pausado";
    case "error":
      return "Con error";
    case "planned":
      return "Planeado";
  }
}
