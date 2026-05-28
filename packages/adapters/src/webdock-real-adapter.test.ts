import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebdockAdaptersFromEnv,
  WebdockRealAdapter
} from "./webdock-real-adapter.ts";

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

test("WebdockRealAdapter creates a server from the safe demo profile aliases", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new WebdockRealAdapter({
    writeApiKey: "ops-key",
    accountApiKey: "account-key",
    apiBase: "https://api.webdock.test/v1",
    now: () => new Date("2026-05-26T19:00:00.000Z"),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/account/publicKeys") && init?.method === "GET") {
        return Response.json([]);
      }
      if (String(url).endsWith("/account/publicKeys") && init?.method === "POST") {
        return Response.json({ id: 4242, name: "delivrix-ops-test", key: "ssh-ed25519 AAAA test" }, { status: 201 });
      }
      return new Response(JSON.stringify({
        slug: "mail-delivrix-test",
        name: "mail.delivrix.test",
        status: "provisioning",
        ipv4: ""
      }), {
        status: 201,
        headers: { "x-callback-id": "cb-123" }
      });
    }
  });

  const result = await adapter.createServer({
    profile: "bit",
    locationId: "dk",
    hostname: "mail.delivrix.test",
    imageSlug: "ubuntu-2404",
    publicKey: "ssh-ed25519 AAAA test"
  });

  assert.equal(result.serverSlug, "mail-delivrix-test");
  assert.equal(result.eventId, "cb-123");
  assert.equal(result.status, "provisioning");
  assert.equal(result.publicKeyId, 4242);
  assert.equal(calls[0].url, "https://api.webdock.test/v1/account/publicKeys");
  assert.equal(calls[1].url, "https://api.webdock.test/v1/account/publicKeys");
  assert.equal(calls[2].url, "https://api.webdock.test/v1/servers");
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {
    name: "mail.delivrix.test",
    locationId: "dk",
    profileSlug: "vps-xeon-essential-2025",
    imageSlug: "webdock-ubuntu-noble-cloud",
    publicKeys: [4242]
  });
});

test("WebdockRealAdapter uses primary key for reads and ops key for writes", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new WebdockRealAdapter({
    readApiKey: "primary-read-key",
    writeApiKey: "ops-write-key",
    accountApiKey: "account-write-key",
    apiBase: "https://api.webdock.test/v1",
    cacheTtlMs: 0,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/account/publicKeys") && init?.method === "GET") {
        return Response.json([{ id: 28400, key: "ssh-ed25519 AAAA test" }]);
      }
      if (String(url).endsWith("/servers") && init?.method === "POST") {
        return Response.json({
          slug: "mail-delivrix-test",
          name: "mail.delivrix.test",
          status: "provisioning",
          ipv4: ""
        }, { status: 201 });
      }
      return Response.json([{
        slug: "mail-current",
        name: "mail.current.test",
        status: "running",
        ipv4: "192.0.2.10"
      }]);
    }
  });

  await adapter.listServers();
  await adapter.createServer({
    profile: "bit",
    locationId: "dk",
    hostname: "mail.delivrix.test",
    imageSlug: "ubuntu-2404",
    publicKey: "ssh-ed25519 AAAA test"
  });

  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer primary-read-key");
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, "Bearer account-write-key");
  assert.equal((calls[2].init.headers as Record<string, string>).authorization, "Bearer ops-write-key");
});

