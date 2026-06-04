import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

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
