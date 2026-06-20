import assert from "node:assert/strict";
import test from "node:test";
import type { AwsRoute53DnsAdapter } from "./aws-route53-dns-adapter.ts";
import {
  createIonosDnsProviderFromEnv,
  createRoute53DnsProviderFromEnv,
  IonosDnsProvider,
  Route53DnsProvider,
  type DnsRecordSpec
} from "./dns-provider.ts";
import type { IonosDnsActuator } from "./ionos-dns-actuator.ts";

test("Route53DnsProvider adapts plural records to Route53 singular upserts", async () => {
  const upserts: unknown[] = [];
  const adapter = {
    isLive: () => true,
    isWriteEnabled: () => true,
    createHostedZone: async (domain: string) => ({
      zoneId: `zone-${domain}`,
      nameServers: ["ns-1.awsdns.test"]
    }),
    upsertRecord: async (zoneId: string, record: unknown) => {
      upserts.push({ zoneId, record });
      return { changeId: `change-${upserts.length}` };
    },
    listResourceRecordSets: async () => [{
      name: "mail.delivrix.test.",
      type: "A",
      ttl: 300,
      values: ["203.0.113.10"]
    }]
  } as unknown as AwsRoute53DnsAdapter;
  const provider = new Route53DnsProvider(adapter);

  const zone = await provider.ensureZone("delivrix.test");
  const upsert = await provider.upsertRecords(zone.zoneId, [{
    name: "delivrix.test.",
    type: "MX",
    ttl: 300,
    prio: 10,
    values: ["mail.delivrix.test."]
  }]);
  const records = await provider.listRecords(zone.zoneId);

  assert.equal(provider.providerId, "route53");
  assert.equal(provider.isLive(), true);
  assert.equal(provider.isWriteEnabled(), true);
  assert.deepEqual(zone, { zoneId: "zone-delivrix.test", nameServers: ["ns-1.awsdns.test"] });
  assert.deepEqual(upsert, { changeIds: ["change-1"] });
  assert.deepEqual(upserts, [{
    zoneId: "zone-delivrix.test",
    record: {
      name: "delivrix.test.",
      type: "MX",
      ttl: 300,
      values: ["10 mail.delivrix.test."]
    }
  }]);
  assert.deepEqual(records, [{
    name: "mail.delivrix.test.",
    type: "A",
    ttl: 300,
    values: ["203.0.113.10"]
  }]);
});

test("IonosDnsProvider adapts IONOS actuator shape to neutral DNS provider shape", async () => {
  const upserts: Array<{ zoneId: string; records: unknown[] }> = [];
  const adapter = {
    isLive: () => true,
    isWriteEnabled: () => true,
    createZone: async (zoneName: string) => ({
      zoneId: `ionos-${zoneName}`,
      nameservers: ["ns-1.ionos.test"]
    }),
    upsertRecords: async (zoneId: string, records: unknown[]) => {
      upserts.push({ zoneId, records });
      return { rrsetIds: ["rrset-1"], idempotent: false };
    },
    listRecords: async () => [{
      id: "record-1",
      name: "delivrix.test",
      type: "TXT",
      content: "v=spf1 -all",
      ttl: 300
    }]
  } as unknown as IonosDnsActuator;
  const provider = new IonosDnsProvider(adapter);
  const records: DnsRecordSpec[] = [{
    name: "delivrix.test",
    type: "TXT",
    ttl: 300,
    values: ["v=spf1 -all", "ignored-by-ionos-wrapper"]
  }];

  const zone = await provider.ensureZone("delivrix.test");
  const upsert = await provider.upsertRecords(zone.zoneId, records);
  const listed = await provider.listRecords(zone.zoneId);

  assert.equal(provider.providerId, "ionos");
  assert.deepEqual(zone, { zoneId: "ionos-delivrix.test", nameServers: ["ns-1.ionos.test"] });
  assert.deepEqual(upsert, { changeIds: ["rrset-1"], idempotent: false });
  assert.deepEqual(upserts, [{
    zoneId: "ionos-delivrix.test",
    records: [{
      name: "delivrix.test",
      type: "TXT",
      content: "v=spf1 -all",
      ttl: 300
    }]
  }]);
  assert.deepEqual(listed, [{
    name: "delivrix.test",
    type: "TXT",
    ttl: 300,
    values: ["v=spf1 -all"]
  }]);
});

test("DNS provider factories only register providers with credentials", () => {
  assert.deepEqual(createRoute53DnsProviderFromEnv({}), []);
  assert.deepEqual(createIonosDnsProviderFromEnv({}), []);

  const route53 = createRoute53DnsProviderFromEnv({
    AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret"
  });
  const ionos = createIonosDnsProviderFromEnv({
    IONOS_API_TOKEN: "ionos-token",
    IONOS_DNS_ENABLE_WRITES: "true"
  });

  assert.equal(route53.length, 1);
  assert.equal(route53[0].id, "route53");
  assert.equal(route53[0].adapter.providerId, "route53");
  assert.equal(ionos.length, 1);
  assert.equal(ionos[0].id, "ionos");
  assert.equal(ionos[0].adapter.providerId, "ionos");
  assert.equal(ionos[0].adapter.isWriteEnabled(), true);
});
