# Hito — Provider Fabric: capa unificada multi-proveedor / multi-cuenta

> Fecha de spec: 2026-07-06
> Hito antecesor: 5.13 (Multi-provider inventory — spec sin codificar en su parte genérica)
> Estado: spec + primera implementación (fase A) en rama `feat/provider-fabric`
> Alcance inmediato: puertos de dominio + registry dinámico de cuentas +
> `providerFetch` blindado + adapters **Namecheap (multi-cuenta)** y
> **Contabo (multi-cuenta)**. Solo lectura live; toda mutación nace
> detrás de flag en `false`.

## Changelog

- **v1.0** (2026-07-06) — Spec + fase A implementada. Motivación del
  operador: entran 2 cuentas Namecheap (amortiguar adquisición de
  dominios; Route53 tiene límites de compra) y 1+ cuentas Contabo,
  además del bastión propio en Tampa (Proxmox/LXC). Auditoría previa
  detectó: multicuenta solo en Webdock con 5 ranuras fijas, cero
  interfaz común entre adapters, escrituras sin timeout/retry/breaker,
  y teardown incompleto.

## 1. Propósito

Unificar cómo Delivrix consume proveedores externos (y el fierro propio)
detrás de **tres puertos de dominio** con `accountId` de primera clase,
un **registry dinámico de cuentas** (agregar/pausar/deprecar cuentas sin
tocar código) y un **cliente HTTP blindado** (`providerFetch`) con
timeout, retry idempotente y circuit breaker por cuenta.

Matriz operativa objetivo:

| Puerto | Hoy | Entra ahora | Después |
|---|---|---|---|
| `ComputeProviderPort` | Webdock (5 ranuras) | **Contabo** (N cuentas) | Tampa colo (Proxmox real), RackNerd |
| `DomainRegistrarPort` | Route53, Porkbun, IONOS | **Namecheap** (N cuentas) | — |
| `DnsProviderPort` | Route53, IONOS | — | Namecheap DNS |

## 2. Norte intacto (qué NO cambia)

- **Kill switch** centralizado + fail-closed: sin tocar. La capa nueva
  vive DEBAJO de él.
- **ApprovalGate humano** por mutación: sin tocar.
- **Flags de runtime con hot-reload** (`runtime-env.ts` + `.env.local`
  cada 1s): la capa nueva se suma a este mecanismo, no lo reemplaza.
- **Adapters existentes** (Webdock, Route53, IONOS, Porkbun, Proxmox):
  **ni una línea modificada en fase A**. Siguen siendo el camino vivo.
  Migran al fabric uno por uno en fases posteriores, cada uno detrás
  de su propio flag.
- Credenciales nunca en repo, solo env vars + secret manager local.
- Suite de tests existente: debe seguir 100% verde en cada fase.

## 3. Decisiones de diseño

1. **Puertos en `packages/domain/src/provider-ports.ts`** — contratos
   puros, sin I/O, alineados con `infrastructure-inventory.ts`
   (`ProviderKind`, `ProviderFetchSourceKind` se reutilizan).
2. **Registry por env indexado** — patrón `PROVIDERFABRIC_ACCOUNTS`
   -style no: se usa env indexado explícito por proveedor
   (`NAMECHEAP_ACCOUNT_1_*`, `CONTABO_ACCOUNT_1_*`) porque es el mismo
   patrón mental que las ranuras Webdock pero **sin tope fijo** (se
   escanea 1..N hasta el primer hueco). Cada cuenta lleva
   `status=active|paused|deprecated` vía env
   (`*_ACCOUNT_n_STATUS`, default `active`).
3. **`providerFetch`** — wrapper de `fetch` con:
   - timeout por `AbortController` (default 30 000 ms),
   - retry con backoff exponencial + jitter **solo** si el caller
     declara `idempotent: true` (GETs / lecturas),
   - circuit breaker por clave `provider:accountId` (abre tras 5
     fallos consecutivos, half-open a los 60 s),
   - jamás reintenta mutaciones (crear server, registrar dominio).
4. **Escrituras nacen bloqueadas** — `NAMECHEAP_ENABLE_PURCHASE=false`,
   `CONTABO_INSTANCES_ENABLE_CREATE=false`,
   `CONTABO_INSTANCES_ENABLE_DELETE=false`. Se registran en
   `runtimeFlagKeys` para hot-reload y para que el kill switch y los
   blockers de ruta los vean cuando se cableen rutas.
5. **Sin dependencias nuevas** — Namecheap responde XML: se parsea con
   helpers propios acotados (mismo espíritu que los parsers defensivos
   de `porkbun-adapter.ts`). Contabo usa OAuth2 client-credentials con
   cache de token en memoria.
6. **Fallback mock en lecturas** — igual que Webdock/Porkbun: sin
   credenciales o con la API caída, `listInventory()` devuelve
   `source.kind="mock"` con `errorMessage`, nunca lanza. El panel no
   se cae porque un proveedor esté enfermo.

## 4. Contratos (fase A)

