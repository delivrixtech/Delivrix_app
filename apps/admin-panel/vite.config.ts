import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { READ_ENDPOINTS, type ReadEndpoint } from "./src/shared/api/read-boundary.ts";

const gatewayOrigin = process.env.ADMIN_PANEL_GATEWAY_ORIGIN ?? "http://127.0.0.1:3000";
const chatSendPath = "/v1/openclaw/chat/send";
const chatStreamPath = "/v1/openclaw/chat/stream";
const canvasLiveStatePath = "/v1/canvas/live/state";
const canvasLiveStreamPath = "/v1/canvas/live/stream";
const gatewayLogStreamPath = "/v1/gateway/logs/stream";
const canvasLiveProxyToken =
  process.env.CANVAS_LIVE_STREAM_TOKEN ??
  process.env.DELIVRIX_READ_BOUNDARY_TOKEN ??
  process.env.OPENCLAW_GATEWAY_TOKEN ??
  "";
const gatewayLogProxyToken =
  process.env.GATEWAY_LOG_STREAM_TOKEN ??
  process.env.DELIVRIX_OPENCLAW_TOKEN ??
  process.env.DELIVRIX_READ_BOUNDARY_TOKEN ??
  process.env.OPENCLAW_GATEWAY_TOKEN ??
  "";
const allowedProxyPaths = new Set([...Object.values(READ_ENDPOINTS), canvasLiveStatePath]);
const allowedReadPatterns: RegExp[] = [
  /^\/v1\/openclaw\/proposals\/[^/]+\/status$/
];

/**
 * Write endpoints permitidos desde el admin panel. El panel administrativo
 * necesita ejecutar acciones operativas P0 (kill switch, snapshot ingest,
 * solicitar evaluación). Las protecciones reales viven en el backend:
 * - Audit append-only obligatorio en cada acción.
 * - Reason + actorId requeridos por contrato.
 * - humanApproved=true para snapshot ingest.
 * - Kill switch (1 firma operador via panel).
 * - Sign de propuestas via ApprovalGate (1 firma operador, post cambio norte 2026-05-29).
 * - Reject de propuestas via ApprovalGate.
 *
 * Otros POST (proposals submit, scheduler, runbook evaluate, demo, etc.) siguen
 * bloqueados para que solo OpenClaw/CLI los disparen.
 *
 * Detalle: el path /sign queda whitelisteado por regex porque incluye {auditId}
 * dinámico. El backend valida la integridad de la firma vía audit chain SHA-256.
 */
const allowedWritePaths = new Set<string>([
  "/v1/kill-switch",
  "/v1/openclaw/onboarding/evaluate",
  "/v1/devops/collector/manual-snapshots/ingest"
]);

/**
 * Patrones POST permitidos (regex). Para paths con segmentos dinámicos
 * tipo /v1/openclaw/proposals/{auditId}/sign.
 */
const allowedWritePatterns: RegExp[] = [
  /^\/v1\/openclaw\/proposals\/[^/]+\/sign$/,
  /^\/v1\/openclaw\/proposals\/[^/]+\/reject$/
];

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
        ws: true,
        rewrite: rewriteGatewayProxyPath,
        // El gateway (:3000) se reinicia mientras el panel sigue abierto. Sin estos
        // handlers, un EPIPE/ECONNRESET/ECONNREFUSED del socket WS proxiado (canvas-live)
        // se vuelve excepcion no capturada y tumba TODO el dev server -> el panel :5173
        // cae con ERR_CONNECTION_REFUSED. Capturarlos los degrada a warning sin matar Vite.
        configure: (proxy) => {
          proxy.on("error", (err) => {
            console.warn(`[vite] proxy error (ignorado, panel sigue vivo): ${err.message}`);
          });
          proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
            socket.on("error", (err) => {
              console.warn(`[vite] ws client socket error (ignorado): ${err.message}`);
            });
          });
          proxy.on("open", (proxySocket) => {
            proxySocket.on("error", (err) => {
              console.warn(`[vite] ws upstream socket error (ignorado): ${err.message}`);
            });
          });
        }
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
        const isGatewayLogStream =
          request.method === "GET" &&
          requestUrl.pathname === gatewayLogStreamPath;
        const isAllowedWrite =
          request.method === "POST" &&
          (allowedWritePaths.has(requestUrl.pathname) ||
            allowedWritePatterns.some((re) => re.test(requestUrl.pathname)));
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
          requestUrl.pathname === canvasLiveStreamPath;

        if (!isProxyPath) {
          next();
          return;
        }

        if (
          isApprovalWrite ||
          isChatSend ||
          isChatStream ||
          isGatewayLogStream ||
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

        if (
          !allowedProxyPaths.has(requestUrl.pathname as ReadEndpoint) &&
          !allowedReadPatterns.some((re) => re.test(requestUrl.pathname))
        ) {
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

function rewriteGatewayProxyPath(pathnameWithSearch: string): string {
  const url = new URL(pathnameWithSearch, "http://127.0.0.1");
  if (url.pathname === canvasLiveStreamPath) {
    appendTokenIfMissing(url, canvasLiveProxyToken);
  }
  if (url.pathname === gatewayLogStreamPath) {
    appendTokenIfMissing(url, gatewayLogProxyToken);
  }
  return `${url.pathname}${url.search}`;
}

function appendTokenIfMissing(url: URL, token: string): void {
  if (token && !url.searchParams.has("token")) {
    url.searchParams.set("token", token);
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload, null, 2));
}
