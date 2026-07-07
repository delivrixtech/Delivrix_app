import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeKeyFor,
  defaultHealthAutoFlagThresholds,
  emptyHealthAutoFlagState,
  evaluateHealthAutoFlags,
  registerHealthAutoFlagOpenFlag,
  type HealthAutoFlagState
} from "./health-autoflag.ts";
import type { SendResult, SenderNode } from "./types.ts";

const NOW = new Date("2026-07-06T12:00:00.000Z");

function node(overrides: Partial<SenderNode> = {}): SenderNode {
  return {
    id: "node-1",
    label: "mail.acme.com",
    provider: "webdock",
    status: "active",
    ipAddress: "203.0.113.10",
    dailyLimit: 100,
    warmupDay: 12,
    ...overrides
  };
}

function results(senderNodeId: string, counts: { sent?: number; bounce?: number; complaint?: number }): SendResult[] {
  const rows: SendResult[] = [];
  const push = (status: SendResult["status"], amount: number) => {
    for (let i = 0; i < amount; i += 1) {
      rows.push({
        id: `res-${status}-${i}`,
        sendJobId: `job-${status}-${i}`,
        senderNodeId,
        status,
        metadata: {},
        occurredAt: NOW.toISOString()
      });
    }
  };
  push("sent", counts.sent ?? 0);
  push("bounce", counts.bounce ?? 0);
  push("complaint", counts.complaint ?? 0);
  return rows;
}

test("flaggea spam rate >10% con severidad Critical", () => {
  const evaluation = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: results("node-1", { sent: 17, complaint: 3 }),
    state: emptyHealthAutoFlagState(),
    now: NOW
  });

  const spam = evaluation.candidates.find((candidate) => candidate.metric === "spam_rate");
  assert.ok(spam);
  assert.equal(spam.severity, "Critical");
  assert.equal(spam.category, "Flagged Server");
  assert.equal(spam.server, "mail.acme.com");
  assert.equal(spam.value, "15.0%");
  assert.equal(spam.threshold, ">10.0%");
  assert.equal(spam.dedupeKey, "node-1::spam_rate");
});

test("flaggea bounce rate >5% pero no bajo el volumen minimo", () => {
  const breach = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: results("node-1", { sent: 18, bounce: 2 }),
    state: emptyHealthAutoFlagState(),
    now: NOW
  });
  assert.ok(breach.candidates.some((candidate) => candidate.metric === "bounce_rate"));

  const lowVolume = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: results("node-1", { sent: 2, bounce: 2 }),
    state: emptyHealthAutoFlagState(),
    now: NOW
  });
  assert.equal(lowVolume.candidates.length, 0);
});

test("no flaggea metricas dentro de umbral", () => {
  const evaluation = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: results("node-1", { sent: 96, bounce: 3, complaint: 1 }),
    state: emptyHealthAutoFlagState(),
    now: NOW
  });
  assert.equal(evaluation.candidates.length, 0);
});

test("reply rate <5% por 3 dias consecutivos flaggea como Warmup Stalled", () => {
  const evaluation = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: [],
    replySamples: {
      "node-1": [
        { date: "2026-07-04", sent: 50, replies: 1 },
        { date: "2026-07-05", sent: 50, replies: 2 },
        { date: "2026-07-06", sent: 50, replies: 0 }
      ]
    },
    state: emptyHealthAutoFlagState(),
    now: NOW
  });

  const reply = evaluation.candidates.find((candidate) => candidate.metric === "reply_rate");
  assert.ok(reply);
  assert.equal(reply.category, "Warmup Stalled");
  assert.equal(reply.severity, "High");
  assert.match(reply.description, /2026-07-04, 2026-07-05, 2026-07-06/);
});

test("reply rate NO flaggea con solo 2 dias bajos ni con dias no consecutivos", () => {
  const twoDays = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: [],
    replySamples: {
      "node-1": [
        { date: "2026-07-05", sent: 50, replies: 0 },
        { date: "2026-07-06", sent: 50, replies: 0 }
      ]
    },
    state: emptyHealthAutoFlagState(),
    now: NOW
  });
  assert.equal(twoDays.candidates.length, 0);

  const withGap = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: [],
    replySamples: {
      "node-1": [
        { date: "2026-07-02", sent: 50, replies: 0 },
        { date: "2026-07-05", sent: 50, replies: 0 },
        { date: "2026-07-06", sent: 50, replies: 0 }
      ]
    },
    state: emptyHealthAutoFlagState(),
    now: NOW
  });
  assert.equal(withGap.candidates.length, 0);
});

