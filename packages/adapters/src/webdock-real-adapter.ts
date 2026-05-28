import { createHash, randomBytes } from "node:crypto";

/**
 * WebdockRealAdapter — cliente HTTP contra la API real de Webdock
 * (https://api.webdock.io/v1).
 *
 * Hito 5.11.A. Reemplaza progresivamente los mocks del Canvas con datos
 * vivos del proveedor. Las lecturas usan `WEBDOCK_API_KEY_PRIMARY`; las
 * escrituras usan `WEBDOCK_API_KEY_OPS`; el bundle frontend sigue GET-only y
 * las mutaciones pasan por rutas gated.
 *
 * Fallback: si `WEBDOCK_API_KEY_PRIMARY`/`WEBDOCK_API_KEY` no está presente
 * en el entorno, las lecturas devuelven un snapshot mock canónico para que el
 * panel siga funcionando en desarrollo sin necesidad de tocar la cuenta real.
 * Las escrituras no usan fallback legacy: requieren `WEBDOCK_API_KEY_OPS`.
 *
 * Cache: TTL de 60s en memoria para no quemar rate-limit del proveedor.
 */

export type WebdockServerStatus =
  | "running"
  | "stopped"
  | "suspended"
  | "provisioning"
  | "reinstalling"
  | "rebooting"
  | "deleting"
  | "error"
  | string;

export interface WebdockServer {
  /** Identificador estable que Webdock usa para todas sus rutas. */
  slug: string;
  /** Nombre display configurado por el operador. */
  name: string;
  /** IP pública v4. Puede estar vacía si el server está siendo provisionado. */
  ipv4: string;
  /** IP pública v6 cuando existe. */
  ipv6?: string;
  status: WebdockServerStatus;
  /** Slug del perfil de plan (CPU/RAM/Storage). */
  profileSlug?: string;
  /** Datacenter location (ej: "fi-hel-2"). */
  location?: string;
  /** ISO timestamp de creación. */
  creationDate?: string;
  /** ISO timestamp de la última modificación visible al cliente. */
  lastDataReceived?: string;
  /** Versión del SO instalado. */
  imageSlug?: string;
  /** Notas que el operador puso en Webdock UI. */
  description?: string;
  /** Si esta IP está marcada como suspendida (no factura ni envía). */
  webRoot?: string;
  /** Snapshot count del server según el proveedor. */
  snapshotRunTime?: number;
  /** Cuenta Webdock de origen. No contiene secretos. */
  accountId?: string;
  /** Etiqueta operativa visible para el panel. */
  accountLabel?: string;
}

export interface WebdockInventorySource {
  kind: "live" | "mock";
  apiBase: string;
  accountId?: string;
  accountLabel?: string;
  fetchedAt: string;
  /** Cuando `kind === "live"`, indica si la API respondió 200. False = degraded. */
  responseOk: boolean;
  errorMessage?: string;
}

export interface WebdockInventoryResult {
  servers: WebdockServer[];
  source: WebdockInventorySource;
}

export type WebdockProvisionProfile = "bit" | "nibble" | "byte" | "kilobyte";
export type WebdockProvisionImageSlug = "ubuntu-2404" | "debian-12";

export interface WebdockCreateServerInput {
  profile: WebdockProvisionProfile;
  locationId: string;
  hostname: string;
  imageSlug: WebdockProvisionImageSlug;
  publicKey: string;
  sshUsername?: string;
  callbackUrl?: string;
}

export interface WebdockCreateServerResult {
  serverSlug: string;
  eventId: string;
  ipv4: string | null;
  status: WebdockServerStatus;
  publicKeyId?: number;
  source: WebdockInventorySource;
}

export interface WebdockEnsureSshAccessResult {
  publicKeyId: number;
  username: string;
  shellUserId: number | null;
  shellUserEventId: string | null;
  sshSettingsEventId: string | null;
}

export interface WebdockDeleteServerResult {
  serverSlug: string;
  eventId: string;
  status: WebdockServerStatus;
  source: WebdockInventorySource;
}

const DEFAULT_API_BASE = "https://api.webdock.io/v1";
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  result: WebdockInventoryResult;
}

