// GET /v1/warmup/monitor — la lectura del agente que mira el warmup.
//
// Barato: sirve el JSON que dejó la corrida del monitor. NUNCA llama al modelo en el camino
// caliente — el análisis se paga una vez cada N minutos, no en cada request del panel.
//
// Fail-honest: si nunca corrió, se declara. Y la respuesta lleva SIEMPRE la fecha y el modelo: una
// opinión sin fecha ni autor no es evidencia, y una lectura vieja no puede parecer de ahora.

import type { IncomingMessage, ServerResponse } from "node:http";

import { MONITOR_FILE, type LecturaAgente } from "../agents/warmup-monitor.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export async function handleWarmupMonitorHttp(deps: {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  readBoundaryToken?: string;
  now?: () => Date;
}): Promise<void> {
  if (deps.request.method !== "GET") {
    json(deps.response, 405, { error: "method_not_allowed" });
    return;
  }
  const auth = authorizeSensitiveRead(
    deps.request,
    {
      ...(deps.readBoundaryToken === undefined ? {} : { readBoundaryToken: deps.readBoundaryToken }),
      ...(deps.now ? { now: deps.now } : {})
    },
    "warmup_monitor"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  const lectura = await deps.workspace.readInventoryJson<LecturaAgente>(MONITOR_FILE).catch(() => null);
  if (!lectura) {
    json(deps.response, 200, {
      generadoEn: null,
      modelo: null,
      lectura: null,
      motivo: "el agente todavía no miró: corré scripts/ops/warmup-monitor.ts --loop",
      tokens: null,
      hechos: null
    });
    return;
  }
  json(deps.response, 200, lectura);
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store"
  });
  response.end(body);
}
