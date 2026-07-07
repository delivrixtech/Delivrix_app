import assert from "node:assert/strict";
import test from "node:test";
import type { AwsRoute53DnsAdapter } from "./aws-route53-dns-adapter.ts";
import {
  createIonosDnsProviderFromEnv,
  createNamecheapDnsProviderFromEnv,
  createRoute53DnsProviderFromEnv,
  IonosDnsProvider,
  NamecheapDnsProvider,
  Route53DnsProvider,
  type DnsRecordSpec
} from "./dns-provider.ts";
import type { IonosDnsActuator } from "./ionos-dns-actuator.ts";
import { NamecheapDomainsAdapter } from "./namecheap-domains-adapter.ts";

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

test("Route53DnsProvider rejects conflicting MX value priority when prio is explicit", async () => {
  const adapter = {
    isLive: () => true,
    isWriteEnabled: () => true,
    upsertRecord: async () => {
      throw new Error("upsertRecord should not be called for invalid MX priority");
    }
  } as unknown as AwsRoute53DnsAdapter;
  const provider = new Route53DnsProvider(adapter);

  await assert.rejects(
    () => provider.upsertRecords("zone-delivrix.test", [{
      name: "delivrix.test.",
      type: "MX",
      prio: 10,
      values: ["5 mail.delivrix.test."]
    }]),
    /MX value at index 0 already includes priority 5; expected 10/
  );
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

test("IonosDnsProvider validates the whole batch before calling the actuator", async () => {
  const upserts: unknown[] = [];
  const adapter = {
    isLive: () => true,
    isWriteEnabled: () => true,
    upsertRecords: async (_zoneId: string, records: unknown[]) => {
      upserts.push(records);
      return { rrsetIds: ["rrset-1"], idempotent: false };
    }
  } as unknown as IonosDnsActuator;
  const provider = new IonosDnsProvider(adapter);

  await assert.rejects(
    () => provider.upsertRecords("ionos-zone", [
      { name: "valid.delivrix.test", type: "TXT", values: ["ok"] },
      { name: "empty.delivrix.test", type: "TXT", values: [] },
      { name: "also-valid.delivrix.test", type: "A", values: ["203.0.113.10"] }
    ]),
    /DNS record empty\.delivrix\.test TXT at index 1 must include at least one value/
  );
  assert.equal(upserts.length, 0);
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

function namecheapDnsAdapter(existingHostsXml: string, captured: { url?: string }): NamecheapDomainsAdapter {
  return new NamecheapDomainsAdapter({
    apiUser: "ops",
    apiKey: "key",
    clientIp: "10.0.0.1",
    dnsWriteEnabled: true,
    env: {},
    fetchImpl: async (url) => {
      const u = String(url);
      const body =
        u.includes("getHosts") ? existingHostsXml
        : u.includes("setHosts") ? ((captured.url = u), `<ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.dns.setHosts"><DomainDNSSetHostsResult Domain="corpfiling-ops.com" IsSuccess="true"/></CommandResponse></ApiResponse>`)
        : `<ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.dns.setDefault"><DomainDNSSetDefaultResult Domain="corpfiling-ops.com" Updated="true"/></CommandResponse></ApiResponse>`;
      return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
    }
  });
}

const NAMECHEAP_SMTP_SPECS: DnsRecordSpec[] = [
  { name: "mail.corpfiling-ops.com", type: "A", ttl: 300, values: ["203.0.113.20"] },
  { name: "corpfiling-ops.com", type: "MX", ttl: 300, values: ["mail.corpfiling-ops.com."], prio: 10 },
  { name: "corpfiling-ops.com", type: "TXT", ttl: 300, values: ["v=spf1 ip4:203.0.113.20 -all"] },
  { name: "default._domainkey.corpfiling-ops.com", type: "TXT", ttl: 300, values: ["v=DKIM1; k=rsa; p=MIIBI"] },
  { name: "_dmarc.corpfiling-ops.com", type: "TXT", ttl: 300, values: ["v=DMARC1; p=quarantine"] }
];

test("NamecheapDnsProvider merges SMTP records, preserves unrelated hosts, and converts FQDN->relative", async () => {
  const existing = `<ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.dns.getHosts">
    <DomainDNSGetHostsResult Domain="corpfiling-ops.com" IsUsingOurDNS="true">
      <host Name="@" Type="A" Address="1.1.1.1" TTL="1800"/>
      <host Name="@" Type="TXT" Address="v=spf1 -all" TTL="1800"/>
      <host Name="www" Type="CNAME" Address="parkingpage.namecheap.com." TTL="1800"/>
    </DomainDNSGetHostsResult></CommandResponse></ApiResponse>`;
  const captured: { url?: string } = {};
  const provider = new NamecheapDnsProvider(namecheapDnsAdapter(existing, captured));

  const result = await provider.upsertRecords("corpfiling-ops.com", NAMECHEAP_SMTP_SPECS);
  assert.equal(result.idempotent, false);
  const u = captured.url ?? "";
  // Unrelated hosts are preserved (independent-provider semantics); the apex SPF (same TXT class)
  // is replaced by the new SPF; the apex A (different host than 'mail') is unrelated and kept.
  assert.ok(u.includes("www"), "preserves unrelated www CNAME");
  assert.ok(u.includes("1.1.1.1"), "preserves unrelated apex A (host @, not 'mail')");
  assert.ok(u.includes("mail"), "writes relative host 'mail' (not FQDN)");
  assert.ok(u.includes("_dmarc"), "writes DMARC host");
  assert.ok(u.includes("default._domainkey"), "writes DKIM host");
  assert.ok(u.includes("EmailType=MX"), "sets EmailType=MX for MX record");
  assert.ok(u.includes("ip4%3A203.0.113.20"), "writes the new SPF value");
  assert.ok(!/Address\d+=v%3Dspf1\+-all/.test(u), "old bare apex SPF replaced (same TXT class)");
});

test("NamecheapDnsProvider.ensureZone resets to BasicDNS and reports Namecheap authoritative NS", async () => {
  const provider = new NamecheapDnsProvider(namecheapDnsAdapter("<ApiResponse Status=\"OK\"></ApiResponse>", {}));
  const zone = await provider.ensureZone("corpfiling-ops.com");
  assert.equal(zone.zoneId, "corpfiling-ops.com");
  assert.ok(zone.nameServers[0].includes("registrar-servers.com"));
});

test("createNamecheapDnsProviderFromEnv yields one entry per account addressed by id", () => {
  const entries = createNamecheapDnsProviderFromEnv({
    NAMECHEAP_ACCOUNT_1_API_USER: "ops",
    NAMECHEAP_ACCOUNT_1_API_KEY: "key-1",
    NAMECHEAP_ACCOUNT_1_CLIENT_IP: "10.0.0.1",
    NAMECHEAP_ACCOUNT_1_LABEL: "Namecheap infravps"
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "namecheap-1");
  assert.equal(entries[0].label, "Namecheap infravps");
  assert.equal(entries[0].adapter.providerId, "namecheap");
});
