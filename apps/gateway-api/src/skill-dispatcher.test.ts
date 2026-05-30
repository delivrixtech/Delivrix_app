import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { dispatchSkillHandler, type SkillHandlerEntry } from "./skill-dispatcher.ts";
import { route53RegisterParamSchema, route53UpsertParamSchema } from "./skill-schemas.ts";
import type { ApprovalToken } from "./security/approval-token.ts";

const token: ApprovalToken = {
  tokenId: "exec-token-1",
  actionId: "register_domain",
  targetType: "domain",
  targetId: "delivrix.test",
  approverId: "operator-juanes",
  issuedAt: "2026-05-29T21:00:00.000Z",
  expiresAt: "2026-05-29T21:05:00.000Z",
  nonce: "nonce",
  signature: "signature"
};

test("dispatcher returns unknown_skill for unmapped skill", async () => {
  const result = await dispatchSkillHandler({
    skill: "missing",
    params: {},
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: {}
  });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.summary, { error: "unknown_skill", skill: "missing" });
});

test("dispatcher requires dependencies", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema) }
  });
  assert.equal(result.statusCode, 500);
  assert.equal((result.summary as { error: string }).error, "dispatcher_dependencies_missing");
});

test("dispatcher validates params before invoking handler", async () => {
  const calls: unknown[] = [];
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "bad", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema, calls) }
  });
  assert.equal(result.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("dispatcher invokes handler with actorId and approvalToken", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1, autoRenew: true },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema, calls) }
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].actorId, "operator-juanes");
  assert.equal(calls[0].approvalToken, "exec-token-1");
});

test("dispatcher marks non-2xx handler response as failed", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: statusEntry(route53RegisterParamSchema, 409, { error: "blocked" }) }
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
});

test("dispatcher maps handler timeout to 504", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    timeoutMs: 5,
    deps: fakeDeps(),
    handlers: {
      register_domain_route53: {
        paramSchema: route53RegisterParamSchema,
        timeoutMs: 5,
        canRollback: true,
        invoke: async () => new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  });
  assert.equal(result.statusCode, 504);
  assert.equal((result.summary as { error: string }).error, "handler_timeout");
});

test("dispatcher maps thrown handler to 500", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: {
      register_domain_route53: {
        paramSchema: route53RegisterParamSchema,
        timeoutMs: 1000,
        canRollback: true,
        invoke: async () => {
          throw new Error("boom");
        }
      }
    }
  });
  assert.equal(result.statusCode, 500);
  assert.equal((result.summary as { message: string }).message, "boom");
});

test("route53 register schema accepts durationYears alias and normalizes to years", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "Delivrix.TEST.", durationYears: 2 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema, calls) }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].domain, "delivrix.test");
  assert.equal(calls[0].years, 2);
});

test("route53 dns schema accepts zoneName alias and emits domain", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await dispatchSkillHandler({
    skill: "upsert_dns_route53",
    params: {
      zoneName: "Delivrix.TEST.",
      records: [{ name: "@", type: "A", ttl: 300, values: ["1.2.3.4"] }]
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { upsert_dns_route53: okEntry(route53UpsertParamSchema, calls) }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].domain, "delivrix.test");
});

test("route53 dns schema rejects unsupported record type", async () => {
  const result = await dispatchSkillHandler({
    skill: "upsert_dns_route53",
    params: {
      domain: "delivrix.test",
      records: [{ name: "@", type: "SRV", ttl: 300, values: ["bad"] }]
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { upsert_dns_route53: okEntry(route53UpsertParamSchema) }
  });
  assert.equal(result.statusCode, 400);
});

test("dispatcher returns parsed JSON summary", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: statusEntry(route53RegisterParamSchema, 202, { status: "accepted" }) }
  });
  assert.deepEqual(result.summary, { status: "accepted" });
});

test("dispatcher records durationMs", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema) }
  });
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.durationMs >= 0, true);
});

function okEntry(schema: SkillHandlerEntry["paramSchema"], calls: Array<Record<string, unknown>> = []): SkillHandlerEntry {
  return {
    paramSchema: schema,
    timeoutMs: 1000,
    canRollback: true,
    invoke: async ({ request, response }) => {
      const body = await readJson(request);
      calls.push(body);
      json(response, 200, { ok: true, body });
    }
  };
}

function statusEntry(
  schema: SkillHandlerEntry["paramSchema"],
  statusCode: number,
  body: unknown
): SkillHandlerEntry {
  return {
    paramSchema: schema,
    timeoutMs: 1000,
    canRollback: true,
    invoke: async ({ response }) => {
      json(response, statusCode, body);
    }
  };
}

function fakeDeps(): any {
  return {};
}

async function readJson(request: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
