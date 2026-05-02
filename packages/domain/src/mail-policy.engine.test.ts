import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySuppressionList } from "./suppression-list.ts";
import { MailPolicyEngine } from "./mail-policy.engine.ts";
import type { SendRequest } from "./types.ts";

function validCommercialRequest(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    campaignId: "campaign_001",
    recipient: {
      email: "founder@example.com",
      consentProofId: "crm_optin_001"
    },
    sender: {
      address: "hello@delivrix.com",
      domain: "delivrix.com",
      dkimDomain: "delivrix.com"
    },
    subject: "Company filing reminder",
    bodyText: "Your requested filing reminder is ready.",
    classification: "commercial",
    unsubscribeUrl: "https://delivrix.com/unsubscribe/example",
    physicalAddress: "Delivrix LLC physical mailing address",
    ...overrides
  };
}

test("allows compliant commercial mail", async () => {
  const engine = new MailPolicyEngine(new InMemorySuppressionList());
  const decision = await engine.evaluate(validCommercialRequest());

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.violations, []);
});

test("blocks suppressed recipients", async () => {
  const suppressionList = new InMemorySuppressionList();
  await suppressionList.add({
    email: "founder@example.com",
    reason: "unsubscribe",
    source: "unit-test"
  });

  const engine = new MailPolicyEngine(suppressionList);
  const decision = await engine.evaluate(validCommercialRequest());

  assert.equal(decision.allowed, false);
  assert.equal(decision.violations[0]?.code, "RECIPIENT_SUPPRESSED");
});

test("blocks commercial mail without consent proof", async () => {
  const engine = new MailPolicyEngine(new InMemorySuppressionList());
  const request = validCommercialRequest({
    recipient: {
      email: "founder@example.com"
    }
  });

  const decision = await engine.evaluate(request);

  assert.equal(decision.allowed, false);
  assert.equal(
    decision.violations.some((violation) => violation.code === "MISSING_CONSENT_PROOF"),
    true
  );
});

test("blocks commercial mail without unsubscribe URL", async () => {
  const engine = new MailPolicyEngine(new InMemorySuppressionList());
  const request = validCommercialRequest({
    unsubscribeUrl: undefined
  });

  const decision = await engine.evaluate(request);

  assert.equal(decision.allowed, false);
  assert.equal(
    decision.violations.some((violation) => violation.code === "MISSING_UNSUBSCRIBE_URL"),
    true
  );
});
