// GET /v1/sender-pool/measurement[?domain=x.com] — la ultima medicion de la flota.
//
// Es el sentido que alimenta a la tool read_sender_measurement de OpenClaw: el detalle por
// receptor (donde esta cerrada, cuantos diferidos, picos contra el umbral permanente) que la
// cuota resume en una palabra. Misma familia que el inventario: JSON local, sin SSH, sin
// Postgres — leer la medicion NO dispara una medicion.
//
// Nunca inventa: si la flota no se midio, la respuesta lo declara (`medidoEn: null`) en vez de
// devolver una lista vacia que se lea como "flota sin problemas".

import type { IncomingMessage, ServerResponse } from "node:http";

import { leerUltimaMedicion } from "../sender-measurement.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export interface SenderMeasurementRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  readBoundaryToken?: string;
  now?: () => Date;
}

export async function handleSenderMeasurementHttp(deps: SenderMeasurementRouteDeps): Promise<void> {
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
    "sender_measurement"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  const medicion = await leerUltimaMedicion(deps.workspace);
  if (!medicion) {
    json(deps.response, 200, {
      medidoEn: null,
      motivo: "la flota nunca se midió: correr scripts/ops/medir-flota.ts",
      bandejas: []
    });
    return;
  }

  const url = new URL(deps.request.url ?? "/", "http://localhost");
  const domain = url.searchParams.get("domain")?.trim().toLowerCase().replace(/\.$/, "") || null;

  if (domain) {
    const bandeja = medicion.bandejas.find((b) => b.domain === domain) ?? null;
    json(deps.response, 200, {
      medidoEn: medicion.medidoEn,
      domain,
      // null explicito con motivo, no una lista vacia: "no se midio" != "sin problemas".
      bandeja,
      ...(bandeja ? {} : { motivo: "este dominio no estuvo en la última corrida" })
    });
    return;
  }

  json(deps.response, 200, medicion);
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
