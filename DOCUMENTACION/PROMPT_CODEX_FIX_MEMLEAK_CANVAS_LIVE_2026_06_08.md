# Codex — FIX memory-leak Canvas Live (admin-panel) — diff PRE-VERIFICADO, aplicar tal cual

> **Estado:** este fix ya fue **implementado y probado en un worktree aislado** (HEAD `79171f2`): panel `tsc --noEmit` EXIT 0; `npm --workspace @delivrix/admin-panel run check` (tsc + node --test + vite build) EXIT 0 con **42/42**; tests nuevos de evicción **9/9**; gateway `node --check` EXIT 0; gateway `canvas-live.test.ts` **25/25**. El working tree compartido quedó intacto. **Tu trabajo es aplicar EXACTAMENTE este diff, correr los gates, commitear atómico y deployar.** NO re-derivar ni "mejorar" la solución (fue auditada 3 veces).
> **Base:** `produ` `79171f2`. Rama `codex/fix-memleak-canvas-live`. **Subagentes OBLIGATORIO:** un subagente aplica el diff y otro subagente Auditor INDEPENDIENTE revisa ANTES del commit (confirma: anclas correctas, cero drift, que NO se tocó `snapshot()`/memoize/WebSockets/Hostinger, y que los gates quedan verdes). El diff es canónico — no re-derivar. Stop-and-report si algo no aplica limpio.

## Causa raíz (resumen)
El Canvas se recarga por RAM ("usando bastante memoria"). Fuga en `apps/admin-panel/src/features/canvas/canvas-live-client.ts` (hook `useLiveCanvasStream`): los `Map` de tasks/artifacts crecen sin eviction (181+ tasks residentes, cada una con `lastAction.responseBody` crudo), el content de streaming concatena sin tope, y `forceRender` corre por CADA evento WSS. WebSockets/timers están OK (no se tocan). Terminal/actions ya capados (no son la fuga).

## PROHIBIDO (lo descartó la auditoría — NO lo hagas)
- NO capar el nº de tasks en el `snapshot()` del backend (`canvas-live-events.ts:~95`) — rompe el extractor de contexto SMTP del agente (`openclaw-chat.ts:~2170`) + 4 tests (`canvas-live.test.ts`).
- NO memoizar las derivaciones del hook (`canvas-live-client.ts:~422-443`) — cero beneficio, riesgo de vista congelada.
- NO tocar el ciclo de vida de WebSockets/sockets ni nada de seguridad.

## Cambios (3 archivos) — el diff exacto verificado

### A) `apps/admin-panel/src/features/canvas/canvas-live-client.ts`
Agrega `MAX_LIVE_TASKS=50` + `evictLiveState(...)` exportada, exporta `InternalState`, cablea la evicción en `applyEvent` y `applySnapshot`, coalesce de `forceRender` con rAF (solo applyEvent; cancelar en cleanup; applySnapshot queda directo), y cap del content de streaming. Anclas por nombre por si las líneas corrieron.

```diff
@@ const SNAPSHOT_POLL_MS = 5_000;
+export const MAX_LIVE_TASKS = 50;

-interface InternalState {
+export interface InternalState {
   tasks: Map<string, LiveTask>;
   lastAction: Map<string, LiveAction>;
   ...
 }

+// (tras emptyState) — función pura, exportable para test
+export function evictLiveState(state: InternalState, activeTaskId: string | null): void {
+  if (state.tasks.size <= MAX_LIVE_TASKS) return;
+  const preserve = new Set<string>();
+  const addWithAncestors = (taskId: string | null | undefined): void => {
+    let cursor = taskId ?? null;
+    let guard = 0;
+    while (cursor && state.tasks.has(cursor) && !preserve.has(cursor) && guard < MAX_LIVE_TASKS) {
+      preserve.add(cursor);
+      cursor = state.tasks.get(cursor)?.parentTaskId ?? null;
+      guard += 1;
+    }
+  };
+  if (activeTaskId && state.tasks.has(activeTaskId)) addWithAncestors(activeTaskId);
+  for (const task of state.tasks.values()) if (task.status === "running") addWithAncestors(task.id);
+  if (preserve.size < MAX_LIVE_TASKS) {
+    const candidates = [...state.tasks.values()]
+      .filter((task) => !preserve.has(task.id))
+      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
+    for (const task of candidates) { if (preserve.size >= MAX_LIVE_TASKS) break; preserve.add(task.id); }
+  }
+  if (preserve.size >= state.tasks.size) return;
+  for (const taskId of [...state.tasks.keys()]) {
+    if (preserve.has(taskId)) continue;
+    state.tasks.delete(taskId);
+    state.lastAction.delete(taskId);
+  }
+  for (const [artifactId, taskId] of [...state.artifactToTask.entries()]) {
+    if (!state.tasks.has(taskId)) { state.artifacts.delete(artifactId); state.artifactToTask.delete(artifactId); }
+  }
+}

   const forceRender = useCallback(() => setTick((n) => (n + 1) % 1_000_000), []);
+  const rafPendingRef = useRef(false);
+  const rafHandleRef = useRef<number | null>(null);
+  const scheduleForceRender = useCallback(() => {
+    if (rafPendingRef.current) return;
+    rafPendingRef.current = true;
+    rafHandleRef.current = window.requestAnimationFrame(() => {
+      rafPendingRef.current = false;
+      rafHandleRef.current = null;
+      forceRender();
+    });
+  }, [forceRender]);

   // en el cleanup del useEffect del stream (donde se cierran sockets/timers), agregar:
+      if (rafHandleRef.current != null) {
+        window.cancelAnimationFrame(rafHandleRef.current);
+        rafHandleRef.current = null;
+        rafPendingRef.current = false;
+      }

   // en applySnapshot, JUSTO antes de `stateRef.current = next;`:
+      evictLiveState(next, activeTaskIdRef.current);
       stateRef.current = next;
       // (el forceRender de applySnapshot queda DIRECTO, no coalescido)

   // en el handler `oc.artifact.streaming`:
-            content: prev.content + event.chunk,
+            content: (prev.content + event.chunk).slice(-20000),

   // al FINAL de applyEvent (el forceRender() justo antes de `// eslint-disable-next-line react-hooks/exhaustive-deps`):
