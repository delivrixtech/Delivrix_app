// Tests de la ruta del feed en vivo. Lo que protegen: auth, validación de slug/ip, y que un SSH
// caído o un nodo sin acceso al log se DECLAREN — nunca una lista vacía que parezca "sin actividad".

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { handleSenderActivityHttp } from "./sender-activity-read.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const TOKEN = "token-del-panel";
const ahora = new Date("2026-07-31T12:00:00.000Z");

const SENT = "Jul 30 14:23:01 srv postfix/smtp[1]: 4Abc12: to=<u@gmail.com>, relay=x[1.1.1.1]:25, dsn=2.0.0, status=sent (250 2.0.0 OK)";

function request(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method: "GET", url, headers }) as unknown as IncomingMessage;
}

function captureResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}

function runner(behavior: (command: string) => string | Error) {
  return {
    async run(input: { command: string }) {
      const out = behavior(input.command);
      if (out instanceof Error) throw out;
      return { stdout: out, exitCode: 0 };
    }
  };
}

async function call(url: string, runnerImpl: ReturnType<typeof runner>, headers: Record<string, string> = { "x-delivrix-token": TOKEN }) {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderActivityHttp({
    request: request(url, headers),
    response: response as unknown as ServerResponse,
    sshRunner: runnerImpl,
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test("sin token, 401", async () => {
  const { statusCode } = await call(
    "/v1/sender-pool/activity?serverSlug=server51&serverIp=1.2.3.4",
    runner(() => `## EVENTS\n${SENT}\n## END`),
    {}
  );
  assert.equal(statusCode, 401);
});

test("slug o ip inválidos, 400 (sin tocar SSH)", async () => {
  let tocado = false;
  const r = runner(() => { tocado = true; return "## EVENTS\n## END"; });
  const bad = await call("/v1/sender-pool/activity?serverSlug=bad!&serverIp=1.2.3.4", r);
  assert.equal(bad.statusCode, 400);
  const badIp = await call("/v1/sender-pool/activity?serverSlug=server51&serverIp=nope", r);
  assert.equal(badIp.statusCode, 400);
  assert.equal(tocado, false, "no se abre SSH con inputs inválidos");
});

test("una corrida OK devuelve los eventos normalizados en orden", async () => {
  const { statusCode, body } = await call(
    "/v1/sender-pool/activity?serverSlug=server51&serverIp=1.2.3.4",
    runner(() => `## EVENTS\n${SENT}\n## END`)
  );
  assert.equal(statusCode, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.count, 1);
  assert.equal(body.events[0].provider, "gmail.com");
  assert.equal(body.events[0].status, "sent");
});

test("SSH caído se DECLARA unreadable, no lista vacía silenciosa", async () => {
  const { statusCode, body } = await call(
    "/v1/sender-pool/activity?serverSlug=server51&serverIp=1.2.3.4",
    runner(() => new Error("ssh timeout"))
  );
  assert.equal(statusCode, 200);
  assert.equal(body.status, "unreadable");
  assert.match(body.detail, /ssh timeout/);
  assert.equal(body.events.length, 0);
});

test("nodo sin acceso al log se DECLARA no_access, no 'sin actividad'", async () => {
  const { body } = await call(
    "/v1/sender-pool/activity?serverSlug=server51&serverIp=1.2.3.4",
    runner(() => "## NOACCESS\n## EVENTS\n## END")
  );
  assert.equal(body.status, "no_access");
  assert.match(body.detail, /sudo/);
  assert.equal(body.events.length, 0);
});

test("el limit se propaga al comando y se clampa", async () => {
  let cmd = "";
  await call(
    "/v1/sender-pool/activity?serverSlug=server51&serverIp=1.2.3.4&limit=99999",
    runner((c) => { cmd = c; return "## EVENTS\n## END"; })
  );
  assert.match(cmd, /tail -n 500/, "clampado al máximo duro");
});
