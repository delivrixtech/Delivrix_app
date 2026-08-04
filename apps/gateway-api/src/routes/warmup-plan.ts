// Ruta read-only que expone EL PLAN DEL DÍA del warmup: qué va a hacer el agente con cada dominio
// y por qué.
//
// Por qué hacía falta: el panel mostraba actividad (qué pasó) pero nunca la DECISIÓN (qué va a
// pasar y con qué fundamento). El operador veía correos yendo y viniendo sin poder responder la
// única pregunta que importa cuando algo va mal: "¿por qué este dominio manda 2 y no 20?".
//
// No recalcula nada: llama a `planDelDia`, la MISMA función que el daemon consulta antes de actuar.
// Si la ruta tuviera su propia copia del criterio, el panel terminaría mostrando una decisión
// parecida pero distinta de la que se ejecuta — y eso es peor que no mostrar nada, porque parece
// verificado.
//
// Puramente observacional: nunca corre el motor, nunca manda correo, nunca escribe.
// Degradado-nunca-500: sin Postgres devuelve un plan vacío con nota, para que el panel muestre un
// "sin datos" honesto en vez de un error.

import type { IncomingMessage, ServerResponse } from "node:http";

import { planDelDia, type PlanDelDia } from "../../../warmup-engine/src/service/plan-diario.ts";
import type { PgClient } from "../../../warmup-engine/src/store/pg-stores.ts";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export interface WarmupPlanDeps {
  pgClient: PgClient | null;
  /** Dónde vive la medición del cupo físico (la persiste `limite-fisico --status`). */
  capFile: string;
  /** Pool configurado; solo se usa si no hay ninguna medición del cupo. */
  poolConfigurado: readonly string[];
  ventanaPlacement?: number;
  readBoundaryToken?: string;
  now?: () => Date;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
}

export interface WarmupPlanSnapshot extends Partial<PlanDelDia> {
  generadoEn: string;
  /** Por qué el plan viene vacío. Ausente cuando salió todo bien. */
  nota?: string;
}

export async function handleWarmupPlan(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupPlanDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, { readBoundaryToken: deps.readBoundaryToken }, "warmup_plan");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const ahora = (deps.now ?? (() => new Date()))();

  if (!deps.pgClient) {
    json(response, 200, {
      generadoEn: ahora.toISOString(),
      dominios: [],
      nota: "postgres_unavailable"
    } satisfies WarmupPlanSnapshot);
    return;
  }

  try {
    const plan = await planDelDia({
      pg: deps.pgClient,
      capFile: deps.capFile,
      poolConfigurado: deps.poolConfigurado,
      ventanaPlacement: deps.ventanaPlacement ?? 6,
      ahora
    });
    json(response, 200, plan satisfies WarmupPlanSnapshot);
  } catch (error) {
    // Tabla sin migrar / lectura rota: plan vacío con nota, no un 500 que tumba el panel entero.
    // Read-only: no hay nada que revertir.
    void deps.logger?.warn("warmup.plan_read_failed", "Warmup plan read failed; returning empty plan.", {
      message: error instanceof Error ? error.message : String(error)
    });
    json(response, 200, {
      generadoEn: ahora.toISOString(),
      dominios: [],
      nota: "plan_read_failed"
    } satisfies WarmupPlanSnapshot);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}
