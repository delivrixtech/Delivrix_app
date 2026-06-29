import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import {
  handleReadDkimStatus,
  type ReadDkimStatusDeps
} from "./openclaw-dkim-status.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const readToken = "dkim-read-token";
const fixedNow = new Date("2026-06-28T18:00:00.000Z");
const VALID_DKIM = "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBexamplekey";

function fakeResolver(map: Record<string, string>): (fqdn: string) => Promise<string[][]> {
  return async (fqdn: string) => {
    if (fqdn in map) return [[map[fqdn]]];
    throw new Error(`ENOTFOUND ${fqdn}`);
  };
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
  overrides: Partial<ReadDkimStatusDeps> & { headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; body: any }> {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  const { headers, ...deps } = overrides;
  await handleReadDkimStatus(
    request(`/v1/openclaw/dkim-status${query}`, headers ?? { "x-delivrix-token": readToken }),
    response as unknown as ServerResponse,
    {
      resolveTxt: fakeResolver({ "s2026a._domainkey.bizreport.com": VALID_DKIM }),
      now: () => fixedNow,
      readBoundaryToken: readToken,
      ...deps
    }
  );
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test("finds DKIM under s2026a (not just 'default') and audits the read", async () => {
  const auditEvents: Array<Record<string, unknown>> = [];
  const res = await route("?domain=bizreport.com", { emitAudit: async (e) => { auditEvents.push(e); } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "valid");
  assert.deepEqual(res.body.validSelectors, ["s2026a"]);
  assert.equal(auditEvents[0].type, "oc.dns.dkim_status_read");
  assert.equal(auditEvents[0].domain, "bizreport.com");
});

test("rejects an invalid token with 401", async () => {
  const res = await route("?domain=bizreport.com", { headers: { "x-delivrix-token": "nope" } });
  assert.equal(res.statusCode, 401);
});

test("rejects invalid params with 400 (bad domain)", async () => {
  const res = await route("?domain=not a domain");
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "invalid_params");
});
