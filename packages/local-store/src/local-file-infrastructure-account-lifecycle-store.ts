import { JsonFileStore } from "./json-file-store.ts";

export type InfrastructureAccountLifecycleStatus =
  | "active"
  | "paused"
  | "unauthorized"
  | "suspended"
  | "disabled"
  | "retired";

export type InfrastructureAccountHealthStatus =
  | "healthy"
  | "unauthorized"
  | "suspended_candidate"
  | "degraded"
  | "retired";

export interface InfrastructureAccountLifecycleRecord {
  accountKey: string;
  providerId: string;
  accountId: string;
  accountLabel: string;
  lifecycleStatus: InfrastructureAccountLifecycleStatus;
  healthStatus: InfrastructureAccountHealthStatus;
  aliases?: string[];
  lastSeenAt?: string;
  lastFetchedAt?: string;
  lastFetchOk?: boolean;
  lastHttpStatus?: number;
  lastErrorCode?: string;
  lastErrorReason?: string;
  lastKnownItemCount?: number;
  consecutiveFailures?: number;
  retiredAt?: string;
  retiredBy?: string;
  retiredReason?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface InfrastructureAccountLifecycleDocument {
  schemaVersion: "infrastructure-account-lifecycle/v1";
  updatedAt: string | null;
  accounts: InfrastructureAccountLifecycleRecord[];
}

export interface ObserveInfrastructureAccountInput {
  providerId: string;
  accountId: string;
  accountLabel: string;
  responseOk: boolean;
  healthStatus: InfrastructureAccountHealthStatus;
  fetchedAt: string;
  observedAt: string;
  itemCount: number;
  httpStatus?: number;
  errorCode?: string;
  errorReason?: string;
  aliases?: string[];
  actorId?: string;
}

export interface RetireInfrastructureAccountInput {
  providerId: string;
  accountId: string;
  accountLabel?: string;
  reason: string;
  actorId: string;
  retiredAt: string;
}

export interface InfrastructureAccountHealthTransition {
  account: InfrastructureAccountLifecycleRecord;
  previousHealthStatus: InfrastructureAccountHealthStatus | null;
  currentHealthStatus: InfrastructureAccountHealthStatus;
  action: "none" | "unhealthy" | "recovered";
}

function defaultDocument(): InfrastructureAccountLifecycleDocument {
  return {
    schemaVersion: "infrastructure-account-lifecycle/v1",
    updatedAt: null,
    accounts: []
  };
}

export class LocalFileInfrastructureAccountLifecycleStore {
  private readonly store: JsonFileStore<InfrastructureAccountLifecycleDocument>;

  constructor(filePath = process.env.LOCAL_INFRASTRUCTURE_ACCOUNT_LIFECYCLE_FILE ?? "runtime/infrastructure-account-lifecycle.json") {
    this.store = new JsonFileStore<InfrastructureAccountLifecycleDocument>(filePath);
  }

  async read(): Promise<InfrastructureAccountLifecycleDocument> {
    return normalizeDocument(await this.store.read(defaultDocument()));
  }

  async list(): Promise<InfrastructureAccountLifecycleRecord[]> {
    return (await this.read()).accounts;
  }

  async get(providerId: string, accountId: string): Promise<InfrastructureAccountLifecycleRecord | null> {
    const accountKey = accountLifecycleKey(providerId, accountId);
    return (await this.list()).find((account) => account.accountKey === accountKey) ?? null;
  }

