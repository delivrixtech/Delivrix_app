// GET /v1/sender-pool/alerts — las alertas de la flota, destiladas de la última medición.
//
// Barato y siempre disponible: JSON local, sin SSH, no se cae (igual que cuota/inventario). Es el
// "dashboard" del monitoreo — lo que necesita acción AHORA, rankeado por severidad. El feed en vivo
// por nodo (SSH) es para bucear; esto es la vista de flota.

import type { IncomingMessage, ServerResponse } from "node:http";

import { armarAlertasFlota } from "../sender-alerts.ts";
import { resolverTecho } from "../sender-quota.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export interface SenderAlertsRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  readBoundaryToken?: string;
  now?: () => Date;
}

export async function handleSenderAlertsHttp(deps: SenderAlertsRouteDeps): Promise<void> {
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
    "sender_alerts"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  const alerts = await armarAlertasFlota({
    workspace: deps.workspace,
    techo: resolverTecho(),
    ...(deps.now ? { now: deps.now } : {})
  });
  json(deps.response, 200, alerts);
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
