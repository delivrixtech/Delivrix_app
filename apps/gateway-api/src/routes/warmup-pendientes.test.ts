// Tests de la ruta de pendientes. Lo que protegen: que el caso NORMAL (todavía no hay nada anotado)
// no se vea como un error, que exija token, y que el orden sea el útil.

import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleWarmupPendientes } from "./warmup-pendientes.ts";

const AHORA = new Date("2026-08-10T12:00:00.000Z");

function respuesta() {
  const cap = { status: 0, body: "" };
  const res = {
    writeHead(s: number) { cap.status = s; return res; },
    end(p?: string) { cap.body = p ?? ""; }
  } as unknown as ServerResponse;
  return { res, cap, json: () => JSON.parse(cap.body) };
}

const pedido = (token?: string) =>
  ({ method: "GET", url: "/v1/warmup/pendientes", headers: token ? { "x-delivrix-token": token } : {} }) as unknown as IncomingMessage;

const ws = (lista: unknown) => ({ readInventoryJson: async () => lista }) as never;

test("exige el token de lectura sensible", async () => {
  const { res, cap } = respuesta();
  await handleWarmupPendientes(pedido(), res, { workspace: ws([]), readBoundaryToken: "secreto", now: () => AHORA });
  assert.notEqual(cap.status, 200);
});

test("sin archivo todavía: lista vacía CON nota, no un error", async () => {
  // Es el caso normal cuando el agente no tiene nada que pedir. Un 500 haría ver como roto un
  // sistema que simplemente está bien.
  const { res, cap, json } = respuesta();
  await handleWarmupPendientes(pedido("t"), res, {
    workspace: { readInventoryJson: async () => { throw new Error("ENOENT"); } } as never,
    readBoundaryToken: "t", now: () => AHORA
  });
  assert.equal(cap.status, 200);
  assert.deepEqual(json().abiertos, []);
  assert.match(json().nota, /todavía no hay/);
});

test("los abiertos se ordenan por INSISTENCIA, no por fecha", async () => {
  // Un pendiente que el agente volvió a detectar quince veces es más urgente que uno viejo que
  // se vio una sola vez.
  const { res, json } = respuesta();
  await handleWarmupPendientes(pedido("t"), res, {
    workspace: ws([
      { id: "a", que: "viejo", porque: "x", abiertoEn: "2026-08-01T00:00:00Z", visto: 1 },
      { id: "b", que: "insistente", porque: "y", abiertoEn: "2026-08-09T00:00:00Z", visto: 15 }
    ]),
    readBoundaryToken: "t", now: () => AHORA
  });
  assert.deepEqual(json().abiertos.map((p: { que: string }) => p.que), ["insistente", "viejo"]);
});

test("los resueltos se separan de los abiertos", async () => {
  const { res, json } = respuesta();
  await handleWarmupPendientes(pedido("t"), res, {
    workspace: ws([
      { id: "a", que: "abierto", porque: "x", abiertoEn: "2026-08-01T00:00:00Z", visto: 1 },
      { id: "b", que: "cerrado", porque: "y", abiertoEn: "2026-08-01T00:00:00Z", visto: 1, resueltoEn: "2026-08-05T00:00:00Z" }
    ]),
    readBoundaryToken: "t", now: () => AHORA
  });
  assert.equal(json().abiertos.length, 1);
  assert.equal(json().resueltos.length, 1);
});

test("calcula los días abiertos, y null si la fecha es ilegible", async () => {
  const { res, json } = respuesta();
  await handleWarmupPendientes(pedido("t"), res, {
    workspace: ws([
      { id: "a", que: "x", porque: "y", abiertoEn: "2026-08-01T12:00:00Z", visto: 1 },
      { id: "b", que: "z", porque: "w", abiertoEn: "no-es-fecha", visto: 1 }
    ]),
    readBoundaryToken: "t", now: () => AHORA
  });
  const porId = Object.fromEntries(json().abiertos.map((p: { id: string; diasAbierto: number | null }) => [p.id, p.diasAbierto]));
  assert.equal(porId.a, 9);
  assert.equal(porId.b, null, "fecha ilegible es null, NO 0 días (que se leería como 'recién')");
});