  async observe(input: ObserveInfrastructureAccountInput): Promise<InfrastructureAccountHealthTransition> {
    return this.store.transaction(defaultDocument(), (current) => {
      const document = normalizeDocument(current);
      const accountKey = accountLifecycleKey(input.providerId, input.accountId);
      const canonicalAccountId = canonicalInfrastructureAccountId(input.providerId, input.accountId);
      const index = document.accounts.findIndex((account) => account.accountKey === accountKey);
      const previous = index >= 0 ? document.accounts[index] : null;
      const previousHealthStatus = previous?.healthStatus ?? null;
      const lifecycleStatus = previous?.lifecycleStatus === "retired"
        ? "retired"
        : lifecycleStatusForHealth(input.healthStatus);
      const aliases = accountAliasesFor(input.providerId, canonicalAccountId, input.aliases ?? previous?.aliases);
      const account: InfrastructureAccountLifecycleRecord = {
        accountKey,
        providerId: normalizeId(input.providerId),
        accountId: canonicalAccountId,
        accountLabel: input.accountLabel.trim() || input.accountId,
        lifecycleStatus,
        healthStatus: lifecycleStatus === "retired" ? "retired" : input.healthStatus,
        ...(aliases ? { aliases } : {}),
        lastSeenAt: input.observedAt,
        lastFetchedAt: input.fetchedAt,
        lastFetchOk: input.responseOk,
        ...(input.httpStatus ? { lastHttpStatus: input.httpStatus } : {}),
        ...(input.errorCode ? { lastErrorCode: input.errorCode } : {}),
        ...(input.errorReason ? { lastErrorReason: input.errorReason } : {}),
        lastKnownItemCount: input.responseOk ? Math.max(0, Math.trunc(input.itemCount)) : previous?.lastKnownItemCount ?? 0,
        consecutiveFailures: input.responseOk ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
        ...(previous?.retiredAt ? { retiredAt: previous.retiredAt } : {}),
        ...(previous?.retiredBy ? { retiredBy: previous.retiredBy } : {}),
        ...(previous?.retiredReason ? { retiredReason: previous.retiredReason } : {}),
        updatedAt: input.observedAt,
        updatedBy: input.actorId ?? "gateway-api"
      };
      if (index >= 0) {
        document.accounts[index] = account;
      } else {
        document.accounts.push(account);
      }
      document.accounts.sort((left, right) => left.accountKey.localeCompare(right.accountKey));
      document.updatedAt = input.observedAt;
      return {
        value: document,
        result: {
          account,
          previousHealthStatus,
          currentHealthStatus: account.healthStatus,
          action: healthTransitionAction(previousHealthStatus, account.healthStatus)
        }
      };
    });
  }

  async retire(input: RetireInfrastructureAccountInput): Promise<InfrastructureAccountLifecycleRecord> {
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw new Error("retire_reason_too_short");
    }
    if (!input.actorId.trim()) {
      throw new Error("retire_actor_required");
    }
    return this.store.transaction(defaultDocument(), (current) => {
      const document = normalizeDocument(current);
      const accountKey = accountLifecycleKey(input.providerId, input.accountId);
      const canonicalAccountId = canonicalInfrastructureAccountId(input.providerId, input.accountId);
      const index = document.accounts.findIndex((account) => account.accountKey === accountKey);
      const previous = index >= 0 ? document.accounts[index] : null;
      const aliases = accountAliasesFor(input.providerId, canonicalAccountId, previous?.aliases);
      const account: InfrastructureAccountLifecycleRecord = {
        accountKey,
        providerId: normalizeId(input.providerId),
        accountId: canonicalAccountId,
        accountLabel: input.accountLabel?.trim() || previous?.accountLabel || input.accountId,
        lifecycleStatus: "retired",
        healthStatus: "retired",
        ...(aliases ? { aliases } : {}),
        ...(previous?.lastSeenAt ? { lastSeenAt: previous.lastSeenAt } : {}),
        ...(previous?.lastFetchedAt ? { lastFetchedAt: previous.lastFetchedAt } : {}),
        ...(previous?.lastFetchOk === undefined ? {} : { lastFetchOk: previous.lastFetchOk }),
        ...(previous?.lastHttpStatus ? { lastHttpStatus: previous.lastHttpStatus } : {}),
        ...(previous?.lastErrorCode ? { lastErrorCode: previous.lastErrorCode } : {}),
        ...(previous?.lastErrorReason ? { lastErrorReason: previous.lastErrorReason } : {}),
        lastKnownItemCount: previous?.lastKnownItemCount ?? 0,
        consecutiveFailures: previous?.consecutiveFailures ?? 0,
        retiredAt: input.retiredAt,
        retiredBy: input.actorId.trim(),
        retiredReason: reason,
        updatedAt: input.retiredAt,
        updatedBy: input.actorId.trim()
      };
      if (index >= 0) {
        document.accounts[index] = account;
      } else {
        document.accounts.push(account);
      }
      document.accounts.sort((left, right) => left.accountKey.localeCompare(right.accountKey));
      document.updatedAt = input.retiredAt;
      return { value: document, result: account };
    });
  }
}

export function accountLifecycleKey(providerId: string, accountId: string): string {
  return `${normalizeId(providerId)}:${canonicalInfrastructureAccountId(providerId, accountId)}`;
}

export function canonicalInfrastructureAccountId(providerId: string, accountId: string): string {
  const provider = normalizeId(providerId);
  const account = normalizeId(accountId);
  if (provider === "webdock" && ["primary", "ops", "account", "default"].includes(account)) {
    return "ops";
  }
  return account;
}

export function isLifecycleAccountActive(record: InfrastructureAccountLifecycleRecord | null | undefined): boolean {
  return !record || (record.lifecycleStatus !== "disabled" && record.lifecycleStatus !== "retired");
}

export function infrastructureAccountLifecycleIds(
  record: Pick<InfrastructureAccountLifecycleRecord, "providerId" | "accountId" | "aliases">
): string[] {
  return accountIdsFor(record.providerId, record.accountId, record.aliases);
}

