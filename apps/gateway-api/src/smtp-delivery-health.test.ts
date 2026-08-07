import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { utimesSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COLA_ATASCADA_MIN,
  DELIVERY_STATS_WINDOW,
  MAX_QUEUE_IDS,
  assessDeliveryHealth,
  buildDeliveryStatsCommand,
  parseDeliveryStats,
  parseLineasSinFecha,
  parseQueueSize,
  prefijosDeDias,
  readNodeDeliveryHealth,
  sanearIds,
  type DeliveryHealthSshRunner,
  type NodeDeliveryStats
} from "./smtp-delivery-health.ts";

/** El "hoy" de los fixtures. Fijo para que la ventana por fecha no dependa del día del calendario. */
const HOY = new Date("2026-08-06T12:00:00Z");

type Filas = Array<[number, string]>;

/**
 * Salida sintética del nodo. Cuando no se declara `own`, el fixture es modo "todo": lo propio ES el
 * total, que es exactamente lo que devuelve el comando cuando se lo corre sin queue-ids.
 */
function stdout(input: {
  delivered?: Filas;
  blocked?: Filas;
  deferred?: Filas;
  own?: { delivered?: Filas; blocked?: Filas; deferred?: Filas };
  truncated?: boolean;
  /** Simula la salida de una versión vieja del comando: sin las secciones propias. */
  sinOwn?: boolean;
}): string {
  const block = (rows?: Filas): string => (rows ?? []).map(([n, d]) => `   ${n} ${d}`).join("\n");
  const own = input.own ?? { delivered: input.delivered, blocked: input.blocked, deferred: input.deferred };
  const par = (nombre: string, total?: Filas, propio?: Filas): string[] =>
    input.sinOwn
      ? [`## ${nombre}`, block(total)]
      : [`## ${nombre}`, block(total), `## OWN_${nombre}`, block(propio)];

  const lines = [
    ...par("DELIVERED", input.delivered, own.delivered),
    ...par("BLOCKED", input.blocked, own.blocked),
    ...par("DEFERRED", input.deferred, own.deferred)
  ];
  if (!input.truncated) lines.push("## END");
  return `${lines.join("\n")}\n`;
}

/** Lo NUESTRO del fixture, que es lo único que decide el veredicto. */
function propio(input: Parameters<typeof stdout>[0]): NodeDeliveryStats {
  return parseDeliveryStats(stdout(input))!.propio;
}

test("buildDeliveryStatsCommand: solo lee, no envia, y marca el fin", () => {
  const command = buildDeliveryStatsCommand("todo");
  assert.match(command, /mail\.log/);
  assert.match(command, /## END/);
  assert.equal(/set -e/.test(command), false);
  // Es una señal pasiva: no debe existir ninguna ruta de envío acá.
  assert.equal(/sendmail|smtp-source|swaks/.test(command), false);
});

test("parseDeliveryStats: agrega por proveedor y totaliza", () => {
  const stats = propio({
    delivered: [[706, "gmail.com"], [140, "yahoo.com"]],
    blocked: [[3, "gmail.com"]]
  });
  assert.equal(stats.totals.delivered, 846);
  assert.equal(stats.totals.blocked, 3);
  assert.equal(stats.byProvider[0]!.provider, "gmail.com");
  assert.equal(stats.byProvider[0]!.delivered, 706);
});

test("parseDeliveryStats: salida truncada ⇒ null (no se inventa salud)", () => {
  assert.equal(parseDeliveryStats(stdout({ delivered: [[10, "gmail.com"]], truncated: true })), null);
});

// El caso real de corp-delivery.com: entrega perfecto en yahoo/aol mientras Gmail lo
// rechaza en el 100% de los intentos. Un promedio global lo habria dado sano.
test("assessDeliveryHealth: cerrado en un proveedor aunque el resto entregue bien", () => {
  const verdict = assessDeliveryHealth(propio({
    delivered: [[1483, "yahoo.com"], [416, "aol.com"], [4, "gmail.com"]],
    blocked: [[3883, "gmail.com"]]
  }));
  assert.equal(verdict.status, "blocked_by_provider");
  assert.deepEqual(verdict.blockedProviders, ["gmail.com"]);
  assert.match(verdict.detail, /gmail\.com/);
});

test("assessDeliveryHealth: nodo sano con volumen real a gmail", () => {
  const verdict = assessDeliveryHealth(propio({
    delivered: [[706, "gmail.com"], [140, "yahoo.com"], [35, "aol.com"]]
  }));
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(verdict.blockedProviders, []);
});

test("assessDeliveryHealth: rechazo parcial ⇒ degraded", () => {
  const verdict = assessDeliveryHealth(propio({
    delivered: [[60, "gmail.com"]],
    blocked: [[40, "gmail.com"]]
  }));
  assert.equal(verdict.status, "degraded");
  assert.deepEqual(verdict.degradedProviders, ["gmail.com"]);
});

test("assessDeliveryHealth: pocos intentos no alcanzan para acusar bloqueo", () => {
  const verdict = assessDeliveryHealth(propio({ blocked: [[3, "gmail.com"]] }));
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(verdict.blockedProviders, []);
});

// Los nodos MAS sanos aparecian "cerrados en su propio dominio": son los rebotes que
// Postfix se manda a si mismo (postmaster, notificaciones de no-entrega), no un proveedor.
test("assessDeliveryHealth: los rebotes al propio dominio no cuentan como bloqueo", () => {
  const stats = propio({
    delivered: [[4944, "gmail.com"]],
    blocked: [[120, "infranationalreport.com"]]
  });
  assert.equal(assessDeliveryHealth(stats).status, "blocked_by_provider");
  assert.equal(assessDeliveryHealth(stats, "infranationalreport.com").status, "healthy");
});

test("assessDeliveryHealth: excluir el propio dominio no tapa un bloqueo real de proveedor", () => {
  const stats = propio({
    delivered: [[500, "yahoo.com"]],
    blocked: [[300, "gmail.com"], [40, "propio.com"]]
  });
  const verdict = assessDeliveryHealth(stats, "propio.com");
  assert.equal(verdict.status, "blocked_by_provider");
  assert.deepEqual(verdict.blockedProviders, ["gmail.com"]);
});

test("assessDeliveryHealth: sin trafico ⇒ no_traffic, no 'sano'", () => {
  const verdict = assessDeliveryHealth(propio({}));
  assert.equal(verdict.status, "no_traffic");
});

// El falso negativo peligroso: si no se pudo leer, NO puede decir "sano".
test("readNodeDeliveryHealth: SSH que falla ⇒ unreadable, nunca healthy", async () => {
  const sshRunner: DeliveryHealthSshRunner = {
    run: async () => { throw new Error("SSH command failed with exit 255.\nPermission denied (publickey)."); }
  };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "server60", serverIp: "10.0.0.1", propios: "todo" });
  assert.equal(verdict.status, "unreadable");
  assert.match(verdict.detail, /lectura fallida/);
});

