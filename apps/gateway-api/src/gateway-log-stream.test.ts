import assert from "node:assert/strict";
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

test("gateway log stream heartbeats with ping and responds to client ping", async () => {
  const service = new GatewayLogStreamService({
    logPath: join(tmpdir(), "missing-gateway-log-stream-test.log"),
    authToken: "log-token",
    heartbeatIntervalMs: 5,
    pollIntervalMs: 10
  });
  const socket = connectFakeLogSocket(service, "/v1/gateway/logs/stream?level=info&token=log-token");

  await wait(20);
  assert.ok(socket.frames(0x09).length >= 1);

  socket.emit("data", Buffer.from([0x89, 0x00]));
  assert.ok(socket.frames(0x0a).length >= 1);
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
