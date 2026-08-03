// GET /v1/warmup/conversation?testId=… — la CONVERSACIÓN REAL de una vuelta de warmup.
//
// Abre el buzón semilla por IMAP y trae lo que de verdad llegó: asunto, remitente, fecha, cuerpo y
// en qué carpeta cayó. Es lo que convierte el semáforo de cuatro puntos en evidencia.
//
// CARO: abre una sesión IMAP por request. Va bajo demanda (el operador toca una vuelta), nunca en
// un poll. Y fail-honest: si no se puede leer, se DECLARA — nunca se devuelve un hilo vacío que
// parezca "no hubo conversación".

import type { IncomingMessage, ServerResponse } from "node:http";

import { leerHiloWarmup, type HiloWarmup, type ImapLector } from "../../../warmup-engine/src/live/imap-thread-reader.ts";
import { descifrarSemilla, leerSemillas, semillasMedibles } from "../warmup-seeds.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export interface ConversacionResponse extends HiloWarmup {
  /** Desde qué buzón se leyó. El operador tiene que saber en qué semilla está mirando. */
  semilla: string | null;
}

export async function handleWarmupConversationHttp(deps: {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  readBoundaryToken?: string;
  env?: Record<string, string | undefined>;
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
    "warmup_conversation"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = new URL(deps.request.url ?? "/", "http://local");
  const testId = (url.searchParams.get("testId") ?? "").trim();
  if (!testId || testId.length > 120) {
    json(deps.response, 400, { error: "test_id_requerido" });
    return;
  }

  const { seeds } = await leerSemillas(deps.workspace);
  // Solo las que tienen app password: la de OAuth usa otro camino y las solo-destino no abren buzón.
  const semilla = semillasMedibles(seeds).find((s) => s.auth === "imap_password");
  if (!semilla) {
    json(deps.response, 200, {
      testId,
      semilla: null,
      mensajes: [],
      motivo: "no hay ninguna semilla con app password: sin acceso al buzón no se puede leer el hilo"
    } satisfies ConversacionResponse);
    return;
  }

  let cliente: (ImapLector & { connect(): Promise<void>; logout(): Promise<void> }) | null = null;
  try {
    const { ImapFlow } = await import("imapflow");
    cliente = new ImapFlow({
      host: semilla.imap.host,
      port: semilla.imap.port,
      secure: true,
      auth: { user: semilla.address, pass: descifrarSemilla(semilla, deps.env ?? process.env) },
      logger: false
    }) as unknown as ImapLector & { connect(): Promise<void>; logout(): Promise<void> };

    await conTimeout(cliente.connect(), 20_000, "conectar al buzón");
    const hilo = await conTimeout(leerHiloWarmup(cliente, testId), 25_000, "leer el hilo");
    json(deps.response, 200, { ...hilo, semilla: semilla.address } satisfies ConversacionResponse);
  } catch (error) {
    // Se declara el fallo con su motivo. Un hilo vacío mudo se leería como "no hubo conversación".
    json(deps.response, 200, {
      testId,
      semilla: semilla.address,
      mensajes: [],
      motivo: `no se pudo leer el buzón: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`
    } satisfies ConversacionResponse);
  } finally {
    try {
      await cliente?.logout();
    } catch {
      /* ya estaba cerrado */
    }
  }
}

function conTimeout<T>(p: Promise<T>, ms: number, que: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout de ${ms / 1000}s al ${que}`)), ms))
  ]);
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
