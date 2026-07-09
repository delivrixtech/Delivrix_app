import { randomUUID } from "node:crypto";

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

/**
 * ContaboAdapter - cliente HTTP contra la API real de Contabo
 * (https://api.contabo.com) implementando la interface generica `VpsProvider`.
 *
 * Segundo proveedor de VPS para `configure_complete_smtp`, en paralelo a
 * Webdock, para diversificar ASN tras el ban de cuentas Webdock. Reusa los
 * tipos de resultado de Webdock (serverSlug/ipv4/status/source) para que el
 * orquestador NO distinga proveedor en el step 4: el adapter TRADUCE el
 * vocabulario Webdock (profile/locationId/imageSlug) a Contabo
 * (productId/region/imageId) usando su PROPIA configuracion (env/constructor),
 * NUNCA el profile/locationId entrantes (que son defaults Webdock como
 * "bit"/"dk"). Asi el dict de `params` del step 4 queda byte-identico y no
 * cambia el inputHash/plan-signature del camino Webdock.
 *
 * Diferencias clave vs Webdock que el adapter encapsula:
 * - Auth: OAuth2 password-grant contra Keycloak (TTL ~5min) en vez de Bearer
 *   estatico. El token se cachea y se re-pide con skew antes de CADA call
 *   compute (el poll de provisioning dura minutos).
 * - serverSlug: el id Contabo es un entero (instanceId). Se PREFIJA a
 *   `contabo-<instanceId>` para pasar el regex de slug del orquestador
 *   (^[a-z0-9][a-z0-9-]{0,95}$) y se de-prefija al llamar la API.
 * - SSH: se inyecta en la creacion via Secrets API (no shellUsers). El
 *   pubkey se sube como secret type "ssh" y se referencia por secretId.
 * - rDNS/PTR: API publica de Contabo via PUT /v1/dns/ptrs/{ip}. El FCrDNS
 *   verify del step 8 gatea hasta propagar.
 * - deleteServer(): Contabo "cancel" es FIN-DE-TERMINO, NO destruccion
 *   inmediata. La instancia queda facturable hasta fin de termino.
 */

const DEFAULT_AUTH_URL =
  "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";
const DEFAULT_API_BASE = "https://api.contabo.com";
/** Margen de seguridad para refrescar el token antes de su expiry real. */
const TOKEN_REFRESH_SKEW_MS = 30_000;
/** Cache corto para inventario: evita que el panel dispare un list live en cada poll. */
const DEFAULT_INVENTORY_CACHE_TTL_MS = 30_000;
const TOKEN_GRANT_MAX_RETRIES = 2;
const COMPUTE_MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 60_000;
/**
 * Producto default (env CONTABO_PRODUCT_ID lo override). "V45" = VPS 1 SSD,
 * tier pequeno y barato; SUPONIDO segun tabla de productos de docs, confirmar
 * specs reales en runtime via GET /v1/compute/products (vCPU/RAM no estan en
 * la tabla de docs). Flag para verificacion en E2E.
 */
const DEFAULT_PRODUCT_ID = "V45";
/** Region default. Contabo usa "US-east" (no "us-east"). Confirmar en E2E. */
const DEFAULT_REGION = "US-east";
/** Default user inyectado en la instancia. */
const DEFAULT_INSTANCE_USER = "root";
/** Periodo de contrato en meses (REQUERIDO por Contabo: 1/3/6/12). */
const DEFAULT_PERIOD_MONTHS = 1;
/** Prefijo del nombre del secret SSH para dedupe en la cuenta. */
const SSH_SECRET_NAME_PREFIX = "delivrix-ops";

export class ContaboAdapterError extends Error {
  readonly code: string;
  /** True si el gateway/failover puede tratarlo como recuperable (otra cuenta). */
  readonly recoverable: boolean;
  readonly status: number | null;
  readonly metadata: Record<string, unknown>;

  constructor(
    code: string,
    options: {
      recoverable?: boolean;
      status?: number | null;
      metadata?: Record<string, unknown>;
    } = {}
  ) {
    super(code);
    this.name = "ContaboAdapterError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.status = options.status ?? null;
    this.metadata = options.metadata ?? {};
  }
}

export interface ContaboAdapterConfig {
  /** OAuth2 client id (env CONTABO_CLIENT_ID). */
  clientId?: string;
  /** OAuth2 client secret (env CONTABO_CLIENT_SECRET). */
  clientSecret?: string;
  /** OAuth2 username = email de la cuenta (env CONTABO_API_USER). */
  username?: string;
  /** OAuth2 password de la cuenta (env CONTABO_API_PASSWORD). */
  password?: string;
  /** Region Contabo, ej "US-east". Default "US-east". */
  region?: string;
  /** productId Contabo, ej "V45". Default DEFAULT_PRODUCT_ID. */
  productId?: string;
  /** imageId UUID fijo opcional. Si no se pasa, se resuelve por lookup. */
  imageId?: string;
  /** Identificador interno de la cuenta para audit/source. */
  accountId?: string;
  /** Etiqueta humana visible para el panel/audit. */
  accountLabel?: string;
  /** Default user de la instancia (root/admin). Default "root". */
  defaultUser?: string;
  /** Periodo de contrato en meses (1/3/6/12). Default 1. */
  periodMonths?: number;
  /** Base URL del API compute para tests. Default https://api.contabo.com. */
  apiBase?: string;
  /** URL del endpoint de token para tests. Default Keycloak Contabo. */
  authUrl?: string;
  /** TTL del cache de inventario listServers(). Default 30s; 0 lo desactiva en tests. */
  cacheTtlMs?: number;
  /** Fetch impl para tests (default global fetch). */
  fetchImpl?: typeof fetch;
  /** Sleep inyectable para tests de backoff/retry. */
  sleep?: (ms: number) => Promise<void>;
  /** Override del proveedor de timestamps (para tests). */
  now?: () => Date;
}

