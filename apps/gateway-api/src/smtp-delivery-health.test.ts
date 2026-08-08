import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { utimesSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ATASCADOS_MIN,
  BLOCKED_MIN_ATTEMPTS,
  COLA_ATASCADA_MIN,
  DEGRADED_MIN_RATIO,
  DEGRADED_MIN_RECHAZOS,
  DELIVERY_STATS_WINDOW,
  MAX_QUEUE_IDS,
  MOTIVOS_DE_CULPA,
  PRESION_BLOQUEO,
  assessDeliveryHealth,
  buildDeliveryStatsCommand,
  clasificarCulpa,
  deliveryStatsUnreadable,
  parseDeliveryStats,
  parseLineasSinFecha,
  parseQueueSize,
  prefijosDeDias,
  readNodeDeliveryHealth,
  resolverPresionBloqueo,
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

test("assessDeliveryHealth: pocos intentos no alcanzan para acusar bloqueo NI PARA DECIR QUE ENTREGA", () => {
  // ESTE TEST AFIRMABA `healthy` Y ERA EL AVAL VERDE DEL AGUJERO. Textual, hasta el 2026-08-08: un
  // nodo con gmail 0 entregados / 3 rechazados se leía "sano", y había un assert defendiéndolo.
  // Mientras ese assert dijera `healthy`, nadie iba a tocar el `continue` que lo producía: el verde
  // es el aval más caro que se puede comprar.
  //
  // Lo que el sistema tiene que afirmar es otra cosa, y es la mitad que faltaba: por debajo del piso
  // NO SE SABE. "No alcanza para acusarlo" y "entrega bien" son proposiciones distintas y este
  // módulo las venía colapsando en una.
  const verdict = assessDeliveryHealth(propio({ blocked: [[3, "gmail.com"]] }));
  assert.equal(verdict.status, "insufficient_sample");
  assert.deepEqual(verdict.sinMuestra, ["gmail.com"]);
  // Y NO SE VUELVE PEGAJOSO: `blockedProviders` es lo que sender-measurement persiste como
  // `cerradoEn`, que no caduca. Tres rechazos justifican "hoy no", jamás "nunca más".
  assert.deepEqual(verdict.blockedProviders, [], "3 rechazos no pueden condenar un dominio para siempre");
});

test("EL CASO INVERSO: una muestra chica SIN evidencia de bloqueo no queda excluida", () => {
  // Un sensor que bloquea todo es tan inútil como uno que no bloquea nada, y este veto se aplica
  // justo donde la fábrica es más frágil: los dominios nuevos, que por definición tienen muestra
  // chica. Las tres formas de muestra chica que NO son un cierre:
  const casos: Array<[string, ReturnType<typeof assessDeliveryHealth>]> = [
    // 1. Entregar es evidencia POSITIVA. 5 entregas y 1 rechazo es correo normal, no una puerta.
    ["entrega y algún rechazo", assessDeliveryHealth(propio({ delivered: [[5, "gmail.com"]], blocked: [[1, "gmail.com"]] }))],
    // 2. El typo del cliente no congela un dominio. En la flota hay más de veinte mil filas de
    //    receptor con algún rechazo y casi todas son de esta clase; con el veto sin filtro de
    //    familia, un dedo equivocado sacaría el nodo del pool.
    ["typo del destinatario", assessDeliveryHealth(propio({ blocked: [[3, "gamil.com"]] }))],
    // 3. El dominio recién comprado, que es la puerta que el pool abre a propósito. Ningún estado
    //    nuevo puede tocarlo o la fábrica deja de fabricar.
    ["dominio nuevo, log vacío", assessDeliveryHealth(propio({}))]
  ];
  assert.equal(casos[0]![1].status, "healthy");
  assert.equal(casos[1]![1].status, "healthy");
  assert.equal(casos[2]![1].status, "no_traffic");
  for (const [nombre, v] of casos) {
    assert.deepEqual(v.sinMuestra, [], `${nombre} no puede quedar vetado`);
    assert.deepEqual(v.blockedProviders, [], `${nombre} no puede escribir cerradoEn`);
  }
});

test("un 5.1.1 no vale como cierre: es el buzón del destinatario, no nuestra reputación", () => {
  // El veto es fail-closed con `"no-se"` a propósito (33 de 39 rebotes de política de Gmail no se
  // pueden clasificar, así que exigir culpa conocida lo volvería decorativo). La única culpa que SÍ
  // lo desactiva es la del buzón, porque esa no habla de nosotros.
  const stats = propio({ blocked: [[3, "gmail.com"]] });
  assert.equal(assessDeliveryHealth(stats, undefined, { culpa: { "gmail.com": "buzon" } }).status, "healthy");
  assert.equal(assessDeliveryHealth(stats, undefined, { culpa: { "gmail.com": "no-se" } }).status, "insufficient_sample");
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
  assert.match(verdict.detail, /920 mensajes trabados/);
  assert.match(verdict.detail, /no llega/);
  // ESTE CASO ES EL QUE OBLIGA AL SEGUNDO DISYUNTOR de la regla del nodo, y no es cosmético. Sin
  // información de líneas (este objeto se arma a mano y no la trae) la presión se lee 1,0 y la regla
  // de la puerta 4xx se calla — que es el lado seguro. Pero un nodo que en cinco días no resolvió NI
  // UN mensaje, ni bien ni mal, no puede caer en `healthy` con el texto "0 entregados, 0 rechazados".
  // Ése era exactamente el fail-open del que se venía: `delivered + blocked === 0` lo cierra sin
  // depender de un ratio degenerado.
  assert.equal(verdict.stats.intentos, undefined, "sin líneas: la presión no puede ser la que lo salva");
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
  // LAS DOS UNIDADES SALEN DE LA MISMA PASADA, y ésta es la afirmación nueva. El dedup contestaba
  // "cuántos mensajes" y borraba "cuánto costó cada uno" — que es el dato que delata al receptor que
  // nos difiere sin rebotar nunca. Ahora salen las dos del mismo `sort | uniq -c`, así que no hay dos
  // lecturas que puedan divergir (el 2026-08-07 el mismo nodo dio 165/136 y 16/1 con el MISMO código,
  // porque las dos corridas cayeron a los dos lados de la medianoche UTC).
  assert.equal(stats.intentos?.deferred, 16, "y las 16 LÍNEAS que dejó ese único mensaje");
  assert.equal(stats.intentos?.delivered, 3, "una entrega deja una línea: presión 1,0");
  assert.equal(stats.byProvider.find((p) => p.provider === "comcast.net")?.intentos?.deferred, 16);
  // La máquina de test no tiene cola de Postfix: 0 si postqueue contesta, null si ni corre. Lo que
  // NO puede pasar es que invente un número, que es lo que mandaría el nodo a `stalled` de mentira.
  const encolados = parseQueueSize(salida);
  assert.ok(encolados === null || encolados === 0, `cola inventada: ${encolados}`);
  // Sigue `healthy`, pero AHORA POR UNA RAZÓN DICHA y no por omisión: comcast tiene 16 reintentos por
  // mensaje (arriba de PRESION_BLOQUEO) pero UN solo mensaje trabado, y el piso son ATASCADOS_MIN.
  // Un mensaje colgado no es una puerta cerrada; cinco con esta presión sí, y eso lo fija el test de
  // abajo con las líneas reales de Yahoo.
  assert.equal(assessDeliveryHealth(stats, undefined, { encolados }).status, "healthy");
  assert.equal(ATASCADOS_MIN, 5, "si este número cambia, el 'healthy' de arriba deja de significar lo mismo");
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
    ["insufficient_sample", assessDeliveryHealth(propio({ blocked: [[2, "gmail.com"]] }), undefined, { encolados: 3 })],
    ["healthy", assessDeliveryHealth(propio({ delivered: [[100, "gmail.com"]] }), undefined, { encolados: 3 })],
    ["sin lectura de cola", assessDeliveryHealth(propio({ delivered: [[100, "gmail.com"]] }))]
  ];
  for (const [nombre, v] of casos) {
    assert.ok("encolados" in v, `${nombre} no declara encolados`);
    assert.notEqual(v.encolados, undefined, `${nombre} dejó encolados en undefined`);
    assert.notEqual(v.ajenos, undefined, `${nombre} dejó ajenos en undefined`);
    assert.notEqual(v.atribucion, undefined, `${nombre} no declara de quién es el tráfico que midió`);
    assert.notEqual(v.culpaPorProveedor, undefined, `${nombre} dejó culpaPorProveedor en undefined`);
    assert.notEqual(v.sinMuestra, undefined, `${nombre} dejó sinMuestra en undefined`);
  }
  // Y los NUEVE estados de la unión están cubiertos por esta lista más los dos que se arman aparte
  // (`unreadable` en su propio test, `no_own_traffic` acá arriba). Si alguien agrega un estado y no
  // lo suma acá, el armador lo cubre igual — que es exactamente para lo que existe.
  assert.equal(casos.filter(([, v]) => v.status === "insufficient_sample").length, 1);
});

