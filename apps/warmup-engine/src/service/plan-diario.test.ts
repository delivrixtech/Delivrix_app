// Tests del plan del día. Lo que protegen es la ASIMETRÍA que costó un bug: una medición vencida
// sirve para elegir a quién intentarle, pero NO para decidir cuánto mandar. Tratar los dos casos
// igual hizo que el daemon se apagara solo teniendo un nodo con cupo, y en la versión anterior que
// decidiera volumen sobre un cap 2000 que ya no existía.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decidirCupoDeHoy, rampaDesdeEnv } from "../domain/decision-diaria.ts";
import {
  cupoAutorizadoVigente,
  elegirPool,
  enviosDelDia,
  flotaAtribuida,
  leerCuposFisicos,
  leerReputacion,
  placementsDeDominio,
  ultimoAutorizado,
  planDelDia,
  type MedicionCupos
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
    pg: pgFalso({ medidos: Array.from({ length: 12 }, () => "INBOX"), historial: ["2026-08-02T10:00:00Z", "2026-08-03T10:00:00Z"] }),
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
const salud = (m: Record<string, { estado?: string; cruzados?: string[]; entregados?: number | null }>) =>
  new Map(Object.entries(m));

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
  }));
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
  const sinClamp = await planDelDia({ ...args, pg: pgFalso({ medidos, historial }) });
  assert.equal(conClamp.dominios[0]!.decision.cupo, 6, "3× lo autorizado hace 2 días");
  assert.ok(sinClamp.dominios[0]!.decision.cupo > conClamp.dominios[0]!.decision.cupo, "y sin el dato, la rampa entera");
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
