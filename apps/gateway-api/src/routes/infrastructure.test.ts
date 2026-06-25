import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalFileAuditLog,
  LocalFileInfrastructureAccountLifecycleStore
} from "../../../../packages/local-store/src/index.ts";
import type { SenderNode } from "../../../../packages/domain/src/index.ts";
import type {
  AwsRoute53DomainsInventoryResult,
  IonosDnsInventoryResult,
  IonosDomainsInventoryResult,
  PorkbunInventoryResult,
  WebdockInventoryResult
} from "../../../../packages/adapters/src/index.ts";
import { WebdockRealAdapter } from "../../../../packages/adapters/src/index.ts";
import { computeAuditHash } from "../audit/hash-chain.ts";
import {
  auditInfrastructureAccountHealthTransitions,
  auditInfrastructureInventoryFetch,
  buildInfrastructureInventoryPayload,
  handleInfrastructureAccountHealthHttp,
  handleInfrastructureInventoryHttp,
  readInfrastructureAccountLifecycleOverlay,
  shouldAuditInfrastructureInventoryFetch
} from "./infrastructure.ts";

const fixedNow = new Date("2026-05-24T18:00:00.000Z");

test("Infrastructure inventory returns an empty provider list when nothing is connected", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    now: fixedNow
  });

  assert.deepEqual(payload, {
    generatedAt: "2026-05-24T18:00:00.000Z",
    itemTotal: 0,
    providers: []
  });
});

test("Infrastructure inventory degrades gracefully when AWS cache exists and IONOS adapter is pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-infra-"));
  const bedrockLog = join(dir, "openclaw-bedrock-setup.jsonl");
  await writeFile(bedrockLog, `${JSON.stringify({
    occurredAt: "2026-05-18T18:27:13.000Z",
    action: "oc.provider.switched",
    metadata: {
      toProvider: "amazon-bedrock",
      toModel: "us.anthropic.claude-sonnet-4-6",
      awsRegion: "us-east-1",
      budgetActionConfigured: true
    }
  })}\n`, "utf8");

  const webdock: WebdockInventoryResult = {
    servers: [{
      slug: "svc-warmup-01",
      name: "svc-warmup-01",
      ipv4: "185.243.12.31",
      status: "running",
      location: "fi-hel-2",
      accountId: "default",
      accountLabel: "Webdock"
    }],
    source: {
      kind: "live",
      apiBase: "https://api.webdock.io/v1",
      accountId: "default",
      accountLabel: "Webdock",
      fetchedAt: "2026-05-24T17:59:30.000Z",
      responseOk: true
    }
  };

  const payload = await buildInfrastructureInventoryPayload({
    webdock,
    awsBedrockSetupLogPath: bedrockLog,
    env: { IONOS_API_TOKEN: "configured-but-adapter-pending" },
    now: fixedNow
  });

  assert.equal(payload.providers.length, 7);
  assert.deepEqual(payload.providers.map((provider) => [provider.id, provider.status]), [
    ["webdock-default", "active"],
    ["aws-bedrock-us-east-1", "active"],
    ["aws-route53-domains", "planned"],
    ["porkbun-domains", "planned"],
    ["ionos-cloud-dns", "error"],
    ["ionos-domains", "planned"],
    ["physical-medellin", "planned"]
  ]);
  assert.equal(payload.providers[0].fetchSourceKind, "live");
  assert.equal(payload.providers[0].itemCount, 1);
  assert.equal(payload.providers[0].items?.[0]?.detail?.ipv4, "185.243.12.31");
  assert.equal(payload.providers[1].items?.[0]?.id, "us.anthropic.claude-sonnet-4-6");
  assert.equal(payload.providers[2].errorReason, "creds_not_configured");
  assert.equal(payload.providers[3].errorReason, "creds_not_configured");
  assert.equal(payload.providers[4].errorReason, "adapter_pending");
  assert.equal(payload.providers[5].errorReason, "creds_not_configured");
  assert.equal(payload.providers.find((provider) => provider.id === "physical-medellin")?.statusLabel, "Aún offline");
});

test("Infrastructure inventory de-dupes Webdock cuenta madre roles in read-only inventory", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [
      webdockAccount("primary", "Webdock Primary", ["running", "running", "stopped"]),
      webdockAccount("ops", "Webdock Ops", ["running", "running", "stopped"]),
      webdockAccount("account", "Webdock Account", ["running", "running", "stopped"])
    ],
    now: fixedNow
  });

  assert.deepEqual(payload.providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    status: provider.status,
    statusLabel: provider.statusLabel,
    itemCount: provider.itemCount
  })), [
    {
      id: "webdock-primary",
      displayName: "Webdock Primary",
      status: "active",
      statusLabel: "Activo",
      itemCount: 3
    }
  ]);
  assert.equal(payload.providers[0].items?.[0]?.detail?.accountId, "primary");
  assert.equal(payload.providers[0].items?.[0]?.detail?.accountLabel, "Webdock Primary");
  assert.equal(payload.providers[0].items?.[0]?.detail?.ipv4, "185.243.12.31");
});

test("Infrastructure inventory preserves distinct Webdock accounts after cuenta madre de-dupe", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [
      webdockAccount("primary", "Webdock Primary", ["running"]),
      webdockAccount("ops", "Webdock Ops", ["running"]),
      webdockAccount("secondary", "Webdock Secondary", [], {
        responseOk: false,
        errorMessage: "Webdock API returned 401 Unauthorized"
      })
    ],
    now: fixedNow
  });

  assert.deepEqual(payload.providers.map((provider) => [provider.id, provider.status, provider.itemCount]), [
    ["webdock-primary", "active", 1],
    ["webdock-secondary", "error", 0]
  ]);
});

