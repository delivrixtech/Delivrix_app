import assert from "node:assert/strict";
import test from "node:test";

import {
  ProxmoxAdapterError,
  ProxmoxRealAdapter,
  createProxmoxAdaptersFromEnv
} from "./proxmox-real-adapter.ts";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function makeFetch(routes: Array<{ match: (url: string, method: string) => boolean; respond: Route }>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = normalizeHeaders(init.headers);
    const body = typeof init.body === "string" ? init.body : undefined;
    calls.push({ url, method, headers, body });
    const route = routes.find((item) => item.match(url, method));
    if (!route) {
      throw new Error(`No mock route for ${method} ${url}`);
    }
    return route.respond(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("createProxmoxAdaptersFromEnv is additive and registers provider id proxmox", () => {
  assert.deepEqual(createProxmoxAdaptersFromEnv({}), []);

  const entries = createProxmoxAdaptersFromEnv({
    PROXMOX_API_URL: "https://pve.example.test:8006/api2/json",
    PROXMOX_TOKEN_ID: "delivrix@pve!provisioner",
    PROXMOX_TOKEN_SECRET: "super-secret",
    PROXMOX_ACCOUNT_ID: "cool-a2",
    PROXMOX_ACCOUNT_LABEL: "Cool A2",
    PROXMOX_TEST_NET0: "name=eth0,bridge=vmbr0,ip=10.250.0.10/24,gw=10.250.0.1",
    PROXMOX_HOST_SSH_TARGET: "root@pve.example.test"
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "proxmox");
  assert.equal(entries[0].label, "Cool A2");
  assert.equal(entries[0].adapter.isLive(), true);
  assert.equal(entries[0].adapter.canCreate?.(), true);
});

test("createServer clones full LXC, configures net0, starts and injects SSH by pct exec", async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const { fetchImpl, calls } = makeFetch([
    route("GET", "/cluster/nextid", () => Response.json({ data: 901 })),
    route("POST", "/nodes/cool-pve1/lxc/9000/clone", () => Response.json({ data: "UPID:clone" })),
    route("GET", "/tasks/UPID%3Aclone/status", () => Response.json({ data: { status: "stopped", exitstatus: "OK" } })),
    route("PUT", "/nodes/cool-pve1/lxc/901/config", () => Response.json({ data: null })),
    route("POST", "/nodes/cool-pve1/lxc/901/status/start", () => Response.json({ data: "UPID:start" })),
    route("GET", "/tasks/UPID%3Astart/status", () => Response.json({ data: { status: "stopped", exitstatus: "OK" } }))
  ]);
  const adapter = new ProxmoxRealAdapter({
    apiUrl: "https://pve.example.test:8006/api2/json",
    tokenId: "delivrix@pve!provisioner",
    tokenSecret: "super-secret",
    testNet0: "name=eth0,bridge=vmbr0,ip=10.250.0.10/24,gw=10.250.0.1",
    hostSshTarget: "root@pve.example.test",
    fetchImpl,
    sleep: async () => {},
    execFile: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: "", stderr: "" };
    },
    now: () => new Date("2026-06-29T12:00:00.000Z")
  });

  const created = await adapter.createServer({
    profile: "bit",
    locationId: "dk",
    hostname: "smtp.example.com",
    imageSlug: "ubuntu-2404",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY delivrix"
  });

  assert.equal(created.serverSlug, "proxmox-901");
  assert.equal(created.status, "running");
  assert.equal(created.ipv4, "10.250.0.10");
  const clone = calls.find((call) => call.method === "POST" && call.url.endsWith("/lxc/9000/clone"));
  assert.ok(clone);
  assert.equal(new URLSearchParams(clone.body).get("full"), "1");
  assert.equal(new URLSearchParams(clone.body).get("storage"), "local");
  const config = calls.find((call) => call.method === "PUT" && call.url.endsWith("/lxc/901/config"));
  assert.ok(config);
  assert.equal(
    new URLSearchParams(config.body).get("net0"),
    "name=eth0,bridge=vmbr0,ip=10.250.0.10/24,gw=10.250.0.1"
  );
  assert.equal(new URLSearchParams(config.body).get("description"), "delivrix-created=2026-06-29T12:00:00.000Z");
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].file, "ssh");
  assert.match(execCalls[0].args.join(" "), /pct exec 901 -- bash -lc/);
  assert.match(execCalls[0].args.join(" "), /authorized_keys/);
});

