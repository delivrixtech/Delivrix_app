import assert from "node:assert/strict";
import test from "node:test";
import type { WarmupNode, WarmupSend } from "../domain/types.ts";
import { MockTransport } from "./transport.ts";
import {
  DEFAULT_MAX_ATTEMPTS,
  WARMUP_ID_HEADER,
  applyWarmupMarker,
  buildDefaultMessage,
  processSend
} from "./send-worker.ts";

const NOW = new Date("2026-07-09T12:00:00Z");

function node(overrides: Partial<WarmupNode> = {}): WarmupNode {
  return {
    id: "n1",
    mailbox: "warm@delivrix.io",
    domain: "delivrix.io",
    infraType: "postfix",
    state: "fresh",
    authReady: true,
    contractExpiresAt: new Date("2026-07-09T13:00:00Z"),
    dailyLimit: 10,
    increaseByDay: 1,
    dayIndex: 1,
    weekdaysOnly: false,
    ...overrides
  };
}

function send(overrides: Partial<WarmupSend> = {}): WarmupSend {
  return {
    nodeId: "n1",
    slotKey: "2026-07-09T12:00:00Z#n1#0",
    toAddress: "dest@example.com",
    status: "queued",
    ...overrides
  };
}

// ================== GATE DE SALIDA DE FASE 0 (assert clave) ==================

test("GATE: nodo SIN contrato ready (authReady=false) NO invoca el transporte", async () => {
  const transport = new MockTransport();
  const r = await processSend({ node: node({ authReady: false }), send: send(), transport, now: NOW });
  assert.equal(transport.sent.length, 0, "el transporte NUNCA debe invocarse si el gate falla");
  assert.equal(r.status, "queued");
  assert.equal(r.reason, "auth_not_ready");
});

test("GATE: nodo blocked NO envía y queda queued con motivo", async () => {
  const transport = new MockTransport();
  const r = await processSend({ node: node({ state: "blocked" }), send: send(), transport, now: NOW });
  assert.equal(transport.sent.length, 0);
  assert.equal(r.status, "queued");
  assert.equal(r.reason, "node_blocked");
});

test("GATE: contrato expirado NO envía aunque authReady siga true", async () => {
  const transport = new MockTransport();
  const n = node({ contractExpiresAt: new Date("2026-07-09T11:00:00Z") });
  const r = await processSend({ node: n, send: send(), transport, now: NOW });
  assert.equal(transport.sent.length, 0);
  assert.equal(r.reason, "contract_expired");
});

test("GATE: verifyGate inyectado que rechaza ⇒ transporte no invocado, reason gate_blocked", async () => {
  const transport = new MockTransport();
  const r = await processSend({ node: node(), send: send(), transport, now: NOW, verifyGate: () => false });
  assert.equal(transport.sent.length, 0);
  assert.equal(r.status, "queued");
  assert.equal(r.reason, "gate_blocked");
});

// ================== ENVÍO OK ==================

test("gate ok ⇒ invoca transporte y marca sent", async () => {
  const transport = new MockTransport();
  const r = await processSend({ node: node(), send: send(), transport, now: NOW });
  assert.equal(transport.sent.length, 1);
  assert.equal(r.status, "sent");
  assert.equal(r.messageId, "mock-1");
});

test("usa el mensaje inyectado si se provee (preservando sus campos)", async () => {
  const transport = new MockTransport();
  const msg = { from: "a@b.com", to: "c@d.com", subject: "s", body: "b" };
  await processSend({ node: node(), send: send(), transport, now: NOW, message: msg });
  // Se respetan from/to/subject/body del mensaje inyectado…
  assert.equal(transport.sent[0].from, "a@b.com");
  assert.equal(transport.sent[0].to, "c@d.com");
  assert.equal(transport.sent[0].subject, "s");
  assert.equal(transport.sent[0].body, "b");
  // …pero el aislamiento garantiza SIEMPRE la marca X-Warmup-Id, aunque el mensaje venga sin headers.
  assert.equal(transport.sent[0].headers?.[WARMUP_ID_HEADER], "n1");
});

test("mensaje por defecto ancla el slotKey (idempotencia por slot)", async () => {
  const transport = new MockTransport();
  const s = send({ slotKey: "slot-XYZ" });
  await processSend({ node: node(), send: s, transport, now: NOW });
  assert.equal(transport.sent[0].headers?.["X-Delivrix-Slot"], "slot-XYZ");
  assert.equal(transport.sent[0].from, "warm@delivrix.io");
  assert.equal(transport.sent[0].to, "dest@example.com");
});

