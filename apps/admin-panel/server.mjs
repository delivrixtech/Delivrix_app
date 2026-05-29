import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ADMIN_PANEL_PORT ?? 5173);
const host = process.env.ADMIN_PANEL_HOST ?? "127.0.0.1";
const gatewayOrigin = process.env.ADMIN_PANEL_GATEWAY_ORIGIN ?? "http://127.0.0.1:3000";
const distRoot = path.join(__dirname, "dist");
const staticRoot = existsSync(path.join(distRoot, "index.html")) ? distRoot : __dirname;
const chatSendPath = "/v1/openclaw/chat/send";
const chatStreamPath = "/v1/openclaw/chat/stream";
const gatewayLogStreamPath = "/v1/gateway/logs/stream";

const allowedProxyPaths = new Set([
  "/health",
  "/v1/admin/clusters",
  "/v1/admin/overview",
  "/v1/admin/workflow",
  "/v1/audit-events",
  "/v1/compliance/status",
  "/v1/devops/collector/snapshot-ingestion",
  "/v1/devops/collector/status",
  "/v1/devops/collector/supervised-plan",
  "/v1/hardware/physical-host",
  "/v1/hardware/telemetry/history",
  "/v1/hardware/telemetry/latest",
  "/v1/iam/roles",
  "/v1/iam/sessions",
  "/v1/ip-reputation/reports",
  "/v1/operational-summary",
  "/v1/openclaw/evidence",
  "/v1/openclaw/learning-plan",
  "/v1/openclaw/live-canvas",
  "/v1/openclaw/onboarding/state",
  "/v1/openclaw/provisioning/state",
  "/v1/openclaw/readiness-signals",
  "/v1/openclaw/skills/audit",
  "/v1/operating-north",
  "/v1/kill-switch",
  "/v1/send-results",
  "/v1/sender-nodes",
  "/v1/stuck-jobs",
  "/v1/webdock/inventory"
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

    if (requestUrl.pathname === chatSendPath) {
      return await proxyGatewayChatSend(request, response, requestUrl);
    }

    if (requestUrl.pathname === "/health" || requestUrl.pathname.startsWith("/v1/")) {
      return await proxyGatewayGet(request, response, requestUrl);
    }

    return await serveStatic(response, requestUrl.pathname);
  } catch (error) {
    return json(response, 500, {
      error: "admin_panel_server_error",
      message: error instanceof Error ? error.message : "Unexpected admin panel server error."
    });
  }
});

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  if (requestUrl.pathname !== chatStreamPath && requestUrl.pathname !== gatewayLogStreamPath) {
    socket.destroy();
    return;
  }
  proxyGatewayWebSocket(request, socket, head, requestUrl);
});

server.listen(port, host, () => {
  console.log(`admin-panel listening on http://${host}:${port}`);
  console.log(`admin-panel proxying GET requests to ${gatewayOrigin}`);
  console.log(`admin-panel serving static files from ${staticRoot}`);
});

async function proxyGatewayChatSend(request, response, requestUrl) {
  if (request.method !== "POST") {
    return json(response, 405, {
      error: "method_not_allowed",
      message: "Chat send requires POST."
    });
  }

  const upstreamUrl = new URL(requestUrl.pathname, gatewayOrigin);
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": firstHeader(request.headers["content-type"]) ?? "application/json"
      },
      body: await readBody(request)
    });
  } catch (error) {
    return json(response, 502, {
      error: "gateway_unavailable",
      message: error instanceof Error ? error.message : "Gateway unavailable."
    });
  }

  const body = await upstreamResponse.text();
  response.writeHead(upstreamResponse.status, {
    "content-type": upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

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
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    });
  } catch (error) {
    return json(response, 502, {
      error: "gateway_unavailable",
      message: error instanceof Error ? error.message : "Gateway unavailable."
    });
  }

  const body = await upstreamResponse.text();
  response.writeHead(upstreamResponse.status, {
    "content-type": upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

function proxyGatewayWebSocket(request, socket, head, requestUrl) {
  const upstreamOrigin = new URL(gatewayOrigin);
  const upstreamSocket = connect({
    host: upstreamOrigin.hostname,
    port: Number(upstreamOrigin.port || 80)
  });

  upstreamSocket.on("connect", () => {
    const upstreamPath = `${requestUrl.pathname}${requestUrl.search}`;
    const handshake = [
      `GET ${upstreamPath} HTTP/1.1`,
      `Host: ${upstreamOrigin.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${request.headers["sec-websocket-key"] ?? ""}`,
      `Sec-WebSocket-Version: ${request.headers["sec-websocket-version"] ?? "13"}`,
      websocketProtocolHeader(request.headers["sec-websocket-protocol"])
    ].filter(Boolean).join("\r\n");
    upstreamSocket.write(`${handshake}\r\n\r\n`);

    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });

  upstreamSocket.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    upstreamSocket.destroy();
  });
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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function websocketProtocolHeader(value) {
  if (Array.isArray(value)) {
    return `Sec-WebSocket-Protocol: ${value.join(", ")}`;
  }
  return typeof value === "string" ? `Sec-WebSocket-Protocol: ${value}` : "";
}

function firstHeader(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : null;
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
