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

/** El nodo que Gmail cerro: 56 rechazos 550-5.7.1 y cero entregas. Es la foto de controlstatecorp.com. */
const NODO_CERRADO = `## DELIVERED
## OWN_DELIVERED
## BLOCKED
     56 gmail.com
## OWN_BLOCKED
     56 gmail.com
## DEFERRED
## OWN_DEFERRED
## END`;

/** El MISMO nodo cuatro dias despues, cuando el otro inquilino dejo de inyectar: el log vacio. */
const NODO_MUDO = `## DELIVERED
## OWN_DELIVERED
## BLOCKED
## OWN_BLOCKED
## DEFERRED
## OWN_DEFERRED
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

test("un CIERRE del receptor no se borra porque el nodo se quedo callado", async () => {
  // EL AGUJERO QUE SE ABRE SOLO, y tiene fecha. `estado`, `cerradoEn` y `porReceptor` se recalculan
  // ENTEROS en cada barrido sobre una ventana de 5 dias por fecha de linea; lo unico pegajoso era
  // `cruzados`. Asi que un nodo que DEJA de mandar vuelve solo a `no_traffic` 0/0/0 con
  // `cerradoEn: []`, o sea que se auto-absuelve por el paso del tiempo.
  //
  // No es teorico: NFC dejo de inyectar por el /24 80.190.73.x el 2026-08-05, asi que alrededor del
  // 9-11 de agosto sus TRES nodos pasan solos a `no_traffic` — y `no_traffic` es justo la puerta por
  // la que `elegirPool` deja entrar a los dominios NUEVOS (esta el test del otro lado en
  // plan-diario.test.ts). controlstatecorp.com tiene 56 rechazos 550-5.7.1 de Gmail de hace cuatro
  // dias y quedaria leido como "nodo nuevo, candidato natural a arrancar". Y ya paso una vez:
  // nationalfiling-infra.com estuvo en el pool el 2026-08-05 y mando un correo real.
  const dir = await mkdtemp(join(tmpdir(), "medicion-cerrado-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  const bandejas = [{ domain: "controlstatecorp.com", serverSlug: "n1", serverIp: "1.1.1.1" }];

  const primera = await medirFlota({
    workspace: ws,
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_CERRADO)),
    bandejas, libro: "todo", now: () => ahora
  });
  assert.deepEqual(primera.bandejas[0]?.cerradoEn, ["gmail.com"], "el barrido lo ve cerrado");

  // Cuatro dias despues el log esta vacio: el receptor no cambio de opinion, el nodo dejo de hablar.
  const segunda = await medirFlota({
    workspace: ws,
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_MUDO)),
    bandejas, libro: "todo", now: () => ahora
  });
  assert.equal(segunda.bandejas[0]?.estado, "no_traffic", "el estado SI se recalcula, y eso esta bien");
  assert.deepEqual(segunda.bandejas[0]?.cerradoEn, ["gmail.com"], "pero el cierre se arrastra: no lo borra el calendario");
  assert.deepEqual((await leerUltimaMedicion(ws))?.bandejas[0]?.cerradoEn, ["gmail.com"], "y sobrevive al archivo");
});

// ── POR QUÉ NOS CIERRAN, NO SÓLO QUIÉN ──────────────────────────────────────────────────────────

/**
 * El mismo controlstatecorp.com de arriba, pero con el texto que Gmail escribió al rechazar.
 *
 * La frase es la MEDIDA en el log real (1.512 apariciones en 193.181.212.223 el 2026-08-08), no una
 * inventada de la documentación de Google: un fixture escrito desde mi suposición del formato prueba
 * que el código coincide conmigo, no que coincida con el nodo. El formato de la sección es el que
 * deja el pipeline del comando — `<cuenta> <receptor>\t<status>\t<motivo>`.
 */
const NODO_CERRADO_CON_MOTIVO = `## DELIVERED
## OWN_DELIVERED
## BLOCKED
     56 gmail.com
## OWN_BLOCKED
     56 gmail.com
## DEFERRED
## OWN_DEFERRED
## CULPA
     56 gmail.com\tbounced\t550-5.7.1 Gmail has detected that this message is likely unsolicited mail
## END`;

