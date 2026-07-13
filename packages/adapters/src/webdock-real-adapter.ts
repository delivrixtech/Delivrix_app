import { createHash, randomBytes } from "node:crypto";

/**
 * WebdockRealAdapter — cliente HTTP contra la API real de Webdock
 * (https://api.webdock.io/v1).
 *
 * Hito 5.11.A. Reemplaza progresivamente los mocks del Canvas con datos
 * vivos del proveedor. El inventario expone vistas separadas para
 * `WEBDOCK_API_KEY_PRIMARY`, `WEBDOCK_API_KEY_OPS` y
 * `WEBDOCK_API_KEY_ACCOUNT`; el bundle frontend sigue GET-only y las
 * mutaciones pasan por rutas gated.
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
  /** Dominio principal/Server Identity si la API lo expone. */
  mainDomain?: string;
  /** Hostname visible si la API lo expone separadamente. */
  hostname?: string;
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
  kind: "live" | "mock" | "unavailable";
  apiBase: string;
  accountId?: string;
  accountLabel?: string;
  fetchedAt: string;
  /** Cuando `kind === "live"`, indica si la API respondió 200. False = degraded. */
  responseOk: boolean;
  /** Fallo de autenticacion/permiso confirmado sin exponer el codigo HTTP crudo en inventario. */
  authFailure?: boolean;
  httpStatus?: number;
  httpStatusText?: string;
  errorCode?: string;
  failureKind?: "unauthorized" | "forbidden" | "rate_limited" | "server_error" | "network" | "unknown";
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

export interface WebdockSetServerMainDomainResult {
  ok: boolean;
  previousMainDomain: string | null;
  raw: unknown;
}

export interface WebdockSetServerPtrResult {
  ok: boolean;
  supported: boolean;
  raw: unknown;
}

export interface WebdockSetServerIdentityResult {
  ok: boolean;
  callbackId: string;
  mainDomain: string;
  raw: unknown;
}

export interface WebdockSshCommandInput {
  serverSlug?: string | null;
  serverIp: string;
  command: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface WebdockSshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface WebdockSshRunner {
  isConfigured?(): boolean;
  run(input: WebdockSshCommandInput): Promise<WebdockSshCommandResult>;
}

export interface WebdockAdapterLogger {
  error(message: string, metadata?: Record<string, unknown>): void;
}

export class WebdockAdapterError extends Error {
  readonly code: string;
  readonly metadata: Record<string, unknown>;

  constructor(code: string, metadata: Record<string, unknown> = {}) {
    super(code);
    this.name = "WebdockAdapterError";
    this.code = code;
    this.metadata = metadata;
  }
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
  /** Runner SSH opcional para fallback de Server Identity. */
  sshRunner?: WebdockSshRunner;
  /** Logger opcional para capturar bodies de errores del proveedor. */
  logger?: WebdockAdapterLogger;
  /** Override del proveedor de timestamps (para tests). */
  now?: () => Date;
}

export interface WebdockAccountAdapterEntry {
  id: string;
  label: string;
  adapter: WebdockRealAdapter;
  /**
   * Fingerprint corto y estable (sha256[:12]) de la credencial de lectura de la cuenta.
   * Sirve para detectar alias: dos entries con el MISMO fingerprint = la misma cuenta
   * física vista por env vars distintas (residuo de la promoción QUINARY→PRIMARY). Nunca
   * expone la key. Ausente si la cuenta no tiene read key.
   */
  credentialFingerprint?: string;
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
  private readonly sshRunner: WebdockSshRunner | undefined;
  private readonly logger: WebdockAdapterLogger;
  private readonly now: () => Date;
  private readonly allowMock: boolean;
  private cache: CacheEntry | null = null;

