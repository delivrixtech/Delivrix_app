import type {
  RegisterSenderNodeInput,
  SenderNode
} from "../../domain/src/index.ts";

export interface WebdockBridgeNodeConfig {
  id: string;
  label: string;
  hostname?: string;
  ipAddress?: string;
  dailyLimit?: number;
  warmupDay?: number;
}

export class WebdockAdapter {
  toSenderNodeInput(config: WebdockBridgeNodeConfig): RegisterSenderNodeInput {
    return {
      id: config.id,
      label: config.label,
      provider: "webdock",
      status: "warming",
      hostname: config.hostname,
      ipAddress: config.ipAddress,
      dailyLimit: config.dailyLimit ?? 50,
      warmupDay: config.warmupDay ?? 1
    };
  }

  describeCapabilities(node: SenderNode): Record<string, unknown> {
    return {
      nodeId: node.id,
      provider: "webdock",
      mode: "bridge",
      smtpEnabledByPlatform: false,
      sideEffects: "none",
      allowedOperations: ["register", "list", "select-for-dry-run"],
      blockedOperations: ["ssh", "postfix-reconfigure", "send-mail", "increase-volume"]
    };
  }
}
