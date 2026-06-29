import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import {
  handleReadRunStateIntegrity,
  type ReadRunStateIntegrityDeps
} from "./openclaw-run-state-integrity.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const readToken = "runstate-read-token";
const fixedNow = new Date("2026-06-28T18:00:00.000Z");

function request(url: string, headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method: "GET", url, headers }) as IncomingMessage;
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

async function route(
  overrides: Partial<ReadRunStateIntegrityDeps> & { headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; body: any }> {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  const { headers, ...deps } = overrides;
  await handleReadRunStateIntegrity(
    request("/v1/openclaw/run-state-integrity", headers ?? { "x-delivrix-token": readToken }),
    response as unknown as ServerResponse,
    {
      listRuns: async () => [{ runId: "r1", status: "completed", chosenDomain: "bizreport.com" }],
      listSends: async () => [{ domain: "bizreport.com" }, { domain: "annualcorpfilings.com" }],
      now: () => fixedNow,
      readBoundaryToken: readToken,
      ...deps
    }
  );
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test("reports domains sending without a run and audits the read", async () => {
  const auditEvents: Array<Record<string, unknown>> = [];
  const res = await route({ emitAudit: async (event) => { auditEvents.push(event); } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.deepEqual(res.body.domainsWithoutRun, ["annualcorpfilings.com"]);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].type, "oc.provisioning.run_state_integrity_read");
});

test("rejects an invalid token with 401", async () => {
  const res = await route({ headers: { "x-delivrix-token": "nope" } });
  assert.equal(res.statusCode, 401);
});

test("returns ok when every sending domain has a run", async () => {
  const res = await route({ listSends: async () => [{ domain: "bizreport.com" }] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});
