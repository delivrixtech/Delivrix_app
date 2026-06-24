import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebdockCreateRegistry,
  createWebdockAdaptersFromEnv,
  WebdockAdapterError,
  WebdockRealAdapter
} from "./webdock-real-adapter.ts";

test("createWebdockAdaptersFromEnv builds one adapter per configured Webdock account", () => {
  const accounts = createWebdockAdaptersFromEnv({
    WEBDOCK_API_KEY_PRIMARY: "primary-key",
    WEBDOCK_ACCOUNT_PRIMARY_LABEL: "Primary EU",
    WEBDOCK_API_KEY_OPS: "ops-key",
    WEBDOCK_ACCOUNT_OPS_LABEL: "Ops EU",
    WEBDOCK_API_KEY_ACCOUNT: "account-key"
  });

  assert.deepEqual(accounts.map((account) => [account.id, account.label]), [
    ["primary", "Primary EU"],
    ["ops", "Ops EU"],
    ["account", "Webdock Account"]
  ]);
});

test("Fase0: cuenta distinta (secondary) con solo read key queda read-only (canCreate false, no cae a singletons OPS/ACCOUNT)", () => {
  const accounts = createWebdockAdaptersFromEnv({
    // singletons de la cuenta-1 presentes (el bug latente los tomaba por fallback)
    WEBDOCK_API_KEY_PRIMARY: "primary-key",
    WEBDOCK_API_KEY_OPS: "ops-key",
    WEBDOCK_API_KEY_ACCOUNT: "account-key",
    // cuenta-2 SOLO con read key, sin _WRITE/_ACCOUNT propias
    WEBDOCK_API_KEY_SECONDARY: "secondary-read"
  });
  const secondary = accounts.find((a) => a.id === "secondary");
  assert.ok(secondary, "secondary debe existir");
  assert.equal(secondary.adapter.isLive(), true, "lee inventario");
  assert.equal(secondary.adapter.canCreate(), false, "NO debe poder crear: sin write/account propias y sin fallback a singletons de cuenta-1");
  assert.equal(secondary.adapter.canWrite(), false, "NO debe heredar la OPS key de la cuenta-1");
});

test("Fase0: cuenta distinta (secondary) con sus 3 keys propias crea con SU token (assert sobre el adapter de la factory)", async () => {
  // El fetchImpl capturador se inyecta VIA LA FACTORY (no un adapter manual),
  // para aseverar el wiring real de la factory, no uno paralelo.
  const calls: Array<{ url: string; auth: string }> = [];
  const accounts = createWebdockAdaptersFromEnv({
    WEBDOCK_API_KEY_OPS: "ops-key-cuenta1",
    WEBDOCK_API_KEY_ACCOUNT: "account-key-cuenta1",
    WEBDOCK_API_KEY_SECONDARY: "secondary-read",
    WEBDOCK_API_KEY_SECONDARY_WRITE: "secondary-write",
    WEBDOCK_API_KEY_SECONDARY_ACCOUNT: "secondary-account",
    WEBDOCK_ACCOUNT_SECONDARY_LABEL: "Cuenta 2"
  }, {
    apiBase: "https://api.webdock.test/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization ?? "" });
      if (String(url).endsWith("/account/publicKeys") && init?.method === "GET") return Response.json([{ id: 9, key: "ssh-ed25519 AAAA t" }]);
      return Response.json({ slug: "s2", name: "mail.c2.test", status: "provisioning", ipv4: "" }, { status: 201 });
    }
  });
  const secondary = accounts.find((a) => a.id === "secondary");
  assert.ok(secondary);
  assert.equal(secondary.label, "Cuenta 2");
  assert.equal(secondary.adapter.canCreate(), true);

  await secondary.adapter.createServer({ profile: "bit", locationId: "dk", hostname: "mail.c2.test", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA t" });
  const createCall = calls.find((c) => c.url.endsWith("/servers"));
  assert.equal(createCall?.auth, "Bearer secondary-write", "el create del adapter de la FACTORY escribe con el token de la cuenta-2, NO con la OPS de cuenta-1");
  const pubKeyCall = calls.find((c) => c.url.endsWith("/account/publicKeys"));
  assert.equal(pubKeyCall?.auth, "Bearer secondary-account", "registra la SSH key con el account token de la cuenta-2");
});

test("Fase0: cuenta distinta con WRITE pero sin ACCOUNT propia NO hereda el account de cuenta-1 (canCreate false)", () => {
  const accounts = createWebdockAdaptersFromEnv({
    WEBDOCK_API_KEY_OPS: "ops-key-cuenta1",
    WEBDOCK_API_KEY_ACCOUNT: "account-key-cuenta1",
    WEBDOCK_API_KEY_SECONDARY: "secondary-read",
    WEBDOCK_API_KEY_SECONDARY_WRITE: "secondary-write"
    // SIN _ACCOUNT propia
  });
  const secondary = accounts.find((a) => a.id === "secondary");
  assert.ok(secondary);
  assert.equal(secondary.adapter.canWrite(), true, "tiene write propia");
  assert.equal(secondary.adapter.canCreate(), false, "canCreate exige write Y account; no debe heredar el ACCOUNT de la cuenta-1");
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

test("WebdockRealAdapter preserves live failure metadata for rejected reads", async () => {
  for (const scenario of [
    { status: 401, statusText: "Unauthorized", errorCode: "webdock_auth_401", failureKind: "unauthorized" },
    { status: 403, statusText: "Forbidden", errorCode: "webdock_forbidden_403", failureKind: "forbidden" }
  ] as const) {
    const adapter = new WebdockRealAdapter({
      readApiKey: "bad-read-key",
      apiBase: "https://api.webdock.test/v1",
      accountId: "secondary",
      accountLabel: "Webdock Secondary",
      cacheTtlMs: 0,
      now: () => new Date("2026-05-24T17:59:30.000Z"),
      fetchImpl: async () => new Response("", { status: scenario.status, statusText: scenario.statusText })
    });

    const result = await adapter.listServers();

    assert.deepEqual(result.servers, []);
    assert.equal(result.source.kind, "live");
    assert.equal(result.source.responseOk, false);
    assert.equal(result.source.httpStatus, scenario.status);
    assert.equal(result.source.httpStatusText, scenario.statusText);
    assert.equal(result.source.errorCode, scenario.errorCode);
    assert.equal(result.source.failureKind, scenario.failureKind);
    assert.equal(result.source.errorMessage, `Webdock API returned ${scenario.status} ${scenario.statusText}`);
  }
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
          ipv4: "192.0.2.44",
          aliases: ["smtp.delivrix.test"]
        }
      });
    }
  });

  const server = await adapter.getServer("mail-delivrix-test");

  assert.equal(server.slug, "mail-delivrix-test");
  assert.equal(server.status, "running");
  assert.equal(server.ipv4, "192.0.2.44");
  assert.equal(server.mainDomain, "smtp.delivrix.test");
});

