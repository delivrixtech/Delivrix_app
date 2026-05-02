export type SuppressionReason = "unsubscribe" | "complaint" | "hard_bounce" | "manual" | "legal";

export interface SuppressionEntry {
  email: string;
  reason: SuppressionReason;
  createdAt: string;
  source: string;
}

export interface SuppressionList {
  isSuppressed(email: string): Promise<SuppressionEntry | null>;
  add(entry: Omit<SuppressionEntry, "email" | "createdAt"> & { email: string }): Promise<SuppressionEntry>;
  list(): Promise<SuppressionEntry[]>;
}

export class InMemorySuppressionList implements SuppressionList {
  private readonly entries = new Map<string, SuppressionEntry>();

  constructor(initialEntries: SuppressionEntry[] = []) {
    for (const entry of initialEntries) {
      this.entries.set(normalizeEmail(entry.email), entry);
    }
  }

  async isSuppressed(email: string): Promise<SuppressionEntry | null> {
    return this.entries.get(normalizeEmail(email)) ?? null;
  }

  async add(entry: Omit<SuppressionEntry, "email" | "createdAt"> & { email: string }): Promise<SuppressionEntry> {
    const suppressionEntry: SuppressionEntry = {
      ...entry,
      email: normalizeEmail(entry.email),
      createdAt: new Date().toISOString()
    };

    this.entries.set(suppressionEntry.email, suppressionEntry);
    return suppressionEntry;
  }

  async list(): Promise<SuppressionEntry[]> {
    return [...this.entries.values()];
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
