// Parser for Postfix mail.log delivery lines -> structured per-message results.
//
// This is a pure function (no I/O): the collector feeds it the raw mail.log tail
// fetched over SSH, and it returns the final delivery outcome + DSN per queue id.
// It is the piece that turns "100% bounce, but why?" into a concrete reason
// (e.g. "550 5.7.1 blocked", "connect to …:25: Connection timed out") WITHOUT
// OpenClaw ever touching SSH.

export type PostfixDeliveryStatus =
  | "sent"
  | "bounced"
  | "deferred"
  | "expired"
  | "unknown";

export interface PostfixDeliveryResult {
  queueId: string;
  messageId?: string;
  recipient?: string;
  relay?: string;
  status: PostfixDeliveryStatus;
  /** SMTP enhanced status code, e.g. "5.7.1". */
  dsnCode?: string;
  /** Bare SMTP reply code, e.g. "550". */
  smtpCode?: string;
  /** The full parenthetical reason after `status=…`. */
  reason?: string;
}

// `postfix/<service>[pid]: <QUEUEID>: <rest>`  — queue id is 10-18 hex/base36 chars.
const QUEUE_LINE = /postfix\/[a-z]+\[\d+\]:\s+([0-9A-Fa-f]{8,20}|[0-9A-Za-z]{12,30}):\s+(.*)$/;
const STATUS_RE = /\bstatus=([a-z]+)\b/;
const TO_RE = /\bto=<([^>]*)>/;
const RELAY_RE = /\brelay=([^,]+)/;
const MESSAGE_ID_RE = /\bmessage-id=<?([^>\s,]+)>?/i;
// Reply code + enhanced status appear together in Postfix reasons ("550 5.7.1"),
// which avoids mistaking a relay IP octet (e.g. [1.2.3.4]) for a DSN code.
const SMTP_DSN_RE = /\b([245]\d\d)\s+([245]\.\d{1,3}\.\d{1,3})\b/;
const SMTP_SAID_RE = /(?:said:\s*|^\s*)([245]\d\d)\b/i;
const REASON_RE = /\bstatus=[a-z]+\s+\((.*)\)\s*$/;

const STATUS_RANK: Record<PostfixDeliveryStatus, number> = {
  unknown: 0,
  deferred: 1,
  expired: 2,
  bounced: 3,
  sent: 4
};

/**
 * Parse a Postfix mail.log tail into one result per queue id. When a queue id
 * has several status lines (deferred → later sent/bounced), the most final
 * status wins (sent/bounced/expired over deferred).
 */
export function parsePostfixDeliveryLog(log: string): PostfixDeliveryResult[] {
  const byQueue = new Map<string, PostfixDeliveryResult>();

  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = QUEUE_LINE.exec(line);
    if (!match) continue;
    const queueId = match[1];
    const rest = match[2];

    const current = byQueue.get(queueId) ?? { queueId, status: "unknown" as PostfixDeliveryStatus };

    const messageId = MESSAGE_ID_RE.exec(rest);
    if (messageId && !current.messageId) {
      current.messageId = messageId[1];
    }

    const statusMatch = STATUS_RE.exec(rest);
    if (statusMatch) {
      const status = normalizeStatus(statusMatch[1]);
      // Only overwrite if the new status is more "final" than what we have.
      if (STATUS_RANK[status] >= STATUS_RANK[current.status]) {
        current.status = status;
        const to = TO_RE.exec(rest);
        if (to) current.recipient = to[1];
        const relay = RELAY_RE.exec(rest);
        if (relay) current.relay = relay[1].trim();
        const reason = REASON_RE.exec(rest);
        if (reason) {
          current.reason = reason[1].trim();
          const both = SMTP_DSN_RE.exec(reason[1]);
          if (both) {
            current.smtpCode = both[1];
            current.dsnCode = both[2];
          } else {
            const said = SMTP_SAID_RE.exec(reason[1]);
            if (said) current.smtpCode = said[1];
          }
        }
      }
    }

    byQueue.set(queueId, current);
  }

  return [...byQueue.values()];
}

/** Roll a set of delivery results up into counts for a quick fleet view. */
export function summarizeDeliveryResults(results: PostfixDeliveryResult[]): Record<PostfixDeliveryStatus, number> {
  const counts: Record<PostfixDeliveryStatus, number> = {
    sent: 0,
    bounced: 0,
    deferred: 0,
    expired: 0,
    unknown: 0
  };
  for (const result of results) {
    counts[result.status] += 1;
  }
  return counts;
}

function normalizeStatus(value: string): PostfixDeliveryStatus {
  switch (value.toLowerCase()) {
    case "sent":
      return "sent";
    case "bounced":
      return "bounced";
    case "deferred":
      return "deferred";
    case "expired":
      return "expired";
    default:
      return "unknown";
  }
}
