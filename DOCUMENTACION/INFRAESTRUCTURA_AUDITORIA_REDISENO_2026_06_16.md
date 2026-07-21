# Auditoría + rediseño — Sección "Infraestructura" (panel admin)

Fecha: 2026-06-16 · Audita: Claude (PM/frontend) con 2 subagentes senior (UX/UI + frontend) · Read-only
Componente activo: `apps/admin-panel/src/v5/views/Infrastructure.tsx` (`InfrastructureV5`, ruteado en `App.tsx:57/700`)
Mockup de la propuesta: `DOCUMENTACION/INFRAESTRUCTURA_REDISENO_MOCKUP_2026_06_16.html`

---

## TL;DR

La v5 NO está rota — ya tiene buen esqueleto (KPIs, zona de atención, grupos por tipo). Lo que la hace sentir desorganizada son **tres cosas concretas**:

1. **Contabo no existe en la vista.** El backend del inventario (`routes/infrastructure.ts`) no tiene `buildContaboProvider`, así que un proveedor conectado simplemente no aparece. Es un gap de **backend**, no de UI. Máxima prioridad — es justo "reconocer cada proveedor".
2. **Las 5 cuentas Webdock se ven como 5 cards iguales** sin un total ni jerarquía marca→cuenta. Hay que agruparlas (1 grupo "Webdock · 5 cuentas · 28 servidores" con sub-filas). Front-only.
3. **Las cards listan metadata de máquina** (slug, capabilities crudas) en vez de presentar al proveedor con un rol legible y un conteo claro. Front-only.

Resolviendo esos tres, más separar la IA (Bedrock) del cómputo y marcar live/mock + frescura por card, la sección pasa de "lista técnica" a "inventario que reconozco".

## Lo que ya está bien (conservar, no rehacer)

KPIs ejecutivos, zona "Atención requerida" (el mejor patrón de la vista), agrupación por tipo, `PhysicalCard`, el polling 30s + cache de sesión (TTL 5 min, defensivo).

## Diagnóstico por severidad

**Crítico**

- **C1 — Contabo invisible.** `buildInfrastructureInventoryPayload` (`routes/infrastructure.ts:113-144`) no emite Contabo; el handler en `main.ts:1741-1758` ni siquiera pasa el registry `vpsProviderEntries` que YA existe (`main.ts:359`). El adapter Contabo ya tiene `listServers()` que devuelve el mismo tipo que Webdock (`contabo-adapter.ts:298`). La UI no puede listar lo que el backend no emite.
- **C2 — Webdock 5 cuentas = 5 cards planas** (`buildWebdockProvider` emite 1 provider por cuenta; el front las lista sueltas). Sin total agregado ni jerarquía. Es el dolor más visible.

**Alto**

- **A1 — La card no "presenta" al proveedor:** muestra slug técnico + capabilities crudas (`list_compute_servers...`) en vez de un rol humano ("VPS de envío SMTP", "Modelo LLM del agente"). Sin ancla visual de marca.
- **A2 — Bedrock (IA) mal clasificado en "Compute".** Mezcla "infra que envía" con "infra que piensa"; el propio caption se disculpa. Debe ser grupo propio (idealmente `kind:"ai"` en el contrato).
- **A3 — Proveedores planned / 0-instancias** (Porkbun, IONOS Domains sin tenant, físico, Contabo-0) se renderizan igual que los productivos y diluyen la señal. Separar en sub-bloque "Conectados / en cola" y distinguir "conectado-sin-recursos" de "sin credenciales".
- **A4 — `live`/`mock` solo en el footer agregado.** Es info de confianza de primer orden; debe ir por-card (el legacy lo hacía y se perdió).

**Medio**

- M1 — Doble pill en filas IONOS actuator (rompe la columna de estado). M2 — `formatRelative` calcula la antigüedad pero nunca marca "stale" pese a existir tokens. M3 — CTAs sin `onClick` (botones muertos) y se perdió el drilldown de items del legacy. M4 — conteo siempre rotulado "items" (debería ser servidores/zonas/dominios). M5 — iconografía no distingue proveedores dentro de un kind.

**Técnico (frontend)**

