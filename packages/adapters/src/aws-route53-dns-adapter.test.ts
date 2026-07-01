import assert from "node:assert/strict";
import test from "node:test";
import {
  AwsRoute53DnsAdapter,
  signAwsRestRequest
} from "./aws-route53-dns-adapter.ts";

const fixedNow = new Date("2026-05-27T12:00:00.000Z");

test("AwsRoute53DnsAdapter creates hosted zone with SigV4 XML request", async () => {
  const calls: Array<{ url: string; headers: HeadersInit | undefined; body: string | undefined }> = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: true,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        headers: init?.headers,
        body: init?.body?.toString()
      });
      return xmlResponse([
        "<CreateHostedZoneResponse>",
        "<HostedZone><Id>/hostedzone/Z123456789</Id></HostedZone>",
        "<DelegationSet>",
        "<NameServers>",
        "<NameServer>ns-1.awsdns.com</NameServer>",
        "<NameServer>ns-2.awsdns.net</NameServer>",
        "</NameServers>",
        "</DelegationSet>",
        "</CreateHostedZoneResponse>"
      ].join(""));
    }) as typeof fetch,
    now: () => fixedNow
  });

  const result = await adapter.createHostedZone("Delivrix-Mail.COM.");

  assert.equal(calls[0].url, "https://route53.amazonaws.com/2013-04-01/hostedzone");
  assert.match((calls[0].headers as Record<string, string>).authorization, /^AWS4-HMAC-SHA256 /);
  assert.match(calls[0].body ?? "", /<Name>delivrix-mail.com\.<\/Name>/);
  assert.equal(result.zoneId, "Z123456789");
  assert.deepEqual(result.nameServers, ["ns-1.awsdns.com", "ns-2.awsdns.net"]);
});

test("AwsRoute53DnsAdapter upserts records using ChangeResourceRecordSets", async () => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: true,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url.toString(), body: init?.body?.toString() });
      return xmlResponse("<ChangeResourceRecordSetsResponse><ChangeInfo><Id>/change/C123</Id></ChangeInfo></ChangeResourceRecordSetsResponse>");
    }) as typeof fetch,
    now: () => fixedNow
  });

  const result = await adapter.upsertRecord("Z123456789", {
    name: "default._domainkey.delivrix-mail.com",
    type: "TXT",
    ttl: 300,
    values: ["v=DKIM1; k=rsa; p=abc123"]
  });

  assert.equal(calls[0].url, "https://route53.amazonaws.com/2013-04-01/hostedzone/Z123456789/rrset");
  assert.match(calls[0].body ?? "", /<Action>UPSERT<\/Action>/);
  assert.match(calls[0].body ?? "", /<Name>default\._domainkey\.delivrix-mail\.com\.<\/Name>/);
  assert.match(calls[0].body ?? "", /<Value>&quot;v=DKIM1; k=rsa; p=abc123&quot;<\/Value>/);
  assert.equal(result.changeId, "C123");
});

test("AwsRoute53DnsAdapter chunks long TXT values for Route53", async () => {
  const calls: Array<{ body: string | undefined }> = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: true,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: init?.body?.toString() });
      return xmlResponse("<ChangeResourceRecordSetsResponse><ChangeInfo><Id>/change/C123</Id></ChangeInfo></ChangeResourceRecordSetsResponse>");
    }) as typeof fetch,
    now: () => fixedNow
  });

  await adapter.upsertRecord("Z123456789", {
    name: "default._domainkey.delivrix-mail.com",
    type: "TXT",
    ttl: 300,
    values: [`v=DKIM1; k=rsa; p=${"A".repeat(380)}`]
  });

  const body = calls[0].body ?? "";
  assert.match(body, /<Value>&quot;v=DKIM1; k=rsa; p=A+/);
  assert.match(body, /&quot; &quot;A+&quot;<\/Value>/);
});

