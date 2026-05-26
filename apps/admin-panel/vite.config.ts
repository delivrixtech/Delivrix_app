import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { READ_ENDPOINTS, type ReadEndpoint } from "./src/shared/api/read-boundary.ts";

const gatewayOrigin = process.env.ADMIN_PANEL_GATEWAY_ORIGIN ?? "http://127.0.0.1:3000";
const allowedProxyPaths = new Set(Object.values(READ_ENDPOINTS));
const chatSendPath = "/v1/openclaw/chat/send";
const chatStreamPath = "/v1/openclaw/chat/stream";

/**
 * Write endpoints permitidos desde el admin panel. El panel administrativo
 * necesita ejecutar acciones operativas P0 (kill switch, snapshot ingest,
 * solicitar evaluación). Las protecciones reales viven en el backend:
 * - Audit append-only obligatorio en cada acción.
 * - Reason + actorId requeridos por contrato.
 * - humanApproved=true para snapshot ingest.
 * - Regla de 2 personas para kill switch.
 *
 * Otros POST (proposals, scheduler, runbook evaluate, demo, etc.) siguen
 * bloqueados para que solo OpenClaw/CLI los disparen.
 */
const allowedWritePaths = new Set<string>([
  "/v1/kill-switch",
  "/v1/openclaw/onboarding/evaluate",
  "/v1/devops/collector/manual-snapshots/ingest"
]);

export default defineConfig({
  plugins: [readOnlyProxyBoundary(), tailwindcss(), react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: {
      "/health": {
        target: gatewayOrigin,
        changeOrigin: false
      },
      "/v1": {
        target: gatewayOrigin,
        changeOrigin: false,
        ws: true
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/")) {
            return "vendor-react";
          }
          if (id.includes("/node_modules/@tanstack/react-query/")) {
            return "vendor-query";
          }
          if (id.includes("/node_modules/@radix-ui/")) {
            return "vendor-radix";
          }
          if (id.includes("/node_modules/lucide-react/")) {
            return "vendor-icons";
          }
        }
      }
    }
  },
  optimizeDeps: {
    force: process.env.VITE_FORCE_OPTIMIZE === "1"
  }
});

function readOnlyProxyBoundary(): Plugin {
  return {
    name: "delivrix-read-only-proxy-boundary",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1:5173");
        const isProxyPath = requestUrl.pathname === "/health" || requestUrl.pathname.startsWith("/v1/");
        const isApprovalWrite =
          request.method === "POST" &&
          /^\/v1\/agent\/proposals\/[^/]+\/approve$/.test(requestUrl.pathname);
        const isChatSend =
          request.method === "POST" &&
          requestUrl.pathname === chatSendPath;
        const isChatStream =
          request.method === "GET" &&
          requestUrl.pathname === chatStreamPath;
        const isAllowedWrite =
          request.method === "POST" &&
          allowedWritePaths.has(requestUrl.pathname);
        // Canvas Live (Bloque 7): approve / reject como POST, edit block como PATCH.
        // El gateway audita los 3 como acción crítica con regla operador.
        const isCanvasArtifactApprove =
          request.method === "POST" &&
          /^\/v1\/canvas\/artifact\/[^/]+\/approve$/.test(requestUrl.pathname);
        const isCanvasArtifactReject =
          request.method === "POST" &&
          /^\/v1\/canvas\/artifact\/[^/]+\/reject$/.test(requestUrl.pathname);
        const isCanvasArtifactBlockPatch =
          request.method === "PATCH" &&
          /^\/v1\/canvas\/artifact\/[^/]+\/block\/[^/]+$/.test(requestUrl.pathname);
        // WSS upgrade del canvas-live stream (sale por el proxy normal, pero
        // el middleware lo ve como GET con header Upgrade).
        const isCanvasLiveStream =
          request.method === "GET" &&
          requestUrl.pathname === "/v1/canvas/live/stream";

        if (!isProxyPath) {
          next();
          return;
        }

        if (
          isApprovalWrite ||
          isChatSend ||
          isChatStream ||
          isAllowedWrite ||
          isCanvasArtifactApprove ||
          isCanvasArtifactReject ||
          isCanvasArtifactBlockPatch ||
          isCanvasLiveStream
        ) {
          next();
          return;
        }

        if (request.method !== "GET") {
          writeJson(response, 405, {
            error: "method_not_allowed",
            message:
              "Admin panel proxy bloquea esta acción. Si necesita estar disponible para el operador, añadirla a allowedWritePaths en vite.config.ts con audit + gate backend."
          });
          return;
        }

        if (!allowedProxyPaths.has(requestUrl.pathname as ReadEndpoint)) {
          writeJson(response, 404, {
            error: "unknown_read_endpoint",
            message: "Endpoint is not exposed to the read-only admin panel."
          });
          return;
        }

        next();
      });
    }
  };
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload, null, 2));
}