interface CachedToken {
  accessToken: string;
  /** epoch ms en el que el token expira (ya con skew restado). */
  expiresAt: number;
}

interface InventoryCacheEntry {
  expiresAt: number;
  result: WebdockInventoryResult;
}

export class ContaboAdapter implements VpsProvider {
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly region: string;
  private readonly productId: string;
  private readonly configuredImageId: string | undefined;
  private readonly accountId: string;
  private readonly accountLabel: string;
  private readonly defaultUser: string;
  private readonly periodMonths: number;
  private readonly apiBase: string;
  private readonly authUrl: string;
  private readonly cacheTtlMs: number;
  /**
   * Fetch inyectado explicitamente. Si es undefined, se resuelve
   * `globalThis.fetch` en cada llamada (lazy) para no congelar una referencia
   * vieja en el constructor: importa cuando el adapter se construye via factory
   * (sin fetchImpl) y el caller/test reemplaza globalThis.fetch despues.
   */
  private readonly injectedFetch: typeof fetch | undefined;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  private token: CachedToken | null = null;
  private tokenPromise: Promise<string> | null = null;
  private inventoryCache: InventoryCacheEntry | null = null;
  private resolvedImageId: string | undefined;

  constructor(config: ContaboAdapterConfig = {}) {
    this.clientId = normalizeEnvValue(config.clientId);
    this.clientSecret = normalizeEnvValue(config.clientSecret);
    this.username = normalizeEnvValue(config.username);
    this.password = normalizeEnvValue(config.password);
    this.region = normalizeEnvValue(config.region) ?? DEFAULT_REGION;
    this.productId = normalizeEnvValue(config.productId) ?? DEFAULT_PRODUCT_ID;
    this.configuredImageId = normalizeEnvValue(config.imageId);
    this.resolvedImageId = this.configuredImageId;
    this.accountId = normalizeEnvValue(config.accountId) ?? "contabo";
    this.accountLabel = normalizeEnvValue(config.accountLabel) ?? "Contabo";
    this.defaultUser = normalizeEnvValue(config.defaultUser) ?? DEFAULT_INSTANCE_USER;
    this.periodMonths = normalizePeriod(config.periodMonths) ?? DEFAULT_PERIOD_MONTHS;
    this.apiBase = normalizeEnvValue(config.apiBase) ?? DEFAULT_API_BASE;
    this.authUrl = normalizeEnvValue(config.authUrl) ?? DEFAULT_AUTH_URL;
    this.cacheTtlMs = normalizeNonNegativeMs(config.cacheTtlMs) ?? DEFAULT_INVENTORY_CACHE_TTL_MS;
    this.injectedFetch = config.fetchImpl;
    this.sleepFn = config.sleep ?? sleep;
    this.now = config.now ?? (() => new Date());
  }

  /** Fetch a usar: el inyectado, o `globalThis.fetch` resuelto en el momento. */
  private get fetchImpl(): typeof fetch {
    return this.injectedFetch ?? globalThis.fetch;
  }

  /** True si las 4 credenciales OAuth2 estan presentes. */
  isLive(): boolean {
    return Boolean(
      this.clientId && this.clientSecret && this.username && this.password
    );
  }

  /**
   * Contabo NO tiene scope de write separado: el password de la cuenta es LA
   * credencial. Con las 4 creds presentes se puede escribir (crear/borrar).
   */
  canWrite(): boolean {
    return this.isLive();
  }

  /** Igual que canWrite: no hay account-key separada para crear. */
  canCreate(): boolean {
    return this.isLive();
  }

  /**
   * Crea (compra) una instancia Contabo a partir del input en vocabulario
   * Webdock. TRADUCE usando la config del adapter (region/productId/imageId),
   * IGNORANDO input.profile/input.locationId (defaults Webdock "bit"/"dk").
   *
   * Pasos:
   *  1. ensure SSH key secret (GET /v1/secrets?type=ssh por nombre, else POST).
   *  2. resolve imageId (GET /v1/compute/images, Ubuntu 22.04) si no esta en
   *     config; se cachea.
   *  3. productId desde config.
   *  4. POST /v1/compute/instances -> 201 {instanceId} (SIN ip; hay que pollear).
   *
   * El POST NO devuelve ipv4 -> se mapea ipv4:null (el step 4 del orquestador
   * ya hace el poll GET hasta running via getServer()).
   */
  async createServer(input: WebdockCreateServerInput): Promise<WebdockCreateServerResult> {
    this.assertWritable();
    const now = this.now();
    const publicKey = normalizePublicKey(input.publicKey);

    const secretId = await this.ensureSshSecret(publicKey);
    const imageId = await this.resolveImageId();

    const payload = {
      imageId,
      productId: this.productId,
      region: this.region,
      sshKeys: [secretId],
      period: this.periodMonths,
      // Contabo solo permite [letras, numeros, espacios, -] en displayName.
      // El hostname operativo trae puntos, asi que conservamos una forma
      // reversible para idempotencia (smtp.example.com -> smtp-example-com).
      displayName: contaboDisplayNameFromHostname(input.hostname),
      defaultUser: this.defaultUser
    };

    const response = await this.computeFetch("/v1/compute/instances", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        "[contabo] createServer failed:",
        JSON.stringify({
          status: response.status,
          body: sanitizeErrorDetail(body).slice(0, 600),
          sentRegion: this.region,
          sentProductId: this.productId,
          sentImageId: imageId
        })
      );
      throw this.classifyContaboFailure(response.status, body, {
        phase: "create_instance",
        sent: JSON.stringify(payload).slice(0, 500)
      });
    }

