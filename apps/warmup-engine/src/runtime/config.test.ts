import assert from "node:assert/strict";
import test from "node:test";
import {
  warmupEngineEnabled,
  assertWarmupEngineEnabled,
  warmupTransportKind,
  readWarmupSmtpConfig,
  warmupPlacementMin,
  DEFAULT_WARMUP_PLACEMENT_MIN
} from "./config.ts";

/** Silencia console.warn dentro de `fn` (los fallbacks de config avisan por warning). */
function withSilencedWarn<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

test("default OFF: sin la var el engine está inerte", () => {
  assert.equal(warmupEngineEnabled({}), false);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "" }), false);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "false" }), false);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "0" }), false);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "no" }), false);
});

test("ON solo con true/1 explícito", () => {
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "true" }), true);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "TRUE" }), true);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "1" }), true);
});

test("assertWarmupEngineEnabled lanza si está OFF y no lanza si está ON", () => {
  assert.throws(() => assertWarmupEngineEnabled({}), /warmup_engine_disabled/);
  assert.doesNotThrow(() => assertWarmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "true" }));
});

test("warmupTransportKind: default mock (fail-safe) sin la var o vacía", () => {
  assert.equal(warmupTransportKind({}), "mock");
  assert.equal(warmupTransportKind({ WARMUP_TRANSPORT: "" }), "mock");
  assert.equal(warmupTransportKind({ WARMUP_TRANSPORT: "   " }), "mock");
});

test("warmupTransportKind: postfix/mock válidos (case-insensitive)", () => {
  assert.equal(warmupTransportKind({ WARMUP_TRANSPORT: "postfix" }), "postfix");
  assert.equal(warmupTransportKind({ WARMUP_TRANSPORT: "POSTFIX" }), "postfix");
  assert.equal(warmupTransportKind({ WARMUP_TRANSPORT: " Mock " }), "mock");
});

test("warmupTransportKind: valor inválido ⇒ fallback a mock con warning (no lanza)", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg?: unknown) => warnings.push(String(msg));
  try {
    assert.equal(warmupTransportKind({ WARMUP_TRANSPORT: "sendgrid" }), "mock");
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /warmup_transport_invalid/);
});

test("readWarmupSmtpConfig: lee host y puerto; default 587 sin puerto", () => {
  assert.deepEqual(readWarmupSmtpConfig({ WARMUP_SMTP_HOST: "smtp.local" }), {
    host: "smtp.local",
    port: 587
  });
  assert.deepEqual(
    readWarmupSmtpConfig({ WARMUP_SMTP_HOST: "smtp.local", WARMUP_SMTP_PORT: "2525" }),
    { host: "smtp.local", port: 2525 }
  );
});

test("readWarmupSmtpConfig: sin host LANZA (fail-closed)", () => {
  assert.throws(() => readWarmupSmtpConfig({}), /warmup_smtp_host_missing/);
  assert.throws(() => readWarmupSmtpConfig({ WARMUP_SMTP_HOST: "  " }), /warmup_smtp_host_missing/);
});

test("readWarmupSmtpConfig: puerto inválido ⇒ fallback 587 con warning", () => {
  const cfg = withSilencedWarn(() =>
    readWarmupSmtpConfig({ WARMUP_SMTP_HOST: "smtp.local", WARMUP_SMTP_PORT: "99999" })
  );
  assert.equal(cfg.port, 587);
  const cfg2 = withSilencedWarn(() =>
    readWarmupSmtpConfig({ WARMUP_SMTP_HOST: "smtp.local", WARMUP_SMTP_PORT: "abc" })
  );
  assert.equal(cfg2.port, 587);
});

test("warmupPlacementMin: default 0.80 y lectura válida/ inválida", () => {
  assert.equal(warmupPlacementMin({}), DEFAULT_WARMUP_PLACEMENT_MIN);
  assert.equal(warmupPlacementMin({ WARMUP_PLACEMENT_MIN: "0.9" }), 0.9);
  assert.equal(
    withSilencedWarn(() => warmupPlacementMin({ WARMUP_PLACEMENT_MIN: "1.5" })),
    DEFAULT_WARMUP_PLACEMENT_MIN
  );
  assert.equal(
    withSilencedWarn(() => warmupPlacementMin({ WARMUP_PLACEMENT_MIN: "x" })),
    DEFAULT_WARMUP_PLACEMENT_MIN
  );
});
