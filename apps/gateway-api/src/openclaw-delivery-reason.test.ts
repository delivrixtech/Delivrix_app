import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDeliveryReason,
  describeDeliveryFromLog,
  selectDeliveryResult,
  type DeliveryLogRunner
} from "./openclaw-delivery-reason.ts";
import { parsePostfixDeliveryLog } from "./postfix-log-parser.ts";

const CLEANUP_LINE =
  "Jun 28 10:16:00 smtp postfix/cleanup[10]: B2C3D4E5F6: message-id=<delivrix-deadbeef@bizreport.com>";
const STATUS_BOUNCE_LINE =
  "Jun 28 10:16:10 smtp postfix/smtp[11]: B2C3D4E5F6: to=<x@gmail.com>, " +
  "relay=mx.gmail.com[1.2.3.4]:25, delay=2.1, status=bounced " +
  "(host mx.gmail.com[1.2.3.4] said: 550 5.7.1 Service unavailable; client blocked (in reply to RCPT TO command))";
// What a queue-id grep returns: both the cleanup line and the status line.
const QUEUE_LOG = [CLEANUP_LINE, STATUS_BOUNCE_LINE].join("\n");

test("describeDeliveryFromLog returns the bounce reason, codes, and a summary", () => {
  const reason = describeDeliveryFromLog(QUEUE_LOG, "<delivrix-deadbeef@bizreport.com>");
  assert.ok(reason);
  assert.equal(reason.finalStatus, "bounced");
  assert.equal(reason.smtpCode, "550");
  assert.equal(reason.dsnCode, "5.7.1");
  assert.equal(reason.recipient, "x@gmail.com");
  assert.match(reason.summary, /^bounced/);
  assert.match(reason.summary, /550 5\.7\.1/);
  assert.match(reason.summary, /Service unavailable/);
});

test("describeDeliveryFromLog matches the right message when several are present", () => {
  const log = [
    "Jun 28 10:00:00 smtp postfix/cleanup[1]: AAAA1111BBBB: message-id=<other@x.com>",
    "Jun 28 10:00:01 smtp postfix/smtp[1]: AAAA1111BBBB: to=<a@x.com>, status=sent (250 2.0.0 OK)",
    QUEUE_LOG
  ].join("\n");
  const reason = describeDeliveryFromLog(log, "<delivrix-deadbeef@bizreport.com>");
  assert.ok(reason);
  assert.equal(reason.finalStatus, "bounced");
  assert.equal(reason.dsnCode, "5.7.1");
});

test("describeDeliveryFromLog returns undefined for empty or irrelevant logs", () => {
  assert.equal(describeDeliveryFromLog("", "<x@y>"), undefined);
  assert.equal(describeDeliveryFromLog("   ", null), undefined);
  assert.equal(describeDeliveryFromLog("Jun 28 systemd[1]: Started Postfix.", null), undefined);
});

test("selectDeliveryResult prefers the most informative status without a message-id", () => {
  const log = [
    "Jun 28 10:00:00 smtp postfix/smtp[1]: AAAA1111CCCC: to=<a@x.com>, status=deferred (connect timed out)",
    "Jun 28 10:00:01 smtp postfix/smtp[2]: BBBB2222DDDD: to=<b@x.com>, status=bounced (said: 550 5.1.1 unknown user)"
  ].join("\n");
  const picked = selectDeliveryResult(parsePostfixDeliveryLog(log));
  assert.ok(picked);
  assert.equal(picked.status, "bounced");
});

// --- collector (two-stage SSH) ---

function fakeRunner(
  byNeedle: Record<string, string>,
  calls: string[] = []
): DeliveryLogRunner {
  return {
    async run({ command }) {
      calls.push(command);
      for (const [needle, stdout] of Object.entries(byNeedle)) {
        if (command.includes(needle)) return { stdout, exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    }
  };
}

test("collectDeliveryReason resolves the queue id from the message-id, then reads the queue", async () => {
  const calls: string[] = [];
  const runner = fakeRunner(
    {
      "delivrix-deadbeef@bizreport.com": CLEANUP_LINE,
      B2C3D4E5F6: QUEUE_LOG
    },
    calls
  );

  const out = await collectDeliveryReason({
    sshRunner: runner,
    serverSlug: "smtp-1",
    serverIp: "1.1.1.1",
    messageId: "<delivrix-deadbeef@bizreport.com>"
  });

  assert.equal(out.ok, true);
  assert.equal(out.reason?.finalStatus, "bounced");
  assert.equal(out.reason?.dsnCode, "5.7.1");
  assert.equal(out.summaryCounts.bounced, 1);
  // Two stages: first grep by message-id, then by the resolved queue id.
  assert.equal(calls.length, 2);
  assert.match(calls[0], /delivrix-deadbeef/);
  assert.match(calls[1], /B2C3D4E5F6/);
});

test("collectDeliveryReason never throws when SSH fails", async () => {
  const runner: DeliveryLogRunner = {
    async run() {
      throw new Error("ssh handshake failed");
    }
  };
  const out = await collectDeliveryReason({
    sshRunner: runner,
    serverSlug: "smtp-1",
    serverIp: "1.1.1.1",
    messageId: "<x@y>"
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /delivery_log_unavailable/);
  assert.match(out.error ?? "", /ssh handshake failed/);
});

test("collectDeliveryReason refuses an unsafe log path without calling SSH", async () => {
  const calls: string[] = [];
  const runner = fakeRunner({}, calls);
  const out = await collectDeliveryReason({
    sshRunner: runner,
    serverSlug: "s",
    serverIp: "1.1.1.1",
    messageId: "<x@y>",
    logPath: "/var/log/mail.log; rm -rf /"
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "unsafe_log_path");
  assert.equal(calls.length, 0);
});
