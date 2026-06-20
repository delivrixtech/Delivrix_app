import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { dispatchSkillHandler, type SkillDispatcherDeps, type SkillHandlerEntry } from "./skill-dispatcher.ts";
import { route53RegisterParamSchema, route53UpsertParamSchema, webdockCreateParamSchema } from "./skill-schemas.ts";
import type { ApprovalToken } from "./security/approval-token.ts";
import type { WebdockServerCreateAdapter, WebdockServerDeleteAdapter } from "./routes/webdock-servers.ts";
import {
  createIonosDnsProviderFromEnv,
  createRoute53DnsProviderFromEnv,
  type DnsProvider,
  type VpsProvider
} from "../../../packages/adapters/src/index.ts";

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

test("dispatcher threads accountId (canal paralelo 5.12) to the handler invoke", async () => {
  const seen: Array<string | undefined> = [];
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    accountId: "secondary",
    deps: fakeDeps(),
    handlers: {
      register_domain_route53: {
        paramSchema: route53RegisterParamSchema,
        timeoutMs: 1000,
        canRollback: true,
        invoke: async ({ response, accountId }) => {
          seen.push(accountId);
          json(response, 200, { ok: true });
        }
      }
    }
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(seen, ["secondary"]);
});

test("DoD#2 routing: create_webdock_server con accountId='secondary' usa el adapter de la cuenta-2 (no el de ops)", async () => {
  // El handler real de create bloquea sin approval/flag, pero ANTES consulta canCreate() del adapter
  // RESUELTO. Espiamos canCreate de cada cuenta para probar que el registry enruta a la cuenta-2.
  const opsCalls: string[] = [];
  const secondaryCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const secondaryAdapter = makeSpyCreateAdapter("secondary", secondaryCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter], ["secondary", secondaryAdapter]])
  });

  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlsecondary.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    accountId: "secondary",
    deps
  });

  assert.deepEqual(secondaryCalls, ["canCreate"], "el handler consulto el adapter de la cuenta-2");
  assert.deepEqual(opsCalls, [], "NO toco el adapter de la cuenta-1");
});

test("DoD#2 routing: create_webdock_server sin accountId usa el webdockAdapter (cuenta-1 ops), byte-identico", async () => {
  const opsCalls: string[] = [];
  const secondaryCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const secondaryAdapter = makeSpyCreateAdapter("secondary", secondaryCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter], ["secondary", secondaryAdapter]])
  });

  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlops.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    // sin accountId => cuenta-1
    deps
  });

  assert.deepEqual(opsCalls, ["canCreate"], "sin accountId enruta a la cuenta-1 (ops)");
  assert.deepEqual(secondaryCalls, [], "no toca la cuenta-2");
});

test("PROVIDER#b routing: create_webdock_server con providerId='contabo' usa el adapter del proveedor (no Webdock)", async () => {
  // El handler real de create bloquea sin approval/flag, pero ANTES consulta canCreate() del adapter
  // RESUELTO. Espiamos canCreate de cada adapter para probar que el providerId enruta a Contabo.
  const opsCalls: string[] = [];
  const contaboCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const contaboAdapter = makeSpyCreateAdapter("contabo", contaboCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter]]),
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", contaboAdapter]])
  });

  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlcontabo.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "contabo",
    deps
  });

  assert.deepEqual(contaboCalls, ["canCreate"], "el handler consulto el adapter de Contabo (createServer enrutaria alli)");
  assert.deepEqual(opsCalls, [], "NO toco el adapter Webdock (ops)");
});

test("PROVIDER#b2 routing: create_webdock_server sin providerId (o 'webdock') usa el webdockAdapter; NUNCA toca el mock Contabo", async () => {
  const opsCalls: string[] = [];
  const contaboCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const contaboAdapter = makeSpyCreateAdapter("contabo", contaboCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter]]),
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", contaboAdapter]])
  });

  // Sin providerId => Webdock (cuenta-1 ops).
  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlops.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    deps
  });
  assert.deepEqual(opsCalls, ["canCreate"], "sin providerId enruta a Webdock (ops)");
  assert.deepEqual(contaboCalls, [], "el mock Contabo NUNCA se toca sin providerId");

  // providerId='webdock' => tambien Webdock (se trata como ausente en el resolver).
  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlwebdock.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "webdock",
    deps
  });
  assert.deepEqual(opsCalls, ["canCreate", "canCreate"], "providerId='webdock' enruta a Webdock (ops)");
  assert.deepEqual(contaboCalls, [], "el mock Contabo sigue intacto con providerId='webdock'");
});

test("PROVIDER#guard providerId desconocido falla 422 y no cae a Webdock", async () => {
  const opsCalls: string[] = [];
  const contaboCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const contaboAdapter = makeSpyCreateAdapter("contabo", contaboCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter]]),
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", contaboAdapter]])
  });

  const result = await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controltypo.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "contaboo",
    deps
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.summary, { error: "unknown_vps_provider", providerId: "contaboo" });
  assert.deepEqual(opsCalls, [], "typo de provider NO cae al adapter Webdock");
  assert.deepEqual(contaboCalls, [], "typo de provider NO toca Contabo");
});

