import {
  createId,
  type SendResult,
  type SendResultStatus
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

export interface CreateSendResultInput {
  sendJobId: string;
  senderNodeId?: string;
  status: SendResultStatus;
  smtpResponse?: string;
  bounceCode?: string;
  complaintSource?: string;
  metadata?: Record<string, unknown>;
}

export class LocalFileSendResultStore {
  private readonly store: JsonFileStore<SendResult[]>;

  constructor(filePath = process.env.LOCAL_SEND_RESULTS_FILE ?? "runtime/send-results.json") {
    this.store = new JsonFileStore<SendResult[]>(filePath);
  }

  async create(input: CreateSendResultInput): Promise<SendResult> {
    const results = await this.store.read([]);
    const result: SendResult = {
      id: createId("sendresult"),
      sendJobId: input.sendJobId,
      senderNodeId: input.senderNodeId,
      status: input.status,
      smtpResponse: input.smtpResponse,
      bounceCode: input.bounceCode,
      complaintSource: input.complaintSource,
      metadata: input.metadata ?? {},
      occurredAt: new Date().toISOString()
    };

    results.push(result);
    await this.store.write(results);
    return result;
  }

  async list(): Promise<SendResult[]> {
    return this.store.read([]);
  }
}
