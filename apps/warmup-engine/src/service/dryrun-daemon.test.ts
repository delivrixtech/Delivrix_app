import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDryRunDeps,
  createDryRunTransport,
  dryRunRecipient,
  dryRunTestId,
  noopImapClient,
  resolveDryRunImapClient,
  type DryRunImapLogger
} from "./dryrun-daemon.ts";
import { MockTransport } from "../runtime/transport.ts";
import type { WarmupNode } from "../domain/types.ts";
import type { WarmupStores } from "../store/ports.ts";
import type { ImapClient } from "../reader/imap-placement-reader.ts";

function node(over: Partial<WarmupNode> = {}): WarmupNode {
  return {
    id: "n1", mailbox: "a@d.test", domain: "d.test", infraType: "postfix",
    state: "fresh", authReady: true, dailyLimit: 10, increaseByDay: 1, dayIndex: 0,
    weekdaysOnly: false, ...over
  };
}

// Stores placeholder: buildDryRunDeps sólo los referencia, no los invoca.
const stores = {} as unknown as WarmupStores;

test("createDryRunTransport: default env ⇒ MockTransport (kind=mock, cero red)", () => {
  const t = createDryRunTransport({});
  assert.ok(t instanceof MockTransport);
  assert.equal(t.kind, "mock");
});

test("createDryRunTransport: mock explícito ⇒ MockTransport", () => {
  const t = createDryRunTransport({ WARMUP_TRANSPORT: "mock" });
  assert.equal(t.kind, "mock");
});

test("createDryRunTransport: postfix ⇒ REHÚSA arrancar (fail-closed, no envía real)", () => {
  assert.throws(
    () => createDryRunTransport({ WARMUP_TRANSPORT: "postfix" }),
    /warmup_dryrun_requires_mock_transport/
  );
});

test("noopImapClient.search ⇒ [] siempre (no abre IMAP)", async () => {
  const rows = await noopImapClient.search({ headerName: "X", headerValue: "y" });
  assert.deepEqual(rows, []);
});

test("dryRunRecipient: determinista y a TLD reservado .invalid", () => {
  const r1 = dryRunRecipient(node({ id: "abc" }), 3);
  const r2 = dryRunRecipient(node({ id: "abc" }), 3);
  assert.equal(r1, r2);
  assert.match(r1, /@warmup\.invalid$/);
});

test("dryRunTestId: determinista por (nodo, seed)", () => {
  assert.equal(dryRunTestId(node({ id: "abc" }), "seed1"), dryRunTestId(node({ id: "abc" }), "seed1"));
  assert.notEqual(dryRunTestId(node({ id: "abc" }), "seed1"), dryRunTestId(node({ id: "abc" }), "seed2"));
});

test("buildDryRunDeps: cablea transporte MOCK + IMAP no-op + helpers deterministas", () => {
  const { deps, transport } = buildDryRunDeps(stores, { now: new Date("2026-07-16T00:00:00Z"), env: {} });
  assert.equal(transport.kind, "mock");
  assert.equal(deps.transport, transport);
  assert.equal(deps.imapClient, noopImapClient);
  assert.equal(deps.pickRecipient(node(), 0), dryRunRecipient(node(), 0));
  assert.equal(deps.newTestId(node(), "s"), dryRunTestId(node(), "s"));
  assert.equal(transport.sent.length, 0);
});

test("buildDryRunDeps: rechaza WARMUP_TRANSPORT=postfix vía createDryRunTransport", () => {
  assert.throws(
    () => buildDryRunDeps(stores, { now: new Date(), env: { WARMUP_TRANSPORT: "postfix" } }),
    /warmup_dryrun_requires_mock_transport/
  );
});

// ── Gating de la LECTURA OAuth (WARMUP_GMAIL_OAUTH_ENABLE) ───────────────────────────────────────────

function recordingLogger(): DryRunImapLogger & { infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return { infos, warns, info: (m) => infos.push(m), warn: (m) => warns.push(m) };
}

test("resolveDryRunImapClient: flag OFF ⇒ no-op (no lee el seed real)", async () => {
  const logger = recordingLogger();
  const c = await resolveDryRunImapClient({}, { logger });
  assert.equal(c, noopImapClient);
  assert.equal(logger.infos.length, 0);
  assert.equal(logger.warns.length, 0);
});

test("resolveDryRunImapClient: flag ON + config OK ⇒ usa el cliente OAuth (no el no-op)", async () => {
  const logger = recordingLogger();
  const sentinel: ImapClient = { async search() { return []; } };
  const c = await resolveDryRunImapClient(
    { WARMUP_GMAIL_OAUTH_ENABLE: "true" },
    { logger, buildOAuthImapClient: async () => sentinel }
  );
  assert.equal(c, sentinel);
  assert.ok(logger.infos.some((l) => l.includes("LECTURA real")));
  assert.ok(logger.infos.some((l) => l.includes("MockTransport")));
});

test("resolveDryRunImapClient: flag ON + config inválida ⇒ fallback no-op (fail-closed, no crashea)", async () => {
  const logger = recordingLogger();
  const c = await resolveDryRunImapClient(
    { WARMUP_GMAIL_OAUTH_ENABLE: "1" },
    {
      logger,
      buildOAuthImapClient: async () => {
        throw new Error("warmup_oauth_config_missing: no such file");
      }
    }
  );
  assert.equal(c, noopImapClient);
  assert.ok(logger.warns.some((l) => l.includes("no-op")));
  // El warning lleva el código del error, no secretos.
  assert.ok(logger.warns.some((l) => l.includes("warmup_oauth_config_missing")));
});
