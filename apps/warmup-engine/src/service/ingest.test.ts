import assert from "node:assert/strict";
import test from "node:test";
import { deliveryToSignalKind, ingestDeliveryOutcome } from "./ingest.ts";
import type { SignalStore } from "../store/ports.ts";

interface Recorded {
  nodeId: string;
  kind: "bounce" | "complaint" | "deferral";
  detail?: unknown;
}

function fakeSignalStore(): { store: SignalStore; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const store: SignalStore = {
    async record(input) {
      recorded.push(input);
    },
    async countRecent() {
      return { bounces: 0, complaints: 0 };
    }
  };
  return { store, recorded };
}

// ── mapeo puro ────────────────────────────────────────────────────────────────────────────────

test("deliveryToSignalKind: bounced ⇒ bounce", () => {
  assert.equal(deliveryToSignalKind({ finalStatus: "bounced" }), "bounce");
});

test("deliveryToSignalKind: DSN de queja/policy 5.7.x ⇒ complaint", () => {
  assert.equal(deliveryToSignalKind({ finalStatus: "bounced", dsnCode: "5.7.1" }), "complaint");
  assert.equal(deliveryToSignalKind({ finalStatus: "bounced", dsnCode: "5.7.26" }), "complaint");
});

test("deliveryToSignalKind: bounce duro (5.1.1 dirección inexistente) sigue siendo bounce", () => {
  assert.equal(deliveryToSignalKind({ finalStatus: "bounced", dsnCode: "5.1.1" }), "bounce");
});

test("deliveryToSignalKind: deferred/expired ⇒ deferral", () => {
  assert.equal(deliveryToSignalKind({ finalStatus: "deferred" }), "deferral");
  assert.equal(deliveryToSignalKind({ finalStatus: "expired" }), "deferral");
});

test("deliveryToSignalKind: sent/unknown/otro ⇒ null (no es señal)", () => {
  assert.equal(deliveryToSignalKind({ finalStatus: "sent" }), null);
  assert.equal(deliveryToSignalKind({ finalStatus: "unknown" }), null);
  assert.equal(deliveryToSignalKind({ finalStatus: "" }), null);
  assert.equal(deliveryToSignalKind({ finalStatus: "weird-status" }), null);
});

test("deliveryToSignalKind: es case/space-insensitive", () => {
  assert.equal(deliveryToSignalKind({ finalStatus: " Bounced " }), "bounce");
});

// ── ingest ────────────────────────────────────────────────────────────────────────────────────

test("ingest: bounced ⇒ graba señal bounce con detalle", async () => {
  const { store, recorded } = fakeSignalStore();
  const r = await ingestDeliveryOutcome({
    stores: { signals: store },
    nodeId: "node-1",
    outcome: { finalStatus: "bounced", dsnCode: "5.1.1", messageId: "abc@host" }
  });
  assert.deepEqual(r, { recorded: true, kind: "bounce" });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].nodeId, "node-1");
  assert.equal(recorded[0].kind, "bounce");
  assert.deepEqual(recorded[0].detail, { dsnCode: "5.1.1", messageId: "abc@host" });
});

test("ingest: deferred ⇒ graba señal deferral", async () => {
  const { store, recorded } = fakeSignalStore();
  const r = await ingestDeliveryOutcome({
    stores: { signals: store },
    nodeId: "node-1",
    outcome: { finalStatus: "deferred" }
  });
  assert.deepEqual(r, { recorded: true, kind: "deferral" });
  assert.equal(recorded[0].kind, "deferral");
});

test("ingest: DSN de queja ⇒ graba señal complaint", async () => {
  const { store, recorded } = fakeSignalStore();
  const r = await ingestDeliveryOutcome({
    stores: { signals: store },
    nodeId: "node-1",
    outcome: { finalStatus: "bounced", dsnCode: "5.7.1" }
  });
  assert.deepEqual(r, { recorded: true, kind: "complaint" });
  assert.equal(recorded[0].kind, "complaint");
});

test("ingest: sent ⇒ NO graba y devuelve recorded:false", async () => {
  const { store, recorded } = fakeSignalStore();
  const r = await ingestDeliveryOutcome({
    stores: { signals: store },
    nodeId: "node-1",
    outcome: { finalStatus: "sent" }
  });
  assert.deepEqual(r, { recorded: false });
  assert.equal(recorded.length, 0);
});

test("ingest: outcome raro (status desconocido) no lanza y no graba", async () => {
  const { store, recorded } = fakeSignalStore();
  const r = await ingestDeliveryOutcome({
    stores: { signals: store },
    nodeId: "node-1",
    outcome: { finalStatus: "totally-bogus" }
  });
  assert.deepEqual(r, { recorded: false });
  assert.equal(recorded.length, 0);
});
