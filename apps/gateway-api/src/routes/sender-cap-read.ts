// GET /v1/sender-pool/cap — el consumo del límite físico de la flota.
//
// Barato: lee el JSON que persiste la corrida de `scripts/ops/limite-fisico.ts --status`, sin
// tocar SSH. El SSH se paga una vez en la corrida, igual que la medición. Si nunca se corrió,
// devuelve 200 con `medidoEn: null` y la lista vacía — la pantalla lo DECLARA en vez de mostrar
// una flota sin límites que parezca sana.

import type { IncomingMessage, ServerResponse } from "node:http";

import { CAP_MEASUREMENT_FILE, type CapFlota } from "../node-daily-cap.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export interface SenderCapRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  readBoundaryToken?: string;
  now?: () => Date;
}

export async function handleSenderCapHttp(deps: SenderCapRouteDeps): Promise<void> {
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
    "sender_cap"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  // Un JSON ilegible NO es lo mismo que "nunca se corrió": se declara, para que la pantalla no
  // diga "nunca se leyó la flota" sobre un archivo que existe pero está roto.
  let cap: CapFlota | null = null;
  let ilegible: string | null = null;
  try {
    cap = await deps.workspace.readInventoryJson<CapFlota>(CAP_MEASUREMENT_FILE);
  } catch (error) {
    ilegible = error instanceof Error ? error.message : String(error);
  }
  if (cap && !Array.isArray(cap.nodos)) {
    ilegible = "sender-cap.json no tiene la forma esperada (falta `nodos`)";
    cap = null;
  }

  json(deps.response, 200, cap ?? { medidoEn: null, nodos: [], ilegibles: 0, omitidos: 0, ilegible });
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
