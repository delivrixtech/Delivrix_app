import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  VpsProvider,
  WebdockServer,
  WebdockSetServerMainDomainResult,
  WebdockSetServerPtrResult,
  WebdockSshCommandInput,
  WebdockSshCommandResult,
  WebdockSshRunner
} from "../../../../packages/adapters/src/index.ts";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";
import {
  handleBindWebdockMainDomain,
  type BindWebdockMainDomainAdapter,
  type BindWebdockMainDomainApprovalGuard,
  type FcrdnsResolver
} from "./webdock-bind-domain.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";

const fixedNowMs = Date.parse("2026-05-31T19:30:00.000Z");

test("bind_webdock_main_domain sets Webdock identity to smtp host and verifies FCrDNS", async () => {
  const calls: Array<{ method: string; mainDomain?: string; removeDefaultAlias?: boolean }> = [];
  const harness = routeHarness({
    fcrdnsResolver: fcrdnsOkResolver(),
    adapter: adapterMock({
      setServerIdentity: async (opts) => {
        calls.push({ method: "identity", mainDomain: opts.mainDomain, removeDefaultAlias: opts.removeDefaultAlias });
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.mainDomain, "smtp.example.com");
  assert.equal(response.body.identitySet, true);
  assert.equal(response.body.identityCallbackId, "cb-identity-1");
  assert.equal(response.body.ptrSet, true);
  assert.equal(response.body.fcrdnsVerified, true);
  assert.equal(response.body.alreadyBound, false);
  assert.deepEqual(calls, [{ method: "identity", mainDomain: "smtp.example.com", removeDefaultAlias: true }]);
  assert.equal(harness.auditEvents.some((event) => event.action === "oc.webdock.identity_aligned"), true);
  const inventory = await harness.workspace.readInventoryJson<{
    bindings: Array<{ domain: string; serverSlug: string | null; serverIp: string; status: string }>;
  }>("domains.json");
  assert.deepEqual(inventory?.bindings[0], {
    domain: "example.com",
    serverSlug: "server-abc123",
    serverIp: "192.0.2.55",
    status: "main_domain_bound"
  });
});

test("bind_webdock_main_domain is idempotent when Webdock identity is already aligned", async () => {
  let setIdentityCalls = 0;
  const harness = routeHarness({
    fcrdnsResolver: fcrdnsOkResolver(),
    adapter: adapterMock({
      server: serverFixture({ mainDomain: "smtp.example.com", hostname: "smtp.example.com" }),
      setServerIdentity: async (opts) => {
        setIdentityCalls += 1;
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.alreadyBound, true);
  assert.equal(response.body.identitySet, false);
  assert.equal(response.body.ptrSet, true);
  assert.equal(setIdentityCalls, 0);
});

test("bind_webdock_main_domain does not treat hostname as confirmed Webdock identity", async () => {
  let setIdentityCalls = 0;
  const harness = routeHarness({
    fcrdnsResolver: fcrdnsOkResolver(),
    adapter: adapterMock({
      server: serverFixture({ mainDomain: undefined, hostname: "smtp.example.com", name: "smtp.example.com" }),
      setServerIdentity: async (opts) => {
        setIdentityCalls += 1;
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.identitySet, true);
  assert.equal(setIdentityCalls, 1);
});

test("bind_webdock_main_domain returns 404 for missing server", async () => {
  const harness = routeHarness({
    adapter: adapterMock({
      getServer: async () => {
        throw new Error("missing");
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "server_not_found");
});

test("bind_webdock_main_domain rejects prohibited mail prefix", async () => {
  const harness = routeHarness();

  const response = await harness.request({
    ...validBody(),
    domain: "mail.example.com"
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_params");
  assert.match(JSON.stringify(response.body.details), /domain_has_prohibited_prefix/);
});

test("bind_webdock_main_domain returns pending instead of declaring success when FCrDNS is not aligned", async () => {
  const harness = routeHarness({
    fcrdnsResolver: {
      resolve4: async () => ["192.0.2.55"],
      reverse: async () => ["server-abc123.vps.webdock.cloud."]
    },
    fcrdnsMaxWaitMs: 0,
    adapter: adapterMock({
      setServerIdentity: async (opts) => {
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 424);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.ptrSet, false);
  assert.equal(response.body.ptrSkipReason, "fcrdns_pending");
  assert.equal(response.body.fcrdnsVerified, false);
  assert.equal(response.body.error, "fcrdns_pending");
  assert.equal(harness.auditEvents.at(-1)?.action, "oc.webdock.identity_pending_fcrdns");
  const inventory = await harness.workspace.readInventoryJson<{
    bindings: Array<{ domain: string; serverSlug: string | null; serverIp: string; status: string }>;
  }>("domains.json");
  assert.equal(inventory?.bindings[0]?.status, "identity_pending_fcrdns");
});

test("bind_webdock_main_domain fails closed when Webdock identity API fails", async () => {
  const harness = routeHarness({
    adapter: adapterMock({
      setServerIdentity: async () => {
        throw new Error("identity API boom");
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "identity_set_failed");
  assert.equal(harness.auditEvents.at(-1)?.action, "oc.webdock.identity_set_failed");
});

test("bind_webdock_main_domain rejects invalid approval before adapter calls", async () => {
  let getServerCalls = 0;
  const harness = routeHarness({
    approvalGuard: { verify: async () => ({ ok: false }) },
    adapter: adapterMock({
      getServer: async () => {
        getServerCalls += 1;
        return serverFixture();
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "approval_invalid");
  assert.equal(getServerCalls, 0);
});

test("bind_webdock_main_domain rejects PTR opt-out because FCrDNS is mandatory", async () => {
  let identityCalls = 0;
  const harness = routeHarness({
    adapter: adapterMock({
      setServerIdentity: async (opts) => {
        identityCalls += 1;
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request({
    ...validBody(),
    setPtr: false
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "fcrdns_required");
  assert.equal(identityCalls, 0);
});

// --- CONTABO BIND PATH (providerId no-Webdock) -----------------------------

test("bind: Contabo run sets hostname via SSH, emits manual-PTR audit, gates on FCrDNS, never calls Webdock setServerIdentity", async () => {
  let webdockIdentityCalls = 0;
  let webdockGetServerCalls = 0;
  const ssh = okSshRunner();
  const contaboGetCalls: string[] = [];
  const harness = routeHarness({
    providerId: "contabo",
    sshRunner: ssh,
    fcrdnsResolver: fcrdnsOkResolver(),
    vpsProviderAdapters: new Map<string, VpsProvider>([[
      "contabo",
      vpsProviderMock({
        getServer: async (slug) => {
          contaboGetCalls.push(slug);
          return contaboServerFixture();
        }
      })
    ]]),
    // El adapter Webdock NO debe tocarse en el camino Contabo: si lo hace, fallan estos spies.
    adapter: adapterMock({
      getServer: async () => {
        webdockGetServerCalls += 1;
        return serverFixture();
      },
      setServerIdentity: async () => {
        webdockIdentityCalls += 1;
        throw new Error("Webdock setServerIdentity must NOT be called on the Contabo path");
      }
    })
  });

  const response = await harness.request({
    serverSlug: "contabo-12345",
    domain: "example.com",
    setPtr: true,
    actorId: "operator/juanes",
    approvalToken: "approval-token"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.mainDomain, "smtp.example.com");
  assert.equal(response.body.identitySet, true);
  assert.equal(response.body.ptrSet, true);
  assert.equal(response.body.fcrdnsVerified, true);
  // Resolvio via el adapter Contabo, NO el Webdock.
  assert.deepEqual(contaboGetCalls, ["contabo-12345"]);
  assert.equal(webdockGetServerCalls, 0);
  assert.equal(webdockIdentityCalls, 0);
  // Hostname seteado por SSH: probe "hostname" + script con hostnamectl set-hostname.
  assert.equal(ssh.commands[0].trim(), "hostname");
  assert.equal(ssh.inputs.every((input) => input.serverSlug === "contabo-12345"), true);
  assert.match(ssh.commands[1], /hostnamectl set-hostname/);
  assert.doesNotMatch(ssh.commands[1], /\bsudo\b/);
  assert.match(ssh.commands[1], /127\.0\.1\.1/);
  // Audit de PTR manual con IP + PTR objetivo.
  const ptrEvent = harness.auditEvents.find((e) => e.action === "oc.bind.contabo_manual_ptr_required");
  assert.ok(ptrEvent, "emits oc.bind.contabo_manual_ptr_required");
  assert.equal((ptrEvent?.metadata as Record<string, unknown>).serverIp, "192.0.2.55");
  assert.equal((ptrEvent?.metadata as Record<string, unknown>).targetPtr, "smtp.example.com");
  // Cierre aligned (Contabo-specific action).
  assert.equal(harness.auditEvents.some((e) => e.action === "oc.bind.contabo_identity_aligned"), true);
});

test("bind: Contabo run ends advisory-pending (200) when FCrDNS does not verify yet", async () => {
  const ssh = okSshRunner();
  const harness = routeHarness({
    providerId: "contabo",
    sshRunner: ssh,
    // PTR aun no propagado: reverse NO devuelve smtp.example.com -> FCrDNS no verifica.
    fcrdnsResolver: {
      resolve4: async () => ["192.0.2.55"],
      reverse: async () => ["vmiXXXXX.contaboserver.net."]
    },
    fcrdnsMaxWaitMs: 0,
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", vpsProviderMock()]])
  });

  const response = await harness.request({
    serverSlug: "contabo-12345",
    domain: "example.com",
    setPtr: true,
    actorId: "operator/juanes",
    approvalToken: "approval-token"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.ptrSet, false);
  assert.equal(response.body.ptrSkipReason, "fcrdns_pending");
  assert.equal(response.body.fcrdnsVerified, false);
  assert.equal(response.body.fcrdnsStatus, "pending");
  assert.equal(response.body.error, undefined);
  assert.match(response.body.operatorAction, /Set rDNS\/PTR for 192\.0\.2\.55 to smtp\.example\.com/);
  // El hostname SI se seteo (eso no depende del PTR); el manual-PTR audit se emitio igual.
  assert.match(ssh.commands[1] ?? "", /hostnamectl set-hostname/);
  assert.equal(harness.auditEvents.some((e) => e.action === "oc.bind.contabo_manual_ptr_required"), true);
  assert.equal(harness.auditEvents.at(-1)?.action, "oc.bind.contabo_identity_pending_fcrdns");
  assert.equal(harness.auditEvents.at(-1)?.decision, "allow");
  assert.equal((harness.auditEvents.at(-1)?.metadata as Record<string, unknown>).nonBlocking, true);
});

test("bind: Contabo FCrDNS wait is bounded and returns advisory pending without handler timeout", async () => {
  const sleeps: number[] = [];
  let reverseAttempts = 0;
  const harness = routeHarness({
    providerId: "contabo",
    sshRunner: okSshRunner(),
    fcrdnsResolver: {
      resolve4: async () => ["192.0.2.55"],
      reverse: async () => {
        reverseAttempts += 1;
        return ["vmiXXXXX.contaboserver.net."];
      }
    },
    fcrdnsMaxWaitMs: 20_000,
    fcrdnsPollIntervalMs: 10_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", vpsProviderMock()]])
  });

  const response = await harness.request({
    serverSlug: "contabo-12345",
    domain: "example.com",
    setPtr: true,
    actorId: "operator/juanes",
    approvalToken: "approval-token"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.ptrSkipReason, "fcrdns_pending");
  assert.deepEqual(sleeps, [10_000, 10_000]);
  assert.equal(reverseAttempts, 3);
});

test("bind: Contabo run fails closed (502) when SSH hostname set fails", async () => {
  const harness = routeHarness({
    providerId: "contabo",
    sshRunner: {
      isConfigured: () => true,
      run: async (cmd) => {
        // probe "hostname" ok, pero el script de set-hostname falla (exitCode != 0).
        if (cmd.command.trim() === "hostname") return { stdout: "old.host", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "sudo: a password is required", exitCode: 1 };
      }
    },
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", vpsProviderMock()]])
  });

  const response = await harness.request({
    serverSlug: "contabo-12345",
    domain: "example.com",
    setPtr: true,
    actorId: "operator/juanes",
    approvalToken: "approval-token"
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "identity_set_failed");
  assert.equal(harness.auditEvents.at(-1)?.action, "oc.bind.contabo_hostname_set_failed");
});

test("bind: Webdock run (no providerId / registry miss) still calls Webdock setServerIdentity, NOT the Contabo path", async () => {
  // Re-asercion de no-regresion: con providerId ausente, el bind Webdock corre tal cual aunque el
  // registry tenga un adapter Contabo (no se consulta sin providerId). Tambien con providerId="webdock".
  let webdockIdentityCalls = 0;
  let contaboGetCalls = 0;
  const makeHarness = (providerId?: string) => routeHarness({
    ...(providerId ? { providerId } : {}),
    fcrdnsResolver: fcrdnsOkResolver(),
    vpsProviderAdapters: new Map<string, VpsProvider>([[
      "contabo",
      vpsProviderMock({
        getServer: async () => {
          contaboGetCalls += 1;
          return contaboServerFixture();
        }
      })
    ]]),
    adapter: adapterMock({
      setServerIdentity: async (opts) => {
        webdockIdentityCalls += 1;
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  // (a) sin providerId.
  const noProvider = await makeHarness().request(validBody());
  assert.equal(noProvider.statusCode, 200);
  assert.equal(noProvider.body.identitySet, true);

  // (b) providerId="webdock" (normaliza a Webdock).
  const webdockProvider = await makeHarness("webdock").request(validBody());
  assert.equal(webdockProvider.statusCode, 200);

  assert.equal(webdockIdentityCalls, 2, "Webdock setServerIdentity called for both Webdock runs");
  assert.equal(contaboGetCalls, 0, "Contabo adapter never consulted without a non-webdock providerId");
});

function routeHarness(input: {
  adapter?: BindWebdockMainDomainAdapter;
  approvalGuard?: BindWebdockMainDomainApprovalGuard;
  fcrdnsResolver?: FcrdnsResolver;
  fcrdnsMaxWaitMs?: number;
  fcrdnsPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // Canal HERMANO providerId + registry: si se pasan, el bind toma el camino del proveedor no-Webdock.
  providerId?: string;
  vpsProviderAdapters?: Map<string, VpsProvider>;
  sshRunner?: WebdockSshRunner;
} = {}) {
  const auditEvents: AuditEventInput[] = [];
  const workspace = new OpenClawWorkspace({
    rootDir: mkdtempSync(join(tmpdir(), "webdock-bind-route-"))
  });
  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    await handleBindWebdockMainDomain({
      request: requestWithJson(body),
      response: response as unknown as ServerResponse,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      deps: {
        auditLog: {
          append: async (event) => {
            auditEvents.push(event);
            return { id: `evt-${auditEvents.length}` };
          }
        },
        approvalGuard: input.approvalGuard ?? { verify: async () => ({ ok: true, eventId: "approval-1" }) },
        webdockAdapter: input.adapter ?? adapterMock(),
        ...(input.vpsProviderAdapters ? { vpsProviderAdapters: input.vpsProviderAdapters } : {}),
        ...(input.sshRunner ? { sshRunner: input.sshRunner } : {}),
        workspace,
        now: () => fixedNowMs + auditEvents.length,
        fcrdnsResolver: input.fcrdnsResolver ?? fcrdnsOkResolver(),
        fcrdnsMaxWaitMs: input.fcrdnsMaxWaitMs ?? 0,
        fcrdnsPollIntervalMs: input.fcrdnsPollIntervalMs ?? 0,
        ...(input.sleep ? { sleep: input.sleep } : {})
      }
    });
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return { request: route, auditEvents, workspace };
}

function adapterMock(overrides: Partial<BindWebdockMainDomainAdapter> & {
  server?: WebdockServer;
} = {}): BindWebdockMainDomainAdapter {
  return {
    getServer: overrides.getServer ?? (async () => overrides.server ?? serverFixture()),
    setServerIdentity: overrides.setServerIdentity ?? (async (opts) => ({
      ok: true,
      serverSlug: opts.serverSlug,
      mainDomain: opts.mainDomain,
      callbackId: "cb-identity-1",
      raw: {}
    })),
    setServerMainDomain: overrides.setServerMainDomain ?? (async (): Promise<WebdockSetServerMainDomainResult> => ({
      ok: true,
      previousMainDomain: "old.example.com",
      raw: {}
    })),
    setServerPtr: overrides.setServerPtr ?? (async (): Promise<WebdockSetServerPtrResult> => ({
      ok: true,
      supported: true,
      raw: {}
    }))
  };
}

function fcrdnsOkResolver(): FcrdnsResolver {
  return {
    resolve4: async () => ["192.0.2.55"],
    reverse: async () => ["smtp.example.com."]
  };
}

/** VpsProvider mock (Contabo) para el camino no-Webdock del bind. getServer override-able. */
function vpsProviderMock(overrides: Partial<VpsProvider> = {}): VpsProvider {
  return {
    isLive: () => true,
    canWrite: () => true,
    canCreate: () => true,
    createServer: async () => {
      throw new Error("createServer not used in bind");
    },
    getServer: overrides.getServer ?? (async () => contaboServerFixture()),
    ...overrides
  };
}

/**
 * SSH runner mock que simula `hostnamectl set-hostname`: el 1er run ("hostname") devuelve el hostname
 * previo; el 2do run (el script) devuelve la FQDN como stdout. Registra cada comando para asserts.
 */
function okSshRunner(opts: { previousHostname?: string; finalHostname?: string } = {}): WebdockSshRunner & {
  commands: string[];
  inputs: WebdockSshCommandInput[];
} {
  const commands: string[] = [];
  const inputs: WebdockSshCommandInput[] = [];
  const previousHostname = opts.previousHostname ?? "vmiXXXXX.contaboserver.net";
  const finalHostname = opts.finalHostname ?? "smtp.example.com";
  return {
    commands,
    inputs,
    isConfigured: () => true,
    run: async (cmd): Promise<WebdockSshCommandResult> => {
      inputs.push(cmd);
      commands.push(cmd.command);
      const isHostnameProbe = cmd.command.trim() === "hostname";
      return {
        stdout: isHostnameProbe ? previousHostname : finalHostname,
        stderr: "",
        exitCode: 0
      };
    }
  };
}

function contaboServerFixture(overrides: Partial<WebdockServer> = {}): WebdockServer {
  return {
    slug: "contabo-12345",
    name: "contabo-12345",
    mainDomain: "",
    hostname: "vmiXXXXX.contaboserver.net",
    ipv4: "192.0.2.55",
    status: "running",
    ...overrides
  };
}

function serverFixture(overrides: Partial<WebdockServer> = {}): WebdockServer {
  return {
    slug: "server-abc123",
    name: "old.example.com",
    mainDomain: "old.example.com",
    hostname: "old.example.com",
    ipv4: "192.0.2.55",
    status: "running",
    ...overrides
  };
}

function validBody(): Record<string, unknown> {
  return {
    serverSlug: "server-abc123",
    domain: "example.com",
    setPtr: true,
    actorId: "operator/juanes",
    approvalToken: "approval-token"
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/skills/bind-webdock-main-domain",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}
