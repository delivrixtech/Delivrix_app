// Tests del plan del día. Lo que protegen es la ASIMETRÍA que costó un bug: una medición vencida
// sirve para elegir a quién intentarle, pero NO para decidir cuánto mandar. Tratar los dos casos
// igual hizo que el daemon se apagara solo teniendo un nodo con cupo, y en la versión anterior que
// decidiera volumen sobre un cap 2000 que ya no existía.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decidirCupoDeHoy,
  rampaDesdeEnv,
  RAMPA_LIMITE_DIARIO_DEFAULT,
  RAMPA_PASO_POR_DIA_DEFAULT
} from "../domain/decision-diaria.ts";
import {
  cupoAutorizadoVigente,
  elegirPool,
  PICO_QUE_YA_NO_ES_NUEVO,
  enviosDelDia,
  flotaAtribuida,
  leerCuposFisicos,
  leerReputacion,
  placementsDeDominio,
  ultimoAutorizado,
  planDelDia,
  type MedicionCupos,
  type SaludDominio
} from "./plan-diario.ts";
// El OTRO lector de la misma ventana. Se importa acá a propósito: la regla vive duplicada en dos
// SQL, y un test por archivo nunca ve que sólo uno la cumple.
import { recentPlacements } from "./live-warmup-daemon.ts";

const AHORA = new Date("2026-08-04T15:00:00.000Z");

function archivoCap(medidoEn: string, nodos: Array<{ domain: string; cap: number | null }>): string {
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  const ruta = join(dir, "sender-cap.json");
  writeFileSync(ruta, JSON.stringify({ medidoEn, nodos }));
  return ruta;
}

const medicion = (over: Partial<MedicionCupos> = {}): MedicionCupos => ({
  porDominio: new Map([["a.com", 20], ["b.com", 0]]),
  vencida: false,
  medidoEn: AHORA.toISOString(),
  edadHoras: 0,
  ...over
});

// ── Lectura del archivo ──────────────────────────────────────────────────────────────────────────

test("medición fresca: no vencida, con edad", async () => {
  const r = await leerCuposFisicos(archivoCap("2026-08-04T14:00:00.000Z", [{ domain: "a.com", cap: 20 }]), AHORA);
  assert.equal(r.vencida, false);
  assert.equal(r.edadHoras, 1);
  assert.equal(r.porDominio.get("a.com"), 20);
});

test("medición vieja: VENCIDA pero los datos se devuelven igual", async () => {
  // Vaciarla al vencer perdía información que sí sirve para elegir a quién intentarle.
  const r = await leerCuposFisicos(archivoCap("2026-08-04T00:00:00.000Z", [{ domain: "a.com", cap: 20 }]), AHORA);
  assert.equal(r.vencida, true);
  assert.equal(r.edadHoras, 15);
  assert.equal(r.porDominio.get("a.com"), 20, "el dato viejo sigue disponible, marcado como viejo");
});

test("archivo inexistente o roto: vencida, sin datos, sin explotar", async () => {
  const r = await leerCuposFisicos("/no/existe/sender-cap.json", AHORA);
  assert.equal(r.vencida, true);
  assert.equal(r.porDominio.size, 0);
  assert.equal(r.medidoEn, null);
});

test("medidoEn ilegible NO se toma como fresca", async () => {
  const r = await leerCuposFisicos(archivoCap("mañana a la tarde", [{ domain: "a.com", cap: 20 }]), AHORA);
  assert.equal(r.vencida, true);
  assert.equal(r.edadHoras, null);
});

test("un cap null no se cuela como 0 ni como número", async () => {
  const r = await leerCuposFisicos(archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: null }]), AHORA);
  assert.equal(r.porDominio.has("a.com"), false, "sin dato es AUSENTE, no 0");
});

// ── Pool ─────────────────────────────────────────────────────────────────────────────────────────

test("el pool son los nodos con cupo > 0", () => {
  const r = elegirPool(medicion(), ["configurado.com"]);
  assert.deepEqual(r.boxes, ["a.com"]);
});

test("medición VENCIDA: igual sirve para el pool, y se declara la antigüedad", () => {
  // La asimetría: lo peor que puede pasar es un rebote, que el daemon ya saltea solo.
  const r = elegirPool(medicion({ vencida: true, edadHoras: 14 }), ["configurado.com"]);
  assert.deepEqual(r.boxes, ["a.com"], "NO cae al pool configurado teniendo un dato usable");
  assert.match(r.motivo, /14h, VENCIDA/);
});

test("sin ninguna medición cae al configurado, diciendo que nadie lo verificó", () => {
  const r = elegirPool(medicion({ porDominio: new Map(), vencida: true }), ["configurado.com"]);
  assert.deepEqual(r.boxes, ["configurado.com"]);
  assert.match(r.motivo, /nadie verificó/);
});

test("sin sender-cap.json el filtro de SALUD se aplica igual: no entran los quemados ni los cerrados", () => {
  // EL RETURN TEMPRANO ESTABA ARRIBA DEL FILTRO. `leerCuposFisicos` tiene un catch que traga todo y
  // devuelve el mapa vacío, así que un sender-cap.json ilegible metía al pool a los quemados, a los
  // cerrados por el receptor y a los de cola atascada — los CUATRO entraban. Y encima con
  // `vencida: true` el `cupoFisico` viaja en null, o sea que la rampa gobierna sola y sin la pared
  // del nodo: hasta hoy eso topaba en 40/día por el default, pero con WARMUP_RAMPA_LIMITE_DIARIO
  // configurable pasa a ser lo que el operador escriba.
  //
  // Son DOS archivos distintos: no poder leer el CUPO no borra la medición de SALUD. Lo único que
  // se pierde es cuánto manda cada uno, no cuáles no pueden mandar.
  const r = elegirPool(
    medicion({ porDominio: new Map(), vencida: true, medidoEn: null, edadHoras: null }),
    ["quemado.com", "cerrado.com", "atascado.com", "sano.com"],
    salud({
      "quemado.com": { estado: "healthy", cruzados: ["gmail"], entregados: 5 },
      "cerrado.com": { estado: "blocked_by_provider", entregados: 0 },
      "atascado.com": { estado: "stalled", entregados: 0 },
      "sano.com": { estado: "healthy", entregados: 5 }
    })
  );
  assert.deepEqual(r.boxes, ["sano.com"]);
  assert.match(r.motivo, /quemado\.com \(cruzó el umbral permanente\)/);
  assert.match(r.motivo, /SIN ninguna medición del cupo/, "y sigue declarando que nadie verificó el volumen");
});

test("flota entera en cap 0: pool VACÍO, no un fallback que rebote 58 veces", () => {
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 0], ["b.com", 0]]) }), ["configurado.com"]);
  assert.deepEqual(r.boxes, []);
  // El texto cambió al agregarse la exclusión por salud: ahora distingue "todos en cap 0" de
  // "tienen cupo pero no sirven". Los dos casos terminan en pool vacío, y el motivo dice cuál es.
  assert.match(r.motivo, /están todos en cap 0/);
});

// ── El plan completo ─────────────────────────────────────────────────────────────────────────────

/** Postgres falso: responde por la forma de la consulta. */
function pgFalso(filas: {
  medidos?: string[];
  /** La semilla que midió. De ella sale el PROVEEDOR de la cifra: sin esto, `placement 70%` a secas. */
  semilla?: string;
  enviadosHoy?: number;
  hace2Dias?: number;
  /** El cupo AUTORIZADO de hace 2 días (`detail.cupoDelDia`). Es OTRA cosa que `hace2Dias`. */
  cupoAutorizadoHace2Dias?: number;
  historial?: string[];
  rebotes?: string[];
}) {
  return {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("kind = 'measured'")) {
        return { rows: (filas.medidos ?? []).map((placement) => ({ placement, seed_inbox: filas.semilla ?? "" })) };
      }
      // El lector del cupo AUTORIZADO va ANTES del de envíos: los dos filtran `kind = 'sent'` y sólo
      // se distinguen por el campo. Es exactamente la confusión que dejó al clamp sin entrada.
      if (sql.includes("cupoDelDia")) {
        return { rows: [{ node_domain: "a.com", cupo: filas.cupoAutorizadoHace2Dias ?? 0 }] };
      }
      // `enviosDelDia` lleva el día en el parámetro: 0 = hoy, 2 = anteayer. Distinguirlos acá es lo
      // que hace que el test pueda probar el clamp de 48h por separado del cupo del día.
      if (sql.includes("COUNT(*)::int")) {
        const n = params?.[0] === 2 ? filas.hace2Dias ?? 0 : filas.enviadosHoy ?? 0;
        return { rows: [{ node_domain: "a.com", n }] };
      }
      if (sql.includes("kind = 'error'")) return { rows: (filas.rebotes ?? []).map((d) => ({ node_domain: d })) };
      if (sql.includes("seed_inbox, occurred_at")) {
        return { rows: (filas.historial ?? []).map((cuando) => ({ node_domain: "a.com", seed_inbox: "s@x.com", occurred_at: new Date(cuando) })) };
      }
      return { rows: [] };
    }
  } as never;
}

test("NINGUNA ventana de placement cuenta los turnos de continuación de hilo — las DOS", async () => {
  // EL DEFECTO QUE ESTE TEST IMPIDE: desde que `medirTurnoDeHilo` graba `kind:'measured'`, las
  // respuestas dentro de un hilo ya establecido entraban en las ventanas de placement. Un "Re:" es
  // una clase de correo mucho más fácil de entregar: la tasa se sesga hacia arriba, y esa tasa es lo
  // único entre la flota y el umbral permanente de Gmail. Encima, con un turno por vuelta y LIMIT 6,
  // seis continuaciones barren toda la medición del ciclo principal.
  //
  // SE RECORREN LOS DOS LECTORES EN EL MISMO TEST, y ése es el punto. La cláusula se agregó sólo en
  // `placementsDeDominio` (el que nombraba el ticket) y quedó afuera de `recentPlacements` — que es
  // el que alimenta `placement-pause`, el ÚNICO corte que apaga los 58 nodos de golpe. Con la
  // ventana global sesgada hacia arriba, el freno de catástrofe se abre solo: medido con
  // `decideDaemonAction` real, 3 dominios × 4 mediciones frías al 25% dan `placement-pause`, y
  // sumando 3 continuaciones en INBOX por dominio la misma llamada devuelve `send` ("inbox 57%").
  // El defecto de fondo es que la regla vive duplicada en dos SQL: un test por lector no lo ve.
  const espiar = async (correr: (pg: never) => Promise<unknown>): Promise<string> => {
    let sql = "";
    const pg = {
      async query(q: string) {
        if (q.includes("kind = 'measured'")) sql = q;
        return { rows: [] };
      }
    } as never;
    await correr(pg);
    return sql;
  };

  const lectores: Array<[string, (pg: never) => Promise<unknown>]> = [
    ["placementsDeDominio (la rampa por dominio)", (pg) => placementsDeDominio(pg, "a.com", 6)],
    ["recentPlacements (el gate GLOBAL que apaga la flota)", (pg) => recentPlacements(pg, 6)]
  ];

  for (const [quien, correr] of lectores) {
    const sql = await espiar(correr);
    assert.match(sql, /origen/, `${quien}: la ventana tiene que filtrar por el origen de la fila`);
    assert.match(
      sql,
      /IS DISTINCT FROM 'continuación de hilo'/,
      `${quien}: IS DISTINCT FROM y no <>, porque las filas del ciclo principal no traen \`origen\` y \`NULL <> 'x'\` las descartaría a todas`
    );
  }
});

