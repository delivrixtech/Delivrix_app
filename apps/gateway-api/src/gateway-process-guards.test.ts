import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installGatewayProcessGuards } from "./gateway-process-guards.ts";

test("installGatewayProcessGuards logs uncaught exceptions and unhandled rejections", () => {
  const target = new EventEmitter();
  const events: Array<{ event: string; message: string; metadata?: Record<string, unknown> }> = [];
  const shutdowns: string[] = [];
  const uninstall = installGatewayProcessGuards({
    async error(event, message, metadata) {
      events.push({ event, message, metadata });
    }
  }, target as never, {
    shutdown(reason) {
      shutdowns.push(reason);
    }
  });

  target.emit("uncaughtException", new Error("boom"));
  target.emit("unhandledRejection", new Error("rejected"));
  uninstall();

  assert.deepEqual(events.map((entry) => entry.event), [
    "gateway.uncaught_exception",
    "gateway.unhandled_rejection"
  ]);
  assert.equal(events[0].metadata?.message, "boom");
  assert.equal(events[1].metadata?.message, "rejected");
  assert.deepEqual(shutdowns, ["uncaughtException", "unhandledRejection"]);
});