test("el veredicto `unreadable` tampoco puede dejar campos en undefined", async () => {
  // El armador único cubre los siete veredictos de assessDeliveryHealth, pero `unreadable` se arma
  // aparte en readNodeDeliveryHealth — o sea que es el único return que puede volver a repetir el
  // olvido del 2026-08-06 (cinco de seis `return` sin `encolados`, y el dato desaparecido de
  // sender-measurement.json en 49 de 58 nodos). Con `culpaPorProveedor` son ocho lugares.
  const sshRunner: DeliveryHealthSshRunner = { run: async () => { throw new Error("boom"); } };
  const v = await readNodeDeliveryHealth({ sshRunner, serverSlug: "s1", serverIp: "1.2.3.4", propios: "todo" });
  assert.equal(v.status, "unreadable");
  assert.deepEqual(v.culpaPorProveedor, {}, "no se pudo leer: {} explícito, no undefined");
  assert.notEqual(v.encolados, undefined);
  assert.notEqual(v.ajenos, undefined);
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

// ── ¿A QUIÉN CASTIGA EL RECEPTOR: A LA IP O AL DOMINIO? ─────────────────────────────────────────
//
// EL INCIDENTE DEL 2026-08-07, con la plata a punto de salir. La mano `revisar_reputacion` publicó
// este detalle, textual del log de producción:
//
//   "bizreport-control.com (86.48.29.176): listas negras sin detecciones · auth SPF ok, DKIM ok,
//    DMARC ok, PTR ok · receptor: CERRADO en gmail.com, hotmail.com, outlook.com"
//
// y el agente se lo contó al jefe así, también textual:
//
//   "salieron con IP limpia y autenticación ok, esos nodos sirven para montarles dominio nuevo"
//
// El jefe preguntó "¿es decir, sería comprar 2 dominios nuevos y configurarlos a esos smtps?" y el
// agente contestó "Exacto, eso mismo". Eran USD 30 y dos rampas de warmup sobre dos IP que hotmail,
// outlook, icloud, me y mac están rechazando POR SER ESAS IP. Nadie en el sistema podía desmentirlo:
// el texto del rechazo se tiraba en el nodo y este módulo solo sabía decir QUIÉN cierra la puerta.
// Hubo que entrar por SSH a mano para contestar la pregunta que decidía la compra.
const NODO_BIZREPORT = "86.48.29.176";
const NODO_CORPANNUAL = "80.190.75.57";

/** Motivos VERBATIM de `/var/log/mail.log` de los dos nodos del incidente, contados el 2026-08-07. */
const SAID = {
  // 334 veces en 86.48.29.176 y 10.686 en 80.190.75.57. El ÚNICO que culpa al dominio.
  gmail:
    `550-5.7.1 [${NODO_BIZREPORT} 19] Gmail has detected that this message is likely suspicious due to the ` +
    "very low reputation of the sending domain. To best protect our users from spam, the message has been blocked. " +
    "550-5.7.1 For more information, go to 550 5.7.1  https://support.google.com/mail/answer/188131 (in reply to end of DATA command)",
  // 171 veces en 86.48.29.176 y 817 en 80.190.75.57. La lista S3150 es de Microsoft y no es pública:
  // por eso el chequeo de listas negras daba limpio y la puerta igual estaba cerrada.
  microsoft:
    `550 5.7.1 Unfortunately, messages from [${NODO_BIZREPORT}] weren't sent. Please contact your Internet ` +
    "service provider since part of their network is on our block list (S3150). You can also refer your " +
    "provider to http://mail.live.com/mail/troubleshooting.aspx#errors. (in reply to MAIL FROM command)",
  // 503 veces en 80.190.75.57. Nombra la IP con número y letra.
  apple: `550 5.7.1 [HCM2] Your mail from ${NODO_CORPANNUAL} was rejected. https://support.apple.com/en-us/HT204137`,
  // El contraste: esto NO es reputación, es una dirección que no existe. Medido el 2026-08-03,
  // nuestros rebotes son ~99% política y casi cero buzón.
  buzon: "550 5.1.1 <nadie@comcast.net> user unknown (in reply to RCPT TO command)"
};

function rebotes(receptor: string, said: string, cuantos: number, sello: string): string[] {
  return Array.from({ length: cuantos }, (_, i) =>
    `Aug  6 09:${String(i % 60).padStart(2, "0")}:00 nodo postfix/smtp[1713359]: ${sello}${String(i).padStart(7, "0")}: ` +
    `to=<x${i}@${receptor}>, relay=mx.${receptor}[10.0.0.1]:25, delay=2.1, dsn=5.7.1, ` +
    `status=bounced (host mx.${receptor}[10.0.0.1] said: ${said})`
  );
}

test("EL INCIDENTE 2026-08-07: el sensor ya puede decir si castigan a la IP o al dominio", async (t) => {
  // Corre por el camino de PRODUCCIÓN: el mismo string que se manda por SSH, con bash, contra un log
  // de verdad. Un stdout escrito a mano compartiría mi suposición del formato y no probaría nada —
  // la lección del fixture de Bedrock, otra vez.
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-culpa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "mail.log"), [
    ...rebotes("gmail.com", SAID.gmail, 25, "GML"),
    ...rebotes("hotmail.com", SAID.microsoft, 25, "MSF"),
    ...rebotes("icloud.com", SAID.apple, 25, "APL"),
    ...rebotes("comcast.net", SAID.buzon, 25, "CMC"),
    ""
  ].join("\n"), "utf8");

  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand("todo", 5, dir, HOY)], { encoding: "utf8" });
  const leido = parseDeliveryStats(salida)!;
  const verdict = assessDeliveryHealth(leido.total, undefined, { encolados: 0, culpa: leido.culpa });

  assert.equal(verdict.status, "blocked_by_provider");
  // LO QUE EL AGENTE NO PODÍA SABER: dos de los tres receptores castigan la IP. Sobre esa misma IP,
  // un dominio nuevo NACE BLOQUEADO — o sea que "esos nodos sirven para montarles dominio nuevo" era
  // falso para hotmail e icloud, y ese es exactamente el gasto que no se hizo.
  assert.equal(verdict.culpaPorProveedor["hotmail.com"], "ip", "S3150 nombra la IP, no el dominio");
  assert.equal(verdict.culpaPorProveedor["icloud.com"], "ip", "HCM2 nombra la IP, no el dominio");
  // Y LO QUE SÍ ERA CIERTO, que es lo que hacía creíble el consejo: Gmail castiga al DOMINIO. Media
  // verdad publicada como verdad entera es lo que costó plata; el arreglo no es negar esa mitad.
  assert.equal(verdict.culpaPorProveedor["gmail.com"], "dominio");
  assert.equal(verdict.culpaPorProveedor["comcast.net"], "buzon", "dirección inexistente no es reputación");

  // CONTRATO CON EL QUE REDACTA (el lote de la frase): hay una culpa por CADA receptor que se
  // publica, ni una de más ni una de menos. Sin esto, la frase podría nombrar un cierre sin culpa
  // (y volver a callarse lo caro) o inventar una culpa de un receptor que nadie mencionó.
  assert.deepEqual(
    Object.keys(verdict.culpaPorProveedor).sort(),
    [...verdict.blockedProviders, ...verdict.degradedProviders].sort()
  );
});

test("AL REVÉS: cuando comprar un dominio nuevo SÍ es la salida, el sensor no lo ensucia", () => {
  // Un verificador que frena todo es tan inútil como uno que no frena nada. El caso legítimo —
  // Gmail castigando la reputación del DOMINIO, con la IP fuera de discusión — tiene que salir
  // limpio y decirlo, o el arreglo termina desactivado por ruidoso a la semana.
  const verdict = assessDeliveryHealth(
    propio({ delivered: [[4, "gmail.com"]], blocked: [[337, "gmail.com"]] }),
    undefined,
    { encolados: 0, culpa: { "gmail.com": clasificarCulpa(SAID.gmail) } }
  );
  assert.equal(verdict.status, "blocked_by_provider");
  assert.deepEqual(verdict.culpaPorProveedor, { "gmail.com": "dominio" });
  assert.equal(Object.values(verdict.culpaPorProveedor).includes("ip"), false, "no se contagia 'ip' sin evidencia");
});

test("clasificarCulpa: un motivo que no conocemos es 'no-se', jamás una adivinanza", () => {
  // Los cuatro que sabemos leer salen del mail.log de los dos nodos del incidente, verbatim.
  assert.equal(clasificarCulpa(SAID.gmail), "dominio");
  assert.equal(clasificarCulpa(SAID.microsoft), "ip");
  assert.equal(clasificarCulpa(SAID.apple), "ip");
  assert.equal(clasificarCulpa(SAID.buzon), "buzon");

  // EL QUE IMPORTA. Un receptor que todavía no está en la tabla no puede salir clasificado: si "no
  // sé" se disfrazara de "dominio", la frase diría "comprá un dominio nuevo" sobre una IP quemada,
  // que es el error de USD 30 que este lote vino a hacer imposible. Y si se disfrazara de "ip",
  // frenaría compras buenas y el arreglo lo apagan por inútil.
  assert.equal(clasificarCulpa("554 5.7.1 [HM08] Message rejected due to local policy"), "no-se");
  assert.equal(clasificarCulpa("450 4.2.0 Resources temporarily unavailable"), "no-se");
  assert.equal(clasificarCulpa(""), "no-se");

  // La tabla es LA perilla de calibración: un receptor nuevo es una línea acá más un caso arriba.
  // Los patrones no pueden llevar la bandera /g — con estado, `test()` alterna verdadero y falso
  // entre llamadas y la clasificación dependería del orden en que se miraron los nodos.
  for (const m of MOTIVOS_DE_CULPA) assert.equal(m.patron.global, false, `${m.patron} tiene /g`);
});

test("la sección nueva NO puede romper el sensor: sin ## CULPA, el veredicto es el de siempre", async () => {
  // Este archivo ya se quemó TRES veces con la misma forma exacta: "comando que devuelve vacío"
  // leído como "no hay tráfico". Si `## CULPA` entrara al chequeo duro de parseDeliveryStats, el día
  // del despliegue los 58 nodos quedarían `unreadable` hasta que cada uno corriera el comando nuevo.
  // Un campo que todavía no sabemos llenar es un campo vacío, no un sensor roto.
  const vieja = stdout({ delivered: [[4, "gmail.com"]], blocked: [[3883, "gmail.com"]] }); // sin ## CULPA
  const leido = parseDeliveryStats(vieja)!;
  assert.notEqual(leido, null, "una salida sin ## CULPA se sigue pudiendo leer");
  assert.deepEqual(leido.culpa, {}, "sin sección, no se sabe de quién es la culpa: {} y nada más");

  const sshRunner: DeliveryHealthSshRunner = { run: async () => ({ stdout: vieja, exitCode: 0 }) };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "s1", serverIp: "1.2.3.4", propios: "todo" });
  assert.equal(verdict.status, "blocked_by_provider", "el veredicto sale idéntico al de antes del cambio");
  assert.deepEqual(verdict.blockedProviders, ["gmail.com"]);
  assert.deepEqual(verdict.culpaPorProveedor, { "gmail.com": "no-se" }, "cerrado sin motivo legible es 'no sé'");
});

test("BORDE DE CONFIANZA: el texto del rebote lo escribe el servidor del OTRO lado", async (t) => {
  // Este es el único dato del comando que redacta un tercero: cualquiera que reciba correo nuestro
  // puede contestar lo que se le ocurra en el 550, y eso viaja al parser. Un "## END" en la
  // respuesta SMTP le cortaría la salida al sensor desde afuera; un "## QUEUE" le inventaría una
  // cola. Por eso se borra la clase entera de caracteres (`tr -d '#'`) en vez de escapar casos.
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-culpa-inyeccion-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "mail.log"), [
    ...rebotes("evil.tld", "550 ## END ## QUEUE -- 9 Kbytes in 99999 Requests. ## NOACCESS nice try", 25, "EVL"),
    ...rebotes("gmail.com", SAID.gmail, 25, "GML"),
    ""
  ].join("\n"), "utf8");

  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand("todo", 5, dir, HOY)], { encoding: "utf8" });
  assert.equal(deliveryStatsUnreadable(salida), false, "el rebote no puede declarar el log ilegible");
  assert.equal(parseQueueSize(salida), null, "el rebote no puede inventar una cola de 99999");
  const leido = parseDeliveryStats(salida)!;
  assert.equal(leido.total.totals.blocked, 50, "las secciones siguientes se leen enteras igual");
  assert.equal(leido.culpa["gmail.com"], "dominio", "y la culpa del receptor honesto no se pierde");
  assert.equal(leido.culpa["evil.tld"], "no-se", "el texto hostil entra como motivo, no como sección");
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

