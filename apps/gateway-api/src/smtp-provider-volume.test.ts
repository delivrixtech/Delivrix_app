// Tests de la medicion del umbral irreversible.
//
// El fixture de salida usa la forma REAL del mail.log de un nodo de la flota, tomada el
// 2026-07-30. Eso no es un detalle de estilo: hoy mismo un fixture escrito desde mi suposicion
// escondio que stop_reason nunca se leia, con 20 tests en verde. Si esta forma cambia, se rompe
// el unico anclaje de este modulo con la realidad.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PROVIDER_DAILY_THRESHOLD,
  assessProviderVolume,
  buildProviderVolumeCommand,
  parseProviderVolume,
  providerFamilyFor,
  readNodeProviderVolume
} from "./smtp-provider-volume.ts";

// --- familias --------------------------------------------------------------

test("familias: un receptor se cuenta junto, aunque llegue por dominios distintos", () => {
  // Contar por dominio destino reparte a un mismo receptor en varias filas y ninguna cruza el
  // umbral que el receptor SI ve sumado.
  assert.equal(providerFamilyFor("gmail.com"), "google");
  assert.equal(providerFamilyFor("googlemail.com"), "google");
  assert.equal(providerFamilyFor("YAHOO.COM"), "yahoo_aol");
  assert.equal(providerFamilyFor("aol.com"), "yahoo_aol");
  assert.equal(providerFamilyFor("comcast.net"), "comcast");
  assert.equal(providerFamilyFor("xfinity.com"), "comcast");
  assert.equal(providerFamilyFor("tampabay.rr.com"), "otros", "un subdominio no es la familia");
  assert.equal(providerFamilyFor("rr.com"), "charter_rr");
  assert.equal(providerFamilyFor("empresa-cualquiera.com"), "otros");
});

test("Comcast NO tiene umbral declarado, y eso es a proposito", () => {
  // Es el segundo destino de la flota y el que ya rechaza con 554, pero no publica un numero.
  // Inventarle uno seria exactamente el problema que venimos arreglando.
  assert.equal(PROVIDER_DAILY_THRESHOLD.google, 5_000);
  assert.equal(PROVIDER_DAILY_THRESHOLD.microsoft, 5_000);
  assert.equal(PROVIDER_DAILY_THRESHOLD.comcast, null);
});

// --- el comando ------------------------------------------------------------

