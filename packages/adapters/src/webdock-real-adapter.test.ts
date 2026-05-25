import assert from "node:assert/strict";
import test from "node:test";
import { createWebdockAdaptersFromEnv } from "./webdock-real-adapter.ts";

test("createWebdockAdaptersFromEnv builds one adapter per configured Webdock account", () => {
  const accounts = createWebdockAdaptersFromEnv({
    WEBDOCK_API_KEY_PRIMARY: "primary-key",
    WEBDOCK_ACCOUNT_PRIMARY_LABEL: "Primary EU",
    WEBDOCK_API_KEY_SECONDARY: "secondary-key",
    WEBDOCK_ACCOUNT_SECONDARY_LABEL: "Secondary EU",
    WEBDOCK_API_KEY_TERTIARY: "tertiary-key"
  });

  assert.deepEqual(accounts.map((account) => [account.id, account.label]), [
    ["primary", "Primary EU"],
    ["secondary", "Secondary EU"],
    ["tertiary", "Webdock Tertiary"]
  ]);
});

test("createWebdockAdaptersFromEnv preserves legacy Webdock account fallback", () => {
  const accounts = createWebdockAdaptersFromEnv({
    WEBDOCK_API_KEY: "legacy-key"
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "default");
  assert.equal(accounts[0].label, "Webdock");
});

test("createWebdockAdaptersFromEnv keeps a mock default adapter when no key exists", async () => {
  const accounts = createWebdockAdaptersFromEnv({}, {
    now: () => new Date("2026-05-24T18:00:00.000Z")
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "default");
  assert.equal(accounts[0].adapter.isLive(), false);

  const result = await accounts[0].adapter.listServers();
  assert.equal(result.source.kind, "mock");
  assert.equal(result.source.accountId, "default");
  assert.equal(result.source.accountLabel, "Webdock");
  assert.equal(result.servers.length > 0, true);
  assert.equal(result.servers[0].accountId, "default");
});
