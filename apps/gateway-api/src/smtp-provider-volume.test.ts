// Tests de la medicion del umbral irreversible.
//
// El fixture de salida usa la forma REAL del mail.log de un nodo de la flota, tomada el
// 2026-07-30. Eso no es un detalle de estilo: hoy mismo un fixture escrito desde mi suposicion
// escondio que stop_reason nunca se leia, con 20 tests en verde. Si esta forma cambia, se rompe
// el unico anclaje de este modulo con la realidad.

import assert from "node:assert/strict";
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
  assert.match(command, /\[0-9A-Fa-f\]\{6,\}/);
  assert.match(command, /## END/, "el marcador de fin distingue 'no hay trafico' de 'no pude leer'");
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
