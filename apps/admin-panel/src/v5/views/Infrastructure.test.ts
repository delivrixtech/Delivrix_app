import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

interface NormalizedSmtpUnit {
  key: string;
  state: string;
  domain?: string;
  smtpHost?: string;
  serverSlug?: string;
  serverIp?: string;
  since?: string;
  credentialStatus?: string;
  tlsStatus?: string;
  evidence: string[];
  issues: Array<{ code?: string; severity?: string; message?: string; fix?: { text: string; docRef?: string } }>;
  fixes: Array<{ text: string; docRef?: string; kind?: string }>;
}

interface NormalizedSmtpHealth {
  available: boolean;
  generatedAt?: string;
  dataSource?: string;
  units: NormalizedSmtpUnit[];
  summary: Record<string, number> | null;
}

interface InfrastructureModule {
  normalizeSmtpHealth: (raw: unknown) => NormalizedSmtpHealth;
  smtpStateGroup: (state: string | undefined) => string;
  deriveSmtpHealthTarget: (
    provider: Record<string, unknown>
  ) => { providerId: string; accountId: string } | null;
}

let server: ViteDevServer | null = null;

async function loadModule(): Promise<InfrastructureModule> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server.ssrLoadModule("/src/v5/views/Infrastructure.tsx") as Promise<InfrastructureModule>;
}

after(async () => {
  await server?.close();
});

test("normalizeSmtpHealth reads the envelope shape with units + unattachedOrphans (PR-10)", async () => {
  const { normalizeSmtpHealth } = await loadModule();
  const health = normalizeSmtpHealth({
    generatedAt: "2026-07-13T18:00:00Z",
    dataSource: "live",
    summary: { active: 1, error: 1 },
    units: [
      {
        state: "error",
        domain: "annualfilinginfra.com",
        serverSlug: "contabo-203438762",
        serverIp: "80.190.75.38",
        smtpHost: "smtp.annualfilinginfra.com",
        tlsStatus: "ok",
        evidence: [{ source: "smtp-runs", runId: "smtp-x", runStatus: "failed" }],
        issues: [
          {
            code: "domain_registration_pending",
            severity: "warning",
            message: "Route53 pendiente",
            suggestedFix: { kind: "wait_and_verify", text: "Esperar y reverificar.", docRef: "I4/O8" }
          }
        ]
      }
    ],
    unattachedOrphans: [
      { state: "orphan.server_without_domain", serverSlug: "contabo-203431700", evidence: [] }
    ]
  });

  assert.equal(health.available, true);
  assert.equal(health.units.length, 2);
  assert.equal(health.dataSource, "live");
  const errorUnit = health.units[0];
  assert.equal(errorUnit.state, "error");
  assert.equal(errorUnit.evidence[0], "smtp-runs: failed (smtp-x)");
  assert.equal(errorUnit.fixes.length, 1);
  assert.equal(errorUnit.fixes[0].text, "Esperar y reverificar.");
  assert.equal(errorUnit.fixes[0].docRef, "I4/O8");
});

test("normalizeSmtpHealth reads the bare array shape and a top-level suggestedFix (PR-10)", async () => {
  const { normalizeSmtpHealth } = await loadModule();
  const health = normalizeSmtpHealth([
    {
      state: "down",
      domain: "example.com",
      smtpHost: "smtp.example.com",
      since: "2026-07-13T10:00:00Z",
      suggestedFix: "Reiniciar el server y reintentar el run."
    }
  ]);
  assert.equal(health.available, true);
  assert.equal(health.summary, null);
  assert.equal(health.units.length, 1);
  assert.equal(health.units[0].fixes[0].text, "Reiniciar el server y reintentar el run.");
  assert.equal(health.units[0].since, "2026-07-13T10:00:00Z");
});

test("normalizeSmtpHealth returns unavailable for non-object payloads (PR-10)", async () => {
  const { normalizeSmtpHealth } = await loadModule();
  const health = normalizeSmtpHealth(null);
  assert.equal(health.available, false);
  assert.deepEqual(health.units, []);
});

test("smtpStateGroup buckets states into UI groups (PR-10)", async () => {
  const { smtpStateGroup } = await loadModule();
  assert.equal(smtpStateGroup("active"), "active");
  assert.equal(smtpStateGroup("down"), "down");
  assert.equal(smtpStateGroup("error"), "error");
  assert.equal(smtpStateGroup("orphan.domain_without_smtp"), "orphan");
  assert.equal(smtpStateGroup("orphan.server_without_domain"), "orphan");
  assert.equal(smtpStateGroup("no_smtp"), "no_smtp");
  assert.equal(smtpStateGroup("pending_registration"), "pending");
  assert.equal(smtpStateGroup("weird"), "other");
  assert.equal(smtpStateGroup(undefined), "other");
});

test("deriveSmtpHealthTarget only targets Webdock/Contabo compute accounts (PR-10)", async () => {
  const { deriveSmtpHealthTarget } = await loadModule();
  const base = {
    displayName: "InfraVPS",
    kind: "compute",
    status: "active",
    itemCount: 20,
    lastFetched: null,
    fetchSourceKind: "live",
    capabilities: []
  };
  assert.deepEqual(deriveSmtpHealthTarget({ ...base, id: "contabo-2" }), {
    providerId: "contabo",
    accountId: "contabo-2"
  });
  assert.deepEqual(deriveSmtpHealthTarget({ ...base, id: "webdock-primary" }), {
    providerId: "webdock",
    accountId: "webdock-primary"
  });
  assert.equal(deriveSmtpHealthTarget({ ...base, id: "aws-bedrock" }), null);
  assert.equal(deriveSmtpHealthTarget({ ...base, id: "ionos-cloud-dns", kind: "dns" }), null);
});
