import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  ContaboAdapter,
  ContaboAdapterError,
  createContaboAdaptersFromEnv
} from "./contabo-adapter.ts";

// --- fetch mock harness ----------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

/** Instala un fetch mock que enruta por (method, url-substring). */
function installFetch(routes: Array<{ match: (url: string, method: string) => boolean; respond: Route }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = normalizeHeaders(init.headers);
    const body = typeof init.body === "string" ? init.body : undefined;
    calls.push({ url, method, headers, body });
    const route = routes.find((r) => r.match(url, method));
    if (!route) {
      throw new Error(`No mock route for ${method} ${url}`);
    }
    return route.respond(url, init);
  }) as typeof fetch;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  return out;
}

function tokenRoute(token = "tok-1", expiresIn = 300): { match: (url: string, m: string) => boolean; respond: Route } {
  return {
    match: (url) => url.includes("/openid-connect/token"),
    respond: () => Response.json({ access_token: token, refresh_token: "ref", expires_in: expiresIn })
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls = [];
});

const baseConfig = {
  clientId: "INT-15071666",
  clientSecret: "secret-32-chars-xxxxxxxxxxxxxxxx",
  username: "hostlatam@proton.me",
  password: "p4ss$word",
  region: "US-east",
  productId: "V45",
  accountId: "contabo",
  accountLabel: "Contabo Host Latam"
};

const SSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY delivrix";

// --- token: fetch + cache + refresh ---------------------------------------

