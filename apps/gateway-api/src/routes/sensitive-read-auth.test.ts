import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  authorizeSensitiveRead,
  resetSensitiveReadAuthBucketsForTests
} from "./sensitive-read-auth.ts";

test("authorizeSensitiveRead rate-limits an authenticated sensitive read", () => {
  resetSensitiveReadAuthBucketsForTests();
  const request = makeRequest({ "x-delivrix-token": "read-token" });
  const deps = {
    readBoundaryToken: "read-token",
    rateLimitPerMinute: 1,
    now: () => new Date("2026-06-02T12:00:00.000Z")
  };

  assert.deepEqual(authorizeSensitiveRead(request, deps, "route53_domain_detail"), { ok: true });
  assert.deepEqual(authorizeSensitiveRead(request, deps, "route53_domain_detail"), {
    ok: false,
    statusCode: 429,
    error: "read_boundary_rate_limited"
  });
});

function makeRequest(headers: Record<string, string>): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url: "/",
    headers,
    socket: { remoteAddress: "127.0.0.1" }
  }) as IncomingMessage;
}