test("Infrastructure inventory does not surface adapter fallback servers when Webdock read is rejected", async () => {
  const adapter = new WebdockRealAdapter({
    readApiKey: "bad-read-key",
    apiBase: "https://api.webdock.test/v1",
    accountId: "secondary",
    accountLabel: "Webdock Secondary",
    cacheTtlMs: 0,
    now: () => new Date("2026-05-24T17:59:30.000Z"),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.webdock.test/v1/servers");
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer bad-read-key");
      return new Response("", { status: 401, statusText: "Unauthorized" });
    }
  });

  const result = await adapter.listServers();
  assert.equal(result.source.kind, "live");
  assert.equal(result.source.responseOk, false);
  assert.equal(result.source.authFailure, true);
  assert.equal(result.source.httpStatus, undefined);
  assert.equal(result.source.errorCode, undefined);
  assert.equal(result.source.failureKind, undefined);
  assert.equal(result.source.errorMessage, "webdock_auth_failed");
  assert.deepEqual(result.servers, []);

  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [{
      accountId: "secondary",
      accountLabel: "Webdock Secondary",
      result
    }],
    now: fixedNow
  });

  const provider = payload.providers[0];
  assert.equal(provider.id, "webdock-secondary");
  assert.equal(provider.status, "error");
  assert.equal(provider.itemCount, 0);
  assert.deepEqual(provider.items, []);
  assert.deepEqual(payload.accountHealth?.accounts.map((account) => ({
    accountId: account.accountId,
    health: account.health,
    lifecycleStatus: account.lifecycleStatus,
    httpStatus: account.httpStatus,
    errorCode: account.errorCode,
    errorReason: account.errorReason
  })), [{
    accountId: "secondary",
    health: "unauthorized",
    lifecycleStatus: "unauthorized",
    httpStatus: undefined,
    errorCode: undefined,
    errorReason: "webdock_auth_failed"
  }]);
  assert.equal(payload.itemTotal, 0);
});

test("Infrastructure inventory preserves legacy Webdock default account shape", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [webdockAccount("default", "Webdock", ["running"])],
    now: fixedNow
  });

  assert.equal(payload.providers.length, 1);
  assert.equal(payload.providers[0].id, "webdock-default");
  assert.equal(payload.providers[0].displayName, "Webdock");
  assert.equal(payload.providers[0].status, "active");
});

test("Infrastructure inventory exposes AWS Route 53 Domains as discovery-only registrar", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: true,
    awsRoute53Domains: awsRoute53DomainsInventory({
      domains: [{
        domainName: "delivrix.io",
        autoRenew: true,
        transferLock: true,
        expiry: "2027-05-25T00:00:00Z"
      }]
    }),
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl"),
    env: {},
    now: fixedNow
  });

  const provider = payload.providers.find((item) => item.id === "aws-route53-domains");

  assert.equal(provider?.kind, "domain-registrar");
  assert.equal(provider?.status, "active");
  assert.equal(provider?.itemCount, 1);
  assert.equal(provider?.fetchSourceKind, "live");
  assert.deepEqual(provider?.capabilities, [
    "list_registered_domains",
    "check_domain_availability",
    "get_domain_suggestions",
    "list_domain_prices",
    "draft_domain_purchase_proposal"
  ]);
  assert.equal(provider?.items?.[0]?.displayName, "delivrix.io");
  assert.deepEqual(provider?.items?.[0]?.detail, {
    autoRenew: true,
    transferLock: true,
    expiry: "2027-05-25T00:00:00Z"
  });
});

test("Infrastructure inventory exposes Porkbun Domains as discovery-only registrar", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: true,
    porkbun: porkbunInventory({
      domains: [{
        domainName: "delivrix-mail.com",
        tld: "com",
        status: "ACTIVE",
        expiry: "2027-05-25",
        autoRenew: true,
        whoisPrivacy: true
      }]
    }),
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl"),
    env: {},
    now: fixedNow
  });

  const provider = payload.providers.find((item) => item.id === "porkbun-domains");

  assert.equal(provider?.kind, "domain-registrar");
  assert.equal(provider?.status, "active");
  assert.equal(provider?.itemCount, 1);
  assert.equal(provider?.fetchSourceKind, "live");
  assert.deepEqual(provider?.capabilities, [
    "list_registered_domains",
    "check_domain_availability",
    "list_domain_prices",
    "draft_domain_purchase_proposal",
    "compare_registrar_prices"
  ]);
  assert.equal(provider?.items?.[0]?.displayName, "delivrix-mail.com");
  assert.deepEqual(provider?.items?.[0]?.detail, {
    tld: "com",
    status: "ACTIVE",
    createdAt: null,
    expiry: "2027-05-25",
    autoRenew: true,
    whoisPrivacy: true
  });
});

test("Infrastructure inventory marks a failed Webdock account without hiding healthy accounts", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [
      webdockAccount("primary", "Webdock Primary", ["running"]),
      webdockAccount("secondary", "Webdock Secondary", ["running", "running", "stopped"], {
        responseOk: false,
        httpStatus: 401,
        errorCode: "webdock_auth_401",
        failureKind: "unauthorized",
        errorMessage: "Webdock API returned 401 Unauthorized"
      })
    ],
    now: fixedNow
  });

  assert.deepEqual(payload.providers.map((provider) => [provider.id, provider.status]), [
    ["webdock-primary", "active"],
    ["webdock-secondary", "error"]
  ]);
  assert.equal(payload.providers[1].errorReason, "Webdock API returned 401 Unauthorized");
  assert.equal(payload.providers[1].itemCount, 0);
  assert.deepEqual(payload.providers[1].items, []);
  assert.equal(payload.accountHealth?.unhealthyCount, 1);
  assert.equal(payload.accountHealth?.accounts.find((account) => account.accountId === "secondary")?.health, "unauthorized");
  assert.equal(payload.itemTotal, 1);
});

