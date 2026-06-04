import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

interface GatewayLogTerminalModule {
  gatewayLogStreamUrl: (
    level: "info" | "warn" | "error",
    location?: { protocol: string; host: string },
    streamToken?: string
  ) => string;
}

let server: ViteDevServer | null = null;

async function loadModule(): Promise<GatewayLogTerminalModule> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server.ssrLoadModule("/src/features/canvas/gateway-log-terminal.tsx") as Promise<GatewayLogTerminalModule>;
}

after(async () => {
  await server?.close();
});

test("gateway log terminal appends level and dedicated stream token", async () => {
  const { gatewayLogStreamUrl } = await loadModule();

  assert.equal(
    gatewayLogStreamUrl("warn", { protocol: "http:", host: "127.0.0.1:5173" }, "log-token"),
    "ws://127.0.0.1:5173/v1/gateway/logs/stream?level=warn&token=log-token"
  );
  assert.equal(
    gatewayLogStreamUrl("error", { protocol: "https:", host: "panel.delivrix.test" }, ""),
    "wss://panel.delivrix.test/v1/gateway/logs/stream?level=error"
  );
});