test("el plan cuenta el mismo cuento que el daemon: día, placement, cupo y decisión", async () => {
  const plan = await planDelDia({
    pg: pgFalso({
      medidos: ["INBOX", "INBOX", "INBOX", "SPAM"],
      enviadosHoy: 1,
      historial: ["2026-08-02T10:00:00Z", "2026-08-03T10:00:00Z"]
    }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  });
  const d = plan.dominios[0]!;
  assert.equal(d.dominio, "a.com");
  assert.equal(d.diaN, 3, "día 3 desde el primer envío");
  assert.equal(d.placement.tasa, 0.75);
  assert.equal(d.placement.muestra, 4);
  assert.equal(d.enviadosHoy, 1);
  assert.equal(d.cupoFisico, 20);
  // "sostener" y no "subir": 3 de 4 es 75% crudo pero su piso de Wilson es 30%, y la rampa avanza
  // con evidencia. El panel dice EXACTAMENTE lo que el daemon va a ejecutar, que es el punto de
  // que las dos mitades llamen a la misma función.
  assert.equal(d.decision.accion, "sostener");
});

test("las palancas de la rampa: el plan y el daemon dan EL MISMO número", async () => {
  // LA DIVERGENCIA QUE ESTO CIERRA: `decidirCupoDeHoy` acepta `limiteDiario`/`pasoPorDia` desde el
  // primer día; el daemon las pasaba (live-warmup-daemon.ts:1076 y :1238) y `planDelDia` no, así
  // que se quedaba con los `?? 40` y `?? 2` de adentro. Hoy no se nota porque las env vars están
  // ausentes — y el mismo lote que dejó la divergencia SHIPEÓ la palanca que la abre. El día que
  // alguien escriba WARMUP_RAMPA_LIMITE_DIARIO=200 en gateway.env, el daemon manda hasta 200/día
  // por dominio y /v1/warmup/plan (el panel) y `hechos.plan` (lo que el agente le REPORTA al jefe
  // por Slack) siguen diciendo 40. No es cosmético: es el único número por el que el operador se
  // entera de cuánto sale, y el agente lo afirmaría con seguridad estando mal.
  const env = { WARMUP_RAMPA_LIMITE_DIARIO: "200", WARMUP_RAMPA_PASO_POR_DIA: "50" };
  const args = {
    // 12 mediciones limpias: hacen falta para que la rampa AVANCE (Wilson asimétrico). Con 4, la
    // decisión es "sostener" y las dos palancas dan el mismo 2 — el test no probaría nada.
    // `cupoAutorizadoHace2Dias` alto a propósito: el clamp 3×/48h es FAIL-CLOSED (sin ese dato
    // asume `CUPO_ARRANQUE` y topa todo en 6/día), así que sin esta línea las dos palancas darían
    // 6 y 6 y el test volvería a no probar nada — la misma trampa que el comentario de arriba.
    pg: pgFalso({
      medidos: Array.from({ length: 12 }, () => "INBOX"),
      historial: ["2026-08-02T10:00:00Z", "2026-08-03T10:00:00Z"],
      cupoAutorizadoHace2Dias: 200
    }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 2000 }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  };
  const conPalanca = await planDelDia({ ...args, env });
  const sinPalanca = await planDelDia({ ...args, env: {} });

  // El número que el daemon calcularía para el mismo dominio, con la MISMA función.
  const d = conPalanca.dominios[0]!;
  const delDaemon = decidirCupoDeHoy({
    diaN: d.diaN ?? 0,
    placements: Array.from({ length: 12 }, () => "INBOX" as const),
    cupoFisico: d.cupoFisico,
    // El daemon pasa el MISMO `cupoHace2Dias` que el plan (lo lee de la misma consulta): sin esta
    // línea el test compararía dos cuentas distintas y volvería a tapar la divergencia que existe
    // para cazar.
    cupoHace2Dias: 0,
    // Y el MISMO cupo autorizado, por lo mismo: es entrada del clamp y mueve el número.
    cupoAutorizadoHace2Dias: 200,
    isoWeekday: 2, // 2026-08-04 es martes
    ...rampaDesdeEnv(env)
  });
  assert.equal(d.decision.cupo, delDaemon.cupo, "el panel y el daemon no pueden decir números distintos");
  assert.notEqual(d.decision.cupo, sinPalanca.dominios[0]!.decision.cupo, "y la palanca tiene que mover algo, si no el test no prueba nada");
});

test("con la medición VENCIDA el plan decide con cupo desconocido, no con el número viejo", async () => {
  // Es la mitad peligrosa de la asimetría: decidir volumen sobre un cap que ya no existe.
  const plan = await planDelDia({
    pg: pgFalso({ medidos: ["INBOX", "INBOX", "INBOX", "INBOX"], historial: ["2026-08-03T10:00:00Z"] }),
    capFile: archivoCap("2026-08-03T00:00:00.000Z", [{ domain: "a.com", cap: 2000 }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  });
  assert.equal(plan.medicionCupo.vencida, true);
  assert.deepEqual(plan.pool.boxes, ["a.com"], "para el pool sí se usa");
  assert.equal(plan.dominios[0]!.cupoFisico, null, "para el volumen NO");
  assert.match(plan.dominios[0]!.decision.motivo, /desconocido/);
});

test("sin muestra, la tasa es null y NO 0% (que se leería como 'todo va a spam')", async () => {
  const plan = await planDelDia({
    pg: pgFalso({ medidos: [] }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  });
  assert.equal(plan.dominios[0]!.placement.tasa, null);
  assert.equal(plan.dominios[0]!.placement.muestra, 0);
});

test("un nodo que rebotó hoy queda marcado", async () => {
  const plan = await planDelDia({
    pg: pgFalso({ rebotes: ["a.com"], medidos: ["INBOX"] }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  });
  assert.equal(plan.dominios[0]!.rebotoHoy, true);
});

// ── Sacar del pool lo que no se puede calentar ───────────────────────────────────────────────────
// El 2026-08-04, 46 nodos pasaron de cap 0 a tener cupo. De esos, 22 estaban CERRADOS POR EL
// RECEPTOR, 22 con la COLA ATASCADA y uno había CRUZADO el umbral permanente. Con el pool filtrando
// solo por "cap > 0", el daemon habría gastado su presupuesto diario en 44 dominios que no entregan.

// `entregados` entró con la ventana acotada: es la señal positiva reciente sin la cual un dominio no
// es "sano" sino "no sé". Los casos viejos no lo declaran a propósito — así este mismo helper prueba
// que un archivo de una medición anterior, sin el campo, tampoco alcanza para entrar.
const salud = (m: Record<string, SaludDominio>) =>
  new Map(Object.entries(m));

/**
 * Reputación CONSULTADA y limpia para cada dominio nombrado.
 *
 * Hace falta desde que la puerta de `no_traffic` exige que la IP del dominio virgen figure
 * consultada en listas negras: `listas: []` es "se preguntó y está limpio", que es lo que estos
 * tests dan por sentado cuando prueban OTRA cosa. El caso de `"no-se"` tiene su test propio.
 */
const authConsultada = (...dominios: string[]) =>
  new Map(dominios.map((d) => [d, { listas: [] as string[] }]));

test("un dominio que CRUZÓ el umbral permanente sale del pool: calentarlo no lo recupera", () => {
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["b.com", 20]]) }), [], salud({
    // El control sano declara `entregados`: desde que el pool exige una señal positiva reciente, un
    // "healthy" sin una sola entrega leída tampoco entra, y sin esto el test probaría otra cosa.
    "a.com": { estado: "healthy", entregados: 12 },
    "b.com": { estado: "healthy", cruzados: ["gmail"] }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
  assert.match(r.motivo, /b\.com \(cruzó el umbral permanente\)/);
});

test("un dominio CERRADO POR EL RECEPTOR sale: no se puede calentar lo que no llega", () => {
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["b.com", 20]]) }), [], salud({
    // El control sano declara `entregados`: desde que el pool exige una señal positiva reciente, un
    // "healthy" sin una sola entrega leída tampoco entra, y sin esto el test probaría otra cosa.
    "a.com": { estado: "healthy", entregados: 12 },
    "b.com": { estado: "blocked_by_provider" }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
});

test("un dominio con la COLA ATASCADA sale: el correo no sale del nodo", () => {
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["b.com", 20]]) }), [], salud({
    // El control sano declara `entregados`: desde que el pool exige una señal positiva reciente, un
    // "healthy" sin una sola entrega leída tampoco entra, y sin esto el test probaría otra cosa.
    "a.com": { estado: "healthy", entregados: 12 },
    "b.com": { estado: "stalled" }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
});

test("SIN medición del dominio NO entra: el pool no se llena con 'no sé'", () => {
  // Este test decía lo contrario, y el razonamiento era: "excluir por falta de dato apagaría el
  // warmup entero el día que la medición falte, y el costo de incluir uno de más está acotado
  // porque rebota y el daemon lo saltea solo".
  //
  // Se invirtió, y el incidente original sigue cubierto por otro camino: si el archivo entero no se
  // puede leer, `leerSalud` devuelve undefined, no se aplica ningún filtro y el pool sale solo del
  // cupo — es el test de acá abajo, "sin archivo de salud el pool funciona igual que antes". Lo que
  // cambia es solo el dominio AUSENTE de un archivo que SÍ se leyó, y ese caso no es "sano".
  //
  // El costo tampoco estaba tan acotado: un rebote gasta una vuelta del presupuesto diario del
  // daemon, que es global para toda la flota.
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["sin-medir.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 12 }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
  assert.match(r.motivo, /sin-medir\.com \(sin medición: no sé si entrega\)/);
});

test("un dominio RECIÉN COMPRADO puede entrar al pool, o la fábrica no fabrica", () => {
  // EL DEFECTO QUE ESTE TEST PREVIENE (2026-08-06, encontrado por QA antes del merge):
  //
  // `no_traffic` excluía del pool, y un nodo recién provisionado tiene el mail.log vacío ⇒ totales
  // 0/0/0 ⇒ `no_traffic` ⇒ excluido ⇒ nunca manda ⇒ sigue en `no_traffic`. Trampa cerrada, y en
  // silencio: el dominio no aparecía en el pool y no saltaba ninguna alerta, solo una línea en el
  // motivo del daemon. Para una empresa cuyo producto ES una fábrica de dominios, eso rompe el
  // onboarding entero. Y es la MISMA FORMA del bug que este ticket vino a matar ("un nodo que se
  // destrabó hace días queda condenado para siempre"), corrida de eje.
  //
  // El segundo camino a la misma trampa ya estaba vivo en producción: cualquier dominio que quede
  // fuera del pool más días que la ventana (cap 0, una medición fallida, un fin de semana flojo)
  // pierde sus entregas, cae en `no_traffic` y se vuelve inelegible para siempre.
  // controlnationalcorp.com estaba exactamente ahí el día de la medición.
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["dominio-nuevo.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 12 },
    "dominio-nuevo.com": { estado: "no_traffic", entregados: 0 }
  }), authConsultada("dominio-nuevo.com"));
  assert.deepEqual(r.boxes, ["a.com", "dominio-nuevo.com"]);
  // Y se DECLARA que entra sin señal positiva: el daemon reparte una vuelta por dominio, así que un
  // pool lleno de nodos que nunca mandaron le saca presupuesto a los que calientan bien. Sin el
  // número en la misma línea, "el pool creció" se lee como buena noticia.
  assert.match(r.motivo, /1 sin tráfico todavía, entran a arrancar: dominio-nuevo\.com/);
});

