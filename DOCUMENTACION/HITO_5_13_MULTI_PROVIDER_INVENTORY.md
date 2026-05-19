# Hito 5.13 — Multi-provider inventory (post-MVP)

> Fecha de spec: 2026-05-19
> Hito antecesor: 5.11.B (OpenClaw Hostinger Agent)
> Estado: documento de arquitectura, ningún código aún
> Sub-tramo dentro del MVP: **multi-Webdock para 3 cuentas** se cabea en
> días 27-30 del MVP si Hito 5.11.B cierra limpio el día 26. Resto del hito
> (IONOS, Amazon, server físico) cae post-MVP.

## Changelog

- **v1.0** (2026-05-19) — Decisión audited del operador: spec ahora,
  build multi-Webdock en MVP D+8 → D+11, resto post-MVP. Nivel de
  control: solo lectura/inventario, mutaciones a infra real siguen en
  `future_live_requires_new_phase` per Doc 2.

## 1. Propósito

Hoy Delivrix tiene un único adapter (`webdock-inventory`) que asume una
sola cuenta del proveedor. La realidad operativa del operador es:

- **3 cuentas Webdock** (compute, sender nodes).
- **IONOS** (registro de dominios + DNS).
- **Amazon** (registro de dominios alternativo + posible Route53 DNS).
- **Servidor físico propio** (futuro, mientras tanto Webdock cubre).

El agente OpenClaw debe poder leer inventario de los 4 (en realidad 6+
con las multi-cuentas Webdock) como una **única fleet view** para razonar
sobre la operación entera, no por proveedor.

Este hito introduce la abstracción `Provider` + multi-account, define la
contract de inventario unificada, y deja el agente listo para razonar
con visión completa. Mutaciones contra infra real siguen bloqueadas por
el matrix (Doc 2 §3.4) — este hito es **solo lectura**.

## 2. Norte intacto (qué NO cambia)

- GET-only frontend.
- Audit append-only con hash chain (D+5 AM).
- Permissions matrix (Doc 2) sigue siendo gate duro. Toda mutación contra
  cualquier proveedor (crear server Webdock, registrar dominio IONOS,
  comprar dominio Amazon) queda en `future_live_requires_new_phase`.
- Kill switch armado por default.
- Credenciales nunca en repo, solo en env vars + secret manager local.

Este hito **expande lectura, no escritura**. La escritura real contra
proveedores externos es un hito posterior (Hito 6 o superior) con norte
actualizado y kill switch dedicado por proveedor.

## 3. Decisiones audited del operador (2026-05-19)

1. **Auth**: API Keys, no usuario/contraseña, no CLI, no SSH. Por
   proveedor y por cuenta. Almacenamiento env vars con sufijo de
   identificador de cuenta.
2. **Alcance MVP**: solo multi-Webdock (3 cuentas) en días 27-30 si
   tiempo lo permite. IONOS / Amazon / servidor físico documentados en
   este spec pero no implementados en MVP.
3. **Nivel de control**: solo lectura/inventario. El agente puede
   razonar sobre qué hay y dónde, pero no proponer crear/destruir nada
   en estos proveedores. Cualquier propose_* de este tipo queda
   bloqueado por matrix.

## 4. Modelo de datos canónico

### 4.1 Concepto `Provider`

```typescript
type ProviderType = 'compute' | 'dns' | 'domain-registrar' | 'storage' | 'physical';

interface ProviderConfig {
  id: string;                  // ej "webdock-account-1", "ionos-main", "amazon-reg"
  type: ProviderType;
  vendor: string;              // ej "webdock", "ionos", "amazon-route53"
  displayName: string;         // ej "Webdock — Account 1 (EU sender nodes)"
  account: {
    accountRef: string;        // identificador externo (account id del proveedor si aplica)
    credentialEnvVar: string;  // ej "WEBDOCK_API_KEY_ACCOUNT_1"
    baseUrl?: string;          // override si el proveedor lo permite
  };
  capabilities: ProviderCapability[];  // ver §4.2
  status: 'active' | 'paused' | 'deprecated';
  notes?: string;
}

type ProviderCapability =
  | 'list_compute_servers'
  | 'get_compute_server_detail'
  | 'list_dns_zones'
  | 'list_dns_records'
  | 'list_registered_domains'
  | 'list_storage_buckets';
```

