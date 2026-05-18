import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWebdockDrift } from "./openclaw-rules.ts";
import type { SenderNode } from "./types.ts";
import type { WebdockInventoryServer } from "./webdock-inventory.ts";

function server(overrides: Partial<WebdockInventoryServer> = {}): WebdockInventoryServer {
  return {
    slug: "svc-test",
    name: "svc-test",
    ipv4: "10.0.0.1",
    status: "running",
    ...overrides
  };
}

function node(overrides: Partial<SenderNode> = {}): SenderNode {
  return {
    id: "svc-test",
    label: "svc-test",
    provider: "webdock",
    status: "active",
    ipAddress: "10.0.0.1",
    dailyLimit: 100,
    warmupDay: 5,
    ...overrides
  };
}

test("evaluateWebdockDrift: webdock running + sender paused → propuesta resume medium", () => {
  const result = evaluateWebdockDrift({
    webdockServers: [server({ slug: "svc-a", status: "running" })],
    senderNodes: [node({ id: "svc-a", status: "paused" })]
  });

  assert.equal(result.proposals.length, 1);
  const p = result.proposals[0]!;
  assert.equal(p.category, "node_resume_proposed");
  assert.equal(p.severity, "medium");
  assert.ok(p.headline.includes("Reactivar"));
  assert.equal(p.runbookRef, "sender-node-resume-runbook.md");
});

test("evaluateWebdockDrift: webdock stopped + sender active → propuesta pause high", () => {
  const result = evaluateWebdockDrift({
    webdockServers: [server({ slug: "svc-b", status: "stopped" })],
    senderNodes: [node({ id: "svc-b", status: "active" })]
  });

  assert.equal(result.proposals.length, 1);
  const p = result.proposals[0]!;
  assert.equal(p.category, "node_pause_proposed");
  assert.equal(p.severity, "high");
  assert.ok(p.headline.includes("Pausar"));
});

test("evaluateWebdockDrift: webdock sin sender → propuesta register low + unmatched", () => {
  const result = evaluateWebdockDrift({
    webdockServers: [server({ slug: "svc-c", status: "running" })],
    senderNodes: []
  });

  assert.equal(result.proposals.length, 1);
  const p = result.proposals[0]!;
  assert.equal(p.category, "node_register_proposed");
  assert.equal(p.severity, "low");
  assert.deepEqual(result.unmatchedWebdockSlugs, ["svc-c"]);
});

test("evaluateWebdockDrift: sender_node huérfano (sin webdock) → propuesta orphan medium", () => {
  const result = evaluateWebdockDrift({
    webdockServers: [],
    senderNodes: [node({ id: "svc-deleted", status: "active" })]
  });

  assert.equal(result.proposals.length, 1);
  const p = result.proposals[0]!;
  assert.equal(p.category, "node_orphan_warning");
  assert.equal(p.severity, "medium");
  assert.deepEqual(result.unmatchedSenderNodeIds, ["svc-deleted"]);
});

test("evaluateWebdockDrift: sender_node no-webdock se ignora (no provider=webdock)", () => {
  const result = evaluateWebdockDrift({
    webdockServers: [],
    senderNodes: [node({ id: "svc-manual", provider: "manual", status: "active" })]
  });

  assert.equal(result.proposals.length, 0);
  assert.equal(result.unmatchedSenderNodeIds.length, 0);
});

test("evaluateWebdockDrift: alineación correcta no produce propuestas", () => {
  const result = evaluateWebdockDrift({
    webdockServers: [server({ slug: "svc-ok", status: "running" })],
    senderNodes: [node({ id: "svc-ok", status: "active" })]
  });

  assert.equal(result.proposals.length, 0);
});

test("evaluateWebdockDrift: ordenamiento high > medium > low", () => {
  const result = evaluateWebdockDrift({
    webdockServers: [
      server({ slug: "svc-low", status: "running" }), // sin sender → low
      server({ slug: "svc-high", status: "stopped" }), // sender active → high
      server({ slug: "svc-med", status: "running" }) // sender paused → medium
    ],
    senderNodes: [
      node({ id: "svc-high", status: "active" }),
      node({ id: "svc-med", status: "paused" })
    ]
  });

  assert.equal(result.proposals.length, 3);
  assert.equal(result.proposals[0]!.severity, "high");
  assert.equal(result.proposals[1]!.severity, "medium");
  assert.equal(result.proposals[2]!.severity, "low");
});