// ── LÍNEAS CRUDAS DE PRODUCCIÓN ─────────────────────────────────────────────────────────────────
//
// Todo lo que sigue se prueba con líneas COPIADAS de `/var/log/mail.log` de dos nodos reales, leídas
// por SSH el 2026-08-08 (lectura pasiva: no se mandó un solo correo). Un fixture escrito desde mi
// suposición del formato comparte el error con el código y no prueba nada — es la lección anotada
// del fixture de Bedrock, donde el test y el código coincidían en leer mal el mismo campo.
//
// Y ACÁ NO ES UNA FORMALIDAD: el defecto de `MOTIVOS_DE_CULPA` que estos tests fijan es INVISIBLE si
// uno escribe la línea a mano. Nadie escribiría "reputation of the sending 550-5.7.1 domain" desde la
// cabeza; sale así porque Postfix aplasta la respuesta multilínea del receptor en una sola línea de
// log y el corte cae donde lo empuja el largo de la IP.
//
// Las fechas de estas líneas caen adentro de la ventana de HOY (2026-08-06 ⇒ Aug 2 … Aug 7), así que
// entran VERBATIM. Lo único que varía por línea generada es el queue-id y el destinatario, para
// tener varios mensajes distintos; el motivo del receptor no se toca ni un carácter.

/** 80.190.76.57 · annualcorp-control.com · Contabo · syslog sin año. */
const NODO_ANNUALCORP = "80.190.76.57";
/** 193.181.212.223 · corpfilingcontrol.com · Webdock · ISO-8601. IP de 15 caracteres: ver el wrap. */
const NODO_CORPFILING = "193.181.212.223";

/**
 * Gmail rechazando por reputación del DOMINIO desde el nodo de IP LARGA.
 *
 * ACÁ ESTÁ EL DEFECTO, VERBATIM: dice "reputation of the sending 550-5.7.1 domain". El patrón de la
 * tabla pedía "reputation of the sending domain" y en este nodo eso matchea CERO veces contra 16.253
 * de la variante cortada. En 80.190.76.57 (IP de 12 caracteres) matchea 4.148 veces sin cortar. Tres
 * caracteres de IP decidían si el sensor podía contestar la pregunta que cuesta plata.
 */
const CRUDA_GMAIL_DOMINIO_CORTADO =
  `2026-08-03T10:02:53.960763+00:00 smtp postfix/smtp[1352691]: %QID%: to=<%DEST%@gmail.com>, ` +
  "relay=gmail-smtp-in.l.google.com[142.251.127.27]:25, delay=1.3, delays=0.52/0.06/0.25/0.47, dsn=5.7.1, " +
  "status=bounced (host gmail-smtp-in.l.google.com[142.251.127.27] said: 550-5.7.1 " +
  `[${NODO_CORPFILING}      19] Gmail has detected that this message is 550-5.7.1 likely suspicious due to the ` +
  "very low reputation of the sending 550-5.7.1 domain. To best protect our users from spam, the message has been " +
  "550-5.7.1 blocked. For more information, go to 550 5.7.1  https://support.google.com/mail/answer/188131 " +
  "ffacd0b85a97d-47fd45ade4csi16176717f8f.218 - gsmtp (in reply to end of DATA command))";

/**
 * La OTRA frase de Gmail — "likely unsolicited mail" — que hasta hoy no tenía ningún patrón.
 *
 * Es la que Gmail le tira a NUESTRO volumen chico: 1.512 veces en 193.181.212.223, y es la que dejó
 * annualcorp-control.com. Igual que la de arriba, viene con el prefijo de continuación adentro
 * ("is likely 550-5.7.1 unsolicited mail"), así que ni siquiera un patrón escrito de la
 * documentación de Google habría acertado.
 */
const CRUDA_GMAIL_UNSOLICITED =
  "Aug  5 01:09:52 smtp postfix/smtp[3967065]: %QID%: to=<%DEST%@gmail.com>, " +
  "relay=gmail-smtp-in.l.google.com[142.250.31.27]:25, delay=1.2, delays=0.71/0/0.11/0.34, dsn=5.7.1, " +
  "status=bounced (host gmail-smtp-in.l.google.com[142.250.31.27] said: 550-5.7.1 " +
  `[${NODO_ANNUALCORP}      12] Gmail has detected that this message is likely 550-5.7.1 unsolicited mail. ` +
  "To reduce the amount of spam sent to Gmail, this 550-5.7.1 message has been blocked. For more information, " +
  "go to 550 5.7.1  https://support.google.com/mail/?p=UnsolicitedMessageError " +
  "6a1803df08f44-908802055fcsi17879076d6.584 - gsmtp (in reply to end of DATA command))";

/**
 * Gmail culpando a la IP, con la frase casi calcada a la del dominio. Solo 3 veces en el log
 * retenido, y son las 3 que desmienten "comprá un dominio nuevo y montalo en el mismo SMTP".
 */
const CRUDA_GMAIL_IP =
  `550-5.7.1 [${NODO_CORPFILING}      18] Gmail has detected that this message is 550-5.7.1 likely suspicious ` +
  "due to the very low reputation of the sending IP 550-5.7.1 address. To best protect our users from spam, " +
  "the message has been 550-5.7.1 blocked. For more information, go to 550 5.7.1  " +
  "https://support.google.com/mail/answer/188131 ffacd0b85a97d-47f46353fd2si11177591f8f.77 - gsmtp";

/**
 * LA PUERTA QUE NUNCA REBOTA. Yahoo nos difiere con un 421 y jamás escribe un `status=bounced`, así
 * que para `attempts = delivered + blocked` este receptor no existe. Nos lo dijo 34.524 veces en
 * 193.181.212.223, con nuestra IP escrita adentro del mensaje.
 */
const CRUDA_YAHOO_TSS04 =
  "2026-08-02T00:00:16.766008+00:00 smtp postfix/smtp[1176626]: %QID%: to=<%DEST%@yahoo.com>, " +
  "relay=mta7.am0.yahoodns.net[67.195.204.74]:25, delay=50169, delays=50167/0.26/1.9/0.12, dsn=4.7.0, " +
  "status=deferred (host mta7.am0.yahoodns.net[67.195.204.74] said: 421 4.7.0 [TSS04] Messages from " +
  `${NODO_CORPFILING} temporarily deferred due to unexpected volume or user complaints - 4.16.55.1; ` +
  "see https://postmaster.yahooinc.com/error-codes (in reply to MAIL FROM command))";

/**
 * LA ENTREGA QUE NO ES UNA ENTREGA: el nodo se manda a sí mismo el rebote de NFC por un pipe local.
 * Nunca sale de la máquina. Medido el 2026-08-08: 23 de los 29 nodos "sanos" tenían el 100% de sus
 * "entregados" de esta forma, y el panel les mostraba "47 entregados" como si fuera salud de entrega.
 */
const CRUDA_PIPE_LOCAL =
  "Aug  2 12:16:11 smtp postfix/local[2492266]: %QID%: to=<bounce+%DEST%@annualcorp-control.com>, relay=local, " +
  "delay=0.3, delays=0.02/0.01/0/0.27, dsn=2.0.0, status=sent (delivered to command: /usr/local/bin/nfc-verp-bounce.sh)";

/** Una entrega de verdad, a un tercero. */
const CRUDA_GMAIL_SENT =
  "Aug  3 12:03:44 smtp postfix/smtp[2620473]: %QID%: to=<%DEST%@gmail.com>, " +
  "relay=gmail-smtp-in.l.google.com[142.250.31.26]:25, delay=45, delays=0.16/44/0.1/0.71, dsn=2.0.0, " +
  "status=sent (250 2.0.0 OK  1785751424 af79cd13be357-9349c24c20esi602140285a.351 - gsmtp)";

/**
 * El queue-id 4A87646C14, REAL: 105 líneas en el log de 80.190.76.57, difiriendo desde el 27/7 con
 * "452-4.2.2 inbox is out of storage space" y rebotando el 1/8. Es UN mensaje y el sensor lo cuenta
 * en DOS baldes (1 diferido + 1 rechazado) porque cada estado se dedupea por separado.
 *
 * EL `%SID%` NO ES DECORACIÓN, y hasta el 2026-08-08 este fixture lo tenía CLAVADO — que es la forma
 * exacta del error contra el que este repo tiene una lección escrita: un fixture escrito desde la
 * suposición de quien escribe el código no prueba nada. Con el id fijo, mil mensajes colapsaban en
 * UNA fila del `sort | uniq -c` y ninguna prueba podía ver el problema real. En el log de verdad
 * cada mensaje trae SU id de sesión de Gmail y el `cut -c1-200` NO se lo lleva (arranca en el
 * carácter ~158): medido, gmail.com deja 217 filas distintas en nationalcorpops.com y 260 en
 * annualcorp-ops.com — más filas que el techo global entero de la sección.
 */
const CRUDA_GMAIL_DEFERRED_QUOTA =
  "Aug  2 00:01:11 smtp postfix/smtp[177237]: %QID%: to=<%DEST%@gmail.com>, " +
  "relay=alt1.gmail-smtp-in.l.google.com[108.177.123.26]:25, delay=1.5, delays=0.23/0/0.91/0.33, dsn=4.2.2, " +
  "status=deferred (host alt1.gmail-smtp-in.l.google.com[108.177.123.26] said: 452-4.2.2 The recipient's inbox " +
  "is out of storage space. Please direct the 452-4.2.2 recipient to 452 4.2.2  " +
  "https://support.google.com/mail/?p=OverQuotaTemp %SID% - gsmtp " +
  "(in reply to RCPT TO command))";

/**
 * EL TRANSITORIO SUELTO. Línea cruda de annualcorp-ops.com (80.190.76.69), bajada por SSH el
 * 2026-08-08: UNA sola aparición contra 296 líneas de casilla llena del MISMO receptor. La tabla de
 * `MOTIVOS_DE_CULPA` no la conoce, así que clasifica `"no-se"` — y con el desempate por máximo esa
 * única línea se llevaba puesto al receptor entero.
 */
const CRUDA_GMAIL_DEFERRED_421 =
  "Aug  5 19:38:56 smtp postfix/smtp[242970]: %QID%: to=<%DEST%@gmail.com>, " +
  "relay=alt1.gmail-smtp-in.l.google.com[108.177.123.27]:25, delay=200151, delays=200135/3.3/1.6/10, dsn=4.3.0, " +
  "status=deferred (host alt1.gmail-smtp-in.l.google.com[108.177.123.27] said: 421-4.3.0 Temporary System " +
  "Problem. Try again later. For more information, go to 421 4.3.0  " +
  "https://support.google.com/a/answer/3221692 %SID% - gsmtp (in reply to RCPT TO command))";

/**
 * N copias de una línea cruda, cada una con su queue-id, su destinatario y —cuando la plantilla lo
 * pide— SU id de sesión, como en el log real. Ver `CRUDA_GMAIL_DEFERRED_QUOTA`.
 */
