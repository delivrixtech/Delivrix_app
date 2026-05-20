import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { READ_ENDPOINTS, type ReadEndpoint } from "./src/shared/api/read-boundary.ts";

const gatewayOrigin = process.env.ADMIN_PANEL_GATEWAY_ORIGIN ?? "http://127.0.0.1:3000";
const allowedProxyPaths = new Set(Object.values(READ_ENDPOINTS));
const chatSendPath = "/v1/openclaw/chat/send";
const chatStreamPath = "/v1/openclaw/chat/stream";

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

        if (!isProxyPath) {
          next();
          return;
        }

        if (isApprovalWrite || isChatSend || isChatStream) {
          next();
          return;
        }

        if (request.method !== "GET") {
          writeJson(response, 405, {
            error: "method_not_allowed",
            message: "Admin panel proxy is GET-only."
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