  constructor(options: WebdockRealAdapterOptions = {}) {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    // El fallback mock solo se permite explícitamente (dev/tests). En producción, sin read key
    // el inventario devuelve "unavailable" en vez de fabricar servers fantasma.
    this.allowMock = normalizeEnvValue(env?.WEBDOCK_ALLOW_MOCK) === "1" ||
      normalizeEnvValue(env?.WEBDOCK_ALLOW_MOCK)?.toLowerCase() === "true";
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
    this.sshRunner = options.sshRunner;
    this.logger = options.logger ?? { error: () => undefined };
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
   * con TTL cache. Cuando no hay key, devuelve un mock canónico que mantiene
   * el panel utilizable en dev. Si la API falla, reporta la fuente degradada
   * sin publicar servidores simulados como capacidad real.
   */
  async listServers(): Promise<WebdockInventoryResult> {
    const now = this.now();

    // Cache hit fresh.
    if (this.cache && this.cache.expiresAt > now.getTime()) {
      return this.cache.result;
    }

    const readApiKey = this.readApiKey;
    if (!readApiKey) {
      const result: WebdockInventoryResult = this.allowMock
        ? {
            servers: this.withAccount(mockWebdockServers()),
            source: this.sourceMetadata(now, "mock", true)
          }
        : {
            // Fail-closed: sin read key NO fabricamos flota fantasma. Vacío + señal honesta.
            servers: [],
            source: this.sourceMetadata(now, "unavailable", false, {
              errorCode: "read_key_unconfigured",
              errorMessage: "No Webdock read API key configured for this collector; use the multi-account infrastructure inventory (read_infrastructure_inventory) for the live fleet."
            })
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
        const result: WebdockInventoryResult = {
          servers: this.withAccount([]),
          source: this.sourceMetadata(now, "live", false, webdockHttpFailureMetadata(response.status, response.statusText))
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
        servers: this.withAccount([]),
        source: this.sourceMetadata(now, "live", false, {
          errorMessage,
          errorCode: "webdock_network_error",
          failureKind: "network"
        })
      };
      this.cacheResult(now, result);
      return result;
    }
  }

  /**
   * Preflight barato de un create real: valida EN VIVO que el write token (GET /servers) y el
   * account token (GET /account/publicKeys) sirvan, sin mutar nada (2 GETs). Un token presente
   * pero revocado del lado del proveedor pasa canCreate() y revienta recien a mitad del run;
   * este check lo detecta antes de gastar. Nunca lanza.
   */
  async verifyCreateCredentials(): Promise<{
    ok: boolean;
    reason?: "no_write_key" | "no_account_key" | "write_token_rejected" | "account_token_rejected" | "network_error";
  }> {
    if (!this.writeApiKey) return { ok: false, reason: "no_write_key" };
    if (!this.accountApiKey) return { ok: false, reason: "no_account_key" };
    try {
      const writeResponse = await this.fetchImpl(`${this.apiBase}/servers`, {
        method: "GET",
        headers: this.jsonHeaders(this.writeApiKey, "Delivrix-MailOps/0.1 (webdock-account-preflight)")
      });
      if (!writeResponse.ok) return { ok: false, reason: "write_token_rejected" };
      const accountResponse = await this.fetchImpl(`${this.apiBase}/account/publicKeys`, {
        method: "GET",
        headers: this.jsonHeaders(this.accountApiKey, "Delivrix-MailOps/0.1 (webdock-account-preflight)")
      });
      if (!accountResponse.ok) return { ok: false, reason: "account_token_rejected" };
      return { ok: true };
    } catch {
      return { ok: false, reason: "network_error" };
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

    const sentBody = JSON.stringify(payload);
    const response = await this.fetchImpl(`${this.apiBase}/servers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.writeApiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "Delivrix-MailOps/0.1 (webdock-provisioner)"
      },
      body: sentBody
    });

    if (!response.ok) {
      const respBody = await response.text().catch(() => "");
      throw new Error(
        `Webdock API returned ${response.status} ${response.statusText} | sent: ${sentBody.slice(0, 500)} | got: ${respBody.slice(0, 600)}`
      );
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

  async setServerMainDomain(opts: {
    serverSlug: string;
    domain: string;
    serverIp?: string | null;
    sshRunner?: WebdockSshRunner;
    timeoutMs?: number;
  }): Promise<WebdockSetServerMainDomainResult> {
    return this.setServerHostnameViaSsh({
      serverSlug: opts.serverSlug,
      domain: opts.domain,
      serverIp: opts.serverIp,
      sshRunner: opts.sshRunner,
      timeoutMs: opts.timeoutMs
    });
  }

  async setServerHostnameViaSsh(opts: {
    serverSlug: string;
    domain: string;
    serverIp?: string | null;
    sshRunner?: WebdockSshRunner;
    timeoutMs?: number;
  }): Promise<WebdockSetServerMainDomainResult> {
    const serverSlug = normalizeBindServerSlug(opts.serverSlug);
    const domain = normalizeMainDomain(opts.domain);
    const serverIp = normalizeOptionalIpv4(opts.serverIp);
    if (!serverIp) {
      throw new WebdockAdapterError("set_main_domain_failed_ipv4_missing", { serverSlug });
    }

    const runner = opts.sshRunner ?? this.sshRunner;
    if (!runner || (runner.isConfigured && !runner.isConfigured())) {
      throw new WebdockAdapterError("set_main_domain_failed_ssh_runner_missing", { serverSlug });
    }

    const previous = await runner.run({
      serverIp,
      command: "hostname",
      timeoutMs: opts.timeoutMs ?? 15_000
    });
    if (previous.exitCode !== 0) {
      throw new WebdockAdapterError("set_main_domain_failed_hostname_read", {
        serverSlug,
        exitCode: previous.exitCode,
        stderr: previous.stderr.slice(0, 1000)
      });
    }

    const previousHostname = lastNonEmptyLine(previous.stdout);
    if (previousHostname === domain) {
      return {
        ok: true,
        previousMainDomain: previousHostname,
        raw: { skipped: "already_bound_ssh", previousHostname }
      };
    }

    const domainArg = shellSingleQuote(domain);
    const script = [
      "set -euo pipefail",
      `domain=${domainArg}`,
      "sudo hostnamectl set-hostname \"$domain\"",
      "if grep -qE '^127\\.0\\.1\\.1[[:space:]]+' /etc/hosts; then",
      "  sudo sed -i.bak -E \"s/^127\\.0\\.1\\.1[[:space:]].*/127.0.1.1 $domain/\" /etc/hosts",
      "else",
      "  printf '127.0.1.1 %s\\n' \"$domain\" | sudo tee -a /etc/hosts >/dev/null",
      "fi",
      "hostname"
    ].join("\n");
    const result = await runner.run({
      serverIp,
      command: script,
      timeoutMs: opts.timeoutMs ?? 30_000
    });
    const hostnameAfter = lastNonEmptyLine(result.stdout);
    if (result.exitCode !== 0 || hostnameAfter !== domain) {
      this.logger.error("webdock.set_main_domain_ssh.failed", {
        serverSlug,
        serverIp,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 1000),
        stderr: result.stderr.slice(0, 1000)
      });
      throw new WebdockAdapterError("set_main_domain_failed_ssh", {
        serverSlug,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 1000),
        stderr: result.stderr.slice(0, 1000)
      });
    }

    this.invalidateCache();
    return {
      ok: true,
      previousMainDomain: previousHostname,
      raw: {
        route: "ssh_hostnamectl",
        commandOutput: result.stdout,
        previousHostname,
        hostname: hostnameAfter
      }
    };
  }

  async setServerPtr(opts: {
    serverSlug: string;
    ipv4: string;
    ptrValue: string;
  }): Promise<WebdockSetServerPtrResult> {
    normalizeBindServerSlug(opts.serverSlug);
    normalizeIpv4(opts.ipv4);
    normalizeReverseDnsHost(opts.ptrValue);
    return {
      ok: false,
      supported: false,
      raw: { reason: "not_supported_by_api" }
    };
  }

  async setServerIdentity(opts: {
    serverSlug: string;
    mainDomain: string;
    aliasDomains?: string | string[] | null;
    removeDefaultAlias?: boolean;
    waitForCompletion?: boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<WebdockSetServerIdentityResult> {
    if (!this.writeApiKey) {
      throw new Error("WEBDOCK_API_KEY_OPS is required for Webdock writes.");
    }

    const serverSlug = normalizeBindServerSlug(opts.serverSlug);
    const mainDomain = normalizeIdentityHost(opts.mainDomain);
    const aliasdomains = normalizeIdentityAliasDomains(opts.aliasDomains);
    const payload = {
      maindomain: mainDomain,
      aliasdomains,
      removeDefaultAlias: opts.removeDefaultAlias ?? true
    };

    const response = await this.fetchImpl(
      `${this.apiBase}/servers/${encodeURIComponent(serverSlug)}/identity`,
      {
        method: "PATCH",
        headers: this.jsonHeaders(this.writeApiKey, "Delivrix-MailOps/0.1 (webdock-identity)"),
        body: JSON.stringify(payload)
      }
    );
    const body = response.status === 204 ? "" : await response.text();
    const raw = parseJsonObject(body);

    if (!response.ok) {
      throw new WebdockAdapterError("set_server_identity_failed_api", {
        serverSlug,
        status: response.status,
        statusText: response.statusText,
        body: body.slice(0, 1000)
      });
    }

    const eventId = callbackId(response, raw);
    if (!eventId) {
      throw new WebdockAdapterError("set_server_identity_callback_missing", { serverSlug });
    }

    const event = opts.waitForCompletion === false
      ? null
      : await this.waitForWebdockEvent({
        callbackId: eventId,
        eventType: "set-hostnames",
        serverSlug,
        timeoutMs: opts.timeoutMs ?? 120_000,
        pollIntervalMs: opts.pollIntervalMs ?? 2_000
      });

    this.invalidateCache();
    return {
      ok: true,
      callbackId: eventId,
      mainDomain,
      raw: {
        response: raw,
        event
      }
    };
  }

  async getServer(slug: string): Promise<WebdockServer> {
    const readApiKey = this.readApiKey;
    if (!readApiKey) {
      if (!this.allowMock) {
        throw new Error("webdock_read_key_unconfigured: cannot read server without a Webdock read API key.");
      }
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
    error?: {
      errorMessage?: string;
      authFailure?: boolean;
      httpStatus?: number;
      httpStatusText?: string;
      errorCode?: string;
      failureKind?: WebdockInventorySource["failureKind"];
    }
  ): WebdockInventorySource {
    return {
      kind,
      apiBase: this.apiBase,
      accountId: this.accountId,
      accountLabel: this.accountLabel,
      fetchedAt: now.toISOString(),
      responseOk,
      ...(error?.authFailure ? { authFailure: true } : {}),
      ...(error?.httpStatus ? { httpStatus: error.httpStatus } : {}),
      ...(error?.httpStatusText ? { httpStatusText: error.httpStatusText } : {}),
      ...(error?.errorCode ? { errorCode: error.errorCode } : {}),
      ...(error?.failureKind ? { failureKind: error.failureKind } : {}),
      ...(error?.errorMessage ? { errorMessage: error.errorMessage } : {})
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

  private async waitForWebdockEvent(input: {
    callbackId: string;
    eventType: string;
    serverSlug: string;
    timeoutMs: number;
    pollIntervalMs: number;
  }): Promise<unknown> {
    const apiKey = this.readApiKey ?? this.accountApiKey;
    if (!apiKey) {
      throw new Error("WEBDOCK_API_KEY_PRIMARY or WEBDOCK_API_KEY_ACCOUNT is required to poll Webdock events.");
    }

    const startedAt = Date.now();
    const pollIntervalMs = Math.max(1, input.pollIntervalMs);
    const timeoutMs = Math.max(1, input.timeoutMs);
    let lastRaw: unknown = null;

    while (Date.now() - startedAt <= timeoutMs) {
      const response = await this.fetchImpl(
        `${this.apiBase}/events?callbackId=${encodeURIComponent(input.callbackId)}&eventType=${encodeURIComponent(input.eventType)}&per_page=10`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
            "user-agent": "Delivrix-MailOps/0.1 (webdock-identity)"
          }
        }
      );
      const body = response.status === 204 ? "" : await response.text();
      const raw = parseJsonObject(body);
      lastRaw = raw;

      if (!response.ok) {
        throw new WebdockAdapterError("set_server_identity_event_poll_failed_api", {
          serverSlug: input.serverSlug,
          callbackId: input.callbackId,
          status: response.status,
          statusText: response.statusText,
          body: body.slice(0, 1000)
        });
      }

      for (const event of parseWebdockEventLogs(raw)) {
        const status = stringField(event, "status");
        if (status === "finished") {
          return event;
        }
        if (status === "error") {
          throw new WebdockAdapterError("set_server_identity_event_failed", {
            serverSlug: input.serverSlug,
            callbackId: input.callbackId,
            eventType: input.eventType,
            event
          });
        }
      }

      await delay(pollIntervalMs);
    }

    throw new WebdockAdapterError("set_server_identity_event_timeout", {
      serverSlug: input.serverSlug,
      callbackId: input.callbackId,
      eventType: input.eventType,
      timeoutMs,
      lastRaw
    });
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

function webdockHttpFailureMetadata(status: number, statusText: string): {
  errorMessage: string;
  authFailure?: boolean;
  httpStatus?: number;
  httpStatusText?: string;
  errorCode?: string;
  failureKind?: WebdockInventorySource["failureKind"];
} {
  if (status === 401 || status === 403) {
    return {
      errorMessage: "webdock_auth_failed",
      authFailure: true
    };
  }
  return {
    errorMessage: `Webdock API returned ${status} ${statusText}`,
    httpStatus: status,
    httpStatusText: statusText,
    errorCode: webdockHttpErrorCode(status),
    failureKind: webdockFailureKind(status)
  };
}

function webdockHttpErrorCode(status: number): string {
  if (status === 401) return "webdock_auth_401";
  if (status === 403) return "webdock_forbidden_403";
  if (status === 429) return "webdock_rate_limited_429";
  if (status >= 500) return "webdock_server_error";
  return `webdock_http_${status}`;
}

function webdockFailureKind(status: number): WebdockInventorySource["failureKind"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unknown";
}

/**
 * FUENTE ÚNICA de los roles de cuentas Webdock DISTINTAS (no cuenta-1). Agregar un rol acá
 * habilita a la vez: el factory (createWebdockAdaptersFromEnv), el gate del catálogo de tools
 * (hasWriteCapableWebdockCreationAccountEnv) y el env-preflight. Antes la lista vivía
 * duplicada en el factory y en openclaw-tools-builder — desincronizarlas fue la raíz del
 * incidente "solo QUINARY viva y configure_complete_smtp desapareció del catálogo".
 */
export const WEBDOCK_DISTINCT_ACCOUNT_ROLES = ["SECONDARY", "TERTIARY", "QUATERNARY", "QUINARY"] as const;

function webdockRoleLabel(role: string): string {
  return `Webdock ${role[0]}${role.slice(1).toLowerCase()}`;
}

/**
 * Espejo puro-env de "existe >=1 cuenta Webdock capaz de un create real". Cláusula 1: cuenta-1
 * (OPS/legacy/PRIMARY — nota: PRIMARY es solo-read pero cuenta como write por compat con el gate
 * histórico; mentira preexistente preservada a propósito para byte-identidad). Cláusula 2:
 * cualquier rol distinct con par _WRITE + _ACCOUNT (espejo de canCreate()).
 */
export function hasWriteCapableWebdockCreationAccountEnv(
  env: Record<string, string | undefined>
): boolean {
  if (
    normalizeEnvValue(env.WEBDOCK_API_KEY_OPS) ??
    normalizeEnvValue(env.WEBDOCK_API_KEY) ??
    normalizeEnvValue(env.WEBDOCK_API_KEY_PRIMARY)
  ) {
    return true;
  }
  return WEBDOCK_DISTINCT_ACCOUNT_ROLES.some((role) =>
    Boolean(normalizeEnvValue(env[`WEBDOCK_API_KEY_${role}_WRITE`])) &&
    Boolean(normalizeEnvValue(env[`WEBDOCK_API_KEY_${role}_ACCOUNT`]))
  );
}

/** Espejo puro-env de "existe >=1 read key Webdock" (inventario/lecturas; para env-preflight). */
export function hasAnyWebdockReadCredentialEnv(
  env: Record<string, string | undefined>
): boolean {
  if (
    normalizeEnvValue(env.WEBDOCK_API_KEY_PRIMARY) ??
    normalizeEnvValue(env.WEBDOCK_API_KEY) ??
    normalizeEnvValue(env.WEBDOCK_API_KEY_OPS) ??
    normalizeEnvValue(env.WEBDOCK_API_KEY_ACCOUNT)
  ) {
    return true;
  }
  return WEBDOCK_DISTINCT_ACCOUNT_ROLES.some((role) =>
    Boolean(normalizeEnvValue(env[`WEBDOCK_API_KEY_${role}`]))
  );
}

export function createWebdockAdaptersFromEnv(
  env: Record<string, string | undefined> =
    typeof process !== "undefined" ? process.env : {},
  options: CreateWebdockAdaptersFromEnvOptions = {}
): WebdockAccountAdapterEntry[] {
  // Specs legacy de la cuenta-1 (primary/ops/account): NO se tocan para
  // preservar byte-identidad del comportamiento single-account de hoy. Sus
  // write/account keys quedan undefined -> el constructor cae al fallback de
  // los singletons OPS/ACCOUNT (correcto: son la misma cuenta-1).
  // Specs de cuentas DISTINTAS (WEBDOCK_DISTINCT_ACCOUNT_ROLES): write y
  // account keys PROPIAS inyectadas explicitas + env aislado, para que NO
  // caigan al fallback de los singletons de la cuenta-1 (bug latente: un
  // create "secondary" escribiria en la cuenta-1). Sin sus _WRITE/_ACCOUNT
  // propias quedan read-only (canCreate()===false real, no enganoso).
  const accountSpecs: AccountSpec[] = [
    {
      id: "primary",
      apiKey: normalizeEnvValue(env.WEBDOCK_API_KEY_PRIMARY),
      label: normalizeEnvValue(env.WEBDOCK_ACCOUNT_PRIMARY_LABEL) ?? "Webdock Primary"
    },
    {
      id: "ops",
      apiKey: normalizeEnvValue(env.WEBDOCK_API_KEY_OPS),
      label: normalizeEnvValue(env.WEBDOCK_ACCOUNT_OPS_LABEL) ?? "Webdock Ops"
    },
    {
      id: "account",
      apiKey: normalizeEnvValue(env.WEBDOCK_API_KEY_ACCOUNT),
      label: normalizeEnvValue(env.WEBDOCK_ACCOUNT_ACCOUNT_LABEL) ?? "Webdock Account"
    },
    ...WEBDOCK_DISTINCT_ACCOUNT_ROLES.map((role) =>
      buildDistinctAccountSpec(role.toLowerCase(), role, webdockRoleLabel(role), env)
    )
  ];

  // Dedupe estructural por FINGERPRINT de credencial: si un rol distinct
  // (secondary/…/quinary) reusa la misma API key que la cuenta-1 o que otro
  // rol distinct ya visto, es un alias de la MISMA cuenta física (residuo de la
  // promoción QUINARY→PRIMARY). Colapsarlo acá arregla a la vez inventario,
  // health poller y buildWebdockCreateRegistry, porque todos consumen el factory.
  const dedupedSpecs = dedupeAccountSpecsByCredentialFingerprint(
    accountSpecs.filter((account) => account.apiKey),
    options.logger
  );
  const configuredAccounts = dedupedSpecs.map((account) => {
    const entry = buildAccountAdapterEntry(account, env, options);
    const fingerprint = account.apiKey ? webdockCredentialFingerprint(account.apiKey) : undefined;
    return fingerprint ? { ...entry, credentialFingerprint: fingerprint } : entry;
  });

  if (configuredAccounts.length > 0) {
    return configuredAccounts;
  }

  const legacyApiKey = normalizeEnvValue(env.WEBDOCK_API_KEY);
  const legacyLabel = normalizeEnvValue(env.WEBDOCK_ACCOUNT_DEFAULT_LABEL) ?? "Webdock";
  return [buildAccountAdapterEntry({ id: "default", label: legacyLabel, apiKey: legacyApiKey }, env, options)];
}

/**
 * Roles de la cuenta-1 (la misma cuenta Webdock vista con sus 3 keys read/write/account, mas el
 * fallback legacy `default`). En el registry de create/delete multicuenta (5.12) NO deben contar
 * como cuentas separadas: se colapsan a una sola clave "ops" apuntando al adapter ops canonico.
 */
const CUENTA1_ROLE_IDS: ReadonlySet<string> = new Set(["primary", "ops", "account", "default"]);

/**
 * Fingerprint corto y estable de una credencial Webdock (sha256[:12]). Se usa SOLO para
 * agrupar/detectar alias (misma key en varias env vars). Nunca se loguea ni expone la key.
 */
export function webdockCredentialFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12);
}

/**
 * Colapsa specs de cuentas que comparten credencial. Regla:
 * - Los roles de la cuenta-1 (primary/ops/account/default) SIEMPRE se conservan (byte-identidad del
 *   comportamiento single-account: son 3 keys legítimas de la misma cuenta, ya de-dupeadas aguas
 *   abajo por buildWebdockCreateRegistry y dedupeWebdockInventoryAccounts).
 * - Un rol DISTINCT (secondary/…/quinary) cuya API key ya apareció (en cuenta-1 o en un distinct
 *   anterior) es un ALIAS: se descarta y se emite `webdock.account_alias_detected`. Así 6 env vars
 *   con la misma credencial colapsan a UNA cuenta lógica.
 */
function dedupeAccountSpecsByCredentialFingerprint(
  specs: AccountSpec[],
  logger?: WebdockAdapterLogger
): AccountSpec[] {
  const canonicalRoleByFingerprint = new Map<string, string>();
  const kept: AccountSpec[] = [];
  for (const spec of specs) {
    const apiKey = spec.apiKey;
    if (!apiKey) {
      kept.push(spec);
      continue;
    }
    const fingerprint = webdockCredentialFingerprint(apiKey);
    const canonicalRole = canonicalRoleByFingerprint.get(fingerprint);
    const isCuenta1 = CUENTA1_ROLE_IDS.has(spec.id);
    if (canonicalRole && !isCuenta1) {
      logger?.error("webdock.account_alias_detected", {
        aliasRole: spec.id,
        canonicalRole,
        fingerprint
      });
      continue;
    }
    if (!canonicalRole) {
      canonicalRoleByFingerprint.set(fingerprint, spec.id);
    }
    kept.push(spec);
  }
  return kept;
}

/**
 * Construye el registry write-capable id->adapter para create/delete multicuenta (5.12), de-dupeando
 * la cuenta-1. La clave "ops" SIEMPRE apunta a `opsAdapter` (el webdockOpsAdapter de produccion:
 * mismo objeto/keys => single-account byte-identico). Las cuentas DISTINTAS (secondary/tertiary/...)
 * entran solo si `canCreate()===true` (post Fase 0 = tienen write+account keys propias). Asi, aunque
 * `entries` traiga primary+ops+account de la cuenta-1, el governor/selector la cuenta UNA sola vez.
 */
export function buildWebdockCreateRegistry(
  entries: WebdockAccountAdapterEntry[],
  opsAdapter: WebdockRealAdapter
): Map<string, WebdockRealAdapter> {
  const registry = new Map<string, WebdockRealAdapter>([["ops", opsAdapter]]);
  // Defensa en profundidad: aunque el factory ya de-dupea por fingerprint, colapsamos
  // acá también por credencial. Los fingerprints de la cuenta-1 se siembran para que un
  // rol distinct que aliasee la cuenta-1 tampoco entre como cuenta creadora "adicional".
  const seenFingerprints = new Set<string>();
  for (const entry of entries) {
    if (CUENTA1_ROLE_IDS.has(entry.id)) {
      if (entry.credentialFingerprint) seenFingerprints.add(entry.credentialFingerprint);
      continue;
    }
    if (!entry.adapter.canCreate()) continue;
    if (entry.credentialFingerprint) {
      if (seenFingerprints.has(entry.credentialFingerprint)) continue;
      seenFingerprints.add(entry.credentialFingerprint);
    }
    registry.set(entry.id, entry.adapter);
  }
  return registry;
}

interface AccountSpec {
  id: string;
  label: string;
  /** Read key (inventario). */
  apiKey: string | undefined;
  /** Write key PROPIA de la cuenta (create/delete). Solo cuentas distintas. */
  writeApiKey?: string | undefined;
  /** Account key PROPIA de la cuenta (registrar SSH). Solo cuentas distintas. */
  accountApiKey?: string | undefined;
  /**
   * Si true, el adapter se construye con env aislado: write/account NO caen al
   * fallback de los singletons globales OPS/ACCOUNT. Para cuentas distintas.
   */
  isolated?: boolean;
}

/**
 * Spec de una cuenta Webdock DISTINTA (no la cuenta-1). Lee 3 env vars propias:
 * WEBDOCK_API_KEY_<ROLE> (read), _<ROLE>_WRITE (write), _<ROLE>_ACCOUNT (account).
 * Si solo tiene la read key, queda read-only (canCreate false real).
 */
function buildDistinctAccountSpec(
  id: string,
  role: string,
  defaultLabel: string,
  env: Record<string, string | undefined>
): AccountSpec {
  return {
    id,
    apiKey: normalizeEnvValue(env[`WEBDOCK_API_KEY_${role}`]),
    label: normalizeEnvValue(env[`WEBDOCK_ACCOUNT_${role}_LABEL`]) ?? defaultLabel,
    writeApiKey: normalizeEnvValue(env[`WEBDOCK_API_KEY_${role}_WRITE`]),
    accountApiKey: normalizeEnvValue(env[`WEBDOCK_API_KEY_${role}_ACCOUNT`]),
    isolated: true
  };
}

function buildAccountAdapterEntry(
  spec: AccountSpec,
  env: Record<string, string | undefined>,
  options: CreateWebdockAdaptersFromEnvOptions
): WebdockAccountAdapterEntry {
  if (spec.isolated) {
    // env aislado: sin singletons globales -> write/account solo si son propias.
    return {
      id: spec.id,
      label: spec.label,
      adapter: new WebdockRealAdapter({
        ...options,
        env: {},
        readApiKey: spec.apiKey,
        writeApiKey: spec.writeApiKey,
        accountApiKey: spec.accountApiKey,
        accountId: spec.id,
        accountLabel: spec.label
      })
    };
  }
  // Cuenta-1 legacy: comportamiento idéntico al de antes (fallback a singletons).
  return {
    id: spec.id,
    label: spec.label,
    adapter: new WebdockRealAdapter({
      ...options,
      env,
      readApiKey: spec.apiKey,
      accountApiKey: normalizeEnvValue(env.WEBDOCK_API_KEY_ACCOUNT),
      accountId: spec.id,
      accountLabel: spec.label
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
      mainDomain: mainDomainFromServerObject(obj),
      hostname: stringField(obj, "hostname"),
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
    mainDomain: mainDomainFromServerObject(obj),
    hostname: stringField(obj, "hostname"),
    webRoot: stringField(obj, "webRoot"),
    snapshotRunTime: numberField(obj, "snapshotRunTime")
  };
}

function mainDomainFromServerObject(obj: Record<string, unknown>): string | undefined {
  const legacy = stringField(obj, "mainDomain") ?? stringField(obj, "maindomain") ?? stringField(obj, "main_domain");
  if (legacy) return legacy;
  const aliases = Array.isArray(obj.aliases) ? obj.aliases : [];
  const firstAlias = aliases.find((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
  return firstAlias?.trim();
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

function parseWebdockEventLogs(raw: unknown): Array<Record<string, unknown>> {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const candidates: unknown[] =
    Array.isArray(raw) ? raw :
      obj && Array.isArray(obj.events) ? obj.events as unknown[] :
        obj && Array.isArray(obj.data) ? obj.data as unknown[] :
          obj && Array.isArray(obj.items) ? obj.items as unknown[] :
            [];
  return candidates.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
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

function normalizeBindServerSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(normalized)) {
    throw new WebdockAdapterError("server_slug_invalid_format", { value });
  }
  return normalized;
}

function normalizeMainDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63})+$/.test(normalized) ||
    /^(mail|email|notify|noreply|alert|smtp|sender|inbox|bulk|blast)\./i.test(normalized)
  ) {
    throw new WebdockAdapterError("domain_invalid_format", { value });
  }
  return normalized;
}

function normalizeIdentityHost(value: string): string {
  const normalized = normalizeReverseDnsHost(value);
  if (!normalized.startsWith("smtp.")) {
    throw new WebdockAdapterError("identity_host_invalid_format", { value });
  }
  return normalized;
}

function normalizeReverseDnsHost(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  const labels = normalized.split(".");
  const validLabels = labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  );
  if (
    normalized.length > 253 ||
    labels.length < 2 ||
    !validLabels ||
    !/[a-z]/.test(labels.at(-1) ?? "")
  ) {
    throw new WebdockAdapterError("identity_host_invalid_format", { value });
  }
  return normalized;
}

function normalizeIdentityAliasDomains(value: string | string[] | null | undefined): string {
  if (value === null || value === undefined) return "";
  const values = Array.isArray(value) ? value : value.split(/[,\n]/);
  const normalized = values
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeReverseDnsHost);
  return [...new Set(normalized)].join("\n");
}

function normalizeOptionalIpv4(value: string | null | undefined): string | null {
  if (!value) return null;
  return normalizeIpv4(value);
}

function normalizeIpv4(value: string): string {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)) {
    throw new WebdockAdapterError("ipv4_invalid_format", { value });
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function lastNonEmptyLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1);
  return line ?? null;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