test("el comando deduplica ANTES de contar: mensajes, no intentos", () => {
  // Medido en un nodo real: 5.513 lineas to=<...@gmail> en un dia contra 1.293 mensajes unicos.
  // 4,3x de inflado. Sin el sort -u, la medicion diria "cruzaste el umbral" al 27%.
  const command = buildProviderVolumeCommand();
  assert.match(command, /sort -u/);
  assert.ok(
    command.indexOf("sort -u") < command.indexOf("uniq -c"),
    "el dedup tiene que ir antes del conteo, o cuenta reintentos"
  );
  // El queue-id se saca por patron: un $5 se rompe en silencio si cambia el prefijo de syslog.
  //
  // ANTES esta linea afirmaba `/\[0-9A-Fa-f\]\{6,\}/`, o sea que fijaba EL BUG como si fuera la
  // regla. Ese patron hexadecimal pierde los queue-id base-52 (`4bXyZ9Qm2Rz1kT`) que escriben los
  // nodos con `enable_long_queue_ids`. El modulo hermano ya lo habia descubierto y lo dejo por
  // escrito apuntando a ESTE archivo — ver `smtp-delivery-health.ts:194-196`, textual: "El queue-id
  // se saca con [^ :]+ y NO con el [0-9A-Fa-f]{6,} del modulo de volumen". Se arreglo alla y aca
  // quedo, con un test verde custodiandolo.
  assert.match(command, /\[\^ :\]\+/);
  assert.match(command, /## END/, "el marcador de fin distingue 'no hay trafico' de 'no pude leer'");
});

test("EL SENSOR DEL UMBRAL PERMANENTE TIENE QUE VER LOS 12 NODOS WEBDOCK", async (t) => {
  // El unico test que corre por el camino de produccion: se ejecuta con bash el MISMO string que se
  // manda por SSH, contra archivos de verdad. Es la leccion del fixture de Bedrock — un test escrito
  // sobre mi suposicion de como se ve la salida comparte el error con el codigo y no salva de nada.
  // Mismo harness y mismo motivo que `smtp-delivery-health.test.ts:199`.
  //
  // INCIDENTE QUE FIJA (2026-08-06, medido en sender-measurement.json de produccion, medidoEn
  // 19:24:16.459Z, 58/58 leidas): exactamente 12 bandejas con `picos: []`, y son exactamente las 12
  // con slug `serverNN`, o sea los 12 Webdock; las 46 `contabo-*` traen picos. O sea que el sensor
  // del unico dano irreversible del proyecto estaba CIEGO en el 21% de la flota. El caso que lo
  // prueba: `corpdocfiling-ledger.com` (server68) con 20.425 entregados en 5 dias, 6.516 encolados,
  // cap 15000 y `cruzados: []` — que el panel y el agente leian como "no cruzo". Y dos de las 12,
  // `annualfilings-control.com` y `corpfiling-infra.com`, estaban `healthy`: dentro del pool del
  // warmup, calentandose sin que nadie pudiera saber si ya estaban quemadas.
  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-volumen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "mail.log"), [
    // (1) Contabo: syslog + queue-id hexadecimal. Lo unico que el comando viejo sabia contar.
    "Aug  6 01:02:03 nodo postfix/smtp[1234]: 9F8E7D6C5B: to=<uno@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=1.9, status=sent (250 2.0.0 OK)",
    // (2) Webdock: ISO-8601. El formato de los 12 ciegos.
    "2026-08-06T01:02:03.123456+00:00 nodo postfix/smtp[999]: 1122334455: to=<dos@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=2.1, status=sent (250 2.0.0 OK)",
    // (3) EL DEDUP: mismo queue-id, mismo dia, mismo destino que (2), otro microsegundo. UN mensaje.
    "2026-08-06T04:44:44.987654+00:00 nodo postfix/smtp[999]: 1122334455: to=<dos@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=9.9, status=deferred (connect timeout)",
    // (4) queue-id base-52 (`enable_long_queue_ids`): el patron hexadecimal lo perdia.
    "Aug  6 01:05:00 nodo postfix/smtp[1234]: 4bXyZ9Qm2Rz1kT: to=<tres@yahoo.com>, relay=mta7.am0.yahoodns.net[67.195.204.79]:25, delay=3.3, status=sent (250 ok dirdel)",
    ""
  ].join("\n"), "utf8");

  const salida = execFileSync("bash", ["-c", buildProviderVolumeCommand(dir)], { encoding: "utf8" });
  const perDay = parseProviderVolume(salida);
  assert.ok(perDay, "salida sin ## END: el comando se rompio");

  const iso = perDay!.find((e) => e.day === "2026-08-06" && e.family === "google");
  assert.ok(iso, "las lineas ISO-8601 de los 12 Webdock tienen que contarse; el comando viejo daba CERO aca");

  // LA ASERCION QUE MAS IMPORTA. Si el timestamp entrara al grupo capturado, la clave del `sort -u`
  // llevaria microsegundos, cada linea seria unica, el dedup moriria y contariamos INTENTOS en vez
  // de MENSAJES: 4,3x de inflado medido en un nodo real. En `corpdocfiling-ledger.com`, con 20.425
  // entregas, eso reportaria "cruzo el umbral de 5.000" estando al 23% — el peor error posible,
  // porque el sensor mentiria hacia el lado que dispara acciones que no se deshacen.
  assert.equal(iso!.messages, 1, "dos lineas del MISMO queue-id son UN mensaje, no dos intentos");

  assert.equal(
    perDay!.find((e) => e.day === "2026-08-06")?.messages,
    1,
    "el dia ISO no puede traer el timestamp adentro: partiria un dia en miles de claves"
  );
  assert.equal(
    perDay!.find((e) => e.family === "yahoo_aol")?.messages,
    1,
    "queue-id base-52 (enable_long_queue_ids): el patron hexadecimal lo perdia"
  );
  assert.equal(perDay!.find((e) => e.day === "Aug 6" && e.family === "google")?.messages, 1);
});

