// GET /v1/sender-pool/inventory — el inventario de bandejas de la fabrica.
//
// Lectura barata: solo JSON local del workspace. Sin SSH, sin Postgres, sin modelo. Es a
// proposito el endpoint que NO se puede caer: la pantalla de warmup actual queda entera en cero
// cuando Postgres se cae, y encima el cartel que lo explica dice algo falso.

import type { IncomingMessage, ServerResponse } from "node:http";

import { leerInventarioFabrica } from "../sender-inventory.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export interface SenderInventoryRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  readBoundaryToken?: string;
  now?: () => Date;
}

export async function handleSenderInventoryHttp(deps: SenderInventoryRouteDeps): Promise<void> {
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
    "sender_inventory"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  const inventario = await leerInventarioFabrica({
    workspace: deps.workspace,
    ...(deps.now ? { now: deps.now } : {})
  });

  // Un fallo de lectura NO devuelve 500 con la pantalla vacia: devuelve 200 con `parcial: true`
  // y el motivo. La pantalla tiene que poder decir "no pude leer" en vez de mostrar ceros.
  json(deps.response, 200, inventario);
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
