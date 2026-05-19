# Hito 5.12 — Multi-provider inventory + panel Infraestructura (MVP)

> Fecha de spec: 2026-05-19
> Hito antecesor: 5.11.B (OpenClaw Hostinger Agent)
> Hito sucesor: 5.13 — completion post-MVP (IONOS robusto, secret manager,
>                                            cross-references, writes proposal)
> Estado: locked-in MVP. Inicia D+8 si 5.11.B cierra limpio el día 26.

## Changelog

- **v1.0** (2026-05-19) — Operador overrides el deferral inicial. Multi-provider
  inventory entra al MVP en alcance lectura. Mutaciones contra infra real
  siguen en `future_live_requires_new_phase` per Doc 2 §3.4.

## 1. Decisión rector

El operador decidió que el inventario multi-proveedor debe **funcionar para
la demo MVP** porque sin él no se ve el valor de "agente que entiende toda
la infra". 

Mi evaluación inicial proponía diferir todo a post-MVP. El operador la
corrigió con dos argumentos válidos:

1. AWS CLI ya está configurado desde D+1 PM (setup Bedrock). El costo
   marginal de agregar Route53/Domains read es menor que estimaba.
2. El patrón de adapter + mock fallback del Hito 5.11.A es reusable. Las
   3 cuentas Webdock + AWS no requieren reinventar arquitectura.

Decisión audited: multi-provider read-only entra al MVP como Hito 5.12.
Writes a infra real quedan en hito futuro (5.13+ con kill switch dedicado
y revisión legal por proveedor).

## 2. Alcance MVP (qué entra)

### 2.1 Proveedores y cuentas

| Proveedor | Cuentas | Tipo | Capabilities MVP |
| --- | --- | --- | --- |
| Webdock | 3 | compute | `list_compute_servers`, `get_compute_server_detail` |
| AWS Route53 | 1 | dns | `list_dns_zones`, `list_dns_records` |
| AWS Domains | 1 | domain-registrar | `list_registered_domains` |
| IONOS Cloud DNS | 1 | dns | `list_dns_zones`, `list_dns_records` |
| Servidor físico | 0 | physical | placeholder card, status `planned` |

**Total runtime providers**: 6 (Webdock × 3 + AWS Route53 + AWS Domains
+ IONOS Cloud DNS), más 1 placeholder físico.

### 2.2 Panel admin nuevo: sección "Infraestructura"

Nueva tab en la navegación. Componentes:

- **Vista resumen**: 5-6 provider cards. Cada card muestra `displayName`,
  `status`, `itemCount`, `lastFetched`, `fetchSourceKind` (real/mock),
  badge de error si última fetch falló.
- **Drilldown por provider**: click en card → lista de items del proveedor
  con filtros (kind, status). Cada item linkea su audit history.
- **Filtros globales**: por tipo de proveedor (compute/dns/domains), por
  status (active/paused/error). Filtros simples, no facetados completos.
- **Empty/loading/error states** honestos: si un fetch falla, decirlo;
  si un proveedor no tiene credenciales, marcarlo como `Pendiente`.
- **Audit link**: cada provider card linkea a la vista Audit filtrada por
  los `oc.read.<provider>.*` eventos del último día.

NO incluye:
- Polish Pencil completo (tokens nuevos, dark mode, animaciones).
- Drill-down profundo per recurso (ej. DNS record con histórico de cambios).
- Cross-references entre proveedores (ej. domain X → DNS zone Y → server Z).
- Forms para editar provider registry (eso es CRUD, post-MVP).

### 2.3 Skill agente: `delivrix-infra-inventory` (genérica)

Nueva skill nativa que invoca el endpoint unificado `/v1/infrastructure/inventory`.
Sustituye progresivamente a `webdock-inventory-sync` (que queda deprecated
con audit warning, sigue funcionando para retro-compat).

Trigger phrases: "qué hay en la infra", "inventario completo", "mostrame
todos los proveedores", "qué dominios tenemos".

System context regenerado: incluye doctrina de la nueva skill + lista de
proveedores activos + capabilities por proveedor.

