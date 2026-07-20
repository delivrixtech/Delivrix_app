import assert from "node:assert/strict";
import test from "node:test";
import {
  WARMUP_CONVERSATIONS,
  conversationCount,
  pickConversation,
  makeTestId
} from "./warmup-content-bank.ts";

test("el banco tiene varias conversaciones distintas", () => {
  assert.ok(conversationCount() >= 12, "al menos 12 conversaciones");
  const subjects = new Set(WARMUP_CONVERSATIONS.map((c) => c.subject));
  assert.equal(subjects.size, WARMUP_CONVERSATIONS.length, "asuntos únicos");
  const topics = new Set(WARMUP_CONVERSATIONS.map((c) => c.topic));
  assert.equal(topics.size, WARMUP_CONVERSATIONS.length, "temas únicos");
});

test("cada conversación es natural: sin links ni marketing, con asunto/cuerpo/respuesta", () => {
  for (const c of WARMUP_CONVERSATIONS) {
    assert.ok(c.subject.trim().length > 0, "asunto no vacío");
    assert.ok(c.body.trim().length > 20, "cuerpo con contenido");
    assert.ok(c.reply.trim().length > 10, "respuesta con contenido");
    const blob = `${c.subject} ${c.body} ${c.reply}`.toLowerCase();
    assert.ok(!blob.includes("http://") && !blob.includes("https://"), "sin URLs");
    assert.ok(!blob.includes("unsubscribe") && !blob.includes("descuento") && !blob.includes("oferta"), "sin marketing");
  }
});

test("pickConversation es determinista y rota el banco", () => {
  const n = conversationCount();
  assert.equal(pickConversation(0).subject, WARMUP_CONVERSATIONS[0].subject);
  assert.equal(pickConversation(0).subject, pickConversation(0).subject, "mismo index → misma conversación");
  assert.equal(pickConversation(n).subject, pickConversation(0).subject, "envuelve por módulo");
  assert.equal(pickConversation(n + 3).subject, pickConversation(3).subject);
});

test("pickConversation tolera índices negativos y no finitos", () => {
  assert.ok(pickConversation(-1).subject.length > 0);
  assert.ok(pickConversation(Number.NaN).subject.length > 0);
  assert.equal(pickConversation(Number.NaN).subject, pickConversation(0).subject);
});

test("el banco es de sólo lectura (congelado)", () => {
  assert.throws(() => {
    (WARMUP_CONVERSATIONS as unknown as { push: (x: unknown) => void }).push({});
  });
});

test("makeTestId estampa un id estable y trazable", () => {
  assert.equal(makeTestId(742739), "warmup-cycle-742739");
  assert.equal(makeTestId("abc"), "warmup-cycle-abc");
});
