import {
  normalizeEmail,
  type SuppressionEntry,
  type SuppressionList
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

export class LocalFileSuppressionList implements SuppressionList {
  private readonly store: JsonFileStore<SuppressionEntry[]>;

  constructor(filePath = process.env.LOCAL_SUPPRESSION_FILE ?? "runtime/suppression-entries.json") {
    this.store = new JsonFileStore<SuppressionEntry[]>(filePath);
  }

  async isSuppressed(email: string): Promise<SuppressionEntry | null> {
    const normalizedEmail = normalizeEmail(email);
    const entries = await this.store.read([]);
    return entries.find((entry) => entry.email === normalizedEmail) ?? null;
  }

  async add(entry: Omit<SuppressionEntry, "email" | "createdAt"> & { email: string }): Promise<SuppressionEntry> {
    const entries = await this.store.read([]);
    const normalizedEmail = normalizeEmail(entry.email);
    const existing = entries.find((candidate) => candidate.email === normalizedEmail);

    if (existing) {
      return existing;
    }

    const suppressionEntry: SuppressionEntry = {
      ...entry,
      email: normalizedEmail,
      createdAt: new Date().toISOString()
    };

    entries.push(suppressionEntry);
    await this.store.write(entries);
    return suppressionEntry;
  }

  async list(): Promise<SuppressionEntry[]> {
    return this.store.read([]);
  }
}
