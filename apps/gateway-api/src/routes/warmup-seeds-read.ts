// GET /v1/warmup/seeds — el registro de semillas del warmup, para el panel.
//
// PROYECCIÓN, no volcado: la respuesta se arma campo por campo a propósito. El registro guarda el
// app password cifrado, y aunque esté cifrado no tiene por qué salir del gateway — servir el
// objeto crudo haría que cualquier campo nuevo que alguien agregue mañana se publique solo.
//
// Barato: JSON local, sin IMAP ni SSH. Detrás del mismo read-boundary que sus hermanos.

import type { IncomingMessage, ServerResponse } from "node:http";

import { coberturaPorProveedor, leerSemillas, semillasActivas, semillasMedibles } from "../warmup-seeds.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

/** Lo que ve el panel. Sin `secretEncrypted`, ni siquiera cifrado. */
export interface SemillaPublica {
  address: string;
  provider: string;
  enabled: boolean;
  /** none = solo destino · imap_password / gmail_oauth = además mide placement. */
  auth: string;
  mide: boolean;
  verifiedAt: string | null;
  notes: string | null;
}

export interface SemillasResponse {
  /** false = nunca se creó el registro; distinto de "existe y está vacío". */
  existeRegistro: boolean;
  seeds: SemillaPublica[];
  /** Cuántas sirven de destino y cuántas pueden medir: son cosas distintas. */
  destinos: number;
  midiendo: number;
  /** Cobertura de MEDICIÓN por proveedor (las solo-destino no cuentan). */
  cobertura: Record<string, number>;
  /** Proveedores clave sin semilla que mida: ahí no sabemos dónde cae el correo. */
  puntoCiego: string[];
}

const PROVEEDORES_CLAVE = ["gmail", "outlook", "yahoo"];

export async function handleWarmupSeedsHttp(deps: {
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
    "warmup_seeds"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  const { seeds, existeRegistro } = await leerSemillas(deps.workspace);
  const medibles = semillasMedibles(seeds);
  const cobertura = coberturaPorProveedor(seeds);

  const payload: SemillasResponse = {
    existeRegistro,
    seeds: seeds.map((s) => ({
      address: s.address,
      provider: s.provider,
      enabled: s.enabled,
      auth: s.auth,
      mide: s.enabled && s.auth !== "none",
      verifiedAt: s.verifiedAt ?? null,
      notes: s.notes ?? null
    })),
    destinos: semillasActivas(seeds).length,
    midiendo: medibles.length,
    cobertura,
    puntoCiego: PROVEEDORES_CLAVE.filter((p) => !cobertura[p])
  };
  json(deps.response, 200, payload);
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
