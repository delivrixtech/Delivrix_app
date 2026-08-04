// Tests de las manos del agente. Lo que protegen NO es que las acciones funcionen — es que las
// que NO están permitidas no se ejecuten. Todo lo que entra acá lo escribió un modelo, así que se
// trata como entrada hostil.

import assert from "node:assert/strict";
import test from "node:test";

import { ejecutarAcciones, extraerAcciones, MAX_ACCIONES_POR_VUELTA, type ContextoAcciones, type Pendiente } from "./acciones-agente.ts";

const AHORA = new Date("2026-08-04T17:00:00.000Z");

function ctx(over: Partial<ContextoAcciones> = {}): ContextoAcciones & { frenados: string[]; pausas: string[]; lista: Pendiente[] } {
  const frenados: string[] = [];
  const pausas: string[] = [];
  const lista: Pendiente[] = [];
  return {
    frenados, pausas, lista,
    dominiosConocidos: ["a.com", "b.com"],
    ahora: () => AHORA,
    frenarDominio: async (d) => { frenados.push(d); return { antes: 20, despues: 0 }; },
    pausarWarmup: async (m) => { pausas.push(m); },
    warmupPausado: async () => pausas.length > 0,
    pendientes: { listar: async () => lista, guardar: async (p) => { lista.length = 0; lista.push(...p); } },
    ...over
  } as never;
}

test("una acción que NO está en la lista blanca no se ejecuta, y se dice", () => {
  return ejecutarAcciones([{ accion: "borrar_todo", motivo: "porque sí" }], ctx()).then((r) => {
    assert.equal(r[0]!.ejecutada, false);
    assert.match(r[0]!.detalle, /no es una acción permitida/);
  });
});

test("NO se puede frenar un dominio que no existe: un nombre alucinado no llega al SSH", async () => {
  const c = ctx();
  const r = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "inventado.com", motivo: "x" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está en el inventario/);
  assert.deepEqual(c.frenados, [], "no se tocó nada");
});

test("frenar un dominio real sí se ejecuta y deja antes/después", async () => {
  const c = ctx();
  const r = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "A.com", motivo: "cruzó el umbral" }], c);
  assert.equal(r[0]!.ejecutada, true);
  assert.deepEqual(c.frenados, ["a.com"]);
  assert.equal(r[0]!.antes, 20);
  assert.equal(r[0]!.despues, 0);
});

test("toda acción exige MOTIVO: sin él no se ejecuta", async () => {
  // Una acción automática sin motivo registrado es indefendible después.
  const c = ctx();
  const r = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "a.com" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /motivo/);
  assert.deepEqual(c.frenados, []);
});

test("pausar es IDEMPOTENTE: si ya estaba pausado no se reporta como acción nueva", async () => {
  const c = ctx();
  await ejecutarAcciones([{ accion: "pausar_warmup", motivo: "placement en caída" }], c);
  const r2 = await ejecutarAcciones([{ accion: "pausar_warmup", motivo: "placement en caída" }], c);
  assert.equal(r2[0]!.ejecutada, false);
  assert.match(r2[0]!.detalle, /ya estaba pausado/);
  assert.equal(c.pausas.length, 1);
});

test("una capacidad no habilitada se rechaza en vez de romper", async () => {
  const r = await ejecutarAcciones([{ accion: "pausar_warmup", motivo: "x" }], ctx({ pausarWarmup: undefined }));
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está habilitado/);
});

test("el mismo pendiente NO se duplica: suma al contador", async () => {
  // Sin esto, "falta una semilla de Yahoo" crearía un pendiente cada 10 minutos y la lista sería
  // inservible en un día.
  const c = ctx();
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "semilla de yahoo", motivo: "punto ciego" }], c);
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "semilla de yahoo", motivo: "punto ciego" }], c);
  assert.equal(c.lista.length, 1);
  assert.equal(c.lista[0]!.visto, 2);
});

test("resolver un pendiente inexistente se rechaza", async () => {
  const r = await ejecutarAcciones([{ accion: "resolver_pendiente", id: "no-existe", motivo: "x" }], ctx());
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no hay pendiente abierto/);
});

test("hay un TOPE de acciones por lectura, y lo que se descarta se declara", async () => {
  // Un agente que hace veinte cosas de golpe no se puede auditar.
  const c = ctx();
  const muchas = Array.from({ length: 6 }, () => ({ accion: "frenar_dominio", dominio: "a.com", motivo: "x" }));
  const r = await ejecutarAcciones(muchas, c);
  assert.equal(c.frenados.length, MAX_ACCIONES_POR_VUELTA);
  assert.match(r.at(-1)!.detalle, /se ignoraron 3/);
});

// ── Extracción del texto del modelo ─────────────────────────────────────────────────────────────

test("extrae acciones de las líneas ACCION y nada más", () => {
  const a = extraerAcciones(
    "AHORA: todo bien.\nACCION: frenar_dominio | dominio=a.com | motivo=cruzó el umbral\nRIESGO: ninguno"
  );
  assert.equal(a.length, 1);
  assert.equal(a[0]!.accion, "frenar_dominio");
  assert.equal(a[0]!.dominio, "a.com");
  assert.equal(a[0]!.motivo, "cruzó el umbral");
});

test("una lectura sin acciones no produce ninguna", () => {
  assert.deepEqual(extraerAcciones("AHORA: todo bien.\nFALTA: nada"), []);
});

test("una línea mal formada se IGNORA, no se adivina", () => {
  // Adivinar sobre una acción que toca producción es exactamente lo que no queremos.
  assert.deepEqual(extraerAcciones("ACCION:"), []);
});