test("readNodeDeliveryHealth: propaga serverSlug (el runner elige usuario y sudo)", async () => {
  const seen: Array<string | null | undefined> = [];
  const sshRunner: DeliveryHealthSshRunner = {
    run: async (input) => {
      seen.push(input.serverSlug);
      return { stdout: stdout({ delivered: [[100, "gmail.com"]] }), exitCode: 0 };
    }
  };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "server60", serverIp: "10.0.0.1", propios: "todo" });
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(seen, ["server60"]);
});

// --- el diferido cuenta: era el agujero mas grande del modulo ---------------

test("un nodo que difiere casi todo NO es 'sin trafico' ni 'sano'", () => {
  // Medido en la flota el 2026-07-30: 2.193 diferidos contra 1.504 entregados hacia Gmail en un
  // solo dia, y ~14.000 mensajes atascados. `attempts` era delivered+blocked, asi que deferred
  // no existia para el veredicto: un nodo con la cola llena y cero entregas caia en `no_traffic`
  // — "el nodo no registra trafico saliente" — que es lo contrario exacto de lo que pasa.
  const verdict = assessDeliveryHealth({
    totals: { delivered: 0, blocked: 0, deferred: 920 },
    byProvider: [{ provider: "comcast.net", delivered: 0, blocked: 0, deferred: 920 }]
  });

  assert.equal(verdict.status, "stalled");
  assert.match(verdict.detail, /920 diferidos/);
  assert.match(verdict.detail, /la cola se acumula/);
});

test("no_traffic queda SOLO para el log realmente vacio", () => {
  const verdict = assessDeliveryHealth({
    totals: { delivered: 0, blocked: 0, deferred: 0 },
    byProvider: []
  });
  assert.equal(verdict.status, "no_traffic");
  assert.match(verdict.detail, /ni diferidos/);
});

test("algo de diferido con entregas sanas NO dispara stalled", () => {
  // 30% diferido es normal en correo: reintentos transitorios. El freno es para el 50%+.
  const verdict = assessDeliveryHealth({
    totals: { delivered: 700, blocked: 0, deferred: 300 },
    byProvider: [{ provider: "gmail.com", delivered: 700, blocked: 0, deferred: 300 }]
  });
  assert.equal(verdict.status, "healthy");
});