test("WebdockRealAdapter sets main domain through SSH fallback with validated command", async () => {
  const commands: string[] = [];
  const adapter = new WebdockRealAdapter({
    sshRunner: {
      isConfigured: () => true,
      run: async (input) => {
        commands.push(input.command);
        assert.equal(input.serverIp, "192.0.2.44");
        if (input.command === "hostname") {
          return { stdout: "old.example.com\n", stderr: "", exitCode: 0 };
        }
        assert.match(input.command, /hostnamectl set-hostname/);
        assert.match(input.command, /domain='example\.com'/);
        return { stdout: "example.com\n", stderr: "", exitCode: 0 };
      }
    }
  });

  const result = await adapter.setServerMainDomain({
    serverSlug: "server-abc123",
    domain: "example.com",
    serverIp: "192.0.2.44"
  });

  assert.equal(result.ok, true);
  assert.equal(result.previousMainDomain, "old.example.com");
  assert.equal(commands.length, 2);
  await assert.rejects(
    () => adapter.setServerMainDomain({
      serverSlug: "server-abc123",
      domain: "mail.example.com;touch /tmp/pwned",
      serverIp: "192.0.2.44"
    }),
    (error) => error instanceof WebdockAdapterError && error.code === "domain_invalid_format"
  );
});

test("WebdockRealAdapter setServerPtr reports PTR unsupported by API", async () => {
  const adapter = new WebdockRealAdapter();

  const result = await adapter.setServerPtr({
    serverSlug: "server-abc123",
    ipv4: "192.0.2.44",
    ptrValue: "example.com"
  });

  assert.deepEqual(result, {
    ok: false,
    supported: false,
    raw: { reason: "not_supported_by_api" }
  });
});

test("WebdockRealAdapter sets server identity through Webdock API and waits for set-hostnames", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new WebdockRealAdapter({
    readApiKey: "primary-read-key",
    writeApiKey: "ops-write-key",
    apiBase: "https://api.webdock.test/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/servers/server60/identity")) {
        return Response.json({
          slug: "server60",
          mainDomain: "smtp.example.com",
          status: "running"
        }, {
          status: 202,
          headers: { "x-callback-id": "identity-cb-123" }
        });
      }
      if (String(url).startsWith("https://api.webdock.test/v1/events?")) {
        return Response.json([{
          callbackId: "identity-cb-123",
          eventType: "set-hostnames",
          status: "finished"
        }]);
      }
      return Response.json({}, { status: 404 });
    }
  });

  const result = await adapter.setServerIdentity({
    serverSlug: "server60",
    mainDomain: "smtp.example.com",
    timeoutMs: 50,
    pollIntervalMs: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.callbackId, "identity-cb-123");
  assert.equal(result.mainDomain, "smtp.example.com");
  assert.equal(calls[0].url, "https://api.webdock.test/v1/servers/server60/identity");
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer ops-write-key");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    maindomain: "smtp.example.com",
    aliasdomains: "",
    removeDefaultAlias: true
  });
  assert.equal(calls[1].url, "https://api.webdock.test/v1/events?callbackId=identity-cb-123&eventType=set-hostnames&per_page=10");
  assert.equal(calls[1].init.method, "GET");
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, "Bearer primary-read-key");
});