test("`no_traffic` NO tapa las cuatro razones reales para no calentar", () => {
  // La contracara del test de arriba: dejar entrar al nodo nuevo no puede abrir la puerta al roto.
  // Ninguno de estos cuatro depende de que el nodo haya mandado algo en la ventana — `cruzados` es
  // pegajoso a propósito (cruzar el umbral permanente de Google es irreversible y sender-measurement
  // lo arrastra de la medición anterior), y cerrado/atascado/ilegible son estados, no ausencias.
  const r = elegirPool(
    medicion({ porDominio: new Map([["cruzado.com", 20], ["cerrado.com", 20], ["atascado.com", 20], ["ciego.com", 20]]) }),
    [],
    salud({
      // El caso filoso: cruzó el umbral Y no tiene tráfico. Si `no_traffic` se evaluara primero,
      // entraría al pool un dominio quemado para siempre.
      "cruzado.com": { estado: "no_traffic", cruzados: ["gmail"], entregados: 0 },
      "cerrado.com": { estado: "blocked_by_provider", entregados: 0 },
      "atascado.com": { estado: "stalled", entregados: 0 },
      // `unreadable` es lo que devuelve el sensor cuando el nodo escribe la fecha en un formato que
      // no entiende: da 0/0/0 igual que un nodo nuevo, y NO puede confundirse con uno.
      "ciego.com": { estado: "unreadable", entregados: null }
    })
  );
  assert.deepEqual(r.boxes, []);
  assert.match(r.motivo, /cruzado\.com \(cruzó el umbral permanente\)/);
  assert.match(r.motivo, /ciego\.com \(sin lectura de entregas: no sé\)/);
});

test("'healthy' con CERO entregas en la ventana NO entra: sin señal positiva es 'no sé'", () => {
  // Con la ventana acotada, `healthy` dejó de significar "entrega bien" y pasó a significar "no
  // encontré nada malo en N días" — y para un nodo que no mandó casi nada, eso es no haber medido.
  // Un nodo sin UNA sola entrega reciente no está probado como sano.
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["b.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 12 },
    "b.com": { estado: "healthy", entregados: 0 }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
  assert.match(r.motivo, /b\.com \(ninguna entrega en la ventana\)/);
});

test("'healthy' con entregas ILEGIBLES (null) NO entra, y el motivo lo distingue de cero", () => {
  // Hoy un nodo cuyo log no se pudo leer entra al pool. Va separado del caso de arriba a propósito:
  // lo que lee el operador es distinto y la acción también — "ninguna entrega" se arregla mandando,
  // "sin lectura" se arregla arreglando el acceso al log (es el mail.log syslog:adm que necesita
  // sudo, el mismo agujero que dejó al sensor mirando donde no había nada).
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["b.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 12 },
    "b.com": { estado: "healthy", entregados: null }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
  assert.match(r.motivo, /b\.com \(sin lectura de entregas: no sé\)/);
});

test("con al menos una entrega en la ventana SÍ entra, y los excluidos se DECLARAN", () => {
  // Un pool que se achica en silencio hace creer al operador que hay menos nodos con cupo de los que
  // hay y esconde justo el problema que hay que resolver: es lo que pasó el 2026-08-04 con los 46
  // nodos que pasaron de cap 0 a tener cupo.
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["b.com", 20], ["c.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 3 },
    "b.com": { estado: "healthy", entregados: 39 },
    "c.com": { estado: "healthy", entregados: 0 }
  }));
  assert.deepEqual(r.boxes, ["a.com", "b.com"]);
  assert.match(r.motivo, /2 de 3 nodos medidos aptos/);
  assert.match(r.motivo, /1 fuera: c\.com \(ninguna entrega en la ventana\)/);
});

test("sin archivo de salud el pool funciona igual que antes", () => {
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["b.com", 20]]) }), []);
  assert.deepEqual(r.boxes, ["a.com", "b.com"]);
});

test("si TODOS quedan excluidos, el pool es vacío y DICE por qué", () => {
  // Vacío mudo haría creer que no hay nodos con cupo, cuando el problema es otro y es el que hay
  // que resolver.
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["b.com", 20]]) }), [], salud({
    "a.com": { estado: "blocked_by_provider" },
    "b.com": { estado: "stalled" }
  }));
  assert.deepEqual(r.boxes, []);
  assert.match(r.motivo, /2 fuera/);
  assert.match(r.motivo, /cerrado por el receptor|cola atascada/);
});

// ── Un estado que este pool no conoce no puede nacer ADENTRO ────────────────────────────────────
//
// Todo el filtro de arriba es lista NEGRA: nombra `blocked_by_provider`, `stalled` y `no_traffic`, y
// lo que no coincide con ninguno llega al `return null` y entra. `SaludDominio.estado` es `string`,
// ni siquiera la unión, así que agregarle un estado al sensor no rompe la compilación de este
// archivo. Ya pasó con `no_own_traffic` (2026-08-06). Estos tres tests protegen al estado que
// TODAVÍA NO EXISTE, que es de lo que este bug es una instancia.

test("el caso annualcorp-control.com: cuando el sensor deje de decir 'healthy', el nodo no entra al pool", () => {
  // LOS NÚMEROS SON REALES Y ESTÁN COPIADOS, no inventados: es la fila tal cual está hoy en
  // /Users/Shared/delivrix/runtime/openclaw-workspace/inventory/sender-measurement.json de la
  // Studio, medición del 2026-08-08T02:08:43.786Z, leída en solo lectura para este ticket:
  // `estado: "healthy"`, `entregados: 16`, `rechazados: 1`, `porReceptor: []`, `cerradoEn: []`.
  //
  // El nodo es 80.190.76.57. A las 20:05 UTC del 7-ago el sensor lo vio 165/136 y dijo
  // `blocked_by_provider`; tres horas después la ventana de 5 días soltó el 3 de agosto —la ráfaga,
  // 149 entregados y 135 rechazos— y quedaron 16/1. Con 17 intentos, debajo de
  // BLOCKED_MIN_ATTEMPTS=20, el sensor NO emite veredicto y la ausencia sale `healthy`. 134 de esos
  // 136 rechazos decían "Gmail has detected that this message is likely suspicious due to the very
  // low reputation of the sending domain", y los 16 "entregados" son 16 de 16 al pipe local de
  // rebotes: entregas a un tercero, CERO.
  //
  // Por qué el pool NO lo tapa hoy: `cerradoEn` está vacío (nunca hubo corrida que lo pegara con el
  // nodo dentro de la ventana), `entregados` es 16 ⇒ pasa MIN_ENTREGAS_EN_VENTANA, y el guard de
  // auto-entrega se queda ciego porque `porReceptor` viene vacío — el escritor lo filtra con los
  // mismos 20 intentos. Tres redes y las tres agujereadas por el mismo número.
  //
  // Este test no arregla el sensor —es otro lote— pero fija el cable: el día que el veredicto sea
  // "no sé" en vez de "sano", acá ya está cerrado.
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["annualcorp-control.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 12 },
    "annualcorp-control.com": { estado: "insufficient_sample", entregados: 16, porReceptor: [], cerradoEn: [] }
  }));
  assert.deepEqual(r.boxes, ["a.com"], "un veredicto que este pool no sabe leer no calienta");
  assert.match(r.motivo, /annualcorp-control\.com \(estado `insufficient_sample`/);
  assert.doesNotMatch(r.motivo, /entran a arrancar/, "tampoco puede colarse como dominio nuevo");
});

test("cualquier estado desconocido queda afuera, no solo el que ya sabemos que viene", () => {
  // El de arriba usa el nombre que se espera del próximo lote; éste usa uno que nadie va a escribir
  // nunca, y uno vacío. Es la única forma de chequear la lista blanca para lo que no existe todavía.
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["raro.com", 20], ["mudo.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 12 },
    "raro.com": { estado: "lo_que_venga", entregados: 12 },
    // Una medición de una versión que no escribía `estado`. Sin estado no hay veredicto que leer.
    "mudo.com": { entregados: 12 }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
  assert.match(r.motivo, /raro\.com \(estado `lo_que_venga`/);
  assert.match(r.motivo, /mudo\.com \(estado `sin estado`/);
});

test("la lista blanca NO es un candado: el dominio nuevo y el degradado siguen entrando", () => {
  // LA CONTRACARA, y pesa igual que lo de arriba: un sensor que bloquea todo es tan inútil como uno
  // que no bloquea nada. Cerrar la puerta al estado desconocido no puede cerrarle la puerta a la
  // fábrica — `no_traffic` es exactamente el mail.log vacío de un dominio recién comprado, y si eso
  // quedara afuera la trampa se cierra sola: no entra ⇒ no manda ⇒ sigue en `no_traffic`.
  //
  // `degraded` también sigue entrando, y es deliberado: rechazo parcial es una señal para bajar el
  // volumen, no para dejar de calentar. Cambiarlo es una decisión de producto, no un efecto lateral
  // de este guard.
  //
  // Y la exclusión de arriba NO deja marca: no escribe `cerradoEn` ni ningún arrastre, así que el
  // barrido siguiente recalcula el estado y el dominio vuelve solo. Es "hoy no", nunca "nunca más".
  const r = elegirPool(
    medicion({ porDominio: new Map([["dominio-nuevo.com", 20], ["degradado.com", 20], ["sano.com", 20]]) }),
    [],
    salud({
      "dominio-nuevo.com": { estado: "no_traffic", entregados: 0 },
      "degradado.com": { estado: "degraded", entregados: 7 },
      "sano.com": { estado: "healthy", entregados: 12 }
    }),
    authConsultada("dominio-nuevo.com")
  );
  assert.deepEqual([...r.boxes].sort(), ["degradado.com", "dominio-nuevo.com", "sano.com"]);
  assert.doesNotMatch(r.motivo, /no sé leer/, "ninguno de los tres puede caer en la rama del desconocido");
});

// ── La ventana de "hoy" no puede depender de la zona horaria de la sesión ────────────────────────
//
// Verificado contra Postgres real, con tres filas de hoy (02:00, 07:00 y 20:00 UTC):
//
//   TZ=Etc/UTC          vieja(sesión)=3  vieja(sin zona)=3  NUEVA=3
//   TZ=America/Bogota   vieja(sesión)=2  vieja(sin zona)=2  NUEVA=3   ← pierde la de las 02:00
//   TZ=Europe/Madrid    vieja(sesión)=3  vieja(sin zona)=3  NUEVA=3
//
// Bajo Bogotá —la zona del operador— las formas viejas PIERDEN los envíos de entre 00:00 y 05:00
// UTC. Contar de menos es la dirección peligrosa: el daemon cree que mandó menos de lo que mandó y
// se autoriza a mandar de más. Hoy el servidor está en Etc/UTC y el bug duerme; un cambio de TZ del
// contenedor lo despierta sin tocar una línea de código.
//
// El test es de CONTRATO sobre la SQL emitida: el defecto vive en Postgres, y un cliente falso no
// ejerce el casteo de timestamp→timestamptz que lo produce. Lo que sí se puede fijar acá es que
// nadie vuelva a escribir la forma frágil.

test("las tres ventanas de 'hoy' usan date_trunc con zona EXPLÍCITA", async () => {
  const { readFile } = await import("node:fs/promises");
  const fuentes = [
    "apps/warmup-engine/src/service/plan-diario.ts",
    "apps/warmup-engine/src/service/live-warmup-daemon.ts"
  ];
  for (const f of fuentes) {
    const src = await readFile(f, "utf8");
    // Solo las líneas de SQL, no los comentarios que documentan las formas viejas.
    const sql = src
      .split("\n")
      .filter((l) => /date_trunc/.test(l) && !/^\s*(\/\/|--|\*)/.test(l.trim()))
      .join("\n");
    assert.doesNotMatch(sql, /date_trunc\('day',\s*now\(\)\)/, `${f}: trunca en la TZ de la sesión`);
    assert.doesNotMatch(sql, /at time zone 'utc'\s*\)/, `${f}: devuelve timestamp sin zona y se reinterpreta`);
    // SE CUENTAN LOS `date_trunc`, no se exige una forma por LÍNEA: el assert por línea daba rojo
    // sobre `date_trunc('day', occurred_at, 'UTC')` —que tiene la zona explícita y es correcto— sólo
    // porque no truncaba `now()`. Lo que hay que garantizar es que NINGUNO se quede sin el tercer
    // argumento, venga de la columna o del reloj.
    const total = (sql.match(/date_trunc\(/g) ?? []).length;
    const conZona = (sql.match(/date_trunc\('day', (?:now\(\)|[a-z_.]+), 'UTC'\)/g) ?? []).length;
    assert.ok(total > 0, `${f}: el barrido no encontró una sola ventana`);
    assert.equal(conZona, total, `${f}: hay ${total - conZona} date_trunc sin zona explícita en\n${sql}`);
    assert.ok(sql.includes("date_trunc('day', now(), 'UTC')"), `${f}: la ventana de hoy se ancla en now() truncado en UTC`);
  }
});

// ── La cuarta exclusión: la autenticación ────────────────────────────────────────────────────────

test("auth ROTA saca del pool: calentar así construye la reputación al revés", () => {
  // Hasta hoy el warmup mandaba sin comprobar que DKIM, PTR o el certificado siguieran vivos. No es
  // teórico: filing-ops.com se quedó sin cert TLS y controlcorpfiling.com sin base SASL, y las dos
  // cosas se descubrieron a mano semanas después.
  const auth = new Map([
    ["a.com", { spf: { estado: "ok" }, dkim: { estado: "mal" }, ptr: { estado: "ok" }, tls: { estado: "ok" } }],
    ["c.com", { spf: { estado: "ok" }, dkim: { estado: "ok" }, ptr: { estado: "ok" }, tls: { estado: "ok" } }]
  ]);
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["c.com", 20]]) }), [], undefined, auth);
  assert.deepEqual(r.boxes, ["c.com"]);
  assert.match(r.motivo, /DKIM en mal estado/);
});