    const raw = (await response.json().catch(() => ({}))) as unknown;
    const instance = pickFirstInstance(raw);
    const instanceId = numberOrStringId(instance, "instanceId");
    if (instanceId === undefined) {
      throw new ContaboAdapterError("contabo_create_missing_instance_id", {
        status: response.status,
        metadata: { raw: truncateRaw(raw) }
      });
    }

    const requestId =
      response.headers.get("x-request-id") ??
      stringField(instance, "requestId") ??
      stringFromUnknown(raw, "requestId") ??
      String(instanceId);

    this.invalidateInventoryCache();
    return {
      serverSlug: toServerSlug(instanceId),
      eventId: requestId,
      ipv4: ipv4FromInstance(instance) || null,
      status: mapContaboStatus(stringField(instance, "status")),
      source: this.sourceMetadata(now, true)
    };
  }

  /**
   * Estado + IP de una instancia por su slug (`contabo-<instanceId>`). Strip del
   * prefijo, GET /v1/compute/instances/{id}, mapeo de status y de IPv4
   * (`ipConfig.v4.ip`, vacia hasta running).
   */
  async getServer(slug: string): Promise<WebdockServer> {
    this.assertReadable();
    const instanceId = fromServerSlug(slug);
    const response = await this.computeFetch(
      `/v1/compute/instances/${encodeURIComponent(instanceId)}`,
      { method: "GET" }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw this.classifyContaboFailure(response.status, body, {
        phase: "get_instance",
        instanceId
      });
    }
    const raw = (await response.json().catch(() => ({}))) as unknown;
    const instance = pickFirstInstance(raw);
    return this.toWebdockServer(instance, instanceId);
  }

  /**
   * Inventario de la cuenta: GET /v1/compute/instances (paginado). Usado para
   * idempotencia por hostname (resolveExistingServerForCreate) y para el
   * governor (conteo por creationDate).
   */
  async listServers(): Promise<WebdockInventoryResult> {
    const now = this.now();
    if (this.inventoryCache && this.inventoryCache.expiresAt > now.getTime()) {
      return this.inventoryCache.result;
    }

    if (!this.isLive()) {
      const result = {
        servers: [],
        source: this.sourceMetadata(now, false, "Contabo credentials missing")
      };
      this.cacheInventory(now, result);
      return result;
    }

    try {
      const servers: WebdockServer[] = [];
      let page = 1;
      const size = 100;
      // Limite duro de paginas para no quemar rate-limit ante respuestas raras.
      const maxPages = 50;
      while (page <= maxPages) {
        const response = await this.computeFetch(
          `/v1/compute/instances?page=${page}&size=${size}`,
          { method: "GET" }
        );
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const result = {
            servers,
            source: this.sourceMetadata(
              now,
              false,
              contaboHttpErrorReason(response.status, body)
            )
          };
          this.cacheInventory(now, result);
          return result;
        }
        const raw = (await response.json().catch(() => ({}))) as unknown;
        const instances = pickInstanceArray(raw);
        for (const instance of instances) {
          const instanceId = numberOrStringId(instance, "instanceId");
          if (instanceId === undefined) continue;
          servers.push(this.toWebdockServer(instance, String(instanceId)));
        }
        if (instances.length < size) break;
        page += 1;
      }
      const result = { servers, source: this.sourceMetadata(now, true) };
      this.cacheInventory(now, result);
      return result;
    } catch (error) {
      const result = {
        servers: [],
        source: this.sourceMetadata(now, false, contaboErrorReason(error))
      };
      this.cacheInventory(now, result);
      return result;
    }
  }

  /**
   * Cancela una instancia: POST /v1/compute/instances/{id}/cancel.
   *
   * IMPORTANTE: el cancel de Contabo es FIN-DE-TERMINO, NO destruccion
   * inmediata. La instancia sigue facturable y operativa hasta el fin de su
   * periodo de contrato; NO se libera al instante como un delete Webdock. El
   * status devuelto es "deleting" por consistencia con el contrato, pero la
   * baja real es diferida (ver result.note y el GAP de rollback documentado en
   * el prompt Codex seccion 4/7).
   */
  async deleteServer(slug: string): Promise<WebdockDeleteServerResult> {
    this.assertWritable();
    const now = this.now();
    const instanceId = fromServerSlug(slug);
    const response = await this.computeFetch(
      `/v1/compute/instances/${encodeURIComponent(instanceId)}/cancel`,
      { method: "POST" }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw this.classifyContaboFailure(response.status, body, {
        phase: "cancel_instance",
        instanceId
      });
    }
    const raw =
      response.status === 204
        ? {}
        : ((await response.json().catch(() => ({}))) as unknown);
    const instance = pickFirstInstance(raw);
    const eventId =
      response.headers.get("x-request-id") ??
      stringField(instance, "requestId") ??
      stringFromUnknown(raw, "requestId") ??
      instanceId;

    this.invalidateInventoryCache();
    return {
      serverSlug: toServerSlug(instanceId),
      eventId,
      // Cancel = baja fin-de-termino, NO destruccion inmediata.
      status: "deleting",
      source: {
        ...this.sourceMetadata(now, true),
        // Pista legible para el gateway/audit del comportamiento diferido.
        errorMessage:
          "Contabo cancel is end-of-term: instance remains billable/active until the contract period ends (not an instant destroy)."
      }
    };
  }

  /**
   * En Contabo el acceso SSH se inyecta en la CREACION via la Secrets API: la
   * pubkey se sube como secret type "ssh" y se referencia en sshKeys[]. No hay
   * shellUsers que crear post-hoc como en Webdock. Esta llamada asegura (o
   * crea) el secret y devuelve un result con forma compatible: publicKeyId = el
   * secretId Contabo, username = root (default), y los campos de shell user en
   * null (no aplican).
   */
  async ensureServerSshAccess(opts: {
    serverSlug: string;
    publicKey: string;
    username?: string;
  }): Promise<WebdockEnsureSshAccessResult> {
    this.assertWritable();
    const publicKey = normalizePublicKey(opts.publicKey);
    const secretId = await this.ensureSshSecret(publicKey);
    return {
      publicKeyId: secretId,
      username: normalizeEnvValue(opts.username) ?? this.defaultUser,
      // Contabo no usa shellUsers separados: no hay id ni eventos de shell.
      shellUserId: null,
      shellUserEventId: null,
      sshSettingsEventId: null
    };
  }

  /**
   * Edita el PTR/rDNS IPv4 por API. Contabo crea PTRs IPv4 por defecto
   * (vmi*.contaboserver.net), asi que para SMTP se actualiza idempotentemente.
   */
  async setReverseDns(ip: string, hostname: string): Promise<{ ok: boolean; status: number; detail?: string }> {
    this.assertWritable();
    const normalizedIp = normalizeContaboPtrIpv4(ip);
    const normalizedHostname = normalizeContaboPtrHostname(hostname);
    const response = await this.computeFetch(`/v1/dns/ptrs/${encodeURIComponent(normalizedIp)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ptr: normalizedHostname })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        detail: sanitizeErrorDetail(`${response.statusText} | ${body}`).slice(0, 300)
      };
    }
    return { ok: true, status: response.status };
  }

  /**
   * Clasifica un fallo de la API Contabo. Mapea 402/403 + payment/quota/
   * insufficient/credit a un codigo RECUPERABLE ("contabo_payment_failed") para
   * que el failover del gateway lo trate como webdock_payment_failed (elegir
   * otra cuenta/proveedor). El resto es no-recuperable. Devuelve un
   * ContaboAdapterError tipado (con .recoverable) que el gateway puede leer.
   */
  classifyContaboFailure(
    status: number,
    body: string,
    metadata: Record<string, unknown> = {}
  ): ContaboAdapterError {
    const haystack = body.toLowerCase();
    const looksLikePayment =
      status === 402 ||
      status === 403 ||
      /payment|insufficient|quota|credit|balance|funds|limit reached|not enough/.test(
        haystack
      );
    if (looksLikePayment) {
      return new ContaboAdapterError("contabo_payment_failed", {
        recoverable: true,
        status,
        metadata: { ...metadata, body: sanitizeErrorDetail(body).slice(0, 600) }
      });
    }
    return new ContaboAdapterError("contabo_api_error", {
      recoverable: false,
      status,
      metadata: { ...metadata, body: sanitizeErrorDetail(body).slice(0, 600) }
    });
  }

  /** Borra el token cacheado (tests / rotacion forzada). */
  invalidateToken(): void {
    this.token = null;
  }

  // --- internos ---------------------------------------------------------

  private assertReadable(): void {
    if (!this.isLive()) {
      throw new ContaboAdapterError("contabo_credentials_missing", {
        recoverable: false
      });
    }
  }

  private assertWritable(): void {
    if (!this.canWrite()) {
      throw new ContaboAdapterError("contabo_credentials_missing", {
        recoverable: false
      });
    }
  }

  /**
   * Devuelve un access_token vigente. Reusa el cacheado si aun no expira (con
   * skew); si no, re-pide al endpoint de token (password grant). Se llama ANTES
   * de cada call compute porque el TTL Keycloak es corto (~5min) y el poll de
   * provisioning dura minutos.
   */
  private async ensureToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.token && this.token.expiresAt > nowMs) {
      return this.token.accessToken;
    }
    if (this.tokenPromise) {
      return this.tokenPromise;
    }

    this.tokenPromise = this.fetchTokenWithRetry().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  private async fetchTokenWithRetry(): Promise<string> {
    const form = new URLSearchParams({
      client_id: this.clientId ?? "",
      client_secret: this.clientSecret ?? "",
      username: this.username ?? "",
      password: this.password ?? "",
      grant_type: "password"
    });

    for (let attempt = 0; attempt <= TOKEN_GRANT_MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.authUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json"
          },
          body: form.toString()
        });
      } catch (error) {
        if (attempt < TOKEN_GRANT_MAX_RETRIES) {
          await this.sleepFn(retryDelayMs(undefined, attempt));
          continue;
        }
        throw new ContaboAdapterError("contabo_token_request_failed", {
          recoverable: true,
          metadata: {
            errorReason: "network",
            errorName: error instanceof Error ? error.name : "UnknownError"
          }
        });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const oauthError = oauthErrorCode(body);
        if (response.status === 401 && oauthError === "invalid_grant") {
          throw new ContaboAdapterError("contabo_token_invalid_grant", {
            recoverable: false,
            status: response.status,
            metadata: {
              errorReason: "401_invalid_grant",
              operatorAction: "review CONTABO_API_PASSWORD in gateway.env",
              body: sanitizeErrorDetail(body).slice(0, 600)
            }
          });
        }
        if (shouldRetryTokenGrant(response.status) && attempt < TOKEN_GRANT_MAX_RETRIES) {
          await this.sleepFn(retryDelayMs(response, attempt));
          continue;
        }
        throw new ContaboAdapterError("contabo_token_request_failed", {
          recoverable: response.status === 429 || response.status >= 500,
          status: response.status,
          metadata: {
            errorReason: contaboHttpErrorReason(response.status, body),
            body: sanitizeErrorDetail(body).slice(0, 600)
          }
        });
      }

      const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const accessToken =
        typeof raw.access_token === "string" ? raw.access_token : undefined;
      if (!accessToken) {
        // El cuerpo del token-grant puede traer access_token/refresh_token (incluso parcialmente,
        // p.ej. sin access_token pero con refresh_token). Redactarlos ANTES de truncateRaw para que
        // ningun token se filtre a metadata de error/logs/audit.
        throw new ContaboAdapterError("contabo_token_missing_access_token", {
          recoverable: false,
          metadata: { raw: truncateRaw(redactTokenFields(raw)) }
        });
      }
      const expiresInSec =
        typeof raw.expires_in === "number" && Number.isFinite(raw.expires_in)
          ? raw.expires_in
          : 300;
      const nowMs = this.now().getTime();
      this.token = {
        accessToken,
        expiresAt: nowMs + expiresInSec * 1000 - TOKEN_REFRESH_SKEW_MS
      };
      return accessToken;
    }
    throw new ContaboAdapterError("contabo_token_request_failed", {
      recoverable: true,
      metadata: { errorReason: "retry_exhausted" }
    });
  }

  /**
   * fetch a api.contabo.com asegurando token fresco + headers obligatorios:
   * Authorization: Bearer, x-request-id (uuid4 REQUERIDO), Content-Type, Accept.
   */
  private async computeFetch(path: string, init: RequestInit): Promise<Response> {
    let unauthorizedRetried = false;
    for (let attempt = 0; attempt <= COMPUTE_MAX_RETRIES; attempt += 1) {
      const token = await this.ensureToken();
      const headers: Record<string, string> = {
        ...((init.headers as Record<string, string> | undefined) ?? {}),
        authorization: `Bearer ${token}`,
        "x-request-id": randomUUID(),
        "content-type": "application/json",
        accept: "application/json"
      };
      try {
        const response = await this.fetchImpl(`${this.apiBase}${path}`, { ...init, headers });
        if (response.status === 401 && !unauthorizedRetried) {
          unauthorizedRetried = true;
          this.invalidateToken();
          continue;
        }
        if (shouldRetryCompute(response.status) && attempt < COMPUTE_MAX_RETRIES) {
          await this.sleepFn(retryDelayMs(response, attempt));
          continue;
        }
        return response;
      } catch (error) {
        if (attempt < COMPUTE_MAX_RETRIES) {
          await this.sleepFn(retryDelayMs(undefined, attempt));
          continue;
        }
        throw new ContaboAdapterError("contabo_api_network_error", {
          recoverable: true,
          metadata: {
            errorReason: "network",
            path,
            errorName: error instanceof Error ? error.name : "UnknownError"
          }
        });
      }
    }
    throw new ContaboAdapterError("contabo_api_error", {
      recoverable: true,
      metadata: { errorReason: "retry_exhausted", path }
    });
  }

  /**
   * Asegura que la pubkey exista como secret SSH en la cuenta y devuelve su
   * secretId. Dedupe por nombre: GET /v1/secrets?type=ssh&name=<label>; si no
   * existe, POST /v1/secrets {name,type:"ssh",value:pubkey}.
   */
  private async ensureSshSecret(publicKey: string): Promise<number> {
    const name = `${SSH_SECRET_NAME_PREFIX}-${publicKeyFingerprint(publicKey)}`;

    const existing = await this.computeFetch(
      `/v1/secrets?type=ssh&name=${encodeURIComponent(name)}`,
      { method: "GET" }
    );
    if (existing.ok) {
      const raw = (await existing.json().catch(() => ({}))) as unknown;
      const found = findSecretId(raw, name);
      if (found !== undefined) {
        return found;
      }
    } else if (existing.status !== 404) {
      const body = await existing.text().catch(() => "");
      throw this.classifyContaboFailure(existing.status, body, {
        phase: "find_ssh_secret"
      });
    }

    const created = await this.computeFetch("/v1/secrets", {
      method: "POST",
      body: JSON.stringify({ name, type: "ssh", value: publicKey })
    });
    if (!created.ok) {
      const body = await created.text().catch(() => "");
      throw this.classifyContaboFailure(created.status, body, {
        phase: "create_ssh_secret"
      });
    }
    const raw = (await created.json().catch(() => ({}))) as unknown;
    const secretId = findSecretId(raw, name) ?? firstSecretId(raw);
    if (secretId === undefined) {
      throw new ContaboAdapterError("contabo_secret_missing_id", {
        metadata: { raw: truncateRaw(raw) }
      });
    }
    return secretId;
  }

  /**
   * Resuelve el imageId UUID de Ubuntu 22.04. Si la config trae uno fijo, lo
   * usa. Si no, GET /v1/compute/images?standardImage=true&name=Ubuntu y elige
   * Ubuntu 22.04 (NO se hardcodea el UUID: puede rotar). Se cachea por instancia.
   */
  private async resolveImageId(): Promise<string> {
    if (this.resolvedImageId) {
      return this.resolvedImageId;
    }
    const response = await this.computeFetch(
      "/v1/compute/images?standardImage=true&name=Ubuntu&size=100",
      { method: "GET" }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw this.classifyContaboFailure(response.status, body, {
        phase: "resolve_image"
      });
    }
    const raw = (await response.json().catch(() => ({}))) as unknown;
    const imageId = pickUbuntuImageId(raw);
    if (!imageId) {
      throw new ContaboAdapterError("contabo_ubuntu_image_not_found", {
        metadata: { raw: truncateRaw(raw) }
      });
    }
    this.resolvedImageId = imageId;
    return imageId;
  }

  private toWebdockServer(
    instance: Record<string, unknown> | undefined,
    instanceId: string
  ): WebdockServer {
    const displayName = stringField(instance, "displayName");
    const instanceName = stringField(instance, "name");
    return {
      slug: toServerSlug(instanceId),
      name: displayName ?? instanceName ?? `contabo-${instanceId}`,
      ipv4: ipv4FromInstance(instance),
      ipv6: ipv6FromInstance(instance),
      status: mapContaboStatus(stringField(instance, "status")),
      location: stringField(instance, "region") ?? this.region,
      creationDate: stringField(instance, "createdDate") ?? stringField(instance, "creationDate"),
      imageSlug: stringField(instance, "imageId"),
      hostname: displayName ?? instanceName,
      mainDomain: displayName,
      accountId: this.accountId,
      accountLabel: this.accountLabel
    };
  }

  private sourceMetadata(
    now: Date,
    responseOk: boolean,
    errorMessage?: string
  ): WebdockInventorySource {
    return {
      kind: "live",
      apiBase: this.apiBase,
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

/**
 * Factory que espeja `createWebdockAdaptersFromEnv`. Lee SOLO las 4 creds
 * OAuth2 Contabo (+ region/product/label opcionales) de env, con disciplina
 * `normalizeEnvValue` (trim, vacio->undefined). NO lee NINGUNA key WEBDOCK_*.
 * Con las 4 creds flat presentes devuelve el VpsProviderEntry id="contabo";
 * cuentas adicionales via CONTABO_ACCOUNT_{n}_* (id="contabo-{n}"). Sin
 * ninguna credencial devuelve [].
 */
export function createContaboAdaptersFromEnv(
  env: Record<string, string | undefined> =
    typeof process !== "undefined" ? process.env : {}
): VpsProviderEntry[] {
  const entries: VpsProviderEntry[] = [];

  const clientId = normalizeEnvValue(env.CONTABO_CLIENT_ID);
  const clientSecret = normalizeEnvValue(env.CONTABO_CLIENT_SECRET);
  const username = normalizeEnvValue(env.CONTABO_API_USER);
  const password = normalizeEnvValue(env.CONTABO_API_PASSWORD);

  if (clientId && clientSecret && username && password) {
    const label = normalizeEnvValue(env.CONTABO_ACCOUNT_LABEL) ?? "Contabo Host Latam";
    const adapter = new ContaboAdapter({
      clientId,
      clientSecret,
      username,
      password,
      region: normalizeEnvValue(env.CONTABO_REGION) ?? DEFAULT_REGION,
      productId: normalizeEnvValue(env.CONTABO_PRODUCT_ID),
      imageId: normalizeEnvValue(env.CONTABO_IMAGE_ID),
      accountId: "contabo",
      accountLabel: label
    });
    entries.push({ id: "contabo", label, adapter });
  }

  // Cuentas adicionales indexadas: CONTABO_ACCOUNT_{n}_CLIENT_ID/CLIENT_SECRET/
  // API_USER/API_PASSWORD (+ _LABEL/_REGION/_PRODUCT_ID/_IMAGE_ID opcionales con
  // fallback a los globales). Huecos de numeracion permitidos para poder retirar
  // una cuenta sin renumerar. La cuenta flat de arriba sigue siendo id="contabo"
  // (byte-identica); las indexadas son id="contabo-{n}".
  for (let index = 1; index <= MAX_INDEXED_ACCOUNTS; index += 1) {
    const readKey = (key: string): string | undefined =>
      normalizeEnvValue(env[`CONTABO_ACCOUNT_${index}_${key}`]);

    const accountClientId = readKey("CLIENT_ID");
    const accountClientSecret = readKey("CLIENT_SECRET");
    const accountUsername = readKey("API_USER");
    const accountPassword = readKey("API_PASSWORD");
    if (!accountClientId || !accountClientSecret || !accountUsername || !accountPassword) {
      continue;
    }
    if ((readKey("STATUS") ?? "active").toLowerCase() === "deprecated") {
      continue;
    }

    const label = readKey("LABEL") ?? `Contabo #${index}`;
    const adapter = new ContaboAdapter({
      clientId: accountClientId,
      clientSecret: accountClientSecret,
      username: accountUsername,
      password: accountPassword,
      region: readKey("REGION") ?? normalizeEnvValue(env.CONTABO_REGION) ?? DEFAULT_REGION,
      productId: readKey("PRODUCT_ID") ?? normalizeEnvValue(env.CONTABO_PRODUCT_ID),
      imageId: readKey("IMAGE_ID") ?? normalizeEnvValue(env.CONTABO_IMAGE_ID),
      accountId: `contabo-${index}`,
      accountLabel: label
    });
    entries.push({ id: `contabo-${index}`, label, adapter });
  }

  return entries;
}