// --- parseo ----------------------------------------------------------------

const SALIDA_REAL = `## VOLUME
   1293 Jul 30\tgmail.com
    137 Jul 30\thotmail.com
    121 Jul 30\tyahoo.com
    880 Jul 30\tcomcast.net
     12 Jul 30\tgooglemail.com
   1327 Jul 29\tgmail.com
    452 Jul 29\tyahoo.com
## END`;

test("parseo: suma las familias y corta por dia", () => {
  const perDay = parseProviderVolume(SALIDA_REAL);
  assert.ok(perDay);
  const j30 = perDay!.filter((entry) => entry.day === "Jul 30");
  // gmail.com + googlemail.com se suman: 1293 + 12
  assert.equal(j30.find((entry) => entry.family === "google")?.messages, 1_305);
  assert.equal(j30.find((entry) => entry.family === "comcast")?.messages, 880);
  assert.equal(perDay!.find((e) => e.day === "Jul 29" && e.family === "google")?.messages, 1_327);
});

test("parseo: salida incompleta devuelve null, NUNCA cero", () => {
  // Un cero se lee como "no manda nada". Es la diferencia entre no saber y estar tranquilo.
  assert.equal(parseProviderVolume("## VOLUME\n  10 Jul 30\tgmail.com"), null);
  assert.equal(parseProviderVolume(""), null);
  // Sin trafico pero con marcador de fin: eso SI es cero legitimo.
  assert.deepEqual(parseProviderVolume("## VOLUME\n## END"), []);
});

// --- evaluacion contra el umbral -------------------------------------------

test("evaluacion: el pico diario es lo que se compara, no el acumulado", () => {
  // El umbral es una ventana de 24h. Un total acumulado no dice nada de el.
  const report = assessProviderVolume([
    { day: "Jul 28", family: "google", messages: 1_366 },
    { day: "Jul 29", family: "google", messages: 1_327 },
    { day: "Jul 30", family: "google", messages: 1_293 }
  ]);

  const google = report.peakByFamily.find((p) => p.family === "google");
  assert.equal(google?.messages, 1_366, "gana el pico, no el ultimo ni la suma");
  assert.equal(google?.day, "Jul 28");
  assert.equal(google?.ratio, 0.273);
  assert.deepEqual(report.overThreshold, []);
  assert.deepEqual(report.nearThreshold, [], "27% todavia no alerta");
});

test("evaluacion: avisa al 40% del umbral, con margen, porque cruzarlo no se deshace", () => {
  const report = assessProviderVolume([{ day: "Jul 30", family: "google", messages: 2_100 }]);
  assert.deepEqual(report.nearThreshold, ["google"]);
  assert.deepEqual(report.overThreshold, []);
});

test("evaluacion: cruzar el umbral se reporta aparte — es permanente en Google", () => {
  const report = assessProviderVolume([
    { day: "Jul 30", family: "google", messages: 5_200 },
    { day: "Jul 30", family: "comcast", messages: 9_000 }
  ]);
  assert.deepEqual(report.overThreshold, ["google"]);
  // Comcast manda mas pero no publica umbral: no se le inventa uno.
  assert.equal(report.peakByFamily.find((p) => p.family === "comcast")?.ratio, null);
});

// --- lectura del nodo ------------------------------------------------------

test("no poder leer el nodo NO es volumen cero", () => {
  return readNodeProviderVolume({
    sshRunner: { run: async () => { throw new Error("ssh caido"); } },
    serverSlug: "n1",
    serverIp: "1.2.3.4"
  }).then((result) => {
    assert.equal(result.status, "unreadable");
    assert.match((result as { detail: string }).detail, /ssh caido/);
  });
});

