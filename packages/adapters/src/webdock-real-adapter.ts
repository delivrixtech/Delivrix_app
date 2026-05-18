/**
 * WebdockRealAdapter — cliente HTTP read-only contra la API real de Webdock
 * (https://api.webdock.io/v1).
 *
 * Hito 5.11.A. Reemplaza progresivamente los mocks del Canvas con datos
 * vivos del proveedor. Solo lee — no expone métodos de mutación contra
 * Webdock. El bundle frontend sigue GET-only.
 *
 * Fallback: si `WEBDOCK_API_KEY` no está presente en el entorno, devuelve un
 * snapshot mock canónico para que el panel siga funcionando en desarrollo
 * sin necesidad de tocar la cuenta real.
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
}

export interface WebdockInventorySource {
  kind: "live" | "mock";
  apiBase: string;
  fetchedAt: string;
  /** Cuando `kind === "live"`, indica si la API respondió 200. False = degraded. */
  responseOk: boolean;
  errorMessage?: string;
}

export interface WebdockInventoryResult {
  servers: WebdockServer[];
  source: WebdockInventorySource;
}

const DEFAULT_API_BASE = "https://api.webdock.io/v1";
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  result: WebdockInventoryResult;
}

export interface WebdockRealAdapterOptions {
  /** Key del proveedor. Si no se pasa, se lee de process.env.WEBDOCK_API_KEY. */
  apiKey?: string;
  /** Base URL para tests. Default https://api.webdock.io/v1. */
  apiBase?: string;
  /** Cache TTL en milisegundos. Default 60_000. */
  cacheTtlMs?: number;
  /** Fetch impl para tests (default global fetch). */
  fetchImpl?: typeof fetch;
  /** Override del proveedor de timestamps (para tests). */
  now?: () => Date;
}

export class WebdockRealAdapter {
  private readonly apiKey: string | undefined;
  private readonly apiBase: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cache: CacheEntry | null = null;

  constructor(options: WebdockRealAdapterOptions = {}) {
    this.apiKey =
      options.apiKey ??
      (typeof process !== "undefined" ? process.env?.WEBDOCK_API_KEY : undefined);
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  isLive(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 0);
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

    if (!this.isLive()) {
      const result: WebdockInventoryResult = {
        servers: mockWebdockServers(),
        source: {
          kind: "mock",
          apiBase: this.apiBase,
          fetchedAt: now.toISOString(),
          responseOk: true
        }
      };
      this.cacheResult(now, result);
      return result;
    }

    try {
      const response = await this.fetchImpl(`${this.apiBase}/servers`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          "user-agent": "Delivrix-MailOps/0.1 (webdock-collector)"
        }
      });

      if (!response.ok) {
        const errorMessage = `Webdock API returned ${response.status} ${response.statusText}`;
        const result: WebdockInventoryResult = {
          servers: mockWebdockServers(),
          source: {
            kind: "mock",
            apiBase: this.apiBase,
            fetchedAt: now.toISOString(),
            responseOk: false,
            errorMessage
          }
        };
        this.cacheResult(now, result);
        return result;
      }

      const raw = (await response.json()) as unknown;
      const servers = parseWebdockServers(raw);
      const result: WebdockInventoryResult = {
        servers,
        source: {
          kind: "live",
          apiBase: this.apiBase,
          fetchedAt: now.toISOString(),
          responseOk: true
        }
      };
      this.cacheResult(now, result);
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown Webdock fetch error";
      const result: WebdockInventoryResult = {
        servers: mockWebdockServers(),
        source: {
          kind: "mock",
          apiBase: this.apiBase,
          fetchedAt: now.toISOString(),
          responseOk: false,
          errorMessage
        }
      };
      this.cacheResult(now, result);
      return result;
    }
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

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
      profileSlug: "webdockepyc-bit-2",
      location: "fi-hel-2",
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
      profileSlug: "webdockepyc-bit-2",
      location: "fi-hel-2",
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