test("Infrastructure inventory treats Webdock 403 as a live account auth failure", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [
      webdockAccount("secondary", "Webdock Secondary", ["running"], {
        responseOk: false,
        httpStatus: 403,
        httpStatusText: "Forbidden",
        errorCode: "webdock_auth_403",
        failureKind: "forbidden",
        errorMessage: "Webdock API returned 403 Forbidden"
      })
    ],
    now: fixedNow
  });

  const provider = payload.providers[0];
  assert.equal(provider.id, "webdock-secondary");
  assert.equal(provider.status, "error");
  assert.equal(provider.fetchSourceKind, "live");
  assert.equal(provider.errorReason, "Webdock API returned 403 Forbidden");
  assert.equal(provider.itemCount, 0);
  assert.deepEqual(provider.items, []);
  assert.deepEqual(payload.accountHealth?.accounts.map((account) => ({
    accountId: account.accountId,
    health: account.health,
    lifecycleStatus: account.lifecycleStatus,
    httpStatus: account.httpStatus,
    errorCode: account.errorCode
  })), [{
    accountId: "secondary",
    health: "unauthorized",
    lifecycleStatus: "unauthorized",
    httpStatus: 403,
    errorCode: "webdock_auth_403"
  }]);
});

test("Infrastructure inventory exposes Contabo as connected external VPS provider with zero live servers", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    vpsProviders: [vpsProvider("contabo", "Contabo Host Latam", [])],
    now: fixedNow
  });

  assert.deepEqual(payload.providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    status: provider.status,
    statusLabel: provider.statusLabel,
    itemCount: provider.itemCount,
    fetchSourceKind: provider.fetchSourceKind
  })), [{
    id: "contabo",
    displayName: "Contabo Host Latam",
    kind: "compute",
    status: "active",
    statusLabel: "Conectado sin VPS",
    itemCount: 0,
    fetchSourceKind: "live"
  }]);
  assert.deepEqual(payload.accountHealth?.accounts.map((account) => ({
    providerId: account.providerId,
    accountId: account.accountId,
    health: account.health,
    liveItemCount: account.liveItemCount
  })), [{
    providerId: "contabo",
    accountId: "contabo",
    health: "healthy",
    liveItemCount: 0
  }]);
});

test("Infrastructure inventory exposes Contabo live VPS items with provider and IPv4 detail", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    vpsProviders: [vpsProvider("contabo", "Contabo Host Latam", ["running"])],
    now: fixedNow
  });

  const provider = payload.providers[0];
  assert.equal(provider.id, "contabo");
  assert.equal(provider.kind, "compute");
  assert.equal(provider.status, "active");
  assert.equal(provider.itemCount, 1);
  assert.equal(provider.items?.[0]?.kind, "contabo_server");
  assert.equal(provider.items?.[0]?.detail?.providerId, "contabo");
  assert.equal(provider.items?.[0]?.detail?.accountId, "contabo");
  assert.equal(provider.items?.[0]?.detail?.accountLabel, "Contabo Host Latam");
  assert.equal(provider.items?.[0]?.detail?.ipv4, "203.0.113.10");
  assert.equal(payload.accountHealth?.accounts.find((account) => account.providerId === "contabo")?.liveItemCount, 1);
});

test("Infrastructure inventory reports confirmed Webdock sender-node orphans and provider servers without nodes", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [webdockAccount("primary", "Webdock Primary", ["running", "running", "running"])],
    senderNodes: [
      senderNode("sender-explicit", { providerAccountId: "primary", providerServerId: "svc-primary-1" }),
      senderNode("sender-ip", { ipAddress: "185.243.12.32" }),
      senderNode("sender-orphan", {
        providerAccountId: "primary",
        providerServerId: "missing-server",
        ipAddress: "198.51.100.10"
      })
    ],
    now: fixedNow
  });

  assert.deepEqual(payload.orphanReport?.confirmedSenderNodeOrphans.map((item) => item.id), ["sender-orphan"]);
  assert.deepEqual(payload.orphanReport?.providerServersWithoutSenderNode.map((item) => item.id), ["svc-primary-3"]);
  assert.deepEqual(payload.orphanReport?.uncertainBecauseAccountDown, []);
});

test("Infrastructure inventory keeps sender-node orphan status uncertain when any Webdock account is down", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [
      webdockAccount("primary", "Webdock Primary", ["running"]),
      webdockAccount("secondary", "Webdock Secondary", [], {
        responseOk: false,
        httpStatus: 401,
        errorCode: "webdock_auth_401",
        failureKind: "unauthorized",
        errorMessage: "Webdock API returned 401 Unauthorized"
      })
    ],
    senderNodes: [
      senderNode("sender-secondary", {
        providerAccountId: "secondary",
        providerServerId: "unknown-because-account-down",
        ipAddress: "198.51.100.11"
      })
    ],
    now: fixedNow
  });

  assert.deepEqual(payload.orphanReport?.confirmedSenderNodeOrphans, []);
  assert.deepEqual(payload.orphanReport?.uncertainBecauseAccountDown.map((account) => account.accountId), ["secondary"]);
});

test("Infrastructure inventory hides stale external VPS items when provider fetch fails", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    vpsProviders: [
      vpsProvider("contabo", "Contabo Host Latam", ["running"], {
        responseOk: false,
        errorMessage: "Contabo API returned 401 Unauthorized"
      })
    ],
    now: fixedNow
  });

  const provider = payload.providers[0];
  assert.equal(provider.id, "contabo");
  assert.equal(provider.status, "error");
  assert.equal(provider.errorReason, "Contabo API returned 401 Unauthorized");
  assert.equal(provider.itemCount, 0);
  assert.deepEqual(provider.items, []);
  assert.deepEqual(payload.accountHealth?.accounts.map((account) => ({
    providerId: account.providerId,
    accountId: account.accountId,
    health: account.health,
    lifecycleStatus: account.lifecycleStatus,
    errorReason: account.errorReason
  })), [{
    providerId: "contabo",
    accountId: "contabo",
    health: "degraded",
    lifecycleStatus: "active",
    errorReason: "Contabo API returned 401 Unauthorized"
  }]);
  assert.equal(payload.itemTotal, 0);
});