test("WebdockRealAdapter rejects when set-hostnames event fails", async () => {
  const adapter = new WebdockRealAdapter({
    readApiKey: "primary-read-key",
    writeApiKey: "ops-write-key",
    apiBase: "https://api.webdock.test/v1",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/servers/server60/identity")) {
        return Response.json({ slug: "server60" }, {
          status: 202,
          headers: { "x-callback-id": "identity-cb-error" }
        });
      }
      return Response.json([{
        callbackId: "identity-cb-error",
        eventType: "set-hostnames",
        status: "error",
        message: "provider failed"
      }]);
    }
  });

  await assert.rejects(
    () => adapter.setServerIdentity({
      serverSlug: "server60",
      mainDomain: "smtp.example.com",
      timeoutMs: 50,
      pollIntervalMs: 1
    }),
    (error) => error instanceof WebdockAdapterError && error.code === "set_server_identity_event_failed"
  );
});

test("WebdockRealAdapter rejects when set-hostnames event stays pending past timeout", async () => {
  const adapter = new WebdockRealAdapter({
    readApiKey: "primary-read-key",
    writeApiKey: "ops-write-key",
    apiBase: "https://api.webdock.test/v1",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/servers/server60/identity")) {
        return Response.json({ slug: "server60" }, {
          status: 202,
          headers: { "x-callback-id": "identity-cb-timeout" }
        });
      }
      return Response.json([{
        callbackId: "identity-cb-timeout",
        eventType: "set-hostnames",
        status: "waiting"
      }]);
    }
  });

  await assert.rejects(
    () => adapter.setServerIdentity({
      serverSlug: "server60",
      mainDomain: "smtp.example.com",
      timeoutMs: 5,
      pollIntervalMs: 1
    }),
    (error) => error instanceof WebdockAdapterError && error.code === "set_server_identity_event_timeout"
  );
});

test("DoD#4 de-dup: las 3 keys de la cuenta-1 (primary/ops/account) colapsan a UNA cuenta 'ops' en el registry write-capable", () => {
  // createWebdockAdaptersFromEnv produce 3 entries para la cuenta-1 (roles), todas write-capable
  // por el fallback a los singletons OPS/ACCOUNT. El registry debe contar la cuenta UNA vez.
  const entries = createWebdockAdaptersFromEnv({
    WEBDOCK_API_KEY_PRIMARY: "primary-key",
    WEBDOCK_API_KEY_OPS: "ops-key",
    WEBDOCK_API_KEY_ACCOUNT: "account-key"
  });
  assert.equal(entries.length, 3, "la factory devuelve primary+ops+account (3 roles de la cuenta-1)");

  const opsAdapter = new WebdockRealAdapter({
    readApiKey: "primary-key",
    writeApiKey: "ops-key",
    accountApiKey: "account-key",
    accountId: "ops"
  });
  const registry = buildWebdockCreateRegistry(entries, opsAdapter);

  assert.deepEqual([...registry.keys()], ["ops"], "la cuenta-1 cuenta UNA vez, no 3");
  assert.equal(registry.get("ops"), opsAdapter, "la clave 'ops' apunta al opsAdapter canonico (mismo objeto)");
});

test("DoD#4 de-dup: una cuenta DISTINTA write-capable entra al registry SIN inflar la cuenta-1", () => {
  const entries = createWebdockAdaptersFromEnv({
    WEBDOCK_API_KEY_PRIMARY: "primary-key",
    WEBDOCK_API_KEY_OPS: "ops-key",
    WEBDOCK_API_KEY_ACCOUNT: "account-key",
    // cuenta-2 con sus 3 keys propias => canCreate true => entra
    WEBDOCK_API_KEY_SECONDARY: "secondary-read",
    WEBDOCK_API_KEY_SECONDARY_WRITE: "secondary-write",
    WEBDOCK_API_KEY_SECONDARY_ACCOUNT: "secondary-account",
    // cuenta-3 SOLO read => canCreate false => NO entra
    WEBDOCK_API_KEY_TERTIARY: "tertiary-read"
  });
  const opsAdapter = new WebdockRealAdapter({ writeApiKey: "ops-key", accountApiKey: "account-key", accountId: "ops" });
  const registry = buildWebdockCreateRegistry(entries, opsAdapter);

  assert.deepEqual([...registry.keys()].sort(), ["ops", "secondary"], "ops (cuenta-1 de-dupeada) + secondary write-capable; tertiary read-only excluida");
  const secondary = entries.find((e) => e.id === "secondary");
  assert.equal(registry.get("secondary"), secondary?.adapter, "secondary apunta a su adapter aislado (token propio)");
});