test("auth en 'no sé' NO saca a nadie: un hipo del DNS no puede apagar la fábrica", () => {
  // LA ASIMETRÍA que hace que esto se pueda encender: sólo excluye una medición POSITIVA de que
  // está roto. Al revés, un resolver con hipo dejaría la flota entera fuera del pool, y la
  // consecuencia física de mandar con una auth desconocida-pero-sana es exactamente cero.
  const auth = new Map([
    ["a.com", { spf: { estado: "no-se" }, dkim: { estado: "no-se" }, ptr: { estado: "no-se" }, tls: { estado: "no-se" } }]
  ]);
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20]]) }), [], undefined, auth);
  assert.deepEqual(r.boxes, ["a.com"]);

  // Y un dominio AUSENTE del archivo tampoco: el barrido puede no haber llegado por la cuota.
  const sinFila = elegirPool(medicion({ porDominio: new Map([["z.com", 20]]) }), [], undefined, auth);
  assert.deepEqual(sinFila.boxes, ["z.com"]);
});

test("sin archivo de reputación el pool sale exactamente igual que antes", async () => {
  assert.equal(await leerReputacion("/no/existe/warmup-reputacion.json"), undefined);
  const r = elegirPool(medicion(), [], undefined, undefined);
  assert.deepEqual(r.boxes, ["a.com"], "b.com está en cap 0; nada más cambió");
});

// ── La quinta exclusión: la LISTA NEGRA, que ya estaba medida y se tiraba ───────────────────────