- Monolito de **976 líneas** con 7 responsabilidades mezcladas (contrato, datos, dominio, formato, 15 componentes).
- `brandName()` / `accountSuffix()` / `isOfflineLike()` usan **string-matching frágil** sobre `displayName`/`errorReason` cuando el backend ya da `id`, `accountLabel` y tokens estables (`not_online_yet`). `brandName` **se degradará con Contabo** (`id="contabo"` cae al fallback `includes` → sin marca).
- **Tipos triplicados** (`packages/domain` + activo + legacy) y ya divergentes (`statusLabel`). Unificar con `import type` (cero peso en bundle).
- **Legacy muerto:** `features/infrastructure/index.tsx` (760 ln) no lo importa nadie. Eliminar.
- `statusLabel` ya viene calculado del backend pero el front lo ignora y reconstruye uno propio. Buckets de `Loaded` recomputados sin `useMemo`.

## Reorganización propuesta (ver mockup)

- **4 grupos por función:** Envío y cómputo (Webdock + Contabo) · DNS y dominios · Inteligencia/IA (Bedrock) · Hardware físico.
- **Webdock agrupado:** 1 card-grupo con header agregado (5 cuentas · 28 servidores · estado peor-de) + sub-filas por cuenta. Mismo patrón para Contabo cuando tenga >1 cuenta.
- **Anatomía de card:** monograma de marca (WD/CB/AWS/I/PB/IBM) · nombre · **rol en una frase** · conteo específico (servidores/zonas/dominios) · chip live/mock · frescura con señal stale · **una** pill de estado. Slug y capabilities → drilldown/tooltip, no en la fila.
- **Contabo:** rol "VPS de envío SMTP (2.º proveedor)", estado "Conectado · 0 servidores" (no "planned" — merece trato de conectado-esperando-flota).
- **planned/0-instancias:** sub-bloque atenuado "Conectados / en cola"; distinguir "sin credenciales" (CTA Conectar) de "conectado, sin recursos".
- **Origen de marca/cuenta/estado SIN string-matching:** mapper por prefijo de `id` (contrato estable) o, mejor, `brand` tipado emitido por el backend; usar `statusLabel` del backend.

## Plan priorizado

**Quick wins (alto valor, bajo riesgo)**

1. **`buildContaboProvider` + cableado** (backend, Codex). Espejo de `buildWebdockProvider`; en `main.ts` pasar `vpsProviderEntries` (ya existe) al handler. Aditivo — los demás builders quedan byte-idénticos. **Destraba el objetivo del CTO.**
2. Agrupar Webdock por marca con header agregado (front).
3. Rol legible por proveedor (diccionario id→rol) en vez de capabilities crudas (front).
4. Conteo específico por kind; chip live/mock + señal stale por card (front).
5. Usar `statusLabel` del backend y `errorReason === "not_online_yet"`; borrar fallbacks duplicados (front).
6. Mapper de marca por `id` (no por `displayName`) — hace que Contabo se renderice con identidad correcta.
7. Cablear o deshabilitar (`disabled` + title) los botones muertos.

**Refactor mayor (coordinar con Codex por el churn del archivo compartido)**

8. Descomponer el monolito (`InfrastructureView` + `ProviderGroup` + `ProviderCard` + `AttentionPanel` + `hooks/` + `lib/` testeable).
9. Unificar tipos vía re-export `import type` desde `@delivrix/domain`.
10. (Backend) `kind:"ai"` para Bedrock y `brand` tipado por proveedor; estado "conectado-sin-recursos" distinto de "planned".
11. Reponer el drilldown de items que el legacy tenía.

**Limpieza**

12. Eliminar `features/infrastructure/index.tsx` (código muerto verificado).

## Archivos clave

- `apps/admin-panel/src/v5/views/Infrastructure.tsx` — activo (brandName L197, accountSuffix L213, isOfflineLike L280, tipos mirror L68-97, buckets sin memo L394-405).
- `apps/gateway-api/src/routes/infrastructure.ts` — builders; falta `buildContaboProvider` (espejo de L181-197 o rama IONOS sin-creds L302-319).
- `apps/gateway-api/src/main.ts:1741-1758` — handler NO pasa `vpsProviderEntries` (existe L359).
- `packages/domain/src/infrastructure-inventory.ts` — contrato canónico + `statusLabel` ya calculado.
- `packages/adapters/src/contabo-adapter.ts` — `listServers()` L298, `createContaboAdaptersFromEnv` L674.
- `apps/admin-panel/src/features/infrastructure/index.tsx` — legacy muerto a eliminar.
