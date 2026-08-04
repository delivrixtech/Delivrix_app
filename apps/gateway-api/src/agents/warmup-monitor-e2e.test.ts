// EXTREMO A EXTREMO del agente: hechos → modelo → verificación → gate de reparos → acciones.
//
// Los tests que había cubrían cada pieza por separado (verificarLectura por un lado,
// ejecutarAcciones por el otro) y ninguno el CAMINO: lo que el modelo escribe se parsea, se
// verifica, y recién entonces —si la verificación no encontró reparos— se ejecuta contra la flota.
// Ese camino es el que decide si sale un `ssh cap 0` a producción, y es el que no tenía guardia.
//
// OJO: el gate vive inline en `scripts/ops/warmup-monitor.ts` (no está exportado), así que acá se
// replica en `correrVuelta`. Mientras siga duplicado, este test protege el contrato pero no la
// línea real; el arreglo es exportar el gate del runner y llamarlo desde los dos lados.

import assert from "node:assert/strict";
import test from "node:test";

import { pedirLectura, type HechosWarmup } from "./warmup-monitor.ts";
import { ejecutarAcciones, extraerAcciones, type ContextoAcciones, type Pendiente, type ResultadoAccion } from "./acciones-agente.ts";

const HECHOS: HechosWarmup = {
  generadoEn: "2026-08-04T15:00:00.000Z",
  semillas: { destinos: 5, midiendo: 1, puntoCiego: ["outlook"] },
  vueltas: [
    { dominio: "corpfiling-infra.com", semilla: "s@gmail.com", cuando: "2026-08-04T10:00:00Z", placement: "INBOX", completa: true, error: null }
  ],
  cap: { consumidoHoy: 2, tope: 20, enElTope: [], sinLimite: 0 },
  flota: { sanas: 13, bloqueadas: 22, atascadas: 22, cruzados: ["bizreport-control.com"], cerca: [] },
  plan: [
    { dominio: "corpfiling-infra.com", diaN: 1, placementTasa: 0.75, placementMuestra: 4, cupo: 2, accion: "subir", motivo: "placement sano", enviadosHoy: 2 }
  ],
  rechazos: [{ origen: "freno_propio", cuantos: 6, explicacion: "es NUESTRO límite de Postfix", ejemplo: "450 daily send cap reached on this node" }]
};

/** Un modelo local de mentira que contesta lo que le digamos. */
function modeloQueDice(texto: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: texto } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

interface Efectos {
  frenados: string[];
  pausas: string[];
  pendientes: Pendiente[];
}

/**
 * El camino completo, tal como lo corre el runner: pide la lectura, y solo actúa si la
 * verificación no encontró reparos.
 */
async function correrVuelta(
  texto: string,
  hechos: HechosWarmup = HECHOS
): Promise<{ reparos: string[]; acciones: ResultadoAccion[]; efectos: Efectos }> {
  const efectos: Efectos = { frenados: [], pausas: [], pendientes: [] };
  const lectura = await pedirLectura({
    hechos,
    baseUrl: "http://mini.local/v1",
    modelo: "qwen-de-mentira",
    fetchImpl: modeloQueDice(texto)
  });
  assert.equal(lectura.lectura, texto, "la lectura tiene que llegar tal cual la escribió el modelo");

  const reparos = lectura.verificacion?.reparos ?? [];
  const ctx: ContextoAcciones = {
    dominiosConocidos: [
      ...new Set([
        ...(hechos.plan ?? []).map((p) => p.dominio),
        ...hechos.vueltas.map((v) => v.dominio),
        ...(hechos.flota?.cruzados ?? []),
        ...(hechos.flota?.cerca ?? []),
        ...(hechos.cap?.enElTope ?? [])
      ])
    ],
    frenarDominio: async (d) => {
      efectos.frenados.push(d);
      return { antes: 20, despues: 0 };
    },
    pausarWarmup: async (m) => {
      efectos.pausas.push(m);
    },
    warmupPausado: async () => efectos.pausas.length > 0,
    pendientes: {
      listar: async () => efectos.pendientes,
      guardar: async (p) => {
        efectos.pendientes = p;
      }
    }
  };

  const acciones = reparos.length === 0 ? await ejecutarAcciones(extraerAcciones(lectura.lectura ?? ""), ctx) : [];
  return { reparos, acciones, efectos };
}

