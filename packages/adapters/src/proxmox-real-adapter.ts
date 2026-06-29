import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";

import type { VpsProvider, VpsProviderEntry } from "./vps-provider.ts";
import type {
  WebdockCreateServerInput,
  WebdockCreateServerResult,
  WebdockDeleteServerResult,
  WebdockEnsureSshAccessResult,
  WebdockInventoryResult,
  WebdockInventorySource,
  WebdockServer,
  WebdockServerStatus
} from "./webdock-real-adapter.ts";

const DEFAULT_NODE = "cool-pve1";
const DEFAULT_TEMPLATE_VMID = 9000;
const DEFAULT_STORAGE = "local";
const DEFAULT_BRIDGE = "vmbr0";
const DEFAULT_ACCOUNT_ID = "proxmox";
const DEFAULT_ACCOUNT_LABEL = "Proxmox Cool";
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TASK_TIMEOUT_MS = 180_000;
const DEFAULT_HOST_SSH_PORT = 22;
const DEFAULT_HOST_SSH_CONNECT_TIMEOUT_SEC = 15;
const DEFAULT_HOST_COMMAND_TIMEOUT_MS = 120_000;

const execFilePromise = promisify(execFileCallback);

type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string; stderr: string }>;

export class ProxmoxAdapterError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly recoverable: boolean;
  readonly metadata: Record<string, unknown>;

  constructor(
    code: string,
    options: {
      status?: number | null;
      recoverable?: boolean;
      metadata?: Record<string, unknown>;
    } = {}
  ) {
    super(code);
    this.name = "ProxmoxAdapterError";
    this.code = code;
    this.status = options.status ?? null;
    this.recoverable = options.recoverable ?? false;
    this.metadata = options.metadata ?? {};
  }
}

export interface ProxmoxIpPoolConfig {
  gateway: string;
  cidr: number;
  rangeStart: string;
  rangeEnd: string;
}

export interface ProxmoxAdapterConfig {
  apiUrl?: string;
  tokenId?: string;
  tokenSecret?: string;
  node?: string;
  templateVmid?: number;
  storage?: string;
  bridge?: string;
  ipPool?: string | ProxmoxIpPoolConfig;
  /**
   * Net0 override para smoke/lifecycle sin /26. Ej:
   * `name=eth0,bridge=vmbr-a2,ip=10.250.0.4/24,gw=10.250.0.1`.
   * No se usa si hay IP pool publico.
   */
  testNet0?: string;
  accountId?: string;
  accountLabel?: string;
  cacheTtlMs?: number;
  taskPollIntervalMs?: number;
  taskTimeoutMs?: number;
  hostSshTarget?: string;
  hostSshKeyPath?: string;
  hostSshPort?: number;
  hostSshConnectTimeoutSec?: number;
  hostCommandTimeoutMs?: number;
  caCertPem?: string;
  caCertPath?: string;
  execFile?: ExecFileImpl;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface InventoryCacheEntry {
  expiresAt: number;
  result: WebdockInventoryResult;
}

interface ProxmoxLxcResource {
  vmid: number;
  status?: string;
  name?: string;
  maxmem?: number;
  maxdisk?: number;
  uptime?: number;
  template?: 0 | 1 | boolean;
}

export class ProxmoxRealAdapter implements VpsProvider {
  private readonly apiUrl: string | undefined;
  private readonly tokenId: string | undefined;
  private readonly tokenSecret: string | undefined;
  private readonly node: string;
  private readonly templateVmid: number;
  private readonly storage: string;
  private readonly bridge: string;
  private readonly ipPool: ProxmoxIpPoolConfig | undefined;
  private readonly testNet0: string | undefined;
  private readonly accountId: string;
  private readonly accountLabel: string;
  private readonly cacheTtlMs: number;
  private readonly taskPollIntervalMs: number;
  private readonly taskTimeoutMs: number;
  private readonly hostSshTarget: string | undefined;
  private readonly hostSshKeyPath: string | undefined;
  private readonly hostSshPort: number;
  private readonly hostSshConnectTimeoutSec: number;
  private readonly hostCommandTimeoutMs: number;
  private readonly caCertPem: string | undefined;
  private readonly execFile: ExecFileImpl;
  private readonly injectedFetch: typeof fetch | undefined;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private inventoryCache: InventoryCacheEntry | null = null;