## 3. Norte intacto (qué NO cambia)

- GET-only frontend sigue intacto. El panel Infraestructura es 100% read.
- Audit append-only + hash chain SHA-256 cubre cada fetch a proveedor.
- Permissions matrix gate sigue activo. Toda mutación contra infra real
  (crear server, registrar dominio, modificar DNS, comprar dominio,
  configurar Route53 record) sigue en `future_live_requires_new_phase`.
- Kill switch sigue armado por default.
- Credenciales en env vars + `/etc/openclaw/skills.env` con permisos 600,
  nunca en repo.

## 4. Decisiones audited del operador (2026-05-19, sesión 2)

1. **IONOS Cloud DNS confirmado**: el operador validó que la cuenta IONOS
   tiene API Programme activado con Cloud DNS API. Key "OpenClaw" generada
   2026-05-19 con prefix `2d34e08172f04db8bf3d90effe680080`. IONOS entra
   al MVP como provider `dns` con capabilities `list_dns_zones` +
   `list_dns_records`. Domains API legacy no se cabea en MVP — AWS
   Domains cubre el rol de registrar.
2. **Webdock × 3 cuentas vía API**: confirmado por el operador. Tres API
   Keys generadas (una por cuenta), env vars `WEBDOCK_API_KEY_ACCOUNT_1/2/3`.
   Razones documentadas: usuario/contraseña viola Norte, CLI es wrapper,
   SDK se usa como librería de tipos adentro del adapter.
3. **Panel pulido**: funcional MVP (cards + drill básico + audit links).
   Sin polish Pencil completo. Polish es post-MVP.

## 5. Pre-requisitos (antes de D+8)

Tres cosas que hay que resolver entre D+7 closure y D+8 start:

### 5.1 Webdock 401/500 (task #138)

La cuenta actual venía 401, ahora 500. Antes de las 3 cuentas hay que:
- Rotar la API key de la cuenta 1 desde el dashboard de Webdock.
- Validar que las 3 cuentas (que el operador todavía no compartió las
  keys) tengan keys vivas. Pedirle al operador las 3 keys en formato:
  `WEBDOCK_API_KEY_ACCOUNT_1`, `_2`, `_3`.
- Smoke por cuenta: `curl -H "Authorization: Bearer $KEY" https://api.webdock.io/v1/servers` debe retornar 200 con lista.

Si alguna cuenta no tiene key viva, esa cuenta se marca `status: paused`
en el provider registry con audit reason.

### 5.2 AWS budget ajustado

El BudgetAction de D+1 PM cubre solo Bedrock (USD 100/mes). Hay que
agregar Route53 y Domains al scope o crear un budget separado.

Comando AWS CLI (Codex ejecuta):
```bash
# Agregar Route53 + Domains al budget Bedrock existente o crear uno nuevo
aws budgets describe-budgets --account-id <ACCOUNT_ID>
# Si conviene budget separado:
aws budgets create-budget --account-id <ACCOUNT_ID> --budget file://route53-budget.json
```

Tiempo estimado: 30 min para Codex.

### 5.3 IONOS Cloud DNS confirmado

Confirmado por operador 2026-05-19:
- API Programme activado en la cuenta IONOS.
- API key etiquetada "OpenClaw" generada con prefix
  `2d34e08172f04db8bf3d90effe680080`. Secret part en `.env.local` +
  `/etc/openclaw/skills.env` del container como `IONOS_API_TOKEN`.
- Capabilities scope: Cloud DNS (zones + records). Domains API legacy NO
  contratada — AWS Domains cubre el rol de registrar.

Pendiente menor (a confirmar al cabear D+10):
- Formato exacto del Authorization header. IONOS Cloud DNS típicamente
  acepta `Authorization: <prefix>.<secret>` directo (sin "Bearer") o
  `Authorization: Bearer <prefix>.<secret>`. Codex verifica con doc
  oficial antes de codear el adapter.
- Sizing del paginador: si la cuenta tiene >100 zones, agregar paginación
  al adapter.

