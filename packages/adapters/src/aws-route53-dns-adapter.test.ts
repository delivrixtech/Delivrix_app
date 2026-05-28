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
