import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePostfixDeliveryLog,
  summarizeDeliveryResults,
  type PostfixDeliveryResult
} from "./postfix-log-parser.ts";

function byQueue(results: PostfixDeliveryResult[], queueId: string): PostfixDeliveryResult | undefined {
  return results.find((result) => result.queueId === queueId);
}

test("parses a successful delivery and links the message-id", () => {
  const log = [
    "Jun 28 10:15:02 smtp postfix/cleanup[1234]: A1B2C3D4E5: message-id=<delivrix-abc123@bizreport-control.com>",
    "Jun 28 10:15:03 smtp postfix/smtp[1240]: A1B2C3D4E5: to=<dest@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=1.2, status=sent (250 2.0.0 OK 167 - gsmtp)"
  ].join("\n");

  const result = byQueue(parsePostfixDeliveryLog(log), "A1B2C3D4E5");
  assert.ok(result);
  assert.equal(result.status, "sent");
  assert.equal(result.messageId, "delivrix-abc123@bizreport-control.com");
  assert.equal(result.recipient, "dest@gmail.com");
  assert.equal(result.dsnCode, "2.0.0");
  assert.equal(result.smtpCode, "250");
});

test("parses a hard bounce with the SMTP reply and DSN code (not the relay IP)", () => {
  const log =
    "Jun 28 10:16:10 smtp postfix/smtp[1310]: B2C3D4E5F6: to=<x@example.com>, " +
    "relay=mx.example.com[1.2.3.4]:25, delay=2.1, status=bounced " +
    "(host mx.example.com[1.2.3.4] said: 550 5.7.1 Service unavailable; client blocked (in reply to RCPT TO command))";

  const result = byQueue(parsePostfixDeliveryLog(log), "B2C3D4E5F6");
  assert.ok(result);
  assert.equal(result.status, "bounced");
  assert.equal(result.smtpCode, "550");
  assert.equal(result.dsnCode, "5.7.1"); // not "1.2.3" from the relay IP
  assert.match(result.reason ?? "", /Service unavailable/);
});

test("parses a deferred delivery (outbound port 25 timeout)", () => {
  const log =
    "Jun 28 10:17:00 smtp postfix/smtp[1320]: C3D4E5F6A7: to=<y@gmail.com>, relay=none, delay=30, " +
    "status=deferred (connect to gmail-smtp-in.l.google.com[142.250.1.27]:25: Connection timed out)";

  const result = byQueue(parsePostfixDeliveryLog(log), "C3D4E5F6A7");
  assert.ok(result);
  assert.equal(result.status, "deferred");
  assert.match(result.reason ?? "", /Connection timed out/);
});

test("keeps the most final status when a message is retried (deferred then sent)", () => {
  const log = [
    "Jun 28 10:00:00 smtp postfix/smtp[1]: D4E5F6A7B8: to=<z@gmail.com>, relay=none, status=deferred (connect timed out)",
    "Jun 28 10:30:00 smtp postfix/smtp[2]: D4E5F6A7B8: to=<z@gmail.com>, relay=gmail-smtp-in.l.google.com[1.1.1.1]:25, status=sent (250 2.0.0 OK)"
  ].join("\n");

  const result = byQueue(parsePostfixDeliveryLog(log), "D4E5F6A7B8");
  assert.ok(result);
  assert.equal(result.status, "sent");
});

test("ignores non-delivery log noise", () => {
  const log = [
    "Jun 28 10:00:00 smtp systemd[1]: Started Postfix Mail Transport Agent.",
    "Jun 28 10:00:01 smtp postfix/master[900]: daemon started -- version 3.6.4",
    ""
  ].join("\n");

  assert.deepEqual(parsePostfixDeliveryLog(log), []);
});

test("summarizeDeliveryResults counts by final status", () => {
  const log = [
    "Jun 28 10:15:03 smtp postfix/smtp[1]: AA11BB22CC: to=<a@x.com>, status=sent (250 2.0.0 OK)",
    "Jun 28 10:16:10 smtp postfix/smtp[2]: BB22CC33DD: to=<b@x.com>, status=bounced (host said: 550 5.7.1 blocked)",
    "Jun 28 10:17:00 smtp postfix/smtp[3]: CC33DD44EE: to=<c@x.com>, status=deferred (connect timed out)"
  ].join("\n");

  const counts = summarizeDeliveryResults(parsePostfixDeliveryLog(log));
  assert.equal(counts.sent, 1);
  assert.equal(counts.bounced, 1);
  assert.equal(counts.deferred, 1);
  assert.equal(counts.unknown, 0);
});