const MAX_INDEXED_ACCOUNTS = 50;

/**
 * Alias de MIGRACIÓN flat<->indexada-1. Si el operador mueve las credenciales de la cuenta
 * flat (CONTABO_*) a la forma indexada (CONTABO_ACCOUNT_1_*) — o al revés — el providerId
 * cambia de "contabo" a "contabo-1" y cualquier RESUME de un run persistido con el id viejo
 * muere con unknown_vps_provider. Este alias registra el id faltante apuntando al MISMO
 * adapter, SOLO cuando existe exactamente una de las dos formas (con ambas presentes son
 * cuentas distintas y aliasear enrutaría a otra cuenta: null). Los runs nuevos siguen
 * persistiendo el id real de su entry; el alias solo resuelve resumes.
 */
export function contaboMigrationAlias(
  entries: VpsProviderEntry[]
): { aliasId: string; adapter: VpsProvider } | null {
  const flat = entries.find((entry) => entry.id === "contabo");
  const indexed1 = entries.find((entry) => entry.id === "contabo-1");
  if (flat && !indexed1) return { aliasId: "contabo-1", adapter: flat.adapter };
  if (indexed1 && !flat) return { aliasId: "contabo", adapter: indexed1.adapter };
  return null;
}

// --- helpers puros --------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNonNegativeMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function shouldRetryTokenGrant(status: number): boolean {
  return status === 429 || status >= 500;
}

