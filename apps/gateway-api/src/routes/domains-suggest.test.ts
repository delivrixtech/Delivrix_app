import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import {
  handleSuggestSafeDomainHttp,
  suggestSafeDomainParamSchema,
  type RegistrarAvailability,
  type SpamhausDblResult,
  type SuggestSafeDomainDeps
} from "./domains-suggest.ts";

test("POST /v1/skills/suggest-safe-domain returns safe smtp candidates", async () => {
  const response = await route({
    brand: "delivrix",
    intent: "smtp",
    count: 3,
    actorId: "juanes-cto"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.candidates.length, 3);
  for (const candidate of response.body.candidates) {
    assert.ok(candidate.namingScore >= 70);
    assert.equal(/mail|notify|email/.test(candidate.domain), false);
    assert.equal(candidate.blockedReasons.length, 0);
  }
});

test("POST /v1/skills/suggest-safe-domain filters Spamhaus DBL listed candidates", async () => {
  const response = await route({
    brand: "delivrix",
    intent: "smtp",
    count: 1,
    actorId: "juanes-cto"
  }, {
    spamhausDBL: async (domain) => domain === "deliverydelivrix.app" ? "listed" : "clean"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.candidates.length, 1);
  assert.notEqual(response.body.candidates[0].domain, "deliverydelivrix.app");
});

test("POST /v1/skills/suggest-safe-domain degrades availability failures to unknown", async () => {
  const response = await route({
    brand: "delivrix",
    intent: "smtp",
    count: 1,
    actorId: "juanes-cto"
  }, {
    route53Availability: async () => {
      throw new Error("route53 unavailable");
    },
    porkbunAvailability: async () => ({ available: "unknown", priceUsd: null })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.candidates[0].available, "unknown");
  assert.deepEqual(response.body.candidates[0].registrarOptions, []);
});

test("suggestSafeDomainParamSchema normaliza el brand a [a-z0-9] en vez de rechazar", () => {
  // Regresion: "corpfiling-infra" (con guion) tumbaba configure_complete_smtp en el
  // paso 1 con HTTP 400. El brand es un concepto de marca, no un identificador
  // estricto: mayusculas, guiones y puntuacion se normalizan. El dominio final viene
  // del scope firmado del plan, no del brand, asi que normalizar es seguro.
  for (const [raw, normalized] of [
    ["corpfiling-infra", "corpfilinginfra"],
    ["Delivrix", "delivrix"],
    ["Corp Filing.Infra", "corpfilinginfra"],
    ["corpfiling", "corpfiling"]
  ] as const) {
    const result = suggestSafeDomainParamSchema.safeParse({ brand: raw, actorId: "juanes-cto" });
    assert.equal(result.success, true, `brand "${raw}" debe pasar`);
    if (result.success) {
      assert.equal(result.data.brand, normalized);
    }
  }
});

test("POST /v1/skills/suggest-safe-domain acepta brand con guion end-to-end (regresion corpfiling-infra)", async () => {
  const response = await route({
    brand: "corpfiling-infra",
    intent: "smtp",
    count: 3,
    actorId: "juanes-cto"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.candidates.length, 3);
});

test("POST /v1/skills/suggest-safe-domain rechaza brand sin caracteres alfanumericos", async () => {
  const response = await route({
    brand: "-.-",
    intent: "smtp",
    count: 3,
    actorId: "juanes-cto"
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_params");
  assert.deepEqual(response.body.details.brand._errors, ["brand_must_be_lowercase_alphanumeric"]);
});

test("POST /v1/skills/suggest-safe-domain rejects count above max", async () => {
  const response = await route({
    brand: "delivrix",
    intent: "smtp",
    count: 21,
    actorId: "juanes-cto"
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_params");
  assert.ok(response.body.details.count._errors[0].includes("1 and 20"));
});

test("POST /v1/skills/suggest-safe-domain audits suggestion with blocked breakdown", async () => {
  const auditLog = await auditLogForTest();
  const response = await route({
    brand: "delivrix",
    intent: "smtp",
    tlds: ["click", "com"],
    count: 2,
    actorId: "juanes-cto"
  }, { auditLog });

  assert.equal(response.statusCode, 200);
  const events = await auditLog.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.naming.candidates_suggested");
  assert.equal(events[0].actorId, "juanes-cto");
  assert.ok((events[0].metadata.blockedReasonsBreakdown as Record<string, number>).tld_problematic > 0);
});

test("POST /v1/skills/suggest-safe-domain respects custom TLD list", async () => {
  const response = await route({
    brand: "delivrix",
    intent: "ops",
    tlds: ["co"],
    count: 3,
    actorId: "juanes-cto"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.candidates.length, 3);
  assert.deepEqual(response.body.candidates.map((candidate: { domain: string }) => candidate.domain.endsWith(".co")), [true, true, true]);
});

test("POST /v1/skills/suggest-safe-domain is deterministic for repeated input", async () => {
  const body = {
    brand: "delivrix",
    intent: "smtp",
    count: 5,
    actorId: "juanes-cto"
  };
  const first = await route(body);
  const second = await route(body);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    first.body.candidates.map((candidate: { domain: string }) => candidate.domain),
    second.body.candidates.map((candidate: { domain: string }) => candidate.domain)
  );
});

async function route(
  body: unknown,
  overrides: Partial<SuggestSafeDomainDeps> = {}
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  const auditLog = overrides.auditLog ?? await auditLogForTest();
  await handleSuggestSafeDomainHttp({
    request: requestWithJson(body),
    response: response as unknown as ServerResponse,
    deps: {
      auditLog,
      route53Availability: async (domain) => availability(domain, false, 14),
      porkbunAvailability: async (domain) => availability(domain, true, 11),
      spamhausDBL: async () => "clean",
      now: () => new Date("2026-05-31T19:30:00.000Z"),
      ...overrides
    }
  });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

async function auditLogForTest(): Promise<LocalFileAuditLog> {
  return new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "delivrix-suggest-domain-audit-")), "audit-events.jsonl"));
}

function availability(_domain: string, available: boolean | "unknown", priceUsd: number | null): RegistrarAvailability {
  return { available, priceUsd };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/skills/suggest-safe-domain",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
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