test("AwsRoute53DnsAdapter deletes records before deleting hosted zone", async () => {
  const calls: Array<{ method: string | undefined; url: string; body: string | undefined }> = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: true,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        url: url.toString(),
        body: init?.body?.toString()
      });
      if (init?.method === "GET") {
        return xmlResponse([
          "<ListResourceRecordSetsResponse>",
          "<ResourceRecordSets>",
          "<ResourceRecordSet><Name>delivrix-mail.com.</Name><Type>NS</Type><TTL>172800</TTL><ResourceRecords><ResourceRecord><Value>ns-1.awsdns.com.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>",
          "<ResourceRecordSet><Name>delivrix-mail.com.</Name><Type>SOA</Type><TTL>900</TTL><ResourceRecords><ResourceRecord><Value>ns-1.awsdns.com. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>",
          "<ResourceRecordSet><Name>_delivrix-smoke.delivrix-mail.com.</Name><Type>TXT</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>&quot;codex-smoke=1&quot;</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>",
          "</ResourceRecordSets>",
          "</ListResourceRecordSetsResponse>"
        ].join(""));
      }
      if (init?.method === "POST") {
        return xmlResponse("<ChangeResourceRecordSetsResponse><ChangeInfo><Id>/change/CDELETE</Id></ChangeInfo></ChangeResourceRecordSetsResponse>");
      }
      return xmlResponse("<DeleteHostedZoneResponse><ChangeInfo><Id>/change/CZONE</Id></ChangeInfo></DeleteHostedZoneResponse>");
    }) as typeof fetch,
    now: () => fixedNow
  });

  const result = await adapter.deleteHostedZone("Z123456789");

  assert.equal(calls[0].url, "https://route53.amazonaws.com/2013-04-01/hostedzone/Z123456789/rrset?maxitems=100");
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].body ?? "", /<Action>DELETE<\/Action>/);
  assert.match(calls[1].body ?? "", /<Name>_delivrix-smoke\.delivrix-mail\.com\.<\/Name>/);
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].url, "https://route53.amazonaws.com/2013-04-01/hostedzone/Z123456789");
  assert.equal(result.zoneId, "Z123456789");
  assert.equal(result.deletedRecords.length, 1);
  assert.equal(result.deletedRecords[0].changeId, "CDELETE");
  assert.equal(result.deleteChangeId, "CZONE");
});

test("AwsRoute53DnsAdapter lists resource records across Route53 cursors", async () => {
  const calls: string[] = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: true,
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(url.toString());
      if (calls.length === 1) {
        return xmlResponse([
          "<ListResourceRecordSetsResponse>",
          "<ResourceRecordSets>",
          "<ResourceRecordSet><Name>a.delivrix-mail.com.</Name><Type>A</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>192.0.2.10</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>",
          "</ResourceRecordSets>",
          "<IsTruncated>true</IsTruncated>",
          "<NextRecordName>txt.delivrix-mail.com.</NextRecordName>",
          "<NextRecordType>TXT</NextRecordType>",
          "<NextRecordIdentifier>weighted-a</NextRecordIdentifier>",
          "</ListResourceRecordSetsResponse>"
        ].join(""));
      }
      return xmlResponse([
        "<ListResourceRecordSetsResponse>",
        "<ResourceRecordSets>",
        "<ResourceRecordSet><Name>txt.delivrix-mail.com.</Name><Type>TXT</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>&quot;ok&quot;</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>",
        "</ResourceRecordSets>",
        "<IsTruncated>false</IsTruncated>",
        "</ListResourceRecordSetsResponse>"
      ].join(""));
    }) as typeof fetch,
    now: () => fixedNow
  });

  const records = await adapter.listResourceRecordSets("Z123456789");

  assert.deepEqual(records.map((record) => record.name), ["a.delivrix-mail.com.", "txt.delivrix-mail.com."]);
  const cursorUrl = new URL(calls[1]);
  assert.equal(cursorUrl.searchParams.get("maxitems"), "100");
  assert.equal(cursorUrl.searchParams.get("name"), "txt.delivrix-mail.com.");
  assert.equal(cursorUrl.searchParams.get("type"), "TXT");
  assert.equal(cursorUrl.searchParams.get("identifier"), "weighted-a");
});

