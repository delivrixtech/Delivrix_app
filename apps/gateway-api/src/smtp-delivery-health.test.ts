import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { utimesSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DELIVERY_STATS_WINDOW,
  assessDeliveryHealth,
  buildDeliveryStatsCommand,
  parseDeliveryStats,
  parseLineasSinFecha,
  parseQueueSize,
  prefijosDeDias,
  readNodeDeliveryHealth,
  type DeliveryHealthSshRunner
} from "./smtp-delivery-health.ts";

/** El "hoy" de los fixtures. Fijo para que la ventana por fecha no dependa del día del calendario. */
const HOY = new Date("2026-08-06T12:00:00Z");

function stdout(input: {
  delivered?: Array<[number, string]>;
  blocked?: Array<[number, string]>;
  deferred?: Array<[number, string]>;
  truncated?: boolean;
}): string {
  const block = (rows?: Array<[number, string]>): string =>
    (rows ?? []).map(([n, d]) => `   ${n} ${d}`).join("\n");
  const lines = [
    "## DELIVERED", block(input.delivered),
    "## BLOCKED", block(input.blocked),
    "## DEFERRED", block(input.deferred)
  ];
  if (!input.truncated) lines.push("## END");
  return `${lines.join("\n")}\n`;
}

test("buildDeliveryStatsCommand: solo lee, no envia, y marca el fin", () => {
  const command = buildDeliveryStatsCommand();
  assert.match(command, /mail\.log/);
  assert.match(command, /## END/);
  assert.equal(/set -e/.test(command), false);
  // Es una señal pasiva: no debe existir ninguna ruta de envío acá.
  assert.equal(/sendmail|smtp-source|swaks/.test(command), false);
});

test("parseDeliveryStats: agrega por proveedor y totaliza", () => {
  const stats = parseDeliveryStats(stdout({
    delivered: [[706, "gmail.com"], [140, "yahoo.com"]],
    blocked: [[3, "gmail.com"]]
  }))!;
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
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({
    delivered: [[1483, "yahoo.com"], [416, "aol.com"], [4, "gmail.com"]],
    blocked: [[3883, "gmail.com"]]
  }))!);
  assert.equal(verdict.status, "blocked_by_provider");
  assert.deepEqual(verdict.blockedProviders, ["gmail.com"]);
  assert.match(verdict.detail, /gmail\.com/);
});

test("assessDeliveryHealth: nodo sano con volumen real a gmail", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({
    delivered: [[706, "gmail.com"], [140, "yahoo.com"], [35, "aol.com"]]
  }))!);
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(verdict.blockedProviders, []);
});

test("assessDeliveryHealth: rechazo parcial ⇒ degraded", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({
    delivered: [[60, "gmail.com"]],
    blocked: [[40, "gmail.com"]]
  }))!);
  assert.equal(verdict.status, "degraded");
  assert.deepEqual(verdict.degradedProviders, ["gmail.com"]);
});

test("assessDeliveryHealth: pocos intentos no alcanzan para acusar bloqueo", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({
    blocked: [[3, "gmail.com"]]
  }))!);
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(verdict.blockedProviders, []);
});

// Los nodos MAS sanos aparecian "cerrados en su propio dominio": son los rebotes que
// Postfix se manda a si mismo (postmaster, notificaciones de no-entrega), no un proveedor.
test("assessDeliveryHealth: los rebotes al propio dominio no cuentan como bloqueo", () => {
  const stats = parseDeliveryStats(stdout({
    delivered: [[4944, "gmail.com"]],
    blocked: [[120, "infranationalreport.com"]]
  }))!;
  assert.equal(assessDeliveryHealth(stats).status, "blocked_by_provider");
  assert.equal(assessDeliveryHealth(stats, "infranationalreport.com").status, "healthy");
});

test("assessDeliveryHealth: excluir el propio dominio no tapa un bloqueo real de proveedor", () => {
  const stats = parseDeliveryStats(stdout({
    delivered: [[500, "yahoo.com"]],
    blocked: [[300, "gmail.com"], [40, "propio.com"]]
  }))!;
  const verdict = assessDeliveryHealth(stats, "propio.com");
  assert.equal(verdict.status, "blocked_by_provider");
  assert.deepEqual(verdict.blockedProviders, ["gmail.com"]);
});