function crudas(plantilla: string, cuantos: number, sello: string, desde = 0): string[] {
  return Array.from({ length: cuantos }, (_, i) =>
    plantilla
      .replace("%QID%", `${sello}${String(desde + i).padStart(7, "0")}`)
      .replace("%DEST%", `dest${desde + i}`)
      // El id de sesión VARÍA DESDE EL PRIMER CARÁCTER, como los de verdad
      // (`af79cd13be357-9349c2bdc25si356485585a.527`, `d2e1a72fcca58-84f2e5c7dedsi7760282b3a.128`).
      // Generarlo con un prefijo fijo y el número al final es la trampa del fixture escrito de
      // memoria: el `cut -c1-200` corta la cola, los ids colapsan entre sí y la prueba deja de ver
      // la cardinalidad real del log — que es justo lo que se está probando.
      .replace("%SID%", `${(0x1a2e0cc1a25 + (desde + i) * 0x9e3779b1).toString(16).slice(-13)}-${(0x977e6b2b7e7 + (desde + i) * 0x85ebca6b).toString(16).slice(-11)}si${1120678241 + desde + i}.${286 + ((desde + i) % 97)}`)
  );
}

async function correrSobre(t: { after: (fn: () => unknown) => void }, nombre: string, lineas: string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), `delivrix-${nombre}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "mail.log"), `${lineas.join("\n")}\n`, "utf8");
  const salida = execFileSync("bash", ["-c", buildDeliveryStatsCommand("todo", 5, dir, HOY)], { encoding: "utf8" });
  return { salida, leido: parseDeliveryStats(salida)! };
}

test("EL INCIDENTE 2026-08-07: annualcorp-control.com con 16 entregados / 1 rechazado ya NO puede salir 'healthy'", async (t) => {
  // LOS NÚMEROS DEL INCIDENTE, TEXTUALES. El mismo nodo, el mismo código, dos corridas:
  //   20:05 UTC → 165 entregados / 136 rechazados → blocked_by_provider
  //   23:00 UTC →  16 entregados /   1 rechazado  → healthy
  // No lo movió el dedup (el dedup ya estaba desplegado en las dos): lo movió la ventana de 5 días
  // soltando el 3 de agosto, que aportaba 149 entregas y 135 rechazos él solo. El nodo dejó de mandar
  // PORQUE estaba bloqueado, y al quedarse callado se absolvió solo.
  //
  // Y lo que quedó del lado "sano" es esto: 16 entregas que son TODAS a su propio pipe de rebotes, y
  // un rechazo de Gmail que no cruza el piso de 20. Con `continue` pelado, `blockedProviders: []` y
  // el último `return`, el nodo con 136 rechazos 550-5.7.1 de hacía cuatro días se leía verde.
  const { leido } = await correrSobre(t, "incidente", [
    ...crudas(CRUDA_PIPE_LOCAL, 16, "PIP"),
    ...crudas(CRUDA_GMAIL_UNSOLICITED, 1, "GML")
  ]);

  // Primero: el sensor CUENTA bien. Nunca contó mal — reproducir 16/1 es la prueba de que lo que se
  // arregla no es el conteo sino lo que se CONCLUYE cuando el conteo es chico.
  assert.deepEqual(leido.total.totals, { delivered: 16, blocked: 1, deferred: 0 }, "los 16/1 del encargo");
  assert.equal(leido.culpa["gmail.com"], "dominio", "y ahora sí sabe POR QUÉ (antes: 'no-se')");

  const verdict = assessDeliveryHealth(leido.total, "annualcorp-control.com", {
    encolados: 2, culpa: leido.culpa
  });
  assert.equal(verdict.status, "insufficient_sample", "16/1 con Gmail al 100% de rechazo NO es un nodo sano");
  assert.deepEqual(verdict.sinMuestra, ["gmail.com"]);
  // NO SE CONVIERTE EN UN CANDADO: `blockedProviders` es lo que se persiste como `cerradoEn`, y
  // `cerradoEn` no caduca. Un rechazo no puede condenar el dominio para siempre.
  assert.deepEqual(verdict.blockedProviders, [], "un solo rechazo no escribe cerradoEn");
  // Y EL TEXTO QUE LEE EL OPERADOR DEJA DE MENTIR: las 16 "entregas" son al pipe local
  // /usr/local/bin/nfc-verp-bounce.sh. Entregas a un tercero en la ventana: CERO.
  assert.match(verdict.detail, /gmail\.com/);
  assert.doesNotMatch(verdict.detail, /^16 entregados/, "el número que sonaba a salud era su propio rebote");
});

test("la ENTREGA A SÍ MISMO no se cuenta como entrega en el texto que lee el operador", async (t) => {
  // 23 de los 29 nodos "healthy" del 2026-08-08 publicaban "47 entregados", "48 entregados", "16
  // entregados" — y el 100% de esas entregas eran a su propio manejador de rebotes por un pipe local.
  // `assessDeliveryHealth` ya excluía el dominio propio del LOOP que dictamina bloqueo, pero no de
  // `stats.totals`, que es de donde sale la frase. El veredicto no cambia; cambia lo que el sistema
  // afirma sobre sí mismo, que es de donde salió el incidente de la compra de dominios.
  const { leido } = await correrSobre(t, "autoentrega", [
    ...crudas(CRUDA_PIPE_LOCAL, 16, "PIP"),
    ...crudas(CRUDA_GMAIL_SENT, 25, "SNT")
  ]);
  const verdict = assessDeliveryHealth(leido.total, "annualcorp-control.com", { encolados: 0 });
  assert.equal(verdict.status, "healthy");
  assert.match(verdict.detail, /^25 entregados a terceros/, "las 25 reales, no las 41 del total");
  assert.match(verdict.detail, /16 a sí mismo/, "y las suyas se nombran aparte, no se esconden");
});

test("LA PUERTA 4xx: Yahoo nos cierra sin rebotar nunca, y el sensor lo dice — pero NO como cerradoEn", async (t) => {
  // EL AGUJERO POR CONSTRUCCIÓN: `attempts = delivered + blocked`. Un receptor que rechaza SIEMPRE
  // con código temporal jamás suma un intento, así que no hay piso que cruzar ni ratio que calcular.
  // Yahoo nos dijo 34.524 veces `421 4.7.0 [TSS04] Messages from 193.181.212.223 temporarily deferred
  // due to unexpected volume or user complaints`, con nuestra IP por escrito, y `blockedProviders`
  // salía `[]`. La tabla de `Culpa` tampoco lo ve: solo lee `status=bounced`.
  //
  // El fixture pone las dos poblaciones juntas en el MISMO nodo, que es lo que discrimina: Yahoo con
  // 5 mensajes trabados a 8 reintentos cada uno, y Gmail difiriendo una vez y entregando. Si la regla
  // fuera un ratio global de diferidos, los dos caerían igual.
  const { leido } = await correrSobre(t, "puerta4xx", [
    ...Array.from({ length: 5 }, (_, msg) =>
      Array.from({ length: 8 }, () => CRUDA_YAHOO_TSS04.replace("%QID%", `YHO000000${msg}`).replace("%DEST%", `dest${msg}`))
    ).flat(),
    ...crudas(CRUDA_GMAIL_DEFERRED_QUOTA, 1, "GMD"),
    ...crudas(CRUDA_GMAIL_SENT, 1, "GMS")
  ]);

  const yahoo = leido.total.byProvider.find((p) => p.provider === "yahoo.com")!;
  assert.equal(yahoo.deferred, 5, "5 mensajes, no 40 líneas");
  assert.equal(yahoo.intentos?.deferred, 40, "y las 40 líneas, de la misma pasada");
  assert.ok(40 / 5 >= PRESION_BLOQUEO, "8 reintentos por mensaje: arriba del umbral de puerta cerrada");

  const verdict = assessDeliveryHealth(leido.total, undefined, {
    encolados: 0, culpa: leido.culpa, culpaDiferido: leido.culpaDiferido
  });
  assert.equal(verdict.status, "stalled");
  assert.match(verdict.detail, /yahoo\.com/, "nombra al receptor que cierra la puerta");
  assert.doesNotMatch(verdict.detail, /gmail\.com/, "y NO acusa al que difiere una vez y entrega");
  // EL ASSERT QUE PROTEGE LA DECISIÓN ARQUITECTÓNICA. La puerta 4xx devuelve `stalled` y jamás
  // escribe `blockedProviders`, porque ése es el cable que sender-measurement persiste como
  // `cerradoEn` y `cerradoEn` NO CADUCA. Un dominio recién comprado cuyo primer lote difiera cinco
  // mensajes con el backoff normal de Postfix quedaría inelegible PARA SIEMPRE por un throttle
  // transitorio. `stalled` se recalcula sobre los 5 días: el nodo se calla, su ventana se vacía y
  // vuelve a `no_traffic`, que es la puerta que el pool abre a propósito.
  assert.deepEqual(verdict.blockedProviders, [], "la puerta 4xx no puede condenar un dominio para siempre");
});

test("UN mensaje que se difiere y después rebota se cuenta en los DOS baldes: por eso murió el ratio 0,5", async (t) => {
  // El queue-id 4A87646C14, real, dejó 105 líneas en 80.190.76.57: difirió desde el 27/7 con "inbox
  // is out of storage space" y rebotó el 1/8 con "reputation of the sending domain". Es UN mensaje.
  //
  // Cada estado se dedupea en su propio pipe (`grep status=X | ... | sort | uniq -c`, tres veces) y
  // NO HAY DESEMPATE entre ellos, así que ese mensaje suma +1 a `deferred` Y +1 a `bounced`. Para un
  // nodo cuyo correo se difiere una vez y sale, `deferred ≈ sent + blocked` y el ratio de diferidos
  // tiende a 0,5000 EXACTO — que con `>=` disparaba `stalled`. Medido el 2026-08-08: 33 de 64 nodos
  // en ese balde y 38 en la banda 0,40-0,60. El veredicto de más de media flota lo decidía un
  // mensaje. `STALLED_MIN_DEFERRED_RATIO` no se recalibró: dejó de medir y se borró.
  //
  // Lo que lo reemplaza mide otra cosa: `atascados = max(0, deferred − delivered − blocked)`. Este
  // mensaje RESOLVIÓ, así que se resta y no cuenta como trabado. Es una cota inferior a propósito —
  // subestima lo trabado, nunca lo infla.
  const { leido } = await correrSobre(t, "dosestados", [
    ...Array.from({ length: 8 }, () =>
      CRUDA_GMAIL_DEFERRED_QUOTA.replace("%QID%", "4A87646C14").replace("%DEST%", "hunterrollins00")
    ),
    CRUDA_GMAIL_DOMINIO_CORTADO.replace("%QID%", "4A87646C14").replace("%DEST%", "hunterrollins00"),
    ...crudas(CRUDA_GMAIL_SENT, 25, "SNT")
  ]);

  const gmail = leido.total.byProvider.find((p) => p.provider === "gmail.com")!;
  assert.equal(gmail.deferred, 1, "el mismo queue-id, contado una vez como diferido");
  assert.equal(gmail.blocked, 1, "Y una vez como rechazado: no hay desempate entre estados");
  assert.equal(gmail.intentos?.deferred, 8, "8 líneas de reintento detrás de ese único mensaje");
  assert.equal(gmail.delivered, 25);
  // Con el ratio viejo esto era 1 diferido sobre 2 resoluciones = 0,50 exacto, o sea cara o cruz.
  // Con la regla nueva: atascados = max(0, 1 − 25 − 1) = 0. El mensaje resolvió, no está trabado.
  const verdict = assessDeliveryHealth(leido.total, undefined, { encolados: 0, culpa: leido.culpa });
  assert.notEqual(verdict.status, "stalled", "un mensaje que resolvió no deja el nodo atascado");
  assert.equal(verdict.status, "healthy");
});

