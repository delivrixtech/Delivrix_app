import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildProviderTeardownPlan,
  type ProviderResourceRecord
} from "../../../../packages/domain/src/index.ts";

/**
 * GET /v1/infrastructure/teardown-plan?provider=&accountId=&flowId=
 *
 * Provider Fabric fase C: plan de baja derivado del ledger de recursos.
 * Solo lectura — la ejecucion de cada paso sigue exigiendo flag + kill
 * switch + aprobacion humana por las rutas de mutacion existentes.
 */
export interface TeardownPlanRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  ledgerList: () => Promise<ProviderResourceRecord[]>;
  now?: () => Date;
}

export async function handleTeardownPlanHttp(deps: TeardownPlanRouteDependencies): Promise<void> {
  const url = new URL(deps.request.url ?? "/", "http://localhost");
  const scope = {
    ...(queryValue(url, "provider") ? { provider: queryValue(url, "provider") } : {}),
    ...(queryValue(url, "accountId") ? { accountId: queryValue(url, "accountId") } : {}),
    ...(queryValue(url, "flowId") ? { flowId: queryValue(url, "flowId") } : {})
  };

  let records: ProviderResourceRecord[];
  try {
    records = await deps.ledgerList();
  } catch {
    json(deps.response, 503, {
      error: "provider_resource_ledger_unavailable",
      generatedAt: (deps.now?.() ?? new Date()).toISOString()
    });
    return;
  }

  const plan = buildProviderTeardownPlan(records, scope);
  json(deps.response, 200, {
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    ...plan
  });
}

function queryValue(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