test("el veredicto declara SIEMPRE que ventana cubre, y son los días que leyó de verdad", () => {
  // La etiqueta vieja decía que los números eran del log entero retenido. Con la ventana acotada eso
  // pasó a ser falso, y no es una etiqueta cualquiera: este mismo string viaja al campo `ventana` de
  // sender-measurement.json, a GET /v1/sender-measurement y a la tool read_sender_measurement del
  // agente. O sea que el modelo decidía sobre un rótulo que no describía el número. Números de N
  // días vendidos como el log completo son un mock servido como medición.
  const verdict = assessDeliveryHealth({ totals: { delivered: 10, blocked: 0, deferred: 0 }, byProvider: [] });
  assert.equal(verdict.window, DELIVERY_STATS_WINDOW);
  assert.match(verdict.window, /últimos \d+ días/);
  assert.doesNotMatch(verdict.window, /log completo/);
});

// ── El sensor mide HOY, no "alguna vez" ─────────────────────────────────────────────────────────

test("el comando REAL contra un log de fixture: reintentos y rotados viejos no condenan al nodo", async (t) => {
  // El único test que corre por el camino de producción: se ejecuta el mismo string que se manda por
  // SSH, con bash, contra archivos de verdad. Es la lección del fixture de Bedrock — un test escrito
  // sobre mi suposición de cómo se ve la salida comparte el error con el código y no salva de nada.
  //
  // Fija cuatro reglas de una sola vez, y las cuatro fallaban antes:
  //  (1) 16 líneas status=deferred del MISMO queue-id son UN mensaje, no 16 intentos. Ese 16x de
  //      inflación es lo que empujaba el ratio de diferidos arriba del 50% y dejaba 29 de 58 nodos
  //      en `stalled` para siempre.
  //  (2) un mail.log.9 con 900 diferidos fechados "Aug 6" pero rotado hace 12 meses NO entra: no se
  //      ABRE, así que su texto de día no puede contarse como de hoy. El año fantasma lo cierra el
  //      sistema de archivos, no un parser de fechas.
  //  (3) las 3 entregas se cuentan en los 3 formatos que hay en la flota de verdad — syslog,
  //      ISO-8601 de los 12 nodos Webdock, y queue-id largo base-52. Atarse al formato syslog dejaba
  //      ciegos a los Webdock, que es el peor caso: pasarían a "sin tráfico".
  //  (4) la salida sigue siendo `<n> <dominio>`, así que parseDeliveryStats no se enteró de nada.
  //
  // Con este mismo insumo, el comando viejo daba `stalled`.
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-maillog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const reintentos = Array.from({ length: 16 }, (_, i) =>
    `Aug  6 0${i % 8}:1${i % 10}:00 nodo postfix/smtp[1234]: A1B2C3D4E5: to=<lista@comcast.net>, relay=mx.comcast.net[68.87.20.5]:25, delay=${i}, status=deferred (host mx.comcast.net said: 421 4.7.0 too many connections)`
  );
  await writeFile(path.join(dir, "mail.log"), [
    ...reintentos,
    "Aug  6 01:02:03 nodo postfix/smtp[1234]: 9F8E7D6C5B: to=<uno@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=1.9, status=sent (250 2.0.0 OK)",
    "2026-08-06T01:02:03.123456+00:00 nodo postfix/smtp[999]: 1122334455: to=<dos@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=2.1, status=sent (250 2.0.0 OK)",
    "Aug  6 01:05:00 nodo postfix/smtp[1234]: 4bXyZ9Qm2Rz1kT: to=<tres@yahoo.com>, relay=mta7.am0.yahoodns.net[67.195.204.79]:25, delay=3.3, status=sent (250 ok dirdel)",
    ""
  ].join("\n"), "utf8");

  const rotado = path.join(dir, "mail.log.9");
  await writeFile(rotado, Array.from({ length: 900 }, (_, i) =>
    `Aug  6 03:00:00 nodo postfix/smtp[1234]: DEAD${String(i).padStart(6, "0")}: to=<viejo${i}@comcast.net>, relay=mx.comcast.net[68.87.20.5]:25, status=deferred (connect timeout)`
  ).join("\n") + "\n", "utf8");
  const haceUnAnio = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  await utimes(rotado, haceUnAnio, haceUnAnio);

  // El reloj va FIJO. Las líneas del fixture están fechadas "Aug  6", y desde que la ventana corta
  // por la fecha de la LÍNEA el test dependería del día en que se corre: verde hoy, rojo el 12 de
  // agosto. Un test que solo pasa una semana al año no es un test.
  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand("todo", 5, dir, HOY)], { encoding: "utf8" });
  const stats = parseDeliveryStats(salida)!.total;

  assert.equal(parseLineasSinFecha(salida), 0, "las 3 formas de la flota tienen que ser fechas reconocidas");
  assert.equal(stats.totals.delivered, 3, "las 3 entregas, en los 3 formatos de la flota");
  assert.equal(stats.totals.blocked, 0);
  assert.equal(stats.totals.deferred, 1, "16 reintentos del mismo queue-id son UN mensaje");
  // La máquina de test no tiene cola de Postfix: 0 si postqueue contesta, null si ni corre. Lo que
  // NO puede pasar es que invente un número, que es lo que mandaría el nodo a `stalled` de mentira.
  const encolados = parseQueueSize(salida);
  assert.ok(encolados === null || encolados === 0, `cola inventada: ${encolados}`);
  assert.equal(assessDeliveryHealth(stats, undefined, { encolados }).status, "healthy");
});

