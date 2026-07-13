import assert from "node:assert/strict";
import test from "node:test";
import {
  MockTransport,
  PostfixTransport,
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

// ---- PostfixTransport con cliente SMTP inyectado (mock, sin red) ----

function stubClient(impl: SmtpClient["sendMail"]): SmtpClient {
  return { sendMail: impl };
}

test("PostfixTransport: envío ok mapea messageId y pasa text=body", async () => {
  let seen: unknown;
  const client = stubClient(async (mail) => {
    seen = mail;
    return { messageId: "<abc@delivrix>", accepted: [mail.to], rejected: [] } satisfies SmtpSendInfo;
  });
  const t = new PostfixTransport(client);
  const r = await t.send(MSG);
  assert.equal(t.kind, "postfix");
  assert.equal(r.ok, true);
  assert.equal(r.messageId, "<abc@delivrix>");
  assert.deepEqual(seen, {
    from: MSG.from,
    to: MSG.to,
    subject: MSG.subject,
    text: MSG.body,
    headers: MSG.headers
  });
});

test("PostfixTransport: rejected no vacío (sin throw) ⇒ bounce permanente", async () => {
  const client = stubClient(async (mail) => ({ messageId: "<id>", accepted: [], rejected: [mail.to] }));
  const r = await new PostfixTransport(client).send(MSG);
  assert.equal(r.ok, false);
  assert.equal(r.permanent, true);
  assert.equal(r.error, "recipient_rejected");
});

test("PostfixTransport: throw con responseCode 5xx ⇒ permanente", async () => {
  const client = stubClient(async () => {
    throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
  });
  const r = await new PostfixTransport(client).send(MSG);
  assert.equal(r.ok, false);
  assert.equal(r.permanent, true);
  assert.match(r.error ?? "", /550/);
});

test("PostfixTransport: throw con responseCode 4xx ⇒ transitorio", async () => {
  const client = stubClient(async () => {
    throw Object.assign(new Error("451 try again later"), { responseCode: 451 });
  });
  const r = await new PostfixTransport(client).send(MSG);
  assert.equal(r.ok, false);
  assert.equal(r.permanent, false);
});

test("PostfixTransport: throw sin responseCode (fallo de red) ⇒ transitorio", async () => {
  const client = stubClient(async () => {
    throw new Error("ECONNREFUSED");
  });
  const r = await new PostfixTransport(client).send(MSG);
  assert.equal(r.ok, false);
  assert.equal(r.permanent, false);
  assert.equal(r.error, "ECONNREFUSED");
});
