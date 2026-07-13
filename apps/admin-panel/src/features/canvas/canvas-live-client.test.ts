import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { LiveAction, LiveArtifact, LiveTask, LiveTaskStatus } from "./live-tool-types.ts";
import type { LiveRunProgressMap } from "./smtp-live-progress.ts";

interface InternalStateShape {
  tasks: Map<string, LiveTask>;
  lastAction: Map<string, LiveAction>;
  artifacts: Map<string, LiveArtifact>;
  artifactToTask: Map<string, string>;
  liveRunProgress: LiveRunProgressMap;
}

interface CanvasLiveClientModule {
  buildCanvasLiveStreamUrl: (location: { protocol: string; host: string }, streamToken?: string) => string;
  canvasLiveRequestHeaders: (streamToken?: string) => HeadersInit;
  createSnapshotRequestGate: () => {
    begin: () => {
      controller: AbortController;
      isCurrent: () => boolean;
      finish: () => void;
    };
    abortCurrent: () => void;
  };
  MAX_LIVE_TASKS: number;
  MAX_LIVE_ARTIFACTS: number;
  evictLiveState: (state: InternalStateShape, activeTaskId: string | null) => void;
  matchesLiveEventType: (
    raw: unknown,
    eventTypes: readonly string[]
  ) => { type: string; payload: Record<string, unknown> } | null;
}

let server: ViteDevServer | null = null;

async function loadModule(): Promise<CanvasLiveClientModule> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server.ssrLoadModule("/src/features/canvas/canvas-live-client.ts") as Promise<CanvasLiveClientModule>;
}

after(async () => {
  await server?.close();
});

/* -------- Helpers para los tests de evicción -------- */

function makeTask(
  id: string,
  createdAt: string,
  status: LiveTaskStatus = "completed",
  parentTaskId: string | null = null
): LiveTask {
  return {
    id,
    title: `task ${id}`,
    status,
    createdAt,
    actorId: "openclaw",
    parentTaskId
  };
}

function makeAction(taskId: string): LiveAction {
  return {
    kind: "audit",
    taskId,
    eventName: "test.event",
    summary: `summary ${taskId}`,
    occurredAt: "2026-06-08T00:00:00.000Z"
  };
}

function makeArtifact(id: string, taskId: string, createdAt = "2026-06-08T00:00:00.000Z"): LiveArtifact {
  return {
    id,
    taskId,
    kind: "plan",
    title: `artifact ${id}`,
    editable: false,
    createdAt,
    approvalStatus: "pending",
    blocks: []
  };
}

function makeState(tasks: LiveTask[]): InternalStateShape {
  const state: InternalStateShape = {
    tasks: new Map(),
    lastAction: new Map(),
    artifacts: new Map(),
    artifactToTask: new Map(),
    liveRunProgress: new Map()
  };
  for (const task of tasks) {
    state.tasks.set(task.id, task);
  }
  return state;
}

/** createdAt incremental: t0000 más viejo, t{n} más nuevo. */
function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 5, 8, 0, 0, 0, 0) + index * 60_000).toISOString();
}

test("matchesLiveEventType parses a string frame and matches by type (PR-08)", async () => {
  const { matchesLiveEventType } = await loadModule();
  const types = ["infra.inventory.updated", "senderpool.inventory.updated"];

  const match = matchesLiveEventType(
    JSON.stringify({ type: "infra.inventory.updated", hash: "abc" }),
    types
  );
  assert.equal(match?.type, "infra.inventory.updated");
  assert.equal(match?.payload.hash, "abc");

  const objMatch = matchesLiveEventType({ type: "senderpool.inventory.updated" }, types);
  assert.equal(objMatch?.type, "senderpool.inventory.updated");
});

