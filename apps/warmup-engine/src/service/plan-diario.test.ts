// Tests del plan del día. Lo que protegen es la ASIMETRÍA que costó un bug: una medición vencida
// sirve para elegir a quién intentarle, pero NO para decidir cuánto mandar. Tratar los dos casos
// igual hizo que el daemon se apagara solo teniendo un nodo con cupo, y en la versión anterior que
// decidiera volumen sobre un cap 2000 que ya no existía.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { elegirPool, leerCuposFisicos, planDelDia, type MedicionCupos } from "./plan-diario.ts";

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

test("flota entera en cap 0: pool VACÍO, no un fallback que rebote 58 veces", () => {
  const r = elegirPool(medicion({ porDominio: new Map([["a.com", 0], ["b.com", 0]]) }), ["configurado.com"]);
  assert.deepEqual(r.boxes, []);
  // El texto cambió al agregarse la exclusión por salud: ahora distingue "todos en cap 0" de
  // "tienen cupo pero no sirven". Los dos casos terminan en pool vacío, y el motivo dice cuál es.
  assert.match(r.motivo, /están todos en cap 0/);
});

// ── El plan completo ─────────────────────────────────────────────────────────────────────────────

/** Postgres falso: responde por la forma de la consulta. */
function pgFalso(filas: { medidos?: string[]; enviadosHoy?: number; historial?: string[]; rebotes?: string[] }) {
  return {
    async query(sql: string) {
      if (sql.includes("kind = 'measured'")) return { rows: (filas.medidos ?? []).map((placement) => ({ placement })) };
      if (sql.includes("COUNT(*)::int")) return { rows: [{ node_domain: "a.com", n: filas.enviadosHoy ?? 0 }] };
      if (sql.includes("kind = 'error'")) return { rows: (filas.rebotes ?? []).map((d) => ({ node_domain: d })) };
      if (sql.includes("seed_inbox, occurred_at")) {
        return { rows: (filas.historial ?? []).map((cuando) => ({ node_domain: "a.com", seed_inbox: "s@x.com", occurred_at: new Date(cuando) })) };
      }
      return { rows: [] };
    }
  } as never;
}

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
  assert.equal(d.decision.accion, "subir");
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
  assert.match(r.motivo, /2 de 3 nodos aptos/);
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
    for (const linea of sql.split("\n").filter(Boolean)) {
      assert.match(linea, /date_trunc\('day', now\(\), 'UTC'\)/, `${f}: ventana sin zona explícita → ${linea.trim()}`);
    }
  }
});
