import type {
  WebdockCreateServerInput,
  WebdockCreateServerResult,
  WebdockDeleteServerResult,
  WebdockEnsureSshAccessResult,
  WebdockInventoryResult,
  WebdockServer
} from "./webdock-real-adapter.ts";

/**
 * Superficie de capacidades de un proveedor de VPS (Webdock, Contabo, ...).
 *
 * Diseno deliberado:
 * - Reusa los tipos de resultado ya existentes (WebdockCreateServerResult,
 *   WebdockServer, etc.) que son estructuralmente genericos (serverSlug, ipv4,
 *   status, source). Asi `WebdockRealAdapter` satisface esta interface SIN cambios,
 *   y un `VpsProvider` es asignable al `WebdockServerCreateAdapter &
 *   Partial<WebdockServerDeleteAdapter>` que consume el dispatcher (tipado estructural).
 * - `createServer` recibe el input con VOCABULARIO WEBDOCK (profile/locationId/
 *   imageSlug). Los adapters NO-Webdock TRADUCEN ese input a su propia API por dentro
 *   (Contabo: profile->productId, locationId->region, imageSlug->imageId UUID), usando
 *   su propia configuracion (region/product/image por env). Esto mantiene los `params`
 *   del step 4 del orquestador BYTE-IDENTICOS -> el `inputHash` y la plan-signature del
 *   camino Webdock NO cambian (invariante de no-regresion).
 *
 * El proveedor se selecciona por un canal paralelo `providerId` (hermano de
 * `serverAccountId`), NUNCA dentro de `params`.
 */
export interface VpsProvider {
  /** True si el adapter apunta a una API real (no mock). */
  isLive(): boolean;
  /** True si las credenciales permiten operaciones de escritura. */
  canWrite?(): boolean;
  /** True si el adapter puede crear servers (write + cuenta propia). */
  canCreate?(): boolean;
  /** Crea (compra) un VPS. El input viene en vocabulario Webdock; los adapters no-Webdock lo traducen. */
  createServer(opts: WebdockCreateServerInput): Promise<WebdockCreateServerResult>;
  /** Estado + IP de un server por su slug/id (para el poll de provisioning). */
  getServer(slug: string): Promise<WebdockServer>;
  /** Inventario de la cuenta (para idempotencia por hostname y para el governor por creationDate). */
  listServers?(): Promise<WebdockInventoryResult>;
  /** Cancela/destruye un VPS (rollback). En Contabo es cancel fin-de-termino, no destruccion inmediata. */
  deleteServer?(slug: string): Promise<WebdockDeleteServerResult>;
  /** Asegura acceso SSH al server. Contabo lo resuelve via cloud-init + Secrets API en la creacion. */
  ensureServerSshAccess?(opts: {
    serverSlug: string;
    publicKey: string;
    username?: string;
  }): Promise<WebdockEnsureSshAccessResult>;
}

/** Una entrada de proveedor lista para el registry: id + adapter. */
export interface VpsProviderEntry {
  /** Identificador estable del proveedor, ej: "contabo". Es la KEY del registry. */
  id: string;
  /** Etiqueta humana visible en panel/audit. No contiene secretos. */
  label: string;
  adapter: VpsProvider;
}