test("matchesLiveEventType matches the real oc.action.now audit-envelope frame emitted by the backend (PR-08)", async () => {
  const { matchesLiveEventType } = await loadModule();
  const types = [
    "infra.inventory.updated",
    "infra.smtp_health.updated",
    "senderpool.inventory.updated"
  ];

  // Forma exacta que emite emitInventoryUpdatedSignal() en el backend: el
  // top-level `type` es SIEMPRE "oc.action.now" y el nombre real del evento
  // viaja en `action`. Este es el frame que llega por el socket.
  const infraFrame = JSON.stringify({
    type: "oc.action.now",
    taskId: "infra-inventory-live",
    kind: "audit",
    action: "infra.inventory.updated",
    targetType: "infrastructure_inventory",
    targetId: "inventory",
    riskLevel: "low",
    metadata: { hash: "deadbeef" },
    occurredAt: "2026-07-13T00:00:00.000Z"
  });
  const infraMatch = matchesLiveEventType(infraFrame, types);
  assert.equal(infraMatch?.type, "infra.inventory.updated");
  assert.equal((infraMatch?.payload.metadata as { hash?: string }).hash, "deadbeef");

  const senderMatch = matchesLiveEventType(
    { type: "oc.action.now", kind: "audit", action: "senderpool.inventory.updated" },
    types
  );
  assert.equal(senderMatch?.type, "senderpool.inventory.updated");

  // Un oc.action.now cuyo `action` NO está en la lista no debe matchear.
  assert.equal(
    matchesLiveEventType({ type: "oc.action.now", action: "smtp.run.progress" }, types),
    null
  );
  // Un oc.action.now sin `action` string no rompe ni matchea.
  assert.equal(matchesLiveEventType({ type: "oc.action.now" }, types), null);
});

test("matchesLiveEventType ignores unrelated, malformed and non-typed frames (PR-08)", async () => {
  const { matchesLiveEventType } = await loadModule();
  const types = ["infra.inventory.updated"];

  assert.equal(matchesLiveEventType(JSON.stringify({ type: "oc.task.declare" }), types), null);
  assert.equal(matchesLiveEventType("{not-json", types), null);
  assert.equal(matchesLiveEventType({ noType: true }, types), null);
  assert.equal(matchesLiveEventType(null, types), null);
});

test("snapshot request gate aborts the previous request and marks it stale", async () => {
  const { createSnapshotRequestGate } = await loadModule();
  const gate = createSnapshotRequestGate();

  const first = gate.begin();
  assert.equal(first.isCurrent(), true);

  const second = gate.begin();
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);

  second.finish();
  assert.equal(second.isCurrent(), false);
});

test("snapshot request gate abortCurrent invalidates the active request", async () => {
  const { createSnapshotRequestGate } = await loadModule();
  const gate = createSnapshotRequestGate();
  const request = gate.begin();

  gate.abortCurrent();

  assert.equal(request.controller.signal.aborted, true);
  assert.equal(request.isCurrent(), false);
});

test("canvas live client appends stream token and bearer snapshot header", async () => {
  const { buildCanvasLiveStreamUrl, canvasLiveRequestHeaders } = await loadModule();

  assert.equal(
    buildCanvasLiveStreamUrl({ protocol: "http:", host: "127.0.0.1:5173" }, "canvas-token"),
    "ws://127.0.0.1:5173/v1/canvas/live/stream?token=canvas-token"
  );
  assert.equal(
    buildCanvasLiveStreamUrl({ protocol: "https:", host: "panel.delivrix.test" }, ""),
    "wss://panel.delivrix.test/v1/canvas/live/stream"
  );
  assert.deepEqual(canvasLiveRequestHeaders("canvas-token"), {
    accept: "application/json",
    authorization: "Bearer canvas-token"
  });
  assert.deepEqual(canvasLiveRequestHeaders(""), {
    accept: "application/json"
  });
});

test("evictLiveState is a no-op when task count is at or below MAX_LIVE_TASKS", async () => {
  const { evictLiveState, MAX_LIVE_TASKS } = await loadModule();
  const tasks = Array.from({ length: MAX_LIVE_TASKS }, (_, i) => makeTask(`t${i}`, isoAt(i)));
  const state = makeState(tasks);

  evictLiveState(state, null);

  assert.equal(state.tasks.size, MAX_LIVE_TASKS);
  for (let i = 0; i < MAX_LIVE_TASKS; i += 1) {
    assert.equal(state.tasks.has(`t${i}`), true);
  }
});

