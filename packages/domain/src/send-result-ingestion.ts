import type { AuditRiskLevel } from "./audit-log.ts";
import type { SendJob, SendResultStatus, SenderNode } from "./types.ts";

export type IngestedSendResultStatus = Exclude<SendResultStatus, "sent">;

export interface IngestSendResultInput {
  sendJobId: string;
  senderNodeId?: string;
  status: SendResultStatus;
  smtpResponse?: string;
  bounceCode?: string;
  complaintSource?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestSendResultContext {
  job?: SendJob;
  senderNode?: SenderNode;
}

export interface IngestSendResultDecision {
  allowed: boolean;
  code:
    | "send_result_ingestion_allowed"
    | "send_result_ingestion_job_not_found"
    | "send_result_ingestion_sender_node_required"
    | "send_result_ingestion_sender_node_not_found"
    | "send_result_ingestion_sender_node_mismatch"
    | "send_result_ingestion_invalid_status";
  message: string;
  sendJobId: string;
  senderNodeId?: string;
  status: SendResultStatus;
  normalizedStatus?: IngestedSendResultStatus;
  riskLevel: AuditRiskLevel;
  suppression?: {
    email: string;
    reason: "complaint" | "hard_bounce";
    source: string;
  };
}

export function evaluateSendResultIngestion(
  input: IngestSendResultInput,
  context: IngestSendResultContext
): IngestSendResultDecision {
  if (!context.job) {
    return blocked(input, {
      code: "send_result_ingestion_job_not_found",
      message: `Send job not found: ${input.sendJobId}`,
      riskLevel: "medium"
    });
  }

  if (!isIngestedSendResultStatus(input.status)) {
    return blocked(input, {
      code: "send_result_ingestion_invalid_status",
      message: "Mock ingestion only accepts bounce, complaint, deferred, or failed statuses.",
      riskLevel: "medium",
      senderNodeId: input.senderNodeId ?? context.job.senderNodeId
    });
  }

  const senderNodeId = input.senderNodeId ?? context.job.senderNodeId;

  if (!senderNodeId) {
    return blocked(input, {
      code: "send_result_ingestion_sender_node_required",
      message: "senderNodeId is required when the send job has no assigned sender node.",
      riskLevel: "medium"
    });
  }

  if (context.job.senderNodeId && input.senderNodeId && input.senderNodeId !== context.job.senderNodeId) {
    return blocked(input, {
      code: "send_result_ingestion_sender_node_mismatch",
      message: "senderNodeId must match the sender node assigned to the send job.",
      riskLevel: "high",
      senderNodeId
    });
  }

  if (!context.senderNode) {
    return blocked(input, {
      code: "send_result_ingestion_sender_node_not_found",
      message: `Sender node not found: ${senderNodeId}`,
      riskLevel: "medium",
      senderNodeId
    });
  }

  return {
    allowed: true,
    code: "send_result_ingestion_allowed",
    message: `Mock ${input.status} result can be ingested.`,
    sendJobId: context.job.id,
    senderNodeId,
    status: input.status,
    normalizedStatus: input.status,
    riskLevel: riskLevelForStatus(input.status),
    suppression: suppressionFor(input, context.job)
  };
}

export function isIngestedSendResultStatus(value: unknown): value is IngestedSendResultStatus {
  return value === "bounce" || value === "complaint" || value === "deferred" || value === "failed";
}

function suppressionFor(
  input: IngestSendResultInput,
  job: SendJob
): IngestSendResultDecision["suppression"] {
  if (input.status === "complaint") {
    return {
      email: job.request.recipient.email,
      reason: "complaint",
      source: input.source?.trim() || input.complaintSource?.trim() || "mock-feedback-loop"
    };
  }

  if (input.status === "bounce" && isHardBounce(input.bounceCode, input.smtpResponse)) {
    return {
      email: job.request.recipient.email,
      reason: "hard_bounce",
      source: input.source?.trim() || "mock-bounce-ingestion"
    };
  }

  return undefined;
}

function isHardBounce(bounceCode: string | undefined, smtpResponse: string | undefined): boolean {
  const candidate = bounceCode?.trim() || smtpResponse?.trim();
  return candidate ? candidate.startsWith("5") : false;
}

function riskLevelForStatus(status: IngestedSendResultStatus): AuditRiskLevel {
  if (status === "complaint") {
    return "critical";
  }

  if (status === "bounce" || status === "failed") {
    return "high";
  }

  return "medium";
}

function blocked(
  input: IngestSendResultInput,
  block: {
    code: IngestSendResultDecision["code"];
    message: string;
    riskLevel: AuditRiskLevel;
    senderNodeId?: string;
  }
): IngestSendResultDecision {
  return {
    allowed: false,
    code: block.code,
    message: block.message,
    sendJobId: input.sendJobId,
    senderNodeId: block.senderNodeId,
    status: input.status,
    riskLevel: block.riskLevel
  };
}
