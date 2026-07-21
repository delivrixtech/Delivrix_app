import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPlacement,
  runLiveCycle,
  type WarmupMailer,
  type GmailOps,
  type ActivityRecorder,
  type ActivityEvent,
  type FoundMessage
} from "./warmup-live-cycle.ts";
import type { WarmupConversation } from "./warmup-content-bank.ts";

const convo: WarmupConversation = { topic: "reunion", subject: "Asunto", body: "cuerpo natural", reply: "respuesta natural" };
const SECRET_PASS = "SUPER-SECRET-PASS";

function recorder(): { rec: ActivityRecorder; events: ActivityEvent[] } {
  const events: ActivityEvent[] = [];
  return { events, rec: { async record(e) { events.push(e); } } };
}

function fakeMailer(): WarmupMailer {
  return {
    async send() {
      // el mailer real usaría el pass; acá NO debe filtrarse a ningún evento
      return { messageId: "<abc@box>", response: "250 Ok" };
    }
  };
}

function fakeGmail(found: FoundMessage | null, sink?: { modified?: any; replied?: any }): GmailOps {
  return {
    async findMessage() { return found; },
    async modifyLabels(id, change) { if (sink) sink.modified = { id, change }; },
    async sendReply(input) { if (sink) sink.replied = input; return { id: "reply-123456789" }; }
  };
}

const noSleep = async (): Promise<void> => {};

test("classifyPlacement mapea labels a placement", () => {
  assert.equal(classifyPlacement(["INBOX"]), "INBOX");
  assert.equal(classifyPlacement(["SPAM", "INBOX"]), "SPAM");
  assert.equal(classifyPlacement(["CATEGORY_PROMOTIONS"]), "PROMOTIONS");
  assert.equal(classifyPlacement(["UNREAD"]), "OTHER");
});

test("vuelta completa (INBOX): registra sent→measured→engaged→replied", async () => {
  const { rec, events } = recorder();
  const sink: any = {};
  const res = await runLiveCycle({
    cycleId: "c1", testId: "t1", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t1]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "g1", threadId: "th1", labelIds: ["INBOX"] }, sink),
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.equal(res.completed, true);
  assert.equal(res.placement, "INBOX");
  assert.deepEqual(events.map((e) => e.kind), ["sent", "measured", "engaged", "replied"]);
  // engage en INBOX ⇒ sólo IMPORTANT (no toca SPAM)
  assert.deepEqual(sink.modified.change, { add: ["IMPORTANT"], remove: [] });
  assert.equal(sink.replied.body, "respuesta natural");
});

test("vuelta con spam: engage mueve a Principal (not-spam + important)", async () => {
  const { rec, events } = recorder();
  const sink: any = {};
  const res = await runLiveCycle({
    cycleId: "c2", testId: "t2", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t2]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "g2", threadId: "th2", labelIds: ["SPAM"] }, sink),
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.equal(res.completed, true);
  const measured = events.find((e) => e.kind === "measured");
  assert.equal(measured?.placement, "SPAM");
  const engaged = events.find((e) => e.kind === "engaged");
  assert.equal(engaged?.placement, "INBOX");
  assert.deepEqual(sink.modified.change, { add: ["INBOX", "IMPORTANT"], remove: ["SPAM", "CATEGORY_PROMOTIONS"] });
});

test("no aparece en la ventana ⇒ error 'measured', corta la vuelta", async () => {
  const { rec, events } = recorder();
  const res = await runLiveCycle({
    cycleId: "c3", testId: "t3", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t3]",
    mailer: fakeMailer(), gmail: fakeGmail(null),
    recorder: rec, sleep: noSleep, pollAttempts: 3, pollDelayMs: 0
  });
  assert.equal(res.completed, false);
  assert.equal(res.brokeAt, "measured");
  assert.deepEqual(events.map((e) => e.kind), ["sent", "error"]);
});

test("falla el envío ⇒ error 'sent', no sigue", async () => {
  const { rec, events } = recorder();
  const res = await runLiveCycle({
    cycleId: "c4", testId: "t4", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t4]",
    mailer: { async send() { throw new Error("smtp_down"); } },
    gmail: fakeGmail({ gmailId: "x", threadId: "y", labelIds: ["INBOX"] }),
    recorder: rec, sleep: noSleep
  });
  assert.equal(res.brokeAt, "sent");
  assert.deepEqual(events.map((e) => e.kind), ["error"]);
});

test("ningún evento persistido filtra el password del box", async () => {
  const { rec, events } = recorder();
  await runLiveCycle({
    cycleId: "c5", testId: "t5", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t5]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "g5", threadId: "th5", labelIds: ["INBOX"] }),
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(SECRET_PASS), "el password nunca aparece en la actividad");
});
