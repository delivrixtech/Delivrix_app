import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  GatewayLogStreamService,
  gatewayLogEventFromLine,
  inferGatewayLogLevel,
  isGatewayLogStreamRequestAuthorized,
  redactGatewayLogSecrets,
  shouldEmitGatewayLogLevel
} from "./gateway-log-stream.ts";

test("gateway log stream redacts tokens, bearer credentials, and AWS access keys", () => {
  const line = "Authorization: Bearer abc.def token=secret-value sessionToken=session-secret signature=sig-secret hmac=hmac-secret AWS=AKIA1234567890ABCDEF";
  const redacted = redactGatewayLogSecrets(line);

  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /token=\[REDACTED\]/);
  assert.match(redacted, /sessionToken=\[REDACTED\]/);
  assert.match(redacted, /signature=\[REDACTED\]/);
  assert.match(redacted, /hmac=\[REDACTED\]/);
  assert.match(redacted, /\[REDACTED_AWS_ACCESS_KEY\]/);
  assert.doesNotMatch(redacted, /abc\.def/);
  assert.doesNotMatch(redacted, /secret-value/);
  assert.doesNotMatch(redacted, /session-secret/);
  assert.doesNotMatch(redacted, /sig-secret/);
  assert.doesNotMatch(redacted, /hmac-secret/);
});

test("gateway log stream redacts complete, partial, and body-only PEM private keys", () => {
  const pem = generatedPrivateKeyPem();
  const keyLine = pemBodyLine(pem);
  const partialPem = pem.slice(0, 500);
  const redacted = redactGatewayLogSecrets(`${pem}\n${partialPem}`);
  const bodyOnlyEvent = gatewayLogEventFromLine(keyLine, new Date("2026-05-29T12:01:00.000Z"));

  assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(redacted, /\[REDACTED_PARTIAL_KEY\]/);
  assert.doesNotMatch(redacted, /-----BEGIN PRIVATE KEY-----/);
  assert.doesNotMatch(redacted, /-----END PRIVATE KEY-----/);
  assert.equal(redacted.includes(keyLine), false);
  assert.equal(bodyOnlyEvent?.message, "[REDACTED_PEM_BODY]");
});

test("gateway log stream infers and filters levels monotonically", () => {
  assert.equal(inferGatewayLogLevel("gateway-api listening on http://127.0.0.1:3000"), "info");
  assert.equal(inferGatewayLogLevel("[gateway] WARN: dependency degraded"), "warn");
  assert.equal(inferGatewayLogLevel("OpenClaw bridge failed with error"), "error");
  assert.equal(inferGatewayLogLevel("2026-06-01T14:00:00.000Z [info] event=oc.step_failed handled"), "info");
  assert.equal(inferGatewayLogLevel("2026-06-01T14:00:00.000Z [error] event=oc.step_failed handled"), "error");

  assert.equal(shouldEmitGatewayLogLevel("warn", "info"), true);
  assert.equal(shouldEmitGatewayLogLevel("info", "warn"), false);
  assert.equal(shouldEmitGatewayLogLevel("error", "warn"), true);
});

test("gateway log event keeps timestamp and caps message", () => {
  const event = gatewayLogEventFromLine("2026-05-29T12:00:00.000Z password=supersecret " + "x".repeat(9_000), new Date("2026-05-29T12:01:00.000Z"));

  assert.ok(event);
  assert.equal(event.ts, "2026-05-29T12:00:00.000Z");
  assert.equal(event.message.includes("supersecret"), false);
  assert.equal(event.message.length, 8_000);
});

test("gateway log stream auth fails closed without configured token", () => {
  assert.equal(isGatewayLogStreamRequestAuthorized(request({}), {}), false);
  assert.equal(isGatewayLogStreamRequestAuthorized(request({ authorization: "Bearer log-token" }), { authToken: "log-token" }), true);
  assert.equal(isGatewayLogStreamRequestAuthorized(request({ "x-delivrix-token": "log-token" }), { authToken: "log-token" }), true);
  assert.equal(isGatewayLogStreamRequestAuthorized(request({ "x-delivrix-openclaw-token": "bad" }), { authToken: "log-token" }), false);
});