test("MOTIVOS_DE_CULPA contra las líneas CRUDAS: el prefijo de continuación caía adentro de la frase", () => {
  // EL DEFECTO, medido y no deducido. Postfix aplasta la respuesta multilínea del receptor en UNA
  // línea de log y cada continuación arrastra su `550-5.7.1 `. Dónde cae depende del LARGO DE LA IP,
  // porque la IP va al principio de la respuesta y empuja el corte:
  //   · 80.190.76.57    (12 caracteres) → "…reputation of the sending domain."            4.148 veces
  //   · 193.181.212.223 (15 caracteres) → "…reputation of the sending 550-5.7.1 domain." 16.253 veces
  //     y la frase sin cortar, en ese nodo: CERO.
  // O sea que el patrón acertaba el 100% en un nodo y el 0% en el otro. Ese nodo entero salía
  // "no-se" y nadie podía contestar si un dominio nuevo sobre esa IP arreglaba algo.
  const motivo = (linea: string): string => linea.slice(linea.indexOf("said: ") + 6);

  assert.equal(clasificarCulpa(motivo(CRUDA_GMAIL_DOMINIO_CORTADO)), "dominio", "la frase cortada por el wrap");
  assert.equal(clasificarCulpa(motivo(CRUDA_GMAIL_UNSOLICITED)), "dominio", "'likely unsolicited mail', que no tenía patrón");
  // LA VARIANTE QUE DESMIENTE LA COMPRA: Gmail culpando a la IP, con la frase casi calcada. Tres
  // letras separan "comprá un dominio nuevo" de "no gastes un peso" — y sobre la MISMA IP, un dominio
  // nuevo nace bloqueado.
  assert.equal(clasificarCulpa(CRUDA_GMAIL_IP), "ip");
  // Y la del buzón sigue leyéndose: la limpieza solo saca la forma con GUIÓN (`550-5.7.1`), que es la
  // de continuación. La forma con espacio es la línea final de la respuesta y lleva el código que
  // este patrón necesita.
  assert.equal(clasificarCulpa("550 5.1.1 <nadie@comcast.net> user unknown (in reply to RCPT TO command)"), "buzon");
  assert.equal(clasificarCulpa("550-5.1.1 The email account that you tried to reach does not exist."), "buzon");

  // LOS 4xx, que es lo que la regla de la puerta necesita separar. Los tres textos salen del log
  // crudo y están contados: el de Yahoo 34.524 veces, el de Comcast/Charter ~2.000 y el de la casilla
  // llena 864+1.026 en los dos nodos.
  assert.equal(
    clasificarCulpa("421 4.7.0 [TSS04] Messages from 193.181.212.223 temporarily deferred due to unexpected volume or user complaints"),
    "ip",
    "Yahoo nombra NUESTRA IP: es una puerta cerrada"
  );
  assert.equal(
    clasificarCulpa("delivery temporarily suspended: host mx2a1.comcast.net[96.103.145.162] refused to talk to me: 554 imp"),
    "ip",
    "Comcast rechaza la CONEXIÓN con un 554 y Postfix lo anota como deferred: invisible para delivered+blocked"
  );
  assert.equal(
    clasificarCulpa("host alt1.gmail-smtp-in.l.google.com said: 452-4.2.2 The recipient's inbox is out of storage space."),
    "buzon",
    "y la casilla llena es del TERCERO: no puede leerse como puerta cerrada"
  );
  // El orden importa y no es casual: un receptor que nos difiere por las DOS razones tiene que
  // resolver a favor de la que habla de nosotros, o una casilla llena taparía el cierre.
  assert.equal(
    clasificarCulpa("452 4.1.1 <x@comcast.net> user over quota; refused to talk to me: 554 imp"),
    "ip"
  );
});

test("la culpa cruda viaja por el camino de producción, no solo por clasificarCulpa()", async (t) => {
  // El clasificador puede estar perfecto y el dato no llegar igual: entre el log y él hay un grep, un
  // sed que le saca el `host … said:`, un `tr -d '#'` y un `cut -c1-200`. La frase de Gmail cortada
  // por el wrap cierra en el carácter 165, o sea que entra — pero eso se MIDE acá, con bash, no se
  // supone.
  const { leido } = await correrSobre(t, "culpacruda", [
    ...crudas(CRUDA_GMAIL_DOMINIO_CORTADO, 25, "GML"),
    ...crudas(CRUDA_YAHOO_TSS04, 25, "YHO")
  ]);
  assert.equal(leido.culpa["gmail.com"], "dominio", "el corte a 200 caracteres no se come la frase");
  assert.equal(leido.culpa["yahoo.com"], undefined, "el 4xx no entra a la tabla de culpas: solo lee bounced");
});

test("resolverPresionBloqueo: es una perilla, y no acepta valores que acusarían a media flota", () => {
  // Abajo de 1,5 "se difirió una vez" pasaría por "puerta cerrada": medido, un mensaje que se difiere
  // y sale deja 1,0-1,5 líneas. El default de 6 cae en el hueco de la distribución (entre 1,5 y 11 no
  // hay NADA en la flota), no en una pendiente, así que moverlo un punto no cambia un veredicto.
  assert.equal(resolverPresionBloqueo(undefined), 6);
  assert.equal(resolverPresionBloqueo("1.0"), 6, "1,0 acusaría a cualquiera que difiera una vez");
  assert.equal(resolverPresionBloqueo("0"), 6);
  assert.equal(resolverPresionBloqueo("999"), 6);
  assert.equal(resolverPresionBloqueo("no"), 6);
  assert.equal(resolverPresionBloqueo("10"), 10, "y sí se puede mover sin desplegar");
  assert.equal(PRESION_BLOQUEO, 6, "el default vigente, para que el resto de los tests signifiquen algo");
  assert.equal(BLOCKED_MIN_ATTEMPTS, 20, "el piso NO se bajó: se midió que su unidad no cambió (factor 1,00)");
});

test("LA CASILLA LLENA DE UN TERCERO NO ES UNA PUERTA CERRADA: el motivo del 4xx también se lee", async (t) => {
  // ESTE DEFECTO LO ENCONTRÓ LA VERIFICACIÓN POR EL CAMINO DE PRODUCCIÓN, no el fixture. Con la regla
  // de la puerta recién escrita, annualcorp-control.com salía `stalled` con el detalle "gmail.com no
  // abre la puerta". Fui a mirar el log crudo del nodo y los 864 diferidos hacia Gmail de la ventana
  // son 864 de 864 `452-4.2.2 The recipient's inbox is out of storage space`: SIETE casillas llenas
  // reintentadas ~108 veces cada una. Gmail no nos estaba cerrando nada.
  //
  // O sea que la regla nueva reproducía, en espejo, la enfermedad que vino a curar: afirmar sobre un
  // hecho que no midió. La presión sola no distingue "me difieren porque la casilla está llena" de
  // "me difieren porque no me quieren" — hace falta el MOTIVO, y el 4xx nunca se leía.
  //
  // El nodo igual no queda sano: cae en `insufficient_sample` por el rechazo 5xx de Gmail, que es el
  // veredicto correcto. La diferencia no es el color, es qué afirma el sistema.
  const { leido } = await correrSobre(t, "casillallena", [
    ...Array.from({ length: 7 }, (_, msg) =>
      Array.from({ length: 8 }, () =>
        CRUDA_GMAIL_DEFERRED_QUOTA.replace("%QID%", `QTA000000${msg}`).replace("%DEST%", `dest${msg}`)
      )
    ).flat(),
    ...crudas(CRUDA_GMAIL_UNSOLICITED, 1, "GML"),
    ...crudas(CRUDA_PIPE_LOCAL, 16, "PIP")
  ]);

  const gmail = leido.total.byProvider.find((p) => p.provider === "gmail.com")!;
  assert.equal(gmail.deferred, 7, "7 mensajes trabados: cruzan ATASCADOS_MIN");
  assert.equal(gmail.intentos?.deferred, 56, "a 8 reintentos cada uno: cruzan PRESION_BLOQUEO");
  assert.equal(leido.culpaDiferido["gmail.com"], "buzon", "y el motivo dice que es del DESTINATARIO");
  assert.equal(leido.culpa["gmail.com"], "dominio", "el 5xx sigue en su propio mapa, sin mezclarse");

  const verdict = assessDeliveryHealth(leido.total, "annualcorp-control.com", {
    encolados: 2, culpa: leido.culpa, culpaDiferido: leido.culpaDiferido
  });
  assert.doesNotMatch(verdict.detail, /no abre la puerta/, "no se acusa a Gmail de algo que no hizo");
  assert.equal(verdict.status, "insufficient_sample", "pero tampoco queda sano: el 5xx sigue sin juzgarse");

  // Y EL CONTROL: los MISMOS números de mensajes y reintentos, con el motivo de Yahoo en vez del de
  // la casilla llena, SÍ son una puerta cerrada. Lo único que cambia entre los dos casos es el texto
  // que escribió el receptor, que es exactamente lo que la regla tiene que estar mirando.
  const { leido: conYahoo } = await correrSobre(t, "casillallena-control", [
    ...Array.from({ length: 7 }, (_, msg) =>
      Array.from({ length: 8 }, () =>
        CRUDA_YAHOO_TSS04.replace("%QID%", `TSS000000${msg}`).replace("%DEST%", `dest${msg}`)
      )
    ).flat()
  ]);
  assert.equal(conYahoo.culpaDiferido["yahoo.com"], "ip", "el 421 de Yahoo nombra NUESTRA IP");
  const cerrado = assessDeliveryHealth(conYahoo.total, undefined, {
    encolados: 0, culpa: conYahoo.culpa, culpaDiferido: conYahoo.culpaDiferido
  });
  assert.equal(cerrado.status, "stalled");
  assert.match(cerrado.detail, /yahoo\.com no abre la puerta/);
});

test("un motivo 4xx que NO sabemos clasificar sigue contando como puerta cerrada (fail-closed)", () => {
  // La asimetría es deliberada y es la regla de la casa: solo `"buzon"` —evidencia POSITIVA de que
  // el problema es del destinatario— desactiva la puerta. "No sé por qué me difiere" no es "me
  // difiere por culpa del tercero", y ausencia de dato no es evidencia.
  const trabado: NodeDeliveryStats = {
    totals: { delivered: 0, blocked: 0, deferred: 6 },
    intentos: { delivered: 0, blocked: 0, deferred: 60 },
    byProvider: [{
      provider: "comcast.net", delivered: 0, blocked: 0, deferred: 6,
      intentos: { delivered: 0, blocked: 0, deferred: 60 }
    }]
  };
  assert.equal(assessDeliveryHealth(trabado, undefined, { encolados: 0 }).status, "stalled");
  assert.equal(
    assessDeliveryHealth(trabado, undefined, { encolados: 0, culpaDiferido: { "comcast.net": "no-se" } }).status,
    "stalled"
  );
  assert.equal(
    assessDeliveryHealth(trabado, undefined, { encolados: 0, culpaDiferido: { "comcast.net": "buzon" } }).status,
    "healthy",
    "y con evidencia de que es el buzón del tercero, la puerta no se acusa"
  );
});

