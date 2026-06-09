import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { LiveAction, LiveArtifact, LiveTask, LiveTaskStatus } from "./live-tool-types.ts";

interface InternalStateShape {
  tasks: Map<string, LiveTask>;
  lastAction: Map<string, LiveAction>;
  artifacts: Map<string, LiveArtifact>;
  artifactToTask: Map<string, string>;
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
  evictLiveState: (state: InternalStateShape, activeTaskId: string | null) => void;
}

let server: ViteDevServer | null = null;

async function loadModule(): Promise<CanvasLiveClientModule> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
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

function makeArtifact(id: string, taskId: string): LiveArtifact {
  return {
    id,
    taskId,
    kind: "plan",
    title: `artifact ${id}`,
    editable: false,
    createdAt: "2026-06-08T00:00:00.000Z",
    approvalStatus: "pending",
    blocks: []
  };
}

function makeState(tasks: LiveTask[]): InternalStateShape {
  const state: InternalStateShape = {
    tasks: new Map(),
    lastAction: new Map(),
    artifacts: new Map(),
    artifactToTask: new Map()
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