test("PROVIDER#c el providerId (canal paralelo) NO entra en los params pasados a invoke", async () => {
  const seenParams: Array<Record<string, unknown>> = [];
  const seenProviderId: Array<string | undefined> = [];
  const result = await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlchannel.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "contabo",
    deps: {
      ...fakeDeps(),
      vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", {} as VpsProvider]])
    },
    handlers: {
      create_webdock_server: {
        paramSchema: webdockCreateParamSchema,
        timeoutMs: 1000,
        canRollback: false,
        invoke: async ({ response, params, providerId }) => {
          seenParams.push(params);
          seenProviderId.push(providerId);
          json(response, 200, { ok: true });
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  // El providerId viaja por el canal paralelo (arg de invoke), NO dentro de params.
  assert.deepEqual(seenProviderId, ["contabo"]);
  assert.equal(seenParams.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(seenParams[0], "providerId"), false);
  // Sanidad: los params validados son exactamente el dict Webdock (sin providerId ni provider).
  assert.deepEqual(Object.keys(seenParams[0]).sort(), ["hostname", "imageSlug", "locationId", "profile", "publicKey"]);
});

test("DNS#stage2 registry factories inject dnsProviderAdapters without touching params", async () => {
  const dnsProviderEntries = [
    ...createRoute53DnsProviderFromEnv({
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret"
    }),
    ...createIonosDnsProviderFromEnv({
      IONOS_API_TOKEN: "ionos-token",
      IONOS_DNS_ENABLE_WRITES: "true"
    })
  ];
  const dnsProviderAdapters = new Map<string, DnsProvider>(
    dnsProviderEntries.map((entry): [string, DnsProvider] => [entry.id, entry.adapter])
  );
  const seenKeys: string[][] = [];
  const seenParams: Array<Record<string, unknown>> = [];

  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      dnsProviderAdapters
    },
    handlers: {
      register_domain_route53: {
        paramSchema: route53RegisterParamSchema,
        timeoutMs: 1000,
        canRollback: true,
        invoke: async ({ response, params, deps }) => {
          seenKeys.push([...(deps.dnsProviderAdapters?.keys() ?? [])].sort());
          seenParams.push(params);
          json(response, 200, { ok: true });
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(seenKeys, [["ionos", "route53"]]);
  assert.equal(dnsProviderAdapters.get("route53")?.isLive(), true);
  assert.equal(dnsProviderAdapters.get("ionos")?.isLive(), true);
  assert.equal(dnsProviderAdapters.get("ionos")?.isWriteEnabled(), true);
  assert.equal(Object.prototype.hasOwnProperty.call(seenParams[0], "dnsProviderId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(seenParams[0], "registrarId"), false);
});

function makeSpyCreateAdapter(
  id: string,
  calls: string[]
): WebdockServerCreateAdapter & WebdockServerDeleteAdapter {
  return {
    isLive: () => true,
    canWrite: () => { calls.push("canWrite"); return false; },
    canCreate: () => { calls.push("canCreate"); return false; },
    async createServer() { calls.push("createServer"); throw new Error(`createServer should not run for ${id} in blocked path`); },
    async getServer() { throw new Error("getServer not expected"); },
    async deleteServer() { calls.push("deleteServer"); throw new Error("deleteServer not expected"); }
  };
}

function webdockDispatchDeps(overrides: {
  webdockAdapter: WebdockServerCreateAdapter;
  webdockCreateAdapters: Map<string, WebdockServerCreateAdapter & Partial<WebdockServerDeleteAdapter>>;
  vpsProviderAdapters?: SkillDispatcherDeps["vpsProviderAdapters"];
}): SkillDispatcherDeps {
  return {
    auditLog: { append: async () => ({}), list: async () => [] },
    workspace: {
      readLearnings: async () => [],
      writeExecutionRecord: async () => null,
      updateInventoryJson: async () => undefined
    } as unknown as SkillDispatcherDeps["workspace"],
    readCanvasState: () => ({ tasks: [], actions: [], artifacts: [] } as never),
    domainPurchaseAdapter: {} as never,
    route53DnsAdapter: {} as never,
    ionosDnsAdapter: {} as never,
    webdockAdapter: overrides.webdockAdapter as never,
    webdockCreateAdapters: overrides.webdockCreateAdapters,
    ...(overrides.vpsProviderAdapters ? { vpsProviderAdapters: overrides.vpsProviderAdapters } : {}),
    smtpSshRunner: {} as never,
    rampScheduler: {} as never,
    env: { WEBDOCK_SERVERS_ENABLE_CREATE: "false" }
  };
}

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
