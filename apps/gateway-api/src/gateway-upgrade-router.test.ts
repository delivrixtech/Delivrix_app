import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import { routeGatewayWebSocketUpgrade } from "./gateway-upgrade-router.ts";

test("routeGatewayWebSocketUpgrade routes Canvas stream upgrades", () => {
  const calls: string[] = [];
  const socket = fakeSocket();

  routeGatewayWebSocketUpgrade(request("/v1/canvas/live/stream"), socket as Socket, Buffer.alloc(0), {
    openClawChatProxy: acceptor("chat", calls),
    canvasLiveEvents: acceptor("canvas", calls),
    gatewayLogStream: acceptor("logs", calls)
  });

  assert.deepEqual(calls, ["canvas"]);
  assert.equal(socket.destroyedByRouter, false);
});

test("routeGatewayWebSocketUpgrade destroys socket and logs when acceptor throws", () => {
  const events: string[] = [];
  const socket = fakeSocket();

  routeGatewayWebSocketUpgrade(request("/v1/canvas/live/stream"), socket as Socket, Buffer.alloc(0), {
    openClawChatProxy: acceptor("chat", []),
    canvasLiveEvents: {
      acceptPanelSocket() {
        throw new Error("bad upgrade");
      }
    },
    gatewayLogStream: acceptor("logs", []),
    logger: {
      async error(event) {
        events.push(event);
      }
    }
  });

  assert.equal(socket.destroyedByRouter, true);
  assert.deepEqual(events, ["gateway.upgrade_failed"]);
});

function acceptor(name: string, calls: string[]) {
  return {
    acceptPanelSocket() {
      calls.push(name);
    }
  };
}

function request(url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url,
    headers: { host: "127.0.0.1" }
  }) as IncomingMessage;
}

function fakeSocket(): Socket & { destroyedByRouter: boolean } {
  return {
    destroyedByRouter: false,
    destroy() {
      this.destroyedByRouter = true;
      return this;
    }
  } as Socket & { destroyedByRouter: boolean };
}
