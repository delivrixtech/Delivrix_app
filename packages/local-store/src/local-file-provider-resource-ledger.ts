import { randomUUID } from "node:crypto";
import type {
  ProviderResourceRecord,
  RecordProviderResourceInput
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

/**
 * Ledger append-only de recursos de proveedores (Provider Fabric fase C).
 * Un registro por evento created/deleted; nunca se muta ni se borra.
 */
export class LocalFileProviderResourceLedger {
  private readonly store: JsonFileStore<ProviderResourceRecord[]>;

  constructor(
    filePath = process.env.LOCAL_PROVIDER_RESOURCE_LEDGER_FILE ??
      "runtime/provider-resource-ledger.json"
  ) {
    this.store = new JsonFileStore<ProviderResourceRecord[]>(filePath);
  }

  async append(input: RecordProviderResourceInput): Promise<ProviderResourceRecord> {
    const record: ProviderResourceRecord = {
      ...input,
      id: randomUUID(),
      occurredAt: new Date().toISOString()
    };
    await this.store.update([], (records) => {
      records.push(record);
      return records;
    });
    return record;
  }

  async list(): Promise<ProviderResourceRecord[]> {
    return this.store.read([]);
  }
}