test("el MISMO insumo da el MISMO veredicto, mueva el rotado su mtime a donde lo mueva", async (t) => {
  // EL DEFECTO QUE ESTE TEST PREVIENE (2026-08-06, encontrado por QA antes del merge):
  //
  // La ventana se acotaba con `find -mtime -N`, que elige ARCHIVOS. Un rotado que se toca hoy trae
  // adentro TODO lo que acumuló desde la rotación anterior — en la flota real la rotación es SEMANAL
  // (medido en 77.37.96.101 / corpfiling-infra.com: mail.log.1 del 1/8, mail.log.2.gz del 25/7,
  // mail.log.3.gz del 18/7). O sea que la ventana era N días MÁS un ciclo entero, y oscilaba con el
  // día de la semana.
  //
  // Consecuencia medida con este mismo fixture: un nodo con 100 rechazos de Gmail hoy y CERO entregas
  // recientes se leía `healthy` con el rotado a 1 y a 4 días (la semana sana de adentro diluía el
  // ratio a 100/500 = 20%, debajo del umbral) y `blocked_by_provider` con el rotado a 6. Cinco de
  // cada siete días, un nodo genuinamente roto entraba al pool del warmup — solo, sin que nadie
  // tocara nada. Y la medición que justificaba el merge se había tomado justo el día del ciclo en que
  // el defecto no se ve.
  //
  // El arreglo: `find -mtime` sigue eligiendo archivos (barato, y cierra el año fantasma del syslog,
  // que no escribe el año), pero los DÍAS los corta el prefijo de fecha de cada línea.
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-rotacion-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // El log corriente: el nodo está CERRADO hoy.
  await writeFile(path.join(dir, "mail.log"), Array.from({ length: 100 }, (_, i) =>
    `Aug  6 01:02:03 nodo postfix/smtp[1234]: NEW${String(i).padStart(7, "0")}: to=<x${i}@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, status=bounced (host said: 550-5.7.1 unsolicited mail)`
  ).join("\n") + "\n", "utf8");
  // El rotado: la semana ANTERIOR, sana. Fuera de una ventana de 5 días termine donde termine su mtime.
  const rotado = path.join(dir, "mail.log.1");
  await writeFile(rotado, Array.from({ length: 400 }, (_, i) =>
    `Jul 30 04:05:06 nodo postfix/smtp[1234]: OLD${String(i).padStart(7, "0")}: to=<y${i}@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, status=sent (250 2.0.0 OK)`
  ).join("\n") + "\n", "utf8");

  const veredictos = [1, 4, 6].map((diasDesdeLaRotacion) => {
    const t0 = new Date(HOY.getTime() - diasDesdeLaRotacion * 86_400_000);
    utimesSync(rotado, t0, t0);
    const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand("todo", 5, dir, HOY)], { encoding: "utf8" });
    const stats = parseDeliveryStats(salida)!.total;
    return { diasDesdeLaRotacion, ...assessDeliveryHealth(stats, undefined, { encolados: 0 }) };
  });

  const distintos = new Set(veredictos.map((v) => `${v.status}|${v.stats.totals.delivered}|${v.stats.totals.blocked}`));
  assert.equal(distintos.size, 1, `el mtime del rotado cambió el veredicto: ${[...distintos].join(" ≠ ")}`);
  // Y el veredicto único es el CORRECTO: el nodo está cerrado hoy, no sano con la semana pasada.
  assert.equal(veredictos[0]!.status, "blocked_by_provider");
  assert.deepEqual(veredictos[0]!.blockedProviders, ["gmail.com"]);
  assert.equal(veredictos[0]!.stats.totals.delivered, 0, "las entregas de hace una semana no entran a una ventana de 5 días");
});

