/**
 * Provider Resource Ledger — Provider Fabric fase C.
 *
 * Registro append-only de recursos reales creados/destruidos en proveedores
 * externos (VPS, dominios, zonas DNS). Es la contramedida a los recursos
 * huerfanos: si un flujo multi-paso muere a mitad (dominio registrado, VPS
 * fallo), el ledger sabe exactamente que quedo vivo y genera el plan de baja.
 *
 * Este modulo es PURO (sin I/O): tipos + derivaciones. La persistencia vive
 * en packages/local-store (LocalFileProviderResourceLedger) y la exposicion
 * en GET /v1/infrastructure/teardown-plan. La ejecucion del plan sigue
 * siendo humana via ApprovalGate — el ledger propone, no ejecuta.
 */

export type ProviderResourceAction = "created" | "deleted";

export type ProviderResourceType =
  | "vps_server"
  | "domain"
  | "dns_zone"
  | "dns_record"
  | string;

export interface ProviderResourceRecord {
  id: string;
  provider: string;
  accountId: string;
  resourceType: ProviderResourceType;
  externalId: string;
  action: ProviderResourceAction;
  occurredAt: string;
  displayName?: string;
  flowId?: string;
  auditId?: string;
  monthlyCostUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordProviderResourceInput {
  provider: string;
  accountId: string;
  resourceType: ProviderResourceType;
  externalId: string;
  action: ProviderResourceAction;
  displayName?: string;
  flowId?: string;
  auditId?: string;
  monthlyCostUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderTeardownScope {
  provider?: string;
  accountId?: string;
  flowId?: string;
}

export interface ProviderTeardownStep {
  order: number;
  provider: string;
  accountId: string;
  resourceType: ProviderResourceType;
  externalId: string;
  displayName?: string;
  createdAt: string;
  flowId?: string;
  monthlyCostUsd?: number;
  /** Accion sugerida; la ejecucion real exige aprobacion humana. */
  suggestedAction: string;
  /** false = no hay camino API (ej. liberar un dominio registrado). */
  executable: boolean;
  blockedReason?: string;
}

export interface ProviderTeardownPlan {
  scope: ProviderTeardownScope;
  liveResourceCount: number;
  estimatedMonthlyCostUsd: number;
  steps: ProviderTeardownStep[];
}

/** Orden de baja: primero lo que apunta (DNS), luego computo, al final dominios. */
const TEARDOWN_ORDER: Record<string, number> = {
  dns_record: 10,
  dns_zone: 20,
  vps_server: 30,
  domain: 40
};

const SUGGESTED_ACTIONS: Record<string, { action: string; executable: boolean; blockedReason?: string }> = {
  dns_record: { action: "delete_dns_record_requires_approval", executable: true },
  dns_zone: { action: "delete_dns_zone_requires_approval", executable: true },
  vps_server: { action: "delete_compute_server_requires_approval", executable: true },
  domain: {
    action: "release_domain_manual",
    executable: false,
    blockedReason: "registrar_release_has_no_api_path"
  }
};

function resourceKey(record: {
  provider: string;
  accountId: string;
  resourceType: string;
  externalId: string;
}): string {
  return [record.provider, record.accountId, record.resourceType, record.externalId].join("::");
}

/**
 * Recursos vivos segun el ledger: por cada clave (provider+cuenta+tipo+id)
 * gana el ultimo registro en orden de aparicion (el ledger es append-only,
 * el orden del array ES el orden temporal). Vivo = ultimo registro "created".
 */
export function liveResourcesFromLedger(records: ProviderResourceRecord[]): ProviderResourceRecord[] {
  const latest = new Map<string, ProviderResourceRecord>();
  for (const record of records) {
    latest.set(resourceKey(record), record);
  }
  return [...latest.values()].filter((record) => record.action === "created");
}

export function buildProviderTeardownPlan(
  records: ProviderResourceRecord[],
  scope: ProviderTeardownScope = {}
): ProviderTeardownPlan {
  const live = liveResourcesFromLedger(records).filter((record) => {
    if (scope.provider && record.provider !== scope.provider) return false;
    if (scope.accountId && record.accountId !== scope.accountId) return false;
    if (scope.flowId && record.flowId !== scope.flowId) return false;
    return true;
  });

  const sorted = [...live].sort((left, right) => {
    const orderDelta = teardownOrder(left.resourceType) - teardownOrder(right.resourceType);
    if (orderDelta !== 0) return orderDelta;
    return left.occurredAt.localeCompare(right.occurredAt);
  });

  const steps: ProviderTeardownStep[] = sorted.map((record, index) => {
    const suggestion = SUGGESTED_ACTIONS[record.resourceType] ?? {
      action: "review_manual",
      executable: false,
      blockedReason: "unknown_resource_type"
    };
    return {
      order: index + 1,
      provider: record.provider,
      accountId: record.accountId,
      resourceType: record.resourceType,
      externalId: record.externalId,
      ...(record.displayName ? { displayName: record.displayName } : {}),
      createdAt: record.occurredAt,
      ...(record.flowId ? { flowId: record.flowId } : {}),
      ...(record.monthlyCostUsd !== undefined ? { monthlyCostUsd: record.monthlyCostUsd } : {}),
      suggestedAction: suggestion.action,
      executable: suggestion.executable,
      ...(suggestion.blockedReason ? { blockedReason: suggestion.blockedReason } : {})
    };
  });

  return {
    scope,
    liveResourceCount: steps.length,
    estimatedMonthlyCostUsd: roundUsd(
      sorted.reduce((sum, record) => sum + (record.monthlyCostUsd ?? 0), 0)
    ),
    steps
  };
}

function teardownOrder(resourceType: string): number {
  return TEARDOWN_ORDER[resourceType] ?? 25;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
