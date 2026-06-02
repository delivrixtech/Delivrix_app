import assert from "node:assert/strict";
import test from "node:test";
import {
  executePauseIpRunbook,
  executeQuarantineRunbook,
  executeRegisterSenderNodeRunbook,
  executeWarmingStepRunbook,
  revertRunbook,
  type RegisterSenderNodeInput,
  type RollbackSnapshot,
  type RunbookContext,
  type RunbookSenderNodeRepository,
  type SenderNode
} from "../index.ts";

const occurredAt = "2026-05-19T12:00:00.000Z";
const rollbackNow = new Date("2026-05-20T00:00:00.000Z");

test("register runbook creates a sender node and rollback snapshot", async () => {
  const repo = new MemoryRunbookSenderNodeRepository();
  const persisted: string[] = [];
  const result = await executeRegisterSenderNodeRunbook(sampleRegisterInput(), ctx(repo, {
    persistRollbackSnapshot(input) {
      persisted.push(input.prevStateJson);
      return "rb-register";
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.rollbackToken : "", "rb-register");
  assert.deepEqual(persisted.map(JSON.parse), [{ existed: false }]);
  assert.equal((await repo.get("svc-mvp-test-01"))?.status, "warming");
});

test("register runbook rejects duplicate node ids", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const result = await executeRegisterSenderNodeRunbook(sampleRegisterInput(), ctx(repo));

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.rejectReason, "state_inconsistent");
});

test("register runbook rejects duplicate IPs", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([
    { ...sampleNode(), id: "other", ipAddress: "185.243.12.40" }
  ]);
  const result = await executeRegisterSenderNodeRunbook(sampleRegisterInput(), ctx(repo));

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.detail, /IP 185\.243\.12\.40/);
});

test("register runbook rejects idempotency replay by proposal id", async () => {
  const repo = new MemoryRunbookSenderNodeRepository();
  const executedProposalIds = new Set<string>(["proposal-1"]);
  const result = await executeRegisterSenderNodeRunbook(
    sampleRegisterInput(),
    ctx(repo, { executedProposalIds })
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.detail, /already executed/);
});

test("warming runbook requires two distinct approvers", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const result = await executeWarmingStepRunbook(
    { nodeId: "svc-mvp-test-01" },
    ctx(repo, { approverIds: ["op-a"] })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.rejectReason, "preconditions_failed");
});

test("warming runbook increments warmup day and daily limit", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const result = await executeWarmingStepRunbook(
    { nodeId: "svc-mvp-test-01" },
    ctx(repo, { approverIds: ["op-a", "op-b"], rollbackToken: "rb-warming" })
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.newState : {}, {
    status: "warming",
    warmupDay: 2,
    dailyLimit: 100
  });
  assert.equal((await repo.get("svc-mvp-test-01"))?.warmupDay, 2);
});

test("warming runbook lowers stale daily limit to the planned next-day cap", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), dailyLimit: 10_000 }]);
  const result = await executeWarmingStepRunbook(
    { nodeId: "svc-mvp-test-01" },
    ctx(repo, { approverIds: ["op-a", "op-b"], rollbackToken: "rb-warming" })
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.newState : {}, {
    status: "warming",
    warmupDay: 2,
    dailyLimit: 100
  });
});

test("warming runbook rejects safety-capped nodes below the current plan", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), warmupDay: 2, dailyLimit: 50 }]);
  const result = await executeWarmingStepRunbook(
    { nodeId: "svc-mvp-test-01" },
    ctx(repo, { approverIds: ["op-a", "op-b"] })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.rejectReason, "preconditions_failed");
  assert.match(result.ok ? "" : result.detail, /below current warming plan 100/);
  assert.equal((await repo.get("svc-mvp-test-01"))?.warmupDay, 2);
  assert.equal((await repo.get("svc-mvp-test-01"))?.dailyLimit, 50);
});

test("warming runbook rejects non-warming nodes", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), status: "paused" }]);
  const result = await executeWarmingStepRunbook(
    { nodeId: "svc-mvp-test-01" },
    ctx(repo, { approverIds: ["op-a", "op-b"] })
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.detail, /expected warming/);
});