test("una IP LISTADA no calienta: la exclusión existía en el archivo y no llegaba a la decisión", () => {
  // LA FILA ES REAL. `corpfiling-relay.com` es uno de los siete vírgenes que el operador está por
  // soltar, y su IP (217.216.55.59) está listada en dyna.spamrats.com AHORA MISMO — medido con dig
  // el 2026-08-07, con control positivo (127.0.0.2 → 127.0.0.36) y control negativo (127.0.0.1 →
  // NXDOMAIN) para que un resolver mudo no se lea como "limpio". Lo mismo corpfilingrelay.com
  // (217.216.55.64).
  //
  // En el archivo de producción hay CINCO filas con `listas` no vacía —annualfilings-infra.com
  // entre ellas, con `["RATS Dyna"]` y spf/dkim/ptr en ok— y `authRota` devolvía `null` sobre las
  // cinco: `leerReputacion` armaba el Map con cuatro campos y tiraba el quinto. Una válvula medida
  // y desconectada.
  const auth = new Map([
    ["corpfiling-relay.com", { spf: { estado: "ok" }, dkim: { estado: "ok" }, ptr: { estado: "ok" }, tls: { estado: "no-se" }, listas: ["RATS Dyna"] }],
    ["sano.com", { spf: { estado: "ok" }, dkim: { estado: "ok" }, ptr: { estado: "ok" }, tls: { estado: "no-se" }, listas: [] }]
  ]);
  const r = elegirPool(medicion({ porDominio: new Map([["corpfiling-relay.com", 20], ["sano.com", 20]]) }), [], undefined, auth);
  assert.deepEqual(r.boxes, ["sano.com"]);
  assert.match(r.motivo, /corpfiling-relay\.com \(la IP está en lista negra \(RATS Dyna\)/);
});

test("listas en 'no sé' NO saca a nadie: al barrido se le acaba la cuota, y eso no es estar limpio", () => {
  // FAIL AL SILENCIO, igual que las otras cuatro señales de `authRota`. Hoy 54 de los 66 dominios
  // del archivo están en `"no-se"` porque el barrido consulta con presupuesto y se le agotó — entre
  // ellos los DOS que dig encontró listados. Excluir por no haber preguntado dejaría la flota entera
  // fuera del pool por una cuota de API, que es exactamente el error opuesto y mucho más caro.
  const auth = new Map([
    ["corpfiling-relay.com", { spf: { estado: "ok" }, dkim: { estado: "ok" }, ptr: { estado: "ok" }, listas: "no-se" as const }]
  ]);
  const r = elegirPool(medicion({ porDominio: new Map([["corpfiling-relay.com", 20]]) }), [], undefined, auth);
  assert.deepEqual(r.boxes, ["corpfiling-relay.com"], "'no sé' no excluye");

  // Y un array VACÍO tampoco: eso es "consultado y limpio".
  const limpio = new Map([["a.com", { listas: [] }]]);
  assert.deepEqual(elegirPool(medicion({ porDominio: new Map([["a.com", 20]]) }), [], undefined, limpio).boxes, ["a.com"]);
});

test("leerReputacion NO puede volver a tirar el campo `listas`", async () => {
  // El defecto no estaba en `authRota`, estaba en el lector: el Map se armaba con cuatro campos.
  // Un test sobre `authRota` sola habría quedado verde con el bug intacto.
  const { mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
  const dir = mk(join(tmpdir(), "rep-"));
  const ruta = join(dir, "warmup-reputacion.json");
  wf(ruta, JSON.stringify({ dominios: [{ dominio: "x.com", spf: { estado: "ok" }, listas: ["RATS Dyna"] }] }));
  const m = await leerReputacion(ruta);
  assert.deepEqual(m?.get("x.com")?.listas, ["RATS Dyna"], "el campo tiene que llegar hasta la decisión");
});

// ── Un cierre del receptor no se borra por el calendario ────────────────────────────────────────

test("un CIERRE ARRASTRADO saca del pool aunque el estado ya diga `no_traffic`", () => {
  // EL AGUJERO QUE SE ABRE SOLO, con fecha. `estado`, `cerradoEn` y `porReceptor` se recalculan en
  // cada barrido sobre una ventana de 5 días por fecha de línea; lo único pegajoso era `cruzados`.
  // NFC dejó de inyectar por el /24 80.190.73.x el 2026-08-05, así que alrededor del 9-11 de agosto
  // sus TRES nodos pasan solos a `no_traffic` 0/0/0 — y `no_traffic` es justo la puerta que se abrió
  // para que los dominios NUEVOS puedan arrancar. controlstatecorp.com tiene 56 rechazos 550-5.7.1
  // de Gmail de hace cuatro días: sin el arrastre se lee como "nodo nuevo, candidato natural".
  // Ya pasó una vez: nationalfiling-infra.com estuvo en el pool el 2026-08-05 y mandó un correo real.
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 20], ["controlstatecorp.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 12 },
    "controlstatecorp.com": { estado: "no_traffic", cerradoEn: ["gmail.com"], entregados: 0 }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
  assert.match(r.motivo, /controlstatecorp\.com \(cerrado por el receptor \(arrastrado: gmail\.com\)/);
  assert.doesNotMatch(r.motivo, /entran a arrancar/, "no puede contarse como dominio nuevo");

  // Y EL MOTIVO DICE EL CAMINO DE VUELTA, porque no hay ninguno automático. `cerradoEn` no caduca a
  // proposito (ver el `ponytail:` de sender-measurement.ts) y hoy son 43 de los 58 dominios los que
  // lo tienen, los 43 medidos con `modo: "todo"` — o sea sobre el mail.log ENTERO del nodo, con el
  // correo de NFC adentro. Entre ellos los 6 que el encargo lista como LIMPIOS (controlstatecorp,
  // docfiling-ops, infranationalcorp, nationalcorp-infra, corpregistry-control, bizfiling-infra).
  // Cuando NFC se aisle —la decision que el jefe ya tomo— esos dominios quedan inelegibles PARA
  // SIEMPRE y el unico camino de vuelta es editar a mano un JSON de produccion. Que sea un acto
  // humano deliberado esta bien; que sea un acto humano que nadie sabe que existe, no.
  assert.match(r.motivo, /se olvida borrando `cerradoEn`/, `el motivo tiene que decir como se despega: ${r.motivo}`);
});

// ── El pool sobre la FOTO REAL de producción ────────────────────────────────────────────────────

/**
 * La foto del 2026-08-07, 20:05 UTC (sender-measurement.json) contra sender-cap.json de las 21:14.
 *
 * Los nombres de los 6 aptos y de los 8 frenados en cap 0 son los REALES; los 43 excluidos se
 * sintetizan con los estados y las proporciones medidas (34 `blocked_by_provider`, 8 con `cruzados`,
 * 1 `stalled`), porque lo que fijan estos tests son los CONTEOS y ninguno depende de sus nombres.
 */
const APTOS_REALES = [
  "annualcorp-infra.com",
  "annualfilings-control.com",
  "annualfilings-ops.com",
  "corpfiling-infra.com",
  "opscorpfiling.com",
  "statefilings-control.com"
];
/** Los 7 vírgenes (tráfico cero, congelados) + bizreport-control.com, que cruzó el umbral. */
const VIRGENES_REALES = [
  "bizregistry-ops.com",
  "controlnationalcorp.com",
  "corpfiling-relay.com",
  "corpfilingrelay.com",
  "corpregistry-ops.com",
  "filing-ops.com",
  "nationalbizrenewal-ops.com"
];

function fotoDeProduccion(capDeLosVirgenes: number): {
  cupos: MedicionCupos;
  saludFlota: Map<string, { estado?: string; cruzados?: string[]; cerradoEn?: string[]; entregados?: number | null }>;
} {
  const cap = new Map<string, number>();
  const s: Record<string, { estado?: string; cruzados?: string[]; cerradoEn?: string[]; entregados?: number | null }> = {};
  for (const d of APTOS_REALES) {
    cap.set(d, 20);
    s[d] = { estado: "healthy", entregados: 10, cruzados: [], cerradoEn: [] };
  }
  for (let i = 0; i < 34; i++) {
    cap.set(`cerrado-${i}.com`, 50);
    s[`cerrado-${i}.com`] = { estado: "blocked_by_provider", entregados: 1000, cerradoEn: ["gmail.com"] };
  }
  for (let i = 0; i < 8; i++) {
    cap.set(`quemado-${i}.com`, 50);
    s[`quemado-${i}.com`] = { estado: "healthy", entregados: 1000, cruzados: ["google"] };
  }
  cap.set("atascado-0.com", 50);
  s["atascado-0.com"] = { estado: "stalled", entregados: 1000, cerradoEn: [] };
  for (const d of VIRGENES_REALES) {
    cap.set(d, capDeLosVirgenes);
    s[d] = { estado: "no_traffic", entregados: 0, cruzados: [], cerradoEn: [] };
  }
  cap.set("bizreport-control.com", 0);
  s["bizreport-control.com"] = { estado: "blocked_by_provider", entregados: 500, cerradoEn: ["gmail.com"] };
  return { cupos: medicion({ porDominio: cap }), saludFlota: new Map(Object.entries(s)) };
}

test("la línea del pool SUMA: aptos + fuera + frenados en cap 0 = el universo medido", () => {
  // LA LÍNEA DE PRODUCCIÓN NO CERRABA: "6 de 57 nodos medidos aptos · 43 fuera" — 6 + 43 = 49, y la
  // flota son 57. Los 8 que faltaban son los frenados en cap 0, descartados en el filtro `cap > 0`
  // ANTES de que exista el array `excluidos`, así que no aparecían en ninguna línea del log del
  // daemon mientras el comentario del código promete que los excluidos se declaran SIEMPRE. Son
  // justo los 7 dominios que el operador compró y no calienta: el número que no cierra esconde la
  // pregunta de negocio.
  const { cupos, saludFlota } = fotoDeProduccion(0);
  const r = elegirPool(cupos, [], saludFlota);
  assert.deepEqual(r.boxes, APTOS_REALES);
  const n = (re: RegExp): number => Number(r.motivo.match(re)?.[1] ?? -1);
  const aptos = n(/(\d+) de \d+ nodos medidos aptos/);
  const universo = n(/\d+ de (\d+) nodos medidos aptos/);
  const fuera = n(/· (\d+) fuera/);
  const frenados = n(/· (\d+) frenados? en cap 0/);
  assert.equal(aptos, 6);
  assert.equal(fuera, 43);
  assert.equal(frenados, 8);
  assert.equal(universo, 57);
  assert.equal(aptos + fuera + frenados, universo, `la línea no suma: ${r.motivo}`);
  assert.match(r.motivo, /frenados en cap 0: bizregistry-ops\.com/, "y se los nombra, no solo se los cuenta");
});

test("los arreglos de instrumento NO mueven el pool: los mismos 6 dominios de hoy", () => {
  // Este lote agrega dos exclusiones nuevas (lista negra y cierre arrastrado) y una cola de espera.
  // Ninguna de las tres puede tocar a los 6 que hoy calientan: verificado contra los archivos de
  // producción, los 6 tienen `cerradoEn: []`, `cruzados: []` y ninguno figura entre los 5 listados
  // del barrido. Si este test se pone rojo, alguien movió una regla de VOLUMEN sin decirlo.
  const { cupos, saludFlota } = fotoDeProduccion(0);
  const authReal = new Map(
    // Las 5 filas con `listas` no vacía del archivo de producción, más el resto en "no sé".
    [
      ["corp-delivery.com", { listas: ["RATS Dyna"] }],
      ["infranationalreport.com", { listas: ["RATS Dyna"] }],
      ["annualfiling-ops.com", { listas: ["DRONE BL"] }],
      ["annualfilingops.com", { listas: ["RATS Dyna"] }],
      ["annualfilings-infra.com", { listas: ["RATS Dyna"] }],
      ...APTOS_REALES.map((d) => [d, { listas: "no-se" as const, tls: { estado: "no-se" } }] as const)
    ] as Array<readonly [string, { listas?: string[] | "no-se"; tls?: { estado: string } }]>
  );
  assert.deepEqual(elegirPool(cupos, [], saludFlota, authReal).boxes, APTOS_REALES);
});

test("ENTRA UN DOMINIO NUEVO POR VEZ: soltar los 7 vírgenes da 7 boxes, no 13", () => {
  // El daemon reparte UNA vuelta por dominio contra un sobre global de 14/día. Con los 7 vírgenes
  // adentro de golpe, `avisoDeSobre` dice que cada dominio recibiría ~1,08 envíos/día: los 6 que hoy
  // calientan caen de 2,00 a 1,08 (−46%) y NADIE junta las 4 mediciones propias que la rampa pide.
  // Peor: la simulación sobre `decideDaemonAction` con los motivos ya medidos da 46% de bandeja al
  // día 5 ⇒ `placement-pause` para TODA la flota, incluido el único al 83%, y esa pausa no sale sola
  // (parado no se mide, y las muestras malas quedan siendo las más nuevas de la ventana).
  const { cupos, saludFlota } = fotoDeProduccion(20);
  // Las listas negras de los siete, CONSULTADAS y limpias: este test prueba la cola de arranque, no
  // la puerta de reputación. Lo que dice el archivo de producción de verdad —"no-se" en los siete—
  // tiene su propio test acá abajo.
  const r = elegirPool(cupos, [], saludFlota, authConsultada(...VIRGENES_REALES));
  assert.equal(r.boxes.length, 7, `entra UNO solo: ${r.boxes.join(", ")}`);
  assert.deepEqual(r.boxes, [...APTOS_REALES, "bizregistry-ops.com"].sort());
  // Y los que esperan se NOMBRAN: una cola silenciosa se lee como "no los soltaron".
  assert.match(r.motivo, /6 esperan turno: controlnationalcorp\.com, corpfiling-relay\.com/);
  assert.match(r.motivo, /1 sin tráfico todavía, entran a arrancar: bizregistry-ops\.com/);
});

// ── La atribución: DATO, no gate ────────────────────────────────────────────────────────────────

test("la flota en modo 'todo' NO es atribuida, y eso no saca a nadie del pool", () => {
  // Las 58 bandejas están en modo "todo" hoy: los veredictos de salud incluyen el correo del OTRO
  // inquilino del nodo. Usarlo como gate dejaría al agente sin manos de un plumazo. Se declara para
  // que el canal pueda decir "no sé de quién es este veredicto" en vez de afirmarlo como propio.
  const todo = new Map([["a.com", { estado: "healthy", entregados: 5, modo: "todo" as const }]]);
  assert.equal(flotaAtribuida(todo), false);
  assert.deepEqual(elegirPool(medicion(), [], todo).boxes, ["a.com"], "sigue calentando igual");

  const nuestro = new Map([["a.com", { estado: "healthy", entregados: 5, modo: "nuestro" as const }]]);
  assert.equal(flotaAtribuida(nuestro), true);
  assert.equal(flotaAtribuida(undefined), false, "sin medición no se afirma que sea nuestro");
  assert.equal(flotaAtribuida(new Map()), false);
});

// ── La ventana de hace 2 días ────────────────────────────────────────────────────────────────────

test("los envíos de hace 2 días salen de UN día cerrado, no de 'desde entonces'", async () => {
  const vistos: Array<{ sql: string; params: unknown[] }> = [];
  const pg = { async query(sql: string, params: unknown[]) { vistos.push({ sql, params }); return { rows: [] }; } } as never;
  await enviosDelDia(pg, 2);
  assert.equal(vistos[0]!.params[0], 2);
  assert.match(vistos[0]!.sql, /occurred_at >= date_trunc\('day', now\(\), 'UTC'\) - make_interval/);
  assert.match(vistos[0]!.sql, /occurred_at <\s+date_trunc\('day', now\(\), 'UTC'\) - make_interval/, "cerrada por arriba");
  // Y la zona explícita, por lo mismo que enviosDeHoy: bajo TZ=America/Bogota se perdían los envíos
  // de entre 00:00 y 05:00 UTC, y contar de menos autoriza a mandar de más.
  assert.equal(vistos[0]!.sql.includes("'UTC'"), true);
});

test("lo que mandó hace 2 días NO le pone techo a un dominio sano", async () => {
  // MEDIDO EN PRODUCCIÓN el 2026-08-07: los envíos reales están topados por un límite GLOBAL
  // (WARMUP_LIVE_MAX_PER_DAY = 14 vueltas para TODA la flota), así que por dominio dan 1-8. Usados
  // como base del clamp 3×/48h, corpfiling-infra.com —el más sano, 83% de bandeja— mandó 1 el
  // 05-ago y quedaba con techo 3/día, mientras opscorpfiling.com, que no mandó nada, quedaba SIN
  // techo. Frenaba a los sanos, soltaba a los mudos, y se realimentaba: el plan se congelaba en
  // 3-6/día para siempre mientras el panel pintaba una rampa que avanzaba.
  const conEnvios = await planDelDia({
    pg: pgFalso({
      medidos: Array.from({ length: 12 }, () => "INBOX"),
      hace2Dias: 2,
      historial: ["2026-07-20T10:00:00Z"]
    }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 2000 }]),
    poolConfigurado: [],
    ventanaPlacement: 12,
    ahora: AHORA
  });
  const sinEnvios = await planDelDia({
    pg: pgFalso({
      medidos: Array.from({ length: 12 }, () => "INBOX"),
      hace2Dias: 0,
      historial: ["2026-07-20T10:00:00Z"]
    }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 2000 }]),
    poolConfigurado: [],
    ventanaPlacement: 12,
    ahora: AHORA
  });
  assert.equal(
    conEnvios.dominios[0]!.decision.cupo,
    sinEnvios.dominios[0]!.decision.cupo,
    "haber mandado 2 correos hace dos días no puede dejarte con menos cupo que no haber mandado ninguno"
  );
  assert.equal(conEnvios.dominios[0]!.decision.accion, "subir");
});

// ══ EL CUPO AUTORIZADO NO ES LO MISMO QUE LOS ENVÍOS ═════════════════════════════════════════════

