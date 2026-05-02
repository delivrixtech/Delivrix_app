import type {
  SenderNode,
  SenderNodeRegistryStore
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

export class LocalFileSenderNodeStore implements SenderNodeRegistryStore {
  private readonly store: JsonFileStore<SenderNode[]>;

  constructor(filePath = process.env.LOCAL_SENDER_NODES_FILE ?? "runtime/sender-nodes.json") {
    this.store = new JsonFileStore<SenderNode[]>(filePath);
  }

  async list(): Promise<SenderNode[]> {
    return this.store.read([]);
  }

  async upsert(node: SenderNode): Promise<SenderNode> {
    const nodes = await this.store.read([]);
    const existingIndex = nodes.findIndex((candidate) => candidate.id === node.id);

    if (existingIndex >= 0) {
      nodes[existingIndex] = node;
    } else {
      nodes.push(node);
    }

    await this.store.write(nodes);
    return node;
  }
}
