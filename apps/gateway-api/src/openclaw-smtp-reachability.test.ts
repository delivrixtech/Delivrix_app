import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReachabilityCommand,
  checkSmtpReachability,
  interpretReachability,
  parseInbound,
  parseOutbound,
  type ReachabilitySshRunner
} from "./openclaw-smtp-reachability.ts";

const INBOUND_OK = "active\nLISTEN 0 100 0.0.0.0:25 0.0.0.0:* users:((\"master\",pid=1,fd=13))";
const INBOUND_DOWN = "inactive\nNO_LISTEN_25";

function combined(inbound: string, outbound: string): string {
  return `## INBOUND\n${inbound}\n## OUTBOUND\n${outbound}`;
}

const OUTBOUND_OK = [
  "-- gmail-smtp-in.l.google.com",
  "220 mx.google.com ESMTP s12-2025",
  "[rc=0]",
  "-- aspmx.l.google.com",
  "220 mx.google.com ESMTP",
  "[rc=0]"
].join("\n");

const OUTBOUND_BLOCKED = [
  "-- gmail-smtp-in.l.google.com",
  "[rc=124]",
  "-- aspmx.l.google.com",
  "[rc=124]"
].join("\n");

function fakeRunner(stdout: string, calls: string[] = []): ReachabilitySshRunner {
  return {
    async run({ command }) {
      calls.push(command);
      return { stdout, exitCode: 0 };
    }
  };
}

test("parseInbound distinguishes active+listening from inactive+not-listening", () => {
  const up = parseInbound(INBOUND_OK);
  assert.equal(up.postfixActive, true);
  assert.equal(up.listening, true);

  const down = parseInbound(INBOUND_DOWN);
  assert.equal(down.postfixActive, false); // "inactive" must NOT read as active
  assert.equal(down.listening, false);
});

test("parseOutbound returns reachable on a 220 banner", () => {
  const out = parseOutbound(OUTBOUND_OK, ["gmail-smtp-in.l.google.com", "aspmx.l.google.com"]);
  assert.equal(out.status, "reachable");
  assert.equal(out.reachableTarget, "gmail-smtp-in.l.google.com");
  assert.match(out.banner ?? "", /220/);
});

test("parseOutbound returns blocked when every probe times out", () => {
  const out = parseOutbound(OUTBOUND_BLOCKED, ["gmail-smtp-in.l.google.com", "aspmx.l.google.com"]);
  assert.equal(out.status, "blocked");
});

test("parseOutbound returns unknown (never false-blocked) on no usable signal", () => {
  const out = parseOutbound("-- gmail-smtp-in.l.google.com\n(weird noise)\n[rc=0]", ["gmail-smtp-in.l.google.com"]);
  assert.equal(out.status, "unknown");
});

test("interpretReachability: outbound is what decides canSend, inbound is reported separately", () => {
  // Listening inbound but outbound blocked → cannot send, and it is NOT a blanket "port 25" fault.
  const blocked = interpretReachability(
    { postfixActive: true, listening: true, detail: "" },
    { status: "blocked", targetsTried: [], detail: "" }
  );
  assert.equal(blocked.canSend, false);
  assert.match(blocked.summary, /BLOQUEADO/);
  assert.match(blocked.summary, /inbound puede estar OK/);

  // Outbound reachable → can send even if we never confirmed inbound.
  const ok = interpretReachability(
    { postfixActive: false, listening: false, detail: "" },
    { status: "reachable", targetsTried: [], reachableTarget: "mx", detail: "" }
  );
  assert.equal(ok.canSend, true);

  // Undetermined → null, explicitly "do not assume blocked".
  const unknown = interpretReachability(
    { postfixActive: true, listening: true, detail: "" },
    { status: "unknown", targetsTried: [], detail: "" }
  );
  assert.equal(unknown.canSend, null);
  assert.match(unknown.summary, /NO asumir bloqueo/);
});

test("checkSmtpReachability composes a full verdict over SSH", async () => {
  const runner = fakeRunner(combined(INBOUND_OK, OUTBOUND_BLOCKED));
  const r = await checkSmtpReachability({ sshRunner: runner, serverSlug: "smtp-1", serverIp: "1.1.1.1" });
  assert.equal(r.inbound.listening, true);
  assert.equal(r.outbound.status, "blocked");
  assert.equal(r.canSend, false);
});

test("checkSmtpReachability never throws and returns unknown when SSH fails", async () => {
  const runner: ReachabilitySshRunner = {
    async run() {
      throw new Error("ssh down");
    }
  };
  const r = await checkSmtpReachability({ sshRunner: runner, serverSlug: "smtp-1", serverIp: "1.1.1.1" });
  assert.equal(r.outbound.status, "unknown");
  assert.equal(r.canSend, null);
  assert.match(r.summary, /NO asumir bloqueo/);
});

test("checkSmtpReachability filters unsafe probe targets and falls back to safe defaults", async () => {
  const calls: string[] = [];
  const runner = fakeRunner(combined(INBOUND_OK, OUTBOUND_OK), calls);
  await checkSmtpReachability({
    sshRunner: runner,
    serverSlug: "smtp-1",
    serverIp: "1.1.1.1",
    probeTargets: ["evil.com; rm -rf /", "gmail-smtp-in.l.google.com"]
  });
  // The injection attempt is rejected by the hostname filter; the safe host remains.
  assert.doesNotMatch(calls[0], /rm -rf/);
  assert.match(calls[0], /gmail-smtp-in\.l\.google\.com/);
});

test("buildReachabilityCommand probes /dev/tcp on :25 for each target", () => {
  const cmd = buildReachabilityCommand(["gmail-smtp-in.l.google.com"]);
  assert.match(cmd, /## INBOUND/);
  assert.match(cmd, /## OUTBOUND/);
  assert.match(cmd, /\/dev\/tcp\/gmail-smtp-in\.l\.google\.com\/25/);
});

// --- regresion: la falsa alarma que este modulo existe para evitar, la producia el modulo ---

test("el probe lee UNA LINEA, no un largo fijo: head -c cuelga y se reporta como bloqueado", () => {
  // Medido en un nodo real el 2026-07-29: el banner de Gmail mide 75 bytes. Con `head -c 120`
  // el proceso espera 120, no llegan, y timeout lo mata con rc=124 -> parseOutbound lo lee como
  // "timed out" -> "blocked (likely provider egress filter)". Daba 10 de 10 nodos bloqueados
  // cuando los 10 conectaban bien. Un negativo falso que apuntaba al proveedor.
  const command = buildReachabilityCommand(["gmail-smtp-in.l.google.com"]);
  assert.match(command, /head -n 1 <&3/);
  assert.equal(/head -c \d+/.test(command), false, "head -c espera bytes que no llegan y cuelga");
});

test("un rc=124 sigue siendo bloqueado: el arreglo no ablanda la deteccion real", () => {
  // Importa que el fix no haya vuelto ciego al probe: si de verdad se cuelga, es bloqueado.
  const outbound = parseOutbound('-- gmail-smtp-in.l.google.com\n[rc=124]', ["gmail-smtp-in.l.google.com"]);
  assert.equal(outbound.status, "blocked");
});

test("un banner de 75 bytes se lee como reachable", () => {
  const real = "-- gmail-smtp-in.l.google.com\n220 mx.google.com ESMTP af79cd13be357-933e73e00fbsi308252885a.415 - gsmtp\n[rc=0]";
  const outbound = parseOutbound(real, ["gmail-smtp-in.l.google.com"]);
  assert.equal(outbound.status, "reachable");
  assert.equal(outbound.reachableTarget, "gmail-smtp-in.l.google.com");
});
