import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { noopGatewayRuntimeLogger, runtimeErrorMetadata, type GatewayRuntimeLogger } from "./gateway-runtime-log.ts";

interface PanelSocketAcceptor {
  acceptPanelSocket(request: IncomingMessage, socket: Socket, head?: Buffer): void;
}

export interface GatewayUpgradeRouterDeps {
  openClawChatProxy: PanelSocketAcceptor;
  canvasLiveEvents: PanelSocketAcceptor;
  gatewayLogStream: PanelSocketAcceptor;
  logger?: Pick<GatewayRuntimeLogger, "error">;
}

export function routeGatewayWebSocketUpgrade(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  deps: GatewayUpgradeRouterDeps
): void {
  try {
    const url = requestUrl(request);
    if (request.method === "GET" && url.pathname === "/v1/openclaw/chat/stream") {
      deps.openClawChatProxy.acceptPanelSocket(request, socket, head);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/canvas/live/stream") {
      deps.canvasLiveEvents.acceptPanelSocket(request, socket, head);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/gateway/logs/stream") {
      deps.gatewayLogStream.acceptPanelSocket(request, socket, head);
      return;
    }
  } catch (error) {
    void (deps.logger ?? noopGatewayRuntimeLogger).error(
      "gateway.upgrade_failed",
      "WebSocket upgrade failed before a route accepted the socket.",
      runtimeErrorMetadata(error)
    );
  }

  socket.destroy();
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
}
