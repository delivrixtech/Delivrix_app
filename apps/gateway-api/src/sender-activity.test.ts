// Tests del normalizador de actividad. Lo que protegen: que una línea real de Postfix se parsee
// a un evento fiel, que ## NOACCESS no se lea como "sin actividad", y que una línea rota se salte
// en vez de inventar un evento a medias.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActivityCommand,
  parseSenderActivity,
  resolveActivityLimit,
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT
} from "./sender-activity.ts";

// Líneas reales de mail.log de Postfix (formato verificado contra la flota).
const SENT = "Jul 30 14:23:01 srv postfix/smtp[1234]: 4Abc12: to=<user@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.1]:25, delay=1.2, dsn=2.0.0, status=sent (250 2.0.0 OK 1690 - gsmtp)";
const BOUNCED = "Jul 30 14:24:05 srv postfix/smtp[1235]: 5Def34: to=<x@yahoo.com>, relay=mta.yahoo.com[98.1.1.1]:25, delay=0.8, dsn=5.7.1, status=bounced (host mta.yahoo.com said: 550 5.7.1 unsolicited mail)";
const DEFERRED = "Jul 30 14:25:11 srv postfix/smtp[1236]: 6Ghi56: to=<y@comcast.net>, relay=comcast.net[76.1.1.1]:25, delay=30, dsn=4.2.2, status=deferred (host comcast.net said: 452 4.2.2 mailbox full)";

test("parsea una entrega exitosa con todos sus campos", () => {
  const { events, noAccess } = parseSenderActivity(`## EVENTS\n${SENT}\n## END`);
  assert.equal(noAccess, false);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    at: "Jul 30 14:23:01",
    queueId: "4Abc12",
    recipient: "user@gmail.com",
    provider: "gmail.com",
    status: "sent",
    code: "250",
    dsn: "2.0.0",
    relay: "gmail-smtp-in.l.google.com[142.250.1.1]:25"
  });
});

test("un rebote trae el código 550 y el dsn 5.7.1 del receptor", () => {
  const { events } = parseSenderActivity(`## EVENTS\n${BOUNCED}\n## END`);
  assert.equal(events[0]?.status, "bounced");
  assert.equal(events[0]?.code, "550");
  assert.equal(events[0]?.dsn, "5.7.1");
  assert.equal(events[0]?.provider, "yahoo.com");
});

test("un diferido trae 452 / 4.2.2", () => {
  const { events } = parseSenderActivity(`## EVENTS\n${DEFERRED}\n## END`);
  assert.equal(events[0]?.status, "deferred");
  assert.equal(events[0]?.code, "452");
  assert.equal(events[0]?.dsn, "4.2.2");
});

test("preserva el orden del log (append-only, cronológico)", () => {
  const { events } = parseSenderActivity(`## EVENTS\n${SENT}\n${BOUNCED}\n${DEFERRED}\n## END`);
  assert.deepEqual(events.map((e) => e.queueId), ["4Abc12", "5Def34", "6Ghi56"]);
});

test("## NOACCESS NO se lee como 'sin actividad': lo declara", () => {
  const { events, noAccess } = parseSenderActivity("## NOACCESS\n## EVENTS\n## END");
  assert.equal(noAccess, true);
  assert.equal(events.length, 0);
});

test("una línea rota se salta, no inventa un evento a medias", () => {
  const rota = "Jul 30 14:26:00 srv postfix/smtp[9]: 7Xyz: garbage sin to ni status";
  const { events } = parseSenderActivity(`## EVENTS\n${rota}\n${SENT}\n## END`);
  assert.equal(events.length, 1, "solo la línea válida");
  assert.equal(events[0]?.queueId, "4Abc12");
});

test("campos ausentes salen null, no vacío ni inventado", () => {
  const minima = "Jul 30 14:27:00 srv postfix/smtp[9]: 8Min: to=<z@aol.com>, status=sent";
  const { events } = parseSenderActivity(`## EVENTS\n${minima}\n## END`);
  assert.equal(events[0]?.code, null);
  assert.equal(events[0]?.dsn, null);
  assert.equal(events[0]?.relay, null);
  assert.equal(events[0]?.provider, "aol.com");
});