test("prefijosDeDias: cubre los dos formatos de la flota y un día de más por el huso", () => {
  // Los 12 nodos Webdock escriben ISO-8601 y el resto syslog. Un corte por fecha que solo entienda
  // uno de los dos deja al otro grupo en cero — y cero, desde el arreglo del onboarding, se lee
  // "nodo nuevo" y ENTRA al pool. El día de más (mañana) es por el reloj del nodo: la lista se genera
  // en UTC y Contabo va hasta 2h adelante; sin él se descartan las líneas MÁS nuevas.
  const p = prefijosDeDias(5, HOY);
  assert.ok(p.includes("Aug  6"), "syslog con padding de espacio");
  assert.ok(p.includes("Aug 06"), "syslog con cero");
  assert.ok(p.includes("2026-08-06"), "ISO-8601 de los Webdock");
  assert.ok(p.includes("2026-08-07"), "mañana, por el huso del nodo");
  assert.ok(p.includes("2026-08-02"), "el día más viejo de una ventana de 5");
  assert.ok(!p.includes("2026-08-01"), "un día más allá de la ventana NO entra");
});

test("un formato de fecha que el sensor no entiende se dice `unreadable`, no 'nodo nuevo'", async (t) => {
  // El filtro por prefijo es fail-OPEN hacia abajo: un tercer formato no da error, da CERO. Y cero es
  // `no_traffic`, que desde el arreglo del onboarding ENTRA al pool del warmup. Sin este seguro, un
  // nodo del que no leemos nada se calentaría creyendo que es un dominio recién comprado.
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-formato-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "mail.log"), Array.from({ length: 7 }, (_, i) =>
    `[1754500000.${i}] nodo postfix/smtp[1234]: AA${i}: to=<z${i}@gmail.com>, status=sent (250 ok)`
  ).join("\n") + "\n", "utf8");

  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand("todo", 5, dir, HOY)], { encoding: "utf8" });
  assert.equal(parseDeliveryStats(salida)!.total.totals.delivered, 0, "el corte por día no las ve (por eso hace falta el seguro)");
  assert.equal(parseLineasSinFecha(salida), 7);

  const sshRunner: DeliveryHealthSshRunner = { run: async () => ({ stdout: salida, exitCode: 0 }) };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "server60", serverIp: "10.0.0.1", propios: "todo" });
  assert.equal(verdict.status, "unreadable");
  assert.match(verdict.detail, /no es syslog ni ISO-8601/);
});

test("assessDeliveryHealth: la cola de AHORA manda sobre el log limpio", () => {
  // nationalfiling-control.com el 2026-08-06: 9.457 mensajes trabados en la cola. Con el dedup por
  // queue-id su log deja de acusarlo — los reintentos ya no cuentan como intentos distintos — y el
  // nodo entraba al pool junto con otros tres de más de siete mil. El dedup y este sensor van juntos
  // o no va ninguno; este test es el que impide mergear uno sin el otro.
  const verdict = assessDeliveryHealth(
    { totals: { delivered: 700, blocked: 0, deferred: 0 }, byProvider: [{ provider: "gmail.com", delivered: 700, blocked: 0, deferred: 0 }] },
    undefined,
    { encolados: 9457 }
  );
  assert.equal(verdict.status, "stalled");
  assert.match(verdict.detail, /9457/);
  assert.equal(verdict.encolados, 9457);
});

test("TODO veredicto declara la cola, la procedencia y lo ajeno", () => {
  // Bug encontrado midiendo la flota de verdad, no en el fixture: cinco de los seis `return` de
  // assessDeliveryHealth se habían quedado sin el campo nuevo (`encolados`). Como corremos con
  // --experimental-strip-types no hay chequeo de tipos en tiempo de ejecución, así que salía
  // `undefined`, JSON.stringify borraba la clave, y sender-measurement.json quedó con el dato en 49
  // de 58 nodos — justo el sensor que vino a decir si el nodo está atascado AHORA.
  // `undefined` es peor que `null`: `null` dice "no sé", `undefined` ni siquiera aparece.
  //
  // Con `ajenos` y `atribucion` el riesgo se triplicaba, así que ahora los siete veredictos salen de
  // un solo armador. Este test cubre los siete, incluido el nuevo `no_own_traffic`.
  const casos: Array<[string, ReturnType<typeof assessDeliveryHealth>]> = [
    ["no_traffic", assessDeliveryHealth({ totals: { delivered: 0, blocked: 0, deferred: 0 }, byProvider: [] }, undefined, { encolados: 3 })],
    ["no_own_traffic", assessDeliveryHealth(
      { totals: { delivered: 0, blocked: 0, deferred: 0 }, byProvider: [] },
      undefined,
      { encolados: 3, modo: "nuestro", total: { totals: { delivered: 90, blocked: 10, deferred: 0 }, byProvider: [] } }
    )],
    ["stalled por log", assessDeliveryHealth({ totals: { delivered: 0, blocked: 0, deferred: 920 }, byProvider: [] }, undefined, { encolados: 3 })],
    ["stalled por cola", assessDeliveryHealth({ totals: { delivered: 10, blocked: 0, deferred: 0 }, byProvider: [] }, undefined, { encolados: COLA_ATASCADA_MIN })],
    ["blocked", assessDeliveryHealth(propio({ delivered: [[4, "gmail.com"]], blocked: [[3883, "gmail.com"]] }), undefined, { encolados: 3 })],
    ["degraded", assessDeliveryHealth(propio({ delivered: [[60, "gmail.com"]], blocked: [[40, "gmail.com"]] }), undefined, { encolados: 3 })],
    ["healthy", assessDeliveryHealth(propio({ delivered: [[100, "gmail.com"]] }), undefined, { encolados: 3 })],
    ["sin lectura de cola", assessDeliveryHealth(propio({ delivered: [[100, "gmail.com"]] }))]
  ];
  for (const [nombre, v] of casos) {
    assert.ok("encolados" in v, `${nombre} no declara encolados`);
    assert.notEqual(v.encolados, undefined, `${nombre} dejó encolados en undefined`);
    assert.notEqual(v.ajenos, undefined, `${nombre} dejó ajenos en undefined`);
    assert.notEqual(v.atribucion, undefined, `${nombre} no declara de quién es el tráfico que midió`);
  }
});

