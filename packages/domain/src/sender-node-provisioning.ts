import { createId } from "./ids.ts";
import type { RegisterSenderNodeInput } from "./sender-node-registry.ts";

export type SenderNodeProvisioningStepName =
  | "create_compute"
  | "assign_ip"
  | "configure_postfix"
  | "configure_opendkim"
  | "configure_tls"
  | "register_dns"
  | "start_warmup";

export type SenderNodeProvisioningStepStatus = "planned" | "completed" | "blocked";
export type SenderNodeProvisioningRunStatus = "simulated" | "blocked";
export type ProxmoxComputeType = "lxc" | "vm";

export interface ProvisionSenderNodeInput {
  id: string;
  label: string;
  provider: "proxmox";
  hostname?: string;
  ipAddress?: string;
  dailyLimit?: number;
  warmupDay?: number;
  computeType?: ProxmoxComputeType;
  cpuCores?: number;
  memoryMb?: number;
  diskGb?: number;
  template?: string;
  networkBridge?: string;
}

export interface SenderNodeProvisioningStep {
  name: SenderNodeProvisioningStepName;
  order: number;
  label: string;
  status: SenderNodeProvisioningStepStatus;
  requiresHumanApproval: boolean;
  sideEffects: "none" | "local-state-only" | "external-blocked";
  metadata: Record<string, unknown>;
}

export interface SenderNodeProvisioningPlan {
  id: string;
  createdAt: string;
  provider: "proxmox";
  dryRun: true;
  sideEffects: "none";
  targetSenderNode: RegisterSenderNodeInput;
  compute: {
    type: ProxmoxComputeType;
    cpuCores: number;
    memoryMb: number;
    diskGb: number;
    template: string;
    networkBridge: string;
  };
  gates: string[];
  blockedOperations: string[];
  steps: SenderNodeProvisioningStep[];
}

export interface SenderNodeProvisioningRun {
  id: string;
  planId: string;
  provider: "proxmox";
  senderNodeId: string;
  status: SenderNodeProvisioningRunStatus;
  dryRun: true;
  sideEffects: "local-state-only";
  createdAt: string;
  completedAt: string;
  registeredSenderNodeId?: string;
  steps: SenderNodeProvisioningStep[];
  summary: {
    completedSteps: number;
    blockedSteps: number;
    externalSideEffects: false;
    smtpEnabled: false;
  };
  plan: SenderNodeProvisioningPlan;
}

const stepLabels: Record<SenderNodeProvisioningStepName, string> = {
  create_compute: "Create Proxmox compute container or VM",
  assign_ip: "Assign sender IP address",
  configure_postfix: "Prepare Postfix configuration",
  configure_opendkim: "Prepare OpenDKIM configuration",
  configure_tls: "Prepare TLS configuration",
  register_dns: "Prepare DNS records",
  start_warmup: "Start controlled warmup"
};

const provisioningStepOrder: SenderNodeProvisioningStepName[] = [
  "create_compute",
  "assign_ip",
  "configure_postfix",
  "configure_opendkim",
  "configure_tls",
  "register_dns",
  "start_warmup"
];

export function buildSenderNodeProvisioningPlan(
  input: ProvisionSenderNodeInput,
  now = new Date()
): SenderNodeProvisioningPlan {
  const normalized = normalizeProvisioningInput(input);

  return {
    id: createId("provisioning_plan"),
    createdAt: now.toISOString(),
    provider: "proxmox",
    dryRun: true,
    sideEffects: "none",
    targetSenderNode: {
      id: normalized.id,
      label: normalized.label,
      provider: "proxmox",
      status: "warming",
      hostname: normalized.hostname,
      ipAddress: normalized.ipAddress,
      dailyLimit: normalized.dailyLimit,
      warmupDay: normalized.warmupDay
    },
    compute: {
      type: normalized.computeType,
      cpuCores: normalized.cpuCores,
      memoryMb: normalized.memoryMb,
      diskGb: normalized.diskGb,
      template: normalized.template,
      networkBridge: normalized.networkBridge
    },
    gates: [
      "proxmox_api_disabled_until_operator_approval",
      "ssh_disabled_until_secret_management_is_configured",
      "smtp_delivery_disabled_until_reputation_gate_passes",
      "dns_live_changes_disabled_until_domain_ownership_is_verified",
      "warming_required_before_any_volume_increase"
    ],
    blockedOperations: [
      "proxmox-api-create",
      "ssh-connect",
      "postfix-apply",
      "opendkim-key-generate-live",
      "tls-certificate-request-live",
      "dns-live-change",
      "smtp-send"
    ],
    steps: buildPlannedSteps(normalized)
  };
}

