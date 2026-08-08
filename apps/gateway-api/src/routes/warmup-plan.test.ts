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
import {
  elegirPool,
  leerCuposFisicos,
  leerReputacion,
  leerSalud
} from "../../../warmup-engine/src/service/plan-diario.ts";

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

// ── UN FIXTURE, DOS CAMINOS: el pool de la ruta tiene que ser el pool del daemon ────────────────

/**
 * Los cinco dominios salen TAL CUAL de la foto de producción del 2026-08-08 (solo lectura): sus
 * caps de `sender-cap.json`, sus estados de `sender-measurement.json` y sus filas de
 * `warmup-reputacion.json`. Se copian acá en vez de leer la foto porque el test tiene que correr en
 * cualquier máquina, pero los valores no son inventados — un fixture escrito desde mi suposición no
 * prueba nada, porque el test y el código comparten el error.
 */
function flotaDeLaFoto(): { capFile: string; saludFile: string; reputacionFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "plan-pool-"));
  const escribir = (nombre: string, cuerpo: unknown): string => {
    const ruta = join(dir, nombre);
    writeFileSync(ruta, JSON.stringify(cuerpo));
    return ruta;
  };
  const nodos = [
    { domain: "annualfiling-ops.com", cap: 137 },
    { domain: "annualfilingops.com", cap: 134 },
    { domain: "annualfilings-infra.com", cap: 146 },
    { domain: "controldelivrix.app", cap: 253 },
    { domain: "corpfiling-infra.com", cap: 20 }
  ];
  // Los cinco salieron `healthy` en la corrida real: la salud NO los separa. El único que los
  // separa es el barrido de autenticación, que es justo el archivo que la ruta no leía.
  const bandejas = nodos.map((n) => ({
    domain: n.domain,
    estado: "healthy",
    entregados: 22,
    picos: [{ familia: "google", mensajes: 8, umbral: 5000, ratio: 0.002 }],
    cerradoEn: [],
    cruzados: [],
    cerca: []
  }));
  const ok = { estado: "ok" };
  const dominios = [
    { dominio: "annualfiling-ops.com", listas: ["DRONE BL"], spf: ok, dkim: ok, ptr: ok, tls: { estado: "no-se" } },
    { dominio: "annualfilingops.com", listas: ["RATS Dyna"], spf: ok, dkim: ok, ptr: ok, tls: { estado: "no-se" } },
    { dominio: "annualfilings-infra.com", listas: ["RATS Dyna"], spf: ok, dkim: ok, ptr: ok, tls: { estado: "no-se" } },
    { dominio: "controldelivrix.app", listas: [], spf: ok, dkim: ok, ptr: { estado: "mal", detalle: "77.37.96.113 no tiene PTR" }, tls: { estado: "no-se" } },
    { dominio: "corpfiling-infra.com", listas: [], spf: ok, dkim: ok, ptr: ok, tls: { estado: "no-se" } }
  ];
  return {
    capFile: escribir("sender-cap.json", { medidoEn: AHORA.toISOString(), nodos }),
    saludFile: escribir("sender-measurement.json", { medidoEn: AHORA.toISOString(), bandejas }),
    reputacionFile: escribir("warmup-reputacion.json", { medidoEn: AHORA.toISOString(), dominios })
  };
}

const pgVacio = { async query() { return { rows: [] }; } } as never;

async function poolDeLaRuta(archivos: ReturnType<typeof flotaDeLaFoto>, conReputacion: boolean): Promise<string[]> {
  const { res, json } = respuestaFalsa();
  await handleWarmupPlan(pedido("t"), res, {
    pgClient: pgVacio,
    capFile: archivos.capFile,
    saludFile: archivos.saludFile,
    ...(conReputacion ? { reputacionFile: archivos.reputacionFile } : {}),
    poolConfigurado: [],
    readBoundaryToken: "t",
    now: () => AHORA
  });
  return json().dominios.map((d: { dominio: string }) => d.dominio).sort();
}

test("el pool que muestra la ruta es EL MISMO que el que corre el daemon", async () => {
  // LA DIVERGENCIA, MEDIDA SOBRE LA FOTO DEL 2026-08-08 con la función real del árbol: la ruta
  // devolvía 36 dominios y el daemon calentaba 32. Los 4 de más eran 3 IPs en lista negra
  // (annualfiling-ops.com en DRONE BL, annualfilingops.com y annualfilings-infra.com en RATS Dyna)
  // y controldelivrix.app sin PTR — exactamente lo que `authRota` existe para sacar. El panel y el
  // agente le reportaban al jefe cuatro dominios que nadie estaba calentando.
  //
  // La causa era una sola: NINGÚN llamador de `planDelDia` pasaba `reputacionFile`, mientras el
  // daemon lee ese archivo por su cuenta (live-warmup-daemon.ts:1337). Dos caminos, un fixture:
  // este test los vuelve a juntar y se pone rojo si alguien los separa otra vez.
  const archivos = flotaDeLaFoto();

  // EL CAMINO DEL DAEMON, compuesto igual que en live-warmup-daemon.ts:1337.
  const delDaemon = elegirPool(
    await leerCuposFisicos(archivos.capFile, AHORA),
    [],
    await leerSalud(archivos.saludFile),
    await leerReputacion(archivos.reputacionFile),
    []
  ).boxes;

  assert.deepEqual(await poolDeLaRuta(archivos, true), [...delDaemon].sort(), "la ruta muestra otro pool que el que se ejecuta");
  assert.deepEqual([...delDaemon].sort(), ["corpfiling-infra.com"], "sólo sobrevive el que tiene la auth sana");

  // Y sin el archivo, la ruta vuelve a inflar: los 4 excluidos reaparecen. Esta mitad del test es
  // la que prueba que el cableado hace algo — sin ella, pasaría igual con la línea borrada.
  assert.deepEqual(await poolDeLaRuta(archivos, false), [
    "annualfiling-ops.com",
    "annualfilingops.com",
    "annualfilings-infra.com",
    "controldelivrix.app",
    "corpfiling-infra.com"
  ]);
});

test("la reputación sólo puede ACHICAR el pool de la ruta, nunca agrandarlo", async () => {
  // La baranda del despliegue: es aditivo y es una lista de EXCLUSIONES. Si algún día `authRota`
  // empezara a meter a alguien que no estaba, este lote habría subido volumen sin decirlo — y nada
  // que aumente volumen entra sin la cuenta del operador delante.
  const archivos = flotaDeLaFoto();
  const conFiltro = await poolDeLaRuta(archivos, true);
  const sinFiltro = await poolDeLaRuta(archivos, false);
  assert.deepEqual(conFiltro.filter((d) => !sinFiltro.includes(d)), [], "apareció un dominio que sin el filtro no estaba");
});

test("el payload NO trae secretos: solo dominios, números y motivos", async () => {
  const { res, capturado } = respuestaFalsa();
  await handleWarmupPlan(pedido("t"), res, {
    pgClient: pgOk, capFile: capFile(20), poolConfigurado: [], readBoundaryToken: "t", now: () => AHORA
  });
  assert.doesNotMatch(capturado.body, /password|secret|token|BEGIN [A-Z]* ?PRIVATE KEY/i);
});