test("reply rate acumula historial entre runs (estado persistido)", () => {
  let state = emptyHealthAutoFlagState();

  for (const [date, replies] of [["2026-07-04", 1], ["2026-07-05", 0]] as const) {
    const run = evaluateHealthAutoFlags({
      senderNodes: [node()],
      sendResults: [],
      replySamples: { "node-1": [{ date, sent: 40, replies }] },
      state,
      now: NOW
    });
    state = run.state;
    assert.equal(run.candidates.length, 0);
  }

  const third = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: [],
    replySamples: { "node-1": [{ date: "2026-07-06", sent: 40, replies: 1 }] },
    state,
    now: NOW
  });
  assert.ok(third.candidates.some((candidate) => candidate.metric === "reply_rate"));
});

test("blacklist hit flaggea Critical con las fuentes", () => {
  const evaluation = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: [],
    blacklistSignals: [
      { senderNodeId: "node-1", type: "blacklist", source: "mxtoolbox:spamhaus", severity: "critical" },
      { senderNodeId: "node-1", type: "blacklist", source: "mxtoolbox:barracuda", severity: "critical" }
    ],
    state: emptyHealthAutoFlagState(),
    now: NOW
  });

  const blacklist = evaluation.candidates.find((candidate) => candidate.metric === "blacklist");
  assert.ok(blacklist);
  assert.equal(blacklist.severity, "Critical");
  assert.equal(blacklist.value, "mxtoolbox:spamhaus, mxtoolbox:barracuda");
});

test("dedupe: no re-flaggea la misma metrica+servidor mientras el flag siga abierto", () => {
  const first = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: results("node-1", { sent: 10, bounce: 10 }),
    state: emptyHealthAutoFlagState(),
    now: NOW
  });
  const bounce = first.candidates.find((candidate) => candidate.metric === "bounce_rate");
  assert.ok(bounce);

  const stateWithFlag = registerHealthAutoFlagOpenFlag(first.state, bounce, "notion-page-123");
  assert.equal(stateWithFlag.openFlags.length, 1);
  assert.equal(stateWithFlag.openFlags[0].notionPageId, "notion-page-123");

  const second = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: results("node-1", { sent: 10, bounce: 10 }),
    state: stateWithFlag,
    now: NOW
  });
  assert.equal(second.candidates.filter((candidate) => candidate.metric === "bounce_rate").length, 0);
});

test("auto-resuelve flag de tasa cuando la metrica se recupera y permite re-flaggear", () => {
  const flaggedState: HealthAutoFlagState = {
    ...emptyHealthAutoFlagState(),
    openFlags: [{
      dedupeKey: dedupeKeyFor("node-1", "bounce_rate"),
      senderNodeId: "node-1",
      server: "mail.acme.com",
      metric: "bounce_rate",
      value: "100.0%",
      threshold: ">5.0%",
      flaggedAt: "2026-07-01T00:00:00.000Z",
      notionPageId: "notion-page-123"
    }]
  };

  const recovered = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: results("node-1", { sent: 100, bounce: 1 }),
    state: flaggedState,
    now: NOW
  });
  assert.deepEqual(recovered.resolved, ["node-1::bounce_rate"]);
  assert.equal(recovered.state.openFlags.length, 0);

  const reBreach = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: results("node-1", { sent: 10, bounce: 10 }),
    state: recovered.state,
    now: NOW
  });
  assert.ok(reBreach.candidates.some((candidate) => candidate.metric === "bounce_rate"));
});

test("flag de blacklist solo se resuelve con scan fresco sin señal", () => {
  const flaggedState: HealthAutoFlagState = {
    ...emptyHealthAutoFlagState(),
    openFlags: [{
      dedupeKey: dedupeKeyFor("node-1", "blacklist"),
      senderNodeId: "node-1",
      server: "mail.acme.com",
      metric: "blacklist",
      value: "mxtoolbox:spamhaus",
      threshold: "listado en 1+ blacklist",
      flaggedAt: "2026-07-01T00:00:00.000Z",
      notionPageId: "notion-page-456"
    }]
  };

  const withoutScan = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: [],
    state: flaggedState,
    now: NOW
  });
  assert.equal(withoutScan.resolved.length, 0);
  assert.equal(withoutScan.state.openFlags.length, 1);

  const withCleanScan = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: [],
    blacklistScanPerformed: true,
    state: flaggedState,
    now: NOW
  });
  assert.deepEqual(withCleanScan.resolved, ["node-1::blacklist"]);
});

test("historial de reply rate se poda a 14 dias y la muestra nueva pisa la del mismo dia", () => {
  const staleState: HealthAutoFlagState = {
    ...emptyHealthAutoFlagState(),
    replyRateHistory: {
      "node-1": [
        { date: "2026-06-01", sent: 30, replies: 10 },
        { date: "2026-07-05", sent: 30, replies: 10 }
      ]
    }
  };

  const run = evaluateHealthAutoFlags({
    senderNodes: [node()],
    sendResults: [],
    replySamples: { "node-1": [{ date: "2026-07-05", sent: 40, replies: 0 }] },
    state: staleState,
    now: NOW
  });

  const history = run.state.replyRateHistory["node-1"];
  assert.deepEqual(history, [{ date: "2026-07-05", sent: 40, replies: 0 }]);
});