test("cupoAutorizadoVigente lee `detail.cupoDelDia`; enviosDelDia CUENTA FILAS — y en el mismo día DIFIEREN", async () => {
  // EL CASO QUE HOY NO SE DISTINGUE, y es la raíz de que el clamp anti-firma del §10 estuviera
  // escrito y desconectado desde el diseño v1: el único dato disponible eran los ENVÍOS, y los
  // envíos están aplastados por el tope GLOBAL del daemon (14 vueltas para TODA la flota). Un
  // dominio con cupo autorizado 20 mandó 2, y el clamp que lea 2 lo topa en 6/día creyendo que
  // respeta el §10 — cuando en realidad está frenando a un dominio sano y dejando suelto al que no
  // mandó nada (ausente del Map ⇒ sin clamp, rampa entera).
  const consultas: string[] = [];
  const pg = {
    async query(sql: string) {
      consultas.push(sql);
      return sql.includes("cupoDelDia")
        ? { rows: [{ node_domain: "a.com", cupo: 20 }] }
        : { rows: [{ node_domain: "a.com", n: 2 }] };
    }
  } as never;

  const autorizado = await cupoAutorizadoVigente(pg, 2);
  const enviado = await enviosDelDia(pg, 2);
  assert.equal(autorizado.get("a.com"), 20, "lo que la decisión AUTORIZÓ");
  assert.equal(enviado.get("a.com"), 2, "lo que realmente SALIÓ");
  assert.notEqual(autorizado.get("a.com"), enviado.get("a.com"), "son dos magnitudes distintas");

  // Y las dos consultas tienen que seguir siendo distintas de verdad: si alguien "simplifica"
  // haciendo que las dos cuenten filas, el clamp vuelve a quedar sin entrada y nada falla.
  assert.match(consultas[0]!, /MAX\(\(detail->>'cupoDelDia'\)::int\)/);
  assert.match(consultas[1]!, /COUNT\(\*\)::int/);
  // Un dato corrupto en el campo no puede reventar la consulta: el llamador lee un fallo de lectura
  // como "no mando esta vuelta", así que UNA fila con basura apagaría el warmup.
  assert.match(consultas[0]!, /~ '\^\[0-9\]\+\$'/);
  // Misma zona explícita que el resto de las ventanas: bajo TZ=America/Bogota se perderían las
  // filas de entre 00:00 y 05:00 UTC.
  assert.match(consultas[0]!, /date_trunc\('day', now\(\), 'UTC'\)/);
});

test("LA AUSENCIA NO ES PERMISO: el dominio que no mandó anteayer arrastra su último cupo conocido", async () => {
  // EL DEFECTO QUE ESTE TEST HABRÍA CAZADO: la consulta miraba UN día puntual y sólo devuelve
  // dominios con una fila `sent` ESE día. Sin entrada, `dailyQuota` no clampea y sale la rampa
  // entera — o sea que el dominio QUIETO anteayer, el único que puede pegar el salto, era el que se
  // quedaba sin freno, y el activo se llevaba el clamp. Es la misma asimetría que el archivo dice
  // haber cerrado al dejar de usar `enviosDelDia`, con otra fuente de datos.
  //
  // Medido contra la Postgres de producción (10 días de warmup_activity, kind 'sent'): de los 17
  // pares dominio-día con envíos, sólo 6 tienen envío dos días antes ⇒ el clamp faltaba el 65% de
  // las veces. Con el tope GLOBAL de 14 vueltas para toda la flota, un día sin fila es lo normal.
  //
  // El arrastre vive en `ultimoAutorizado`, que es PURA justamente para poder fijarlo sin Postgres:
  // la lógica adentro del SQL sólo se puede "probar" con un doble que devuelve lo que uno quiera.
  const filas = [
    { node_domain: "quieto.com", dia: "2026-08-01T00:00:00.000Z", cupo: 4 },
    // Ni una fila el 08-03 (anteayer): antes esto era ausencia ⇒ rampa entera.
    { node_domain: "activo.com", dia: "2026-08-01T00:00:00.000Z", cupo: 20 },
    { node_domain: "activo.com", dia: "2026-08-03T00:00:00.000Z", cupo: 6 }
  ];
  const m = ultimoAutorizado(filas);
  assert.equal(m.get("quieto.com"), 4, "el que no mandó anteayer arrastra lo último que se le autorizó");
  assert.equal(m.get("activo.com"), 6, "y el que sí mandó usa ESE día, no el MÁXIMO de la ventana");

  // EL MÁXIMO SERÍA CASI NO CLAMPEAR en una rampa hacia abajo: con `MAX` sobre la ventana,
  // activo.com se clamparía contra 20 (60/día) en vez de contra 6 (18/día).
  assert.notEqual(m.get("activo.com"), 20);

  // Y la consulta pide una VENTANA, no un día: dos parámetros, borde inferior y borde superior.
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const pg = {
    async query(sql: string, params: unknown[]) {
      consultas.push({ sql, params });
      return { rows: [] };
    }
  } as never;
  await cupoAutorizadoVigente(pg, 2, 10);
  assert.deepEqual(consultas[0]!.params, [2, 10], "hasta hace 2 días, mirando 10 hacia atrás");
  assert.match(consultas[0]!.sql, /GROUP BY node_domain, date_trunc/, "una fila por dominio y DÍA: el arrastre se decide afuera");
});

test("el plan pasa el cupo AUTORIZADO al clamp, y el clamp sólo baja", async () => {
  const args = {
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 2000 }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  };
  const medidos = Array.from({ length: 6 }, () => "INBOX");
  const historial = ["2026-07-26T10:00:00Z"];
  const conClamp = await planDelDia({ ...args, pg: pgFalso({ medidos, historial, cupoAutorizadoHace2Dias: 2 }) });
  const sinTope = await planDelDia({ ...args, pg: pgFalso({ medidos, historial, cupoAutorizadoHace2Dias: 200 }) });
  const sinDato = await planDelDia({ ...args, pg: pgFalso({ medidos, historial }) });
  assert.equal(conClamp.dominios[0]!.decision.cupo, 6, "3× lo autorizado hace 2 días");
  assert.ok(sinTope.dominios[0]!.decision.cupo > conClamp.dominios[0]!.decision.cupo, "con 200 autorizados el clamp no toca la rampa");
  // Y SIN EL DATO EL CLAMP NO DESAPARECE: asume `CUPO_ARRANQUE` y topa en 6/día. Antes de ese
  // cambio, la falta de dato daba la rampa ENTERA — que es el estado de la producción de hoy (0 de
  // 54 filas `sent` de toda la historia llevan `detail.cupoDelDia`), o sea la válvula anti-firma
  // 3×/48h fallando abierta justo antes de que la rampa se destrabe.
  assert.equal(sinDato.dominios[0]!.decision.cupo, 6, "sin dato, el clamp asume el piso; no se apaga");
});

// ══ TODA CIFRA DE PLACEMENT DEL PLAN LLEVA SU PROVEEDOR, Y EL GATE DE §3 VA AL LADO ══════════════

function archivoSemillas(seeds: Array<{ address: string; provider: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "seeds-"));
  const ruta = join(dir, "warmup-seeds.json");
  writeFileSync(ruta, JSON.stringify({ seeds }));
  return ruta;
}