test("token: fetches once and reuses within TTL, refreshes after expiry", async () => {
  let tokenHits = 0;
  let clock = new Date("2026-06-11T12:00:00.000Z").getTime();
  installFetch([
    {
      match: (url) => url.includes("/openid-connect/token"),
      respond: () => {
        tokenHits += 1;
        return Response.json({ access_token: `tok-${tokenHits}`, expires_in: 300 });
      }
    },
    {
      match: (url, m) => url.includes("/v1/compute/instances") && m === "GET",
      respond: () => Response.json({ data: [{ instanceId: 1, status: "running", ipConfig: { v4: { ip: "1.2.3.4" } } }] })
    }
  ]);

  const adapter = new ContaboAdapter({ ...baseConfig, now: () => new Date(clock) });

  // 1st call -> 1 token fetch.
  await adapter.listServers();
  assert.equal(tokenHits, 1, "first call requests a token");
  // 2nd call within TTL -> still 1 token fetch (cache reuse).
  await adapter.listServers();
  assert.equal(tokenHits, 1, "second call within TTL reuses cached token");

  // Advance past expiry (300s - 30s skew => refresh after ~270s). Jump 5 min.
  clock += 5 * 60 * 1000;
  await adapter.listServers();
  assert.equal(tokenHits, 2, "call after expiry re-requests a token");

  // Token request is a form-urlencoded password grant.
  const tokenCall = calls.find((c) => c.url.includes("/openid-connect/token"));
  assert.ok(tokenCall);
  assert.equal(tokenCall.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(tokenCall.body ?? "");
  assert.equal(form.get("grant_type"), "password");
  assert.equal(form.get("client_id"), "INT-15071666");
  assert.equal(form.get("username"), "hostlatam@proton.me");
});

// --- createServer ----------------------------------------------------------

test("createServer: translates to config region/product, finds-or-creates ssh secret, resolves image, posts instance", async () => {
  let secretGetHits = 0;
  installFetch([
    tokenRoute(),
    {
      // find ssh secret -> empty (forces create)
      match: (url, m) => url.includes("/v1/secrets") && m === "GET",
      respond: () => {
        secretGetHits += 1;
        return Response.json({ data: [] });
      }
    },
    {
      match: (url, m) => url.includes("/v1/secrets") && m === "POST",
      respond: () => Response.json({ data: [{ secretId: 777, name: "delivrix-ops-x" }] }, { status: 201 })
    },
    {
      match: (url, m) => url.includes("/v1/compute/images") && m === "GET",
      respond: () =>
        Response.json({
          data: [
            { imageId: "img-2004-uuid", name: "Ubuntu 20.04" },
            { imageId: "img-2204-uuid", name: "Ubuntu 22.04" }
          ]
        })
    },
    {
      match: (url, m) => url.includes("/v1/compute/instances") && m === "POST",
      respond: () =>
        Response.json({ data: [{ instanceId: 555, status: "provisioning" }] }, {
          status: 201,
          headers: { "x-request-id": "req-abc" }
        })
    }
  ]);

  const adapter = new ContaboAdapter({ ...baseConfig, now: () => new Date("2026-06-11T12:00:00.000Z") });

  // Incoming input uses Webdock defaults that MUST be ignored.
  const result = await adapter.createServer({
    profile: "bit",
    locationId: "dk",
    hostname: "mail.controlcorp.example",
    imageSlug: "ubuntu-2404",
    publicKey: SSH_KEY
  });

  assert.equal(result.serverSlug, "contabo-555", "slug is contabo-prefixed instanceId");
  assert.equal(result.ipv4, null, "create POST has no ip yet");
  assert.equal(result.status, "provisioning");
  assert.equal(result.eventId, "req-abc");
  assert.equal(result.source.kind, "live");
  assert.equal(result.source.apiBase, "https://api.contabo.com");
  assert.equal(result.source.accountId, "contabo");
  assert.equal(result.source.accountLabel, "Contabo Host Latam");
  assert.equal(result.source.responseOk, true);

  // The instance POST body uses CONFIG region/product, not the input dk/bit.
  const postCall = calls.find((c) => c.url.includes("/v1/compute/instances") && c.method === "POST");
  assert.ok(postCall);
  const sent = JSON.parse(postCall.body ?? "{}");
  assert.equal(sent.region, "US-east", "uses config region, ignores input locationId=dk");
  assert.equal(sent.productId, "V45", "uses config productId, ignores input profile=bit");
  assert.equal(sent.imageId, "img-2204-uuid", "resolved Ubuntu 22.04 image (lookup, not hardcoded)");
  assert.deepEqual(sent.sshKeys, [777], "references the created secretId");
  assert.equal(sent.period, 1);
  assert.equal(sent.displayName, "mail.controlcorp.example");
  assert.equal(sent.defaultUser, "root");

  // Mandatory headers on the instance POST.
  assert.equal(postCall.headers["authorization"], "Bearer tok-1", "Bearer token attached");
  assert.match(
    postCall.headers["x-request-id"],
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "x-request-id is a uuid4"
  );
  assert.equal(postCall.headers["content-type"], "application/json");
  assert.equal(postCall.headers["accept"], "application/json");

  // Secret was looked up before being created.
  assert.equal(secretGetHits, 1, "did a find-by-name before creating the secret");
});

test("createServer: reuses an existing ssh secret (no POST /v1/secrets)", async () => {
  installFetch([
    tokenRoute(),
    {
      match: (url, m) => url.includes("/v1/secrets") && m === "GET",
      // Return a secret whose name matches the deterministic label.
      respond: (url) => {
        const name = decodeURIComponent(new URL(url).searchParams.get("name") ?? "");
        return Response.json({ data: [{ secretId: 4242, name }] });
      }
    },
    {
      match: (url, m) => url.includes("/v1/secrets") && m === "POST",
      respond: () => {
        throw new Error("should not create a secret when one already exists");
      }
    },
    {
      match: (url, m) => url.includes("/v1/compute/images") && m === "GET",
      respond: () => Response.json({ data: [{ imageId: "img-2204-uuid", name: "Ubuntu 22.04" }] })
    },
    {
      match: (url, m) => url.includes("/v1/compute/instances") && m === "POST",
      respond: () => Response.json({ data: [{ instanceId: 9, status: "provisioning" }] }, { status: 201 })
    }
  ]);

  const adapter = new ContaboAdapter(baseConfig);
  const result = await adapter.createServer({
    profile: "bit",
    locationId: "dk",
    hostname: "mail.reuse.example",
    imageSlug: "ubuntu-2404",
    publicKey: SSH_KEY
  });
  assert.equal(result.serverSlug, "contabo-9");
  const sent = JSON.parse(calls.find((c) => c.url.includes("/v1/compute/instances") && c.method === "POST")?.body ?? "{}");
  assert.deepEqual(sent.sshKeys, [4242], "reused the existing secretId");
});

test("createServer: a configured imageId skips the image lookup", async () => {
  installFetch([
    tokenRoute(),
    {
      match: (url, m) => url.includes("/v1/secrets") && m === "GET",
      respond: () => Response.json({ data: [] })
    },
    {
      match: (url, m) => url.includes("/v1/secrets") && m === "POST",
      respond: () => Response.json({ data: [{ secretId: 1, name: "x" }] }, { status: 201 })
    },
    {
      match: (url, m) => url.includes("/v1/compute/images") && m === "GET",
      respond: () => {
        throw new Error("image lookup should be skipped when imageId is configured");
      }
    },
    {
      match: (url, m) => url.includes("/v1/compute/instances") && m === "POST",
      respond: () => Response.json({ data: [{ instanceId: 2, status: "provisioning" }] }, { status: 201 })
    }
  ]);

  const adapter = new ContaboAdapter({ ...baseConfig, imageId: "fixed-image-uuid" });
  await adapter.createServer({
    profile: "bit",
    locationId: "dk",
    hostname: "mail.fixed.example",
    imageSlug: "ubuntu-2404",
    publicKey: SSH_KEY
  });
  const sent = JSON.parse(calls.find((c) => c.url.includes("/v1/compute/instances") && c.method === "POST")?.body ?? "{}");
  assert.equal(sent.imageId, "fixed-image-uuid");
});

// --- getServer -------------------------------------------------------------

test("getServer: running instance maps ipv4 from ipConfig.v4.ip", async () => {
  installFetch([
    tokenRoute(),
    {
      match: (url, m) => url.includes("/v1/compute/instances/") && m === "GET",
      respond: () =>
        Response.json({
          data: [
            {
              instanceId: 555,
              displayName: "mail.controlcorp.example",
              status: "running",
              region: "US-east",
              createdDate: "2026-06-11T12:00:00.000Z",
              ipConfig: { v4: { ip: "194.5.6.7" }, v6: { ip: "2a02:c::1" } }
            }
          ]
        })
    }
  ]);

  const adapter = new ContaboAdapter(baseConfig);
  const server = await adapter.getServer("contabo-555");
  assert.equal(server.slug, "contabo-555");
  assert.equal(server.status, "running");
  assert.equal(server.ipv4, "194.5.6.7");
  assert.equal(server.ipv6, "2a02:c::1");
  assert.equal(server.creationDate, "2026-06-11T12:00:00.000Z");
  assert.equal(server.accountId, "contabo");
  // It stripped the prefix to hit the API.
  const getCall = calls.find((c) => c.url.includes("/v1/compute/instances/"));
  assert.ok(getCall?.url.endsWith("/v1/compute/instances/555"), "stripped contabo- prefix for the API call");
});

test("getServer: provisioning instance has empty/null ipv4", async () => {
  installFetch([
    tokenRoute(),
    {
      match: (url, m) => url.includes("/v1/compute/instances/") && m === "GET",
      respond: () =>
        Response.json({
          data: [{ instanceId: 556, status: "provisioning", ipConfig: { v4: { ip: "" } } }]
        })
    }
  ]);

  const adapter = new ContaboAdapter(baseConfig);
  const server = await adapter.getServer("contabo-556");
  assert.equal(server.status, "provisioning");
  assert.equal(server.ipv4, "", "no ip until running");
});

// --- listServers -----------------------------------------------------------

test("listServers: maps the instance array to WebdockServer[]", async () => {
  installFetch([
    tokenRoute(),
    {
      match: (url, m) => url.includes("/v1/compute/instances") && m === "GET",
      respond: () =>
        Response.json({
          data: [
            { instanceId: 1, displayName: "mail.a.example", status: "running", ipConfig: { v4: { ip: "1.1.1.1" } }, createdDate: "2026-06-01T00:00:00.000Z" },
            { instanceId: 2, displayName: "mail.b.example", status: "stopped", ipConfig: { v4: { ip: "2.2.2.2" } }, createdDate: "2026-06-02T00:00:00.000Z" }
          ]
        })
    }
  ]);

  const adapter = new ContaboAdapter(baseConfig);
  const inventory = await adapter.listServers();
  assert.equal(inventory.source.kind, "live");
  assert.equal(inventory.source.responseOk, true);
  assert.equal(inventory.servers.length, 2);
  assert.deepEqual(
    inventory.servers.map((s) => [s.slug, s.status, s.ipv4]),
    [
      ["contabo-1", "running", "1.1.1.1"],
      ["contabo-2", "stopped", "2.2.2.2"]
    ]
  );
  assert.equal(inventory.servers[0].name, "mail.a.example");
  assert.equal(inventory.servers[1].creationDate, "2026-06-02T00:00:00.000Z");
});

test("listServers: missing creds returns empty live-degraded inventory without network", async () => {
  installFetch([
    {
      match: () => true,
      respond: () => {
        throw new Error("must not hit network without creds");
      }
    }
  ]);
  const adapter = new ContaboAdapter({ region: "US-east" });
  const inventory = await adapter.listServers();
  assert.equal(inventory.servers.length, 0);
  assert.equal(inventory.source.responseOk, false);
});

// --- deleteServer (cancel) -------------------------------------------------

test("deleteServer: hits the cancel endpoint and documents end-of-term", async () => {
  installFetch([
    tokenRoute(),
    {
      match: (url, m) => url.includes("/cancel") && m === "POST",
      respond: () => Response.json({ data: [{ instanceId: 555 }] }, { headers: { "x-request-id": "cancel-req" } })
    }
  ]);

  const adapter = new ContaboAdapter(baseConfig);
  const result = await adapter.deleteServer("contabo-555");
  assert.equal(result.serverSlug, "contabo-555");
  assert.equal(result.status, "deleting");
  assert.equal(result.eventId, "cancel-req");
  const cancelCall = calls.find((c) => c.url.includes("/cancel"));
  assert.ok(cancelCall?.url.endsWith("/v1/compute/instances/555/cancel"), "cancel endpoint with stripped id");
  assert.equal(cancelCall?.method, "POST");
  // End-of-term semantics surfaced for the gateway/audit.
  assert.match(result.source.errorMessage ?? "", /end-of-term/i);
});

// --- ensureServerSshAccess (near-noop secret) ------------------------------

test("ensureServerSshAccess: ensures the secret and returns secretId as publicKeyId", async () => {
  installFetch([
    tokenRoute(),
    {
      match: (url, m) => url.includes("/v1/secrets") && m === "GET",
      respond: () => Response.json({ data: [] })
    },
    {
      match: (url, m) => url.includes("/v1/secrets") && m === "POST",
      respond: () => Response.json({ data: [{ secretId: 88, name: "x" }] }, { status: 201 })
    }
  ]);

  const adapter = new ContaboAdapter(baseConfig);
  const result = await adapter.ensureServerSshAccess({ serverSlug: "contabo-1", publicKey: SSH_KEY });
  assert.equal(result.publicKeyId, 88);
  assert.equal(result.username, "root");
  assert.equal(result.shellUserId, null);
  assert.equal(result.shellUserEventId, null);
  assert.equal(result.sshSettingsEventId, null);
});

// --- classifyContaboFailure ------------------------------------------------

test("classifyContaboFailure: 402 and quota wording are recoverable; 400 is not", () => {
  const adapter = new ContaboAdapter(baseConfig);

  const paymentByStatus = adapter.classifyContaboFailure(402, "Payment Required");
  assert.equal(paymentByStatus.recoverable, true);
  assert.equal(paymentByStatus.code, "contabo_payment_failed");

  const quotaByBody = adapter.classifyContaboFailure(400, '{"message":"instance quota exceeded"}');
  assert.equal(quotaByBody.recoverable, true, "quota wording is recoverable even on a 400");
  assert.equal(quotaByBody.code, "contabo_payment_failed");

  const insufficient = adapter.classifyContaboFailure(403, "insufficient credit on account");
  assert.equal(insufficient.recoverable, true);

  const plain400 = adapter.classifyContaboFailure(400, '{"message":"invalid productId"}');
  assert.equal(plain400.recoverable, false, "a plain bad-request is NOT recoverable");
  assert.equal(plain400.code, "contabo_api_error");
});

test("createServer: a 402 from the instance POST throws a recoverable ContaboAdapterError", async () => {
  installFetch([
    tokenRoute(),
    {
      // Return a secret whose name matches the deterministic label so the
      // ssh-secret step is a no-op and the 402 under test comes from the POST.
      match: (url, m) => url.includes("/v1/secrets") && m === "GET",
      respond: (url) => {
        const name = decodeURIComponent(new URL(url).searchParams.get("name") ?? "");
        return Response.json({ data: [{ secretId: 1, name }] });
      }
    },
    {
      match: (url, m) => url.includes("/v1/compute/images") && m === "GET",
      respond: () => Response.json({ data: [{ imageId: "img", name: "Ubuntu 22.04" }] })
    },
    {
      match: (url, m) => url.includes("/v1/compute/instances") && m === "POST",
      respond: () => new Response("Payment Required", { status: 402 })
    }
  ]);

  const adapter = new ContaboAdapter(baseConfig);
  await assert.rejects(
    () =>
      adapter.createServer({
        profile: "bit",
        locationId: "dk",
        hostname: "mail.broke.example",
        imageSlug: "ubuntu-2404",
        publicKey: SSH_KEY
      }),
    (error: unknown) => {
      assert.ok(error instanceof ContaboAdapterError);
      assert.equal(error.code, "contabo_payment_failed");
      assert.equal(error.recoverable, true);
      return true;
    }
  );
});

// --- createContaboAdaptersFromEnv ------------------------------------------

test("createContaboAdaptersFromEnv: builds one adapter from the 4 OAuth2 creds", () => {
  const entries = createContaboAdaptersFromEnv({
    CONTABO_CLIENT_ID: "INT-15071666",
    CONTABO_CLIENT_SECRET: "secret",
    CONTABO_API_USER: "hostlatam@proton.me",
    CONTABO_API_PASSWORD: "p4ss$word",
    CONTABO_ACCOUNT_LABEL: "Contabo Host Latam"
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "contabo");
  assert.equal(entries[0].label, "Contabo Host Latam");
  assert.equal(entries[0].adapter.isLive(), true);
  assert.equal(entries[0].adapter.canCreate?.(), true);
  assert.equal(entries[0].adapter.canWrite?.(), true);
});

test("createContaboAdaptersFromEnv: returns [] when any core cred is missing", () => {
  assert.deepEqual(
    createContaboAdaptersFromEnv({
      CONTABO_CLIENT_ID: "INT-15071666",
      CONTABO_CLIENT_SECRET: "secret",
      CONTABO_API_USER: "hostlatam@proton.me"
      // CONTABO_API_PASSWORD missing
    }),
    []
  );
  // Empty/whitespace-only is treated as missing (normalizeEnvValue discipline).
  assert.deepEqual(
    createContaboAdaptersFromEnv({
      CONTABO_CLIENT_ID: "INT-15071666",
      CONTABO_CLIENT_SECRET: "secret",
      CONTABO_API_USER: "hostlatam@proton.me",
      CONTABO_API_PASSWORD: "   "
    }),
    []
  );
});

test("createContaboAdaptersFromEnv: ignores WEBDOCK_* keys entirely", () => {
  // Webdock keys present, Contabo creds absent -> no Contabo adapter.
  const onlyWebdock = createContaboAdaptersFromEnv({
    WEBDOCK_API_KEY: "legacy",
    WEBDOCK_API_KEY_PRIMARY: "primary",
    WEBDOCK_API_KEY_OPS: "ops",
    WEBDOCK_API_KEY_ACCOUNT: "account"
  });
  assert.deepEqual(onlyWebdock, [], "does not read any WEBDOCK_* key as a Contabo credential");

  // Webdock keys must not leak into the Contabo adapter when Contabo is configured.
  const mixed = createContaboAdaptersFromEnv({
    WEBDOCK_API_KEY_OPS: "ops",
    CONTABO_CLIENT_ID: "INT-15071666",
    CONTABO_CLIENT_SECRET: "secret",
    CONTABO_API_USER: "hostlatam@proton.me",
    CONTABO_API_PASSWORD: "p4ss"
  });
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].id, "contabo");
});