test("gateway log stream heartbeats with ping and responds to client ping", (t) => {
  // EL RELOJ VA FALSO, Y ESA ES LA CORRECCIÓN. Éste era el rojo intermitente que el equipo del
  // sensor reportó (1 de 9 corridas del gate) y del que nadie se había quedado con el nombre.
  //
  // Antes esperaba 20 ms de RELOJ DE PARED y daba por hecho que el intervalo de 5 ms ya había
  // disparado. El detalle que lo volvía una carrera está en `sendPing()`: primero REAPEA y después
  // pinguea — si pasaron más de `heartbeatIntervalMs * 4` sin pong, cierra el cliente y no manda
  // nada. Con heartbeat de 5 ms ese plazo son 20 ms: EXACTAMENTE la espera del test. Margen cero
  // por construcción, la espera y el plazo del reaper eran el mismo número.
  //
  // Con el gate corriendo 300+ archivos de test en paralelo sobre 14 núcleos, el proceso se queda
  // sin CPU y el primer tick del intervalo cae DESPUÉS de esos 20 ms. Entonces el primer `sendPing`
  // se va por la rama del reaper, cierra, y `frames(0x09)` queda vacío. Medido el 2026-08-08:
  // 2/120 en Node 22, 3/120 en Node 24, 2 de 30 corridas del gate entero y 2/150 en repetición
  // dirigida. No es el producto: con el intervalo real (30 s) el plazo son 120 s y el cliente
  // alcanza a pongear tres veces antes; es este test, que eligió una espera igual al plazo.
  //
  // `mock.timers` viene en node:test —cero dependencias nuevas— y el tick lo damos nosotros: no hay
  // reloj de pared del que depender, así que la carrera DESAPARECE en lugar de volverse menos
  // probable. Se habilita ANTES de construir el service porque el intervalo nace en el constructor.
  t.mock.timers.enable({ apis: ["setInterval"] });

  const service = new GatewayLogStreamService({
    logPath: join(tmpdir(), "missing-gateway-log-stream-test.log"),
    authToken: "log-token",
    heartbeatIntervalMs: 5,
    pollIntervalMs: 10
  });
  const socket = connectFakeLogSocket(service, "/v1/gateway/logs/stream?level=info&token=log-token");

  // Un solo tick del heartbeat. El reaper mira `Date.now()`, que sigue siendo el real y no se movió,
  // así que ya no puede ganarle al ping: lo que se afirma es que el intervalo PINGUEA, nada más.
  t.mock.timers.tick(5);
  assert.ok(socket.frames(0x09).length >= 1, "el heartbeat tiene que mandar ping en su intervalo");

  socket.emit("data", Buffer.from([0x89, 0x00]));
  assert.ok(socket.frames(0x0a).length >= 1, "un ping del cliente se contesta con pong");
  service.close();
});

function request(headers: Record<string, string>, url = "/v1/gateway/logs/stream"): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url,
    headers
  }) as IncomingMessage;
}

function connectFakeLogSocket(service: GatewayLogStreamService, path: string): FakeSocket {
  const request = {
    method: "GET",
    url: path,
    headers: {
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ=="
    }
  } as unknown as IncomingMessage;
  const socket = new FakeSocket();
  service.acceptPanelSocket(request, socket as unknown as Socket);
  return socket;
}

class FakeSocket extends EventEmitter {
  private readonly writes: Array<string | Buffer> = [];

  write(chunk: string | Buffer): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) {
      this.writes.push(chunk);
    }
    this.emit("close");
  }

  destroy(): void {
    this.emit("close");
  }

  unshift(chunk: Buffer): void {
    this.writes.push(chunk);
  }

  frames(opcode: number): Buffer[] {
    return this.writes
      .filter((chunk): chunk is Buffer => Buffer.isBuffer(chunk) && (chunk[0] & 0x0f) === opcode);
  }
}

function generatedPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey;
}

function pemBodyLine(pem: string): string {
  const line = pem.split(/\r?\n/).find((candidate) => /^[A-Za-z0-9+/]{48,}={0,2}$/.test(candidate));
  assert.ok(line);
  return line;
}
