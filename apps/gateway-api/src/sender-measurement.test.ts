// Tests de la corrida de medicion.
//
// Lo que protegen: que ninguna forma de fallar termine pareciendose a un nodo sano.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import {
  MEASUREMENT_FILE,
  leerLibroPropio,
  leerUltimaMedicion,
  medirBandeja,
  medirFlota,
  type LibroPropio,
  type MedicionFlota
} from "./sender-measurement.ts";
import type { PgClient } from "../../warmup-engine/src/store/pg-stores.ts";

const ahora = new Date("2026-07-30T18:00:00.000Z");

/** Salida real de un nodo con la cola atascada: el caso que el modulo viejo leia como sano. */
const NODO_ATASCADO = `## DELIVERED
## OWN_DELIVERED
## BLOCKED
## OWN_BLOCKED
## DEFERRED
    920 comcast.net
## OWN_DEFERRED
    920 comcast.net
## END`;

const NODO_SANO = `## DELIVERED
   1500 gmail.com
## OWN_DELIVERED
   1500 gmail.com
## BLOCKED
      5 comcast.net
## OWN_BLOCKED
      5 comcast.net
## DEFERRED
     30 gmail.com
## OWN_DEFERRED
     30 gmail.com
## END`;

/** El libro vacío: se midió atribuyendo, y no había un solo envío nuestro. */
const SIN_LIBRO: LibroPropio = { queueIdsPorDominio: new Map(), ultimoEnvioPorDominio: new Map() };

const VOLUMEN = `## VOLUME
   3651 Jul 30\tgmail.com
## END`;

function runner(porComando: (command: string) => string | Error) {
  return {
    async run(input: { command: string }) {
      const out = porComando(input.command);
      if (out instanceof Error) throw out;
      return { stdout: out, exitCode: 0 };
    }
  };
}

test("una bandeja con la cola atascada NO se mide como sana", async () => {
  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_ATASCADO)),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4",
    propios: "todo"
  });

  assert.equal(m.estado, "stalled");
  assert.equal(m.diferidos, 920);
  assert.match(m.detalle, /la cola se acumula/);
});

test("si no se puede leer el nodo, los contadores son null y NO cero", async () => {
  const m = await medirBandeja({
    sshRunner: runner(() => new Error("ssh caido")),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4",
    propios: "todo"
  });

  assert.equal(m.estado, "unreadable");
  assert.equal(m.entregados, null);
  assert.equal(m.rechazados, null);
  assert.equal(m.diferidos, null, "un cero aca se leeria como 'no rebota nada'");
});

test("el pico contra el umbral permanente viaja con la medicion", async () => {
  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_SANO)),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4",
    propios: "todo"
  });

  const google = m.picos.find((p) => p.familia === "google");
  assert.equal(google?.mensajes, 3_651);
  assert.equal(google?.umbral, 5_000);
  assert.equal(google?.ratio, 0.73);
  assert.deepEqual(m.cerca, ["google"], "73% ya avisa");
  assert.deepEqual(m.cruzados, []);
});

