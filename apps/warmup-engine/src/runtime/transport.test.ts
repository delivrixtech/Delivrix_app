import assert from "node:assert/strict";
import test from "node:test";
import {
  MockTransport,
  type SmtpClient,
  type SmtpSendInfo,
  type WarmupMessage
} from "./transport.ts";

const MSG: WarmupMessage = {
  from: "warm@delivrix.io",
  to: "dest@example.com",
  subject: "Delivrix warmup",
  body: "hello",
  headers: { "X-Delivrix-Slot": "slot-1" }
};

// ---- MockTransport ----

test("MockTransport: registra el mensaje y devuelve ok por defecto", async () => {
  const t = new MockTransport();
  const r = await t.send(MSG);
  assert.equal(t.kind, "mock");
  assert.equal(r.ok, true);
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0], MSG);
});

test("MockTransport.permanentBounce: ok:false + permanent:true", async () => {
  const t = MockTransport.permanentBounce("hard_bounce");
  const r = await t.send(MSG);
  assert.equal(r.ok, false);
  assert.equal(r.permanent, true);
  assert.equal(r.error, "hard_bounce");
});

test("MockTransport.transientFailure: ok:false + permanent:false", async () => {
  const t = MockTransport.transientFailure();
  const r = await t.send(MSG);
  assert.equal(r.ok, false);
  assert.equal(r.permanent, false);
});

test("MockTransport: behavior por-mensaje simula bounce selectivo", async () => {
  const t = new MockTransport({
    behavior: (m) => (m.to === "bad@x.com" ? { ok: false, error: "no_such_user", permanent: true } : undefined)
  });
  const ok = await t.send(MSG);
  const bad = await t.send({ ...MSG, to: "bad@x.com" });
  assert.equal(ok.ok, true);
  assert.equal(bad.ok, false);
  assert.equal(bad.permanent, true);
  assert.equal(t.sent.length, 2);
});

