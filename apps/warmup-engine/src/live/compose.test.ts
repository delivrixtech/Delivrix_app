import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveAuthCheckers,
  createLiveSeedInboxClient,
  createLivePostfixTransport,
  createWarmupTransport,
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

const smtpCreds = { smtp: { user: "u", secretRef: "vault://x" } };

test("createWarmupTransport: fail-closed sin WARMUP_ENGINE_ENABLE (no importa el flag de transporte)", () => {
  assert.throws(
    () => createWarmupTransport(config, smtpCreds, { WARMUP_TRANSPORT: "postfix", WARMUP_SMTP_HOST: "smtp.x" }),
    /warmup_engine_disabled/
  );
  assert.throws(() => createWarmupTransport(config, smtpCreds, {}), /warmup_engine_disabled/);
});

test("createWarmupTransport: WARMUP_TRANSPORT=mock (o default) selecciona MockTransport", () => {
  const def = createWarmupTransport(config, {}, ON);
  assert.equal(def.kind, "mock");
  const mock = createWarmupTransport(config, {}, { ...ON, WARMUP_TRANSPORT: "mock" });
  assert.equal(mock.kind, "mock");
});

test("createWarmupTransport: WARMUP_TRANSPORT=postfix selecciona PostfixTransport (contra WARMUP_SMTP_HOST)", () => {
  const transport = createWarmupTransport(config, smtpCreds, {
    ...ON,
    WARMUP_TRANSPORT: "postfix",
    WARMUP_SMTP_HOST: "smtp.x",
    WARMUP_SMTP_PORT: "587"
  });
  assert.equal(transport.kind, "postfix");
  assert.equal(typeof transport.send, "function");
});

test("createWarmupTransport: valor inválido cae con gracia a mock (no lanza)", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg?: unknown) => warnings.push(String(msg));
  let transport;
  try {
    transport = createWarmupTransport(config, {}, { ...ON, WARMUP_TRANSPORT: "ses" });
  } finally {
    console.warn = original;
  }
  assert.equal(transport.kind, "mock");
  assert.match(warnings.join("\n"), /warmup_transport_invalid/);
});

test("createWarmupTransport: postfix sin WARMUP_SMTP_HOST LANZA (fail-closed)", () => {
  assert.throws(
    () => createWarmupTransport(config, smtpCreds, { ...ON, WARMUP_TRANSPORT: "postfix" }),
    /warmup_smtp_host_missing/
  );
});

test("createWarmupTransport: postfix sin credenciales del nodo LANZA", () => {
  assert.throws(
    () => createWarmupTransport(config, {}, { ...ON, WARMUP_TRANSPORT: "postfix", WARMUP_SMTP_HOST: "smtp.x" }),
    /warmup_transport_postfix_requires_credentials/
  );
});