test("assessDeliveryHealth: sin trafico ⇒ no_traffic, no 'sano'", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({}))!);
  assert.equal(verdict.status, "no_traffic");
});

// El falso negativo peligroso: si no se pudo leer, NO puede decir "sano".
test("readNodeDeliveryHealth: SSH que falla ⇒ unreadable, nunca healthy", async () => {
  const sshRunner: DeliveryHealthSshRunner = {
    run: async () => { throw new Error("SSH command failed with exit 255.\nPermission denied (publickey)."); }
  };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "server60", serverIp: "10.0.0.1" });
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
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "server60", serverIp: "10.0.0.1" });
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
  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand(5, dir, HOY)], { encoding: "utf8" });
  const stats = parseDeliveryStats(salida)!;

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
    const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand(5, dir, HOY)], { encoding: "utf8" });
    const stats = parseDeliveryStats(salida)!;
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

  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand(5, dir, HOY)], { encoding: "utf8" });
  assert.equal(parseDeliveryStats(salida)!.totals.delivered, 0, "el corte por día no las ve (por eso hace falta el seguro)");
  assert.equal(parseLineasSinFecha(salida), 7);

  const sshRunner: DeliveryHealthSshRunner = { run: async () => ({ stdout: salida, exitCode: 0 }) };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "server60", serverIp: "10.0.0.1" });
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

test("TODO veredicto declara la cola, incluso cuando no la pudo leer", () => {
  // Bug encontrado midiendo la flota de verdad, no en el fixture: cinco de los seis `return` de
  // assessDeliveryHealth se habían quedado sin el campo nuevo. Como corremos con
  // --experimental-strip-types no hay chequeo de tipos en tiempo de ejecución, así que `encolados`
  // salía `undefined`, JSON.stringify borraba la clave, y sender-measurement.json quedó con el dato
  // en 49 de 58 nodos — justo el sensor que vino a decir si el nodo está atascado AHORA.
  // `undefined` es peor que `null`: `null` dice "no sé", `undefined` ni siquiera aparece.
  const casos: Array<[string, ReturnType<typeof assessDeliveryHealth>]> = [
    ["no_traffic", assessDeliveryHealth({ totals: { delivered: 0, blocked: 0, deferred: 0 }, byProvider: [] }, undefined, { encolados: 3 })],
    ["stalled por log", assessDeliveryHealth({ totals: { delivered: 0, blocked: 0, deferred: 920 }, byProvider: [] }, undefined, { encolados: 3 })],
    ["blocked", assessDeliveryHealth(parseDeliveryStats(stdout({ delivered: [[4, "gmail.com"]], blocked: [[3883, "gmail.com"]] }))!, undefined, { encolados: 3 })],
    ["degraded", assessDeliveryHealth(parseDeliveryStats(stdout({ delivered: [[60, "gmail.com"]], blocked: [[40, "gmail.com"]] }))!, undefined, { encolados: 3 })],
    ["healthy", assessDeliveryHealth(parseDeliveryStats(stdout({ delivered: [[100, "gmail.com"]] }))!, undefined, { encolados: 3 })],
    ["sin lectura de cola", assessDeliveryHealth(parseDeliveryStats(stdout({ delivered: [[100, "gmail.com"]] }))!)]
  ];
  for (const [nombre, v] of casos) {
    assert.ok("encolados" in v, `${nombre} no declara encolados`);
    assert.notEqual(v.encolados, undefined, `${nombre} dejó encolados en undefined`);
  }
});

test("parseQueueSize: no poder leer la cola es 'no sé', jamás cero", () => {
  // El 2026-07-29 un probe que se colgaba devolvió "bloqueado" falso en 10 de 10 nodos: un sensor
  // que no puede leer tiene que decir "no sé". Al revés, un cero inventado sobre un nodo con 15.693
  // mensajes atascados lo manda derecho al pool del calentamiento.
  const conQueue = (cuerpo: string): string => `## DELIVERED\n## BLOCKED\n## DEFERRED\n## QUEUE\n${cuerpo}\n## END\n`;
  assert.equal(parseQueueSize(conQueue("Mail queue is empty")), 0);
  assert.equal(parseQueueSize(conQueue("")), null);
  assert.equal(parseQueueSize(conQueue("postqueue: fatal: Queue report unavailable")), null);
  assert.equal(parseQueueSize(conQueue("-- 107250 Kbytes in 15710 Requests.")), 15710);
});
