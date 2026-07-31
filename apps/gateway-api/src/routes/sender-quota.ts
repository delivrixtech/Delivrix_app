// GET  /v1/sender-pool/quota           — la lista con el numero: lo que NFC consume por API.
// PATCH /v1/sender-pool/quota/:domain  — el operador asigna la cuota diaria de una bandeja.
//
// Auth en dos carriles, como warmup-mailboxes:
//   - LECTURA: con SENDER_QUOTA_API_KEY seteada, NFC entra por `x-sender-quota-key` (timing-safe).
//     El read-boundary del panel sigue valiendo en paralelo: el operador y el consumidor externo
//     no comparten llave.
//   - ESCRITURA: FAIL-CLOSED contra el token del emisor OpenClaw (`x-openclaw-gateway-token`),
//     el mismo carril que las mutaciones de canvas. Sin token configurado → 503. El portador de
//     la llave de lectura de NFC NO puede subirse su propia cuota: ese era exactamente el
//     problema a matar.
//
// Cada cambio de cuota queda en el audit log con antes/despues: es la decision que controla el
// volumen de envio, no un ajuste cosmetico.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuditEvent, AuditEventInput } from "../../../../packages/domain/src/index.ts";
import { armarCuotaFlota, guardarCuota, resolverTecho } from "../sender-quota.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { readRequestBody } from "../request-body.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<AuditEvent>;
}

export interface SenderQuotaRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  auditLog: AuditSink;
  /** Llave de lectura para el consumidor externo (NFC). Opcional: sin ella queda solo el panel. */
  quotaApiKey?: string;
  /** Token del emisor OpenClaw. Las escrituras son fail-closed contra este token. */
  operatorToken?: string;
  readBoundaryToken?: string;
  techo?: number;
  now?: () => Date;
}

export async function handleSenderQuotaHttp(deps: SenderQuotaRouteDeps): Promise<void> {
  if (deps.request.method !== "GET") {
    json(deps.response, 405, { error: "method_not_allowed" });
    return;
  }

  if (!autorizadoParaLeer(deps)) {
    json(deps.response, 401, { error: "unauthorized" });
    return;
  }

  const cuota = await armarCuotaFlota({
    workspace: deps.workspace,
    techo: deps.techo ?? resolverTecho(),
    ...(deps.now ? { now: deps.now } : {})
  });
  json(deps.response, 200, cuota);
}

export async function handleSenderQuotaUpdateHttp(
  deps: SenderQuotaRouteDeps & { domain: string }
): Promise<void> {
  if (deps.request.method !== "PATCH") {
    json(deps.response, 405, { error: "method_not_allowed" });
    return;
  }

  // Fail-closed: sin token configurado no hay escritura, no hay fallback al read-boundary.
  const expected = deps.operatorToken?.trim();
  if (!expected) {
    json(deps.response, 503, { error: "operator_token_not_configured" });
    return;
  }
  const supplied = headerValue(deps.request, "x-openclaw-gateway-token");
  if (!supplied || !safeEqual(supplied, expected)) {
    json(deps.response, 401, { error: "unauthorized" });
    return;
  }

  let body: { hoyPuede?: unknown };
  try {
    body = JSON.parse((await readRequestBody(deps.request)) || "{}") as { hoyPuede?: unknown };
  } catch {
    json(deps.response, 400, { error: "invalid_json" });
    return;
  }

  const techo = deps.techo ?? resolverTecho();
  const resultado = await guardarCuota({
    workspace: deps.workspace,
    domain: deps.domain,
    hoyPuede: body.hoyPuede,
    techo,
    ...(deps.now ? { now: deps.now } : {})
  });

  if (!resultado.ok) {
    const status = resultado.error === "dominio_desconocido" ? 404 : 422;
    json(deps.response, status, {
      error: resultado.error,
      ...(resultado.techo !== undefined ? { techo: resultado.techo } : {})
    });
    return;
  }

  await deps.auditLog.append({
    actorType: "operator",
    actorId: "admin-panel",
    action: "senderpool.quota.updated",
    targetType: "sender_domain",
    targetId: resultado.domain,
    riskLevel: "high",
    metadata: { antes: resultado.antes, asignada: resultado.asignada, techo }
  });

  json(deps.response, 200, {
    domain: resultado.domain,
    asignada: resultado.asignada,
    antes: resultado.antes,
    actualizadoEn: resultado.actualizadoEn
  });
}

function autorizadoParaLeer(deps: SenderQuotaRouteDeps): boolean {
  const apiKey = deps.quotaApiKey?.trim();
  const supplied = headerValue(deps.request, "x-sender-quota-key");
  if (apiKey && supplied && safeEqual(supplied, apiKey)) return true;

  const fallback = authorizeSensitiveRead(
    deps.request,
    {
      ...(deps.readBoundaryToken === undefined ? {} : { readBoundaryToken: deps.readBoundaryToken }),
      ...(deps.now ? { now: deps.now } : {})
    },
    "sender_quota"
  );
  return fallback.ok;
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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