test("evictLiveState caps to MAX_LIVE_TASKS keeping the most recent tasks", async () => {
  const { evictLiveState, MAX_LIVE_TASKS } = await loadModule();
  const total = MAX_LIVE_TASKS + 10;
  // t0 oldest … t{total-1} newest.
  const tasks = Array.from({ length: total }, (_, i) => makeTask(`t${i}`, isoAt(i)));
  const state = makeState(tasks);

  evictLiveState(state, null);

  assert.equal(state.tasks.size, MAX_LIVE_TASKS);
  // The 10 oldest (t0..t9) are evicted; the 50 most recent survive.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(state.tasks.has(`t${i}`), false, `t${i} should be evicted`);
  }
  for (let i = 10; i < total; i += 1) {
    assert.equal(state.tasks.has(`t${i}`), true, `t${i} should survive`);
  }
});

test("evictLiveState preserves the active task even when it is the oldest, with its lastAction and artifact", async () => {
  const { evictLiveState, MAX_LIVE_TASKS } = await loadModule();
  const total = MAX_LIVE_TASKS + 10;
  const tasks = Array.from({ length: total }, (_, i) => makeTask(`t${i}`, isoAt(i)));
  const state = makeState(tasks);
  // t0 is the oldest and would normally be evicted; mark it active.
  const activeId = "t0";
  state.lastAction.set(activeId, makeAction(activeId));
  state.artifacts.set("a0", makeArtifact("a0", activeId));
  state.artifactToTask.set("a0", activeId);

  evictLiveState(state, activeId);

  assert.equal(state.tasks.size, MAX_LIVE_TASKS);
  assert.equal(state.tasks.has(activeId), true, "active task must survive");
  assert.equal(state.lastAction.has(activeId), true, "active task lastAction must survive");
  assert.equal(state.artifacts.has("a0"), true, "active task artifact must survive");
  assert.equal(state.artifactToTask.get("a0"), activeId);
  // Exactly one extra-old task was sacrificed to make room for the active one.
  assert.equal(state.tasks.has("t1"), false, "oldest non-active task should be evicted to make room");
});

test("evictLiveState preserves ALL running tasks even when they are the oldest", async () => {
  const { evictLiveState, MAX_LIVE_TASKS } = await loadModule();
  const total = MAX_LIVE_TASKS + 10;
  const tasks = Array.from({ length: total }, (_, i) => makeTask(`t${i}`, isoAt(i)));
  // Mark the 15 oldest tasks as running (more than the would-be-evicted set of 10).
  for (let i = 0; i < 15; i += 1) {
    tasks[i] = makeTask(`t${i}`, isoAt(i), "running");
  }
  const state = makeState(tasks);

  evictLiveState(state, null);

  assert.equal(state.tasks.size, MAX_LIVE_TASKS);
  for (let i = 0; i < 15; i += 1) {
    assert.equal(state.tasks.has(`t${i}`), true, `running t${i} must survive`);
  }
  // With 15 running preserved + 35 newest, the newest 35 (t25..t59) survive,
  // and the non-running middle ones (t15..t24) are evicted.
  for (let i = 15; i < 25; i += 1) {
    assert.equal(state.tasks.has(`t${i}`), false, `non-running middle t${i} should be evicted`);
  }
  for (let i = 25; i < total; i += 1) {
    assert.equal(state.tasks.has(`t${i}`), true, `newest t${i} should survive`);
  }
});

test("evictLiveState caps artifacts even when task count is already small", async () => {
  const { evictLiveState, MAX_LIVE_ARTIFACTS } = await loadModule();
  const state = makeState([makeTask("active", isoAt(0), "completed")]);
  for (let i = 0; i < MAX_LIVE_ARTIFACTS + 25; i += 1) {
    state.artifacts.set(`a${i}`, makeArtifact(`a${i}`, "active", isoAt(i)));
    state.artifactToTask.set(`a${i}`, "active");
  }

  evictLiveState(state, "active");

  assert.equal(state.tasks.size, 1);
  assert.equal(state.artifacts.size, MAX_LIVE_ARTIFACTS);
  assert.equal(state.artifactToTask.size, MAX_LIVE_ARTIFACTS);
  for (let i = 0; i < 25; i += 1) {
    assert.equal(state.artifacts.has(`a${i}`), false, `old artifact a${i} should be evicted`);
  }
});