function shouldRetryCompute(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = parseRetryAfterMs(response?.headers.get("retry-after"));
  if (retryAfter !== null) {
    return Math.min(retryAfter, MAX_RETRY_AFTER_MS);
  }
  return Math.min(250 * 2 ** attempt, MAX_RETRY_AFTER_MS);
}

function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate)) return null;
  return Math.max(0, parsedDate - Date.now());
}

function oauthErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

function contaboHttpErrorReason(status: number, body = ""): string {
  if (status === 429) return "429_rate_limited";
  if (status === 401 && oauthErrorCode(body) === "invalid_grant") return "401_invalid_grant";
  if (status === 401) return "401_unauthorized";
  if (status >= 500) return "5xx_server_error";
  return `contabo_http_${status}`;
}

function contaboErrorReason(error: unknown): string {
  if (error instanceof ContaboAdapterError) {
    const reason = error.metadata.errorReason;
    return typeof reason === "string" ? reason : error.code;
  }
  return error instanceof Error ? sanitizeErrorDetail(error.message) : "contabo_unknown_error";
}

function sanitizeErrorDetail(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** `contabo-<id>` para pasar el regex de slug del orquestador. */
function toServerSlug(instanceId: number | string): string {
  return `contabo-${instanceId}`;
}

/** Quita el prefijo `contabo-` y valida que quede un id no vacio. */
function fromServerSlug(slug: string): string {
  const trimmed = slug.trim();
  const id = trimmed.startsWith("contabo-") ? trimmed.slice("contabo-".length) : trimmed;
  if (!id) {
    throw new ContaboAdapterError("contabo_invalid_server_slug", {
      metadata: { slug }
    });
  }
  return id;
}

/**
 * Mapea el enum de status Contabo (provisioning/installing/running/stopped/
 * error/...) a un WebdockServerStatus. Conserva los desconocidos como string.
 */
function mapContaboStatus(status: string | undefined): WebdockServerStatus {
  switch ((status ?? "").toLowerCase()) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "provisioning":
    case "installing":
    case "pending_payment":
    case "manual_provisioning":
      return "provisioning";
    case "rescue":
    case "rebooting":
      return "rebooting";
    case "uninstalled":
    case "cancelled":
    case "canceled":
      return "deleting";
    case "error":
      return "error";
    default:
      return status && status.length > 0 ? status : "provisioning";
  }
}

