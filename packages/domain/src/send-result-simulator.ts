import type { SendJob, SendResultStatus } from "./types.ts";

export interface SimulatedSendResult {
  status: SendResultStatus;
  smtpResponse?: string;
  bounceCode?: string;
  complaintSource?: string;
  metadata: Record<string, unknown>;
}

export function simulateSendResult(job: SendJob): SimulatedSendResult {
  const forced = forcedResultStatus(job);

  if (forced) {
    return resultForStatus(forced, "forced-by-metadata");
  }

  const recipient = job.request.recipient.email.toLowerCase();

  if (recipient.includes("bounce")) {
    return resultForStatus("bounce", "recipient-pattern");
  }

  if (recipient.includes("complaint")) {
    return resultForStatus("complaint", "recipient-pattern");
  }

  if (recipient.includes("defer")) {
    return resultForStatus("deferred", "recipient-pattern");
  }

  if (recipient.includes("fail")) {
    return resultForStatus("failed", "recipient-pattern");
  }

  return resultForStatus("sent", "default");
}

function forcedResultStatus(job: SendJob): SendResultStatus | null {
  const value = job.request.metadata?.simulatedResult;

  if (
    value === "sent"
    || value === "bounce"
    || value === "complaint"
    || value === "deferred"
    || value === "failed"
  ) {
    return value;
  }

  return null;
}

function resultForStatus(status: SendResultStatus, reason: string): SimulatedSendResult {
  switch (status) {
    case "sent":
      return {
        status,
        smtpResponse: "250 2.0.0 queued as dry-run",
        metadata: { simulated: true, reason }
      };
    case "bounce":
      return {
        status,
        smtpResponse: "550 5.1.1 user unknown",
        bounceCode: "5.1.1",
        metadata: { simulated: true, reason }
      };
    case "complaint":
      return {
        status,
        complaintSource: "simulated-feedback-loop",
        metadata: { simulated: true, reason }
      };
    case "deferred":
      return {
        status,
        smtpResponse: "451 4.7.0 temporary rate limited",
        metadata: { simulated: true, reason }
      };
    case "failed":
      return {
        status,
        smtpResponse: "554 5.0.0 transaction failed",
        metadata: { simulated: true, reason }
      };
  }
}
