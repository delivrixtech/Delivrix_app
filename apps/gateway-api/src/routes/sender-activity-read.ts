// GET /v1/sender-pool/activity?serverSlug=&serverIp=&limit= — el feed en vivo de un nodo.
//
// Lee las últimas N líneas de entrega del mail.log del nodo por SSH y las devuelve como eventos
// normalizados, en orden. A diferencia del inventario/cuota (JSON local que no se cae), esto es
// una lectura VIVA por diseño: es "lo que está pasando ahora". Si el SSH falla o el nodo no deja
// leer el log, se DECLARA (`unreadable` / `noAccess`), nunca se devuelve una lista vacía que se
// lea como "sin actividad".
//
// PASIVO: solo lee, no envía. Pull; el push por SSE es el slice siguiente.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  buildActivityCommand,
  parseSenderActivity,
  resolveActivityLimit
} from "../sender-activity.ts";
import type { DeliveryHealthSshRunner } from "../smtp-delivery-health.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

export interface SenderActivityRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  sshRunner: DeliveryHealthSshRunner;
  readBoundaryToken?: string;
  now?: () => Date;
}

export async function handleSenderActivityHttp(deps: SenderActivityRouteDeps): Promise<void> {
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
    "sender_activity"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = new URL(deps.request.url ?? "/", "http://localhost");
  const serverSlug = url.searchParams.get("serverSlug")?.trim() ?? "";
  const serverIp = url.searchParams.get("serverIp")?.trim() ?? "";
  if (!SLUG.test(serverSlug) || !IPV4.test(serverIp)) {
    json(deps.response, 400, { error: "server_slug_or_ip_invalid" });
    return;
  }
  const limit = resolveActivityLimit(url.searchParams.get("limit"));

  let stdout: string;
  try {
    const result = await deps.sshRunner.run({
      serverSlug,
      serverIp,
      command: buildActivityCommand(limit)
    });
    stdout = result.stdout;
  } catch (error) {
    // Un SSH caído se DECLARA; no es "sin actividad".
    json(deps.response, 200, {
      serverSlug,
      status: "unreadable",
      detail: error instanceof Error ? error.message : "no se pudo leer el nodo",
      events: []
    });
    return;
  }

  const { events, noAccess, truncated } = parseSenderActivity(stdout);
  if (truncated) {
    // La salida SSH se cortó antes de ## END: NO se sirve lo parcial como feed completo.
    json(deps.response, 200, {
      serverSlug,
      status: "unreadable",
      detail: "salida SSH incompleta (sin ## END): lectura truncada, no se sirve parcial",
      events: []
    });
    return;
  }
  json(deps.response, 200, {
    serverSlug,
    status: noAccess ? "no_access" : "ok",
    ...(noAccess ? { detail: "el nodo no deja leer /var/log/mail.log (falta sudo del usuario ops)" } : {}),
    limit,
    count: events.length,
    events
  });
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