  constructor(config: ProxmoxAdapterConfig = {}) {
    this.apiUrl = normalizeApiUrl(config.apiUrl);
    this.tokenId = normalizeEnvValue(config.tokenId);
    this.tokenSecret = normalizeEnvValue(config.tokenSecret);
    this.node = normalizeEnvValue(config.node) ?? DEFAULT_NODE;
    this.templateVmid = normalizePositiveInteger(config.templateVmid) ?? DEFAULT_TEMPLATE_VMID;
    this.storage = normalizeEnvValue(config.storage) ?? DEFAULT_STORAGE;
    this.bridge = normalizeEnvValue(config.bridge) ?? DEFAULT_BRIDGE;
    this.ipPool = typeof config.ipPool === "string" ? parseIpPool(config.ipPool) : config.ipPool;
    this.testNet0 = normalizeEnvValue(config.testNet0);
    this.accountId = normalizeEnvValue(config.accountId) ?? DEFAULT_ACCOUNT_ID;
    this.accountLabel = normalizeEnvValue(config.accountLabel) ?? DEFAULT_ACCOUNT_LABEL;
    this.cacheTtlMs = normalizeNonNegativeMs(config.cacheTtlMs) ?? DEFAULT_CACHE_TTL_MS;
    this.taskPollIntervalMs = normalizeNonNegativeMs(config.taskPollIntervalMs) ?? DEFAULT_TASK_POLL_INTERVAL_MS;
    this.taskTimeoutMs = normalizeNonNegativeMs(config.taskTimeoutMs) ?? DEFAULT_TASK_TIMEOUT_MS;
    this.hostSshTarget = normalizeEnvValue(config.hostSshTarget);
    this.hostSshKeyPath = normalizeEnvValue(config.hostSshKeyPath);
    this.hostSshPort = normalizePositiveInteger(config.hostSshPort) ?? DEFAULT_HOST_SSH_PORT;
    this.hostSshConnectTimeoutSec =
      normalizePositiveInteger(config.hostSshConnectTimeoutSec) ?? DEFAULT_HOST_SSH_CONNECT_TIMEOUT_SEC;
    this.hostCommandTimeoutMs = normalizeNonNegativeMs(config.hostCommandTimeoutMs) ?? DEFAULT_HOST_COMMAND_TIMEOUT_MS;
    this.caCertPem = loadCaCertPem(config.caCertPem, config.caCertPath);
    this.execFile = config.execFile ?? execFilePromise;
    this.injectedFetch = config.fetchImpl;
    this.sleepFn = config.sleep ?? sleep;
    this.now = config.now ?? (() => new Date());
  }

  isLive(): boolean {
    return Boolean(this.apiUrl && this.tokenId && this.tokenSecret);
  }

  canWrite(): boolean {
    return this.isLive();
  }

  canCreate(): boolean {
    return this.isLive() && Boolean(this.hostSshTarget) && Boolean(this.ipPool || this.testNet0);
  }