test("listServers maps Proxmox LXC resources and parses creation date from description", async () => {
  const { fetchImpl } = makeFetch([
    route("GET", "/nodes/cool-pve1/lxc", () =>
      Response.json({ data: [{ vmid: 901, status: "running", name: "smtp.example.com" }] })
    ),
    route("GET", "/nodes/cool-pve1/lxc/901/config", () =>
      Response.json({
        data: {
          hostname: "smtp.example.com",
          net0: "name=eth0,bridge=vmbr0,ip=10.250.0.10/24,gw=10.250.0.1",
          description: "delivrix-created=2026-06-29T12:00:00.000Z"
        }
      })
    )
  ]);
  const adapter = new ProxmoxRealAdapter({
    apiUrl: "https://pve.example.test:8006/api2/json",
    tokenId: "delivrix@pve!provisioner",
    tokenSecret: "super-secret",
    fetchImpl,
    now: () => new Date("2026-06-29T12:30:00.000Z"),
    cacheTtlMs: 0
  });

  const inventory = await adapter.listServers();

  assert.equal(inventory.source.responseOk, true);
  assert.equal(inventory.servers.length, 1);
  assert.equal(inventory.servers[0].slug, "proxmox-901");
  assert.equal(inventory.servers[0].status, "running");
  assert.equal(inventory.servers[0].ipv4, "10.250.0.10");
  assert.equal(inventory.servers[0].creationDate, "2026-06-29T12:00:00.000Z");
  assert.equal(inventory.servers[0].accountId, "proxmox");
});

test("deleteServer destroys by VMID with DELETE query params instead of body", async () => {
  const { fetchImpl, calls } = makeFetch([
    route("DELETE", "/nodes/cool-pve1/lxc/901", () => Response.json({ data: "UPID:delete" })),
    route("GET", "/tasks/UPID%3Adelete/status", () => Response.json({ data: { status: "stopped", exitstatus: "OK" } }))
  ]);
  const adapter = new ProxmoxRealAdapter({
    apiUrl: "https://pve.example.test:8006/api2/json",
    tokenId: "delivrix@pve!provisioner",
    tokenSecret: "super-secret",
    fetchImpl,
    sleep: async () => {}
  });

  const deleted = await adapter.deleteServer("proxmox-901");

  assert.equal(deleted.serverSlug, "proxmox-901");
  assert.equal(deleted.eventId, "UPID:delete");
  const destroy = calls.find((call) => call.method === "DELETE");
  assert.ok(destroy);
  assert.equal(destroy.body, undefined);
  assert.equal(new URL(destroy.url).searchParams.get("purge"), "1");
  assert.equal(new URL(destroy.url).searchParams.get("destroyUnreferencedDisks"), "1");
});

test("createServer fails before clone when guest setup or network config is unavailable", async () => {
  const { fetchImpl, calls } = makeFetch([]);
  const adapter = new ProxmoxRealAdapter({
    apiUrl: "https://pve.example.test:8006/api2/json",
    tokenId: "delivrix@pve!provisioner",
    tokenSecret: "super-secret",
    fetchImpl
  });

  await assert.rejects(
    () =>
      adapter.createServer({
        profile: "bit",
        locationId: "dk",
        hostname: "smtp.example.com",
        imageSlug: "ubuntu-2404",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY delivrix"
      }),
    (error: unknown) => error instanceof ProxmoxAdapterError && error.code === "proxmox_guest_setup_not_configured"
  );
  assert.equal(calls.length, 0);
});

function route(method: string, suffix: string, respond: Route): { match: (url: string, method: string) => boolean; respond: Route } {
  return {
    match: (url, actualMethod) => actualMethod === method && new URL(url).pathname.endsWith(suffix),
    respond
  };
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
