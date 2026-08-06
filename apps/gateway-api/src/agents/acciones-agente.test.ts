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

// ── Dedup de pendientes reformulados ─────────────────────────────────────────────────────────────
// Visto en producción a los diez minutos de habilitar las acciones: el agente anotó la MISMA cosa
// tres veces con tres redacciones. Los modelos reformulan; con dedup exacto la promesa de "anotalo
// una sola vez" se rompe el primer día.

import { mismoPendiente } from "./acciones-agente.ts";

test("reconoce como el mismo pendiente las tres redacciones que salieron en vivo", () => {
  assert.equal(mismoPendiente("outlook y yahoo", "semillas para outlook y yahoo"), true);
  assert.equal(mismoPendiente("outlook y yahoo", "outlook,yahoo"), true);
  assert.equal(mismoPendiente("semillas para outlook y yahoo", "outlook,yahoo"), true);
});

test("NO confunde pendientes de temas distintos", () => {
  assert.equal(mismoPendiente("semilla de yahoo", "soltar cupo en corpfiling-infra.com"), false);
  assert.equal(mismoPendiente("semilla de outlook", "semilla de gmail"), false);
});

test("los acentos y la puntuación no crean duplicados", () => {
  assert.equal(mismoPendiente("revisión del cupo", "revision del cupo!"), true);
});

test("dos pendientes con redacciones distintas se juntan en uno", async () => {
  const c = ctx();
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "outlook y yahoo", motivo: "punto ciego" }], c);
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "semillas para outlook y yahoo", motivo: "punto ciego" }], c);
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "outlook,yahoo", motivo: "punto ciego" }], c);
  assert.equal(c.lista.length, 1, "una sola entrada, no tres");
  assert.equal(c.lista[0]!.visto, 3);
});

test("el freno tiene ALCANCE: solo donde el daño ya está hecho", async () => {
  // Un dominio sano frenado por decisión del modelo cuesta calentamiento real. Uno que ya cruzó
  // el umbral permanente no tiene nada que perder. La diferencia no puede quedar librada al juicio
  // del modelo: es una barrera.
  const frenados: string[] = [];
  const ctx = {
    dominiosConocidos: ["sano.com", "cruzado.com"],
    frenablesConDanio: ["cruzado.com"],
    frenarDominio: async (d: string) => {
      frenados.push(d);
      return { antes: 50, despues: 0 };
    }
  };

  const sobreSano = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "sano.com", motivo: "me parece" }],
    ctx as never
  );
  assert.equal(sobreSano[0]?.ejecutada, false, "un dominio sano NO se frena solo");
  assert.match(sobreSano[0]?.detalle ?? "", /no cruzó el umbral/);
  assert.match(sobreSano[0]?.detalle ?? "", /pendiente/, "le dice cuál es la salida correcta");
  assert.deepEqual(frenados, [], "no llegó a tocar la flota");

  const sobreCruzado = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "cruzado.com", motivo: "cruzó el umbral permanente" }],
    ctx as never
  );
  assert.equal(sobreCruzado[0]?.ejecutada, true, "donde el daño ya está hecho, sí actúa");
  assert.deepEqual(frenados, ["cruzado.com"]);

  // Sin alcance declarado se mantiene el comportamiento previo (tests y dry-run).
  const sinAlcance = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "sano.com", motivo: "m" }],
    { dominiosConocidos: ["sano.com"], frenarDominio: async () => ({ antes: 10, despues: 0 }) } as never
  );
  assert.equal(sinAlcance[0]?.ejecutada, true);
});

test("cada acción deja su SUJETO, o la bitácora no sirve", async () => {
  // Sin `objetivo`, "frenar A" y "frenar B" colapsan en la misma entrada de la bitácora: `veces`
  // sube por acciones distintas y el veredicto se le aplica al dominio equivocado.
  const r = await ejecutarAcciones(
    [
      { accion: "frenar_dominio", dominio: "a.com", motivo: "m" },
      { accion: "frenar_dominio", dominio: "fantasma.com", motivo: "m" }
    ],
    { dominiosConocidos: ["a.com"], frenarDominio: async () => ({ antes: 5, despues: 0 }) } as never
  );
  assert.equal(r[0]?.objetivo, "a.com", "la ejecutada dice sobre qué");
  assert.equal(r[1]?.objetivo, "fantasma.com", "la RECHAZADA también: es la que más se repite");
});

test("si el JEFE lo ordena, el alcance del freno se relaja — pero solo ese", async () => {
  // El alcance existe para acotar al MODELO: que no decida frenar un dominio sano por su cuenta.
  // Si Juanes lo ordena por su canal privado, es su fábrica y su decisión; negarse sería tratarlo
  // como si fuera el modelo.
  const frenados: string[] = [];
  const base = {
    dominiosConocidos: ["sano.com"],
    frenablesConDanio: ["otro.com"],
    frenarDominio: async (d: string) => {
      frenados.push(d);
      return { antes: 40, despues: 0 };
    }
  };

  const porElModelo = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "sano.com", motivo: "m" }], base as never);
  assert.equal(porElModelo[0]?.ejecutada, false, "el modelo solo, no");

  const porElJefe = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "sano.com", motivo: "me lo pidió Juanes" }],
    { ...base, ordenadoPorElJefe: true } as never
  );
  assert.equal(porElJefe[0]?.ejecutada, true, "ordenado por el jefe, sí");
  assert.deepEqual(frenados, ["sano.com"]);
});

test("lo que NO se destraba ni con orden del jefe: un dominio que no existe", async () => {
  // El alcance es criterio; que el dominio EXISTA es un hecho. Una orden no puede crear un nodo.
  const r = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "fantasma.com", motivo: "dale" }],
    { dominiosConocidos: ["real.com"], ordenadoPorElJefe: true, frenarDominio: async () => ({ antes: 1, despues: 0 }) } as never
  );
  assert.equal(r[0]?.ejecutada, false);
  assert.match(r[0]?.detalle ?? "", /no está en el inventario/);
});
