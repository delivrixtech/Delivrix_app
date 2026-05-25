import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AwsRoute53DomainDiscoveryResult } from "../../../../packages/adapters/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import {
  buildAwsDomainDiscoveryResponse,
  parseAwsDomainDiscoveryQuery,
  shouldAuditAwsDomainDiscovery
} from "./aws-domain-discovery.ts";

const fixedNow = new Date("2026-05-25T18:00:00.000Z");

test("parseAwsDomainDiscoveryQuery expands label with default TLDs", () => {
  const query = parseAwsDomainDiscoveryQuery(new URLSearchParams("name=delivrix&suggestions=3"));

  assert.deepEqual(query, {
    rawName: "delivrix",
    candidateNames: [
      "delivrix.com",
      "delivrix.net",
      "delivrix.app",
      "delivrix.io",
      "delivrix.co"
    ],
    tlds: ["com", "net", "app", "io", "co"],
    suggestionsLimit: 3
  });
});

test("parseAwsDomainDiscoveryQuery accepts a fully-qualified domain", () => {
  const query = parseAwsDomainDiscoveryQuery(new URLSearchParams("name=DelivrixHQ.com&tlds=net,app"));

  assert.deepEqual(query, {
    rawName: "delivrixhq.com",
    candidateNames: ["delivrixhq.com"],
    tlds: ["com"],
    suggestionsLimit: 5
  });
});

test("buildAwsDomainDiscoveryResponse stays discovery-only and blocks purchase actions", () => {
  const payload = buildAwsDomainDiscoveryResponse({
    query: parseAwsDomainDiscoveryQuery(new URLSearchParams("name=delivrix&tlds=com")),
    result: discoveryResult({
      purchaseEnabled: false,
      candidates: [{
        domainName: "delivrix.com",
        tld: "com",
        availability: "AVAILABLE",
        canRegister: true,
        registrationPrice: { amount: 14, currency: "USD" },
        renewalPrice: { amount: 14, currency: "USD" }
      }],
      suggestions: [{ domainName: "delivrixhq.com", availability: "AVAILABLE" }]
    }),
    now: fixedNow
  });

  assert.equal(payload.summary.mode, "discovery_only");
  assert.equal(payload.summary.availableCount, 1);
  assert.equal(payload.summary.purchaseEnabled, false);
  assert.deepEqual(payload.proposal.blockedActions, [
    "register_domain",
    "create_hosted_zone",
    "change_dns_records"
  ]);
  assert.equal(payload.candidates[0].registrationPrice?.amount, 14);
});

test("domain discovery audit is explicit OpenClaw-only", async () => {
  assert.equal(shouldAuditAwsDomainDiscovery({}), false);
  assert.equal(shouldAuditAwsDomainDiscovery({ "x-openclaw-skill-invocation": "panel" }), false);
  assert.equal(shouldAuditAwsDomainDiscovery({ "x-openclaw-skill-invocation": "aws-domain-discovery" }), true);

  const dir = await mkdtemp(join(tmpdir(), "delivrix-domain-discovery-audit-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const payload = buildAwsDomainDiscoveryResponse({
    query: parseAwsDomainDiscoveryQuery(new URLSearchParams("name=delivrix&tlds=com")),
    result: discoveryResult({
      purchaseEnabled: false,
      candidates: [{
        domainName: "delivrix.com",
        tld: "com",
        availability: "AVAILABLE",
        canRegister: true
      }]
    }),
    now: fixedNow
  });

  await auditLog.append({
    actorType: "openclaw",
    actorId: "aws-domain-discovery",
    action: "oc.aws.route53domains.discovery",
    targetType: "domain_discovery",
    targetId: payload.query.rawName,
    riskLevel: "low",
    decision: "n/a",
    metadata: {
      candidateCount: payload.summary.candidateCount,
      availableCount: payload.summary.availableCount,
      suggestionCount: payload.summary.suggestionCount,
      sourceKind: payload.source.kind,
      responseOk: payload.source.responseOk,
      purchaseEnabled: payload.summary.purchaseEnabled
    }
  });

  const events = await auditLog.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.aws.route53domains.discovery");
  assert.equal(events[0].metadata.availableCount, 1);
});

function discoveryResult(input: {
  purchaseEnabled: boolean;
  candidates?: AwsRoute53DomainDiscoveryResult["candidates"];
  suggestions?: AwsRoute53DomainDiscoveryResult["suggestions"];
}): AwsRoute53DomainDiscoveryResult {
  return {
    candidates: input.candidates ?? [],
    suggestions: input.suggestions ?? [],
    prices: [],
    source: {
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53domains.us-east-1.amazonaws.com",
      fetchedAt: "2026-05-25T18:00:00.000Z",
      responseOk: true,
      purchaseEnabled: input.purchaseEnabled
    }
  };
}