test("porReceptor SOBREVIVE a la persistencia y esta ACOTADO", async () => {
  // INCIDENTE QUE FIJA (2026-08-06): 36 de 58 bandejas cerradas por el receptor, y el archivo solo
  // guardaba QUIEN cierra (`cerradoEn`) mas los totales globales. El clasificador YA calculaba
  // `byProvider` y el persistidor lo tiraba entero. Dos cosas quedaban sin respuesta:
  //   · cuanto correo seguia entregando cada bandeja por las OTRAS puertas, que es lo unico que
  //     dice si frenarla cuesta correo de cliente. La decision se tomaba a ciegas sobre 36 nodos.
  //   · si Yahoo o Apple estaban difiriendo: el bloqueo se detecta SOLO por rebotes 5xx y Yahoo
  //     tipicamente DIFIERE con 4xx, que no alimenta `cerradoEn`. Asi "Yahoo no aparece en ninguna
  //     de las 58" se leyo como "Yahoo no nos bloquea" — ausencia de instrumento, no evidencia.
  // La forma real de una de las 36: cerrada en Google (195 rechazos sobre 200 intentos = 97%) pero
  // entregando 400 por Comcast. Ese 400 es el numero que decide si frenarla cuesta correo o no.
  const SALIDA = `## DELIVERED
      5 gmail.com
    400 comcast.net
      1 diminuto.com
## OWN_DELIVERED
      5 gmail.com
    400 comcast.net
      1 diminuto.com
## BLOCKED
    195 gmail.com
      2 diminuto.com
## OWN_BLOCKED
    195 gmail.com
      2 diminuto.com
## DEFERRED
    300 yahoo.com
## OWN_DEFERRED
    300 yahoo.com
## END`;

  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : SALIDA)),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4",
    propios: "todo"
  });

  const gmail = m.porReceptor?.find((p) => p.receptor === "gmail.com");
  assert.deepEqual(gmail, { receptor: "gmail.com", entregados: 5, rechazados: 195, diferidos: 0 });
  // La pregunta que antes no se podia contestar sobre ninguna de las 36: cuanto sigue entregando
  // por las OTRAS puertas. `cerradoEn` decia "gmail.com" y los totales decian 405 entregados, pero
  // nada decia que esos 405 eran casi todos de Comcast.
  assert.deepEqual(
    m.porReceptor?.find((p) => p.receptor === "comcast.net"),
    { receptor: "comcast.net", entregados: 400, rechazados: 0, diferidos: 0 }
  );

  // EL CASO YAHOO, el que motiva todo el campo: rechazados 0 y aun asi tiene que estar. Un receptor
  // que solo difiere es invisible para `cerradoEn` por definicion.
  const yahoo = m.porReceptor?.find((p) => p.receptor === "yahoo.com");
  assert.deepEqual(yahoo, { receptor: "yahoo.com", entregados: 0, rechazados: 0, diferidos: 300 });
  assert.deepEqual(m.cerradoEn, ["gmail.com"], "yahoo difiere: NO figura como cerrado, y esa es la trampa");

  // El filtro por BLOCKED_MIN_ATTEMPTS (20) no es cosmetico: `byProvider` no tiene techo de filas y
  // 58 bandejas por cientos de receptores inflarian el JSON que el panel sirve entero. Abajo de 20
  // intentos el propio clasificador se niega a emitir veredicto, asi que no hay decision que tomar.
  assert.equal(m.porReceptor?.find((p) => p.receptor === "diminuto.com"), undefined, "3 intentos no entran");
});

test("la medicion declara su cobertura: pedidas vs leidas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "medicion-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  let n = 0;

  const flota = await medirFlota({
    workspace: ws,
    // La segunda bandeja no se puede leer: la cobertura tiene que delatarlo.
    sshRunner: runner(() => (++n > 2 ? new Error("nodo caido") : NODO_SANO)),
    bandejas: [
      { domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" },
      { domain: "b.com", serverSlug: "n2", serverIp: "2.2.2.2" }
    ],
    concurrency: 1,
    libro: "todo",
    now: () => ahora
  });

  assert.equal(flota.pedidas, 2);
  assert.equal(flota.leidas, 1, "la cobertura no se infla");
  assert.equal(flota.bandejas.length, 2, "la que fallo igual aparece, marcada");
});

test("la medicion se persiste y se puede releer sin volver a la flota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "medicion-p-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });

  assert.equal(await leerUltimaMedicion(ws), null, "nunca medido NO es todo en cero");

  await medirFlota({
    workspace: ws,
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_SANO)),
    bandejas: [{ domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" }],
    libro: "todo",
    now: () => ahora
  });

  const leida = await leerUltimaMedicion(ws);
  assert.equal(leida?.medidoEn, ahora.toISOString());
  assert.equal(leida?.bandejas[0]?.domain, "a.com");
});