export interface WebdockRealAdapterOptions {
  /** Key legacy del proveedor. Compat: solo fallback para lecturas. */
  apiKey?: string;
  /** Key read-only para inventario. Si no se pasa, se lee de env. */
  readApiKey?: string;
  /** Key con permisos de write para createServer. Si no se pasa, se lee de env. */
  writeApiKey?: string;
  /** Key con permisos de account write para registrar SSH public keys. */
  accountApiKey?: string;
  /** Base URL para tests. Default https://api.webdock.io/v1. */
  apiBase?: string;
  /** Alias operativo de apiBase usado por algunas specs OPS. */
  baseUrl?: string;
  /** Identificador interno de la cuenta, ej: primary. */
  accountId?: string;
  /** Etiqueta humana de la cuenta, ej: Webdock Primary. */
  accountLabel?: string;
  /** Entorno inyectable para tests. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Cache TTL en milisegundos. Default 60_000. */
  cacheTtlMs?: number;
  /** Fetch impl para tests (default global fetch). */
  fetchImpl?: typeof fetch;
  /** Override del proveedor de timestamps (para tests). */
  now?: () => Date;
}

export interface WebdockAccountAdapterEntry {
  id: string;
  label: string;
  adapter: WebdockRealAdapter;
}

export interface CreateWebdockAdaptersFromEnvOptions
  extends Omit<
    WebdockRealAdapterOptions,
    "apiKey" | "accountId" | "accountLabel" | "env"
  > {
  env?: Record<string, string | undefined>;
}

export class WebdockRealAdapter {
  private readonly readApiKey: string | undefined;
  private readonly writeApiKey: string | undefined;
  private readonly accountApiKey: string | undefined;
  private readonly apiBase: string;
  private readonly accountId: string;
  private readonly accountLabel: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cache: CacheEntry | null = null;