### 4.2 Concepto `InventoryItem` (vista canónica unificada)

```typescript
interface InventoryItem {
  // Identidad
  canonicalId: string;         // "compute:webdock-account-1:vps-12345"
  providerId: string;          // "webdock-account-1"
  externalId: string;          // id del proveedor (slug del VPS, dominio, etc)
  kind: 'compute_server' | 'dns_zone' | 'dns_record' | 'domain' | 'storage_bucket' | 'physical_box';

  // Atributos visibles
  displayName: string;
  status: string;              // proveedor-específico, normalizado a labels familiares
  region?: string;
  metadata: Record<string, unknown>;  // específicos del proveedor sin normalizar

  // Cross-references
  linkedSenderNodes?: string[];      // si este compute_server alimenta sender nodes
  linkedDomains?: string[];          // si este dns_record o domain está atado a sender flow

  // Auditoría
  fetchedAt: string;
  fetchSourceKind: 'real' | 'mock_canonical';
  fetchResponseOk: boolean;
}
```

### 4.3 Endpoint nuevo del Gateway

```
GET /v1/infrastructure/inventory
  Auth: Bearer dev (lectura, no requiere HMAC)
  Query params:
    provider_type?: 'compute' | 'dns' | ...
    provider_id?:   'webdock-account-1' | ...
    kind?:           'compute_server' | 'dns_record' | ...
  Response:
    {
      "providers": [ProviderConfig...],
      "items": [InventoryItem...],
      "fetchSummary": {
        "providersAttempted": N,
        "providersOk": N,
        "providersFailed": [{providerId, error}]
      },
      "fetchedAt": "ISO"
    }
```

El endpoint actual `/v1/webdock/inventory` queda para retro-compat hasta
Hito 6 y luego se deprecia.

## 5. Adapters concretos por proveedor

### 5.1 Webdock (lo que ya tenemos × 3 cuentas)

Refactor del adapter existente (`packages/adapters/webdock/`):

- Acepta `accountConfig: WebdockAccountConfig` en lugar de leer un único
  env var.
- Mismo flujo real+mock fallback que Hito 5.11.A.
- 3 instancias en runtime, una por cuenta.

Capabilities: `list_compute_servers`, `get_compute_server_detail`.

ENV layout MVP:
```
WEBDOCK_API_KEY_ACCOUNT_1=...
WEBDOCK_API_KEY_ACCOUNT_2=...
WEBDOCK_API_KEY_ACCOUNT_3=...
```

Provider config en `config/providers.json`:
```json
[
  {
    "id": "webdock-account-1",
    "type": "compute",
    "vendor": "webdock",
    "displayName": "Webdock — Account 1 (EU primary)",
    "account": { "accountRef": "account_1", "credentialEnvVar": "WEBDOCK_API_KEY_ACCOUNT_1" },
    "capabilities": ["list_compute_servers", "get_compute_server_detail"],
    "status": "active"
  },
  {
    "id": "webdock-account-2",
    "type": "compute",
    "vendor": "webdock",
    "displayName": "Webdock — Account 2 (EU warming)",
    "account": { "accountRef": "account_2", "credentialEnvVar": "WEBDOCK_API_KEY_ACCOUNT_2" },
    "capabilities": ["list_compute_servers", "get_compute_server_detail"],
    "status": "active"
  },
  {
    "id": "webdock-account-3",
    "type": "compute",
    "vendor": "webdock",
    "displayName": "Webdock — Account 3 (backup)",
    "account": { "accountRef": "account_3", "credentialEnvVar": "WEBDOCK_API_KEY_ACCOUNT_3" },
    "capabilities": ["list_compute_servers", "get_compute_server_detail"],
    "status": "active"
  }
]
```

### 5.2 IONOS (post-MVP)

Provider type: `domain-registrar` + opcionalmente `dns`.

Auth: API Key (IONOS Cloud / DNS API según el plan contratado).

