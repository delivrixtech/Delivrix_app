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
    return this.store.transaction([], (records) => {
      if (records.some((record) => record.proposalId === input.proposalId)) {
        return { value: records, result: "already_reserved" as const };
      }

      records.push({
        ...input,
        reservedAt: new Date().toISOString()
      });
      return { value: records, result: "reserved" as const };
    });
  }

  async list(): Promise<RunbookExecutionRecord[]> {
    return this.store.read([]);
  }
}
