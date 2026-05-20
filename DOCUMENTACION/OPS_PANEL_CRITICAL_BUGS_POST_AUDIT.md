# OPS — Bugs críticos del admin panel (post-auditoría 2026-05-20)

**Fecha:** 2026-05-20
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Trigger:** Auditoría conjunta Claude (browser real :5173) + Codex (terminales). Encontramos por qué el panel "se ve horrible": no es solo UX, hay un **bug crítico que rompe el render** + 3 bugs adicionales que Codex ya flagueó.
**Estimado total:** ~2-3 hrs.

## Bugs ordenados por severidad

### 🚨 CRIT-1 — Vite dep cache corrupto rompe render entero

**Síntoma:** abrir `http://127.0.0.1:5173` muestra pantalla en blanco. El title es "Delivrix Admin" pero `<div id="root">` queda vacío.

**Diagnóstico (Claude vía Chrome MCP):** 4 dependencias pre-bundled fallan con **HTTP 503**:

```
GET /node_modules/.vite/deps/react.js                    → 503
GET /node_modules/.vite/deps/react-dom_client.js         → 503
GET /node_modules/.vite/deps/react_jsx-dev-runtime.js    → 503
GET /node_modules/.vite/deps/@tanstack_react-query.js    → 503
```

Sin React + JSX runtime no se monta el árbol. Sin react-query no carga `loadDashboardData()`. Por eso `data.*` parece estático: en realidad **el panel ni renderizó**.

CSS (tokens, globals, fonts), `App.tsx`, `@vite/client` y `@react-refresh` cargan OK (200). Solo las 4 deps pre-bundled de `.vite/deps/` están corruptas.

**Causa raíz:** después de los múltiples commits del día (Ola 1 + Ola 2 + cleanups + chat live + tokenization) el optimizeDeps de Vite quedó inconsistente. Restart sin `--force` no regenera el cache.

**Fix:**

```bash
# 1. Detener cualquier dev server activo (Ctrl+C en su terminal)
cd "/Users/juanescanar/Documents/delivrix app"

# 2. Limpiar caches de optimizeDeps
rm -rf node_modules/.vite
rm -rf apps/admin-panel/node_modules/.vite

# 3. Re-instalar para regenerar lockfile si hace falta
npm install

# 4. Reiniciar con --force para forzar pre-bundle limpio
npx --workspace @delivrix/admin-panel vite --force
# o equivalente del script existente
```

**Prevención:** agregar a `apps/admin-panel/vite.config.ts` la opción `optimizeDeps.force: true` cuando `process.env.VITE_FORCE_OPTIMIZE === "1"`, y documentar que después de cambios grandes en deps (chat-client, WSS lib, react-query upgrade) corre `VITE_FORCE_OPTIMIZE=1 npm run dev`.

**Verificación:** `curl http://127.0.0.1:5173/node_modules/.vite/deps/react.js` → 200 + body válido. Abrir panel en navegador → ver sidebar Delivrix con Overview activo.

### 🚨 CRIT-2 — GET `/v1/webdock/inventory` muta audit chain cada poll

**Síntoma:** abrir panel dispara `loadDashboardData()` cada 30s → ese loader llama `/v1/webdock/inventory` → ese GET hace `auditLog.append({ action: "oc.webdock.inventory_polled", ... })` en `apps/gateway-api/src/main.ts:454`.

**Resultado:** `.audit/audit-events.jsonl` crece N eventos cada 30s solo por tener el panel abierto. **Un GET read-only no debe ensuciar la chain.**

**Fix:** quitar el `auditLog.append` del handler GET. Solo registrar invocations REALES del agente (cuando el skill `fleet-ops` consulta), no polls de panel. Hay 2 caminos:

1. **Camino A (mínimo invasivo):** mover el append a un middleware/wrapper que solo se ejecuta cuando el `actorType` del request es `"openclaw"` o `"system"` con metadata específica de skill invocation. Polls del panel quedan silenciados.
2. **Camino B (más limpio):** separar el endpoint en `/v1/webdock/inventory` (GET puro, sin audit) y `/v1/agent/webdock/inventory` (privado, con audit + HMAC). El panel consume el primero, el agente el segundo.

Recomiendo **A** para no romper read-boundary del panel.

**Verificación:**

```bash
# Antes del fix
curl http://127.0.0.1:3000/v1/webdock/inventory > /dev/null
tail -1 .audit/audit-events.jsonl | jq '.action'  # debería ser "oc.webdock.inventory_polled"

# Después del fix
curl http://127.0.0.1:3000/v1/webdock/inventory > /dev/null
tail -1 .audit/audit-events.jsonl | jq '.action'  # NO debe haber cambiado

# Y verify-chain debe seguir verde
node --experimental-strip-types scripts/audit/verify-chain.ts
```

### 🟡 HIGH-1 — Mobile: sidebar ocupa todo el viewport (390px)

**Síntoma:** en mobile (375-400px) el sidebar ocupa la primera pantalla completa y el contenido empieza debajo del fold. Usuario tiene que hacer scroll antes de ver datos.

