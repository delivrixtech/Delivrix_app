import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { LiveAction } from "./live-tool-types.ts";

interface LiveToolModule {
  CommandActionView: React.ComponentType<{ action: Extract<LiveAction, { kind: "command" }> }>;
  commitEditableTitleText: (textContent: string | null, title: string, onChange: (value: string) => void) => string;
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
