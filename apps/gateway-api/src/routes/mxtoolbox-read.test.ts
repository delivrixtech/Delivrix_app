import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import {
  handleReadMxtoolbox,
  handleReadMxtoolboxDailyReport,
  type MxtoolboxAuditEvent
} from "./mxtoolbox-read.ts";
import type {
  MxtoolboxAdapter,
  MxtoolboxHealthSummary,
  MxtoolboxLookupResult
} from "../../../../packages/adapters/src/index.ts";
import type { SenderNode } from "../../../../packages/domain/src/index.ts";

test("health endpoint requires read boundary token", async () => {
  const route = createRoute({
    url: "/v1/mxtoolbox/health?target=8.8.8.8&type=blacklist",
    token: "wrong"
  });

  await handleReadMxtoolbox(route.request, route.response, {
    adapter: mockAdapter(),
    readBoundaryToken: "secret"
  });

  assert.equal(route.response.statusCode, 401);
  assert.deepEqual(route.body(), { error: "read_boundary_token_invalid" });
});

test("health endpoint returns live result and appends low-risk audit", async () => {
  const audits: MxtoolboxAuditEvent[] = [];
  const route = createRoute({
    url: "/v1/mxtoolbox/health?target=8.8.8.8&type=blacklist",
    token: "secret"
  });

  await handleReadMxtoolbox(route.request, route.response, {
    adapter: mockAdapter({ status: "clean" }),
    readBoundaryToken: "secret",
    emitAudit: async (event) => {
      audits.push(event);
    }
  });

  assert.equal(route.response.statusCode, 200);
  assert.equal(route.body().source, "live");
  assert.equal(route.body().result.status, "clean");
  assert.equal(audits[0]?.action, "oc.mxtoolbox.lookup");
  assert.equal(audits[0]?.targetType, "ip");
  assert.equal(audits[0]?.riskLevel, "low");
  assert.equal(JSON.stringify(audits).includes("secret"), false);
});

test("health endpoint exposes cache source on adapter cache hit", async () => {
  const route = createRoute({
    url: "/v1/mxtoolbox/health?target=example.com&type=mx",
    token: "secret"
  });

  await handleReadMxtoolbox(route.request, route.response, {
    adapter: mockAdapter({ target: "example.com", command: "mx", cacheHit: true }),
    readBoundaryToken: "secret"
  });

  assert.equal(route.body().source, "cached");
  assert.equal(route.body().cachedAt, "2026-06-18T10:00:00.000Z");
});

test("daily report uses explicit targets and emits high-risk audits for listed results", async () => {
  const audits: MxtoolboxAuditEvent[] = [];
  const canvasEvents: unknown[] = [];
  const route = createRoute({
    url: "/v1/mxtoolbox/daily-report?targets=8.8.8.8,example.com&types=blacklist",
    token: "secret"
  });

  await handleReadMxtoolboxDailyReport(route.request, route.response, {
    adapter: mockAdapter({ listedTargets: new Set(["example.com"]) }),
    readBoundaryToken: "secret",
    now: () => new Date("2026-06-18T10:05:00Z"),
    emitAudit: async (event) => {
      audits.push(event);
    },
    canvasLiveEvents: {
      emit: (event) => {
        canvasEvents.push(event);
      }
    }
  });

  const body = route.body();
  assert.equal(route.response.statusCode, 200);
  assert.equal(body.totalTargets, 2);
  assert.equal(body.summary.clean, 1);
  assert.equal(body.summary.listed, 1);
  assert.equal(body.criticalAlerts.length, 1);
  assert.equal(audits.some((event) => event.action === "oc.mxtoolbox.blacklist_detected" && event.riskLevel === "high"), true);
  assert.equal(canvasEvents.length, 1);
});

