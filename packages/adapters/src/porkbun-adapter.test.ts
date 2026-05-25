import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePorkbunAvailability,
  parsePorkbunOwnedDomains,
  parsePorkbunPrices,
  PorkbunAdapter
} from "./porkbun-adapter.ts";

test("parsePorkbunAvailability maps avail yes and price into candidate", () => {
  const candidate = parsePorkbunAvailability("delivrix-mail.com", {
    status: "SUCCESS",
    response: {
      avail: "yes",
      price: "11.06",
      renewal: "11.06",
      transfer: "11.06",
      firstYearPromo: "no"
    }
  });

  assert.equal(candidate.availability, "AVAILABLE");
  assert.equal(candidate.canRegister, true);
  assert.equal(candidate.registrationPrice?.amount, 11.06);
  assert.equal(candidate.renewalPrice?.amount, 11.06);
});

test("parsePorkbunPrices handles pricing object keyed by TLD", () => {
  const prices = parsePorkbunPrices({
    status: "SUCCESS",
    pricing: {
      com: { registration: "11.06", renewal: "11.06", transfer: "11.06" },
      app: { registration: "14.98", renewal: "14.98" }
    }
  });

  assert.deepEqual(prices.map((price) => [price.tld, price.registration?.amount]), [
    ["app", 14.98],
    ["com", 11.06]
  ]);
});

test("parsePorkbunOwnedDomains normalizes listAll response", () => {
  const domains = parsePorkbunOwnedDomains({
    status: "SUCCESS",
    domains: [{
      domain: "delivrix.io",
      status: "ACTIVE",
      expireDate: "2027-05-25",
      autoRenew: "yes",
      whoisPrivacy: "yes"
    }]
  });

  assert.equal(domains[0].domainName, "delivrix.io");
  assert.equal(domains[0].tld, "io");
  assert.equal(domains[0].autoRenew, true);
  assert.equal(domains[0].whoisPrivacy, true);
});

test("PorkbunAdapter stays mock-safe without credentials", async () => {
  const adapter = new PorkbunAdapter({
    env: {},
    now: () => new Date("2026-05-25T20:00:00.000Z")
  });

  const inventory = await adapter.listInventory();
  const ping = await adapter.ping();

  assert.equal(adapter.isLive(), false);
  assert.equal(inventory.source.kind, "mock");
  assert.equal(inventory.domains.length, 0);
  assert.equal(ping.ok, false);
});
