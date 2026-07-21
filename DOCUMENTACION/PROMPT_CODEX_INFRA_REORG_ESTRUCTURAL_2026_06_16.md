# BRIEF CODEX — Reorganización estructural de Infraestructura (anti "demasiada info")

Fecha: 2026-06-16 · Solicita: Juanes (CTO) · Diseña + auto-audita: Claude · Ejecuta: Codex (frontend) · Rama: `produ`
Archivo: `apps/admin-panel/src/v5/views/Infrastructure.tsx` (+ posibles helpers nuevos). NO toca backend.

## Objetivo

Pasar de ~12 filas planas (que confunden) a **~6 entidades reales + bloques "en cola" plegados**. Regla de diseño: tinta plena solo para real+live; lo demás apagado/colapsado. Es la 3a ronda: ya están aplicados los quick wins de front (no romperlos) y hay un P0 de backend aparte (no servir mock en 401). Esto es SOLO estructura de la vista.

## Estado y supuestos verificados (en vivo, 2026-06-16)

- `GET /v1/infrastructure/inventory`: 12 providers. `provider.items` **viene poblado**: webdock-primary (active) trae 9 items reales con `{id,kind,displayName,status,detail}`; cuentas en error traen 3 items MOCK (svc-warmup-*) — el P0 backend los vaciará; planeadas traen `items:[]`.
- `Loaded` (`Infrastructure.tsx:492-554`) ya particiona: `errors`/`offline` → `attentionItems`; `visibleProviders` = el resto; `compute`/`dns`/`physical` por kind. Las cuentas en atención YA se excluyen de Compute/DNS (no duplicar).
- Quick wins vigentes (preservar): `resourceLabel` (~L260) suprime conteo si error/!live; `KpiStrip` (~L610) "Recursos reales" cuenta solo live+no-error; rol repetido eliminado en compute (Bedrock conserva rol).
- `AttentionRow` ya tiene el patrón de disclosure correcto (`useState(expanded)` + `aria-expanded`/`aria-controls` toggle `:751-759`, bloque de items `:771-793`). `ProviderList` (~L914-977) es un `<ul>` de `<li>` plano (un map, sin agrupar, sin expandir). `brandName()` ~L195 (mira `id` primero: "Contabo Host Latam" → "Contabo" por `id="contabo"`, NO cae en Webdock; webdock-tertiary "Host Latam" → "Webdock"), `providerMonogram()` ~L233, `accountSuffix()` ~L213, `isOfflineLike` ~L379, `isIonosDnsActuator` ~L397, `dnsCaption` dinámico `:510-512`.

## Cambios

### A. Extraer piezas reutilizables (refactor sin cambio visual)
- `<ProviderRow provider expandable>`: sacar el `<li>` de `ProviderList` (`:919-968`) a un componente. Mantener el grid y los quick wins tal cual.
- `<ProviderDetail provider>`: sacar SOLO el bloque-lista de disclosure de `AttentionRow` (`:771-793`) a un componente compartido que renderiza la lista `provider.items` (id/displayName/status). NO unificar `PhysicalCard`: su detalle es un grid de `items[0].detail.model/location/role` (shape distinto) — dejarlo intacto.

### B. Drill-down universal (consistencia: hoy solo expanden las filas ROTAS)
- `<ProviderRow>` ofrece toggle "Ver detalle" SOLO cuando `canExpand = provider.fetchSourceKind === "live" && provider.status !== "error" && (provider.items?.length ?? 0) > 0`. Así nunca se muestran items mock/error; planeadas/0 no tienen toggle. Reusar `aria-expanded`/`aria-controls` como `AttentionRow`. (Tras el P0, las de error tendrán items:[] y quedan no-expandibles, coherente.)
- CASO CONTABO (no es bug): `contabo` viene `active`, `itemCount 0`, `statusLabel "Conectado sin VPS"`. Es connected/visible inline pero `canExpand=false` (0 items); muestra "0 servidores" sin toggle. Correcto — no forzar drill-down vacío ni tratarlo como error.

### C + D. Partición y agrupación — PRECEDENCIA (corregido por auto-auditoría)

Calcular en `Loaded` sobre la lista COMPLETA `providers` (NO `visibleProviders`, que ya filtró atención — si agrupás sobre la filtrada el grupo no puede contar "todas las cuentas"):