test("la sección CULPA vieja de DOS columnas se sigue leyendo: nadie queda ilegible en el despliegue", () => {
  // Entre que esto se despliega y que cada uno de los 58 nodos corre el comando nuevo conviven las
  // dos formas de la sección: `<receptor>\t<motivo>` (vieja, solo rebotes) y `<receptor>\t<status>\t
  // <motivo>` (nueva). Este archivo ya se quemó TRES veces con "salida distinta a la esperada" leída
  // como un desastre; la vieja se cuenta como rechazo, que es lo único que esa versión miraba.
  const vieja =
    "## DELIVERED\n## OWN_DELIVERED\n## BLOCKED\n  3883 gmail.com\n## OWN_BLOCKED\n" +
    "## DEFERRED\n## OWN_DEFERRED\n## CULPA\n" +
    `gmail.com\t550-5.7.1 Gmail has detected that this message is likely unsolicited mail.\n` +
    "## QUEUE\nMail queue is empty\n## END\n";
  const leido = parseDeliveryStats(vieja)!;
  assert.equal(leido.culpa["gmail.com"], "dominio", "dos columnas = un rechazo, como antes");
  assert.deepEqual(leido.culpaDiferido, {}, "y ninguna culpa de diferido inventada");
});

test("el techo de la sección CULPA corta por FRECUENCIA, no por orden alfabético", async (t) => {
  // DEFECTO REAL, encontrado corriendo el sensor contra producción y no en un fixture. Con el techo
  // ordenado alfabéticamente, corpfilingcontrol.com publicaba "gmail.com no abre la puerta" — y sus
  // 1.026 diferidos hacia Gmail eran 1.026 de 1.026 `452-4.2.2 out of storage space`. La fila que lo
  // desmentía existía y se caía por el corte: al sumar el diferido, la sección pasó de 3-12 filas
  // distintas a 764 y 989 (medido en los dos nodos), porque el correo de NFC toca miles de dominios
  // receptores y cada uno deja su fila.
  //
  // Ordenado por cantidad de líneas, lo que sobrevive es lo que tiene volumen — que es exactamente lo
  // que las dos reglas necesitan para disparar. El ruido de una línea se cae, y no decide nada.
  const ruido = Array.from({ length: 250 }, (_, i) =>
    // Misma línea real, con el dominio receptor cambiado: ordena ANTES que gmail.com y con el techo
    // viejo se comía la sección entera.
    CRUDA_GMAIL_DEFERRED_QUOTA
      .replace("%QID%", `NOI${String(i).padStart(7, "0")}`)
      .replace("%DEST%", `x${i}`)
      .replace("@gmail.com", `@aaa${String(i).padStart(4, "0")}.example`)
  );
  const { leido } = await correrSobre(t, "techoculpa", [
    ...ruido,
    ...Array.from({ length: 7 }, (_, msg) =>
      Array.from({ length: 8 }, () =>
        CRUDA_GMAIL_DEFERRED_QUOTA.replace("%QID%", `QTA000000${msg}`).replace("%DEST%", `dest${msg}`)
      )
    ).flat()
  ]);

  assert.equal(
    leido.culpaDiferido["gmail.com"],
    "buzon",
    "la fila con 56 líneas no puede perderse detrás de 250 filas de una línea"
  );
  const verdict = assessDeliveryHealth(leido.total, undefined, {
    encolados: 0, culpa: leido.culpa, culpaDiferido: leido.culpaDiferido
  });
  assert.doesNotMatch(verdict.detail, /gmail\.com no abre la puerta/);
});

// ── EL GATE DEL BUZÓN ESTABA INVERTIDO ─────────────────────────────────────────────────────────

/** La puerta MÁS dura que existe: el MX ni acepta la conexión. Texto real, citado por el módulo. */
const CRUDA_GMAIL_CONN_REFUSED =
  "Aug  2 00:11:15 smtp postfix/smtp[177424]: %QID%: to=<%DEST%@gmail.com>, " +
  "relay=none, delay=101, delays=101/0.01/0/0, dsn=4.4.1, " +
  "status=deferred (delivery temporarily suspended: connect to alt4.gmail-smtp-in.l.google.com[172.253.157.26]:25: " +
  "Connection refused)";

test("UNA casilla llena no puede absolver a un receptor que nos tiene la puerta cerrada", async (t) => {
  // EL DEFECTO, y el archivo afirmaba lo contrario en su propio comentario: "Fail-closed igual: solo
  // `buzon` desactiva la puerta. Un motivo que no sabemos clasificar (`no-se`) SÍ cuenta".
  //
  // `parseCulpa` desempataba el mapa de DIFERIDOS con `PESO_DE_CULPA`, que se diseñó para la decisión
  // de COMPRA sobre rechazos 5xx: ahí gana lo más grave y `buzon` es lo más leve (peso 1 contra 0 de
  // `no-se`). Reusado para los 4xx invierte el sentido, porque ahí `buzon` es el valor que ABSUELVE.
  // Resultado: un receptor que nos difiere N mensajes con un texto que la tabla todavía no conoce
  // MÁS una sola casilla llena clasificaba `buzon` entero, y la puerta se callaba.
  //
  // Corre por el camino de producción: el mismo `buildDeliveryStatsCommand`, con bash, sobre líneas
  // crudas del log real. En la flota de hoy no enmascara a nadie (barrido pasivo sobre los 64 nodos:
  // 0 receptores afectados), porque hace falta un texto de puerta que la tabla no conozca — pero
  // `no-se` es por definición el balde del receptor que todavía no vimos.
  assert.equal(
    clasificarCulpa("delivery temporarily suspended: connect to alt4.gmail-smtp-in.l.google.com[172.253.157.26]:25: Connection refused"),
    "no-se",
    "el MX que rechaza la conexión no tiene patrón en la tabla: es 'no-se'"
  );

  const puerta = Array.from({ length: 10 }, (_, m) =>
    Array.from({ length: 8 }, () =>
      CRUDA_GMAIL_CONN_REFUSED.replace("%QID%", `REF000000${m}`).replace("%DEST%", `d${m}`)
    )
  ).flat();

  const solo = await correrSobre(t, "puertasola", puerta);
  assert.equal(
    assessDeliveryHealth(solo.leido.total, undefined, { encolados: 0, culpa: solo.leido.culpa, culpaDiferido: solo.leido.culpaDiferido }).status,
    "stalled",
    "10 mensajes colgados a 8 reintentos contra un MX cerrado: puerta cerrada"
  );

  // La MISMA puerta, más UN solo mensaje a una casilla llena. Antes esto salía `healthy`.
  const mezcla = await correrSobre(t, "puertamezcla", [
    ...puerta,
    ...Array.from({ length: 8 }, () => CRUDA_GMAIL_DEFERRED_QUOTA.replace("%QID%", "QTA0000000").replace("%DEST%", "lleno"))
  ]);
  assert.equal(mezcla.leido.culpaDiferido["gmail.com"], "no-se", "la casilla llena no puede ganarle a un motivo sin clasificar");
  assert.equal(
    assessDeliveryHealth(mezcla.leido.total, undefined, { encolados: 0, culpa: mezcla.leido.culpa, culpaDiferido: mezcla.leido.culpaDiferido }).status,
    "stalled",
    "once mensajes colgados, 88 líneas y cero entregas no son un nodo sano"
  );
});

test("y la casilla llena SIGUE absolviendo cuando es lo único que hay: el mapa de 5xx no se movió", async (t) => {
  // LA MITAD QUE NO SE PUEDE ROMPER, y la que hace que el arreglo ingenuo no sirva: si `no-se` pesara
  // más que `buzon` a secas, `buzon` no se escribiría NUNCA (el acumulador arranca con el centinela
  // `"no-se"`) y volveríamos a acusar a Gmail por las 864 casillas llenas de annualcorp-control.com.
  // Por eso el desempate compara contra "no vi nada" (`undefined`), no contra el centinela.
  const solo = await correrSobre(t, "solobuzon", Array.from({ length: 7 }, (_, m) =>
    Array.from({ length: 8 }, () => CRUDA_GMAIL_DEFERRED_QUOTA.replace("%QID%", `QTA000000${m}`).replace("%DEST%", `d${m}`))
  ).flat());
  assert.equal(solo.leido.culpaDiferido["gmail.com"], "buzon");
  assert.doesNotMatch(
    assessDeliveryHealth(solo.leido.total, undefined, { encolados: 0, culpa: solo.leido.culpa, culpaDiferido: solo.leido.culpaDiferido }).detail,
    /gmail\.com no abre la puerta/
  );

  // Y el mapa de RECHAZOS conserva su semántica exacta: el primer `no-se` se sigue escribiendo, y una
  // culpa más grave le sigue ganando.
  const cinco =
    "## DELIVERED\n## OWN_DELIVERED\n## BLOCKED\n  40 gmail.com\n## OWN_BLOCKED\n## DEFERRED\n## OWN_DEFERRED\n## CULPA\n" +
    "gmail.com\tbounced\t550 5.0.0 algo que nadie clasificó\n" +
    "gmail.com\tbounced\t550-5.7.1 Gmail has detected that this message is likely unsolicited mail.\n" +
    "## QUEUE\nMail queue is empty\n## END\n";
  assert.equal(parseDeliveryStats(cinco)!.culpa["gmail.com"], "dominio", "en 5xx gana la culpa más grave, como siempre");
});

// ── LOS RECEPTORES GRANDES QUE LA TABLA NO CONOCÍA ─────────────────────────────────────────────

test("bellsouth.net rechaza el 100% bajo el piso ⇒ insufficient_sample, no `healthy`", () => {
  // `providerFamilyFor` matchea por dominio EXACTO y la tabla listaba 23 literales, así que
  // bellsouth.net, sbcglobal.net, att.net, verizon.net, myyahoo.com y las variantes por país caían en
  // "otros" — y el veto `insufficient_sample` pide `providerFamilyFor(x) !== "otros"` para que un typo
  // (`gamil.com`) no congele un dominio. Consecuencia: un nodo cuyo único receptor con rechazo del
  // 100% fuera uno de ésos salía `healthy` con "0 entregados a terceros, 3 rechazados", que es la
  // firma exacta de "no medido leído como sano".
  //
  // No son receptores de laboratorio: son los buzones de NFC. Medidos en la flota (5 días, 58 nodos,
  // 2026-08-08): bellsouth.net 671 entregas / 982 diferidos en 7 nodos, verizon.net 461/555 en 7,
  // att.net 388/490 en 7. Hoy los salva del hueco que TODAVÍA entregan; el día que caigan bajo el
  // piso —el escenario que este lote prepara— el veto se apagaba para ellos en silencio.
  const conUnRechazo = (dom: string): NodeDeliveryStats => ({
    totals: { delivered: 0, blocked: 3, deferred: 0 },
    intentos: { delivered: 0, blocked: 3, deferred: 0 },
    byProvider: [{ provider: dom, delivered: 0, blocked: 3, deferred: 0, intentos: { delivered: 0, blocked: 3, deferred: 0 } }]
  });
  for (const dom of ["bellsouth.net", "sbcglobal.net", "att.net", "verizon.net", "myyahoo.com", "yahoo.com.mx", "hotmail.fr", "outlook.com.br", "wi.rr.com", "tampabay.rr.com"]) {
    const v = assessDeliveryHealth(conUnRechazo(dom), undefined, { encolados: 0 });
    assert.equal(v.status, "insufficient_sample", `${dom} rechazó todo lo que le mandamos y salió '${v.status}'`);
    assert.deepEqual(v.sinMuestra, [dom]);
  }
  // Y el typo sigue sin congelar nada, que es para lo que el filtro existe.
  for (const typo of ["gamil.com", "yahoo.comm", "hotmail.con", "askherr.com"]) {
    assert.equal(assessDeliveryHealth(conUnRechazo(typo), undefined, { encolados: 0 }).status, "healthy", typo);
  }
});

