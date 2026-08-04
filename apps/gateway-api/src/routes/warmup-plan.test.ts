// Tests de la ruta del plan. Lo que protegen: que sea read-only de verdad, que exija el token, y
// que un fallo de lectura NO tumbe el panel — un 500 acá deja al operador sin la única pantalla
// donde puede entender por qué el warmup manda lo que manda.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleWarmupPlan } from "./warmup-plan.ts";

const AHORA = new Date("2026-08-04T15:00:00.000Z");

function capFile(cap: number): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  const ruta = join(dir, "sender-cap.json");
  writeFileSync(ruta, JSON.stringify({ medidoEn: AHORA.toISOString(), nodos: [{ domain: "a.com", cap }] }));
  return ruta;
}

function respuestaFalsa() {
  const capturado = { status: 0, body: "" };
  const res = {
    writeHead(status: number) { capturado.status = status; return res; },
    end(payload?: string) { capturado.body = payload ?? ""; }
  } as unknown as ServerResponse;
  return { res, capturado, json: () => JSON.parse(capturado.body) };
}

const pedido = (token?: string) =>
  ({ method: "GET", url: "/v1/warmup/plan", headers: token ? { "x-delivrix-token": token } : {} }) as unknown as IncomingMessage;

const pgOk = {
  async query(sql: string) {
    if (sql.includes("kind = 'measured'")) return { rows: [{ placement: "INBOX" }, { placement: "INBOX" }, { placement: "INBOX" }, { placement: "INBOX" }] };
    if (sql.includes("seed_inbox, occurred_at")) return { rows: [{ node_domain: "a.com", seed_inbox: "s@x.com", occurred_at: new Date("2026-08-03T10:00:00Z") }] };
    return { rows: [] };
  }
} as never;

test("sin Postgres devuelve plan vacío con nota, no un 500", async () => {
  // El panel tiene que poder mostrar "sin datos" honesto en vez de romperse.
  const { res, json } = respuestaFalsa();
  await handleWarmupPlan(pedido("t"), res, {
    pgClient: null, capFile: capFile(20), poolConfigurado: [], readBoundaryToken: "t", now: () => AHORA
  });
  assert.deepEqual(json().dominios, []);
  assert.equal(json().nota, "postgres_unavailable");
});

test("una lectura rota NO tumba el panel, pero SE DECLARA qué falló", async () => {
  // Degradar en silencio es la trampa: el plan se mostraría como completo estando a medias, y
  // "no pude medir" se leería igual que "medí y no hay nada".
  const { res, capturado, json } = respuestaFalsa();
  await handleWarmupPlan(pedido("t"), res, {
    pgClient: { async query() { throw new Error("relation does not exist"); } } as never,
    capFile: capFile(20), poolConfigurado: [], readBoundaryToken: "t", now: () => AHORA
  });
  assert.equal(capturado.status, 200, "el panel no se rompe");
  const plan = json();
  assert.ok(plan.lecturasFallidas.length > 0, "el fallo se declara");
  assert.match(plan.lecturasFallidas.join(" "), /relation does not exist/);
  assert.equal(plan.dominios[0].placement.tasa, null);
  assert.match(plan.dominios[0].placement.error, /relation does not exist/, "no se confunde con 'sin muestra'");
});

test("exige el token de lectura sensible", async () => {
  const { res, capturado } = respuestaFalsa();
  await handleWarmupPlan(pedido(), res, {
    pgClient: pgOk, capFile: capFile(20), poolConfigurado: [], readBoundaryToken: "secreto", now: () => AHORA
  });
  assert.notEqual(capturado.status, 200, "sin token no se sirve el plan");
});

test("devuelve la decisión con su motivo, que es el punto de la pantalla", async () => {
  const { res, json } = respuestaFalsa();
  await handleWarmupPlan(pedido("t"), res, {
    pgClient: pgOk, capFile: capFile(20), poolConfigurado: [], readBoundaryToken: "t", now: () => AHORA
  });
  const d = json().dominios[0];
  assert.equal(d.dominio, "a.com");
  assert.ok(d.decision.motivo.length > 0, "una decisión sin motivo no se puede auditar");
  assert.equal(d.placement.tasa, 1);
  assert.equal(typeof d.decision.cupo, "number");
});

test("el payload NO trae secretos: solo dominios, números y motivos", async () => {
  const { res, capturado } = respuestaFalsa();
  await handleWarmupPlan(pedido("t"), res, {
    pgClient: pgOk, capFile: capFile(20), poolConfigurado: [], readBoundaryToken: "t", now: () => AHORA
  });
  assert.doesNotMatch(capturado.body, /password|secret|token|BEGIN [A-Z]* ?PRIVATE KEY/i);
});