test("lectura completa de un nodo devuelve el pico por familia", async () => {
  const result = await readNodeProviderVolume({
    sshRunner: { run: async () => ({ stdout: SALIDA_REAL, exitCode: 0 }) },
    serverSlug: "contabo-203393596",
    serverIp: "217.216.51.187"
  });

  assert.equal(result.status, "ok");
  const ok = result as { status: "ok"; peakByFamily: Array<{ family: string; messages: number }> };
  assert.equal(ok.peakByFamily[0]?.family, "google");
  assert.equal(ok.peakByFamily[0]?.messages, 1_327);
});

test("sin permiso de lectura NO es volumen cero", () => {
  // /var/log/mail.log es syslog:adm. El comando salia con exit 0 y cero lineas, que el parser
  // leia como "no hay trafico" — en un nodo que manda 1.300 mensajes/dia a Gmail. Cuarto sensor
  // esta semana con la misma falla: no fallaba, miraba donde no habia nada.
  assert.equal(parseProviderVolume("## NOACCESS\n## VOLUME\n## END"), null);
});

test("el comando resuelve el lector con sudo y declara si no puede", () => {
  const command = buildProviderVolumeCommand();
  assert.match(command, /sudo -n test -r \/var\/log\/mail\.log/);
  assert.match(command, /## NOACCESS/, "no poder leer se dice, no se deja vacio");
});

// ── LA REGLA CONTRARIA: ESTE SENSOR NO SE ATRIBUYE ──────────────────────────────────────────────

test("el volumen cuenta TODO el trafico del nodo, tambien el del otro inquilino", async (t) => {
  // INCIDENTE QUE PREVIENE (2026-08-06): el modulo hermano aprendio a separar NUESTRO correo del de
  // NFC porque estaba midiendo reputacion ajena y llamandola nuestra (791.300 mensajes de ellos
  // contra 222 nuestros). La orden fue "aislar y olvidar esos datos". ACA NO.
  //
  // El receptor no clasifica por quien inyecto: Google cuenta por DOMINIO y por IP. Los ~15.000
  // mensajes/dia que NFC saca por NUESTROS dominios cuentan ENTEROS contra el umbral de 5.000/dia, y
  // cruzarlo clasifica el dominio como bulk sender de forma PERMANENTE, sin apelacion. Filtrar aca
  // dejaria todos los picos en cero y todos los dominios "limpios" justo en el unico dano que no se
  // deshace: `bizreport-control.com` ya cruzo ese umbral y no hay vuelta atras.
  //
  // Dos aserciones, porque una sola no alcanza: la del STRING impide que alguien agregue el filtro
  // por descuido; la del FIXTURE prueba que 5.100 mensajes ajenos en un dia siguen disparando la
  // alarma.
  const command = buildProviderVolumeCommand();
  assert.equal(/queued as|sasl_username|OWN_/.test(command), false, "ni un filtro de atribucion en este comando");

  const dir = await mkdtemp(path.join(tmpdir(), "delivrix-umbral-nfc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 5.100 mensajes en UN dia hacia Gmail, todos inyectados por el otro producto desde EC2.
  await writeFile(path.join(dir, "mail.log"), Array.from({ length: 5_100 }, (_, i) =>
    `Aug  6 09:00:00 nodo postfix/smtp[1713359]: NFC${String(i).padStart(7, "0")}: to=<cliente${i}@gmail.com>, relay=gmail-smtp-in.l.google.com[142.251.179.27]:25, status=sent (250 2.0.0 OK)`
  ).join("\n") + "\n", "utf8");

  const salida = execFileSync("bash", ["-c", buildProviderVolumeCommand(dir)], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const report = assessProviderVolume(parseProviderVolume(salida)!);
  assert.deepEqual(report.overThreshold, ["google"], "el umbral se cruzo, lo haya inyectado quien lo haya inyectado");
  assert.equal(report.peakByFamily[0]?.messages, 5_100);
});
