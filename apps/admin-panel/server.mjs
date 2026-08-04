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
const readBoundaryProxyToken =
  process.env.DELIVRIX_READ_BOUNDARY_TOKEN ??
  process.env.DELIVRIX_OPENCLAW_TOKEN ??
  process.env.OPENCLAW_GATEWAY_TOKEN ??
  "";
// Token del emisor OpenClaw. El browser NUNCA lo embebe: el proxy same-origin lo inyecta desde el
// entorno al proxear los WRITES de canvas artifact (approve/reject/block), que el gateway autentica
// fail-closed con este mismo token. Sin él, una aprobación forjada quedaría bloqueada con 401.
const openClawGatewayProxyToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const allowedWritePatterns = [
  /^\/v1\/openclaw\/proposals\/[^/]+\/sign$/,
  /^\/v1\/openclaw\/proposals\/[^/]+\/reject$/,
  /^\/v1\/canvas\/artifact\/[^/]+\/approve$/,
  /^\/v1\/canvas\/artifact\/[^/]+\/reject$/,
  /^\/v1\/canvas\/artifact\/[^/]+\/block\/[^/]+$/,
  /^\/v1\/sender-pool\/quota\/[^/]+$/
];
// Subconjunto de allowedWritePatterns que el gateway autentica con el token del emisor OpenClaw.
// El proxy inyecta x-openclaw-gateway-token SOLO en estas rutas (las de proposals usan otro carril).
// La cuota diaria por bandeja (PATCH) usa este mismo carril: escritura fail-closed del operador.
const canvasArtifactWritePatterns = [
  /^\/v1\/canvas\/artifact\/[^/]+\/approve$/,
  /^\/v1\/canvas\/artifact\/[^/]+\/reject$/,
  /^\/v1\/canvas\/artifact\/[^/]+\/block\/[^/]+$/,
  /^\/v1\/sender-pool\/quota\/[^/]+$/
];
const allowedReadPatterns = [
  /^\/v1\/openclaw\/proposals\/[^/]+\/status$/,
  /^\/v1\/sender-pool\/credentials\/[^/]+\/download$/
];

const allowedProxyPaths = new Set([
  "/health",
  "/v1/admin/clusters",
  "/v1/admin/overview",
  "/v1/admin/workflow",
  "/v1/audit-events",
  canvasLiveStatePath,
  "/v1/openclaw/chat/conversations",
  "/v1/openclaw/chat/history",
  "/v1/compliance/status",
  "/v1/devops/collector/snapshot-ingestion",
  "/v1/devops/collector/status",
  "/v1/devops/collector/supervised-plan",
  "/v1/domains/availability",
  "/v1/domains/owned",
  "/v1/domains/prices",
  "/v1/domains/suggestions",
  "/v1/hardware/physical-host",
  "/v1/hardware/telemetry/history",
  "/v1/hardware/telemetry/latest",
  "/v1/iam/roles",
  "/v1/iam/sessions",
  "/v1/infrastructure/domain-discovery",
  "/v1/infrastructure/inventory",
  "/v1/ip-reputation/reports",
  "/v1/operational-summary",
  "/v1/openclaw/evidence",
  "/v1/openclaw/learning-plan",
  "/v1/openclaw/live-canvas",
  "/v1/openclaw/onboarding/state",
  "/v1/openclaw/proposals",
  "/v1/openclaw/provisioning/state",
  "/v1/openclaw/readiness-signals",
  "/v1/openclaw/skills/audit",
  "/v1/openclaw/workspace/file",
  "/v1/openclaw/workspace/tree",
  "/v1/operating-north",
  "/v1/kill-switch",
  "/v1/mxtoolbox/daily-report",
  "/v1/mxtoolbox/health",
  "/v1/send-results",
  "/v1/sender-nodes",
  "/v1/sender-pool/status",
  "/v1/sender-pool/inventory",
  "/v1/sender-pool/quota",
  "/v1/sender-pool/activity",
  "/v1/sender-pool/alerts",
  "/v1/sender-pool/cap",
  "/v1/warmup/conversation",
  "/v1/warmup/monitor",
  "/v1/warmup/seeds",
  "/v1/sender-pool/credentials/export",
  "/v1/sender-pool/credentials/download-all",
  "/v1/stuck-jobs",
  "/v1/warmup/activity",
  "/v1/warmup/pendientes",
  "/v1/warmup/plan",
  "/v1/warmup/ramp/by-domain",
  "/v1/warmup/status",
  "/v1/warmup/trends",
  "/v1/webdock/inventory"
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

    if (requestUrl.pathname === chatSendPath) {
      return await proxyGatewayChatSend(request, response, requestUrl);
    }

    if (allowedWritePatterns.some((pattern) => pattern.test(requestUrl.pathname))) {
      return await proxyGatewayWrite(request, response, requestUrl);
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
  if (
    requestUrl.pathname !== chatStreamPath &&
    requestUrl.pathname !== canvasLiveStreamPath &&
    requestUrl.pathname !== gatewayLogStreamPath
  ) {
    socket.destroy();
    return;
  }
  proxyGatewayWebSocket(request, socket, head, requestUrl);
});

// Solo escucha cuando se ejecuta directo (`node server.mjs`). Asi el test de paridad de
// allowlists puede importar este modulo sin levantar un servidor.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  server.listen(port, host, () => {
    console.log(`admin-panel listening on http://${host}:${port}`);
    console.log(`admin-panel proxying GET requests to ${gatewayOrigin}`);
    console.log(`admin-panel serving static files from ${staticRoot}`);
  });
}

