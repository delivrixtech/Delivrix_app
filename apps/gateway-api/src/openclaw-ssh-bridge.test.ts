import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenClawSshBridge,
  type OpenClawSshCommandRunner
} from "./openclaw-ssh-bridge.ts";
import type { ChatStreamEvent } from "./openclaw-chat.ts";

test("OpenClawSshBridge sendMessage parses status=started ACK from CLI", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: OpenClawSshCommandRunner = async (file, args) => {
    calls.push({ file, args });
    return {
      stdout: JSON.stringify({ runId: "run-1", status: "started" }),
      stderr: "",
      exitCode: 0
    };
  };
  const bridge = new OpenClawSshBridge({
    sshHost: "2.24.223.240",
    sshUser: "root",
    sshKeyPath: "~/.ssh/openclaw-hostinger",
    containerId: "openclaw-dtsf-openclaw-1",
    commandRunner: runner
  });

  const result = await bridge.sendMessage({
    msgId: "msg-1",
    message: "hola"
  });

  assert.deepEqual(result, { msgId: "msg-1", queued: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "ssh");
  const remoteCommand = calls[0].args.at(-1) ?? "";
  assert.ok(remoteCommand.includes("'docker'"));
  assert.ok(remoteCommand.includes("'exec'"));
  assert.ok(remoteCommand.includes("'chat.send'"));

  const params = JSON.parse(remoteCommand.match(/'--params' '([^']+)'$/)?.[1] ?? "{}");
  assert.equal(params.sessionKey, "agent:main:operator");
  assert.equal(params.idempotencyKey, "msg-1");
  assert.equal(params.message, "hola");
  assert.equal("msgId" in params, false);
  assert.equal("text" in params, false);
});

test("OpenClawSshBridge streamHistory emits typing, delta, and assistant done", async () => {
  let historyPolls = 0;
  const runner: OpenClawSshCommandRunner = async (_file, args) => {
    assert.ok((args.at(-1) ?? "").includes("'chat.history'"));
    historyPolls += 1;
    return {
      stdout: JSON.stringify(historyPolls === 1
        ? { messages: [] }
        : {
            messages: [{
              role: "assistant",
              msgId: "msg-2",
              content: [{ type: "text", text: "respuesta final" }],
              skillsInvoked: ["delivrix-fleet-ops"],
              audit: { tokensUsed: 12, duration_ms: 345 }
            }]
          }),
      stderr: "",
      exitCode: 0
    };
  };
  const bridge = new OpenClawSshBridge({
    sshHost: "2.24.223.240",
    commandRunner: runner,
    sleep: async () => undefined,
    now: () => new Date("2026-05-24T18:00:00.000Z")
  });
  const events: ChatStreamEvent[] = [];

  await bridge.streamHistory("msg-2", {
    timeoutMs: 50,
    pollIntervalMs: 1,
    onTyping: (event) => events.push(event),
    onDelta: (event) => events.push(event),
    onDone: (event) => events.push(event)
  });

  assert.deepEqual(events.map((event) => event.type), [
    "ASSISTANT_TYPING",
    "ASSISTANT_DELTA",
    "ASSISTANT_DONE"
  ]);
  assert.deepEqual(events[0], {
    type: "ASSISTANT_TYPING",
    msgId: "msg-2",
    ts: "2026-05-24T18:00:00.000Z"
  });
  assert.deepEqual(events[1], {
    type: "ASSISTANT_DELTA",
    msgId: "msg-2",
    delta: "respuesta final"
  });
  assert.deepEqual(events[2], {
    type: "ASSISTANT_DONE",
    msgId: "msg-2",
    content: "respuesta final",
    audit: {
      skillsInvoked: ["delivrix-fleet-ops"],
      tokensUsed: 12,
      durationMs: 345
    }
  });
});