test("el plan emite placement.proveedor y gate.condicionQueFalla — las DOS filas que declara el lote", async () => {
  // Son las dos filas que `artefactos.ts` tiene que ver no-nulas a las 24 h del despliegue: un campo
  // nuevo en un JSON de runtime no está terminado por tener test verde.
  const plan = await planDelDia({
    pg: pgFalso({
      medidos: ["INBOX", "INBOX", "INBOX", "SPAM"],
      semilla: "trazosvercel@gmail.com",
      historial: ["2026-08-02T10:00:00Z"]
    }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
    seedsFile: archivoSemillas([{ address: "trazosvercel@gmail.com", provider: "gmail" }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  });
  const d = plan.dominios[0]!;
  assert.equal(d.placement.proveedor, "gmail", "la cifra dice EN QUÉ receptor se midió");
  assert.equal(d.placement.tasa, 0.75, "y la tasa sigue siendo la MISMA que tomó la decisión");
  // "no medido" y "cero" no son lo mismo: los receptores sin semilla salen null, jamás 0%.
  const outlook = d.placement.porProveedor.find((p) => p.proveedor === "outlook")!;
  assert.equal(outlook.tasa, null);
  assert.equal(outlook.muestra, 0);
  // El gate de §3 viaja evaluado, no como criterio: al modelo le llega el veredicto.
  assert.equal(d.gate.pasa, false);
  assert.equal(d.gate.umbral, 0.95, "el umbral del proveedor que midió");
  assert.match(d.gate.condicionQueFalla!, /sin muestra suficiente: 4 de 4|placement Gmail/);
  // Y no toca el cupo: la decisión es la misma que sin gate.
  assert.equal(d.decision.accion, "sostener");
});

test("sin registro de semillas el proveedor es 'desconocido', no un gmail adivinado", async () => {
  const plan = await planDelDia({
    pg: pgFalso({ medidos: ["INBOX"], semilla: "quiensea@x.com", historial: ["2026-08-03T10:00:00Z"] }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  });
  assert.equal(plan.dominios[0]!.placement.proveedor, "desconocido");
});

test("el cruce MTA × placement aparece con su 'no sé' cuando el MTA no reporta el receptor", async () => {
  // Medido el 2026-08-07: de los 6 dominios que calientan, CINCO tienen `porReceptor: []` porque el
  // escritor filtra los receptores con menos de 20 intentos. El cruce vale hoy para UNO, y decirlo
  // es el punto — un 0 ahí sería una medición que nadie hizo.
  const plan = await planDelDia({
    pg: pgFalso({ medidos: ["INBOX", "SPAM"], semilla: "trazosvercel@gmail.com", historial: ["2026-08-03T10:00:00Z"] }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
    seedsFile: archivoSemillas([{ address: "trazosvercel@gmail.com", provider: "gmail" }]),
    poolConfigurado: [],
    ventanaPlacement: 6,
    ahora: AHORA
  });
  const [c] = plan.dominios[0]!.cruce;
  assert.equal(c!.receptor, "gmail.com");
  assert.equal(c!.entregadosMta, null);
  assert.match(c!.lectura, /el cruce no se puede hacer/);
});

test("CABLEADO: el registro de semillas tiene DEFAULT — sin él, `proveedor` sería 'desconocido' en producción", async () => {
  // Es la diferencia con `saludFile`/`reputacionFile`, y la razón es concreta: el ÚNICO llamador
  // vivo de `planDelDia` (scripts/ops/warmup-monitor.ts, que es lo que el agente le reporta al jefe
  // por Slack) no pasa los archivos opcionales — se verifica leyendo su fuente acá abajo. Con
  // `seedsFile` opcional-sin-default, este lote habría shipeado un campo que en producción vale
  // `desconocido` para siempre: la sexta instancia de "una mano prometida y no cableada".
  const { readFile, mkdir, writeFile } = await import("node:fs/promises");

  const llamador = await readFile("scripts/ops/warmup-monitor.ts", "utf8");
  const llamada = llamador.slice(llamador.indexOf("plan: await planDelDia({"), llamador.indexOf("plan: await planDelDia({") + 300);
  assert.doesNotMatch(llamada, /seedsFile/, "si algún día lo pasa, este test sobra — hasta entonces el default es lo único que lo cablea");

  // Se ejerce el camino REAL del default: el workspace apunta a un temporal con el registro adentro.
  const raiz = mkdtempSync(join(tmpdir(), "ws-"));
  await mkdir(join(raiz, "inventory"), { recursive: true });
  await writeFile(
    join(raiz, "inventory", "warmup-seeds.json"),
    JSON.stringify({ seeds: [{ address: "trazosvercel@gmail.com", provider: "gmail" }] })
  );
  const previo = process.env.OPENCLAW_WORKSPACE_DIR;
  process.env.OPENCLAW_WORKSPACE_DIR = raiz;
  try {
    const plan = await planDelDia({
      pg: pgFalso({ medidos: ["INBOX"], semilla: "trazosvercel@gmail.com", historial: ["2026-08-03T10:00:00Z"] }),
      capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
      // SIN seedsFile: es el punto del test.
      poolConfigurado: [],
      ventanaPlacement: 6,
      ahora: AHORA
    });
    assert.equal(plan.dominios[0]!.placement.proveedor, "gmail");
  } finally {
    if (previo === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
    else process.env.OPENCLAW_WORKSPACE_DIR = previo;
  }
});

test("CABLEADO: `reputacionFile` también tiene DEFAULT — el canal del agente reportaba 36 y el daemon calentaba 32", async () => {
  // MISMA CLASE QUE EL TEST DE ARRIBA, y por eso está pegado: `seedsFile` recibió su default y
  // `reputacionFile` quedó afuera en el mismo lote. El arreglo del lote anterior fue por LLAMADOR
  // (se le pasó el archivo a la ruta del panel, main.ts) y `planDelDia` tiene DOS llamadores vivos:
  // la ruta y `scripts/ops/warmup-monitor.ts`, que es lo que el agente le dice al jefe por Slack.
  // Arreglar uno dejó al otro exactamente igual de ciego.
  //
  // MEDIDO SOBRE LA FOTO DE PRODUCCIÓN DEL 2026-08-08, corriendo `elegirPool` de verdad contra
  // inventory/: con reputación el pool da 32 boxes y sin ella 36. Los 4 que se colaban son
  // annualfiling-ops.com (DRONE BL), annualfilingops.com y annualfilings-infra.com (RATS Dyna) y
  // controldelivrix.app (PTR roto) — IPs en lista negra o autenticación rota, o sea justo lo que
  // `authRota` existe para sacar. El jefe leía 36 mientras corrían 32.
  //
  // EL DEFAULT VIVE EN LA FUNCIÓN Y NO EN EL LLAMADOR a propósito: un default por llamador es una
  // línea que hay que acordarse de escribir cada vez, y acordarse es justo lo que falla — van ocho
  // instancias contadas en este repo de "capacidad completa sin llamador".
  const { mkdir, writeFile } = await import("node:fs/promises");

  const raiz = mkdtempSync(join(tmpdir(), "ws-rep-"));
  await mkdir(join(raiz, "inventory"), { recursive: true });
  await writeFile(
    join(raiz, "inventory", "warmup-reputacion.json"),
    JSON.stringify({ dominios: [{ dominio: "sucia.com", listas: ["dyna.spamrats.com"] }, { dominio: "a.com", listas: [] }] })
  );
  const previo = process.env.OPENCLAW_WORKSPACE_DIR;
  process.env.OPENCLAW_WORKSPACE_DIR = raiz;
  try {
    const plan = await planDelDia({
      pg: pgFalso({ medidos: ["INBOX"], historial: ["2026-08-03T10:00:00Z"] }),
      capFile: archivoCap(AHORA.toISOString(), [
        { domain: "a.com", cap: 20 },
        { domain: "sucia.com", cap: 20 }
      ]),
      // SIN reputacionFile: es el punto del test. Es la llamada TAL CUAL la hace el orquestador.
      poolConfigurado: [],
      ventanaPlacement: 6,
      ahora: AHORA
    });
    assert.ok(!plan.pool.boxes.includes("sucia.com"), `la IP listada tiene que quedar afuera sin pasar el archivo — pool: ${plan.pool.boxes.join(", ")}`);
    assert.ok(plan.pool.boxes.includes("a.com"), "y el limpio tiene que seguir adentro: el default excluye, no apaga la fábrica");
  } finally {
    if (previo === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
    else process.env.OPENCLAW_WORKSPACE_DIR = previo;
  }
});

test("el default de reputación no puede APAGAR la fábrica cuando el archivo no está", async () => {
  // LA OTRA MITAD, y es la que convierte un arreglo en un incidente si sale mal. `leerReputacion`
  // devuelve `undefined` ante archivo ausente o roto, y `authRota` falla al silencio: un workspace
  // sin warmup-reputacion.json tiene que dejar el pool EXACTAMENTE como estaba. Sin este test, el
  // default de arriba es un cambio que nadie probó en la máquina donde el barrido todavía no corrió.
  const raiz = mkdtempSync(join(tmpdir(), "ws-vacio-"));
  const previo = process.env.OPENCLAW_WORKSPACE_DIR;
  process.env.OPENCLAW_WORKSPACE_DIR = raiz;
  try {
    const plan = await planDelDia({
      pg: pgFalso({ medidos: ["INBOX"], historial: ["2026-08-03T10:00:00Z"] }),
      capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
      poolConfigurado: [],
      ventanaPlacement: 6,
      ahora: AHORA
    });
    assert.deepEqual(plan.pool.boxes, ["a.com"]);
  } finally {
    if (previo === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
    else process.env.OPENCLAW_WORKSPACE_DIR = previo;
  }
});

// ── ENTREGARSE CORREO A SÍ MISMO NO ES ENTREGAR ─────────────────────────────────────────────────

test("annualcorp-control.com: `healthy` con porReceptor VACÍO y 0 entregas a un tercero ⇒ fuera del pool", () => {
  // LA FILA MEDIDA, no inventada: `readNodeDeliveryHealth` del árbol corrido por SSH contra
  // 80.190.76.57 el 2026-08-08 con la ventana en 3 días (que es lo que hace el calendario cuando el
  // nodo deja de mandar) devuelve `healthy`, `totals.delivered: 2`, aTerceros 0, y el detalle dice
  // en la cara "0 entregados a terceros, 0 rechazados (y 2 a sí mismo, que no son entrega)". El log
  // retenido de ese nodo: 4.087 mensajes rebotados en gmail.com contra 483 entregados.
  //
  // ESTE ES EL CASO QUE EL GUARD VIEJO NO PODÍA AGARRAR, y por eso el fixture tiene `porReceptor: []`
  // y no una lista poblada: el guard leía PRESENCIA de una fila del dominio propio, y `porReceptor`
  // sale filtrado a 20 intentos en sender-measurement.ts. En estos nodos llega vacío SIEMPRE, así que
  // `aSiMismo` daba 0 y la condición no podía disparar nunca. Un fixture con el desglose poblado
  // habría dado verde sin probar nada — es la lección del fixture de Bedrock.
  //
  // Sobre la flota entera con esa misma ventana el pool saltaba de 6 a 25 boxes y 19 de esos 25
  // tenían CERO entregas a terceros. Con esta regla vuelve a 7.
  const r = elegirPool(medicion({ porDominio: new Map([["annualcorp-control.com", 20], ["a.com", 20]]) }), [], salud({
    "a.com": { estado: "healthy", entregados: 12, entregadosATerceros: 12, porReceptor: [] },
    "annualcorp-control.com": { estado: "healthy", entregados: 2, entregadosATerceros: 0, porReceptor: [] }
  }));
  assert.deepEqual(r.boxes, ["a.com"]);
  assert.match(r.motivo, /annualcorp-control\.com \(sus 2 entregas de la ventana son a sí mismo/);
});

test("una medición VIEJA sin `entregadosATerceros` se cae a `entregados`, no a cero", () => {
  // EL DÍA DEL DESPLIEGUE. Los archivos que ya están escritos no traen el campo nuevo, y leer esa
  // ausencia como cero dejaría la flota entera fuera del pool de una — el mismo modo de falla
  // ("campo que todavía no viene, leído como evidencia") que este lote vino a cerrar. La ausencia se
  // cae al total; el `null` (no se pudo leer) sí excluye, y lo agarra la línea de arriba.
  const viejo = elegirPool(medicion({ porDominio: new Map([["annualcorp-infra.com", 20]]) }), [], salud({
    "annualcorp-infra.com": { estado: "healthy", entregados: 12, porReceptor: [] }
  }));
  assert.deepEqual(viejo.boxes, ["annualcorp-infra.com"]);

  const sinLeer = elegirPool(medicion({ porDominio: new Map([["x.com", 20]]) }), [], salud({
    "x.com": { estado: "healthy", entregados: null, entregadosATerceros: null }
  }));
  assert.deepEqual(sinLeer.boxes, []);
});

test("SIN desglose por receptor NO se excluye: 5 de los 6 que hoy calientan tienen porReceptor vacío", () => {
  // LA MITAD QUE HABRÍA ROTO LA FÁBRICA. La forma obvia del arreglo —"`porReceptor` ausente ⇒ no sé
  // ⇒ afuera"— deja el pool en UN dominio: `porReceptor` sale filtrado por `BLOCKED_MIN_ATTEMPTS`
  // (20 intentos) en sender-measurement.ts, y nuestro warmup manda ~2/día, así que annualcorp-infra,
  // annualfilings-control, annualfilings-ops, opscorpfiling y statefilings-control salen con `[]`
  // teniendo 7-12 entregas REALES a Gmail. Verificado corriendo `elegirPool` contra la copia de
  // producción: 6 boxes con esta regla, 1 con la otra.
  //
  // Por eso la condición lee PRESENCIA (hay una fila que PRUEBA la auto-entrega) y no ausencia.
  const r = elegirPool(medicion({ porDominio: new Map([["annualcorp-infra.com", 20]]) }), [], salud({
    "annualcorp-infra.com": { estado: "healthy", entregados: 12, porReceptor: [] }
  }));
  assert.deepEqual(r.boxes, ["annualcorp-infra.com"]);
});

// ── "SIN TRÁFICO" NO ES "NUEVO" ─────────────────────────────────────────────────────────────────

test("controlcontrolledger.com: `no_traffic` con 6.121 mensajes/día de historia NO arranca como dominio nuevo", () => {
  // LA FILA MEDIDA. `readNodeDeliveryHealth` del árbol por SSH contra 147.93.186.66 el 2026-08-08 con
  // la ventana en 3 días devuelve `no_traffic` — "el log no registra ni entregas ni rechazos ni
  // diferidos en la ventana leida" — y por esta puerta ENTRABA al pool como candidato a arrancar.
  //
  // Lo que dice su log RETENIDO, contado a mano en mensajes con dedup por queue-id: 15.116 rebotados
  // en gmail.com contra 294 entregados (98%), 14.988 líneas `550-5.7.1 [147.93.186.66 12] Gmail has
  // detected that this message is likely unsolicited mail`, 1.963 rechazos de Microsoft, 396
  // `Service unavailable; client blocked using Cloudmark Sender Intelligence` y rechazos de Apple.
  // Quemado en cuatro receptores a la vez, y el sensor lo iba a presentar como dominio virgen.
  // `cerradoEn` no lo tapa: está vacío para él (sólo 8 de 58 nodos lo tienen).
  //
  // El pico es el suyo real (yahoo_aol 2.175, google 3.597, otros 6.121).
  const quemado = {
    estado: "no_traffic",
    entregados: 0,
    picos: [{ mensajes: 6121 }, { mensajes: 3597 }, { mensajes: 2175 }]
  };
  const cupos = medicion({ porDominio: new Map([["controlcontrolledger.com", 20]]) });
  const r = elegirPool(cupos, [], salud({ "controlcontrolledger.com": quemado }));
  assert.deepEqual(r.boxes, [], "un nodo con 6.121 mensajes/día de historia no es un dominio nuevo");
  assert.match(r.motivo, /historia en el log \(pico de 6121 mensajes\/día\)/);

  // Y NO ES UN CANDADO: el operador lo suelta con la lista que ya existe.
  const suelto = elegirPool(cupos, [], salud({ "controlcontrolledger.com": quemado }), authConsultada("controlcontrolledger.com"), ["controlcontrolledger.com"]);
  assert.deepEqual(suelto.boxes, ["controlcontrolledger.com"]);
});

test("el dominio recién comprado SIGUE arrancando: su historia son 3 mensajes, no 6.121", () => {
  // LA MITAD QUE NO SE PUEDE ROMPER. La forma obvia del arreglo —"tiene algún pico ⇒ no es nuevo"—
  // cierra la puerta para TODOS: medido sobre la flota del 2026-08-08, los 58 nodos tienen al menos
  // un pico, así que la presencia pelada volvería a trabar el onboarding, que es el bug que esta
  // puerta vino a arreglar.
  //
  // La distribución real del pico máximo diario es bimodal con un hueco enorme: los candidatos
  // genuinos y los 6 que hoy calientan van de 1 a 8 mensajes/día (nuestro propio warmup y nada más),
  // el siguiente es 110 y el siguiente ya 1.863. Éstos son los valores reales de tres candidatos.
  const r = elegirPool(
    medicion({ porDominio: new Map([["bizregistry-ops.com", 20]]) }),
    [],
    salud({ "bizregistry-ops.com": { estado: "no_traffic", entregados: 0, picos: [{ mensajes: 3 }, { mensajes: 3 }] } }),
    authConsultada("bizregistry-ops.com")
  );
  assert.deepEqual(r.boxes, ["bizregistry-ops.com"]);

  // Y el dominio comprado hace cinco minutos, con el mail.log en blanco.
  const virgen = elegirPool(
    medicion({ porDominio: new Map([["recien-comprado.com", 20]]) }),
    [],
    salud({ "recien-comprado.com": { estado: "no_traffic", entregados: 0, picos: [] } }),
    authConsultada("recien-comprado.com")
  );
  assert.deepEqual(virgen.boxes, ["recien-comprado.com"]);
});

// ── LA COLA DE ARRANQUE NO LA DECIDE EL ALFABETO ────────────────────────────────────────────────

test("con WARMUP_LIVE_ARRANCA_PRIMERO entra el que dice el operador, no el primero por nombre", () => {
  // EL DEFECTO: `MAX_ARRANCANDO_A_LA_VEZ` toma `arrancando.slice(0, 1)` sobre una lista ordenada por
  // NOMBRE. Verificado corriendo `elegirPool` con los archivos reales de producción: soltar los 7
  // vírgenes de golpe hace entrar a bizregistry-ops.com — el peor de los siete, en el /24
  // 80.190.75.x donde 11 de 13 nodos no están sanos, y el que la ficha de la entrega clasifica
  // "no-conviene · resuelve: nadie". El alfabeto estaba decidiendo un dominio COMPRADO.
  const nuevos = salud({
    "bizregistry-ops.com": { estado: "no_traffic", entregados: 0 },
    "controlnationalcorp.com": { estado: "no_traffic", entregados: 0 }
  });
  const cupos = medicion({ porDominio: new Map([["bizregistry-ops.com", 20], ["controlnationalcorp.com", 20]]) });

  const limpias = authConsultada("bizregistry-ops.com", "controlnationalcorp.com");
  const porAlfabeto = elegirPool(cupos, [], nuevos, limpias);
  assert.deepEqual(porAlfabeto.boxes, ["bizregistry-ops.com"], "hoy elige el alfabeto");
  assert.match(porAlfabeto.motivo, /el orden lo decidió el ALFABETO/, "y lo tiene que DECIR: si no, se lee como una decisión");

  const elegido = elegirPool(cupos, [], nuevos, limpias, ["controlnationalcorp.com"]);
  assert.deepEqual(elegido.boxes, ["controlnationalcorp.com"]);
  assert.match(elegido.motivo, /bizregistry-ops\.com/, "el que espera se sigue declarando con nombre");
  assert.doesNotMatch(elegido.motivo, /ALFABETO/);
});

test("SIN MEDICIÓN DE SALUD, el plan avisa que ESE NO ES EL POOL QUE CORRE", async () => {
  // LA DIVERGENCIA QUE FIJA (encontrada por QA antes de desplegar, 2026-08-07). `poolSinSalud`
  // (live-warmup-daemon.ts) degrada al pool CONFIGURADO cuando el archivo de salud no se puede leer,
  // y `medirFlota` reescribe ese archivo ENTERO: una escritura cortada lo deja inválido. En ese
  // estado el daemon calienta 1 dominio y `planDelDia` —lo que muestra el panel y lo que el agente le
  // reporta al jefe— anunciaba 44, incluidos los 8 que cruzaron el umbral permanente. El propio
  // comentario de `poolSinSalud` declara la medición: "con salud ⇒ 6 boxes; con salud undefined ⇒ 44".
  //
  // La degradación NO se mueve al plan a propósito (el que MANDA es el daemon; dejar al panel sin
  // plan no protege nada y encima esconde). Pero la asimetría sólo es honesta si se DICE, y el motivo
  // salía idéntico al de un día normal. Es la misma regla que el propio archivo aplica a
  // `arrancaPrimero` cuatrocientas líneas más abajo: el panel no puede mostrar un pool que no es el
  // que corre sin avisar que no es el que corre.
  const plan = await planDelDia({
    pg: pgFalso({ medidos: ["INBOX"], enviadosHoy: 0, historial: [] }),
    capFile: archivoCap(AHORA.toISOString(), [{ domain: "a.com", cap: 20 }]),
    poolConfigurado: ["corpfiling-infra.com"],
    ventanaPlacement: 6,
    ahora: AHORA
  });
  assert.match(plan.pool.motivo, /ESTE NO ES EL POOL QUE CORRE/, `sin saludFile el plan tiene que avisar: ${plan.pool.motivo}`);
  assert.match(plan.pool.motivo, /se degrada a los 1 del pool configurado/);
});

// ── LA PUERTA DE "DOMINIO NUEVO" NO PUEDE CERRARSE SOBRE NUESTRO PROPIO ÉXITO ──────────────────

test("el umbral de 'ya no es nuevo' está ARRIBA del techo de la rampa: el que calienta bien no se retira solo", () => {
  // EL DEFECTO: `PICO_QUE_YA_NO_ES_NUEVO` estaba clavado en 20 y el comentario decía que "cualquier
  // número entre 9 y 1.800 da el mismo resultado". Es cierto de la FOTO de la flota y falso por
  // construcción, porque el que camina ese hueco es nuestro propio producto: la rampa sube
  // `día × 2` hasta 40/día, así que un dominio que calienta BIEN cruza 20 el día 10.
  //
  // Y `picos` se lee sobre el log RETENIDO entero y no caduca. Consecuencia: el dominio que mejor
  // calentó, si después se calla 5 días —cap físico a 0 en 46 nodos de golpe el 2026-08-04, un nodo
  // que pierde la red, el freno global: todo documentado en este repo como rutina— vuelve a
  // `no_traffic` con su propio pico adentro y queda excluido hasta que un humano lo nombre. La
  // trampa que se cierra sola, corrida diez días.
  assert.ok(
    PICO_QUE_YA_NO_ES_NUEVO > RAMPA_LIMITE_DIARIO_DEFAULT,
    `nuestra rampa llega a ${RAMPA_LIMITE_DIARIO_DEFAULT}/día y el umbral es ${PICO_QUE_YA_NO_ES_NUEVO}: el producto cruza su propia puerta`
  );
  // La rampa por dentro, para que esto siga rojo si alguien sube el techo sin mirar acá.
  const rampa = rampaDesdeEnv({});
  assert.equal(rampa.limiteDiario, RAMPA_LIMITE_DIARIO_DEFAULT);
  assert.equal(rampa.pasoPorDia, RAMPA_PASO_POR_DIA_DEFAULT);

  // El caso concreto: un dominio arriba de la rampa (40/día, su propio warmup) que se calló.
  const arriba = elegirPool(
    medicion({ porDominio: new Map([["el-que-mejor-calienta.com", 20]]) }),
    [],
    salud({ "el-que-mejor-calienta.com": { estado: "no_traffic", entregados: 0, picos: [{ mensajes: RAMPA_LIMITE_DIARIO_DEFAULT }] } }),
    authConsultada("el-que-mejor-calienta.com")
  );
  assert.deepEqual(arriba.boxes, ["el-que-mejor-calienta.com"], "40/día es NUESTRA rampa al tope, no historia de otro");

  // Y la mitad que no se puede romper: el nodo quemado de verdad sigue afuera.
  const quemado = elegirPool(
    medicion({ porDominio: new Map([["controlcontrolledger.com", 20]]) }),
    [],
    salud({ "controlcontrolledger.com": { estado: "no_traffic", entregados: 0, picos: [{ mensajes: 6121 }] } }),
    authConsultada("controlcontrolledger.com")
  );
  assert.deepEqual(quemado.boxes, []);
});

// ── UN DOMINIO VIRGEN NO ESTRENA DESDE UNA IP QUE NADIE MIRÓ ───────────────────────────────────

test("el que nunca mandó no arranca con las listas negras en 'no sé' — y el que ya calienta no se toca", () => {
  // LA FOTO DE PRODUCCIÓN, leída el 2026-08-08 (solo lectura): los SIETE dominios en `no_traffic`
  // tienen `listas: "no-se"` en warmup-reputacion.json, porque el barrido consulta con presupuesto y
  // se le acaba (49 de 66 filas están en "no-se"). Y dos de esos siete están listados AHORA MISMO:
  // corpfiling-relay.com (217.216.55.59) y corpfilingrelay.com (217.216.55.64) dan 127.0.0.36 en
  // dyna.spamrats.com, verificado con dig y con controles (127.0.0.2 prende las tres listas que
  // consulto, 127.0.0.1 no prende ninguna).
  //
  // `authRota` falla al SILENCIO ante "no-se" y tiene que seguir haciéndolo para los 52 que ya
  // calientan: excluir por no haber preguntado apagaría la fábrica por una cuota de API. Pero por la
  // puerta de `no_traffic` pasa el PRIMER correo de un dominio virgen, y el primer correo desde una
  // IP listada construye reputación al revés — el único trabajo que no se deshace. Lo único que hoy
  // frena a esos dos es el cap 0 y el orden alfabético, que no son una medición.
  const sinConsultar = new Map([
    ["corpfiling-relay.com", { listas: "no-se" as const, spf: { estado: "ok" }, dkim: { estado: "ok" } }],
    ["ya-calienta.com", { listas: "no-se" as const, spf: { estado: "ok" }, dkim: { estado: "ok" } }]
  ]);
  const cupos = medicion({ porDominio: new Map([["corpfiling-relay.com", 20], ["ya-calienta.com", 20]]) });
  const estado = salud({
    "corpfiling-relay.com": { estado: "no_traffic", entregados: 0 },
    "ya-calienta.com": { estado: "healthy", entregados: 12 }
  });

  const r = elegirPool(cupos, [], estado, sinConsultar);
  assert.deepEqual(r.boxes, ["ya-calienta.com"], "el que ya calienta no se toca por un 'no sé'");
  assert.match(r.motivo, /corpfiling-relay\.com \(nunca mandó y su IP no figura consultada en listas negras/);

  // Consultada y limpia, arranca: la exclusión es por falta de medición, no un candado.
  const consultada = new Map(sinConsultar);
  consultada.set("corpfiling-relay.com", { listas: [] as string[], spf: { estado: "ok" }, dkim: { estado: "ok" } } as never);
  const conDato = elegirPool(cupos, [], estado, consultada);
  assert.deepEqual([...conDato.boxes].sort(), ["corpfiling-relay.com", "ya-calienta.com"]);

  // Y consultada CON detección, la exclusión la da `authRota`, que ya existía y ahora sí se aplica.
  const listada = new Map(sinConsultar);
  listada.set("corpfiling-relay.com", { listas: ["dyna.spamrats.com"], spf: { estado: "ok" }, dkim: { estado: "ok" } } as never);
  const conLista = elegirPool(cupos, [], estado, listada);
  assert.deepEqual(conLista.boxes, ["ya-calienta.com"]);
  assert.match(conLista.motivo, /la IP está en lista negra \(dyna\.spamrats\.com\)/);
});
