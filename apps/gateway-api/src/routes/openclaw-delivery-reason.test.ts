import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import {
  handleReadDeliveryReason,
  type ReadDeliveryReasonDeps
} from "./openclaw-delivery-reason.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";
import type { DeliveryLogRunner } from "../openclaw-delivery-reason.ts";

const readToken = "delivery-read-token";
const fixedNow = new Date("2026-06-28T18:00:00.000Z");

const CLEANUP_LINE =
  "Jun 28 10:16:00 smtp postfix/cleanup[10]: B2C3D4E5F6: message-id=<delivrix-deadbeef@bizreport.com>";
const STATUS_BOUNCE_LINE =
  "Jun 28 10:16:10 smtp postfix/smtp[11]: B2C3D4E5F6: to=<x@gmail.com>, " +
  "relay=mx.gmail.com[1.2.3.4]:25, status=bounced (host mx.gmail.com[1.2.3.4] said: 550 5.7.1 blocked)";

const validQuery =
  "?serverSlug=smtp-1&serverIp=1.1.1.1&messageId=%3Cdelivrix-deadbeef%40bizreport.com%3E";

function fakeRunner(byNeedle: Record<string, string>): DeliveryLogRunner {
  return {
    async run({ command }) {
      for (const [needle, stdout] of Object.entries(byNeedle)) {
        if (command.includes(needle)) return { stdout, exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    }
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
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}

async function route(
  query: string,
  overrides: Partial<ReadDeliveryReasonDeps> & { headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; body: any }> {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  const { headers, ...deps } = overrides;
  await handleReadDeliveryReason(
    request(`/v1/openclaw/delivery-reason${query}`, headers ?? { "x-delivrix-token": readToken }),
    response as unknown as ServerResponse,
    {
      sshRunner: fakeRunner({
        "delivrix-deadbeef@bizreport.com": CLEANUP_LINE,
        B2C3D4E5F6: [CLEANUP_LINE, STATUS_BOUNCE_LINE].join("\n")
      }),
      now: () => fixedNow,
      readBoundaryToken: readToken,
      ...deps
    }
  );
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test("returns the parsed bounce reason and audits the read", async () => {
  const auditEvents: Array<Record<string, unknown>> = [];
  const res = await route(validQuery, {
    emitAudit: async (event) => {
      auditEvents.push(event);
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.found, true);
  assert.equal(res.body.reason.finalStatus, "bounced");
  assert.equal(res.body.reason.smtpCode, "550");
  assert.equal(res.body.reason.dsnCode, "5.7.1");
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].type, "oc.smtp.delivery_reason_read");
  assert.equal(auditEvents[0].serverSlug, "smtp-1");
  assert.equal(auditEvents[0].dsnCode, "5.7.1");
});

test("rejects an invalid read-boundary token with 401", async () => {
  const res = await route(validQuery, { headers: { "x-delivrix-token": "wrong" } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "read_boundary_token_invalid");
});

test("returns 503 when the read-boundary token is unconfigured", async () => {
  const res = await route(validQuery, { readBoundaryToken: undefined });
  assert.equal(res.statusCode, 503);
});

test("rejects invalid params with 400 (bad IP)", async () => {
  const res = await route("?serverSlug=smtp-1&serverIp=not-an-ip&messageId=%3Cx%40y.com%3E");
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "invalid_params");
});
