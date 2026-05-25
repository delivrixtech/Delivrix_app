import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import type { WebdockInventoryResult } from "../../../../packages/adapters/src/index.ts";
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

  assert.equal(payload.providers.length, 4);
  assert.deepEqual(payload.providers.map((provider) => [provider.id, provider.status]), [
    ["webdock-default", "active"],
    ["aws-bedrock-us-east-1", "active"],
    ["ionos-cloud-dns", "error"],
    ["physical-medellin", "planned"]
  ]);
  assert.equal(payload.providers[0].fetchSourceKind, "live");
  assert.equal(payload.providers[0].itemCount, 1);
  assert.equal(payload.providers[1].items?.[0]?.id, "us.anthropic.claude-sonnet-4-6");
  assert.equal(payload.providers[2].errorReason, "adapter_pending");
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
    assert.equal(event.metadata.providerCount, 4);
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