// ── LA CUENTA QUE EL SENSOR CALCULABA Y TIRABA ─────────────────────────────────────────────────

test("el veredicto publica `entregadosATerceros`, y NO es `stats.totals.delivered`", () => {
  // La fila medida por SSH contra 193.181.212.223 (corpfilingcontrol.com) el 2026-08-08 con la ventana
  // en 3 días: `healthy` con 6 entregas, las 6 al propio dominio por el pipe de rebotes. El detalle ya
  // lo decía ("0 entregados a terceros ... y 6 a sí mismo") y el número se tiraba: quien decide el
  // pool leía `entregados`, el total. Ahora viaja en el veredicto, para los SIETE estados y no sólo
  // para la frase de `healthy` — que era donde vivía la cuenta.
  const soloASiMismo: NodeDeliveryStats = {
    totals: { delivered: 6, blocked: 0, deferred: 7 },
    intentos: { delivered: 6, blocked: 0, deferred: 7 },
    byProvider: [
      { provider: "corpfilingcontrol.com", delivered: 6, blocked: 0, deferred: 0, intentos: { delivered: 6, blocked: 0, deferred: 0 } },
      { provider: "gmail.com", delivered: 0, blocked: 0, deferred: 7, intentos: { delivered: 0, blocked: 0, deferred: 7 } }
    ]
  };
  const v = assessDeliveryHealth(soloASiMismo, "corpfilingcontrol.com", { encolados: 0 });
  assert.equal(v.status, "healthy");
  assert.equal(v.stats.totals.delivered, 6, "el total NO cambia de significado: el panel lo muestra con ese nombre");
  assert.equal(v.entregadosATerceros, 0, "y ninguna de las 6 salió del nodo");

  // Un subdominio del propio nodo tampoco es un tercero, y el estado que NO es `healthy` también lo trae.
  const conSubdominio = assessDeliveryHealth({
    totals: { delivered: 9, blocked: 0, deferred: 0 },
    intentos: { delivered: 9, blocked: 0, deferred: 0 },
    byProvider: [
      { provider: "bounces.x.com", delivered: 5, blocked: 0, deferred: 0, intentos: { delivered: 5, blocked: 0, deferred: 0 } },
      { provider: "gmail.com", delivered: 4, blocked: 0, deferred: 0, intentos: { delivered: 4, blocked: 0, deferred: 0 } }
    ]
  }, "x.com", { encolados: COLA_ATASCADA_MIN });
  assert.equal(conSubdominio.status, "stalled", "la cola manda, y el campo viaja igual");
  assert.equal(conSubdominio.entregadosATerceros, 4);
});

// ── UN CHEQUEO QUE SE CUELGA ES "NO SÉ", Y TIENE QUE DECIR DE QUÉ ──────────────────────────────

test("el presupuesto de lectura alcanza para los nodos grandes, y si no alcanza lo dice", async () => {
  // MEDIDO: la sección `## CULPA` pasó a leer `status=(bounced|deferred)` y el comando salió 3,4× más
  // caro. Alternando las dos versiones contra el MISMO nodo (annualfiling-infra.com), dos veces cada
  // una y con 300 s de techo para que ninguna se corte: 17,1 s y 20,1 s la vieja, 64,8 s y 69,0 s la
  // nueva. Con el default de 60 s, los tres nodos más pesados —annualfiling-infra.com,
  // corpannualinfra.com y corpledger-control.com, con 16.749, 14.936 y 16.655 mensajes trabados AHORA
  // y `cruzados: ["google"]`— salían `unreadable` a los 60,0 s clavados. El sensor se quedaba ciego
  // exactamente donde vive la evidencia.
  let pedido: number | undefined;
  await readNodeDeliveryHealth({
    sshRunner: { run: async (i) => { pedido = i.timeoutMs; return { stdout: "## NOACCESS\n## END\n", exitCode: 0 }; } },
    serverSlug: "s", serverIp: "1.2.3.4", propios: "todo"
  });
  assert.ok((pedido ?? 0) >= 180_000, `el presupuesto por defecto es ${pedido}ms y el peor caso medido son 69 s`);

  // Y el texto tiene que mandar a la perilla correcta: es la lección del probe que se colgaba
  // (2026-07-29, 10 de 10 nodos con un falso "puerto 25 bloqueado"). Un timeout no es un permiso.
  const colgado = await readNodeDeliveryHealth({
    sshRunner: { run: async () => { throw new Error("SSH command timed out."); } },
    serverSlug: "s", serverIp: "1.2.3.4", propios: "todo"
  });
  assert.equal(colgado.status, "unreadable");
  assert.match(colgado.detail, /no terminó en 180s/);
  assert.match(colgado.detail, /no es que esté limpio/);

  const sinPermiso = await readNodeDeliveryHealth({
    sshRunner: { run: async () => ({ stdout: "## NOACCESS\n## END\n", exitCode: 0 }) },
    serverSlug: "s", serverIp: "1.2.3.4", propios: "todo"
  });
  assert.match(sinPermiso.detail, /sin permiso/, "y no se confunde con el que sí es un permiso");
});

// ── EL VETO SE APAGABA CON UNA SOLA ENTREGA, Y ESA ENTREGA LA PONEMOS NOSOTROS ─────────────────

test("UNA entrega no puede apagar el veto: 1 de 10 pasando NO es un nodo sano", async (t) => {
  // EL AGUJERO, corrido un casillero desde el incidente del 2026-08-07. El veto de abajo del piso
  // exigía `p.delivered === 0`, así que alcanzaba UNA entrega para que el receptor volviera a caer
  // en el `healthy` del final. Y esa entrega es, por construcción, la del propio warmup: los seis
  // dominios que hoy calientan le entregan todos los días a las mismas dos semillas de Gmail.
  //
  // Entre eso y el piso —inalcanzable con nuestro volumen: ~2 correos/día por dominio son ~10
  // intentos en la ventana de 5 días, contra los 20 que pide `BLOCKED_MIN_ATTEMPTS`— la única forma
  // de que el sensor dijera que Gmail nos cerró la puerta era que NO entregara ni una. Con 1 de cada
  // 10 pasando, verde para siempre, y el nodo vendiendo cupo adentro del pool mientras se quema.
  //
  // Las líneas son CRUDAS del mail.log real (rechazos 550-5.7.1 de gmail-smtp-in bajados de
  // corpfilingcontrol.com y entregas `status=sent` de corpfiling-infra.com), y corre por el camino de
  // producción: el mismo `buildDeliveryStatsCommand`, con bash, contra un log de verdad.
  const { leido } = await correrSobre(t, "unaentrega", [
    ...crudas(CRUDA_GMAIL_SENT, 1, "SNT"),
    ...crudas(CRUDA_GMAIL_DOMINIO_CORTADO, 9, "RCH")
  ]);
  assert.deepEqual(leido.total.totals, { delivered: 1, blocked: 9, deferred: 0 }, "10 intentos, 90% de rechazo");

  const v = assessDeliveryHealth(leido.total, "prueba.com", { encolados: 0, culpa: leido.culpa, culpaDiferido: leido.culpaDiferido });
  assert.equal(v.status, "insufficient_sample", "90% de rechazo bajo el piso es 'no sé', jamás 'sano'");
  assert.deepEqual(v.sinMuestra, ["gmail.com"]);
  // Y el texto no puede mentir sobre el número que lo motivó: decía "0 entregados" fijo.
  assert.match(v.detail, /gmail\.com: 1 entregados y 9 rechazados/);

  // LA MITAD QUE NO SE PUEDE ROMPER: correo normal con algún rechazo suelto SIGUE siendo sano. Abajo
  // del piso la regla no puede ser más dura que arriba, donde 25% es `degraded` y entra al pool.
  const normal = await correrSobre(t, "unaentregasano", [
    ...crudas(CRUDA_GMAIL_SENT, 6, "SNT"),
    ...crudas(CRUDA_GMAIL_DOMINIO_CORTADO, 1, "RCH")
  ]);
  const sano = assessDeliveryHealth(normal.leido.total, "prueba.com", {
    encolados: 0, culpa: normal.leido.culpa, culpaDiferido: normal.leido.culpaDiferido
  });
  assert.equal(sano.status, "healthy", "6 entregas y 1 rechazo es correo normal, no una puerta cerrada");
  assert.deepEqual(sano.sinMuestra, []);
});

// ── LA BANDA DEL MEDIO ABAJO DEL PISO: 89% DE RECHAZO NO PUEDE SALIR `healthy` ─────────────────