test("Infrastructure account health includes Contabo lifecycle streak metadata", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    vpsProviders: [
      vpsProvider("contabo", "Contabo Host Latam", ["running"], {
        responseOk: false,
        httpStatus: 401,
        errorCode: "contabo_auth_401",
        failureKind: "unauthorized",
        errorMessage: "Contabo API returned 401 Unauthorized"
      })
    ],
    accountLifecycleRecords: [{
      accountKey: "contabo:contabo",
      providerId: "contabo",
      accountId: "contabo",
      accountLabel: "Contabo Host Latam",
      lifecycleStatus: "unauthorized",
      healthStatus: "unauthorized",
      lastKnownItemCount: 8,
      consecutiveFailures: 3,
      firstUnhealthyAt: "2026-06-24T10:05:01.000Z",
      updatedAt: "2026-06-24T10:15:01.000Z",
      updatedBy: "gateway-api"
    }],
    now: fixedNow
  });

  assert.deepEqual(payload.accountHealth?.accounts.map((account) => ({
    providerId: account.providerId,
    accountId: account.accountId,
    health: account.health,
    consecutiveFailures: account.consecutiveFailures,
    firstUnhealthyAt: account.firstUnhealthyAt,
    lastKnownItemCount: account.lastKnownItemCount
  })), [{
    providerId: "contabo",
    accountId: "contabo",
    health: "unauthorized",
    consecutiveFailures: 3,
    firstUnhealthyAt: "2026-06-24T10:05:01.000Z",
    lastKnownItemCount: 8
  }]);
});

test("Infrastructure health audit emits generic transitions for external VPS providers", async () => {
  const auditEvents: unknown[] = [];
  const observed: unknown[] = [];

  await auditInfrastructureAccountHealthTransitions({
    auditLog: {
      async append(event) {
        auditEvents.push(event);
        return event as never;
      }
    },
    accountLifecycleStore: {
      list: async () => [],
      observe: async (input) => {
        observed.push(input);
        return {
          action: "unhealthy",
          previousHealthStatus: "healthy",
          currentHealthStatus: "unauthorized",
          account: {
            accountKey: "contabo:contabo",
            providerId: "contabo",
            accountId: "contabo",
            accountLabel: "Contabo Host Latam",
            lifecycleStatus: "unauthorized",
            healthStatus: "unauthorized",
            updatedAt: fixedNow.toISOString(),
            updatedBy: "gateway-api"
          }
        };
      }
    },
    webdockAccounts: [],
    vpsProviders: [
      vpsProvider("contabo", "Contabo Host Latam", [], {
        responseOk: false,
        httpStatus: 401,
        errorCode: "contabo_auth_401",
        failureKind: "unauthorized",
        errorMessage: "Contabo API returned 401 Unauthorized"
      })
    ],
    observedAt: fixedNow
  });

  assert.deepEqual(observed, [{
    providerId: "contabo",
    accountId: "contabo",
    accountLabel: "Contabo Host Latam",
    responseOk: false,
    healthStatus: "unauthorized",
    fetchedAt: "2026-05-24T17:59:30.000Z",
    observedAt: "2026-05-24T18:00:00.000Z",
    itemCount: 0,
    httpStatus: 401,
    errorCode: "contabo_auth_401",
    errorReason: "Contabo API returned 401 Unauthorized",
    actorId: "gateway-api"
  }]);
  assert.equal((auditEvents[0] as any).action, "oc.infrastructure.account_unhealthy");
  assert.equal((auditEvents[0] as any).targetType, "infrastructure_account");
  assert.equal((auditEvents[0] as any).metadata.providerId, "contabo");
});

test("Infrastructure inventory handler degrades provider fanout failures with allSettled", async () => {
  const response = responseRecorder();
  const auditEvents: unknown[] = [];

  await handleInfrastructureInventoryHttp({
    request: requestStub("/v1/infrastructure/inventory", {}),
    response: response as unknown as ServerResponse,
    auditLog: {
      async append(event) {
        auditEvents.push(event);
      }
    },
    webdockListServers: async () => {
      throw new Error("webdock exploded");
    },
    vpsProviderListServers: async () => [vpsProvider("contabo", "Contabo Host Latam", ["running"])],
    now: () => fixedNow,
    env: {},
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl")
  });

  assert.equal(response.result().statusCode, 200);
  const body = response.result().body as { providers: Array<{ id: string; itemCount: number }> };
  assert.equal(body.providers.find((provider) => provider.id === "contabo")?.itemCount, 1);
  assert.equal(body.providers.find((provider) => provider.id === "webdock-primary"), undefined);
  assert.deepEqual(auditEvents, []);
});

test("Infrastructure inventory handler gates OpenClaw skill invocation with read-boundary token", async () => {
  const denied = responseRecorder();
  await handleInfrastructureInventoryHttp({
    request: requestStub("/v1/infrastructure/inventory", {
      "x-openclaw-skill-invocation": "delivrix-infra-inventory"
    }),
    response: denied as unknown as ServerResponse,
    auditLog: { async append() {} },
    webdockListServers: async () => [],
    readBoundaryToken: "read-token",
    now: () => fixedNow
  });
  assert.equal(denied.result().statusCode, 401);

  const allowed = responseRecorder();
  const auditEvents: unknown[] = [];
  await handleInfrastructureInventoryHttp({
    request: requestStub("/v1/infrastructure/inventory", {
      "x-openclaw-skill-invocation": "delivrix-infra-inventory",
      "x-delivrix-token": "read-token"
    }),
    response: allowed as unknown as ServerResponse,
    auditLog: {
      async append(event) {
        auditEvents.push(event);
      }
    },
    webdockListServers: async () => [],
    readBoundaryToken: "read-token",
    now: () => fixedNow,
    env: {},
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl")
  });

  assert.equal(allowed.result().statusCode, 200);
  assert.equal(auditEvents.length, 1);
});