test("createContaboAdaptersFromEnv: honors CONTABO_REGION/PRODUCT_ID overrides in the POST", async () => {
  const entries = createContaboAdaptersFromEnv({
    CONTABO_CLIENT_ID: "INT-15071666",
    CONTABO_CLIENT_SECRET: "secret",
    CONTABO_API_USER: "hostlatam@proton.me",
    CONTABO_API_PASSWORD: "p4ss",
    CONTABO_REGION: "US-west",
    CONTABO_PRODUCT_ID: "V48"
  });
  installFetch([
    tokenRoute(),
    {
      match: (url, m) => url.includes("/v1/secrets") && m === "GET",
      respond: (url) => {
        const name = decodeURIComponent(new URL(url).searchParams.get("name") ?? "");
        return Response.json({ data: [{ secretId: 5, name }] });
      }
    },
    {
      match: (url, m) => url.includes("/v1/compute/images") && m === "GET",
      respond: () => Response.json({ data: [{ imageId: "img", name: "Ubuntu 22.04" }] })
    },
    {
      match: (url, m) => url.includes("/v1/compute/instances") && m === "POST",
      respond: () => Response.json({ data: [{ instanceId: 3, status: "provisioning" }] }, { status: 201 })
    }
  ]);
  await entries[0].adapter.createServer({
    profile: "bit",
    locationId: "dk",
    hostname: "mail.region.example",
    imageSlug: "ubuntu-2404",
    publicKey: SSH_KEY
  });
  const sent = JSON.parse(calls.find((c) => c.url.includes("/v1/compute/instances") && c.method === "POST")?.body ?? "{}");
  assert.equal(sent.region, "US-west");
  assert.equal(sent.productId, "V48");
});
