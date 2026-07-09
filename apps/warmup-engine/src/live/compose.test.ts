import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveAuthCheckers,
  createLiveSeedInboxClient,
  createLivePostfixTransport,
  type LiveWarmupConfig
} from "./compose.ts";
import { V1_REQUIRED_CHECKS } from "../domain/auth-checks.ts";

const config: LiveWarmupConfig = {
  secretResolver: { resolve: async () => ({ user: "u", pass: "p" }) },
  scheduleProvider: () => ({ active: true }),
  unsubProvider: () => ({ enabled: true, endpoint: "https://unsub.example.com/x" })
};

const ON = { WARMUP_ENGINE_ENABLE: "true" };

test("con el flag OFF, el cableado en vivo LANZA (nada real se construye)", () => {
  assert.throws(() => createLiveAuthCheckers(config, {}), /warmup_engine_disabled/);
  assert.throws(() => createLiveSeedInboxClient(config, { host: "imap.x", port: 993, user: "u", secretRef: "vault://x" }, {}), /warmup_engine_disabled/);
  assert.throws(() => createLivePostfixTransport(config, { host: "smtp.x", port: 587, user: "u", secretRef: "vault://x" }, {}), /warmup_engine_disabled/);
});

test("con el flag ON, arma los 13 checkers del §8 (sin abrir red)", () => {
  const checkers = createLiveAuthCheckers(config, ON);
  const covered = new Set(checkers.flatMap((c) => c.ids));
  for (const id of V1_REQUIRED_CHECKS) {
    assert.equal(covered.has(id), true, `falta checker para ${id}`);
  }
});

test("con el flag ON, construye el ImapClient y el transporte (perezosos, sin conectar)", () => {
  const client = createLiveSeedInboxClient(config, { host: "imap.x", port: 993, user: "u", secretRef: "vault://x" }, ON);
  assert.equal(typeof client.search, "function");
  const transport = createLivePostfixTransport(config, { host: "smtp.x", port: 587, user: "u", secretRef: "vault://x" }, ON);
  assert.equal(typeof transport.send, "function");
  assert.equal(transport.kind, "postfix");
});