test("e2e: lectura sana + frenar un dominio que los datos dicen que cruzó ⇒ se ejecuta", async () => {
  const { reparos, acciones, efectos } = await correrVuelta(
    [
      "AHORA: un dominio cruzó el umbral permanente y sigue en el pool.",
      "PORQUE: bizreport-control.com figura entre los que cruzaron.",
      "RIESGO: se le sigue gastando reputación a un dominio que ya no se recupera.",
      "FALTA: nada",
      "ACCION: frenar_dominio | dominio=bizreport-control.com | motivo=cruzó el umbral permanente"
    ].join("\n")
  );
  assert.deepEqual(reparos, []);
  assert.deepEqual(efectos.frenados, ["bizreport-control.com"]);
  assert.equal(acciones[0]?.ejecutada, true);
});

test("e2e: si la verificación encuentra UN reparo, NO se ejecuta ninguna acción", async () => {
  // El error real del 2026-08-04: le atribuye a Gmail nuestro propio cap de Postfix.
  const { reparos, acciones, efectos } = await correrVuelta(
    [
      "AHORA: está bloqueado por los límites diarios de Gmail.",
      "PORQUE: 6 rechazos.",
      "RIESGO: ninguno",
      "FALTA: nada",
      "ACCION: frenar_dominio | dominio=corpfiling-infra.com | motivo=bloqueado"
    ].join("\n")
  );
  assert.ok(reparos.length > 0, "tiene que haber al menos un reparo");
  assert.deepEqual(acciones, [], "con reparos no se ejecuta nada");
  assert.deepEqual(efectos.frenados, [], "y sobre todo: no se toca la flota");
});

test("e2e: un dominio que NO está en los hechos no llega a la flota", async () => {
  const { acciones, efectos } = await correrVuelta(
    [
      "AHORA: todo normal.",
      "PORQUE: 2 de 2 enviados.",
      "RIESGO: ninguno",
      "FALTA: nada",
      "ACCION: frenar_dominio | dominio=no-existe-en-los-hechos.com | motivo=me parece"
    ].join("\n")
  );
  // El nombre inventado dispara DOS barreras: la verificación lo marca (y ahí ya no se ejecuta
  // nada) y, si pasara, el inventario lo rechaza. Lo que importa es que la flota queda intacta.
  assert.deepEqual(efectos.frenados, []);
  assert.ok(acciones.every((a) => !a.ejecutada));
});

test("e2e: sin motivo no se ejecuta, aunque la lectura esté limpia", async () => {
  const { reparos, efectos } = await correrVuelta(
    [
      "AHORA: un dominio cruzó el umbral.",
      "PORQUE: bizreport-control.com figura entre los que cruzaron.",
      "RIESGO: reputación perdida.",
      "FALTA: nada",
      "ACCION: frenar_dominio | dominio=bizreport-control.com"
    ].join("\n")
  );
  assert.deepEqual(reparos, []);
  assert.deepEqual(efectos.frenados, []);
});

test("e2e: el mismo pendiente dos vueltas seguidas se anota UNA vez", async () => {
  const texto = [
    "AHORA: no hay semilla en Outlook.",
    "PORQUE: el punto ciego declara outlook.",
    "RIESGO: no sabemos dónde cae nuestro correo ahí.",
    "FALTA: una semilla de Outlook",
    "ACCION: anotar_pendiente | dominio=semilla de outlook | motivo=punto ciego declarado"
  ].join("\n");
  const uno = await correrVuelta(texto);
  assert.equal(uno.efectos.pendientes.length, 1);
  // Segunda vuelta con la MISMA lista ya cargada.
  const efectos = uno.efectos;
  const acciones = await ejecutarAcciones(extraerAcciones(texto), {
    dominiosConocidos: ["corpfiling-infra.com"],
    pendientes: {
      listar: async () => efectos.pendientes,
      guardar: async (p) => {
        efectos.pendientes = p;
      }
    }
  });
  assert.equal(efectos.pendientes.length, 1, "no se crea un pendiente nuevo");
  assert.equal(efectos.pendientes[0]?.visto, 2);
  assert.equal(acciones[0]?.ejecutada, false);
});

test("e2e: si la mini no contesta, no hay lectura y no se ejecuta nada", async () => {
  const lectura = await pedirLectura({
    hechos: HECHOS,
    baseUrl: "http://mini.local/v1",
    modelo: "qwen-de-mentira",
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch
  });
  assert.equal(lectura.lectura, null);
  assert.match(lectura.motivo ?? "", /no se pudo consultar el modelo local/);
  assert.equal(lectura.verificacion, undefined);
  // Los hechos viajan igual: el panel tiene que poder decir sobre qué NO se pudo opinar.
  assert.equal(lectura.hechos, HECHOS);
});
