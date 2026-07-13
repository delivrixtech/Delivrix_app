import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

interface PendingApprovalGateModule {
  normalizeProposalPreflight: (
    raw: unknown
  ) => { willFail: boolean; reason: string | null } | null;
}

let server: ViteDevServer | null = null;

async function loadModule(): Promise<PendingApprovalGateModule> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server.ssrLoadModule(
    "/src/features/canvas/PendingApprovalGate.tsx"
  ) as Promise<PendingApprovalGateModule>;
}

after(async () => {
  await server?.close();
});

test("normalizeProposalPreflight reads willFail + reason (PR-05)", async () => {
  const { normalizeProposalPreflight } = await loadModule();
  const result = normalizeProposalPreflight({
    willFail: true,
    reason: "provider contabo-2 sin credenciales en el env canónico"
  });
  assert.deepEqual(result, {
    willFail: true,
    reason: "provider contabo-2 sin credenciales en el env canónico"
  });
});

test("normalizeProposalPreflight joins a reasons array (PR-05)", async () => {
  const { normalizeProposalPreflight } = await loadModule();
  const result = normalizeProposalPreflight({
    willFail: true,
    reasons: ["dominio comprado sin SMTP", "run previo failed"]
  });
  assert.equal(result?.willFail, true);
  assert.equal(result?.reason, "dominio comprado sin SMTP · run previo failed");
});

test("normalizeProposalPreflight falls back to message and tolerates willFail=false (PR-05)", async () => {
  const { normalizeProposalPreflight } = await loadModule();
  assert.deepEqual(normalizeProposalPreflight({ willFail: false }), {
    willFail: false,
    reason: null
  });
  assert.deepEqual(normalizeProposalPreflight({ willFail: true, message: "scope drift" }), {
    willFail: true,
    reason: "scope drift"
  });
});

test("normalizeProposalPreflight returns null for uninterpretable payloads (PR-05)", async () => {
  const { normalizeProposalPreflight } = await loadModule();
  assert.equal(normalizeProposalPreflight(null), null);
  assert.equal(normalizeProposalPreflight({ noWillFail: true }), null);
  assert.equal(normalizeProposalPreflight("nope"), null);
});