function normalizeDocument(document: InfrastructureAccountLifecycleDocument): InfrastructureAccountLifecycleDocument {
  if (document.schemaVersion !== "infrastructure-account-lifecycle/v1" || !Array.isArray(document.accounts)) {
    return defaultDocument();
  }
  return {
    schemaVersion: "infrastructure-account-lifecycle/v1",
    updatedAt: typeof document.updatedAt === "string" ? document.updatedAt : null,
    accounts: document.accounts
      .filter((account) => typeof account.accountKey === "string")
      .map(normalizeRecord)
  };
}

function normalizeRecord(record: InfrastructureAccountLifecycleRecord): InfrastructureAccountLifecycleRecord {
  return {
    accountKey: accountLifecycleKey(record.providerId, record.accountId),
    providerId: normalizeId(record.providerId),
    accountId: canonicalInfrastructureAccountId(record.providerId, record.accountId),
    accountLabel: record.accountLabel || record.accountId,
    lifecycleStatus: normalizeLifecycleStatus(record.lifecycleStatus),
    healthStatus: normalizeHealthStatus(record.healthStatus),
    ...(accountAliasesFor(record.providerId, record.accountId, record.aliases) ? { aliases: accountAliasesFor(record.providerId, record.accountId, record.aliases) } : {}),
    ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
    ...(record.lastFetchedAt ? { lastFetchedAt: record.lastFetchedAt } : {}),
    ...(record.lastFetchOk === undefined ? {} : { lastFetchOk: Boolean(record.lastFetchOk) }),
    ...(record.lastHttpStatus ? { lastHttpStatus: record.lastHttpStatus } : {}),
    ...(record.lastErrorCode ? { lastErrorCode: record.lastErrorCode } : {}),
    ...(record.lastErrorReason ? { lastErrorReason: record.lastErrorReason } : {}),
    lastKnownItemCount: Number.isFinite(record.lastKnownItemCount) ? Math.max(0, Math.trunc(record.lastKnownItemCount ?? 0)) : 0,
    consecutiveFailures: Number.isFinite(record.consecutiveFailures) ? Math.max(0, Math.trunc(record.consecutiveFailures ?? 0)) : 0,
    ...(record.retiredAt ? { retiredAt: record.retiredAt } : {}),
    ...(record.retiredBy ? { retiredBy: record.retiredBy } : {}),
    ...(record.retiredReason ? { retiredReason: record.retiredReason } : {}),
    updatedAt: record.updatedAt || new Date(0).toISOString(),
    updatedBy: record.updatedBy || "unknown"
  };
}

function lifecycleStatusForHealth(healthStatus: InfrastructureAccountHealthStatus): InfrastructureAccountLifecycleStatus {
  if (healthStatus === "unauthorized") return "unauthorized";
  if (healthStatus === "suspended_candidate") return "suspended";
  if (healthStatus === "retired") return "retired";
  return "active";
}

function healthTransitionAction(
  previous: InfrastructureAccountHealthStatus | null,
  current: InfrastructureAccountHealthStatus
): InfrastructureAccountHealthTransition["action"] {
  const wasUnhealthy = previous !== null && previous !== "healthy";
  const isUnhealthy = current !== "healthy";
  if (!wasUnhealthy && isUnhealthy) return "unhealthy";
  if (wasUnhealthy && !isUnhealthy) return "recovered";
  return "none";
}

function normalizeLifecycleStatus(value: unknown): InfrastructureAccountLifecycleStatus {
  if (value === "paused" || value === "unauthorized" || value === "suspended" || value === "disabled" || value === "retired") {
    return value;
  }
  return "active";
}

function normalizeHealthStatus(value: unknown): InfrastructureAccountHealthStatus {
  if (value === "unauthorized" || value === "suspended_candidate" || value === "degraded" || value === "retired") {
    return value;
  }
  return "healthy";
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function accountAliasesFor(providerId: string, accountId: string, aliases?: string[]): string[] | undefined {
  const result = accountIdsFor(providerId, accountId, aliases);
  return result.length > 0 ? result : undefined;
}

function accountIdsFor(providerId: string, accountId: string, aliases?: string[]): string[] {
  const provider = normalizeId(providerId);
  const canonicalAccountId = canonicalInfrastructureAccountId(provider, accountId);
  const normalizedAliases = aliases?.map(normalizeId) ?? [];
  if (provider === "webdock" && canonicalAccountId === "ops") {
    return uniqueSorted([...normalizedAliases, "account", "default", "ops", "primary"]);
  }
  return uniqueSorted([canonicalAccountId, ...normalizedAliases]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