test("warming runbook rejects max warmup day", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), warmupDay: 30 }]);
  const result = await executeWarmingStepRunbook(
    { nodeId: "svc-mvp-test-01" },
    ctx(repo, { approverIds: ["op-a", "op-b"] })
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.detail, /at max/);
});

test("pause runbook changes active or warming nodes to paused", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const result = await executePauseIpRunbook(
    { nodeId: "svc-mvp-test-01", reason: "reputation" },
    ctx(repo, { rollbackToken: "rb-pause" })
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.newState : {}, {
    status: "paused",
    warmupDay: 1,
    dailyLimit: 50
  });
  assert.equal((await repo.get("svc-mvp-test-01"))?.status, "paused");
});

test("pause runbook rejects already paused nodes", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), status: "paused" }]);
  const result = await executePauseIpRunbook({ nodeId: "svc-mvp-test-01" }, ctx(repo));

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.rejectReason, "preconditions_failed");
});

test("quarantine runbook moves active, warming or paused nodes to quarantined", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const result = await executeQuarantineRunbook(
    { nodeId: "svc-mvp-test-01", reason: "SBL hit", evidenceRefs: ["sha:abc"] },
    ctx(repo, { rollbackToken: "rb-quarantine" })
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.newState : {}, {
    status: "quarantined",
    warmupDay: 1,
    dailyLimit: 50,
    reason: "SBL hit",
    evidenceRefs: ["sha:abc"]
  });
  assert.equal((await repo.get("svc-mvp-test-01"))?.status, "quarantined");
});

test("quarantine runbook rejects missing reason", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const result = await executeQuarantineRunbook(
    { nodeId: "svc-mvp-test-01", reason: "", evidenceRefs: [] },
    ctx(repo)
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.rejectReason, "preconditions_failed");
});

test("quarantine runbook rejects terminal states", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), status: "retired" }]);
  const result = await executeQuarantineRunbook(
    { nodeId: "svc-mvp-test-01", reason: "SBL hit", evidenceRefs: [] },
    ctx(repo)
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.detail, /Cannot quarantine/);
});

test("runbooks reject when kill switch is active", async () => {
  const repo = new MemoryRunbookSenderNodeRepository();
  const result = await executeRegisterSenderNodeRunbook(
    sampleRegisterInput(),
    ctx(repo, { killSwitchState: "active" })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.rejectReason, "kill_switch_armed");
});

test("quarantine runbook rejects idempotency replay by proposal id", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const executedProposalIds = new Set<string>(["proposal-1"]);
  const result = await executeQuarantineRunbook(
    { nodeId: "svc-mvp-test-01", reason: "SBL hit", evidenceRefs: [] },
    ctx(repo, { executedProposalIds })
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.detail, /already executed/);
});

test("revert restores pause snapshot to previous warming state", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), status: "paused", warmupDay: 2, dailyLimit: 100 }]);
  const result = await revertRunbook({
    repository: repo,
    now: rollbackNow,
    snapshot: snapshot("pause-ip", {
      status: "warming",
      warmupDay: 2,
      dailyLimit: 100
    })
  });

  assert.equal(result.ok, true);
  assert.equal((await repo.get("svc-mvp-test-01"))?.status, "warming");
  assert.equal((await repo.get("svc-mvp-test-01"))?.warmupDay, 2);
});

test("revert restores warming snapshot fields", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), warmupDay: 2, dailyLimit: 100 }]);
  const result = await revertRunbook({
    repository: repo,
    now: rollbackNow,
    snapshot: snapshot("warming-step", {
      status: "warming",
      warmupDay: 1,
      dailyLimit: 50
    })
  });

  assert.equal(result.ok, true);
  assert.equal((await repo.get("svc-mvp-test-01"))?.warmupDay, 1);
  assert.equal((await repo.get("svc-mvp-test-01"))?.dailyLimit, 50);
});

test("revert register marks node retired_pending_approval instead of deleting", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const result = await revertRunbook({
    repository: repo,
    now: rollbackNow,
    snapshot: snapshot("register-sender-node-local", { existed: false })
  });

  assert.equal(result.ok, true);
  assert.equal((await repo.get("svc-mvp-test-01"))?.status, "retired_pending_approval");
});