```typescript
// packages/domain/src/provider-ports.ts (resumen)
export interface ProviderAccountRef {
  provider: string;      // "namecheap" | "contabo" | "webdock" | ...
  accountId: string;     // "namecheap-1", "contabo-2", ...
  accountLabel: string;
  status: ProviderAccountStatus; // "active" | "paused" | "deprecated"
}

export interface DomainRegistrarPort {
  readonly account: ProviderAccountRef;
  isLive(): boolean;
  checkAvailability(domainName: string): Promise<RegistrarDomainCandidate>;
  listOwnedDomains(): Promise<RegistrarInventoryResult>;
  registerDomain(input: RegisterDomainInput): Promise<RegisterDomainResult>; // gated
}

export interface ComputeProviderPort {
  readonly account: ProviderAccountRef;
  isLive(): boolean;
  listServers(): Promise<ComputeInventoryResult>;
  createServer(spec: ComputeServerSpec): Promise<ComputeServerResult>;  // gated
  deleteServer(ref: ComputeServerRef): Promise<ComputeServerResult>;   // gated
}
```

`paused` ⇒ el registry no entrega la cuenta para provisiones nuevas
(lecturas siguen). `deprecated` ⇒ tampoco lecturas por default; queda
solo para generar plan de teardown (fase C, ledger).

## 5. Variables de entorno (fase A)

```bash
# Namecheap — N cuentas indexadas. Compra SIEMPRE gated.
NAMECHEAP_ACCOUNT_1_API_USER=...
NAMECHEAP_ACCOUNT_1_API_KEY=...
NAMECHEAP_ACCOUNT_1_USERNAME=...        # default: API_USER
NAMECHEAP_ACCOUNT_1_CLIENT_IP=...       # IP whitelisteada en Namecheap
NAMECHEAP_ACCOUNT_1_LABEL="Namecheap Principal"
NAMECHEAP_ACCOUNT_1_STATUS=active
NAMECHEAP_ACCOUNT_2_API_USER=...
NAMECHEAP_ACCOUNT_2_API_KEY=...
# ...
NAMECHEAP_BASE_URL=https://api.namecheap.com/xml.response
NAMECHEAP_ENABLE_PURCHASE=false

# Contabo — N cuentas indexadas. Mutaciones SIEMPRE gated.
CONTABO_ACCOUNT_1_CLIENT_ID=...
CONTABO_ACCOUNT_1_CLIENT_SECRET=...
CONTABO_ACCOUNT_1_API_USER=...
CONTABO_ACCOUNT_1_API_PASSWORD=...
CONTABO_ACCOUNT_1_LABEL="Contabo Ops"
CONTABO_ACCOUNT_1_STATUS=active
CONTABO_INSTANCES_ENABLE_CREATE=false
CONTABO_INSTANCES_ENABLE_DELETE=false

# providerFetch
PROVIDER_FETCH_TIMEOUT_MS=30000
PROVIDER_FETCH_MAX_RETRIES=2
```

## 6. Plan por fases con REVERSA explícita

| Fase | Qué entra | Cómo se revierte | Riesgo a lo existente |
|---|---|---|---|
| **A (esta rama)** | Puertos + registry + `providerFetch` + adapters Namecheap/Contabo + flags. **Nada existente se modifica**; solo archivos nuevos + registro de flags + export en barrel. | `git revert` del merge, o simplemente no poner las env vars (sin credenciales todo queda en mock). | **Cero por construcción**: ningún camino vivo pasa por código nuevo. Prueba: suite completa verde sin tocar un test existente. |
| **B** | Cablear rutas read-only de inventario Namecheap/Contabo al gateway (fleet view unificada). | Quitar las env vars de las cuentas (adapter cae a mock) o revertir el commit de wiring. | Bajo: rutas nuevas, no se tocan las existentes. |
| **C** | Ledger de recursos + plan de teardown ejecutable (aprobación humana). | Ledger es append-only y pasivo; se desactiva con su flag. | Bajo. |
| **D** | Migrar Webdock al fabric detrás de `PROVIDER_FABRIC_ENABLE_WEBDOCK` (default `false`). Tests de paridad: mismo input ⇒ misma llamada HTTP que el adapter viejo. Canario: 1 cuenta no crítica, días de observación. | Flag a `false` en `.env.local` ⇒ camino viejo en ~1 s, sin redeploy. | Medio-controlado: swap reversible por flag; el código viejo NO se borra hasta que el canario cierre limpio. |
| **E** | Tampa colo: `proxmox-adapter` real implementando `ComputeProviderPort` (hoy es simulación). Route53/IONOS/Porkbun migran igual que D. | Igual que D: flag por proveedor. | Medio-controlado. |

Regla dura de todas las fases: **si un test existente falla, no hay
merge**. Regla de reversa: **cada fase debe poder apagarse con env/flag
sin redeploy antes de considerar la siguiente**.

## 7. Qué NO hace la fase A (anti-scope-creep)

- No toca `main.ts` salvo nada (el wiring de rutas es fase B).
- No migra ningún adapter existente.
- No compra dominios ni crea instancias (flags en `false`; además las
  rutas ni existen aún — doble candado).
- No introduce dependencias npm nuevas.