test("daily report falls back to active sender nodes", async () => {
  const route = createRoute({
    url: "/v1/mxtoolbox/daily-report",
    token: "secret"
  });

  await handleReadMxtoolboxDailyReport(route.request, route.response, {
    adapter: mockAdapter(),
    readBoundaryToken: "secret",
    getSenderNodes: async () => [
      senderNode("a", "active", "8.8.8.8", "mail.example.com"),
      senderNode("b", "paused", "1.1.1.1", "paused.example.com")
    ]
  });

  const body = route.body();
  assert.equal(body.totalTargets, 2);
  assert.deepEqual(body.results.map((result: MxtoolboxHealthSummary) => result.target).sort(), ["8.8.8.8", "mail.example.com"]);
});

test("daily report clean scan appends clean audit", async () => {
  const audits: MxtoolboxAuditEvent[] = [];
  const route = createRoute({
    url: "/v1/mxtoolbox/daily-report?targets=8.8.8.8&types=blacklist",
    token: "secret"
  });

  await handleReadMxtoolboxDailyReport(route.request, route.response, {
    adapter: mockAdapter(),
    readBoundaryToken: "secret",
    emitAudit: async (event) => {
      audits.push(event);
    }
  });

  assert.equal(audits[0]?.action, "oc.mxtoolbox.daily_scan_clean");
  assert.equal(audits[0]?.riskLevel, "low");
});

function mockAdapter(options: {
  target?: string;
  command?: string;
  status?: MxtoolboxHealthSummary["status"];
  cacheHit?: boolean;
  listedTargets?: Set<string>;
} = {}): MxtoolboxAdapter {
  return {
    lookup: async (input: { target: string; command?: string }) => lookupResult({
      target: options.target ?? input.target,
      command: options.command ?? input.command ?? "blacklist",
      status: options.listedTargets?.has(input.target) ? "listed" : options.status ?? "clean",
      cacheHit: options.cacheHit ?? false
    }),
    usage: async () => null
  } as MxtoolboxAdapter;
}

function lookupResult(input: {
  target: string;
  command: string;
  status: MxtoolboxHealthSummary["status"];
  cacheHit: boolean;
}): MxtoolboxLookupResult {
  return {
    cacheHit: input.cacheHit,
    source: {
      kind: "live",
      apiBase: "https://api.mxtoolbox.com/api/v1",
      fetchedAt: "2026-06-18T10:00:00.000Z",
      responseOk: true
    },
    summary: {
      target: input.target,
      command: input.command,
      checkedAt: "2026-06-18T10:00:00.000Z",
      status: input.status,
      failedChecks: input.status === "listed" ? ["Listed"] : [],
      warningChecks: input.status === "warning" ? ["Warning"] : [],
      passedCount: input.status === "clean" ? 10 : 0,
      timeoutCount: input.status === "error" ? 1 : 0,
      rawRef: "a".repeat(64)
    }
  };
}

function senderNode(
  id: string,
  status: SenderNode["status"],
  ipAddress?: string,
  hostname?: string
): SenderNode {
  return {
    id,
    label: id,
    provider: "manual",
    status,
    ipAddress,
    hostname,
    dailyLimit: 100,
    warmupDay: 1
  };
}

function createRoute(input: { url: string; token?: string }) {
  const request = new EventEmitter() as IncomingMessage;
  request.method = "GET";
  request.url = input.url;
  request.headers = input.token ? { "x-delivrix-token": input.token } : {};

  const chunks: string[] = [];
  const response = new EventEmitter() as ServerResponse & {
    statusCode: number;
    headers: Record<string, string>;
  };
  response.statusCode = 200;
  response.headers = {};
  response.writeHead = ((statusCode: number, headers?: Record<string, string>) => {
    response.statusCode = statusCode;
    response.headers = headers ?? {};
    return response;
  }) as ServerResponse["writeHead"];
  response.end = ((chunk?: unknown) => {
    if (chunk) chunks.push(String(chunk));
    response.emit("finish");
    return response;
  }) as ServerResponse["end"];

  return {
    request,
    response,
    body: () => JSON.parse(chunks.join("") || "{}")
  };
}