test("una bandeja que revienta no tumba la corrida ni cuenta como sana", async () => {
  const dir = await mkdtemp(join(tmpdir(), "medicion-e-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });

  const flota = await medirFlota({
    workspace: ws,
    sshRunner: { async run() { throw new Error("boom"); } },
    bandejas: [
      { domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" },
      { domain: "b.com", serverSlug: "n2", serverIp: "2.2.2.2" }
    ],
    libro: "todo",
    now: () => ahora
  });

  assert.equal(flota.leidas, 0);
  assert.ok(flota.bandejas.every((b) => b.estado === "unreadable"));
});

// ── NUESTRO CORREO vs EL DE NFC ─────────────────────────────────────────────────────────────────

test("leerLibroPropio: saca el queue-id de la respuesta de Postfix y agrupa por dominio", async () => {
  // INCIDENTE MEDIDO 2026-08-06 contra la Postgres de produccion: de 36 envios nuestros en 7 dias,
  // solo 24 traian queue-id (33% sin clave de union con el log del nodo). El libro tiene que
  // IGNORAR esas filas — no adivinarlas — porque un id inventado atribuiria correo de NFC a
  // nosotros, que es el error que va en la direccion peligrosa.
  //
  // Las filas son textuales de produccion: `250 2.0.0 Ok: queued as C921D46D53`.
  const consultas: string[] = [];
  const pg: PgClient = {
    async query(text: string) {
      consultas.push(text);
      if (text.includes("MAX(occurred_at)")) {
        return {
          rows: [{ node_domain: "CorpFiling-Infra.com", ultimo: new Date("2026-08-06T17:53:53.937Z") }],
          rowCount: 1
        } as any;
      }
      return {
        rows: [
          { node_domain: "corpfiling-infra.com", smtp: "250 2.0.0 Ok: queued as B7CA03F69F" },
          { node_domain: "CorpFiling-Infra.com", smtp: "250 2.0.0 Ok: queued as 42F6C3F69D" },
          { node_domain: "nationalfiling-infra.com", smtp: "250 2.0.0 Ok: queued as C921D46D53" },
          // Los nodos con enable_long_queue_ids escriben base-52: si el patron fuera solo hex,
          // esos nodos quedarian sin libro y por lo tanto en `no_own_traffic` para siempre.
          { node_domain: "opscorpfiling.com", smtp: "250 2.0.0 Ok: queued as 4bXyZ9Qm2Rz1kT" },
          // Un envio registrado SIN respuesta del nodo: no se puede unir con nada.
          { node_domain: "opscorpfiling.com", smtp: null }
        ],
        rowCount: 5
      } as any;
    }
  };

  const libro = await leerLibroPropio(pg, 5);
  assert.deepEqual(libro.queueIdsPorDominio.get("corpfiling-infra.com"), ["B7CA03F69F", "42F6C3F69D"], "el dominio se normaliza a minusculas");
  assert.deepEqual(libro.queueIdsPorDominio.get("nationalfiling-infra.com"), ["C921D46D53"]);
  assert.deepEqual(libro.queueIdsPorDominio.get("opscorpfiling.com"), ["4bXyZ9Qm2Rz1kT"], "la fila sin smtp se ignora, no se inventa");
  assert.equal(libro.ultimoEnvioPorDominio.get("corpfiling-infra.com"), "2026-08-06T17:53:53.937Z");

  // La ventana del libro es `dias + 2` por el `maximal_queue_lifetime = 2d` del nodo: un mensaje
  // encolado ANTES del borde sigue escribiendo lineas status= adentro de la ventana.
  assert.match(consultas[0]!, /make_interval/);
});

test("FAIL-CLOSED: sin libro no se reescribe la medicion de produccion", async () => {
  // INCIDENTE QUE PREVIENE: si un fallo de Postgres devolviera un libro VACIO en vez de tirar, se
  // atribuirian CERO mensajes nuestros en los 58 nodos, la flota entera pasaria a `no_own_traffic`
  // y el archivo publicaria eso como si lo hubiera medido. Un archivo viejo con su `medidoEn`
  // envejecido — que el panel ya sabe mostrar — es infinitamente mejor que uno nuevo con una
  // atribucion inventada.
  const dir = await mkdtemp(join(tmpdir(), "medicion-fc-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });

  // La medicion anterior, la que tiene que sobrevivir intacta.
  await medirFlota({
    workspace: ws,
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_SANO)),
    bandejas: [{ domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" }],
    libro: "todo",
    now: () => ahora
  });
  const antes = await leerUltimaMedicion(ws);

  const pgCaido: PgClient = { async query() { throw new Error("connection terminated unexpectedly"); } };
  await assert.rejects(
    async () => {
      const libro = await leerLibroPropio(pgCaido, 5);
      await medirFlota({
        workspace: ws,
        sshRunner: runner(() => NODO_SANO),
        bandejas: [{ domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" }],
        libro,
        now: () => new Date("2026-08-06T20:00:00.000Z")
      });
    },
    /connection terminated/,
    "leerLibroPropio NO puede atrapar el error y devolver un libro vacio"
  );

  const despues = await ws.readInventoryJson<MedicionFlota>(MEASUREMENT_FILE);
  assert.deepEqual(despues, antes, "el archivo de produccion quedo como estaba");
});

test("el veredicto se decide con NUESTRO correo, y lo de NFC viaja aparte", async () => {
  // INCIDENTE QUE FIJA (2026-08-06): annualcorp-control.com se publicaba como "cerrado en gmail:
  // 136 rechazos sobre 137 intentos" y 135 de esos rechazos eran de NFC. Sobre esa evidencia se
  // decidio que 36 de 58 nodos estaban cerrados por el receptor.
  //
  // Acá el nodo movió 136 rechazos y 1 entrega; lo nuestro es 1 rechazo y 1 entrega.
  const SALIDA = `## DELIVERED
      1 gmail.com
## OWN_DELIVERED
      1 gmail.com
## BLOCKED
    136 gmail.com
## OWN_BLOCKED
      1 gmail.com
## DEFERRED
## OWN_DEFERRED
## END`;

  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : SALIDA)),
    domain: "annualcorp-control.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4",
    propios: ["B7CA03F69F", "C921D46D53"],
    ultimoEnvioNuestro: "2026-08-05T17:33:59.096Z"
  });

  assert.notEqual(m.estado, "blocked_by_provider", "2 intentos nuestros no alcanzan para acusar a Gmail");
  assert.deepEqual(m.cerradoEn, [], "el `cerradoEn` que frenaba el dominio era de otro producto");
  assert.equal(m.entregados, 1);
  assert.equal(m.rechazados, 1);
  assert.deepEqual(m.ajeno, { entregados: 0, rechazados: 135, diferidos: 0 }, "lo de NFC se ve, pero no decide");
  assert.deepEqual(m.atribucion, { modo: "nuestro", queueIds: 2, descartados: 0 });
  assert.equal(m.ultimoEnvioNuestro, "2026-08-05T17:33:59.096Z");

  // Y el sensor del umbral permanente NO se atribuye: sigue contando TODO el trafico del nodo.
  // El receptor cuenta por dominio+IP y no le importa quien inyecto.
  assert.deepEqual(m.cerca, ["google"], "los picos son del nodo entero, a proposito");
});

test("medirFlota reparte el libro por dominio, y un dominio sin libro NO cae en 'todo'", async () => {
  // El fallback peligroso: si un dominio sin entrada en el libro se midiera con `propios: "todo"`,
  // el correo de NFC volveria a contarse como nuestro justo en los nodos con mas ruido ajeno.
  const dir = await mkdtemp(join(tmpdir(), "medicion-libro-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  // El nodo cuenta la sección OWN con los ids que le mandamos DENTRO del comando, así que el runner
  // falso mira el comando: si no llegó el id, no hay nada nuestro. Un fixture que devolviera lo
  // mismo para los dos dominios no probaría el reparto — probaría el fixture.
  const salida = (nuestros: number): string => `## DELIVERED
   1500 gmail.com
## OWN_DELIVERED
${nuestros > 0 ? `      ${nuestros} gmail.com` : ""}
## BLOCKED
## OWN_BLOCKED
## DEFERRED
## OWN_DEFERRED
## END`;

  const flota = await medirFlota({
    workspace: ws,
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : salida(c.includes("B7CA03F69F") ? 3 : 0))),
    bandejas: [
      { domain: "Corpfiling-Infra.com", serverSlug: "n1", serverIp: "1.1.1.1" },
      { domain: "ajeno.com", serverSlug: "n2", serverIp: "2.2.2.2" }
    ],
    libro: {
      queueIdsPorDominio: new Map([["corpfiling-infra.com", ["B7CA03F69F"]]]),
      ultimoEnvioPorDominio: new Map([["corpfiling-infra.com", "2026-08-06T17:53:53.937Z"]])
    },
    concurrency: 1,
    now: () => ahora
  });

  const conLibro = flota.bandejas.find((b) => b.domain === "Corpfiling-Infra.com")!;
  assert.equal(conLibro.atribucion?.queueIds, 1, "el libro se busca en minusculas");
  assert.equal(conLibro.entregados, 3, "lo nuestro, no los 1500 del nodo");
  assert.equal(conLibro.ultimoEnvioNuestro, "2026-08-06T17:53:53.937Z");

  const sinLibro = flota.bandejas.find((b) => b.domain === "ajeno.com")!;
  assert.equal(sinLibro.atribucion?.modo, "nuestro", "sin libro NO se degrada a 'todo'");
  assert.equal(sinLibro.atribucion?.queueIds, 0);
  assert.equal(sinLibro.estado, "no_own_traffic", "el nodo movio correo y nada era nuestro");
  assert.equal(sinLibro.ultimoEnvioNuestro, null, "nunca le mandamos: onboardearlo es decision del operador");
});

test("--seco: medir sin reescribir el archivo de produccion", async () => {
  // Es la pantalla que el operador mira ANTES de dejar que una corrida normal pise la medicion.
  const dir = await mkdtemp(join(tmpdir(), "medicion-seco-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });

  const flota = await medirFlota({
    workspace: ws,
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_SANO)),
    bandejas: [{ domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" }],
    libro: SIN_LIBRO,
    persistir: false,
    now: () => ahora
  });

  assert.equal(flota.bandejas.length, 1, "midio igual");
  assert.equal(await leerUltimaMedicion(ws), null, "y no escribio nada");
});