  async createServer(input: WebdockCreateServerInput): Promise<WebdockCreateServerResult> {
    this.assertWritable();
    this.assertGuestSetupAvailable();
    this.assertNetworkConfigAvailable();
    const now = this.now();
    const vmid = await this.nextId();
    const createdAt = now.toISOString();
    const hostname = normalizeHostname(input.hostname);
    const net0 = await this.allocateNet0();
    let created = false;

    try {
      const cloneUpid = await this.proxmoxRequestText("POST", `/nodes/${encodeURIComponent(this.node)}/lxc/${this.templateVmid}/clone`, {
        newid: String(vmid),
        hostname,
        full: "1",
        storage: this.storage,
        description: `delivrix-created=${createdAt}`
      });
      created = true;
      await this.waitTask(cloneUpid);

      await this.proxmoxRequestJson("PUT", `/nodes/${encodeURIComponent(this.node)}/lxc/${vmid}/config`, {
        net0,
        description: `delivrix-created=${createdAt}`,
        onboot: "0"
      });

      const startUpid = await this.proxmoxRequestText("POST", `/nodes/${encodeURIComponent(this.node)}/lxc/${vmid}/status/start`);
      await this.waitTask(startUpid);
      await this.runInitialGuestSetup(vmid, input.publicKey);

      this.invalidateInventoryCache();
      return {
        serverSlug: toServerSlug(vmid),
        eventId: startUpid || `proxmox-start-${vmid}`,
        ipv4: ipv4FromNet0(net0),
        status: "running",
        source: this.sourceMetadata(now, true)
      };
    } catch (error) {
      if (created) {
        await this.bestEffortDestroy(vmid);
      }
      throw error;
    }
  }

  async getServer(slug: string): Promise<WebdockServer> {
    this.assertReadable();
    const vmid = fromServerSlug(slug);
    const resource = await this.proxmoxRequestJson("GET", `/nodes/${encodeURIComponent(this.node)}/lxc/${vmid}/status/current`);
    const config = await this.safeGetConfig(vmid);
    return this.toWebdockServer(resourceObject(resource), config, vmid);
  }

  async listServers(): Promise<WebdockInventoryResult> {
    const now = this.now();
    if (this.inventoryCache && this.inventoryCache.expiresAt > now.getTime()) {
      return this.inventoryCache.result;
    }

    if (!this.isLive()) {
      const result = {
        servers: [],
        source: this.sourceMetadata(now, false, "Proxmox credentials missing")
      };
      this.cacheInventory(now, result);
      return result;
    }

    try {
      const raw = await this.proxmoxRequestJson("GET", `/nodes/${encodeURIComponent(this.node)}/lxc`);
      const resources = proxmoxDataArray(raw);
      const servers: WebdockServer[] = [];
      for (const resource of resources) {
        const vmid = numberField(resource, "vmid");
        if (vmid === undefined) continue;
        const config = await this.safeGetConfig(vmid);
        servers.push(this.toWebdockServer(resource, config, vmid));
      }
      const result = { servers, source: this.sourceMetadata(now, true) };
      this.cacheInventory(now, result);
      return result;
    } catch (error) {
      const result = {
        servers: [],
        source: this.sourceMetadata(now, false, proxmoxErrorReason(error))
      };
      this.cacheInventory(now, result);
      return result;
    }
  }

  async deleteServer(slug: string): Promise<WebdockDeleteServerResult> {
    this.assertWritable();
    const now = this.now();
    const vmid = fromServerSlug(slug);
    const upid = await this.proxmoxRequestText("DELETE", `/nodes/${encodeURIComponent(this.node)}/lxc/${vmid}`, {
      purge: "1",
      destroyUnreferencedDisks: "1"
    });
    if (upid) {
      await this.waitTask(upid);
    }
    this.invalidateInventoryCache();
    return {
      serverSlug: toServerSlug(vmid),
      eventId: upid || `proxmox-delete-${vmid}`,
      status: "deleting",
      source: this.sourceMetadata(now, true)
    };
  }

