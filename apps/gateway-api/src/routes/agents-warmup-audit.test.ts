// Tests de la ruta del abanico: lo que protege la plata y la flota.
//
// Los tres casos vienen de la auditoria adversarial: sin ellos el kill switch se leia una sola
// vez (una corrida lanzada era imparable), y el rate limit de 3/min permitia tres abanicos
// concurrentes de 59 dominios cada uno.

import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleWarmupAuditHttp } from "./agents-warmup-audit.ts";
import type { AgentSessionManager } from "../agents/agent-session-manager.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";

const TOKEN = "token-de-prueba";

let clientCounter = 0;

function request(body: unknown): IncomingMessage {
  // Readable de verdad y no un EventEmitter pelado: readRequestBody consume el stream, y un
  // emitter que emite antes de que se suscriban entrega un body vacio (400 invalid_json).
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  stream.method = "POST";
  // IP distinta por request: el rate limit de la ruta es 3/min por IP + prefijo de token, y
  // varios tests seguidos desde la misma IP se comerian un 429 que no tiene nada que ver.
  clientCounter += 1;
  stream.headers = { "x-delivrix-token": TOKEN, "x-forwarded-for": `10.0.0.${clientCounter}` };
  return stream;
}

function response(): { response: ServerResponse; done: Promise<{ status: number; payload: any }> } {
  let resolve!: (value: { status: number; payload: any }) => void;
  const done = new Promise<{ status: number; payload: any }>((r) => { resolve = r; });
  let status = 0;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(body?: string) { resolve({ status, payload: body ? JSON.parse(body) : undefined }); }
  } as unknown as ServerResponse;
  return { response: res, done };
}

/**
 * Workspace REAL sobre un directorio temporal, no un doble.
 *
 * Un fake de readInventoryJson pasaria los tests aunque loadWarmupFleet leyera otro archivo o
 * lo cruzara distinto — ya paso en este repo que un doble se salteaba el codigo que importaba.
 */
async function workspace(): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "audit-route-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  await ws.updateInventoryJson("domains.json", () => ({
    bindings: [
      { domain: "a.com", serverSlug: "nodo-1", serverIp: "198.51.100.1" },
      { domain: "b.com", serverSlug: "nodo-2", serverIp: "198.51.100.2" }
    ]
  }));
  return ws;
}

/** Manager que tarda, para que el kill switch tenga tiempo de dispararse en vuelo. */
function slowManager(delayMs: number, seen: { aborted: boolean }): AgentSessionManager {
  return {
    modelIdForRole: () => "mock/test",
    async invokeAgent(_role: string, invoke: any, options: any) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (options?.abortSignal?.aborted) seen.aborted = true;
      return {
        sessionId: `sess-${invoke.taskId}`,
        result: {
          status: "completed",
          resultSummary: "el nodo responde y el DKIM valida",
          inputTokens: 10,
          outputTokens: 5,
          estimatedCostUsd: 0,
          pricingKnown: true,
          toolCallCount: 4
        }
      };
    }
  } as unknown as AgentSessionManager;
}

const auditLog = {
  async append() { return undefined; },
  async list() { return []; }
} as any;

test("el kill switch armado DURANTE la corrida la corta: antes se leia una sola vez", async () => {
  const seen = { aborted: false };
  let armed = false;
  const { response: res, done } = response();

  const running = handleWarmupAuditHttp({
    request: request({ concurrency: 1 }),
    response: res,
    sessionManager: slowManager(120, seen),
    workspace: await workspace(),
    auditLog,
    readBoundaryToken: TOKEN,
    readKillSwitch: () => ({ enabled: armed }),
    killSwitchPollMs: 10
  });

  setTimeout(() => { armed = true; }, 40);
  await running;
  const { status, payload } = await done;

  assert.equal(status, 200);
  // La corrida se corto: hay dominios cancelados y el flag de aborto.
  assert.equal(payload.aborted, true);
  assert.ok(payload.cancelled >= 1, "al menos un dominio no llego a despacharse");
});

test("dos abanicos a la vez no: el segundo se rechaza en vez de duplicar el gasto", async () => {
  const seen = { aborted: false };
  const first = response();
  const second = response();

  const running = handleWarmupAuditHttp({
    request: request({ concurrency: 1 }),
    response: first.response,
    sessionManager: slowManager(60, seen),
    workspace: await workspace(),
    auditLog,
    readBoundaryToken: TOKEN,
    readKillSwitch: () => ({ enabled: false })
  });

  // Sin esperar a que termine el primero.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await handleWarmupAuditHttp({
    request: request({}),
    response: second.response,
    sessionManager: slowManager(60, seen),
    workspace: await workspace(),
    auditLog,
    readBoundaryToken: TOKEN,
    readKillSwitch: () => ({ enabled: false })
  });

  const segundo = await second.done;
  assert.equal(segundo.status, 409);
  assert.equal(segundo.payload.error, "warmup_audit_already_running");

  await running;
  assert.equal((await first.done).status, 200);
});

test("un veredicto sin una sola sonda NO se reporta como ok", async () => {
  // Medido en vivo el 2026-07-29: el modelo cerraba con cero tools en el 46% de la flota y el
  // reporte decia ok, con lineas de "evidencia" citando sondas que nunca corrieron.
  const seen = { aborted: false };
  const { response: res, done } = response();
  const manager = {
    modelIdForRole: () => "modelo/de-prueba",
    async invokeAgent(_role, invoke) {
      return {
        sessionId: `sess-${invoke.taskId}`,
        result: {
          status: "completed",
          resultSummary: "veredicto: indeterminado\nevidencia:\n  - read_smtp_reachability: unknown",
          inputTokens: 3244,
          outputTokens: 1004,
          estimatedCostUsd: 0,
          pricingKnown: true,
          toolCallCount: 0
        }
      };
    }
  } as unknown as AgentSessionManager;

  await handleWarmupAuditHttp({
    request: request({ concurrency: 2 }),
    response: res,
    sessionManager: manager,
    workspace: await workspace(),
    auditLog,
    readBoundaryToken: TOKEN,
    readKillSwitch: () => ({ enabled: false })
  });

  const { payload } = await done;
  assert.equal(payload.ok, 0, "cero sondas no es un diagnostico");
  assert.equal(payload.sinEvidencia, 2);
  assert.equal(payload.items[0].status, "sin_evidencia");
  assert.equal(payload.items[0].toolCallCount, 0);
  // El veredicto se conserva: el operador tiene que poder ver QUE escribio el modelo sin sondas.
  assert.match(payload.items[0].verdict, /indeterminado/);
});

test("el reporte trae el veredicto y que cerebro corrio, no solo un conteo", async () => {
  const seen = { aborted: false };
  const { response: res, done } = response();

  await handleWarmupAuditHttp({
    request: request({ concurrency: 2 }),
    response: res,
    sessionManager: slowManager(1, seen),
    workspace: await workspace(),
    auditLog,
    readBoundaryToken: TOKEN,
    readKillSwitch: () => ({ enabled: false })
  });

  const { status, payload } = await done;
  assert.equal(status, 200);
  // El veredicto es el producto de la corrida: sin esto el operador recibe un conteo y nada mas.
  assert.equal(payload.items[0].verdict, "el nodo responde y el DKIM valida");
  // Sin modelId, una corrida en mock se lee igual que una real.
  assert.equal(payload.modelId, "mock/test");
  assert.equal(payload.items[0].status, "ok");
});