// Exportado solo para el test de paridad contra READ_ENDPOINTS del read-boundary.
export { allowedProxyPaths, allowedReadPatterns };

async function proxyGatewayChatSend(request, response, requestUrl) {
  if (request.method !== "POST") {
    return json(response, 405, {
      error: "method_not_allowed",
      message: "Chat send requires POST."
    });
  }

  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, gatewayOrigin);
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
  const responseHeaders = {
    "content-type": upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
    "cache-control": "no-store"
  };
  const contentDisposition = upstreamResponse.headers.get("content-disposition");
  if (contentDisposition) {
    responseHeaders["content-disposition"] = contentDisposition;
  }
  response.writeHead(upstreamResponse.status, responseHeaders);
  response.end(body);
}

async function proxyGatewayGet(request, response, requestUrl) {
  if (request.method !== "GET") {
    return json(response, 405, {
      error: "method_not_allowed",
      message: "Admin panel proxy is GET-only."
    });
  }

  if (
    !allowedProxyPaths.has(requestUrl.pathname) &&
    !allowedReadPatterns.some((pattern) => pattern.test(requestUrl.pathname))
  ) {
    return json(response, 404, {
      error: "unknown_read_endpoint",
      message: "Endpoint is not exposed to the read-only admin panel."
    });
  }

  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, gatewayOrigin);
  const headers = {
    accept: "application/json"
  };
  const authorization = firstHeader(request.headers.authorization);
  const delivrixToken = firstHeader(request.headers["x-delivrix-token"]);
  if (authorization) {
    headers.authorization = authorization;
  }
  if (delivrixToken) {
    headers["x-delivrix-token"] = delivrixToken;
  } else if (readBoundaryProxyToken) {
    headers["x-delivrix-token"] = readBoundaryProxyToken;
  }
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "GET",
      headers
    });
  } catch (error) {
    return json(response, 502, {
      error: "gateway_unavailable",
      message: error instanceof Error ? error.message : "Gateway unavailable."
    });
  }

  // Bytes crudos, no texto: el borde de lectura ya sirve respuestas binarias (el ZIP de
  // download-all). Pasarlas por .text() las decodifica como UTF-8 y las re-encodea, y eso
  // corrompe todo lo que no sea texto. Buffer round-trippea el JSON igual.
  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  const responseHeaders = {
    "content-type": upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(body.length)
  };
  const contentDisposition = upstreamResponse.headers.get("content-disposition");
  if (contentDisposition) {
    responseHeaders["content-disposition"] = contentDisposition;
  }
  response.writeHead(upstreamResponse.status, responseHeaders);
  response.end(body);
}

async function proxyGatewayWrite(request, response, requestUrl) {
  if (request.method !== "POST" && request.method !== "PATCH") {
    return json(response, 405, {
      error: "method_not_allowed",
      message: "This gateway action requires POST or PATCH."
    });
  }

  const upstreamUrl = new URL(requestUrl.pathname, gatewayOrigin);
  const headers = {
    accept: "application/json",
    "content-type": firstHeader(request.headers["content-type"]) ?? "application/json",
    origin: `http://${host}:${port}`
  };
  // Canvas artifact writes: el gateway exige el token del emisor OpenClaw (fail-closed). Inyectamos
  // x-openclaw-gateway-token desde el entorno para que la mutación same-origin del operador quede
  // autenticada sin exponer el token al browser (mismo patrón que la inyección de x-delivrix-token).
  if (
    openClawGatewayProxyToken &&
    canvasArtifactWritePatterns.some((pattern) => pattern.test(requestUrl.pathname)) &&
    !firstHeader(request.headers["x-openclaw-gateway-token"])
  ) {
    headers["x-openclaw-gateway-token"] = openClawGatewayProxyToken;
  }
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
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

function proxyGatewayWebSocket(request, socket, head, requestUrl) {
  const upstreamOrigin = new URL(gatewayOrigin);
  const upstreamSocket = connect({
    host: upstreamOrigin.hostname,
    port: Number(upstreamOrigin.port || 80)
  });

  upstreamSocket.on("connect", () => {
    const upstreamPath = gatewayWebSocketPath(requestUrl);
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

function gatewayWebSocketPath(requestUrl) {
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, "http://127.0.0.1");
  if (upstreamUrl.pathname === canvasLiveStreamPath) {
    appendTokenIfMissing(upstreamUrl, canvasLiveProxyToken);
  }
  if (upstreamUrl.pathname === gatewayLogStreamPath) {
    appendTokenIfMissing(upstreamUrl, gatewayLogProxyToken);
  }
  return `${upstreamUrl.pathname}${upstreamUrl.search}`;
}

function appendTokenIfMissing(url, token) {
  if (token && !url.searchParams.has("token")) {
    url.searchParams.set("token", token);
  }
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