/**
 * Contabo envuelve casi todo en { data: [ ... ] }. Devuelve el primer objeto
 * de data, o el propio objeto si no hay envoltura.
 */
function pickFirstInstance(raw: unknown): Record<string, unknown> | undefined {
  const arr = pickInstanceArray(raw);
  if (arr.length > 0) return arr[0];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

/** Extrae el array `data` (o el array crudo) de una respuesta Contabo. */
function pickInstanceArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object")
    );
  }
  if (raw && typeof raw === "object") {
    const data = (raw as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      return data.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object")
      );
    }
  }
  return [];
}

/** IPv4 de una instancia Contabo: ipConfig.v4.ip. */
function ipv4FromInstance(instance: Record<string, unknown> | undefined): string {
  const ipConfig = nestedObject(instance, "ipConfig");
  const v4 = nestedObject(ipConfig, "v4");
  return stringField(v4, "ip") ?? "";
}

/** IPv6 de una instancia Contabo: ipConfig.v6.ip. */
function ipv6FromInstance(instance: Record<string, unknown> | undefined): string | undefined {
  const ipConfig = nestedObject(instance, "ipConfig");
  const v6 = nestedObject(ipConfig, "v6");
  return stringField(v6, "ip");
}

/**
 * Elige el imageId UUID de Ubuntu 22.04 de una respuesta de imagenes. Prefiere
 * 22.04; si no aparece, cae al primer Ubuntu disponible.
 */