test("Infrastructure inventory handler degrades account health audit failures", async () => {
  const response = responseRecorder();
  const warnings: Array<{ event: string; metadata?: Record<string, unknown> }> = [];

  await handleInfrastructureInventoryHttp({
    request: requestStub("/v1/infrastructure/inventory", {}),
    response: response as unknown as ServerResponse,
    auditLog: { async append() {} },
    webdockListServers: async () => [webdockAccount("secondary", "Webdock Secondary", ["running"])],
    accountLifecycleStore: {
      observe: async () => {
        throw new Error("lifecycle write failed");
      },
      list: async () => []
    },
    logger: {
      logPath: "",
      info: async () => undefined,
      warn: async (event, _message, metadata) => {
        warnings.push({ event, metadata });
      },
      error: async () => undefined
    },
    now: () => fixedNow,
    env: {},
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl")
  });

  const body = response.result().body as { providers: Array<{ id: string; itemCount: number }> };
  assert.equal(response.result().statusCode, 200);
  assert.equal(body.providers.find((provider) => provider.id === "webdock-secondary")?.itemCount, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.some((warning) => warning.event === "infrastructure.webdock_account_health_audit_failed"), true);
});

test("Infrastructure inventory handler marks lifecycle store read failures as degraded", async () => {
  const response = responseRecorder();
  const warnings: Array<{ event: string; metadata?: Record<string, unknown> }> = [];

  await handleInfrastructureInventoryHttp({
    request: requestStub("/v1/infrastructure/inventory", {}),
    response: response as unknown as ServerResponse,
    auditLog: { async append() {} },
    webdockListServers: async () => [webdockAccount("secondary", "Webdock Secondary", ["running"])],
    accountLifecycleStore: {
      observe: async () => ({
        action: "none",
        previousHealthStatus: null,
        currentHealthStatus: "healthy",
        account: {
          accountKey: "webdock:secondary",
          providerId: "webdock",
          accountId: "secondary",
          accountLabel: "Webdock Secondary",
          lifecycleStatus: "active",
          healthStatus: "healthy",
          updatedAt: fixedNow.toISOString(),
          updatedBy: "gateway-api"
        }
      }),
      list: async () => {
        throw new Error("lifecycle JSON corrupt");
      }
    },
    logger: {
      logPath: "",
      info: async () => undefined,
      warn: async (event, _message, metadata) => {
        warnings.push({ event, metadata });
      },
      error: async () => undefined
    },
    now: () => fixedNow,
    env: {},
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl")
  });

  const body = response.result().body as {
    degraded: boolean;
    partialReasons: string[];
    providers: Array<{ id: string; itemCount: number }>;
  };
  assert.equal(response.result().statusCode, 200);
  assert.equal(body.degraded, true);
  assert.deepEqual(body.partialReasons, ["webdock_lifecycle_overlay_unavailable"]);
  assert.equal(body.providers.find((provider) => provider.id === "webdock-secondary")?.itemCount, 1);
  assert.equal(warnings.some((warning) => warning.event === "infrastructure.webdock_lifecycle_overlay_unavailable"), true);
  assert.equal(JSON.stringify(body).includes("lifecycle JSON corrupt"), false);
});

test("Infrastructure routes degrade corrupt lifecycle JSON without hiding Webdock inventory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-corrupt-lifecycle-"));
  const lifecyclePath = join(dir, "infrastructure-account-lifecycle.json");
  await writeFile(lifecyclePath, "{not-valid-json", "utf8");
  const lifecycleStore = new LocalFileInfrastructureAccountLifecycleStore(lifecyclePath);
  const warnings: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
  const logger = {
    logPath: "",
    info: async () => undefined,
    warn: async (event: string, _message: string, metadata?: Record<string, unknown>) => {
      warnings.push({ event, metadata });
    },
    error: async () => undefined
  };

  const inventoryResponse = responseRecorder();
  await handleInfrastructureInventoryHttp({
    request: requestStub("/v1/infrastructure/inventory", {}),
    response: inventoryResponse as unknown as ServerResponse,
    auditLog: { async append() {} },
    webdockListServers: async () => [webdockAccount("secondary", "Webdock Secondary", ["running"])],
    accountLifecycleStore: lifecycleStore,
    logger,
    now: () => fixedNow,
    env: {},
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl")
  });

  const inventoryBody = inventoryResponse.result().body as {
    degraded: boolean;
    partialReasons: string[];
    providers: Array<{ id: string; itemCount: number }>;
  };
  assert.equal(inventoryResponse.result().statusCode, 200);
  assert.equal(inventoryBody.degraded, true);
  assert.deepEqual(inventoryBody.partialReasons, ["webdock_lifecycle_overlay_unavailable"]);
  assert.equal(inventoryBody.providers.find((provider) => provider.id === "webdock-secondary")?.itemCount, 1);
  assert.equal(JSON.stringify(inventoryBody).includes("not-valid-json"), false);

  const healthResponse = responseRecorder();
  await handleInfrastructureAccountHealthHttp({
    request: requestStub("/v1/infrastructure/account-health", { "x-delivrix-token": "read-token" }),
    response: healthResponse as unknown as ServerResponse,
    readBoundaryToken: "read-token",
    buildInventory: async () => {
      const overlay = await readInfrastructureAccountLifecycleOverlay({
        accountLifecycleStore: lifecycleStore,
        logger,
        context: "test_account_health"
      });
      const inventory = await buildInfrastructureInventoryPayload({
        includeStaticProviders: false,
        webdockAccounts: [webdockAccount("secondary", "Webdock Secondary", ["running"])],
        accountLifecycleRecords: overlay.records,
        now: fixedNow
      });
      return overlay.partialReasons.length > 0
        ? { ...inventory, degraded: true, partialReasons: overlay.partialReasons }
        : inventory;
    },
    scratchHealth: async () => ({
      status: "ok",
      checkedAt: "2026-06-24T12:00:00.000Z"
    }),
    now: () => fixedNow
  });

  const healthBody = healthResponse.result().body as {
    partial: boolean;
    integrity: { status: string; reasons: string[] };
    partialReasons: string[];
    accountHealth: { accounts: Array<{ accountId: string; health: string }> };
  };
  assert.equal(healthResponse.result().statusCode, 200);
  assert.equal(healthBody.partial, true);
  assert.deepEqual(healthBody.partialReasons, ["webdock_lifecycle_overlay_unavailable"]);
  assert.deepEqual(healthBody.integrity, {
    status: "partial",
    reasons: ["webdock_lifecycle_overlay_unavailable"]
  });
  assert.deepEqual(healthBody.accountHealth.accounts.map((account) => [account.accountId, account.health]), [
    ["secondary", "healthy"]
  ]);
  assert.equal(warnings.some((warning) => warning.event === "infrastructure.webdock_lifecycle_overlay_unavailable"), true);
  assert.equal(JSON.stringify(healthBody).includes("not-valid-json"), false);
});