test("WebdockRealAdapter creates shell user with registered key and enables passwordless sudo", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new WebdockRealAdapter({
    writeApiKey: "ops-write-key",
    accountApiKey: "account-write-key",
    apiBase: "https://api.webdock.test/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/account/publicKeys")) {
        return Response.json([{ id: 28180, key: "ssh-ed25519 AAAA test" }]);
      }
      if (String(url).endsWith("/shellUsers") && init?.method === "GET") {
        return Response.json([]);
      }
      if (String(url).endsWith("/shellUsers") && init?.method === "POST") {
        return Response.json({ id: 111541, username: "delivrixops" }, {
          status: 202,
          headers: { "x-callback-id": "shell-cb-123" }
        });
      }
      if (String(url).endsWith("/sshSettings") && init?.method === "POST") {
        return Response.json({}, {
          status: 202,
          headers: { "x-callback-id": "ssh-settings-cb-123" }
        });
      }
      return Response.json({});
    }
  });

  const result = await adapter.ensureServerSshAccess({
    serverSlug: "server57",
    publicKey: "ssh-ed25519 AAAA test",
    username: "delivrixops"
  });

  assert.deepEqual(result, {
    publicKeyId: 28180,
    username: "delivrixops",
    shellUserId: 111541,
    shellUserEventId: "shell-cb-123",
    sshSettingsEventId: "ssh-settings-cb-123"
  });
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {
    username: "delivrixops",
    password: JSON.parse(String(calls[2].init.body)).password,
    group: "sudo",
    shell: "/bin/bash",
    publicKeys: [28180]
  });
  assert.match(JSON.parse(String(calls[2].init.body)).password, /^Dx_/);
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), {
    passwordSshAuthEnabled: false,
    passwordlessSudoEnabled: true,
    sshPort: 22
  });
});

test("WebdockRealAdapter uses ops key for deletes", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new WebdockRealAdapter({
    readApiKey: "primary-read-key",
    writeApiKey: "ops-write-key",
    apiBase: "https://api.webdock.test/v1",
    now: () => new Date("2026-05-26T19:00:00.000Z"),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ callbackId: "delete-cb-123" }), { status: 202 });
    }
  });

  const result = await adapter.deleteServer("Mail-Delivrix-Test");

  assert.equal(result.serverSlug, "mail-delivrix-test");
  assert.equal(result.eventId, "delete-cb-123");
  assert.equal(result.status, "deleting");
  assert.equal(calls[0].url, "https://api.webdock.test/v1/servers/mail-delivrix-test");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer ops-write-key");
});

test("WebdockRealAdapter does not use legacy key for writes", async () => {
  const adapter = new WebdockRealAdapter({
    apiKey: "legacy-key"
  });

  assert.equal(adapter.isLive(), true);
  assert.equal(adapter.canWrite(), false);
  await assert.rejects(
    () => adapter.createServer({
      profile: "bit",
      locationId: "dk",
      hostname: "mail.delivrix.test",
      imageSlug: "ubuntu-2404",
      publicKey: "ssh-ed25519 AAAA test"
    }),
    /WEBDOCK_API_KEY_OPS is required for Webdock writes/
  );
  await assert.rejects(
    () => adapter.deleteServer("mail-delivrix-test"),
    /WEBDOCK_API_KEY_OPS is required for Webdock writes/
  );
});

test("WebdockRealAdapter does not use ops key for reads", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new WebdockRealAdapter({
    writeApiKey: "ops-write-key",
    apiBase: "https://api.webdock.test/v1",
    now: () => new Date("2026-05-26T19:00:00.000Z"),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json([]);
    }
  });

  assert.equal(adapter.isLive(), false);
  assert.equal(adapter.canWrite(), true);
  const result = await adapter.listServers();

  assert.equal(result.source.kind, "mock");
  assert.equal(calls.length, 0);
});

test("WebdockRealAdapter fetches a provisioned server by slug", async () => {
  const adapter = new WebdockRealAdapter({
    readApiKey: "ops-key",
    apiBase: "https://api.webdock.test/v1",
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://api.webdock.test/v1/servers/mail-delivrix-test");
      return Response.json({
        server: {
          slug: "mail-delivrix-test",
          name: "mail.delivrix.test",
          status: "running",
          ipv4: "192.0.2.44"
        }
      });
    }
  });

  const server = await adapter.getServer("mail-delivrix-test");

  assert.equal(server.slug, "mail-delivrix-test");
  assert.equal(server.status, "running");
  assert.equal(server.ipv4, "192.0.2.44");
});