test("el archivo dice POR QUE nos cierra el receptor, no solo quien", async () => {
  // EL DATO SE CALCULABA CADA 6 HORAS EN LOS 58 NODOS Y SE TIRABA. `readNodeDeliveryHealth` clasifica
  // cada texto de rechazo en dominio/ip/buzon/no-se y lo publica en su veredicto; este mapeador —el
  // unico que persiste— lo omitia. Medido sobre la copia de produccion del 2026-08-08: 0 de 58
  // bandejas lo traen. Consecuencia exacta: el archivo podia decir "cerrado en gmail.com" y NO tenia
  // con que contestar la pregunta que cuesta plata — ¿es la IP, es el dominio, o son buzones que no
  // existen? Esa es la diferencia entre "compra un dominio nuevo" y "no gastes un peso", y sin este
  // campo solo se contesta abriendo el mail.log crudo del nodo por SSH.
  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_CERRADO_CON_MOTIVO)),
    domain: "controlstatecorp.com",
    serverSlug: "n1",
    serverIp: "1.1.1.1",
    propios: "todo"
  });

  assert.deepEqual(m.cerradoEn, ["gmail.com"], "QUIEN nos cierra: eso ya se sabia");
  // Y POR QUE. `dominio` es el veredicto caro: dice que un dominio nuevo sobre esta misma IP SI
  // cambia algo, al reves de lo que diria un `ip`.
  assert.deepEqual(m.culpaPorProveedor, { "gmail.com": "dominio" });
});

test("si el nodo no se pudo leer, la culpa es {} y la clave NUNCA se omite", async () => {
  // ESTA ES LA ASERCION QUE IMPORTA DE LAS DOS. Un bloque ausente se lee como "esta todo bien", y
  // esa confusion ya costo caro dos veces con nombre y fecha: los 38 nodos cerrados por el receptor
  // leidos como sanos (2026-07-25), y el 2026-08-06, cuando `encolados` salio `undefined` en cinco
  // de los seis `return`, JSON.stringify borro la clave y 49 de 58 bandejas quedaron sin el dato sin
  // que nada se pusiera rojo. Un `{}` explicito dice "lo mire y no hay"; la clave ausente no dice
  // nada y el que lee completa con lo que le conviene.
  const m = await medirBandeja({
    sshRunner: runner(() => new Error("ssh caido")),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4",
    propios: "todo"
  });

  assert.equal(m.estado, "unreadable");
  assert.deepEqual(m.culpaPorProveedor, {});
  // Y sobrevive al viaje por el archivo, que es donde `undefined` desaparece sin ruido: la clave
  // tiene que seguir estando del otro lado del JSON.
  assert.ok("culpaPorProveedor" in (JSON.parse(JSON.stringify(m)) as object), "JSON.stringify se come las claves undefined");
});

test("el receptor que DECIDIO el veredicto no se puede caer por el piso de tamano", async () => {
  // UN ARRAY VACIO QUE SE LEE COMO CERO. `porReceptor` se filtra a 20 intentos porque es un techo de
  // TAMANO DE ARCHIVO —`byProvider` no tiene tope de filas y el panel sirve el JSON entero—, pero ese
  // techo no puede tapar al receptor sobre el que el veredicto YA se pronuncio: ahi `[]` se lee como
  // "no mando nada" cuando lo que dice es "no llego al piso".
  //
  // EL CASO, reproducido por el camino de produccion el 2026-08-08 con lineas crudas del mail.log de
  // corpfilingcontrol.com: 1 entrega y 9 rechazos 550-5.7.1 de Gmail. Son 10 intentos, la MITAD del
  // piso, asi que la fila se filtraba siempre — y es justo el receptor que dispara el veto
  // `insufficient_sample`. O sea que el archivo publicaba el estado nuevo sin UN solo numero que lo
  // respaldara, y `cruzarEntregaConPlacement` imprimia "nuestro MTA no reporta gmail.com en la
  // ventana ... el cruce no se puede hacer" sobre el receptor que nos estaba cerrando la puerta.
  //
  // Con nuestro volumen (~2 correos/dia por dominio) el piso de 20 es INALCANZABLE para los nuestros:
  // sin esta excepcion la fila no aparece nunca, no "casi nunca".
  const SALIDA = `## DELIVERED
      1 gmail.com
      3 cola-larga-de-nfc.com
## OWN_DELIVERED
      1 gmail.com
      3 cola-larga-de-nfc.com
## BLOCKED
      9 gmail.com
## OWN_BLOCKED
      9 gmail.com
## DEFERRED
## OWN_DEFERRED
## END`;

  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : SALIDA)),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4",
    propios: "todo"
  });

  assert.equal(m.estado, "insufficient_sample", "10 intentos con 90% de rechazo: no se si esta cerrado, y eso NO es estar sano");
  assert.deepEqual(
    m.porReceptor?.find((p) => p.receptor === "gmail.com"),
    { receptor: "gmail.com", entregados: 1, rechazados: 9, diferidos: 0 },
    "el receptor que decidio el veredicto tiene que traer su numero"
  );
  // Y LA COLA LARGA DE NFC SIGUE FILTRADA, que es lo que mantiene acotado el archivo: la excepcion es
  // para los receptores que decidieron algo, no un piso mas bajo para todos.
  assert.equal(m.porReceptor?.find((p) => p.receptor === "cola-larga-de-nfc.com"), undefined, "3 intentos y ningun veredicto: no entra");
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
