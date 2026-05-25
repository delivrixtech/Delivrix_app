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
  itemCount: number;
  lastFetched: string | null;
  fetchSourceKind: ProviderFetchSourceKind | null;
  errorReason?: string;
  capabilities: string[];
  items?: InventoryItem[];
}

export type InfrastructureInventoryProvider = Provider;

export interface InfrastructureInventoryResponse {
  generatedAt: string;
  providers: Provider[];
}

export interface BuildInfrastructureInventoryInput {
  providers?: Provider[];
  now?: Date;
}

export function buildInfrastructureInventoryResponse(
  input: BuildInfrastructureInventoryInput = {}
): InfrastructureInventoryResponse {
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    providers: (input.providers ?? []).map(normalizeProvider)
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
