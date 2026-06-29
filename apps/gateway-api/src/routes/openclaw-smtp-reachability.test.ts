import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import {
  handleReadSmtpReachability,
  type ReadSmtpReachabilityDeps
} from "./openclaw-smtp-reachability.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";
import type { ReachabilitySshRunner } from "../openclaw-smtp-reachability.ts";

const readToken = "reach-read-token";
const fixedNow = new Date("2026-06-28T18:00:00.000Z");

const STDOUT_OUTBOUND_OK = [
  "## INBOUND",
  "active",
  "LISTEN 0 100 0.0.0.0:25 0.0.0.0:*",
  "## OUTBOUND",
  "-- gmail-smtp-in.l.google.com",
  "220 mx.google.com ESMTP ready",
  "[rc=0]"
].join("\n");

function fakeRunner(stdout: string): ReachabilitySshRunner {
  return { async run() { return { stdout, exitCode: 0 }; } };
}

function request(url: string, headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method: "GET", url, headers }) as IncomingMessage;
}

function captureResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void { this.statusCode = statusCode; },
    end(payload: string): void { this.body = payload; }
  };
}

async function route(
  query: string,
  overrides: Partial<ReadSmtpReachabilityDeps> & { headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; body: any }> {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  const { headers, ...deps } = overrides;
  await handleReadSmtpReachability(
    request(`/v1/openclaw/smtp-reachability${query}`, headers ?? { "x-delivrix-token": readToken }),
    response as unknown as ServerResponse,
    { sshRunner: fakeRunner(STDOUT_OUTBOUND_OK), now: () => fixedNow, readBoundaryToken: readToken, ...deps }
  );
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

const validQuery = "?serverSlug=smtp-1&serverIp=1.1.1.1";

test("returns a structured inbound/outbound verdict and audits the read", async () => {
  const auditEvents: Array<Record<string, unknown>> = [];
  const res = await route(validQuery, { emitAudit: async (e) => { auditEvents.push(e); } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outbound.status, "reachable");
  assert.equal(res.body.canSend, true);
  assert.equal(res.body.inbound.listening, true);
  assert.equal(auditEvents[0].type, "oc.smtp.reachability_read");
});

test("rejects an invalid token with 401", async () => {
  const res = await route(validQuery, { headers: { "x-delivrix-token": "nope" } });
  assert.equal(res.statusCode, 401);
});

test("rejects invalid params with 400 (bad IP)", async () => {
  const res = await route("?serverSlug=smtp-1&serverIp=not-an-ip");
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "invalid_params");
});