**Raíz:** `apps/admin-panel/src/app/App.tsx:61` — `grid grid-cols-1` con sidebar en `max-md:static`. En mobile el grid colapsa a 1 columna y el sidebar (240px width default pero `min-content` por flex/grid) toma altura completa.

**Fix:**

- En breakpoint `md` (< 768px), sidebar debería ser un **drawer toggleable** (icono hamburguesa en topbar), no parte del grid principal.
- O en mobile colapsar el sidebar a `<nav>` horizontal con scroll (chips) en topbar.
- Recomiendo drawer: respeta el patrón ya usado por el ChatWidget de Ola 1.

**Verificación:** Chrome DevTools → iPhone 13 viewport (390×844) → al cargar, el contenido (header + KPIs) debe ser visible sin scroll. Sidebar accesible vía hamburguesa.

### 🟡 HIGH-2 — Pipeline overview: 5 pasos aplastados en mobile

**Síntoma:** la fila de 5 pasos del pipeline en Overview se renderiza en una sola fila sin breakpoint ni scroll horizontal en mobile → textos se montan, columnas con `flex-1` se vuelven inutilizables.

**Raíz:** `apps/admin-panel/src/features/overview/index.tsx:453` (`flex items-stretch`) + `:511` (`StageCard` con `flex-1` y `minWidth: 0`).

**Fix:**

- En breakpoint `max-md`, cambiar el row a `overflow-x-auto` con `snap-x snap-mandatory` y cards de width fijo (~280px cada una).
- Mantener el `flex items-stretch` en desktop ≥768px.
- Agregar indicador visual de scroll (gradient fade en bordes laterales).

**Verificación:** mobile 390px → scroll horizontal suave entre los 5 pasos, cada uno legible al snap. Desktop 1280px → 5 cards distribuidos en la fila, idénticos al diseño actual.

### 🟠 MEDIUM-1 — Bundle 607 KB warning de Vite

**Síntoma:** `npm run build` reporta `index-pM592WBA.js (607.91 kB)` con warning de chunk size.

**Diagnóstico rápido sugerido:**

```bash
npx --workspace @delivrix/admin-panel vite-bundle-visualizer
# o
npm --workspace @delivrix/admin-panel run build -- --mode analyze
```

Sospechosos por tamaño: `@xyflow/react` (visualización canvas, ~200KB típico), `recharts` (charts, ~150KB), todas las fuentes self-hosted (Funnel Sans + Geist + Inter + IBM Plex Mono = ~80KB cada una sumando hasta 200KB), `lucide-react` íconos.

**Fix sugerido:**

- **Code-splitting por feature** con `React.lazy()` + `Suspense`: `OverviewSection`, `CanvasSection`, etc. cargan solo cuando se navega. Bajaría main bundle ~40%.
- **Subset de fuentes**: cargar solo weights usados (400, 600). Hoy carga 400/500/600/700 de Funnel Sans → 4 archivos cuando 2 alcanzan.
- **Lucide tree-shaking**: confirmar que el import es `import { Camera } from "lucide-react"` (named), no `import * as Lucide`. Es importante porque el `*` rompe tree-shaking.

**Verificación:** build después del fix < 350 KB main + chunks separados ≤200 KB cada uno. Lighthouse mobile FCP < 2s.

## Orden de ejecución sugerido

1. **CRIT-1 primero** (10 min). Sin esto no podemos verificar nada visual.
2. **CRIT-2** (30 min). El más importante para integridad operativa.
3. **HIGH-1 + HIGH-2** en mismo commit (45 min). Ambos son responsive, conviene hacerlos juntos.
4. **MEDIUM-1** (60 min). Code-splitting + análisis bundle.
5. `npm run test:admin` + Playwright smoke en cada commit.

## Reporte esperado al terminar

```
PANEL CRITICAL BUGS — implementado

CRIT-1 vite cache corrupto: <fix aplicado, panel renderea>
CRIT-2 GET muta audit: <middleware aplicado o split endpoint>
HIGH-1 mobile sidebar: <drawer / nav horizontal>
HIGH-2 mobile pipeline: <overflow-x-auto>
MEDIUM-1 bundle 607KB: <main NN KB, X chunks separados>
tests: <N>/<N> verdes
verify-chain: events_total=N (sin crecer entre polls), chain_ok=N, OK

next action: operator review visual (Claude vuelve a entrar con Chrome MCP y audita las 9 pantallas con render real)
```

## Restricciones

- **No** tocar Hito 5.11.B ni los OPS Ola 1/2 cerrados (backend completo).
- **No** cambiar tokens en `tokens.css` (solo consumirlos).
- **No** romper tests existentes.
- **No** invalidar contratos del read-boundary (los endpoints expuestos siguen siendo los mismos).
- **No** introducir nuevo hex hardcoded — usar tokens del design system.

## Referencias

- Hito 5.11.C master: https://www.notion.so/3667932c3b4281e5b815d3b527d18f3c
- Audit chain spec: `DOCUMENTACION/OPENCLAW_AUDIT_INTEGRATION.md`
- Code-splitting React docs: https://react.dev/reference/react/lazy