Capabilities: `list_registered_domains`, `list_dns_zones`, `list_dns_records`.

Endpoint a usar (sujeto a confirmación al implementar): IONOS Cloud DNS
API o IONOS Domains API según la cuenta.

Limitación a documentar: IONOS legacy domain API es REST con paginación
distinta a Webdock — el adapter normaliza al `InventoryItem` canónico.

### 5.3 Amazon (post-MVP)

Si se usa Route53 + Registrar:

Provider type: `domain-registrar` + `dns`.

Auth: IAM access key + secret (con permiso scoped a Route53 y
domains:ListDomains). NUNCA root key.

Capabilities: `list_registered_domains`, `list_dns_zones`, `list_dns_records`.

Notar: el budget gate AWS de D+1 PM (BudgetAction USD 100/mes) cubre
Bedrock, no Route53. Cuando se agregue, hay que ajustar el budget para
incluir el resto de servicios AWS o agregar gate separado.

### 5.4 Servidor físico (post-MVP)

Provider type: `physical`.

Auth: no aplica si el servidor es local y se consulta vía agente local
(no fetch remoto). Si se gestiona vía IPMI/iDRAC u otra interfaz fuera
de banda, definir auth en la implementación.

Capabilities: `list_compute_servers` (1 ítem, el server físico). Posible
expansión a métricas hardware en hito posterior.

Por ahora, **mientras no exista**, el operador marca el inventario
físico como "pendiente — provisión local". El agente lo lee como item
con `status: planned` y no propone nada sobre él.

## 6. Implicaciones para la Permissions Matrix (Doc 2)

Solo se agregan acciones **read** al matrix. Cero writes.

```
# Agregar a §3.1 allowed_read_only:

read_infrastructure_inventory       GET /v1/infrastructure/inventory       oc.read.infra_inventory
read_provider_config                GET /v1/infrastructure/providers       oc.read.provider_config
read_webdock_account_1_inventory    (interno via adapter)                  oc.read.webdock_acc1
read_webdock_account_2_inventory    (interno via adapter)                  oc.read.webdock_acc2
read_webdock_account_3_inventory    (interno via adapter)                  oc.read.webdock_acc3
read_ionos_domains                  (futuro)                               oc.read.ionos_domains
read_ionos_dns                      (futuro)                               oc.read.ionos_dns
read_amazon_domains                 (futuro)                               oc.read.amazon_domains
read_amazon_route53                 (futuro)                               oc.read.amazon_dns
read_physical_box_status            (futuro)                               oc.read.physical_box
```

`future_live_requires_new_phase` mantiene las mutaciones (crear,
destruir, modificar) bloqueadas. No se agregan en este hito.

## 7. Skills nuevas (post-MVP excepto multi-Webdock)

### 7.1 `delivrix-infra-inventory` (genérica multi-proveedor)

Reemplaza progresivamente `webdock-inventory-sync` (Hito 5.11.A).
Misma forma que la skill antigua pero invoca el endpoint unificado
`/v1/infrastructure/inventory`.

Trigger phrases: "qué hay en la infra", "inventario completo",
"mostrame todos los proveedores".

Audit IDs: `oc.skill.infra_inventory.invoke` + reads correspondientes.

### 7.2 Skills específicas (no necesarias si la genérica funciona)

No se crean skills por proveedor — la genérica con parámetros es
suficiente. El system context documenta cómo filtrar.

## 8. Plan MVP D+8 → D+11 (días 27-30, multi-Webdock solamente)

**Condición:** Hito 5.11.B debe cerrar limpio el día 26 (D+7). Si se
desvía, este sub-tramo se pospone a post-MVP sin afectar la demo (la
demo puede usar 1 cuenta Webdock + mock fallback como hoy).

**D+8 AM** — Refactor del Webdock adapter para aceptar `accountConfig`.
Tests unitarios cubren los 3 escenarios de cuenta + mock fallback por
cuenta. Endpoint `/v1/webdock/inventory` extendido con query param
`account_id`. Backward compat: sin `account_id` retorna agregado.