test("AwsRoute53DnsAdapter lists hosted zones across Route53 cursors", async () => {
  const calls: string[] = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: false,
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(url.toString());
      if (calls.length === 1) {
        return xmlResponse([
          "<ListHostedZonesResponse>",
          "<HostedZones>",
          "<HostedZone><Id>/hostedzone/Z111111111</Id><Name>delivrix-mail.com.</Name></HostedZone>",
          "</HostedZones>",
          "<IsTruncated>true</IsTruncated>",
          "<NextMarker>Z222222222</NextMarker>",
          "</ListHostedZonesResponse>"
        ].join(""));
      }
      return xmlResponse([
        "<ListHostedZonesResponse>",
        "<HostedZones>",
        "<HostedZone><Id>/hostedzone/Z222222222</Id><Name>example.com.</Name></HostedZone>",
        "</HostedZones>",
        "<IsTruncated>false</IsTruncated>",
        "</ListHostedZonesResponse>"
      ].join(""));
    }) as typeof fetch,
    now: () => fixedNow
  });

  const zones = await adapter.listHostedZones();

  assert.deepEqual(zones, [
    { zoneId: "Z111111111", name: "delivrix-mail.com.", nameServers: [] },
    { zoneId: "Z222222222", name: "example.com.", nameServers: [] }
  ]);
  assert.equal(new URL(calls[0]).searchParams.get("maxitems"), "100");
  assert.equal(new URL(calls[1]).searchParams.get("marker"), "Z222222222");
});

test("AwsRoute53DnsAdapter lists hosted zones by exact apex name", async () => {
  const calls: string[] = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: false,
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(url.toString());
      return xmlResponse([
        "<ListHostedZonesByNameResponse>",
        "<HostedZones>",
        "<HostedZone><Id>/hostedzone/Z01313019Q8DEA3UGP8G</Id><Name>controlcorpfiling.com.</Name></HostedZone>",
        "<HostedZone><Id>/hostedzone/ZOTHERDOMAIN</Id><Name>controlcorpfiling.com.evil.</Name></HostedZone>",
        "</HostedZones>",
        "<IsTruncated>false</IsTruncated>",
        "</ListHostedZonesByNameResponse>"
      ].join(""));
    }) as typeof fetch,
    now: () => fixedNow
  });

  const zones = await adapter.listHostedZonesByName("ControlCorpFiling.COM.");

  assert.deepEqual(zones, [{
    zoneId: "Z01313019Q8DEA3UGP8G",
    name: "controlcorpfiling.com.",
    nameServers: []
  }]);
  const url = new URL(calls[0]);
  assert.equal(url.pathname, "/2013-04-01/hostedzonesbyname");
  assert.equal(url.searchParams.get("dnsname"), "controlcorpfiling.com.");
});

test("AwsRoute53DnsAdapter follows ListHostedZonesByName cursor for duplicate apex zones", async () => {
  const calls: string[] = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: false,
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(url.toString());
      if (calls.length === 1) {
        return xmlResponse([
          "<ListHostedZonesByNameResponse>",
          "<HostedZones>",
          "<HostedZone><Id>/hostedzone/ZONE1</Id><Name>controldelivrix.app.</Name></HostedZone>",
          "</HostedZones>",
          "<IsTruncated>true</IsTruncated>",
          "<NextDNSName>controldelivrix.app.</NextDNSName>",
          "<NextHostedZoneId>ZONE2</NextHostedZoneId>",
          "</ListHostedZonesByNameResponse>"
        ].join(""));
      }
      return xmlResponse([
        "<ListHostedZonesByNameResponse>",
        "<HostedZones>",
        "<HostedZone><Id>/hostedzone/ZONE2</Id><Name>controldelivrix.app.</Name></HostedZone>",
        "</HostedZones>",
        "<IsTruncated>false</IsTruncated>",
        "</ListHostedZonesByNameResponse>"
      ].join(""));
    }) as typeof fetch,
    now: () => fixedNow
  });

  const zones = await adapter.listHostedZonesByName("controldelivrix.app");

  assert.deepEqual(zones.map((zone) => zone.zoneId), ["ZONE1", "ZONE2"]);
  assert.equal(new URL(calls[1]).searchParams.get("hostedzoneid"), "ZONE2");
});