  async ensureServerSshAccess(opts: {
    serverSlug: string;
    publicKey: string;
    username?: string;
  }): Promise<WebdockEnsureSshAccessResult> {
    this.assertWritable();
    const vmid = fromServerSlug(opts.serverSlug);
    const publicKey = normalizePublicKey(opts.publicKey);
    const username = normalizeEnvValue(opts.username) ?? "root";
    const shell = [
      "set -euo pipefail",
      "install -d -m 0700 /root/.ssh",
      `printf '%s\\n' ${shellQuote(publicKey)} > /root/.ssh/authorized_keys`,
      "chmod 0600 /root/.ssh/authorized_keys",
      "systemctl daemon-reload >/dev/null 2>&1 || true",
      "systemctl reset-failed ssh >/dev/null 2>&1 || true",
      "(systemctl restart ssh || systemctl restart sshd) >/dev/null 2>&1 || true"
    ].join("; ");
    await this.runPctExec(vmid, shell);
    return {
      publicKeyId: publicKeyFingerprintNumber(publicKey),
      username,
      shellUserId: null,
      shellUserEventId: null,
      sshSettingsEventId: `proxmox-pct-exec-${vmid}`
    };
  }

  private async nextId(): Promise<number> {
    const raw = await this.proxmoxRequestJson("GET", "/cluster/nextid");
    const value = proxmoxData(raw);
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ProxmoxAdapterError("proxmox_nextid_invalid", {
        metadata: { raw: truncateRaw(raw) }
      });
    }
    return parsed;
  }

  private async allocateNet0(): Promise<string> {
    if (this.ipPool) {
      const used = await this.usedIpv4s();
      const ipv4 = firstAvailableIpv4(this.ipPool, used);
      if (!ipv4) {
        throw new ProxmoxAdapterError("proxmox_ip_pool_exhausted", {
          metadata: {
            rangeStart: this.ipPool.rangeStart,
            rangeEnd: this.ipPool.rangeEnd,
            usedCount: used.size
          }
        });
      }
      return `name=eth0,bridge=${this.bridge},ip=${ipv4}/${this.ipPool.cidr},gw=${this.ipPool.gateway},hwaddr=auto`;
    }
    if (this.testNet0) {
      return this.testNet0;
    }
    throw new ProxmoxAdapterError("proxmox_ip_pool_missing", {
      metadata: {
        operatorAction:
          "set PROXMOX_IP_POOL for production, or PROXMOX_TEST_NET0 for lifecycle smoke without /26"
      }
    });
  }

  private async usedIpv4s(): Promise<Set<string>> {
    const raw = await this.proxmoxRequestJson("GET", `/nodes/${encodeURIComponent(this.node)}/lxc`);
    const used = new Set<string>();
    for (const resource of proxmoxDataArray(raw)) {
      const vmid = numberField(resource, "vmid");
      if (vmid === undefined) continue;
      const config = await this.safeGetConfig(vmid);
      const net0 = stringField(config, "net0");
      const ip = net0 ? ipv4FromNet0(net0) : null;
      if (ip) used.add(ip);
    }
    return used;
  }