**D+8 PM** — Provider registry inicial: archivo `config/providers.json`
con las 3 cuentas Webdock. Endpoint nuevo
`/v1/infrastructure/providers` (read-only) + 
`/v1/infrastructure/inventory` que itera los 3 adapters Webdock con
`Promise.allSettled`. Cero IONOS / Amazon / físico (esos llegan
post-MVP como entries con status `planned`).

**D+9 AM** — Frontend admin panel: vista Clusters extendida para
desglosar por cuenta. Tab nuevo "Inventario" con dropdown de proveedor.
Empty states + loading states honestos.

**D+9 PM** — Skill nueva `delivrix-infra-inventory` (genérica). 
Deprecar `webdock-inventory-sync` con audit warning si se invoca (sigue
funcionando, solo loggea decisión). Actualizar system context
(rebuild Capa 1 + KB chunks Capa 2).

**D+10** — Smoke E2E del operador: invocar la nueva skill, ver las 3
cuentas Webdock, validar audit chain con los nuevos audit IDs.

**D+11** — Demo prep: documentar el flujo para la presentación,
capturar screenshots, agregar al guion de release.

Si algún día se sale del plan, el fallback es deprecar este sub-tramo
y mantener el adapter single-account para la demo. El spec doc queda
intacto para post-MVP.

## 9. Plan post-MVP (Hito 5.13 completo)

Después del MVP cerrado:

**Tramo 1 — IONOS**: adapter + tests + endpoint cabling + provider
registry entry + skill incluida en la genérica. Tiempo estimado: 2 días.

**Tramo 2 — Amazon (Route53 + Registrar)**: similar a IONOS pero con
AWS SDK + IAM scoping cuidadoso. Tiempo estimado: 2-3 días.

**Tramo 3 — Servidor físico**: depende de la decisión hardware del
operador. Puede ser local-agent + reporte HTTP, o IPMI/iDRAC, o un push
desde el server. Definir cuando se concrete la compra.

**Tramo 4 — Cross-references**: vincular sender_nodes con sus servers
Webdock concretos, dominios con sus DNS records, etc. Esto enriquece
la fleet view y permite al agente razonar sobre dependencias.

Total estimado: 7-10 días dev post-MVP. Aprobación del operador antes
de empezar.

## 10. Riesgos identificados

**Rate limiting cross-account.** Webdock puede tener límites por cuenta
o por key. Hay que probar al agregar las 3 cuentas; si hay throttling,
agregar caching + backoff en el adapter.

**Drift entre proveedores.** Un dominio en IONOS puede apuntar a un
sender_node Webdock retired. Esto no es bug del hito 5.13 pero abre la
puerta a un `drift-monitor` cross-provider en hitos posteriores.

**Costos AWS.** Agregar Amazon implica usar SDK + posibles costos por
llamada. El BudgetAction actual (USD 100/mes solo Bedrock) NO cubre
Route53/Domains. Ajustar al implementar.

**Confidencialidad de credenciales.** 6+ API Keys en env vars del
container OpenClaw es superficie de ataque que crece. Para post-MVP
considerar mover a secret manager (1Password CLI, AWS Secrets Manager,
o equivalente local). Por ahora env vars + `/etc/openclaw/skills.env`
con permisos 600.

## 11. Lo que este hito explícitamente NO hace

- Provisioning de nuevos servers en ningún proveedor.
- Modificación de DNS, dominios, IPs, ni infraestructura real.
- Decisiones de mercado de proveedores (qué comprar, dónde mover, etc).
  El operador decide; el agente solo lee.
- Federación de identidades entre proveedores. Cada cuenta sigue siendo
  independiente en su backend.
- Backup/restore cross-provider. Eso es otro hito.

## 12. Referencias

- `HITO_5_11_A_WEBDOCK_INVENTORY.md` (mockoups + adapter inicial)
- `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md` (norte agente + matrix)
- `OPENCLAW_PERMISSIONS_MATRIX.md` Doc 2 §3.1 / §3.4
- `NORTE_OPERATIVO_DELIVRIX.md` (read-only frontend, no infra real)
- `.audit/decision-skip-notion-side-effect.md` (patrón de skip por
  ausencia de credenciales, replicable acá si alguna cuenta falla)
