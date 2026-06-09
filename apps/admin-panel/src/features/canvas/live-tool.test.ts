import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { LiveAction, LiveTask } from "./live-tool-types.ts";

/** Estructura mínima del nodo del árbol que asertamos (mirror de TaskNode interno). */
interface TaskNodeShape {
  id: string;
  title: string;
  repeatCount: number;
  children: TaskNodeShape[];
}

interface LiveToolModule {
  CommandActionView: React.ComponentType<{ action: Extract<LiveAction, { kind: "command" }> }>;
  commitEditableTitleText: (textContent: string | null, title: string, onChange: (value: string) => void) => string;
  buildTaskTree: (tasks: LiveTask[]) => TaskNodeShape[];
}

/**
 * Replica EXACTA de la fórmula `totalShown` del header "Tareas · N"
 * (live-tool.tsx ~:243): raíces + descendientes. Sirve para probar que un
 * huérfano re-rooteado queda CONTADO en el badge.
 */
function totalShown(tree: TaskNodeShape[]): number {
  const countDescendants = (n: TaskNodeShape): number =>
    n.children.reduce((acc, c) => acc + 1 + countDescendants(c), 0);
  return tree.length + tree.reduce((acc, n) => acc + countDescendants(n), 0);
}

function makeTask(over: Partial<LiveTask> & Pick<LiveTask, "id" | "title">): LiveTask {
  return {
    status: "completed",
    createdAt: "2026-06-08T00:00:00.000Z",
    actorId: "agent-1",
    ...over
  };
}

let server: ViteDevServer | null = null;

async function loadModule(): Promise<LiveToolModule> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server.ssrLoadModule("/src/features/canvas/live-tool.tsx") as Promise<LiveToolModule>;
}

after(async () => {
  await server?.close();
});

test("command actions render command, exit code, stdout and stderr", async () => {
  const { CommandActionView } = await loadModule();
  const markup = renderToStaticMarkup(
    React.createElement(CommandActionView, {
      action: {
        kind: "command",
        taskId: "task-1",
        cmd: "npm run check",
        exitCode: 1,
        stdout: "checked 4 files",
        stderr: "type error",
        durationMs: 1234,
        occurredAt: new Date(Date.now() - 1000).toISOString()
      }
    })
  );

  assert.match(markup, /npm run check/);
  assert.match(markup, /exit 1/);
  assert.match(markup, /checked 4 files/);
  assert.match(markup, /type error/);
});

test("editable title commit uses the blur text instead of stale draft state", async () => {
  const { commitEditableTitleText } = await loadModule();
  const committed: string[] = [];

  const next = commitEditableTitleText("Titulo nuevo", "Titulo viejo", (value) => committed.push(value));

  assert.equal(next, "Titulo nuevo");
  assert.deepEqual(committed, ["Titulo nuevo"]);
});

test("editable title commit is a no-op when text did not change", async () => {
  const { commitEditableTitleText } = await loadModule();
  const committed: string[] = [];

  const next = commitEditableTitleText("Mismo titulo", "Mismo titulo", (value) => committed.push(value));

  assert.equal(next, "Mismo titulo");
  assert.deepEqual(committed, []);
});

test("buildTaskTree re-roots an orphan whose parent was evicted so it stays visible and counted", async () => {
  const { buildTaskTree } = await loadModule();

  // Padre normal + su hijo (anidamiento que NO debe cambiar).
  const parent = makeTask({ id: "p", title: "Supervisor", status: "running", createdAt: "2026-06-08T00:00:03.000Z" });
  const child = makeTask({ id: "c", title: "Sub normal", parentTaskId: "p", createdAt: "2026-06-08T00:00:02.000Z" });
  // Huérfano: su parentTaskId apunta a un id que NO está en la lista (padre evictado).
  const orphan = makeTask({ id: "o", title: "Sub huérfano", parentTaskId: "ghost-evicted", createdAt: "2026-06-08T00:00:01.000Z" });

  const tree = buildTaskTree([parent, child, orphan]);

  // (a) El huérfano aparece como nodo RAÍZ (visible en la lista).
  const rootIds = tree.map((n) => n.id);
  assert.ok(rootIds.includes("o"), `orphan debe ser raíz; roots=${JSON.stringify(rootIds)}`);

  // (b) Está CONTADO: 2 raíces (Supervisor + huérfano) + 1 descendiente (Sub normal) = 3.
  assert.equal(tree.length, 2);
  assert.equal(totalShown(tree), 3);

  // (c) El anidamiento normal padre→hijo sigue intacto: el huérfano NO se cuela ahí.
  const supervisor = tree.find((n) => n.id === "p");
  assert.ok(supervisor, "supervisor presente");
  assert.deepEqual(supervisor.children.map((c2) => c2.id), ["c"]);
  // Y el huérfano-raíz no arrastra hijos espurios.
  const orphanRoot = tree.find((n) => n.id === "o");
  assert.ok(orphanRoot, "orphan root presente");
  assert.equal(orphanRoot.children.length, 0);
});

test("buildTaskTree leaves a normal present-parent tree unchanged (no regression)", async () => {
  const { buildTaskTree } = await loadModule();

  const parent = makeTask({ id: "p", title: "Supervisor", status: "running", createdAt: "2026-06-08T00:00:02.000Z" });
  const child = makeTask({ id: "c", title: "Sub", parentTaskId: "p", createdAt: "2026-06-08T00:00:01.000Z" });

  const tree = buildTaskTree([parent, child]);

  // Una sola raíz con un hijo anidado; total = 2.
  assert.deepEqual(tree.map((n) => n.id), ["p"]);
  assert.deepEqual(tree[0].children.map((c2) => c2.id), ["c"]);
  assert.equal(totalShown(tree), 2);
});