-      forceRender();
+      evictLiveState(s, activeTaskIdRef.current);
+      scheduleForceRender();
```

### B) `apps/gateway-api/src/services/canvas-live-events.ts` (una línea, en `applyArtifactStreaming`)
```diff
-      existing.content += event.chunk;
+      existing.content = (existing.content + event.chunk).slice(-50000);
```

### C) `apps/admin-panel/src/features/canvas/canvas-live-client.test.ts` — REEMPLAZAR el archivo por ESTE contenido EXACTO (verificado `# pass 9 # fail 0`)
Hoy NO hay cobertura de evicción. Este es el archivo COMPLETO verificado en worktree (3 tests existentes intactos + imports/helpers + 6 tests nuevos = 9/9). **Pegalo verbatim — no lo re-derives.**

```ts
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
```

**Puntos a respetar EXACTAMENTE (verificados — no improvisar):**
1. **Redeclarar el shape del state localmente como `InternalStateShape`** en el test; NO importar el tipo runtime `InternalState` del módulo bajo prueba (`ssrLoadModule` devuelve valores, no tipos).
2. **Import con extensión `.ts`**: `from "./live-tool-types.ts"` (el repo usa NodeNext/verbatim-module-syntax; sin `.ts` rompe `tsc`).
3. **`LiveAction` es una unión de 4 variantes** → usar el stub `kind: "audit"` (el más liviano: `kind`/`taskId`/`eventName`/`occurredAt`). No armar una `api` action.
4. **`LiveArtifact` requiere** `editable`, `approvalStatus`, `blocks`, `createdAt` (sin defaults) — el `makeArtifact` de arriba ya los cubre.
5. **Test #5 (running) — partición EXACTA:** con 15 running entre 60 tasks (cap 50) sobreviven las 15 running (`t0..t14`) + las 35 más nuevas (`t25..t59`); se evicta la franja media `t15..t24`. Afirmar eso, NO la intuición "se evictan las más viejas".
6. **Helper `isoAt(index)` (timestamps ISO monotónicos, paso 1 min)** es obligatorio: la evicción ordena por `createdAt.localeCompare`; sin timestamps deterministas los asserts quedan flaky.

## DoD (Codex)
1. Aplicar A+B+C exactamente. `cd apps/admin-panel && npx tsc --noEmit` → 0. `npm --workspace @delivrix/admin-panel run check` → 0 (42/42 + los 6 nuevos = el archivo da 9/9). `node --test src/routes/canvas-live.test.ts` en gateway → 25/25. `node --check` del archivo backend → 0.
2. **Commit atómico único** (A+B+C juntos). Mensaje: "Cap Canvas Live state to fix memory leak".
3. **Deploy local del panel:** rebuild/restart del serve del admin-panel (`delivrix-admin-start.sh` / `npm run dev:admin`) + restart del gateway (por la línea backend B). **NO** tocar system-context/Hostinger (esto es admin-panel, se sirve aparte — no aplica la regla de sync del agente).
4. **Push `origin produ`** (FF).
5. **Marcar PENDIENTE DE QA-VISUAL** — no dar por cerrado hasta que el operador valide en su navegador (guion abajo). El `npm test` NO detecta una regresión de render en vivo.

## QA-visual (la define Claude, la ejecuta Juanes en su Mac — obligatoria)
Con gateway + panel arriba, abrir el Canvas Live durante una corrida SMTP real/larga y verificar:
- (a) la task **activa** y las **running** siguen visibles tras superar 50 tasks;
- (b) el **árbol** de tasks se arma (ninguna sub-task running queda invisible);
- (c) el **stream** de artifacts se sigue mostrando y NO crece sin tope;
- (d) en sesión sostenida, el reload "por memoria" **no** vuelve a dispararse (mirar memoria del tab en DevTools).
Screenshots → Claude confirma o lista regresiones.

## Reportá
SHA del commit + EXIT de los gates (tsc/check/tests/node --check) + confirmación de deploy local + push, y que NO tocaste snapshot()/memoize/WebSockets/Hostinger. Dejá el cambio marcado pendiente de QA-visual.
