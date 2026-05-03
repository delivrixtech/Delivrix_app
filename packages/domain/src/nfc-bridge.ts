import { createId } from "./ids.ts";
import type { SenderNode, SenderNodeStatus } from "./types.ts";

export type NfcBridgeMode = "mock";
export type NfcBridgeReadinessStatus = "payload_ready" | "needs_review" | "blocked";

export interface NfcBridgeCapacityPlanInput {
  senderNodes: SenderNode[];
  actorId?: string;
  providerNamePrefix?: string;
  emailFromName?: string;
  emailsPerMinute?: number;
}

export interface NfcBridgeReadiness {
  senderNodeId: string;
  status: NfcBridgeReadinessStatus;
  reasons: string[];
}

export interface NfcEmailProviderPayload {
  name: string;
  providerType: "smtp";
  emailFromAddress: string;
  emailFromName: string;
  dailyLimit: number;
  emailsPerMinute: number;
  isActive: false;
  bounceRateCheckEnabled: true;
  allowedDomainGroups: string[];
  poolConfig: Record<string, string>;
}

export interface NfcSmtpServerPayload {
  name: string;
  ip: string;
  domain: string;
  sshHost: string;
  sshPort: 22;
  sshUser: "pending-secret-managed-user";
  smtpUser: "pending-secret-managed-smtp-user";
  isActive: false;
  providerIdHint: string;
}

export interface NfcBridgePlanItem {
  senderNodeId: string;
  readiness: NfcBridgeReadiness;
  providerPayload?: NfcEmailProviderPayload;
  smtpServerPayload?: NfcSmtpServerPayload;
}

export interface NfcBridgeCapacityPlan {
  id: string;
  createdAt: string;
  mode: NfcBridgeMode;
  dryRun: true;
  sideEffects: "none";
  actorId: string;
  items: NfcBridgePlanItem[];
  summary: {
    totalSenderNodes: number;
    payloadReady: number;
    needsReview: number;
    blocked: number;
    providersToCreate: number;
    smtpServersToCreate: number;
  };
  blockedOperations: string[];
  requiredApprovals: string[];
  warnings: string[];
}

const blockedOperations = [
  "nfc-provider-create-live",
  "nfc-smtp-server-create-live",
  "nfc-database-write",
  "activate-provider",
  "send-email",
  "ssh-connect",
  "store-secret"
];

const requiredApprovals = [
  "nfc_contract_review",
  "operator_approval_before_nfc_write",
  "secret_management_review",
  "reputation_gate_review",
  "provider_activation_review"
];

export function buildNfcBridgeCapacityPlan(
  input: NfcBridgeCapacityPlanInput,
  now = new Date()
): NfcBridgeCapacityPlan {
  const actorId = input.actorId?.trim() || "operator_local";
  const items = input.senderNodes.map((senderNode) =>
    buildNfcBridgePlanItem(senderNode, input)
  );
  const payloadReady = items.filter((item) => item.readiness.status === "payload_ready").length;
  const needsReview = items.filter((item) => item.readiness.status === "needs_review").length;
  const blocked = items.filter((item) => item.readiness.status === "blocked").length;

  return {
    id: createId("nfcbridge"),
    createdAt: now.toISOString(),
    mode: "mock",
    dryRun: true,
    sideEffects: "none",
    actorId,
    items,
    summary: {
      totalSenderNodes: input.senderNodes.length,
      payloadReady,
      needsReview,
      blocked,
      providersToCreate: items.filter((item) => item.providerPayload).length,
      smtpServersToCreate: items.filter((item) => item.smtpServerPayload).length
    },
    blockedOperations,
    requiredApprovals,
    warnings: buildPlanWarnings(input.senderNodes, items)
  };
}

export function evaluateNfcBridgeReadiness(senderNode: SenderNode): NfcBridgeReadiness {
  const reasons: string[] = [];

  if (!senderNode.ipAddress) {
    reasons.push("missing_ip_address");
  }

  if (!senderNode.hostname) {
    reasons.push("missing_hostname");
  }

  if (isBlockedStatus(senderNode.status)) {
    reasons.push(`sender_node_status_${senderNode.status}`);
  }

  if (senderNode.dailyLimit <= 0) {
    reasons.push("daily_limit_must_be_positive");
  }

  if (reasons.length > 0) {
    return {
      senderNodeId: senderNode.id,
      status: "blocked",
      reasons
    };
  }

  if (senderNode.status === "paused" || senderNode.status === "degraded") {
    return {
      senderNodeId: senderNode.id,
      status: "needs_review",
      reasons: [`sender_node_status_${senderNode.status}`]
    };
  }

  return {
    senderNodeId: senderNode.id,
    status: "payload_ready",
    reasons: ["mock_payload_only_not_active_in_nfc"]
  };
}

function buildNfcBridgePlanItem(
  senderNode: SenderNode,
  input: NfcBridgeCapacityPlanInput
): NfcBridgePlanItem {
  const readiness = evaluateNfcBridgeReadiness(senderNode);

  if (!senderNode.ipAddress || !senderNode.hostname || readiness.status === "blocked") {
    return {
      senderNodeId: senderNode.id,
      readiness
    };
  }

  const domain = domainFromHostname(senderNode.hostname);
  const providerIdHint = `delivrix:${senderNode.id}`;

  return {
    senderNodeId: senderNode.id,
    readiness,
    providerPayload: {
      name: `${input.providerNamePrefix?.trim() || "Delivrix"} ${senderNode.label}`.trim(),
      providerType: "smtp",
      emailFromAddress: `mailops@${domain}`,
      emailFromName: input.emailFromName?.trim() || "Delivrix Capacity",
      dailyLimit: senderNode.dailyLimit,
      emailsPerMinute: normalizeEmailsPerMinute(input.emailsPerMinute),
      isActive: false,
      bounceRateCheckEnabled: true,
      allowedDomainGroups: [],
      poolConfig: {
        delivrixSenderNodeId: senderNode.id,
        delivrixStatus: senderNode.status,
        delivrixProvider: senderNode.provider,
        hostname: senderNode.hostname,
        ipAddress: senderNode.ipAddress,
        warmupDay: String(senderNode.warmupDay),
        dryRun: "true",
        source: "delivrix-nfc-bridge-mock"
      }
    },
    smtpServerPayload: {
      name: senderNode.label,
      ip: senderNode.ipAddress,
      domain,
      sshHost: senderNode.hostname,
      sshPort: 22,
      sshUser: "pending-secret-managed-user",
      smtpUser: "pending-secret-managed-smtp-user",
      isActive: false,
      providerIdHint
    }
  };
}

function normalizeEmailsPerMinute(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 1) {
    return 1;
  }

  return Math.floor(value);
}

function isBlockedStatus(status: SenderNodeStatus): boolean {
  return status === "quarantined" || status === "retired" || status === "retired_pending_approval";
}

function domainFromHostname(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);

  if (parts.length <= 2) {
    return hostname;
  }

  return parts.slice(1).join(".");
}

function buildPlanWarnings(senderNodes: SenderNode[], items: NfcBridgePlanItem[]): string[] {
  const warnings: string[] = [];

  if (senderNodes.length === 0) {
    warnings.push("no_sender_nodes_selected");
  }

  if (items.some((item) => item.readiness.status === "blocked")) {
    warnings.push("some_sender_nodes_blocked_from_nfc_payload");
  }

  if (items.some((item) => item.readiness.status === "needs_review")) {
    warnings.push("some_sender_nodes_require_human_review");
  }

  warnings.push("mock_plan_only_no_nfc_write");
  warnings.push("providers_are_inactive_until_supervised_activation");

  return warnings;
}
