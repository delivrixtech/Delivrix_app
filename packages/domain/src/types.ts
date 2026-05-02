export type MessageClassification = "commercial" | "transactional" | "operational";

export type SenderNodeStatus =
  | "active"
  | "warming"
  | "paused"
  | "quarantined"
  | "degraded"
  | "retired_pending_approval";

export type SendJobStatus = "queued" | "processing" | "completed" | "failed" | "blocked";
export type SendResultStatus = "sent" | "bounce" | "complaint" | "deferred" | "failed";

export interface Recipient {
  email: string;
  consentProofId?: string;
}

export interface SenderIdentity {
  address: string;
  domain: string;
  dkimDomain?: string;
}

export interface SendRequest {
  id?: string;
  campaignId: string;
  recipient: Recipient;
  sender: SenderIdentity;
  subject: string;
  bodyText: string;
  classification: MessageClassification;
  unsubscribeUrl?: string;
  physicalAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface SendJob {
  id: string;
  request: SendRequest;
  status: SendJobStatus;
  createdAt: string;
  processingStartedAt?: string;
  completedAt?: string;
  senderNodeId?: string;
  failureReason?: string;
  recoveredAt?: string;
  recoveryReason?: string;
}

export interface SendResult {
  id: string;
  sendJobId: string;
  senderNodeId?: string;
  status: SendResultStatus;
  smtpResponse?: string;
  bounceCode?: string;
  complaintSource?: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface SenderNode {
  id: string;
  label: string;
  provider: "webdock" | "proxmox" | "racknerd" | "manual";
  status: SenderNodeStatus;
  ipAddress?: string;
  hostname?: string;
  dailyLimit: number;
  warmupDay: number;
}
