import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenClawChatHistoryStore } from "./openclaw-chat-history-store.ts";

test("OpenClawChatHistoryStore appends, reloads, skips corrupt lines, and caps turns", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-chat-history-"));
  const store = new OpenClawChatHistoryStore({
    stateDir,
    maxTurnsPerConversation: 3,
    now: fixedNow()
  });

  await store.appendTurn("conv-a", { role: "user", content: "primer mensaje", msgId: "a-1" });
  await store.appendTurn("conv-a", { role: "assistant", content: "primera respuesta", msgId: "a-1" });
  await store.appendTurn("conv-a", { role: "user", content: "segundo mensaje", msgId: "a-2" });
  await store.appendTurn("conv-b", { role: "user", content: "mensaje b", msgId: "b-1", createdAt: "2026-06-19T12:00:00.000Z" });
  await appendFile(join(stateDir, "conv-a.jsonl"), "{corrupt-json}\n", "utf8");
  await store.appendTurn("conv-a", { role: "assistant", content: "segunda respuesta", msgId: "a-2" });

  const raw = await readFile(join(stateDir, "conv-a.jsonl"), "utf8");
  assert.match(raw, /primer mensaje/);
  assert.match(raw, /\{corrupt-json\}/);

  const reloaded = new OpenClawChatHistoryStore({ stateDir, maxTurnsPerConversation: 3 });
  const convA = await reloaded.history("conv-a");
  assert.deepEqual(convA.turns.map((turn) => turn.content), [
    "primera respuesta",
    "segundo mensaje",
    "segunda respuesta"
  ]);

  const summaries = await reloaded.listConversations();
  assert.deepEqual(summaries.map((summary) => summary.id), ["conv-b", "conv-a"]);
  assert.equal(summaries[0].title, "mensaje b");
  assert.equal(summaries[1].preview, "segunda respuesta");
});

test("OpenClawChatHistoryStore persists attachment metadata without raw image base64", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-chat-attachments-"));
  const store = new OpenClawChatHistoryStore({ stateDir });

  await store.appendTurn("conv-attachments", {
    role: "user",
    content: "revisa adjunto",
    msgId: "attach-1",
    attachments: [{
      kind: "image",
      name: "capture.png",
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      bytes: 8,
      sha256: "hash-image"
    }]
  });

  const raw = await readFile(join(stateDir, "conv-attachments.jsonl"), "utf8");
  assert.match(raw, /"sha256":"hash-image"/);
  assert.doesNotMatch(raw, /iVBORw0KGgo=/);

  const history = await store.history("conv-attachments");
  assert.deepEqual(history.turns[0].attachments, [{
    kind: "image",
    name: "capture.png",
    mimeType: "image/png",
    bytes: 8,
    sha256: "hash-image"
  }]);
});

function fixedNow(): () => Date {
  return () => new Date("2026-06-19T11:00:00.000Z");
}