test("AwsRoute53DnsAdapter lists resource records when writes are disabled", async () => {
  let fetchCalled = false;
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: false,
    fetchImpl: (async () => {
      fetchCalled = true;
      return xmlResponse([
        "<ListResourceRecordSetsResponse>",
        "<ResourceRecordSets>",
        "<ResourceRecordSet><Name>delivrix-mail.com.</Name><Type>NS</Type><TTL>172800</TTL><ResourceRecords><ResourceRecord><Value>ns-1.awsdns.com.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>",
        "</ResourceRecordSets>",
        "</ListResourceRecordSetsResponse>"
      ].join(""));
    }) as typeof fetch,
    now: () => fixedNow
  });

  const records = await adapter.listResourceRecordSets("Z123456789");

  assert.equal(fetchCalled, true);
  assert.equal(records[0].type, "NS");
});

test("AwsRoute53DnsAdapter deletes hosted zone records from all listed pages", async () => {
  const calls: Array<{ method: string | undefined; url: string; body: string | undefined }> = [];
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: true,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        url: url.toString(),
        body: init?.body?.toString()
      });
      const getCalls = calls.filter((call) => call.method === "GET").length;
      if (init?.method === "GET" && getCalls === 1) {
        return xmlResponse([
          "<ListResourceRecordSetsResponse>",
          "<ResourceRecordSets>",
          "<ResourceRecordSet><Name>a.delivrix-mail.com.</Name><Type>A</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>192.0.2.10</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>",
          "</ResourceRecordSets>",
          "<IsTruncated>true</IsTruncated>",
          "<NextRecordName>mx.delivrix-mail.com.</NextRecordName>",
          "<NextRecordType>MX</NextRecordType>",
          "</ListResourceRecordSetsResponse>"
        ].join(""));
      }
      if (init?.method === "GET") {
        return xmlResponse([
          "<ListResourceRecordSetsResponse>",
          "<ResourceRecordSets>",
          "<ResourceRecordSet><Name>mx.delivrix-mail.com.</Name><Type>MX</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>10 mail.delivrix-mail.com.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>",
          "</ResourceRecordSets>",
          "<IsTruncated>false</IsTruncated>",
          "</ListResourceRecordSetsResponse>"
        ].join(""));
      }
      if (init?.method === "POST") {
        return xmlResponse("<ChangeResourceRecordSetsResponse><ChangeInfo><Id>/change/CDELETE</Id></ChangeInfo></ChangeResourceRecordSetsResponse>");
      }
      return xmlResponse("<DeleteHostedZoneResponse><ChangeInfo><Id>/change/CZONE</Id></ChangeInfo></DeleteHostedZoneResponse>");
    }) as typeof fetch,
    now: () => fixedNow
  });

  const result = await adapter.deleteHostedZone("Z123456789");

  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[2].method, "POST");
  assert.equal(calls[3].method, "POST");
  assert.equal(calls[4].method, "DELETE");
  assert.equal(result.deletedRecords.length, 2);
  assert.match(calls[2].body ?? "", /<Name>a\.delivrix-mail\.com\.<\/Name>/);
  assert.match(calls[3].body ?? "", /<Name>mx\.delivrix-mail\.com\.<\/Name>/);
});

test("AwsRoute53DnsAdapter blocks writes when write flag is disabled", async () => {
  let fetchCalled = false;
  const adapter = new AwsRoute53DnsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    writeEnabled: false,
    fetchImpl: (async () => {
      fetchCalled = true;
      return xmlResponse("<ok />");
    }) as typeof fetch,
    now: () => fixedNow
  });

  await assert.rejects(
    adapter.createHostedZone("delivrix-mail.com"),
    /DNS writes are disabled/
  );
  assert.equal(fetchCalled, false);
});

test("signAwsRestRequest produces deterministic Route53 REST headers", () => {
  const headers = signAwsRestRequest({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    region: "us-east-1",
    service: "route53",
    method: "POST",
    url: new URL("https://route53.amazonaws.com/2013-04-01/hostedzone"),
    body: "<xml />",
    contentType: "text/xml; charset=utf-8",
    now: fixedNow
  });

  assert.equal(headers["x-amz-date"], "20260527T120000Z");
  assert.equal(headers.host, "route53.amazonaws.com");
  assert.match(headers.authorization, /Credential=AKIAEXAMPLE\/20260527\/us-east-1\/route53\/aws4_request/);
  assert.match(headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
});

function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/xml" }
  });
}
