import { positiveIntegerOrDefault } from "./request-body.ts";

export interface ServerRunningServer {
  slug: string;
  status: string;
  ipv4: string;
}

export interface ServerRunningAdapter {
  getServer(slug: string): Promise<ServerRunningServer>;
}

export interface ServerRunningAdapterRegistry {
  webdockOpsAdapter: ServerRunningAdapter;
  webdockCreateAdapters: Map<string, ServerRunningAdapter>;
  vpsProviderAdapters: Map<string, ServerRunningAdapter>;
}

export async function waitForServerRunning(input: {
  params: Record<string, unknown>;
  adapters: ServerRunningAdapterRegistry;
  env?: Record<string, string | undefined>;
  serverAccountId?: string;
  providerId?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<Record<string, unknown>> {
  const serverSlug = stringParam(input.params, "serverSlug");
  if (!serverSlug) {
    throw new Error("wait_server_running requires serverSlug");
  }
  const env = input.env ?? process.env;
  const maxWaitMs = positiveIntegerOrDefault(input.params.maxWaitMs, 600_000);
  const provider = normalizeRuntimeProviderId(input.providerId);
  const adapter = resolveServerRunningAdapter({
    providerId: provider,
    serverAccountId: input.serverAccountId,
    adapters: input.adapters
  });
  const pollIntervalMs = provider === "contabo"
    ? positiveIntegerOrDefault(env.CONTABO_PROVISION_POLL_INTERVAL_MS, 10_000)
    : positiveIntegerOrDefault(env.WEBDOCK_PROVISION_POLL_INTERVAL_MS, 5_000);
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? sleepMs;
  const startedAt = now();
  const maxIterations = Math.max(1, Math.ceil(maxWaitMs / Math.max(1, pollIntervalMs)) + 100);
  let attempts = 0;
  let lastStatus: unknown = "unknown";
  let lastIpv4: string | null = null;

  while (attempts < maxIterations) {
    attempts += 1;
    const server = await adapter.getServer(serverSlug);
    lastStatus = server.status;
    lastIpv4 = typeof server.ipv4 === "string" && server.ipv4.trim() ? server.ipv4.trim() : null;
    if (server.status === "running" && lastIpv4) {
      return {
        ok: true,
        status: "running",
        providerId: provider ?? "webdock",
        serverAccountId: input.serverAccountId ?? "ops",
        serverSlug: server.slug,
        ipv4: lastIpv4,
        serverIp: lastIpv4,
        pollCount: attempts,
        durationMs: now() - startedAt
      };
    }

    const remainingMs = maxWaitMs - (now() - startedAt);
    if (remainingMs <= 0) {
      return timeoutOutcome({
        provider,
        serverAccountId: input.serverAccountId,
        serverSlug,
        lastIpv4,
        lastStatus,
        attempts,
        durationMs: now() - startedAt,
        reason: "max_wait_elapsed"
      });
    }

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return timeoutOutcome({
    provider,
    serverAccountId: input.serverAccountId,
    serverSlug,
    lastIpv4,
    lastStatus,
    attempts,
    durationMs: now() - startedAt,
    reason: "max_iterations_exceeded"
  });
}

function timeoutOutcome(input: {
  provider?: string;
  serverAccountId?: string;
  serverSlug: string;
  lastIpv4: string | null;
  lastStatus: unknown;
  attempts: number;
  durationMs: number;
  reason: string;
}): Record<string, unknown> {
  return {
    ok: false,
    status: "timeout_waiting_for_server_ip",
    reason: input.reason,
    providerId: input.provider ?? "webdock",
    serverAccountId: input.serverAccountId ?? "ops",
    serverSlug: input.serverSlug,
    ipv4: input.lastIpv4,
    serverIp: input.lastIpv4,
    lastStatus: input.lastStatus,
    pollCount: input.attempts,
    durationMs: input.durationMs
  };
}

function resolveServerRunningAdapter(input: {
  providerId?: string;
  serverAccountId?: string;
  adapters: ServerRunningAdapterRegistry;
}): ServerRunningAdapter {
  if (input.providerId && input.providerId !== "webdock") {
    const adapter = input.adapters.vpsProviderAdapters.get(input.providerId);
    if (!adapter) {
      throw new Error(`unknown_vps_provider:${input.providerId}`);
    }
    return adapter;
  }
  const accountId = input.serverAccountId?.trim() || "ops";
  if (accountId === "ops") return input.adapters.webdockOpsAdapter;
  return input.adapters.webdockCreateAdapters.get(accountId) ?? input.adapters.webdockOpsAdapter;
}

function normalizeRuntimeProviderId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "webdock") return undefined;
  return normalized;
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