test("parseQueueSize: no poder leer la cola es 'no sé', jamás cero", () => {
  // El 2026-07-29 un probe que se colgaba devolvió "bloqueado" falso en 10 de 10 nodos: un sensor
  // que no puede leer tiene que decir "no sé". Al revés, un cero inventado sobre un nodo con 15.693
  // mensajes atascados lo manda derecho al pool del calentamiento.
  const conQueue = (cuerpo: string): string =>
    `## DELIVERED\n## OWN_DELIVERED\n## BLOCKED\n## OWN_BLOCKED\n## DEFERRED\n## OWN_DEFERRED\n## QUEUE\n${cuerpo}\n## END\n`;
  assert.equal(parseQueueSize(conQueue("Mail queue is empty")), 0);
  assert.equal(parseQueueSize(conQueue("")), null);
  assert.equal(parseQueueSize(conQueue("postqueue: fatal: Queue report unavailable")), null);
  assert.equal(parseQueueSize(conQueue("-- 107250 Kbytes in 15710 Requests.")), 15710);
});

// ── NUESTRO CORREO vs EL DE NFC ─────────────────────────────────────────────────────────────────
//
// Por los mismos 58 nodos pasa el correo de NFC: otro producto, otros clientes, que inyecta por 587
// con SASL igual que nosotros y con el MISMO usuario. Hasta el 2026-08-06 este módulo contaba todo
// junto: 791.300 mensajes de ellos contra 222 nuestros en la flota entera (0,028%).

test("el comando REAL separa nuestro correo del del otro inquilino, por queue-id", async (t) => {
  // INCIDENTE QUE FIJA: annualcorp-control.com se publicaba como "cerrado en gmail: 136 rechazos
  // sobre 137 intentos" — y 135 de esos rechazos eran de NFC. El veredicto que frenaba el dominio
  // no describía nuestra reputación: describía la de otro producto.
  //
  // Corre con bash el mismo string que se manda por SSH: la separación pasa DENTRO del awk del nodo,
  // así que probarla con un stdout inventado no probaría nada (la lección del fixture de Bedrock).
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-nfc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const nfc = Array.from({ length: 25 }, (_, i) =>
    `Aug  6 09:${String(i % 60).padStart(2, "0")}:00 nodo postfix/smtp[1713359]: NFC${String(i).padStart(7, "0")}: to=<cliente${i}@gmail.com>, relay=gmail-smtp-in.l.google.com[142.251.179.27]:25, dsn=5.7.1, status=bounced (550-5.7.1 Gmail has detected that this message is likely unsolicited mail)`
  );
  // Los tres nuestros, con la forma real del queue-id que devuelve Postfix (verificada contra
  // producción: "250 2.0.0 Ok: queued as B7CA03F69F").
  const nuestros = ["B7CA03F69F", "C921D46D53", "42F6C3F69D"];
  await writeFile(path.join(dir, "mail.log"), [
    ...nfc,
    `Aug  6 10:00:00 nodo postfix/smtp[306271]: ${nuestros[0]}: to=<semilla1@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=1.9, status=sent (250 2.0.0 OK)`,
    `Aug  6 10:01:00 nodo postfix/smtp[306271]: ${nuestros[1]}: to=<semilla2@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=2.0, status=sent (250 2.0.0 OK)`,
    `Aug  6 10:02:00 nodo postfix/smtp[306271]: ${nuestros[2]}: to=<semilla3@gmail.com>, relay=gmail-smtp-in.l.google.com[142.251.179.27]:25, dsn=5.7.1, status=bounced (550-5.7.1 likely unsolicited mail)`,
    ""
  ].join("\n"), "utf8");

  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand(nuestros, 5, dir, HOY)], { encoding: "utf8" });
  const { total, propio: mio } = parseDeliveryStats(salida)!;

  assert.deepEqual(total.totals, { delivered: 2, blocked: 26, deferred: 0 }, "el nodo entero: los 25 de NFC más el nuestro");
  assert.deepEqual(mio.totals, { delivered: 2, blocked: 1, deferred: 0 }, "lo NUESTRO son 3 mensajes, no 28");

  const verdict = assessDeliveryHealth(mio, undefined, {
    encolados: 0, total, modo: "nuestro", queueIds: nuestros.length
  });
  assert.notEqual(verdict.status, "blocked_by_provider", "3 intentos nuestros no alcanzan para acusar a Gmail de cerrarnos");
  assert.deepEqual(verdict.stats.totals, { delivered: 2, blocked: 1, deferred: 0 });
  assert.deepEqual(verdict.ajenos.totals, { delivered: 0, blocked: 25, deferred: 0 }, "lo de NFC se ve, pero aparte");
  assert.equal(verdict.atribucion.modo, "nuestro");
});