test("evictLiveState keeps a hard task cap when running tasks are stale zombies", async () => {
  const { evictLiveState, MAX_LIVE_TASKS } = await loadModule();
  const total = MAX_LIVE_TASKS + 30;
  const tasks = Array.from({ length: total }, (_, i) => makeTask(`running-${i}`, isoAt(i), "running"));
  const state = makeState(tasks);

  evictLiveState(state, null);

  assert.equal(state.tasks.size, MAX_LIVE_TASKS);
  for (let i = 0; i < total - MAX_LIVE_TASKS; i += 1) {
    assert.equal(state.tasks.has(`running-${i}`), false, `old running zombie ${i} should be evicted`);
  }
  for (let i = total - MAX_LIVE_TASKS; i < total; i += 1) {
    assert.equal(state.tasks.has(`running-${i}`), true, `recent running ${i} should survive`);
  }
});

test("evictLiveState preserves transitive ancestors of a running task (g <- p <- c-running)", async () => {
  const { evictLiveState, MAX_LIVE_TASKS } = await loadModule();
  // grandparent (oldest), parent, child-running are all old and would be evicted by recency,
  // but the running child pulls its whole ancestor chain into the preserve set.
  const grandparent = makeTask("g", isoAt(0), "completed", null);
  const parent = makeTask("p", isoAt(1), "completed", "g");
  const childRunning = makeTask("c", isoAt(2), "running", "p");
  // Fill the rest with newer, unrelated, completed tasks.
  const filler = Array.from({ length: MAX_LIVE_TASKS + 10 }, (_, i) =>
    makeTask(`f${i}`, isoAt(100 + i))
  );
  const state = makeState([grandparent, parent, childRunning, ...filler]);

  evictLiveState(state, null);

  assert.equal(state.tasks.size, MAX_LIVE_TASKS);
  assert.equal(state.tasks.has("c"), true, "running child must survive");
  assert.equal(state.tasks.has("p"), true, "parent ancestor must survive");
  assert.equal(state.tasks.has("g"), true, "grandparent ancestor must survive");
});

test("evictLiveState deletes lastAction/artifacts/artifactToTask of evicted tasks and keeps the invariant that every artifact points to a live task", async () => {
  const { evictLiveState, MAX_LIVE_TASKS } = await loadModule();
  const total = MAX_LIVE_TASKS + 10;
  const tasks = Array.from({ length: total }, (_, i) => makeTask(`t${i}`, isoAt(i)));
  const state = makeState(tasks);
  // Attach a lastAction + artifact to EVERY task, including the 10 oldest that will be evicted.
  for (let i = 0; i < total; i += 1) {
    state.lastAction.set(`t${i}`, makeAction(`t${i}`));
    state.artifacts.set(`a${i}`, makeArtifact(`a${i}`, `t${i}`));
    state.artifactToTask.set(`a${i}`, `t${i}`);
  }

  evictLiveState(state, null);

  assert.equal(state.tasks.size, MAX_LIVE_TASKS);
  // The 10 oldest tasks (t0..t9) and all their satellite state are gone.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(state.tasks.has(`t${i}`), false);
    assert.equal(state.lastAction.has(`t${i}`), false, `lastAction for evicted t${i} must be deleted`);
    assert.equal(state.artifacts.has(`a${i}`), false, `artifact for evicted t${i} must be deleted`);
    assert.equal(state.artifactToTask.has(`a${i}`), false, `artifactToTask for evicted t${i} must be deleted`);
  }
  // Surviving tasks keep their satellite state.
  for (let i = 10; i < total; i += 1) {
    assert.equal(state.lastAction.has(`t${i}`), true);
    assert.equal(state.artifacts.has(`a${i}`), true);
  }
  // Invariant: every remaining artifact points to a live task.
  for (const [artifactId, taskId] of state.artifactToTask.entries()) {
    assert.equal(state.tasks.has(taskId), true, `artifact ${artifactId} points to a dead task ${taskId}`);
  }
  for (const artifact of state.artifacts.values()) {
    assert.equal(state.tasks.has(artifact.taskId), true, `artifact ${artifact.id} points to a dead task ${artifact.taskId}`);
  }
});