test("Infrastructure account health endpoint is read-token gated and sanitizes scratch failures", async () => {
  const denied = responseRecorder();
  let buildCalls = 0;
  await handleInfrastructureAccountHealthHttp({
    request: requestStub("/v1/infrastructure/account-health", {}),
    response: denied as unknown as ServerResponse,
    readBoundaryToken: "read-token",
    buildInventory: async () => {
      buildCalls += 1;
      return buildInfrastructureInventoryPayload({ includeStaticProviders: false, now: fixedNow });
    },
    scratchHealth: async () => {
      throw new Error("raw database secret should not leak");
    },
    now: () => fixedNow
  });

  assert.equal(denied.result().statusCode, 401);
  assert.equal(buildCalls, 0);

  const allowed = responseRecorder();
  await handleInfrastructureAccountHealthHttp({
    request: requestStub("/v1/infrastructure/account-health", { "x-delivrix-token": "read-token" }),
    response: allowed as unknown as ServerResponse,
    readBoundaryToken: "read-token",
    buildInventory: async () => {
      buildCalls += 1;
      return buildInfrastructureInventoryPayload({
        includeStaticProviders: false,
        webdockAccounts: [webdockAccount("secondary", "Webdock Secondary", [], {
          responseOk: false,
          httpStatus: 401,
          errorCode: "webdock_auth_401",
          failureKind: "unauthorized",
          errorMessage: "Webdock API returned 401 Unauthorized"
        })],
        now: fixedNow
      });
    },
    scratchHealth: async () => {
      throw new Error("raw database secret should not leak");
    },
    now: () => fixedNow
  });

  const body = allowed.result().body as {
    partial: boolean;
    partialReasons: string[];
    integrity: { status: string; reasons: string[] };
    accountHealth: { unhealthyCount: number };
    orphanReport: { uncertainBecauseAccountDown: unknown[] };
    scratchHealth: { status: string; reason: string; message?: string };
  };
  assert.equal(allowed.result().statusCode, 200);
  assert.equal(buildCalls, 1);
  assert.equal(body.partial, true);
  assert.deepEqual(body.partialReasons, ["scratch_health_down"]);
  assert.deepEqual(body.integrity, { status: "partial", reasons: ["scratch_health_down"] });
  assert.equal(body.accountHealth.unhealthyCount, 1);
  assert.equal(body.orphanReport.uncertainBecauseAccountDown.length, 1);
  assert.deepEqual(body.scratchHealth, {
    status: "down",
    reason: "scratch_health_failed"
  });
  assert.equal(JSON.stringify(body).includes("raw database secret"), false);
});

test("Infrastructure account health endpoint marks schema drift partial and redacts fulfilled scratch reasons", async () => {
  const response = responseRecorder();
  await handleInfrastructureAccountHealthHttp({
    request: requestStub("/v1/infrastructure/account-health", { "x-delivrix-token": "read-token" }),
    response: response as unknown as ServerResponse,
    readBoundaryToken: "read-token",
    buildInventory: async () => buildInfrastructureInventoryPayload({ includeStaticProviders: false, now: fixedNow }),
    scratchHealth: async () => ({
      status: "schema_drift",
      checkedAt: "2026-06-24T12:00:00.000Z",
      reason: "password=secret host=db.internal",
      missingColumns: ["plane"]
    }),
    now: () => fixedNow
  });

  const body = response.result().body as {
    partial: boolean;
    integrity: { status: string; reasons: string[] };
    scratchHealth: { status: string; reason: string; missingColumns: string[] };
  };
  assert.equal(response.result().statusCode, 200);
  assert.equal(body.partial, true);
  assert.deepEqual(body.integrity, { status: "partial", reasons: ["scratch_schema_drift"] });
  assert.deepEqual(body.scratchHealth, {
    status: "schema_drift",
    checkedAt: "2026-06-24T12:00:00.000Z",
    reason: "scratch_health_failed",
    missingColumns: ["plane"]
  });
  assert.equal(JSON.stringify(body).includes("password"), false);
  assert.equal(JSON.stringify(body).includes("host=db"), false);
});