test("stdout vacío = sin actividad legible (no noAccess)", () => {
  const { events, noAccess } = parseSenderActivity("## EVENTS\n## END");
  assert.equal(events.length, 0);
  assert.equal(noAccess, false);
});

test("BUG1: '## NOACCESS' dentro de la respuesta del receptor NO tumba el feed (sentinela por línea)", () => {
  // El texto entre paréntesis es la respuesta del MTA remoto — puede contener cualquier cosa.
  const trampa = "Jul 30 14:23:01 srv postfix/smtp[1]: 4Abc12: to=<u@gmail.com>, dsn=5.7.1, status=bounced (host mx said: 550 5.7.1 rejected ref ## NOACCESS-99)";
  const { events, noAccess } = parseSenderActivity(`## EVENTS\n${trampa}\n## END`);
  assert.equal(noAccess, false, "el nodo NO está sin acceso: es texto del receptor");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.code, "550");
});

test("BUG2: '## END' dentro de la respuesta NO trunca el feed (no se pierden eventos)", () => {
  const l1 = "Jul 30 14:23:01 srv postfix/smtp[1]: 4Abc12: to=<u@gmail.com>, dsn=2.0.0, status=sent (250 2.0.0 OK ## END queued)";
  const l2 = "Jul 30 14:23:02 srv postfix/smtp[1]: 4Abc13: to=<v@yahoo.com>, dsn=2.0.0, status=sent (250 2.0.0 OK)";
  const { events } = parseSenderActivity(`## EVENTS\n${l1}\n${l2}\n## END`);
  assert.equal(events.length, 2, "el segundo evento NO se pierde por el '## END' en el texto del primero");
  assert.equal(events[1]?.provider, "yahoo.com");
});

test("BUG3: salida cortada sin '## END' se declara truncated, NO se sirve parcial", () => {
  const l1 = "Jul 30 14:23:01 srv postfix/smtp[1]: 4Abc12: to=<u@gmail.com>, status=sent (250 2.0.0 OK)";
  const { events, truncated } = parseSenderActivity(`## EVENTS\n${l1}\n`); // sin ## END: SSH cortó
  assert.equal(truncated, true);
  assert.equal(events.length, 0, "no se sirve lo parcial como completo");
});

test("código SMTP sin enhanced-DSN ('250 OK') se extrae por el fallback del paréntesis", () => {
  const plano = "Jul 30 14:23:01 srv postfix/smtp[1]: 4Abc12: to=<u@gmail.com>, status=sent (250 OK)";
  const { events } = parseSenderActivity(`## EVENTS\n${plano}\n## END`);
  assert.equal(events[0]?.code, "250");
});

test("una lectura completa normal no queda marcada truncated", () => {
  const { truncated } = parseSenderActivity(`## EVENTS\n${SENT}\n## END`);
  assert.equal(truncated, false);
});

test("resolveActivityLimit: default, clamp al máximo, rechaza basura", () => {
  assert.equal(resolveActivityLimit(undefined), ACTIVITY_DEFAULT_LIMIT);
  assert.equal(resolveActivityLimit("50"), 50);
  assert.equal(resolveActivityLimit(99999), ACTIVITY_MAX_LIMIT);
  assert.equal(resolveActivityLimit("que"), ACTIVITY_DEFAULT_LIMIT);
  assert.equal(resolveActivityLimit(-5), ACTIVITY_DEFAULT_LIMIT);
});

test("el comando lee el mail.log ACTUAL (no el rotado) y acota con tail", () => {
  const cmd = buildActivityCommand(50);
  assert.match(cmd, /\/var\/log\/mail\.log 2>/, "sin el asterisco: solo el log actual");
  assert.doesNotMatch(cmd, /mail\.log\* /, "el feed no lee los .gz rotados");
  assert.match(cmd, /tail -n 50/);
  assert.match(cmd, /## NOACCESS/, "declara cuando no puede leer");
});

test("el comando clampa el límite al máximo duro", () => {
  assert.match(buildActivityCommand(99999), new RegExp(`tail -n ${ACTIVITY_MAX_LIMIT}`));
});
