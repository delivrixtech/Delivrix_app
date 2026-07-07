import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createNamecheapAdaptersFromEnv,
  NamecheapDomainsAdapter,
  parseNamecheapOwnedDomains
} from "./namecheap-domains-adapter.ts";

const LIVE_OPTIONS = {
  apiUser: "delivrix",
  apiKey: "test-key",
  clientIp: "10.0.0.1"
};

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

const CHECK_OK_XML = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.check">
    <DomainCheckResult Domain="delivrixmail.com" Available="true" IsPremiumName="false"/>
  </CommandResponse>
</ApiResponse>`;

const GETLIST_XML = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain ID="1" Name="delivrix.com" Created="04/22/2026" Expires="04/22/2027" IsExpired="false" AutoRenew="true" WhoisGuard="ENABLED"/>
      <Domain ID="2" Name="delivrixsend.net" Created="05/01/2026" Expires="05/01/2027" IsExpired="false" AutoRenew="false" WhoisGuard="NOTPRESENT"/>
    </DomainGetListResult>
  </CommandResponse>
</ApiResponse>`;

const ERROR_XML = `<?xml version="1.0"?>
<ApiResponse Status="ERROR">
  <Errors><Error Number="1011102">API Key is invalid or API access has not been enabled</Error></Errors>
</ApiResponse>`;

test("checkAvailability parses a live availability response", async () => {
  let requestedUrl = "";
  const adapter = new NamecheapDomainsAdapter({
    ...LIVE_OPTIONS,
    env: {},
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return xmlResponse(CHECK_OK_XML);
    }
  });

  const candidate = await adapter.checkAvailability("delivrixmail.com");
  assert.equal(candidate.availability, "AVAILABLE");
  assert.equal(candidate.canRegister, true);
  assert.equal(candidate.premium, false);
  assert.ok(requestedUrl.includes("Command=namecheap.domains.check"));
  assert.ok(requestedUrl.includes("ClientIp=10.0.0.1"));
});

test("checkAvailability without credentials returns mock candidate and never calls the API", async () => {
  let calls = 0;
  const adapter = new NamecheapDomainsAdapter({
    env: {},
    fetchImpl: async () => {
      calls += 1;
      return xmlResponse(CHECK_OK_XML);
    }
  });

  const candidate = await adapter.checkAvailability("delivrixmail.com");
  assert.equal(candidate.availability, "DONT_KNOW");
  assert.equal(calls, 0);
});

test("listInventory parses domains and reports live source with account metadata", async () => {
  const adapter = new NamecheapDomainsAdapter({
    ...LIVE_OPTIONS,
    accountId: "namecheap-1",
    accountLabel: "Namecheap Principal",
    env: {},
    fetchImpl: async () => xmlResponse(GETLIST_XML)
  });

  const inventory = await adapter.listInventory();
  assert.equal(inventory.accountId, "namecheap-1");
  assert.equal(inventory.accountLabel, "Namecheap Principal");
  assert.equal(inventory.domains.length, 2);
  assert.equal(inventory.domains[0].domainName, "delivrix.com");
  assert.equal(inventory.domains[0].whoisPrivacy, true);
  assert.equal(inventory.domains[1].whoisPrivacy, undefined);
  assert.equal(inventory.source.kind, "live");
  assert.equal(inventory.source.responseOk, true);
});

test("listInventory degrades to empty result with error metadata when the API errors", async () => {
  const adapter = new NamecheapDomainsAdapter({
    ...LIVE_OPTIONS,
    env: {},
    fetchImpl: async () => xmlResponse(ERROR_XML)
  });

  const inventory = await adapter.listInventory();
  assert.equal(inventory.domains.length, 0);
  assert.equal(inventory.source.responseOk, false);
  assert.ok(inventory.source.errorMessage?.includes("1011102"));
});

test("registerDomain is blocked by default (purchase flag off) without touching the API", async () => {
  let calls = 0;
  const adapter = new NamecheapDomainsAdapter({
    ...LIVE_OPTIONS,
    env: {},
    fetchImpl: async () => {
      calls += 1;
      return xmlResponse(CHECK_OK_XML);
    }
  });

  const result = await adapter.registerDomain({ domainName: "delivrixmail.com" });
  assert.equal(result.status, "blocked");
  assert.equal(result.blockedReason, "NAMECHEAP_ENABLE_PURCHASE_not_enabled");
  assert.equal(calls, 0);
});

test("registerDomain executes when the flag is enabled", async () => {
  const CREATE_XML = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.create">
    <DomainCreateResult Domain="delivrixmail.com" Registered="true" ChargedAmount="9.06" TransactionID="tx-123"/>
  </CommandResponse>
</ApiResponse>`;
  const adapter = new NamecheapDomainsAdapter({
    ...LIVE_OPTIONS,
    env: { NAMECHEAP_ENABLE_PURCHASE: "true" },
    fetchImpl: async () => xmlResponse(CREATE_XML)
  });

  const result = await adapter.registerDomain({ domainName: "delivrixmail.com" });
  assert.equal(result.status, "registered");
  assert.equal(result.transactionId, "tx-123");
  assert.equal(result.chargedAmountUsd, 9.06);
});

test("getHosts parses the BasicDNS host records and IsUsingOurDNS", async () => {
  const GETHOSTS_XML = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.dns.getHosts">
    <DomainDNSGetHostsResult Domain="corpfiling-ops.com" IsUsingOurDNS="true">
      <host Name="@" Type="A" Address="1.2.3.4" MXPref="10" TTL="1800"/>
      <host Name="@" Type="TXT" Address="v=spf1 ip4:1.2.3.4 -all" MXPref="10" TTL="1800"/>
      <host Name="@" Type="MX" Address="smtp.corpfiling-ops.com." MXPref="10" TTL="1800"/>
    </DomainDNSGetHostsResult>
  </CommandResponse>
</ApiResponse>`;
  const adapter = new NamecheapDomainsAdapter({ ...LIVE_OPTIONS, env: {}, fetchImpl: async () => xmlResponse(GETHOSTS_XML) });
  const result = await adapter.getHosts("corpfiling-ops.com");
  assert.equal(result.isUsingOurDns, true);
  assert.equal(result.hosts.length, 3);
  assert.deepEqual(result.hosts[0], { hostName: "@", recordType: "A", address: "1.2.3.4", ttl: 1800 });
  assert.equal(result.hosts[2].recordType, "MX");
  assert.equal(result.hosts[2].mxPref, 10);
});