1. **Clasificar cada proveedor** en uno de tres cubos: `attention` (error/offline; ya se renderizan en la sección Atención de arriba), `connected` (`status==="active" || status==="paused"` Y `fetchSourceKind!=="mock"`), o `queued` (`status==="planned"` o `fetchSourceKind==="mock"`). Nota: **`mock` gana sobre `active`** (un active+mock va a `queued`, es demo).
2. **Agrupar por marca SOLO el cubo `connected`**: `groupByBrand(connected)` con `brandName()`. Una marca arma `<ProviderGroup>` solo si tiene **≥2 cuentas connected** (hoy: Webdock = primary active + InfraVPS paused). Marcas con 1 cuenta connected → `<ProviderRow>` suelto (Contabo, AWS Route53, Bedrock). IONOS hoy NO dispara grupo (sus cuentas están split connected/queued).
3. **Render por sección (kind):** primero los `connected` (grupos + filas sueltas), luego, si hay, `<CollapsibleSection title="En cola / sin conectar" defaultOpen={false}>` con los `queued` de esa sección. Si una sección no tiene `queued`, no renderizar la colapsable.

**Cabecera de `<ProviderGroup>`** (cuenta cruzando TODAS las cuentas de la marca, de `providers` completo): monograma + marca + `"{N} cuentas · {serversReales} servidores reales"` + desglose `"{c} conectadas · {k} en atención ↑ · {q} en cola ↓"` (omitir los términos en 0). `serversReales` = suma de `itemCount` solo de cuentas live+no-error. Las cuentas en atención NO se re-renderizan en el grupo (la ↑ apunta a la sección Atención); las queued de la marca viven en la colapsable (la ↓). Sub-filas del grupo = solo las cuentas `connected` de la marca.

Props sugeridas (calculadas en `Loaded`): `<ProviderGroup brand monogram summary={{ totalAccounts, serversReales, connectedCount, attentionCount, queuedCount }} connectedAccounts={Provider[]} />`.

**Resultado esperado:**
- Compute connected = grupo "Webdock" (cabecera p.ej. "5 cuentas · 22 servidores reales · 2 conectadas · 2 en atención ↑ · 1 en cola ↓"; sub-filas: Dep Infraestructura `active` 9 + InfraVPS `paused` 13) + Contabo (`active`, "0 servidores", no-expandible) + Bedrock (`active`, dato viejo). Compute "en cola" plegado = la cuenta Webdock `planned`.
- DNS connected = Route53 (`active`, 13 dominios). DNS "en cola" plegado = Porkbun + IONOS Cloud DNS + IONOS Domains (planned/demo).

### E. Preservar
Quick wins (A/B/C de la ronda anterior) y el resto de secciones (Atención, banner OpenClaw, físico, footer) intactos.

## DoD (verificable)
- Compute: Webdock como UN grupo con cabecera agregada honesta + Contabo + Bedrock; planeadas/demo plegadas en "en cola".
- DNS: Route53 visible + "3 en cola" plegado.
- Drill-down "Ver detalle" funciona en proveedores live con items reales (webdock-primary → sus 9 servidores) y NO aparece en mock/error/planned.
- KPIs siguen honestos (sin cambios) y las cuentas en atención no se duplican dentro de los grupos.
- `npm --workspace @delivrix/admin-panel run check` (tsc + tests + vite build) verde.
- Verificar en Chrome `/infrastructure`: menos filas, agrupación correcta, sin overflow a 390px, sin errores de consola. (Nota: el screenshot de Chrome puede salir en blanco por timing de pintado; verificar también con `innerText` del `main`.)

## Commit / coordinación
- File-disjoint con el P0 backend (este toca solo `apps/admin-panel/...`). Incluir en el commit junto con los quick wins de front ya vivos (mismo archivo `Infrastructure.tsx`). Stage selectivo por paths (no `git add -A`; hay `.audit/*`, docs y `config/*.bak-*` con secretos). Push a `origin/produ`.

## Riesgos / edge cases (de la auto-auditoría)
- Conteo de cabecera de marca cuando las cuentas se reparten entre Atención y visibles: la cabecera cuenta TODAS las cuentas de la marca pero solo renderiza las visibles (las de atención quedan arriba) → evitar doble conteo y doble render.
- No envolver en `<ProviderGroup>` marcas de 1 cuenta (evita chrome inútil).
- `paused` (InfraVPS, real) va en connected, NO en "en cola".
- Mantener `isIonosDnsActuator`/`isOfflineLike` y el caption dinámico de DNS (`:510`).
- `CollapsibleSection` con foco/teclado y `aria-expanded`; si una sección no tiene `queued`, no mostrar el disclosure vacío.
