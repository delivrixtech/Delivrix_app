import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import type {
  IonosDnsInventoryResult,
  IonosDomainsInventoryResult,
  WebdockInventoryResult
} from "../../../../packages/adapters/src/index.ts";
import { computeAuditHash } from "../audit/hash-chain.ts";
import {
  auditInfrastructureInventoryFetch,
  buildInfrastructureInventoryPayload,
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

  assert.equal(payload.providers.length, 5);
  assert.deepEqual(payload.providers.map((provider) => [provider.id, provider.status]), [
    ["webdock-default", "active"],
    ["aws-bedrock-us-east-1", "active"],
    ["ionos-cloud-dns", "error"],
    ["ionos-domains", "planned"],
    ["physical-medellin", "planned"]
  ]);
  assert.equal(payload.providers[0].fetchSourceKind, "live");
  assert.equal(payload.providers[0].itemCount, 1);
  assert.equal(payload.providers[1].items?.[0]?.id, "us.anthropic.claude-sonnet-4-6");
  assert.equal(payload.providers[2].errorReason, "adapter_pending");
  assert.equal(payload.providers[3].errorReason, "creds_not_configured");
});

test("Infrastructure inventory exposes three Webdock accounts as distinct providers", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [
      webdockAccount("primary", "Webdock Primary", ["running", "stopped"]),
      webdockAccount("secondary", "Webdock Secondary", ["running"]),
      webdockAccount("tertiary", "Webdock Tertiary", ["running", "running", "stopped"])
    ],
    now: fixedNow
  });

  assert.deepEqual(payload.providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    status: provider.status,
    itemCount: provider.itemCount
  })), [
    {
      id: "webdock-primary",
      displayName: "Webdock Primary",
      status: "active",
      itemCount: 2
    },
    {
      id: "webdock-secondary",
      displayName: "Webdock Secondary",
      status: "active",
      itemCount: 1
    },
    {
      id: "webdock-tertiary",
      displayName: "Webdock Tertiary",
      status: "active",
      itemCount: 3
    }
  ]);
  assert.equal(payload.providers[0].items?.[0]?.detail?.accountId, "primary");
  assert.equal(payload.providers[1].items?.[0]?.detail?.accountLabel, "Webdock Secondary");
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

test("Infrastructure inventory marks a failed Webdock account without hiding healthy accounts", async () => {
  const payload = await buildInfrastructureInventoryPayload({
    includeStaticProviders: false,
    webdockAccounts: [
      webdockAccount("primary", "Webdock Primary", ["running"]),
      webdockAccount("secondary", "Webdock Secondary", [], {
        responseOk: false,
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
    assert.equal(event.metadata.providerCount, 5);
    assert.equal(event.metadata.itemTotal, 1);
    assert.equal(event.prevHash, i === 0 ? "GENESIS" : events[i - 1].hash);
    assert.equal(event.hash, computeAuditHash(event as unknown as Record<string, unknown>, event.prevHash ?? "GENESIS"));
  }

  const metadataJson = JSON.stringify(events.map((event) => event.metadata));
  assert.equal(metadataJson.includes("185.243.12.31"), false);
  assert.equal(metadataJson.includes("smtp-out-01"), false);
  assert.equal(metadataJson.includes("svc-private-01"), false);
});

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