export function simulateSenderNodeProvisioningRun(
  plan: SenderNodeProvisioningPlan,
  now = new Date(),
  registeredSenderNodeId?: string
): SenderNodeProvisioningRun {
  const steps = plan.steps.map((step) => ({
    ...step,
    status: "completed" as const,
    sideEffects: "local-state-only" as const,
    metadata: {
      ...step.metadata,
      simulated: true
    }
  }));

  return {
    id: createId("provisioning_run"),
    planId: plan.id,
    provider: "proxmox",
    senderNodeId: plan.targetSenderNode.id,
    status: "simulated",
    dryRun: true,
    sideEffects: "local-state-only",
    createdAt: plan.createdAt,
    completedAt: now.toISOString(),
    registeredSenderNodeId,
    steps,
    summary: {
      completedSteps: steps.length,
      blockedSteps: 0,
      externalSideEffects: false,
      smtpEnabled: false
    },
    plan
  };
}

function buildPlannedSteps(input: RequiredProvisioningInput): SenderNodeProvisioningStep[] {
  return provisioningStepOrder.map((name, index) => ({
    name,
    order: index + 1,
    label: stepLabels[name],
    status: "planned",
    requiresHumanApproval: name !== "start_warmup",
    sideEffects: "none",
    metadata: metadataForStep(name, input)
  }));
}

function metadataForStep(
  name: SenderNodeProvisioningStepName,
  input: RequiredProvisioningInput
): Record<string, unknown> {
  if (name === "create_compute") {
    return {
      computeType: input.computeType,
      cpuCores: input.cpuCores,
      memoryMb: input.memoryMb,
      diskGb: input.diskGb,
      template: input.template,
      networkBridge: input.networkBridge
    };
  }

  if (name === "assign_ip") {
    return {
      ipAddress: input.ipAddress ?? "pending_ip_assignment",
      liveIpAllocation: false
    };
  }

  if (name === "start_warmup") {
    return {
      status: "warming",
      dailyLimit: input.dailyLimit,
      warmupDay: input.warmupDay
    };
  }

  return {
    targetHostname: input.hostname ?? "pending_hostname",
    liveChange: false
  };
}

interface RequiredProvisioningInput extends ProvisionSenderNodeInput {
  dailyLimit: number;
  warmupDay: number;
  computeType: ProxmoxComputeType;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  template: string;
  networkBridge: string;
}

function normalizeProvisioningInput(input: ProvisionSenderNodeInput): RequiredProvisioningInput {
  if (input.provider !== "proxmox") {
    throw new Error("Provisioning provider must be proxmox.");
  }

  const id = input.id.trim();
  const label = input.label.trim();

  if (!id) {
    throw new Error("Provisioning sender node id is required.");
  }

  if (!label) {
    throw new Error("Provisioning sender node label is required.");
  }

  const dailyLimit = input.dailyLimit ?? 10;
  const warmupDay = input.warmupDay ?? 0;
  const cpuCores = input.cpuCores ?? 2;
  const memoryMb = input.memoryMb ?? 2048;
  const diskGb = input.diskGb ?? 24;

  assertNonNegative("dailyLimit", dailyLimit);
  assertNonNegative("warmupDay", warmupDay);
  assertPositive("cpuCores", cpuCores);
  assertPositive("memoryMb", memoryMb);
  assertPositive("diskGb", diskGb);

  return {
    ...input,
    id,
    label,
    hostname: input.hostname?.trim() || undefined,
    ipAddress: input.ipAddress?.trim() || undefined,
    dailyLimit,
    warmupDay,
    computeType: input.computeType ?? "lxc",
    cpuCores,
    memoryMb,
    diskGb,
    template: input.template?.trim() || "debian-12-mailops-base",
    networkBridge: input.networkBridge?.trim() || "vmbr0"
  };
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Provisioning ${name} must be >= 0.`);
  }
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Provisioning ${name} must be > 0.`);
  }
}