## 6. Cronograma D+8 → D+11

### D+8 AM — Webdock multi-account refactor

OPS: `OPS_INFRA_D8_AM_WEBDOCK_MULTI.md` (a escribir cuando 5.11.B cierre).

- Refactor `packages/adapters/webdock/` para aceptar `accountConfig`.
- Provider registry inicial en `config/providers.json` con las 3 cuentas.
- Endpoint `/v1/webdock/inventory` extendido con query param `account_id`.
  Sin `account_id` retorna agregado de las 3.
- Mock fallback opera por cuenta independiente.
- Tests unitarios cubren: 3 cuentas OK, 1 cuenta KO + 2 OK, 3 cuentas KO
  (todo mock), key inválida por cuenta.
- Smoke: `curl http://127.0.0.1:3000/v1/webdock/inventory?account_id=webdock-account-2`.

### D+8 PM — Provider abstraction + endpoint unificado

OPS: `OPS_INFRA_D8_PM_PROVIDER_ABSTRACTION.md`.

- Tipo `Provider`, `InventoryItem`, `ProviderCapability` en
  `packages/domain/src/infrastructure/`.
- Provider registry expandido con tipos `dns`, `domain-registrar`,
  `physical` (entries con status `planned` por ahora).
- Endpoint `/v1/infrastructure/providers` (read-only, lista providers
  + capabilities).
- Endpoint `/v1/infrastructure/inventory` que itera providers activos
  con `Promise.allSettled`, normaliza al `InventoryItem` canónico.
- Backward compat: `/v1/webdock/inventory` sigue vivo, ahora es una vista
  filtrada del unificado.

### D+9 AM — AWS Route53 + Domains read

OPS: `OPS_INFRA_D9_AM_AWS_ADAPTER.md`.

- Adapter en `packages/adapters/aws/` usando AWS SDK v3 (instalar
  `@aws-sdk/client-route-53` + `@aws-sdk/client-route-53-domains`).
- Reusa el AWS CLI config + IAM user del D+1 PM. Verificar que el IAM
  policy del Bedrock user tiene también permisos `route53:List*` y
  `route53domains:List*`. Si no, ampliar policy con Codex.
- Implementa `list_dns_zones`, `list_dns_records` (por zone), `list_registered_domains`.
- Mock fallback honesto (siguiendo patrón Webdock).
- Provider entries en registry: `aws-route53` (dns), `aws-domains`
  (domain-registrar).
- Tests + smoke.

### D+9 PM — Skill + system context + panel base

OPS: `OPS_INFRA_D9_PM_SKILL_AND_PANEL_BASE.md`.

- Skill nativa `delivrix-infra-inventory` en
  `/data/.openclaw/skills/delivrix-infra-inventory/` siguiendo el patrón
  del `delivrix-publish-proposal` que cabló en D+6 PM fix.
- Rebuild `system-context.txt` incluyendo: nueva skill + provider registry
  + capabilities + audit IDs nuevos.
- Frontend admin panel: tab `Infraestructura` agregada a la nav. Vista
  resumen con cards básicas (sin drilldown ni filtros aún).
- Empty/loading/error states honestos.

### D+10 AM — IONOS Cloud DNS adapter

OPS: `OPS_INFRA_D10_AM_IONOS_CLOUD_DNS.md`.

- Verificar formato del Authorization header contra doc IONOS Cloud DNS
  (prefix.secret directo vs Bearer).
- Adapter en `packages/adapters/ionos/` con dos métodos: `listZones()`,
  `listRecordsByZone(zoneId)`.
- Mock fallback honesto (siguiendo patrón Webdock + AWS).
- Provider entry en registry: `ionos-cloud-dns` (dns).
- Tests + smoke contra cuenta real con la key "OpenClaw".

Si el adapter responde limpio (esperado), seguimos con D+10 PM normal.
Si por algún motivo IONOS contrato cambió o la doc difiere de lo
esperado, fallback a mock canónico audited y continuamos — el adapter
queda parcial pero la demo no se rompe.