test("el nodo movió correo y nada es nuestro ⇒ no_own_traffic, JAMÁS no_traffic", async (t) => {
  // INCIDENTE QUE PREVIENE: `no_traffic` ENTRA al pool del warmup a propósito (plan-diario.ts:200,
  // "un nodo nuevo es el candidato natural a arrancar"). Al separar el tráfico, 63 de 64 nodos
  // quedan sin muestra propia; si eso devolviera `no_traffic`, 63 nodos que NFC ya quemó se leerían
  // como dominios recién comprados y el pool habría saltado de 6 a ~63 — repartiendo las 14 vueltas
  // del día entre nodos que nunca calentamos.
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-ajeno-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "mail.log"), Array.from({ length: 25 }, (_, i) =>
    `Aug  6 09:00:0${i % 10} nodo postfix/smtp[1713359]: NFC${String(i).padStart(7, "0")}: to=<cliente${i}@gmail.com>, relay=gmail-smtp-in.l.google.com[142.251.179.27]:25, status=bounced (550-5.7.1 likely unsolicited mail)`
  ).join("\n") + "\n", "utf8");

  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand([], 5, dir, HOY)], { encoding: "utf8" });
  const { total, propio: mio } = parseDeliveryStats(salida)!;
  assert.equal(total.totals.blocked, 25);
  assert.equal(mio.totals.blocked, 0);

  const verdict = assessDeliveryHealth(mio, undefined, { encolados: 0, total, modo: "nuestro", queueIds: 0 });
  assert.equal(verdict.status, "no_own_traffic");
  assert.notEqual(verdict.status, "no_traffic");
  assert.match(verdict.detail, /ninguno es nuestro/);
});

test("log genuinamente vacío ⇒ no_traffic, aunque no haya un solo envío nuestro", async (t) => {
  // La otra mitad de la regla, y la que impide que la fábrica deje de fabricar: un dominio recién
  // comprado tiene el mail.log vacío y TIENE que poder recibir su primer correo de warmup. La
  // trampa que documenta plan-diario.ts:177-195 no se reabre con este cambio.
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-vacio-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "mail.log"), "", "utf8");

  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand([], 5, dir, HOY)], { encoding: "utf8" });
  const { total, propio: mio } = parseDeliveryStats(salida)!;
  const verdict = assessDeliveryHealth(mio, undefined, { encolados: 0, total, modo: "nuestro", queueIds: 0 });
  assert.equal(verdict.status, "no_traffic", "vacío es vacío: dominio nuevo, no 'sin muestra propia'");
});

test("una salida sin las secciones OWN es ilegible, nunca ceros", async () => {
  // Este módulo ya se quemó TRES veces con la misma forma: "comando que devuelve vacío" leído como
  // "no hay tráfico". Un `## OWN_*` ausente leído como cero convertiría cada nodo de la flota en
  // `no_own_traffic` de una, en silencio, y el archivo que publica el panel se llenaría de "sin
  // muestra propia" sin que nadie sospeche del parser.
  const vieja = stdout({ delivered: [[100, "gmail.com"]], sinOwn: true });
  assert.equal(parseDeliveryStats(vieja), null, "sin ## OWN_* no se puede leer");

  const sshRunner: DeliveryHealthSshRunner = { run: async () => ({ stdout: vieja, exitCode: 0 }) };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "s1", serverIp: "1.2.3.4", propios: ["B7CA03F69F"] });
  assert.equal(verdict.status, "unreadable");
  assert.match(verdict.detail, /OWN/);
});

