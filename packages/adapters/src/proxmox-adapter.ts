import type {
  ProvisionSenderNodeInput,
  RegisterSenderNodeInput,
  SenderNode,
  SenderNodeProvisioningPlan,
  SenderNodeProvisioningRun
} from "../../domain/src/index.ts";
import {
  buildSenderNodeProvisioningPlan,
  simulateSenderNodeProvisioningRun
} from "../../domain/src/index.ts";

export interface ProxmoxMockNodeConfig extends Omit<ProvisionSenderNodeInput, "provider"> {
  provider?: "proxmox";
}

export class ProxmoxAdapter {
  planProvisioning(config: ProxmoxMockNodeConfig): SenderNodeProvisioningPlan {
    return buildSenderNodeProvisioningPlan({
      ...config,
      provider: "proxmox"
    });
  }

  simulateProvisioning(
    plan: SenderNodeProvisioningPlan,
    registeredSenderNodeId?: string
  ): SenderNodeProvisioningRun {
    return simulateSenderNodeProvisioningRun(plan, new Date(), registeredSenderNodeId);
  }

  toSenderNodeInput(config: ProxmoxMockNodeConfig): RegisterSenderNodeInput {
    const plan = this.planProvisioning(config);
    return plan.targetSenderNode;
  }

  describeCapabilities(node?: SenderNode): Record<string, unknown> {
    return {
      nodeId: node?.id,
      provider: "proxmox",
      mode: "mock",
      dryRun: true,
      smtpEnabledByPlatform: false,
      sshEnabledByPlatform: false,
      proxmoxApiEnabled: false,
      sideEffects: "none",
      allowedOperations: [
        "plan-provisioning",
        "simulate-provisioning",
        "register-mock-node",
        "list",
        "select-for-dry-run"
      ],
      blockedOperations: [
        "proxmox-api-create",
        "ssh",
        "postfix-reconfigure-live",
        "opendkim-live-key-generation",
        "dns-live-change",
        "send-mail",
        "increase-volume"
      ]
    };
  }
}