### D+10 PM — Panel drilldown + filtros + audit links

OPS: `OPS_INFRA_D10_PM_PANEL_DRILLDOWN.md`.

- Click en card → vista lista de items del proveedor.
- Filtros simples (kind, status).
- Audit link por provider (linkea a la vista Audit filtrada).
- Placeholder card para servidor físico con badge `Planned`.
- Smoke visual + tests del panel.

### D+11 AM — Smoke E2E del operador

OPS: `SMOKE_E2E_INFRA_D11_AM.md` (similar formato al D+6 PM, guía para
el operador).

- Abrir panel → tab Infraestructura → verificar cards.
- Drill en cada provider → verificar items.
- Chat OpenClaw → pedir "qué hay en la infra hoy" → agente invoca
  `delivrix-infra-inventory` → responde con resumen.
- Verify-chain post-smoke.

### D+11 PM — Demo prep

- Capturar screenshots del panel Infraestructura.
- Actualizar guion de demo MVP (qué mostrar de Infraestructura).
- Commit + push de Hito 5.12.
- Tildar en Notion master del MVP.

## 7. Riesgos y mitigaciones

**Webdock contrato cambió.** El 401→500 que vimos sugiere posible cambio
de API. Si al rotar key sigue rojo, hay que leer la doc actualizada de
Webdock antes del D+8. Mitigación: dejar buffer en D+8 AM para diagnóstico.

**IONOS contrato confirmado.** Cloud DNS API activado, key generada. Riesgo
residual menor: doc IONOS puede tener variaciones de formato (Authorization
header). Mitigación: Codex valida contra doc oficial antes de codear y mock
fallback opera si la primera fetch real falla.

**AWS budget no ajustado.** Si Codex no extiende el budget antes del D+9
AM, las llamadas Route53 pueden generar costo inesperado. Mitigación:
ajustar como pre-requisito de D+9.

**Rate limiting de Webdock con 3 keys.** Si Webdock limita por cuenta o
por IP, las 3 fetches simultáneas pueden trotear. Mitigación: si pega,
agregar backoff exponencial + caché 60s en el adapter.

**Polish del panel se va de scope.** El operador decidió funcional MVP,
no Pencil completo. Mitigación: yo (Claude) revisa el design system de
shared/ui antes de cabear el panel para reusar primitives existentes y
no inventar componentes nuevos.

## 8. Lo que explícitamente NO entra (sigue en Hito 5.13 post-MVP)

- **Writes a infra real**: crear server, destruir server, registrar dominio,
  modificar DNS, comprar dominio. Todo `future_live_requires_new_phase`.
- **IONOS Domains API legacy**: la cuenta del operador solo tiene Cloud DNS
  activado. Dominios registrados en IONOS (si los hay) se gestionan vía
  panel web hasta Hito 5.13. AWS Domains cubre el rol de registrar en MVP.
- **Cross-references** entre proveedores (domain → DNS zone → server).
- **Secret manager** (1Password CLI, AWS Secrets Manager, etc).
  MVP usa env vars + `/etc/openclaw/skills.env` con permisos 600.
- **Drilldown profundo** per recurso con histórico.
- **Dashboard de drift** cross-provider (drift-monitor sigue siendo solo
  Webdock vs sender_node registry).
- **Forms de edición** del provider registry desde el panel. El registry
  se edita por commit en `config/providers.json` por ahora.
- **Polish Pencil completo** del panel Infraestructura.

## 9. Referencias

- `HITO_5_11_A_WEBDOCK_INVENTORY.md` (adapter pattern original)
- `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md` (agente que consume)
- `OPENCLAW_PERMISSIONS_MATRIX.md` Doc 2 §3.1 / §3.4
- `OPS_OPENCLAW_BEDROCK_AWS_SETUP_VIA_CODEX.md` (IAM setup existente)
- `NORTE_OPERATIVO_DELIVRIX.md` (read-only frontend, no writes a infra real)
- `HITO_5_13_MULTI_PROVIDER_INVENTORY.md` (completion post-MVP)