  constructor(options: WebdockRealAdapterOptions = {}) {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    const legacyApiKey =
      normalizeEnvValue(options.apiKey) ?? normalizeEnvValue(env?.WEBDOCK_API_KEY);
    this.readApiKey =
      normalizeEnvValue(options.readApiKey) ??
      normalizeEnvValue(env?.WEBDOCK_API_KEY_PRIMARY) ??
      legacyApiKey;
    this.writeApiKey =
      normalizeEnvValue(options.writeApiKey) ??
      normalizeEnvValue(env?.WEBDOCK_API_KEY_OPS);
    this.accountApiKey =
      normalizeEnvValue(options.accountApiKey) ??
      normalizeEnvValue(env?.WEBDOCK_API_KEY_ACCOUNT);
    this.apiBase = options.apiBase ?? options.baseUrl ?? DEFAULT_API_BASE;
    this.accountId = normalizeEnvValue(options.accountId) ?? "default";
    this.accountLabel = normalizeEnvValue(options.accountLabel) ?? "Webdock";
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  isLive(): boolean {
    return Boolean(this.readApiKey);
  }

  canWrite(): boolean {
    return Boolean(this.writeApiKey);
  }

  canCreate(): boolean {
    return Boolean(this.writeApiKey && this.accountApiKey);
  }

  /**
   * Devuelve el inventario de servers. Cuando hay key, llama a la API real
   * con TTL cache. Cuando no hay key o la API falla, devuelve un mock
   * canónico que mantiene el panel utilizable en dev.
   */
  async listServers(): Promise<WebdockInventoryResult> {
    const now = this.now();

    // Cache hit fresh.
    if (this.cache && this.cache.expiresAt > now.getTime()) {
      return this.cache.result;
    }

    const readApiKey = this.readApiKey;
    if (!readApiKey) {
      const result: WebdockInventoryResult = {
        servers: this.withAccount(mockWebdockServers()),
        source: this.sourceMetadata(now, "mock", true)
      };
      this.cacheResult(now, result);
      return result;
    }

    try {
      const response = await this.fetchImpl(`${this.apiBase}/servers`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${readApiKey}`,
          accept: "application/json",
          "user-agent": "Delivrix-MailOps/0.1 (webdock-collector)"
        }
      });

      if (!response.ok) {
        const errorMessage = `Webdock API returned ${response.status} ${response.statusText}`;
        const result: WebdockInventoryResult = {
          servers: this.withAccount(mockWebdockServers()),
          source: this.sourceMetadata(now, "mock", false, errorMessage)
        };
        this.cacheResult(now, result);
        return result;
      }

      const raw = (await response.json()) as unknown;
      const servers = this.withAccount(parseWebdockServers(raw));
      const result: WebdockInventoryResult = {
        servers,
        source: this.sourceMetadata(now, "live", true)
      };
      this.cacheResult(now, result);
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown Webdock fetch error";
      const result: WebdockInventoryResult = {
        servers: this.withAccount(mockWebdockServers()),
        source: this.sourceMetadata(now, "mock", false, errorMessage)
      };
      this.cacheResult(now, result);
      return result;
    }
  }

  async createServer(opts: WebdockCreateServerInput): Promise<WebdockCreateServerResult> {
    if (!this.writeApiKey) {
      throw new Error("WEBDOCK_API_KEY_OPS is required for Webdock writes.");
    }
    if (!this.accountApiKey) {
      throw new Error("WEBDOCK_API_KEY_ACCOUNT is required to register Webdock SSH keys.");
    }

    const now = this.now();
    const publicKey = normalizePublicKey(opts.publicKey);
    const publicKeyId = await this.ensureAccountPublicKey(publicKey);
    const payload = {
      name: opts.hostname,
      locationId: opts.locationId,
      profileSlug: resolveProfileSlug(opts.profile),
      imageSlug: resolveImageSlug(opts.imageSlug),
      publicKeys: [publicKeyId],
      ...(opts.callbackUrl ? { callbackUrl: opts.callbackUrl } : {})
    };

    const response = await this.fetchImpl(`${this.apiBase}/servers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.writeApiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "Delivrix-MailOps/0.1 (webdock-provisioner)"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Webdock API returned ${response.status} ${response.statusText}`);
    }

    const raw = (await response.json()) as unknown;
    const server = parseCreatedServer(raw);
    const eventId =
      response.headers.get("x-callback-id") ??
      response.headers.get("x_callback_id") ??
      stringFieldFromUnknown(raw, "callbackId") ??
      stringFieldFromUnknown(raw, "CallbackID") ??
      stringFieldFromUnknown(raw, "callbackID") ??
      server.slug;

    this.invalidateCache();
    return {
      serverSlug: server.slug,
      eventId,
      ipv4: server.ipv4 || null,
      status: server.status,
      publicKeyId,
      source: this.sourceMetadata(now, "live", true)
    };
  }

  async ensureServerSshAccess(input: {
    serverSlug: string;
    publicKey: string;
    username?: string;
  }): Promise<WebdockEnsureSshAccessResult> {
    if (!this.writeApiKey) {
      throw new Error("WEBDOCK_API_KEY_OPS is required for Webdock writes.");
    }
    if (!this.accountApiKey) {
      throw new Error("WEBDOCK_API_KEY_ACCOUNT is required to register Webdock SSH keys.");
    }

    const serverSlug = normalizeServerSlug(input.serverSlug);
    const username = normalizeShellUsername(input.username ?? "delivrixops");
    const publicKeyId = await this.ensureAccountPublicKey(normalizePublicKey(input.publicKey));
    const existing = await this.findShellUser(serverSlug, username);
    let shellUserId = existing?.id ?? null;
    let shellUserEventId: string | null = null;

    if (existing) {
      const hasKey = existing.publicKeyIds.includes(publicKeyId);
      if (!hasKey) {
        const response = await this.fetchImpl(
          `${this.apiBase}/servers/${encodeURIComponent(serverSlug)}/shellUsers/${existing.id}`,
          {
            method: "PATCH",
            headers: this.jsonHeaders(this.writeApiKey, "Delivrix-MailOps/0.1 (webdock-provisioner)"),
            body: JSON.stringify({ publicKeys: uniqueNumbers([...existing.publicKeyIds, publicKeyId]) })
          }
        );
        if (!response.ok) {
          throw new Error(`Webdock API returned ${response.status} ${response.statusText} while assigning SSH key.`);
        }
        shellUserEventId = callbackId(response, {}) ?? null;
      }
    } else {
      const response = await this.fetchImpl(
        `${this.apiBase}/servers/${encodeURIComponent(serverSlug)}/shellUsers`,
        {
          method: "POST",
          headers: this.jsonHeaders(this.writeApiKey, "Delivrix-MailOps/0.1 (webdock-provisioner)"),
          body: JSON.stringify({
            username,
            password: randomShellPassword(),
            group: "sudo",
            shell: "/bin/bash",
            publicKeys: [publicKeyId]
          })
        }
      );
      const body = response.status === 204 ? "" : await response.text();
      const raw = parseJsonObject(body);
      if (!response.ok) {
        throw new Error(`Webdock API returned ${response.status} ${response.statusText} while creating SSH user.`);
      }
      shellUserId = numberFieldFromUnknown(raw, "id") ?? null;
      shellUserEventId = callbackId(response, raw) ?? null;
    }

    const sshSettingsResponse = await this.fetchImpl(
      `${this.apiBase}/servers/${encodeURIComponent(serverSlug)}/sshSettings`,
      {
        method: "POST",
        headers: this.jsonHeaders(this.writeApiKey, "Delivrix-MailOps/0.1 (webdock-provisioner)"),
        body: JSON.stringify({
          passwordSshAuthEnabled: false,
          passwordlessSudoEnabled: true,
          sshPort: 22
        })
      }
    );
    const sshSettingsBody = sshSettingsResponse.status === 204 ? "" : await sshSettingsResponse.text();
    const sshSettingsRaw = parseJsonObject(sshSettingsBody);
    if (!sshSettingsResponse.ok) {
      throw new Error(`Webdock API returned ${sshSettingsResponse.status} ${sshSettingsResponse.statusText} while enabling SSH settings.`);
    }

    return {
      publicKeyId,
      username,
      shellUserId,
      shellUserEventId,
      sshSettingsEventId: callbackId(sshSettingsResponse, sshSettingsRaw) ?? null
    };
  }

  async deleteServer(slug: string): Promise<WebdockDeleteServerResult> {
    if (!this.writeApiKey) {
      throw new Error("WEBDOCK_API_KEY_OPS is required for Webdock writes.");
    }

    const now = this.now();
    const serverSlug = normalizeServerSlug(slug);
    const response = await this.fetchImpl(`${this.apiBase}/servers/${encodeURIComponent(serverSlug)}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${this.writeApiKey}`,
        accept: "application/json",
        "user-agent": "Delivrix-MailOps/0.1 (webdock-provisioner)"
      }
    });
    const body = response.status === 204 ? "" : await response.text();

    if (!response.ok) {
      throw new Error(`Webdock API returned ${response.status} ${response.statusText}`);
    }

    const raw = parseJsonObject(body);
    const eventId =
      response.headers.get("x-callback-id") ??
      response.headers.get("x_callback_id") ??
      stringFieldFromUnknown(raw, "callbackId") ??
      stringFieldFromUnknown(raw, "CallbackID") ??
      stringFieldFromUnknown(raw, "callbackID") ??
      serverSlug;

    this.invalidateCache();
    return {
      serverSlug,
      eventId,
      status: "deleting",
      source: this.sourceMetadata(now, "live", true)
    };
  }

  async getServer(slug: string): Promise<WebdockServer> {
    const readApiKey = this.readApiKey;
    if (!readApiKey) {
      const server = this.withAccount(mockWebdockServers()).find((item) => item.slug === slug);
      if (!server) {
        throw new Error(`Webdock mock server not found: ${slug}`);
      }
      return server;
    }

    const response = await this.fetchImpl(`${this.apiBase}/servers/${encodeURIComponent(slug)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${readApiKey}`,
        accept: "application/json",
        "user-agent": "Delivrix-MailOps/0.1 (webdock-provisioner)"
      }
    });

    if (!response.ok) {
      throw new Error(`Webdock API returned ${response.status} ${response.statusText}`);
    }

    return this.withAccount([parseCreatedServer((await response.json()) as unknown)])[0];
  }

  /** Permite borrar la cache desde tests o tras un kill-switch event. */
  invalidateCache(): void {
    this.cache = null;
  }

  private cacheResult(now: Date, result: WebdockInventoryResult): void {
    this.cache = {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result
    };
  }

  private sourceMetadata(
    now: Date,
    kind: WebdockInventorySource["kind"],
    responseOk: boolean,
    errorMessage?: string
  ): WebdockInventorySource {
    return {
      kind,
      apiBase: this.apiBase,
      accountId: this.accountId,
      accountLabel: this.accountLabel,
      fetchedAt: now.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {})
    };
  }

  private withAccount(servers: WebdockServer[]): WebdockServer[] {
    return servers.map((server) => ({
      ...server,
      accountId: this.accountId,
      accountLabel: this.accountLabel
    }));
  }

  private async ensureAccountPublicKey(publicKey: string): Promise<number> {
    const existing = await this.findAccountPublicKey(publicKey);
    if (existing) {
      return existing.id;
    }

    const response = await this.fetchImpl(`${this.apiBase}/account/publicKeys`, {
      method: "POST",
      headers: this.jsonHeaders(this.accountApiKey, "Delivrix-MailOps/0.1 (webdock-account-keys)"),
      body: JSON.stringify({
        name: `delivrix-ops-${publicKeyFingerprint(publicKey)}`,
        publicKey
      })
    });
    const body = response.status === 204 ? "" : await response.text();
    const raw = parseJsonObject(body);
    if (!response.ok) {
      const afterConflict = response.status === 400 ? await this.findAccountPublicKey(publicKey) : null;
      if (afterConflict) {
        return afterConflict.id;
      }
      throw new Error(`Webdock API returned ${response.status} ${response.statusText} while registering SSH public key.`);
    }
    const id = numberFieldFromUnknown(raw, "id");
    if (id === undefined) {
      throw new Error("Webdock public key response did not include id.");
    }
    return id;
  }

  private async findAccountPublicKey(publicKey: string): Promise<{ id: number } | null> {
    const response = await this.fetchImpl(`${this.apiBase}/account/publicKeys`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.accountApiKey}`,
        accept: "application/json",
        "user-agent": "Delivrix-MailOps/0.1 (webdock-account-keys)"
      }
    });
    if (!response.ok) {
      throw new Error(`Webdock API returned ${response.status} ${response.statusText} while listing SSH public keys.`);
    }
    const keys = parsePublicKeys((await response.json()) as unknown);
    return keys.find((key) => key.key === publicKey) ?? null;
  }

  private async findShellUser(
    serverSlug: string,
    username: string
  ): Promise<{ id: number; publicKeyIds: number[] } | null> {
    const response = await this.fetchImpl(
      `${this.apiBase}/servers/${encodeURIComponent(serverSlug)}/shellUsers`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.writeApiKey}`,
          accept: "application/json",
          "user-agent": "Delivrix-MailOps/0.1 (webdock-provisioner)"
        }
      }
    );
    if (!response.ok) {
      throw new Error(`Webdock API returned ${response.status} ${response.statusText} while listing SSH users.`);
    }
    return parseShellUsers((await response.json()) as unknown)
      .find((user) => user.username === username) ?? null;
  }

  private jsonHeaders(apiKey: string | undefined, userAgent: string): Record<string, string> {
    if (!apiKey) {
      throw new Error("Webdock API key is required for this operation.");
    }
    return {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": userAgent
    };
  }
}

export function createWebdockAdaptersFromEnv(
  env: Record<string, string | undefined> =
    typeof process !== "undefined" ? process.env : {},
  options: CreateWebdockAdaptersFromEnvOptions = {}
): WebdockAccountAdapterEntry[] {
  const accountSpecs = [
    {
      id: "primary",
      apiKey: normalizeEnvValue(env.WEBDOCK_API_KEY_PRIMARY),
      label: normalizeEnvValue(env.WEBDOCK_ACCOUNT_PRIMARY_LABEL) ?? "Webdock Primary"
    },
    {
      id: "secondary",
      apiKey: normalizeEnvValue(env.WEBDOCK_API_KEY_SECONDARY),
      label:
        normalizeEnvValue(env.WEBDOCK_ACCOUNT_SECONDARY_LABEL) ?? "Webdock Secondary"
    },
    {
      id: "tertiary",
      apiKey: normalizeEnvValue(env.WEBDOCK_API_KEY_TERTIARY),
      label: normalizeEnvValue(env.WEBDOCK_ACCOUNT_TERTIARY_LABEL) ?? "Webdock Tertiary"
    }
  ];

  const configuredAccounts = accountSpecs
    .filter((account) => account.apiKey)
    .map((account) =>
      buildAccountAdapterEntry(account.id, account.label, account.apiKey, env, options)
    );

  if (configuredAccounts.length > 0) {
    return configuredAccounts;
  }

  const legacyApiKey = normalizeEnvValue(env.WEBDOCK_API_KEY);
  const legacyLabel = normalizeEnvValue(env.WEBDOCK_ACCOUNT_DEFAULT_LABEL) ?? "Webdock";
  return [buildAccountAdapterEntry("default", legacyLabel, legacyApiKey, env, options)];
}

function buildAccountAdapterEntry(
  id: string,
  label: string,
  apiKey: string | undefined,
  env: Record<string, string | undefined>,
  options: CreateWebdockAdaptersFromEnvOptions
): WebdockAccountAdapterEntry {
  return {
    id,
    label,
    adapter: new WebdockRealAdapter({
      ...options,
      env,
      readApiKey: apiKey,
      accountApiKey: normalizeEnvValue(env.WEBDOCK_API_KEY_ACCOUNT),
      accountId: id,
      accountLabel: label
    })
  };
}

/**
 * Parser defensivo: Webdock devuelve arrays con muchos más campos que los
 * que necesitamos. Nos quedamos con los campos canónicos y normalizamos.
 */
function parseWebdockServers(raw: unknown): WebdockServer[] {
  if (!Array.isArray(raw)) return [];
  const out: WebdockServer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const slug = stringField(obj, "slug");
    const name = stringField(obj, "name") ?? slug ?? "unknown";
    if (!slug) continue;
    out.push({
      slug,
      name,
      ipv4: stringField(obj, "ipv4") ?? "",
      ipv6: stringField(obj, "ipv6"),
      status: (stringField(obj, "status") ?? "unknown") as WebdockServerStatus,
      profileSlug: stringField(obj, "profileSlug"),
      location: stringField(obj, "location"),
      creationDate: stringField(obj, "creationDate"),
      lastDataReceived: stringField(obj, "lastDataReceived"),
      imageSlug: stringField(obj, "imageSlug"),
      description: stringField(obj, "description"),
      webRoot: stringField(obj, "webRoot"),
      snapshotRunTime: numberField(obj, "snapshotRunTime")
    });
  }
  return out;
}

function parseCreatedServer(raw: unknown): WebdockServer {
  const candidate =
    raw && typeof raw === "object" && "server" in raw && (raw as Record<string, unknown>).server
      ? (raw as Record<string, unknown>).server
      : raw;

  if (!candidate || typeof candidate !== "object") {
    throw new Error("Webdock response did not include a server object.");
  }

  const obj = candidate as Record<string, unknown>;
  const slug = stringField(obj, "slug");
  if (!slug) {
    throw new Error("Webdock response did not include server slug.");
  }

  return {
    slug,
    name: stringField(obj, "name") ?? slug,
    ipv4: stringField(obj, "ipv4") ?? "",
    ipv6: stringField(obj, "ipv6"),
    status: (stringField(obj, "status") ?? "provisioning") as WebdockServerStatus,
    profileSlug: stringField(obj, "profileSlug") ?? stringField(obj, "profile"),
    location: stringField(obj, "location"),
    creationDate: stringField(obj, "creationDate") ?? stringField(obj, "date"),
    lastDataReceived: stringField(obj, "lastDataReceived"),
    imageSlug: stringField(obj, "imageSlug") ?? stringField(obj, "image"),
    description: stringField(obj, "description"),
    webRoot: stringField(obj, "webRoot"),
    snapshotRunTime: numberField(obj, "snapshotRunTime")
  };
}

function parsePublicKeys(raw: unknown): Array<{ id: number; key: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: number; key: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = numberField(item as Record<string, unknown>, "id");
    const key = normalizeOptionalPublicKey(stringField(item as Record<string, unknown>, "key"));
    if (id === undefined || !key) continue;
    out.push({ id, key });
  }
  return out;
}

function parseShellUsers(raw: unknown): Array<{
  id: number;
  username: string;
  publicKeyIds: number[];
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: number; username: string; publicKeyIds: number[] }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = numberField(obj, "id");
    const username = stringField(obj, "username");
    if (id === undefined || !username) continue;
    const publicKeys = Array.isArray(obj.publicKeys) ? obj.publicKeys : [];
    const publicKeyIds = publicKeys
      .map((key) => key && typeof key === "object" ? numberField(key as Record<string, unknown>, "id") : undefined)
      .filter((value): value is number => value !== undefined);
    out.push({ id, username, publicKeyIds });
  }
  return out;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringFieldFromUnknown(raw: unknown, key: string): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return stringField(raw as Record<string, unknown>, key);
}

function numberFieldFromUnknown(raw: unknown, key: string): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return numberField(raw as Record<string, unknown>, key);
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonObject(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function normalizeServerSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(normalized)) {
    throw new Error(`Invalid Webdock server slug: ${value}`);
  }
  return normalized;
}

function normalizeShellUsername(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(normalized)) {
    throw new Error(`Invalid Webdock shell username: ${value}`);
  }
  if (normalized === "root") {
    throw new Error("Webdock shell username root is reserved.");
  }
  return normalized;
}

function normalizePublicKey(value: string): string {
  const normalized = normalizeOptionalPublicKey(value);
  if (!normalized) {
    throw new Error("Webdock SSH public key is required.");
  }
  return normalized;
}

function normalizeOptionalPublicKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/.test(normalized)
    ? normalized
    : undefined;
}

function publicKeyFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 16);
}

function randomShellPassword(): string {
  return `Dx_${randomBytes(18).toString("base64url")}`;
}

function callbackId(response: Response, raw: unknown): string | undefined {
  return response.headers.get("x-callback-id") ??
    response.headers.get("x_callback_id") ??
    stringFieldFromUnknown(raw, "callbackId") ??
    stringFieldFromUnknown(raw, "CallbackID") ??
    stringFieldFromUnknown(raw, "callbackID");
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function resolveProfileSlug(profile: WebdockProvisionProfile): string {
  const map: Record<WebdockProvisionProfile, string> = {
    bit: "vps-xeon-essential-2025",
    nibble: "vps-epyc-advanced-2025",
    byte: "vps-epyc-pro-2025",
    kilobyte: "wp-pro-2026"
  };
  return map[profile];
}

function resolveImageSlug(imageSlug: WebdockProvisionImageSlug): string {
  const map: Record<WebdockProvisionImageSlug, string> = {
    "ubuntu-2404": "webdock-ubuntu-noble-cloud",
    "debian-12": "webdock-debian-bookworm-cloud"
  };
  return map[imageSlug];
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Mock canónico del MVP. Refleja el shape de la API real con dos servidores
 * representativos (uno warming, uno producción) para que el Canvas y la
 * sección Clústeres no se queden en blanco cuando no hay env var.
 */
export function mockWebdockServers(): WebdockServer[] {
  return [
    {
      slug: "svc-warmup-01",
      name: "svc-warmup-01",
      ipv4: "185.243.12.31",
      ipv6: "2a06:a004:f00d::31",
      status: "running",
      profileSlug: "vps-xeon-essential-2025",
      location: "dk",
      creationDate: "2026-05-02T14:18:00.000Z",
      lastDataReceived: "2026-05-17T01:00:00.000Z",
      imageSlug: "ubuntu-24.04-lts",
      description: "Cluster A · warming supervisado",
      snapshotRunTime: 2
    },
    {
      slug: "svc-warmup-02",
      name: "svc-warmup-02",
      ipv4: "185.243.12.32",
      ipv6: "2a06:a004:f00d::32",
      status: "running",
      profileSlug: "vps-xeon-essential-2025",
      location: "dk",
      creationDate: "2026-05-02T14:19:00.000Z",
      lastDataReceived: "2026-05-17T01:00:00.000Z",
      imageSlug: "ubuntu-24.04-lts",
      description: "Cluster A · respaldo warming",
      snapshotRunTime: 2
    },
    {
      slug: "svc-prod-eu-01",
      name: "svc-prod-eu-01",
      ipv4: "185.243.12.40",
      ipv6: "2a06:a004:f00d::40",
      status: "stopped",
      profileSlug: "webdockepyc-bit-4",
      location: "fi-hel-2",
      creationDate: "2026-04-22T09:00:00.000Z",
      lastDataReceived: "2026-05-15T22:00:00.000Z",
      imageSlug: "ubuntu-24.04-lts",
      description: "EU producción · standby, esperando aprobación humana",
      snapshotRunTime: 5
    }
  ];
}