function pickUbuntuImageId(raw: unknown): string | undefined {
  const images = pickInstanceArray(raw);
  const ubuntu2204 = images.find((image) => {
    const name = (stringField(image, "name") ?? "").toLowerCase();
    return name.includes("ubuntu") && name.includes("22.04");
  });
  const chosen = ubuntu2204 ?? images.find((image) =>
    (stringField(image, "name") ?? "").toLowerCase().includes("ubuntu")
  );
  return chosen ? stringField(chosen, "imageId") : undefined;
}

/** Busca un secret SSH por nombre exacto en la respuesta y devuelve su secretId. */
function findSecretId(raw: unknown, name: string): number | undefined {
  const secrets = pickInstanceArray(raw);
  const match = secrets.find((secret) => stringField(secret, "name") === name);
  return match ? numberField(match, "secretId") : undefined;
}

/** Devuelve el secretId del primer secret de la respuesta (fallback post-POST). */
function firstSecretId(raw: unknown): number | undefined {
  const secrets = pickInstanceArray(raw);
  return secrets.length > 0 ? numberField(secrets[0], "secretId") : undefined;
}

function numberOrStringId(
  obj: Record<string, unknown> | undefined,
  key: string
): number | string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return undefined;
}

function nestedObject(
  obj: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  obj: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringFromUnknown(raw: unknown, key: string): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return stringField(raw as Record<string, unknown>, key);
}

