import type { SendRequest, SenderNode } from "./types.ts";
import {
  dailyWindowKey,
  senderNodeRateLimitRule,
  type RateLimitCounterStore
} from "./rate-limit.ts";

export interface SenderNodeRegistryStore {
  list(): Promise<SenderNode[]>;
  upsert(node: SenderNode): Promise<SenderNode>;
}

export interface SenderNodeCapacitySnapshot {
  senderNodeId: string;
  consumed: number;
}

export interface RegisterSenderNodeInput {
  id: string;
  label: string;
  provider: SenderNode["provider"];
  providerAccountId?: string;
  providerServerId?: string;
  status?: SenderNode["status"];
  ipAddress?: string;
  hostname?: string;
  dailyLimit: number;
  warmupDay?: number;
}

export class SenderNodeRegistry {
  private readonly store: SenderNodeRegistryStore;
  private readonly quotaStore: RateLimitCounterStore | null;
  private readonly now: () => Date;

  constructor(
    store: SenderNodeRegistryStore,
    options: { quotaStore?: RateLimitCounterStore; now?: () => Date } = {}
  ) {
    this.store = store;
    this.quotaStore = options.quotaStore ?? null;
    this.now = options.now ?? (() => new Date());
  }

  async register(input: RegisterSenderNodeInput): Promise<SenderNode> {
    const node = normalizeSenderNode(input);
    return this.store.upsert(node);
  }

  async list(): Promise<SenderNode[]> {
    return this.store.list();
  }

  async get(senderNodeId: string): Promise<SenderNode | null> {
    const nodes = await this.store.list();
    return nodes.find((candidate) => candidate.id === senderNodeId) ?? null;
  }

  async exists(senderNodeId: string): Promise<boolean> {
    return (await this.get(senderNodeId)) !== null;
  }

  async existsByIp(ipAddress: string | undefined): Promise<boolean> {
    const ip = ipAddress?.trim();

    if (!ip) {
      return false;
    }

    const nodes = await this.store.list();
    return nodes.some((candidate) => candidate.ipAddress === ip);
  }

  async findAvailableFor(request: SendRequest): Promise<SenderNode | null> {
    void request;
    const nodes = await this.store.list();
    if (!this.quotaStore) {
      return selectSenderNode(nodes);
    }

    const capacities = await this.capacitySnapshotsFor(nodes);
    if (!capacities) {
      return null;
    }
    return selectSenderNode(nodes, capacities);
  }

  private async capacitySnapshotsFor(nodes: SenderNode[]): Promise<SenderNodeCapacitySnapshot[] | null> {
    const quotaStore = this.quotaStore;
    if (!quotaStore) {
      return [];
    }

    const windowKey = dailyWindowKey(this.now());
    try {
      return await Promise.all(nodes.map(async (node) => {
        const counter = await quotaStore.get(senderNodeRateLimitRule(node), windowKey);
        return {
          senderNodeId: node.id,
          consumed: counter.count
        };
      }));
    } catch {
      return null;
    }
  }

  async updateStatus(senderNodeId: string, status: SenderNode["status"]): Promise<SenderNode> {
    const nodes = await this.store.list();
    const node = nodes.find((candidate) => candidate.id === senderNodeId);

    if (!node) {
      throw new Error(`Sender node not found: ${senderNodeId}`);
    }

    return this.store.upsert({
      ...node,
      status
    });
  }

  async updateMetadata(
    senderNodeId: string,
    patch: Partial<Pick<SenderNode, "status" | "dailyLimit" | "warmupDay" | "ipAddress" | "hostname" | "label">>
  ): Promise<SenderNode> {
    const nodes = await this.store.list();
    const node = nodes.find((candidate) => candidate.id === senderNodeId);

    if (!node) {
      throw new Error(`Sender node not found: ${senderNodeId}`);
    }

    return this.store.upsert({
      ...node,
      ...patch
    });
  }
}

export function selectSenderNode(
  nodes: SenderNode[],
  capacities: SenderNodeCapacitySnapshot[] = [],
  requestedAmount = 1
): SenderNode | null {
  const consumedByNodeId = new Map(capacities.map((capacity) => [capacity.senderNodeId, capacity.consumed]));
  const eligibleNodes = nodes
    .filter((node) => node.dailyLimit > 0)
    .filter((node) => node.status === "active" || node.status === "warming")
    .filter((node) => remainingCapacity(node, consumedByNodeId) >= requestedAmount)
    .sort((left, right) => compareSenderNodes(left, right, consumedByNodeId));

  return eligibleNodes[0] ?? null;
}

function compareSenderNodes(left: SenderNode, right: SenderNode, consumedByNodeId = new Map<string, number>()): number {
  const statusRank = rankStatus(left.status) - rankStatus(right.status);

  if (statusRank !== 0) {
    return statusRank;
  }

  const remainingRank = remainingCapacity(right, consumedByNodeId) - remainingCapacity(left, consumedByNodeId);

  if (remainingRank !== 0) {
    return remainingRank;
  }

  const warmupRank = left.warmupDay - right.warmupDay;

  if (warmupRank !== 0) {
    return warmupRank;
  }

  return left.id.localeCompare(right.id);
}

function remainingCapacity(node: SenderNode, consumedByNodeId: Map<string, number>): number {
  return node.dailyLimit - (consumedByNodeId.get(node.id) ?? 0);
}

function rankStatus(status: SenderNode["status"]): number {
  if (status === "active") {
    return 0;
  }

  if (status === "warming") {
    return 1;
  }

  return 99;
}

function normalizeSenderNode(input: RegisterSenderNodeInput): SenderNode {
  if (!input.id.trim()) {
    throw new Error("Sender node id is required.");
  }

  if (!input.label.trim()) {
    throw new Error("Sender node label is required.");
  }

  if (input.dailyLimit < 0) {
    throw new Error("Sender node dailyLimit must be >= 0.");
  }

  return {
    id: input.id.trim(),
    label: input.label.trim(),
    provider: input.provider,
    providerAccountId: input.providerAccountId?.trim() || undefined,
    providerServerId: input.providerServerId?.trim() || undefined,
    status: input.status ?? "warming",
    ipAddress: input.ipAddress?.trim() || undefined,
    hostname: input.hostname?.trim() || undefined,
    dailyLimit: input.dailyLimit,
    warmupDay: input.warmupDay ?? 0
  };
}