  private async safeGetConfig(vmid: number): Promise<Record<string, unknown>> {
    try {
      const raw = await this.proxmoxRequestJson("GET", `/nodes/${encodeURIComponent(this.node)}/lxc/${vmid}/config`);
      const data = proxmoxData(raw);
      return data && typeof data === "object" && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private toWebdockServer(
    resource: Record<string, unknown> | undefined,
    config: Record<string, unknown>,
    vmid: number
  ): WebdockServer {
    const net0 = stringField(config, "net0");
    const description = stringField(config, "description");
    const hostname =
      stringField(config, "hostname") ??
      stringField(resource, "name") ??
      `proxmox-${vmid}`;
    return {
      slug: toServerSlug(vmid),
      name: hostname,
      ipv4: net0 ? ipv4FromNet0(net0) ?? "" : "",
      status: mapProxmoxStatus(stringField(resource, "status") ?? stringField(config, "status")),
      location: this.node,
      creationDate: parseCreationDate(description),
      imageSlug: "debian-12",
      description,
      hostname,
      mainDomain: hostname,
      accountId: this.accountId,
      accountLabel: this.accountLabel
    };
  }

  private async waitTask(upid: string): Promise<void> {
    if (!upid) return;
    const started = Date.now();
    while (Date.now() - started <= this.taskTimeoutMs) {
      const raw = await this.proxmoxRequestJson("GET", `/nodes/${encodeURIComponent(this.node)}/tasks/${encodeURIComponent(upid)}/status`);
      const status = resourceObject(raw);
      if (stringField(status, "status") === "stopped") {
        const exitstatus = stringField(status, "exitstatus");
        if (exitstatus && exitstatus !== "OK") {
          throw new ProxmoxAdapterError("proxmox_task_failed", {
            metadata: { upid, exitstatus }
          });
        }
        return;
      }
      await this.sleepFn(this.taskPollIntervalMs);
    }
    throw new ProxmoxAdapterError("proxmox_task_timeout", {
      metadata: { upid, timeoutMs: this.taskTimeoutMs }
    });
  }

  private async proxmoxRequestJson(
    method: string,
    path: string,
    params?: Record<string, string>
  ): Promise<unknown> {
    const response = await this.proxmoxFetch(method, path, params);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw classifyProxmoxHttpFailure(response.status, body, { method, path });
    }
    return response.json().catch(() => ({}));
  }

  private async proxmoxRequestText(
    method: string,
    path: string,
    params?: Record<string, string>
  ): Promise<string> {
    const raw = await this.proxmoxRequestJson(method, path, params);
    const data = proxmoxData(raw);
    return typeof data === "string" ? data : stringField(resourceObject(raw), "upid") ?? "";
  }

  private async proxmoxFetch(
    method: string,
    path: string,
    params?: Record<string, string>
  ): Promise<Response> {
    this.assertReadable();
    const baseUrl = `${this.apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const hasQueryParams = params && method.toUpperCase() === "DELETE";
    const url = hasQueryParams ? `${baseUrl}?${new URLSearchParams(params).toString()}` : baseUrl;
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`
    };
    const init: RequestInit = { method, headers };
    if (params && !hasQueryParams) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(params).toString();
    }
    if (!this.injectedFetch && this.caCertPem && url.startsWith("https://")) {
      return nodeHttpFetch(url, init, this.caCertPem);
    }
    return this.fetchImpl(url, init);
  }

  private async runInitialGuestSetup(vmid: number, publicKey: string): Promise<void> {
    const normalizedPublicKey = normalizePublicKey(publicKey);
    const shell = [
      "set -euo pipefail",
      "rm -f /etc/ssh/ssh_host_*key* /etc/ssh/ssh_host_*key*.pub",
      "ssh-keygen -A >/dev/null",
      "rm -f /etc/machine-id",
      "systemd-machine-id-setup >/dev/null 2>&1 || true",
      "install -d -m 0700 /root/.ssh",
      `printf '%s\\n' ${shellQuote(normalizedPublicKey)} > /root/.ssh/authorized_keys`,
      "chmod 0600 /root/.ssh/authorized_keys",
      "systemctl daemon-reload >/dev/null 2>&1 || true",
      "systemctl reset-failed ssh >/dev/null 2>&1 || true",
      "(systemctl restart ssh || systemctl restart sshd) >/dev/null 2>&1 || true"
    ].join("; ");
    await this.runPctExec(vmid, shell);
  }

  private async runPctExec(vmid: number, shell: string): Promise<void> {
    this.assertGuestSetupAvailable();
    const target = this.hostSshTarget!;
    const sshArgs = [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${this.hostSshConnectTimeoutSec}`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      String(this.hostSshPort)
    ];
    if (this.hostSshKeyPath) {
      sshArgs.push("-i", this.hostSshKeyPath);
    }
    const remoteCommand = `pct exec ${vmid} -- bash -lc ${shellQuote(shell)}`;
    await this.execFile("ssh", [...sshArgs, target, remoteCommand], {
      timeout: this.hostCommandTimeoutMs,
      maxBuffer: 64 * 1024
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? sanitizeErrorDetail(error.message) : "unknown pct exec failure";
      throw new ProxmoxAdapterError("proxmox_guest_setup_failed", {
        recoverable: true,
        metadata: { vmid, detail: detail.slice(0, 400) }
      });
    });
  }

  private get fetchImpl(): typeof fetch {
    return this.injectedFetch ?? globalThis.fetch;
  }

  private assertReadable(): void {
    if (!this.isLive()) {
      throw new ProxmoxAdapterError("proxmox_credentials_missing");
    }
  }

  private assertWritable(): void {
    if (!this.canWrite()) {
      throw new ProxmoxAdapterError("proxmox_credentials_missing");
    }
  }

  private assertGuestSetupAvailable(): void {
    if (!this.hostSshTarget) {
      throw new ProxmoxAdapterError("proxmox_guest_setup_not_configured", {
        metadata: {
          operatorAction:
            "set PROXMOX_HOST_SSH_TARGET so the adapter can run pct exec for identity reset and SSH key injection"
        }
      });
    }
  }

  private assertNetworkConfigAvailable(): void {
    if (!this.ipPool && !this.testNet0) {
      throw new ProxmoxAdapterError("proxmox_network_config_missing", {
        metadata: {
          operatorAction:
            "set PROXMOX_IP_POOL for production or PROXMOX_TEST_NET0 for lifecycle smoke before creating Proxmox LXCs"
        }
      });
    }
  }

  private async bestEffortDestroy(vmid: number): Promise<void> {
    try {
      const upid = await this.proxmoxRequestText("DELETE", `/nodes/${encodeURIComponent(this.node)}/lxc/${vmid}`, {
        purge: "1",
        destroyUnreferencedDisks: "1"
      });
      if (upid) {
        await this.waitTask(upid);
      }
      this.invalidateInventoryCache();
    } catch {
      return;
    }
  }

  private sourceMetadata(
    now: Date,
    responseOk: boolean,
    errorMessage?: string
  ): WebdockInventorySource {
    return {
      kind: "live",
      apiBase: this.apiUrl ?? "proxmox",
      accountId: this.accountId,
      accountLabel: this.accountLabel,
      fetchedAt: now.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {})
    };
  }

  private cacheInventory(now: Date, result: WebdockInventoryResult): void {
    if (this.cacheTtlMs <= 0) return;
    this.inventoryCache = {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result
    };
  }

  private invalidateInventoryCache(): void {
    this.inventoryCache = null;
  }
}

export function createProxmoxAdaptersFromEnv(
  env: Record<string, string | undefined> =
    typeof process !== "undefined" ? process.env : {}
): VpsProviderEntry[] {
  const apiUrl = normalizeEnvValue(env.PROXMOX_API_URL);
  const tokenId = normalizeEnvValue(env.PROXMOX_TOKEN_ID);
  const tokenSecret = normalizeEnvValue(env.PROXMOX_TOKEN_SECRET);
  if (!apiUrl || !tokenId || !tokenSecret) {
    return [];
  }
  const accountId = normalizeEnvValue(env.PROXMOX_ACCOUNT_ID) ?? DEFAULT_ACCOUNT_ID;
  const label = normalizeEnvValue(env.PROXMOX_ACCOUNT_LABEL) ?? DEFAULT_ACCOUNT_LABEL;
  const adapter = new ProxmoxRealAdapter({
    apiUrl,
    tokenId,
    tokenSecret,
    node: normalizeEnvValue(env.PROXMOX_NODE) ?? DEFAULT_NODE,
    templateVmid: parseIntegerEnv(env.PROXMOX_TEMPLATE_VMID) ?? DEFAULT_TEMPLATE_VMID,
    storage: normalizeEnvValue(env.PROXMOX_STORAGE) ?? DEFAULT_STORAGE,
    bridge: normalizeEnvValue(env.PROXMOX_BRIDGE) ?? DEFAULT_BRIDGE,
    ipPool: normalizeEnvValue(env.PROXMOX_IP_POOL),
    testNet0: normalizeEnvValue(env.PROXMOX_TEST_NET0),
    accountId,
    accountLabel: label,
    hostSshTarget: normalizeEnvValue(env.PROXMOX_HOST_SSH_TARGET),
    hostSshKeyPath: normalizeEnvValue(env.PROXMOX_HOST_SSH_KEY_PATH),
    hostSshPort: parseIntegerEnv(env.PROXMOX_HOST_SSH_PORT),
    hostSshConnectTimeoutSec: parseIntegerEnv(env.PROXMOX_HOST_SSH_CONNECT_TIMEOUT_SEC),
    hostCommandTimeoutMs: parseIntegerEnv(env.PROXMOX_HOST_COMMAND_TIMEOUT_MS),
    caCertPem: normalizeEnvValue(env.PROXMOX_CA_CERT_PEM),
    caCertPath: normalizeEnvValue(env.PROXMOX_CA_CERT_PATH)
  });
  return [{ id: DEFAULT_ACCOUNT_ID, label, adapter }];
}

function classifyProxmoxHttpFailure(
  status: number,
  body: string,
  metadata: Record<string, unknown>
): ProxmoxAdapterError {
  return new ProxmoxAdapterError("proxmox_api_error", {
    status,
    recoverable: status === 429 || status >= 500,
    metadata: {
      ...metadata,
      body: sanitizeErrorDetail(body).slice(0, 600)
    }
  });
}

function proxmoxErrorReason(error: unknown): string {
  if (error instanceof ProxmoxAdapterError) return error.code;
  return error instanceof Error ? sanitizeErrorDetail(error.message) : "proxmox_unknown_error";
}

function proxmoxData(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "data" in raw) {
    return (raw as Record<string, unknown>).data;
  }
  return raw;
}

function proxmoxDataArray(raw: unknown): Array<Record<string, unknown>> {
  const data = proxmoxData(raw);
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item))
  );
}

function resourceObject(raw: unknown): Record<string, unknown> | undefined {
  const data = proxmoxData(raw);
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function toServerSlug(vmid: number): string {
  return `proxmox-${vmid}`;
}

function fromServerSlug(slug: string): number {
  const trimmed = slug.trim().toLowerCase();
  const raw = trimmed.startsWith("proxmox-") ? trimmed.slice("proxmox-".length) : trimmed;
  const vmid = Number(raw);
  if (!Number.isInteger(vmid) || vmid <= 0) {
    throw new ProxmoxAdapterError("proxmox_invalid_server_slug", {
      metadata: { slug }
    });
  }
  return vmid;
}

function mapProxmoxStatus(status: string | undefined): WebdockServerStatus {
  switch ((status ?? "").toLowerCase()) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "paused":
      return "suspended";
    default:
      return status && status.length > 0 ? status : "provisioning";
  }
}

function parseCreationDate(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = description.match(/(?:^|\s)delivrix-created=([0-9T:.\-+Z]+)/);
  if (!match) return undefined;
  const value = match[1];
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseIpPool(value: string | undefined): ProxmoxIpPoolConfig | undefined {
  const trimmed = normalizeEnvValue(value);
  if (!trimmed) return undefined;
  const fields = new Map<string, string>();
  for (const piece of trimmed.split(";")) {
    const [key, ...rest] = piece.split("=");
    if (!key || rest.length === 0) continue;
    fields.set(key.trim().toLowerCase(), rest.join("=").trim());
  }
  const gw = fields.get("gw") ?? fields.get("gateway");
  const cidr = Number(fields.get("cidr"));
  const range = fields.get("range");
  const [start, end] = range?.split("-").map((part) => part.trim()) ?? [];
  if (!gw || !isIpv4(gw) || !Number.isInteger(cidr) || cidr < 1 || cidr > 32 || !start || !end || !isIpv4(start) || !isIpv4(end)) {
    throw new ProxmoxAdapterError("proxmox_invalid_ip_pool", {
      metadata: { valuePreview: trimmed.slice(0, 120) }
    });
  }
  return { gateway: gw, cidr, rangeStart: start, rangeEnd: end };
}

function firstAvailableIpv4(pool: ProxmoxIpPoolConfig, used: Set<string>): string | null {
  const start = ipv4ToInt(pool.rangeStart);
  const end = ipv4ToInt(pool.rangeEnd);
  if (start > end) return null;
  for (let cursor = start; cursor <= end; cursor += 1) {
    const ip = intToIpv4(cursor);
    if (!used.has(ip)) return ip;
  }
  return null;
}

function ipv4FromNet0(net0: string): string | null {
  const match = net0.match(/(?:^|,)ip=([0-9]{1,3}(?:\.[0-9]{1,3}){3})(?:\/[0-9]{1,2})?(?:,|$)/);
  return match && isIpv4(match[1]) ? normalizeIpv4(match[1]) : null;
}

function ipv4ToInt(value: string): number {
  return normalizeIpv4(value).split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join(".");
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function normalizeIpv4(value: string): string {
  if (!isIpv4(value)) {
    throw new ProxmoxAdapterError("proxmox_invalid_ipv4", {
      metadata: { valuePreview: value.slice(0, 40) }
    });
  }
  return value.split(".").map((part) => String(Number(part))).join(".");
}

function normalizeApiUrl(value: string | undefined): string | undefined {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return undefined;
  return normalized.replace(/\/+$/, "");
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeNonNegativeMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function parseIntegerEnv(value: string | undefined): number | undefined {
  const normalized = normalizeEnvValue(value);
  if (!normalized || !/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeHostname(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 253 ||
    !normalized.split(".").every((label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    throw new ProxmoxAdapterError("proxmox_invalid_hostname", {
      metadata: { valuePreview: normalized.slice(0, 120) }
    });
  }
  return normalized;
}

function normalizePublicKey(value: string): string {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/.test(
      normalized
    )
  ) {
    throw new ProxmoxAdapterError("proxmox_invalid_public_key", {
      metadata: { valuePreview: normalized.slice(0, 40) }
    });
  }
  return normalized;
}

function publicKeyFingerprintNumber(publicKey: string): number {
  let hash = 2166136261;
  for (let i = 0; i < publicKey.length; i += 1) {
    hash ^= publicKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function stringField(
  obj: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
  obj: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function sanitizeErrorDetail(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function loadCaCertPem(caCertPem: string | undefined, caCertPath: string | undefined): string | undefined {
  const inline = normalizeEnvValue(caCertPem);
  if (inline) return inline;
  const path = normalizeEnvValue(caCertPath);
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new ProxmoxAdapterError("proxmox_ca_cert_read_failed", {
      metadata: {
        path,
        detail: error instanceof Error ? sanitizeErrorDetail(error.message) : "unknown read failure"
      }
    });
  }
}

async function nodeHttpFetch(url: string, init: RequestInit, caCertPem: string): Promise<Response> {
  const parsed = new URL(url);
  const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = headersRecord(init.headers);
  const body = typeof init.body === "string" || init.body instanceof Buffer ? init.body : undefined;
  return await new Promise<Response>((resolve, reject) => {
    const request = requestFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? "GET",
        headers,
        ...(parsed.protocol === "https:" ? { ca: caCertPem, rejectUnauthorized: true } : {})
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 0,
            headers: responseHeaders(response.headers)
          }));
        });
      }
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key] = String(value);
  return out;
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): HeadersInit {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out[key] = value.join(", ");
    else if (typeof value === "string") out[key] = value;
  }
  return out;
}

function truncateRaw(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 600);
  } catch {
    return "[unserializable]";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