test("abajo del piso la regla no puede ser MÁS FLOJA que arriba: 2/17 y 9/10 quedan marcados", async (t) => {
  // EL AGUJERO. El clasificador promete por escrito que "abajo del piso la regla no puede ser más
  // dura que arriba, donde 90% es `blocked_by_provider` y 25% es `degraded`" — y de los dos umbrales
  // sólo estaba implementado el 90%. Resultado: 3,6× MÁS FLOJA, al revés de lo que dice. Con nuestro
  // volumen (~2 correos/día ⇒ ~10 intentos en la ventana) el piso de 20 es inalcanzable, así que
  // ésta es la ÚNICA regla que se le aplica a nuestros propios dominios.
  //
  // Y se agranda con el aislamiento de NFC: hoy los receptores grandes cruzan el piso porque los
  // intentos son de NFC; el día que NFC deje de inyectar, TODA la flota cae abajo del piso.
  //
  // Corre por el camino de producción (bash + `buildDeliveryStatsCommand` sobre un mail.log de
  // verdad con líneas crudas), no sobre un objeto armado a mano: un fixture escrito desde mi
  // suposición del formato haría que el test y el código compartan el error.
  const casi = await correrSobre(t, "bandamedia89", [
    ...crudas(CRUDA_GMAIL_SENT, 2, "SNT"),
    ...crudas(CRUDA_GMAIL_DOMINIO_CORTADO, 17, "RCH")
  ]);
  assert.deepEqual(casi.leido.total.totals, { delivered: 2, blocked: 17, deferred: 0 }, "19 intentos, 89%");
  const v89 = assessDeliveryHealth(casi.leido.total, "prueba.com", {
    encolados: 0, culpa: casi.leido.culpa, culpaDiferido: casi.leido.culpaDiferido
  });
  assert.equal(v89.status, "degraded", "89% de rechazo no es 'sano' por quedarse a UN intento del piso");
  assert.deepEqual(v89.degradedProviders, ["gmail.com"]);

  const mitad = await correrSobre(t, "bandamedia53", [
    ...crudas(CRUDA_GMAIL_SENT, 9, "SNT"),
    ...crudas(CRUDA_GMAIL_DOMINIO_CORTADO, 10, "RCH")
  ]);
  assert.equal(
    assessDeliveryHealth(mitad.leido.total, "prueba.com", {
      encolados: 0, culpa: mitad.leido.culpa, culpaDiferido: mitad.leido.culpaDiferido
    }).status,
    "degraded",
    "10 rechazos sobre 19 intentos es rechazo parcial, y así se llama"
  );

  // LA MITAD QUE NO SE PUEDE ROMPER, Y ES LA QUE JUSTIFICA `DEGRADED_MIN_RECHAZOS`. Sin el mínimo
  // absoluto de rechazos, 3 entregas y 1 rechazo (4 intentos, 25% clavado) marcaría un dominio sano
  // — y un aviso que grita en falso enseña a ignorar todos los demás. Arriba del piso ese mismo 25%
  // exige 5 rechazos; acá abajo se exige lo mismo.
  const chico = await correrSobre(t, "bandamediachico", [
    ...crudas(CRUDA_GMAIL_SENT, 3, "SNT"),
    ...crudas(CRUDA_GMAIL_DOMINIO_CORTADO, 1, "RCH")
  ]);
  const vChico = assessDeliveryHealth(chico.leido.total, "prueba.com", {
    encolados: 0, culpa: chico.leido.culpa, culpaDiferido: chico.leido.culpaDiferido
  });
  assert.equal(vChico.status, "healthy", "25% sobre CUATRO intentos no alcanza para marcar nada");
  assert.deepEqual(vChico.degradedProviders, []);

  // Y LA PROMESA, ESCRITA COMO ASERCIÓN: el mismo 25% ARRIBA del piso ya era `degraded`, así que la
  // regla de abajo nunca puede acusar por menos evidencia que la de arriba.
  assert.equal(DEGRADED_MIN_RECHAZOS, Math.ceil(BLOCKED_MIN_ATTEMPTS * DEGRADED_MIN_RATIO));
  const arriba = await correrSobre(t, "bandamediaarriba", [
    ...crudas(CRUDA_GMAIL_SENT, 15, "SNT"),
    ...crudas(CRUDA_GMAIL_DOMINIO_CORTADO, 5, "RCH")
  ]);
  assert.equal(
    assessDeliveryHealth(arriba.leido.total, "prueba.com", {
      encolados: 0, culpa: arriba.leido.culpa, culpaDiferido: arriba.leido.culpaDiferido
    }).status,
    "degraded",
    "5/20 arriba del piso es degraded: es el piso de evidencia que copia la regla de abajo"
  );

  // Y NO SE CONVIERTE EN CANDADO NI ACHICA EL POOL: `degraded` no escribe `cerradoEn` (que no
  // caduca) y `elegirPool` lo deja entrar igual que a `healthy` (plan-diario.ts:579). Lo que cambia
  // es lo que el sistema AFIRMA, no cuánto correo manda.
  assert.deepEqual(v89.blockedProviders, [], "rechazo parcial no puede pegar un cerradoEn permanente");
  assert.deepEqual(v89.sinMuestra, [], "y tampoco se disfraza del veto de 'no sé'");
});

// ── EL DIFERIDO SE VOTA POR PESO DE LÍNEAS, NO POR PRESENCIA DE ETIQUETA ───────────────────────

test("UNA línea sin clasificar no puede acusar a Gmail por 296 líneas de casilla llena", async (t) => {
  // MEDIDO EN PRODUCCIÓN el 2026-08-08, no construido: en annualcorp-ops.com (80.190.76.69) el
  // diferido de gmail.com son 296 líneas `452-4.2.2 out of storage space` (siete casillas llenas de
  // terceros) y UNA línea `421-4.3.0 Temporary System Problem`. Con el desempate por MÁXIMO, esa
  // única línea (`no-se`, peso 1) le ganaba a las 296 (`buzon`, peso 0), la exención de buzón se
  // apagaba y el sensor publicaba "gmail.com no abre la puerta".
  //
  // Verificado corriendo el pipeline TEXTUAL de `## CULPA` por SSH contra ese nodo, con y sin el
  // techo de 200 filas: CON techo sale `insufficient_sample` y SIN techo sale `stalled` — o sea que
  // hoy la acusación falsa la tapa el corte del `head`, por suerte de ranking. Un receptor ruidoso
  // más y sale publicada.
  //
  // Acá va la MISMA proporción con 7 mensajes × 20 reintentos en vez de × 42, y no es cosmético: con
  // 294 filas distintas el `head -n 200` se come la fila del 421 y el defecto se esconde solo — que
  // es exactamente lo que pasa hoy en el nodo real. Por debajo del techo, el desempate por máximo
  // queda a la vista sin depender del corte.
  const { leido } = await correrSobre(t, "votopeso", [
    ...Array.from({ length: 7 }, (_, msg) =>
      crudas(CRUDA_GMAIL_DEFERRED_QUOTA, 20, "QTA", msg * 20).map((l) => l.replace(/: QTA\d+:/, `: QTA000000${msg}:`))
    ).flat(),
    ...crudas(CRUDA_GMAIL_DEFERRED_421, 1, "TMP")
  ]);
  assert.deepEqual(
    leido.total.byProvider.find((p) => p.provider === "gmail.com"),
    { provider: "gmail.com", delivered: 0, blocked: 0, deferred: 8, intentos: { delivered: 0, blocked: 0, deferred: 141 } },
    "8 mensajes trabados y 141 líneas: la puerta 4xx dispara salvo que la culpa sea del buzón"
  );
  assert.equal(leido.culpaDiferido["gmail.com"], "buzon", "140 líneas de casilla llena contra 1 transitorio");
  const v = assessDeliveryHealth(leido.total, "prueba.com", { encolados: 0, culpa: leido.culpa, culpaDiferido: leido.culpaDiferido });
  assert.doesNotMatch(v.detail, /gmail\.com no abre la puerta/, "siete casillas llenas de terceros no son una puerta cerrada");

  // Y AL REVÉS, que es la mitad que no se puede romper: cuando la mayoría de las líneas habla de la
  // puerta, una casilla llena no absuelve. Es el caso que ya cubre el test del `PESO_DIFERIDO`, acá
  // con la proporción invertida sobre las MISMAS líneas crudas.
  const alReves = await correrSobre(t, "votopeso2", [
    ...Array.from({ length: 7 }, (_, msg) =>
      crudas(CRUDA_GMAIL_DEFERRED_421, 20, "TMP", msg * 20).map((l) => l.replace(/: TMP\d+:/, `: TMP000000${msg}:`))
    ).flat(),
    ...crudas(CRUDA_GMAIL_DEFERRED_QUOTA, 1, "QTA")
  ]);
  assert.equal(alReves.leido.culpaDiferido["gmail.com"], "no-se", "una casilla llena no tapa 140 líneas de otra cosa");
  assert.match(
    assessDeliveryHealth(alReves.leido.total, "prueba.com", {
      encolados: 0, culpa: alReves.leido.culpa, culpaDiferido: alReves.leido.culpaDiferido
    }).detail,
    /gmail\.com no abre la puerta/
  );
});

test("un receptor ruidoso no puede borrar del mapa al receptor de al lado", async (t) => {
  // EL TECHO GLOBAL DE 200 FILAS DECIDÍA QUIÉN TIENE ETIQUETA. Medido con el pipeline de producción
  // contra nationalcorpops.com (193.181.212.248) el 2026-08-08: 680 filas distintas, 480 tiradas, y
  // SIETE receptores se quedan sin una sola fila — centurytel.net, centurylink.net,
  // allianceflgroup.com, platinumtitleins.com y tres más. Un receptor sin fila sale del parser
  // AUSENTE, y aguas abajo `?? "no-se"` lo convierte en evidencia de puerta cerrada que nadie midió.
  //
  // La causa es la cardinalidad de Gmail, no el volumen: cada `452-4.2.2` trae su id de sesión, el
  // `cut -c1-200` no se lo lleva (arranca en el carácter ~158) y cada mensaje deja SU fila. gmail.com
  // solo produce 217 filas en ese nodo — más que el techo entero de la sección.
  //
  // Acá el ruidoso es Gmail con la forma real (7 mensajes × 40 reintentos, un id por línea = 280
  // filas de una línea) y el callado es centurytel.net con la línea CRUDA de ese mismo nodo, que es
  // la que nombra NUESTRA IP en Cloudmark. Con el techo global pelado, las 280 filas de Gmail se
  // comen las 200 y centurytel.net desaparece del mapa.
  // Los pares (MX, ibgw) son los REALES del nodo: `mx.centurylink.net` resuelve a varias IPs y cada
  // nodo de cloudfilter se nombra distinto, así que las 36 líneas de centurytel.net de la ventana
  // caen en 28 filas de cuenta baja. Ésa es la forma que el `head` global se come.
  const CENTURYTEL_MX = [
    ["34.226.24.72", "mwd-ibgw-5002b"], ["54.88.152.217", "mwd-ibgw-5004b"], ["54.88.152.217", "mwd-ibgw-5001b"],
    ["35.167.34.51", "mwd-ibgw-6005b"], ["35.167.34.51", "mwd-ibgw-6004b"]
  ];
  const centurytel = CENTURYTEL_MX.map(([ip, ibgw], i) =>
    `2026-08-02T00:17:20.089836+00:00 smtp postfix/smtp[1174940]: CTL000000${i}: to=<dest${i}@centurytel.net>, ` +
    `relay=mx.centurylink.net[${ip}]:25, delay=164277, delays=164275/0.17/1.5/0, dsn=4.0.0, ` +
    `status=deferred (host mx.centurylink.net[${ip}] refused to talk to me: 554 ` +
    `${ibgw}.ext.cloudfilter.net cmsmtp 193.181.212.248 is listed on Cloudmark CSI-Global. ` +
    "Please visit https://csi.cloudmark.com/en/reset?ip=193.181.212.248 AUP#BL)"
  );

  const { leido } = await correrSobre(t, "ruidoso", [
    ...Array.from({ length: 7 }, (_, msg) =>
      crudas(CRUDA_GMAIL_DEFERRED_QUOTA, 40, "NOI", msg * 40).map((l) => l.replace(/: NOI\d+:/, `: NOI000000${msg}:`))
    ).flat(),
    ...centurytel
  ]);
  assert.equal(leido.culpaDiferido["centurytel.net"], "ip", "el que nombra nuestra IP no puede quedar sin etiqueta");
  assert.equal(leido.culpaDiferido["gmail.com"], "buzon", "y el ruidoso conserva la suya");
});