test("BORDE DE CONFIANZA: los queue-ids de la base no pueden inyectar shell", () => {
  // Estos ids salen de una columna JSON de Postgres (`warmup_activity.detail->>'smtp'`) y terminan
  // DENTRO de una línea de shell que corre por SSH como root en 58 nodos de producción. Entre esos
  // dos puntos no hay ninguna otra validación: la lista blanca es la única.
  const sucios = ["ok1234", "a';rm -rf /", "$(id)", "con espacio"];
  const { ok, descartados } = sanearIds(sucios);
  assert.deepEqual(ok, ["ok1234"]);
  assert.equal(descartados, 3, "lo que no matchea se DESCARTA, no se escapa");

  const command = buildDeliveryStatsCommand(sucios, 5, "/var/log", HOY);
  // El único lugar donde viajan los ids es el `-v ids='...'` del awk: se verifica ahí, y no con un
  // `includes` sobre todo el comando, porque el comando contiene un `$(find ...)` legítimo.
  const idsEnElComando = [...command.matchAll(/-v ids='([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(idsEnElComando)], ["ok1234"], "solo el id sano llega al nodo");
  assert.equal(command.includes("rm -rf"), false);
  assert.equal(command.includes("$(id)"), false);
  assert.equal(command.includes("con espacio"), false);

  // Y las dos formas legítimas de queue-id de la flota SÍ pasan: hex corto y base-52 de
  // `enable_long_queue_ids`. Una lista blanca que perdiera la segunda dejaría esos nodos sin libro,
  // o sea en `no_own_traffic` para siempre.
  assert.deepEqual(sanearIds(["B7CA03F69F", "4bXyZ9Qm2Rz1kT", "B7CA03F69F"]).ok, ["B7CA03F69F", "4bXyZ9Qm2Rz1kT"]);
});

test("la cola atascada NUNCA se atribuye: es física y compartida", async () => {
  // Los 15.693 mensajes trabados los puso NFC, pero la cola es UNA sola: nuestro correo tampoco sale
  // de ese nodo. Preguntar "¿de quién son los mensajes trabados?" es la pregunta equivocada. Por eso
  // la rama de la cola va PRIMERA y no mira la atribución.
  const salida =
    `## DELIVERED\n## OWN_DELIVERED\n## BLOCKED\n  900 gmail.com\n## OWN_BLOCKED\n` +
    `## DEFERRED\n## OWN_DEFERRED\n## QUEUE\n-- 107250 Kbytes in 15693 Requests.\n## END\n`;
  const sshRunner: DeliveryHealthSshRunner = { run: async () => ({ stdout: salida, exitCode: 0 }) };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "s1", serverIp: "1.2.3.4", propios: [] });
  assert.equal(verdict.status, "stalled", "sin muestra propia, pero la cola física manda igual");
  assert.equal(verdict.encolados, 15693);
});

test("un libro absurdamente grande no se atribuye a ciegas", async () => {
  // Nuestro máximo real por nodo y ventana, medido contra la base de producción, es 13. Si el libro
  // trae 40x eso, algo cambió de régimen y nadie lo previó: se dice `unreadable` en vez de armar una
  // línea de shell de 50 KB con datos de una columna JSON.
  const ids = Array.from({ length: MAX_QUEUE_IDS + 1 }, (_, i) => `Q${String(i).padStart(9, "0")}`);
  let corrio = false;
  const sshRunner: DeliveryHealthSshRunner = { run: async () => { corrio = true; return { stdout: "", exitCode: 0 }; } };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "s1", serverIp: "1.2.3.4", propios: ids });
  assert.equal(verdict.status, "unreadable");
  assert.match(verdict.detail, /no atribuyo a ciegas/);
  assert.equal(corrio, false, "ni siquiera se abre la sesión SSH");
});

test("modo 'todo': lo propio ES el total y el veredicto lo declara", async () => {
  // `scripts/ops/deliverability-health.ts` diagnostica la MÁQUINA, no nuestra reputación, y para eso
  // el número correcto es el del nodo entero. Lo que no puede pasar es que ese número se lea después
  // como nuestro: por eso `atribucion.modo` viaja en el veredicto y se persiste.
  const sshRunner: DeliveryHealthSshRunner = {
    run: async () => ({ stdout: stdout({ delivered: [[900, "gmail.com"]], own: {} }), exitCode: 0 })
  };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "s1", serverIp: "1.2.3.4", propios: "todo" });
  assert.equal(verdict.status, "healthy");
  assert.equal(verdict.stats.totals.delivered, 900, "en modo todo NO se resta nada, aunque el fixture traiga OWN vacío");
  assert.deepEqual(verdict.ajenos.totals, { delivered: 0, blocked: 0, deferred: 0 });
  assert.equal(verdict.atribucion.modo, "todo");
});