test("setHosts posts the full record set with indexed params, MX pref and EmailType", async () => {
  let requestedUrl = "";
  const SETHOSTS_XML = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.dns.setHosts">
    <DomainDNSSetHostsResult Domain="corpfiling-ops.com" IsSuccess="true"/>
  </CommandResponse>
</ApiResponse>`;
  const adapter = new NamecheapDomainsAdapter({
    ...LIVE_OPTIONS,
    accountId: "namecheap-1",
    env: {},
    fetchImpl: async (url) => { requestedUrl = String(url); return xmlResponse(SETHOSTS_XML); }
  });

  const result = await adapter.setHosts("corpfiling-ops.com", [
    { hostName: "smtp", recordType: "A", address: "1.2.3.4" },
    { hostName: "@", recordType: "MX", address: "smtp.corpfiling-ops.com.", mxPref: 10 }
  ]);
  assert.equal(result.updated, true);
  assert.equal(result.accountId, "namecheap-1");
  assert.ok(requestedUrl.includes("Command=namecheap.domains.dns.setHosts"));
  assert.ok(requestedUrl.includes("HostName1=smtp"));
  assert.ok(requestedUrl.includes("RecordType1=A"));
  assert.ok(requestedUrl.includes("Address1=1.2.3.4"));
  assert.ok(requestedUrl.includes("HostName2=%40"));
  assert.ok(requestedUrl.includes("MXPref2=10"));
  assert.ok(requestedUrl.includes("EmailType=MX"));
});

test("setHosts fails closed without credentials and with an empty record set", async () => {
  let calls = 0;
  const noCreds = new NamecheapDomainsAdapter({ env: {}, fetchImpl: async () => { calls += 1; return xmlResponse(""); } });
  await assert.rejects(noCreds.setHosts("corpfiling-ops.com", [{ hostName: "@", recordType: "A", address: "1.2.3.4" }]), /namecheap_credentials_missing/);

  const live = new NamecheapDomainsAdapter({ ...LIVE_OPTIONS, env: {}, fetchImpl: async () => { calls += 1; return xmlResponse(""); } });
  await assert.rejects(live.setHosts("corpfiling-ops.com", []), /namecheap_hosts_empty/);
  assert.equal(calls, 0);
});

test("setDefaultNameservers resets the domain to Namecheap BasicDNS", async () => {
  let requestedUrl = "";
  const SETDEFAULT_XML = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.dns.setDefault">
    <DomainDNSSetDefaultResult Domain="corpfiling-ops.com" Updated="true"/>
  </CommandResponse>
</ApiResponse>`;
  const adapter = new NamecheapDomainsAdapter({ ...LIVE_OPTIONS, env: {}, fetchImpl: async (url) => { requestedUrl = String(url); return xmlResponse(SETDEFAULT_XML); } });
  const result = await adapter.setDefaultNameservers("corpfiling-ops.com");
  assert.equal(result.updated, true);
  assert.ok(requestedUrl.includes("Command=namecheap.domains.dns.setDefault"));
});

test("createNamecheapAdaptersFromEnv builds one entry per indexed account and tolerates holes", () => {
  const entries = createNamecheapAdaptersFromEnv({
    NAMECHEAP_ACCOUNT_1_API_USER: "ops",
    NAMECHEAP_ACCOUNT_1_API_KEY: "key-1",
    NAMECHEAP_ACCOUNT_1_CLIENT_IP: "10.0.0.1",
    NAMECHEAP_ACCOUNT_1_LABEL: "Namecheap Principal",
    NAMECHEAP_ACCOUNT_3_API_USER: "backup",
    NAMECHEAP_ACCOUNT_3_API_KEY: "key-3",
    NAMECHEAP_ACCOUNT_3_STATUS: "paused"
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "namecheap-1");
  assert.equal(entries[0].label, "Namecheap Principal");
  assert.equal(entries[0].adapter.isLive(), true);
  assert.equal(entries[1].id, "namecheap-3");
  assert.equal(entries[1].adapter.accountStatus, "paused");
  assert.equal(entries[1].adapter.isLive(), false);
});

test("createNamecheapAdaptersFromEnv excludes deprecated accounts and returns [] without accounts", () => {
  assert.deepEqual(createNamecheapAdaptersFromEnv({}), []);
  const entries = createNamecheapAdaptersFromEnv({
    NAMECHEAP_ACCOUNT_1_API_USER: "old",
    NAMECHEAP_ACCOUNT_1_API_KEY: "key",
    NAMECHEAP_ACCOUNT_1_STATUS: "deprecated"
  });
  assert.deepEqual(entries, []);
});

test("parseNamecheapOwnedDomains ignores malformed entries", () => {
  const domains = parseNamecheapOwnedDomains(`<Domain ID="9"/><Domain Name="ok.com" IsExpired="true"/>`);
  assert.equal(domains.length, 1);
  assert.equal(domains[0].domainName, "ok.com");
  assert.equal(domains[0].status, "expired");
});
