import type {
  ReserveRunbookExecutionInput,
  RunbookExecutionTracker
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

interface RunbookExecutionRecord extends ReserveRunbookExecutionInput {
  reservedAt: string;
}

export class LocalFileRunbookExecutionStore implements RunbookExecutionTracker {
  private readonly store: JsonFileStore<RunbookExecutionRecord[]>;

  constructor(filePath = process.env.LOCAL_RUNBOOK_EXECUTIONS_FILE ?? "runtime/runbook-executions.json") {
    this.store = new JsonFileStore<RunbookExecutionRecord[]>(filePath);
  }

  async reserve(input: ReserveRunbookExecutionInput): Promise<"reserved" | "already_reserved"> {
    const records = await this.store.read([]);
    if (records.some((record) => record.proposalId === input.proposalId)) {
      return "already_reserved";
    }

    records.push({
      ...input,
      reservedAt: new Date().toISOString()
    });
    await this.store.write(records);
    return "reserved";
  }

  async list(): Promise<RunbookExecutionRecord[]> {
    return this.store.read([]);
  }
}