function numberField(
  obj: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function truncateRaw(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 600);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Reemplaza cualquier campo de token sensible (access_token/refresh_token/id_token) por "[redacted]"
 * antes de serializar a metadata de error. Devuelve una COPIA superficial; no muta el original.
 * Solo aplica al cuerpo del token-grant de Keycloak, que es el unico raw que puede traer tokens.
 */
function redactTokenFields(raw: Record<string, unknown>): Record<string, unknown> {
  const sensitive = new Set(["access_token", "refresh_token", "id_token"]);
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    redacted[key] = sensitive.has(key) ? "[redacted]" : value;
  }
  return redacted;
}

function normalizePublicKey(value: string): string {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/.test(
      normalized
    )
  ) {
    throw new ContaboAdapterError("contabo_invalid_public_key", {
      metadata: { valuePreview: normalized.slice(0, 40) }
    });
  }
  return normalized;
}

function normalizeContaboPtrIpv4(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const octets = trimmed.split(".");
  if (
    octets.length !== 4 ||
    octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)
  ) {
    throw new ContaboAdapterError("contabo_invalid_ptr_input", {
      metadata: { field: "ip", valuePreview: trimmed.slice(0, 40) }
    });
  }
  return octets.map((octet) => String(Number(octet))).join(".");
}

function normalizeContaboPtrHostname(value: string): string {
  const normalized = (typeof value === "string" ? value.trim() : "")
    .replace(/\.$/, "")
    .toLowerCase();
  const labels = normalized.split(".");
  const labelsValid = labels.length >= 2 && labels.every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
  if (!labelsValid || normalized.length > 253) {
    throw new ContaboAdapterError("contabo_invalid_ptr_input", {
      metadata: { field: "hostname", valuePreview: normalized.slice(0, 80) }
    });
  }
  return normalized;
}

/**
 * Fingerprint estable de la pubkey para nombrar el secret de forma deterministica
 * (dedupe). FNV-1a hex de 12 chars: sin deps, suficiente para un label unico.
 */
function publicKeyFingerprint(publicKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < publicKey.length; i += 1) {
    hash ^= publicKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizePeriod(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.trunc(value);
  return [1, 3, 6, 12].includes(rounded) ? rounded : undefined;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function contaboDisplayNameFromHostname(hostname: string): string {
  return hostname.replace(/[^a-zA-Z0-9 -]/g, "-");
}