test("Infrastructure inventory exposes IONOS Cloud DNS zones and record summaries", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: true,
    ionosDns: ionosDnsInventory({
      zones: [{
        id: "zone-1",
        name: "delivrix.io",
        enabled: true,
        state: "AVAILABLE",
        records: [
          {
            id: "record-a",
            name: "mail",
            type: "A",
            content: "203.0.113.10",
            ttl: 3600,
            enabled: true,
            state: "AVAILABLE"
          },
          {
            id: "record-txt",
            name: "_dmarc",
            type: "TXT",
            content: "v=DMARC1; p=reject; rua=mailto:ops@example.test",
            ttl: 3600,
            enabled: true,
            state: "AVAILABLE"
          }
        ]
      }]
    }),
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl"),
    env: {},
    now: fixedNow
  });

  const ionosProvider = payload.providers.find((provider) => provider.id === "ionos-cloud-dns");

  assert.equal(ionosProvider?.status, "active");
  assert.equal(ionosProvider?.itemCount, 1);
  assert.equal(ionosProvider?.fetchSourceKind, "live");
  assert.equal(ionosProvider?.items?.[0]?.displayName, "delivrix.io");
  assert.equal(ionosProvider?.items?.[0]?.detail?.recordCount, 2);
  assert.deepEqual(ionosProvider?.items?.[0]?.detail?.records, [
    {
      id: "record-a",
      name: "mail",
      type: "A",
      status: "active",
      state: "AVAILABLE",
      enabled: true,
      ttl: 3600,
      priority: null,
      contentPreview: "203.0.113.10"
    },
    {
      id: "record-txt",
      name: "_dmarc",
      type: "TXT",
      status: "active",
      state: "AVAILABLE",
      enabled: true,
      ttl: 3600,
      priority: null,
      contentPreview: "[redacted-txt:47]"
    }
  ]);
});

test("Infrastructure inventory marks IONOS Cloud DNS as error when live API rejects token", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: true,
    ionosDns: ionosDnsInventory({
      zones: [],
      responseOk: false,
      errorMessage: "IONOS DNS API returned 403 Forbidden"
    }),
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl"),
    env: {},
    now: fixedNow
  });

  const ionosProvider = payload.providers.find((provider) => provider.id === "ionos-cloud-dns");
  assert.equal(ionosProvider?.status, "error");
  assert.equal(ionosProvider?.errorReason, "IONOS DNS API returned 403 Forbidden");
  assert.equal(ionosProvider?.fetchSourceKind, "live");
});

test("Infrastructure inventory exposes IONOS Domains without contacts or auth codes", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: true,
    ionosDomains: ionosDomainsInventory({
      domains: [{
        id: "domain-1",
        name: "delivrix.io",
        type: "domain",
        contract: "123456",
        status: "ACTIVE",
        statusGroup: "OK",
        expiresAt: "2027-05-25",
        transferLock: true,
        autoRenew: true,
        privacyEnabled: true,
        dnssecEnabled: false,
        nameservers: [{
          name: "ns1.ionos.com",
          ipV4Addresses: ["203.0.113.53"]
        }]
      }]
    }),
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl"),
    env: {},
    now: fixedNow
  });

  const domainsProvider = payload.providers.find((provider) => provider.id === "ionos-domains");

  assert.equal(domainsProvider?.kind, "domain-registrar");
  assert.equal(domainsProvider?.status, "active");
  assert.equal(domainsProvider?.itemCount, 1);
  assert.equal(domainsProvider?.fetchSourceKind, "live");
  assert.equal(domainsProvider?.items?.[0]?.displayName, "delivrix.io");
  assert.deepEqual(domainsProvider?.items?.[0]?.detail, {
    idn: null,
    type: "domain",
    contract: "123456",
    status: "ACTIVE",
    statusGroup: "OK",
    provisioningStatus: null,
    pendingProvisioning: null,
    expiresAt: "2027-05-25",
    domainLock: null,
    transferLock: true,
    autoRenew: true,
    privacyEnabled: true,
    dnssecEnabled: false,
    nameservers: [{
      name: "ns1.ionos.com",
      ipV4AddressCount: 1,
      ipV6AddressCount: 0
    }]
  });
});

test("Infrastructure inventory marks IONOS Domains tenant mismatch as error", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: true,
    ionosDomains: ionosDomainsInventory({
      domains: [],
      responseOk: false,
      errorMessage: "IONOS Domains API returned 403 Forbidden"
    }),
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl"),
    env: {},
    now: fixedNow
  });

  const domainsProvider = payload.providers.find((provider) => provider.id === "ionos-domains");
  assert.equal(domainsProvider?.status, "error");
  assert.equal(domainsProvider?.errorReason, "IONOS Domains API returned 403 Forbidden");
  assert.equal(domainsProvider?.fetchSourceKind, "live");
});

test("Infrastructure inventory accepts live IONOS Domains without tenant for read-only inventory", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: true,
    ionosDomains: {
      domains: [{
        id: "domain-no-tenant",
        name: "delivrix.io",
        status: "ACTIVE",
        nameservers: []
      }],
      source: {
        kind: "live",
        apiBase: "https://api.hosting.ionos.com/domains/v1",
        fetchedAt: "2026-05-24T17:59:30.000Z",
        responseOk: true,
        tenantConfigured: false
      }
    },
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl"),
    env: { IONOS_DOMAINS_API_KEY: "public.secret" },
    now: fixedNow
  });

  const domainsProvider = payload.providers.find((provider) => provider.id === "ionos-domains");
  assert.equal(domainsProvider?.status, "active");
  assert.equal(domainsProvider?.itemCount, 1);
  assert.equal(domainsProvider?.fetchSourceKind, "live");
  assert.equal(domainsProvider?.errorReason, undefined);
});