test("revert rejects expired snapshots", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([sampleNode()]);
  const result = await revertRunbook({
    repository: repo,
    now: new Date("2026-05-20T00:00:00.000Z"),
    snapshot: {
      ...snapshot("pause-ip", { status: "warming" }),
      expiresAt: "2026-05-19T00:00:00.000Z"
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.rejectReason, "rollback_token_expired");
});

test("revert quarantine supports explicit retired target status", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), status: "quarantined" }]);
  const result = await revertRunbook({
    repository: repo,
    now: rollbackNow,
    snapshot: snapshot("incident-quarantine", {
      status: "warming",
      warmupDay: 1,
      dailyLimit: 50
    }),
    metadata: { targetStatus: "retired" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.restoredState : {}, { status: "retired" });
  assert.equal((await repo.get("svc-mvp-test-01"))?.status, "retired");
});

test("revert quarantine defaults to active target status", async () => {
  const repo = new MemoryRunbookSenderNodeRepository([{ ...sampleNode(), status: "quarantined" }]);
  const result = await revertRunbook({
    repository: repo,
    now: rollbackNow,
    snapshot: snapshot("incident-quarantine", {
      status: "warming",
      warmupDay: 1,
      dailyLimit: 50
    })
  });

  assert.equal(result.ok, true);
  assert.equal((await repo.get("svc-mvp-test-01"))?.status, "active");
});

function ctx(
  repository: RunbookSenderNodeRepository,
  overrides: Partial<RunbookContext> & { rollbackToken?: string } = {}
): RunbookContext {
  return {
    proposalId: "proposal-1",
    approverIds: ["op-a", "op-b"],
    killSwitchState: "armed",
    occurredAt,
    repository,
    persistRollbackSnapshot: () => overrides.rollbackToken ?? "rb-token",
    executedProposalIds: overrides.executedProposalIds,
    ...overrides
  };
}

function sampleRegisterInput(): RegisterSenderNodeInput {
  return {
    id: "svc-mvp-test-01",
    label: "MVP Test 01",
    provider: "webdock",
    status: "warming",
    ipAddress: "185.243.12.40",
    hostname: "svc-mvp-test-01.delivrix.local",
    dailyLimit: 50,
    warmupDay: 1
  };
}

function sampleNode(): SenderNode {
  return {
    ...sampleRegisterInput(),
    status: "warming",
    warmupDay: 1
  };
}

function snapshot(runbookId: RollbackSnapshot["runbookId"], prevState: unknown): RollbackSnapshot {
  return {
    rollbackToken: "rb-token",
    runbookId,
    targetType: "sender_node",
    targetId: "svc-mvp-test-01",
    prevStateJson: JSON.stringify(prevState),
    createdAt: occurredAt,
    expiresAt: "2026-05-26T12:00:00.000Z",
    status: "available"
  };
}

class MemoryRunbookSenderNodeRepository implements RunbookSenderNodeRepository {
  private readonly nodes = new Map<string, SenderNode>();

  constructor(nodes: SenderNode[] = []) {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async list(): Promise<SenderNode[]> {
    return [...this.nodes.values()];
  }

  async get(senderNodeId: string): Promise<SenderNode | null> {
    return this.nodes.get(senderNodeId) ?? null;
  }

  async exists(senderNodeId: string): Promise<boolean> {
    return this.nodes.has(senderNodeId);
  }

  async existsByIp(ipAddress: string | undefined): Promise<boolean> {
    return [...this.nodes.values()].some((node) => node.ipAddress === ipAddress);
  }

  async register(input: RegisterSenderNodeInput): Promise<SenderNode> {
    const node: SenderNode = {
      ...input,
      status: input.status ?? "warming",
      warmupDay: input.warmupDay ?? 0
    };
    this.nodes.set(node.id, node);
    return node;
  }

  async updateStatus(senderNodeId: string, status: SenderNode["status"]): Promise<SenderNode> {
    return this.updateMetadata(senderNodeId, { status });
  }

  async updateMetadata(
    senderNodeId: string,
    patch: Partial<Pick<SenderNode, "status" | "dailyLimit" | "warmupDay" | "ipAddress" | "hostname" | "label">>
  ): Promise<SenderNode> {
    const node = this.nodes.get(senderNodeId);

    if (!node) {
      throw new Error(`Sender node not found: ${senderNodeId}`);
    }

    const updated = { ...node, ...patch };
    this.nodes.set(senderNodeId, updated);
    return updated;
  }
}