// ================== IDEMPOTENCIA (§12, exactly-once por slot) ==================

test("IDEMPOTENCIA: un send ya 'sent' NO se reenvía (transporte no invocado)", async () => {
  const transport = new MockTransport();
  const r = await processSend({ node: node(), send: send({ status: "sent" }), transport, now: NOW });
  assert.equal(transport.sent.length, 0, "exactly-once: no reenviar un slot ya enviado");
  assert.equal(r.status, "sent");
  assert.equal(r.reason, "already_terminal");
});

test("IDEMPOTENCIA: un send 'bounced' es terminal, no reintenta", async () => {
  const transport = new MockTransport();
  const r = await processSend({ node: node(), send: send({ status: "bounced" }), transport, now: NOW });
  assert.equal(transport.sent.length, 0);
  assert.equal(r.status, "bounced");
});

test("IDEMPOTENCIA: un send 'dead_lettered' es terminal", async () => {
  const transport = new MockTransport();
  const r = await processSend({ node: node(), send: send({ status: "dead_lettered" }), transport, now: NOW });
  assert.equal(transport.sent.length, 0);
  assert.equal(r.status, "dead_lettered");
});

// ================== BOUNCE / DLQ (§12) ==================

test("bounce PERMANENTE ⇒ status bounced", async () => {
  const transport = MockTransport.permanentBounce("no_such_user");
  const r = await processSend({ node: node(), send: send(), transport, now: NOW });
  assert.equal(r.status, "bounced");
  assert.equal(r.reason, "no_such_user");
});

test("fallo TRANSITORIO con intentos restantes ⇒ failed (reintable)", async () => {
  const transport = MockTransport.transientFailure("temp");
  const r = await processSend({ node: node(), send: send(), transport, now: NOW, attempt: 1, maxAttempts: 3 });
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "temp");
});

test("fallo TRANSITORIO agotados los intentos ⇒ dead_lettered (DLQ)", async () => {
  const transport = MockTransport.transientFailure("temp");
  const r = await processSend({ node: node(), send: send(), transport, now: NOW, attempt: 3, maxAttempts: 3 });
  assert.equal(r.status, "dead_lettered");
});

test("fallo TRANSITORIO en el último intento por defecto (DEFAULT_MAX_ATTEMPTS) ⇒ dead_lettered", async () => {
  const transport = MockTransport.transientFailure();
  const r = await processSend({ node: node(), send: send(), transport, now: NOW, attempt: DEFAULT_MAX_ATTEMPTS });
  assert.equal(r.status, "dead_lettered");
});

// ================== AISLAMIENTO DE TRÁFICO (invariante X-Warmup-Id) ==================

test("AISLAMIENTO: el mensaje por defecto lleva X-Warmup-Id = id del nodo (además del slot)", async () => {
  const transport = new MockTransport();
  await processSend({ node: node({ id: "node-42" }), send: send(), transport, now: NOW });
  assert.equal(transport.sent[0].headers?.[WARMUP_ID_HEADER], "node-42");
  assert.equal(transport.sent[0].headers?.["X-Delivrix-Slot"], "2026-07-09T12:00:00Z#n1#0");
});

test("AISLAMIENTO: buildDefaultMessage ya incluye la marca X-Warmup-Id", () => {
  const msg = buildDefaultMessage(node({ id: "node-7" }), send());
  assert.equal(msg.headers?.[WARMUP_ID_HEADER], "node-7");
});

test("AISLAMIENTO: applyWarmupMarker NO pisa un X-Warmup-Id ya seteado por el scheduler", () => {
  const marked = applyWarmupMarker(
    { from: "a@b.com", to: "c@d.com", subject: "s", body: "b", headers: { [WARMUP_ID_HEADER]: "custom-send-id" } },
    node({ id: "node-9" })
  );
  assert.equal(marked.headers?.[WARMUP_ID_HEADER], "custom-send-id");
});

test("AISLAMIENTO: applyWarmupMarker preserva otros headers y no muta el mensaje original", () => {
  const original = { from: "a@b.com", to: "c@d.com", subject: "s", body: "b", headers: { "X-Delivrix-Slot": "slot-1" } };
  const marked = applyWarmupMarker(original, node({ id: "node-3" }));
  assert.equal(marked.headers?.["X-Delivrix-Slot"], "slot-1");
  assert.equal(marked.headers?.[WARMUP_ID_HEADER], "node-3");
  // el original queda intacto (sin la marca)
  assert.equal(original.headers[WARMUP_ID_HEADER as keyof typeof original.headers], undefined);
});