test("Infrastructure inventory audit is explicit, privacy-preserving, and keeps hash chain valid", async () => {
  assert.equal(shouldAuditInfrastructureInventoryFetch({}), false);
  assert.equal(shouldAuditInfrastructureInventoryFetch({ "x-openclaw-skill-invocation": "panel" }), false);
  assert.equal(shouldAuditInfrastructureInventoryFetch({ "x-openclaw-skill-invocation": "delivrix-infra-inventory" }), true);

  const payload = await buildInfrastructureInventoryPayload({
    webdock: {
      servers: [{
        slug: "svc-private-01",
        name: "smtp-out-01",
        ipv4: "185.243.12.31",
        status: "running",
        location: "fi-hel-2"
      }],
      source: {
        kind: "mock",
        apiBase: "https://api.webdock.io/v1",
        accountId: "default",
        accountLabel: "Webdock",
        fetchedAt: "2026-05-24T17:59:30.000Z",
        responseOk: true
      }
    },
    awsBedrockSetupLogPath: join(tmpdir(), "missing-openclaw-bedrock-setup.jsonl"),
    env: {},
    now: fixedNow
  });

  const dir = await mkdtemp(join(tmpdir(), "delivrix-infra-audit-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));

  for (let i = 0; i < 3; i += 1) {
    await auditInfrastructureInventoryFetch(auditLog, payload);
  }

  const events = await auditLog.list();
  assert.equal(events.length, 3);
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    assert.equal(event.action, "oc.infrastructure.inventory.fetch");
    assert.equal(event.metadata.providerCount, 7);
    assert.equal(event.metadata.itemTotal, 1);
    assert.equal(event.prevHash, i === 0 ? "GENESIS" : events[i - 1].hash);
    assert.equal(event.hash, computeAuditHash(event as unknown as Record<string, unknown>, event.prevHash ?? "GENESIS"));
  }

  const metadataJson = JSON.stringify(events.map((event) => event.metadata));
  assert.equal(metadataJson.includes("185.243.12.31"), false);
  assert.equal(metadataJson.includes("smtp-out-01"), false);
  assert.equal(metadataJson.includes("svc-private-01"), false);
});

function requestStub(url: string, headers: Record<string, string>): IncomingMessage {
  return { url, headers, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
}

function responseRecorder(): {
  writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  end: (chunk?: string) => void;
  result: () => { statusCode: number; body: unknown };
} {
  let statusCode = 0;
  let rawBody = "";
  return {
    writeHead(status) {
      statusCode = status;
    },
    end(chunk) {
      rawBody = chunk ?? "";
    },
    result() {
      return {
        statusCode,
        body: rawBody ? JSON.parse(rawBody) : null
      };
    }
  };
}

function webdockAccount(
  accountId: string,
  accountLabel: string,
  statuses: string[],
  source?: Partial<WebdockInventoryResult["source"]>
) {
  return {
    accountId,
    accountLabel,
    result: {
      servers: statuses.map((status, index) => ({
        slug: `svc-${accountId}-${index + 1}`,
        name: `svc-${accountId}-${index + 1}`,
        ipv4: `185.243.12.${index + 31}`,
        status,
        location: "fi-hel-2",
        accountId,
        accountLabel
      })),
      source: {
        kind: "live" as const,
        apiBase: "https://api.webdock.io/v1",
        accountId,
        accountLabel,
        fetchedAt: "2026-05-24T17:59:30.000Z",
        responseOk: true,
        ...source
      }
    }
  };
}

function senderNode(id: string, overrides: Partial<SenderNode> = {}): SenderNode {
  return {
    id,
    label: id,
    provider: "webdock",
    status: "active",
    dailyLimit: 100,
    warmupDay: 1,
    ...overrides
  };
}

function vpsProvider(
  providerId: string,
  providerLabel: string,
  statuses: string[],
  source?: Partial<WebdockInventoryResult["source"]>
) {
  return {
    providerId,
    providerLabel,
    result: {
      servers: statuses.map((status, index) => ({
        slug: `${providerId}-${index + 1}`,
        name: `${providerId}-${index + 1}`,
        ipv4: `203.0.113.${index + 10}`,
        status,
        location: "us-east",
        accountId: providerId,
        accountLabel: providerLabel
      })),
      source: {
        kind: "live" as const,
        apiBase: `https://api.${providerId}.example.test`,
        accountId: providerId,
        accountLabel: providerLabel,
        fetchedAt: "2026-05-24T17:59:30.000Z",
        responseOk: true,
        ...source
      }
    }
  };
}

function ionosDnsInventory(input: {
  zones: IonosDnsInventoryResult["zones"];
  responseOk?: boolean;
  errorMessage?: string;
}): IonosDnsInventoryResult {
  return {
    zones: input.zones,
    source: {
      kind: "live",
      apiKind: "cloud-dns",
      apiBase: "https://dns.de-fra.ionos.com",
      fetchedAt: "2026-05-24T17:59:30.000Z",
      responseOk: input.responseOk ?? true,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {})
    }
  };
}

function awsRoute53DomainsInventory(input: {
  domains: AwsRoute53DomainsInventoryResult["domains"];
  responseOk?: boolean;
  errorMessage?: string;
}): AwsRoute53DomainsInventoryResult {
  return {
    domains: input.domains,
    source: {
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53domains.us-east-1.amazonaws.com",
      fetchedAt: "2026-05-24T17:59:30.000Z",
      responseOk: input.responseOk ?? true,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {})
    }
  };
}

function porkbunInventory(input: {
  domains: PorkbunInventoryResult["domains"];
  responseOk?: boolean;
  errorMessage?: string;
}): PorkbunInventoryResult {
  return {
    domains: input.domains,
    source: {
      kind: "live",
      apiBase: "https://api.porkbun.com/api/json/v3",
      fetchedAt: "2026-05-24T17:59:30.000Z",
      responseOk: input.responseOk ?? true,
      purchaseEnabled: false,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {})
    }
  };
}

function ionosDomainsInventory(input: {
  domains: IonosDomainsInventoryResult["domains"];
  responseOk?: boolean;
  errorMessage?: string;
}): IonosDomainsInventoryResult {
  return {
    domains: input.domains,
    source: {
      kind: "live",
      apiBase: "https://api.hosting.ionos.com/domains/v1",
      fetchedAt: "2026-05-24T17:59:30.000Z",
      responseOk: input.responseOk ?? true,
      tenantConfigured: true,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {})
    }
  };
}
