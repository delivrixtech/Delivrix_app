import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ADMIN_PANEL_PORT ?? 5173);
const host = process.env.ADMIN_PANEL_HOST ?? "127.0.0.1";
const gatewayOrigin = process.env.ADMIN_PANEL_GATEWAY_ORIGIN ?? "http://127.0.0.1:3000";
const staticRoot = __dirname;

const allowedProxyPaths = new Set([
  "/health",
  "/v1/admin/clusters",
  "/v1/admin/overview",
  "/v1/admin/workflow",
  "/v1/devops/collector/status",
  "/v1/hardware/physical-host",
  "/v1/hardware/telemetry/history",
  "/v1/hardware/telemetry/latest",
  "/v1/openclaw/learning-plan",
  "/v1/openclaw/live-canvas",
  "/v1/openclaw/onboarding/state",
  "/v1/openclaw/provisioning/state",
  "/v1/openclaw/readiness-signals",
  "/v1/operating-north",
  "/v1/kill-switch"
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

    if (requestUrl.pathname === "/health" || requestUrl.pathname.startsWith("/v1/")) {
      return proxyGatewayGet(request, response, requestUrl);
    }

    return serveStatic(response, requestUrl.pathname);
  } catch (error) {
    return json(response, 500, {
      error: "admin_panel_server_error",
      message: error instanceof Error ? error.message : "Unexpected admin panel server error."
    });
  }
});

server.listen(port, host, () => {
  console.log(`admin-panel listening on http://${host}:${port}`);
  console.log(`admin-panel proxying GET requests to ${gatewayOrigin}`);
});

async function proxyGatewayGet(request, response, requestUrl) {
  if (request.method !== "GET") {
    return json(response, 405, {
      error: "method_not_allowed",
      message: "Admin panel proxy is GET-only."
    });
  }

  if (!allowedProxyPaths.has(requestUrl.pathname)) {
    return json(response, 404, {
      error: "unknown_read_endpoint",
      message: "Endpoint is not exposed to the read-only admin panel."
    });
  }

  const upstreamUrl = new URL(requestUrl.pathname, gatewayOrigin);
  const upstreamResponse = await fetch(upstreamUrl, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  const body = await upstreamResponse.text();
  response.writeHead(upstreamResponse.status, {
    "content-type": upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

async function serveStatic(response, pathname) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = path.resolve(staticRoot, `.${normalizedPath}`);

  if (!absolutePath.startsWith(staticRoot)) {
    return json(response, 403, {
      error: "forbidden_path"
    });
  }

  try {
    const fileStat = await stat(absolutePath);

    if (!fileStat.isFile()) {
      return notFound(response);
    }
  } catch {
    return notFound(response);
  }

  response.writeHead(200, {
    "content-type": contentTypeFor(absolutePath),
    "cache-control": "no-store"
  });
  createReadStream(absolutePath).pipe(response);
}

function notFound(response) {
  return json(response, 404, {
    error: "not_found"
  });
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return "application/octet-stream";
}
