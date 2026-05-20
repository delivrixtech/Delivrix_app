# OPS — Safety Real-Time Ola 1 · Port Pencil → React

**Fecha:** 2026-05-20
**Sub-hito:** Ola 1 Frontend — porting de 5 componentes Pencil al admin panel + cableo a `meta.dataSource` / `meta.staleSinceMs`
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Pre-requisito:** Backend Safety real-time ya implementado (commit `9d31d7d`)
**Regla rectora:** `port 1:1 no interpretacion` — leer valores literales del `.pen`, NO adivinar desde screenshot ni inventar tokens.

## 1. Contexto

Backend Ola 1 cerrado por Codex (`9d31d7d`). Los 3 endpoints `/v1/compliance/status`, `/v1/iam/roles`, `/v1/iam/sessions` ahora retornan payload con `meta.dataSource: "live" | "cached" | "fallback"` y `meta.staleSinceMs: number | null`.

El frontend hoy renderiza el happy path (data live). Faltan 5 componentes nuevos para visualizar los estados degradados (loading, cached, fallback, sin sesiones). Esos 5 componentes ya están **diseñados en Pencil** y este OPS los porta a React.

## 2. Pre-requisitos

- `git pull origin main` — para tener el `.pen` y la spec actualizada.
- Pencil Desktop NO necesita estar abierto — Codex usa `mcp__pencil-desktop__batch_get` con `filePath`.
- Conocer la convención de tokens del admin panel (`apps/admin-panel/src/shared/ui/` y el config de Tailwind del Hito 5.10).

## 3. Componentes Pencil a portar

Archivo: `/Users/juanescanar/Documents/delivrix app/DOCUMENTACION/design/Panel_Front_End.pen`

Leer con `mcp__pencil-desktop__batch_get` (filePath + nodeIds + readDepth 3 + resolveVariables true) para tener dimensiones, tokens resueltos y estructura:

```
nodeIds: ["JeXwj", "GVCBF", "uDAHQ", "hlLkJ", "ZXqFn", "Gcf2v"]
```

| Pencil ID | Componente | React target | Cuándo se usa |
|---|---|---|---|
| `JeXwj` | Stale Data Badge | `<StaleBadge minutesAgo={n} />` | corner card cuando `meta.dataSource === "cached"` |
| `GVCBF` | Fallback Banner | `<FallbackBanner />` (full width) | encima de Main, debajo de Topbar, cuando `meta.dataSource === "fallback"` en cualquier endpoint Safety |
| `uDAHQ` | Skeleton KPI Card | `<SkeletonKpiCard />` (220×100) | reemplaza KPI card mientras primera respuesta del polling 30s está en vuelo |
| `hlLkJ` | Realtime Tick | `<RealtimeTick />` con CSS animation 200ms pulse + fade | adyacente al número del KPI cuando cambia entre polls |
| `ZXqFn` | Empty Sessions Card | `<EmptySessionsCard />` (360 wide) | reemplaza tabla cuando `/v1/iam/sessions` devuelve `sessions: []` |

**Frame de anatomía** (`Gcf2v`): spec visual con captions de uso. Usar como referencia para colocación. Tomar `get_screenshot` de `Gcf2v` antes de empezar y al finalizar (comparar bundle render vs Pencil 1:1).

## 4. Tokens a respetar (mapeo Pencil → Tailwind/CSS)

Todos los tokens del Hito 5.10 ya existen en el design system del bundle. Mapear así:

| Pencil token | Light mode | Dark mode | Tailwind alias (Hito 5.10) |
|---|---|---|---|
| `$state-warning-bg` | `#FEF3C7` | `#3A2A10` | `bg-state-warning-bg` |
| `$state-warning` | `#B45309` | `#FBBF24` | `text-state-warning` / `border-state-warning` |
| `$state-success` | `#15803D` | `#4ADE80` | `text-state-success` / `bg-state-success` |
| `$state-success-bg` | `#DCFCE7` | `#14352A` | `bg-state-success-bg` |
| `$state-critical-bg` | `#FEE2E2` | `#3F1A1A` | `bg-state-critical-bg` |
| `$state-neutral-bg` | `#F5F5F4` | `#2A2520` | `bg-state-neutral-bg` |
| `$surface-tertiary` | `#FFFFFF` | `#241D16` | `bg-surface-tertiary` |
| `$border-subtle` | `#EAE0CE` | `#322A20` | `border-border-subtle` |
| `$foreground-primary` | `#1A1410` | `#F5EDDF` | `text-foreground-primary` |
| `$foreground-secondary` | `#5C544A` | `#B5A892` | `text-foreground-secondary` |
| `$foreground-tertiary` | `#8A8073` | `#867865` | `text-foreground-tertiary` |
| `$radius-sm` (4px) | — | — | `rounded-sm` |
| `$radius-md` (6px) | — | — | `rounded-md` |
| `$font-heading` | Funnel Sans | — | `font-heading` |
| `$font-caption` | Inter | — | `font-caption` |
| `$font-data` | IBM Plex Mono | — | `font-data` |

Si algún token no existe ya en Tailwind config, agregar al `tailwind.config.ts` siguiendo el patrón existente. **No inventar valores hex** — usar los exactos del `.pen`.

## 5. Ubicación de los nuevos componentes en el bundle

```
apps/admin-panel/src/shared/ui/
  realtime/
    StaleBadge.tsx
    FallbackBanner.tsx
    SkeletonKpiCard.tsx
    RealtimeTick.tsx
    EmptySessionsCard.tsx
    index.ts          (re-exports)
```

Patrón a seguir: mismo estilo que `apps/admin-panel/src/shared/ui/openclaw-prompt-panel.tsx` (functional components, props tipadas estrictamente, sin estado interno excepto donde sea necesario para animación).

## 6. Props sugeridas

```ts
interface StaleBadgeProps {
  minutesAgo: number;
}

interface FallbackBannerProps {
  message?: string;
}

interface SkeletonKpiCardProps {}

interface RealtimeTickProps {
  active: boolean;
}

interface EmptySessionsCardProps {
  pollIntervalSeconds?: number;
}
```

## 7. Cableo a meta del payload

En los componentes que consumen los endpoints Safety:

```ts
const { data, isLoading } = useSafetyCompliance();

if (isLoading) return <SkeletonKpiCard />;
if (data.meta.dataSource === "fallback") return <><FallbackBanner /><CardReal data={data} /></>;
if (data.meta.dataSource === "cached") return <CardReal data={data} stale={<StaleBadge minutesAgo={Math.floor(data.meta.staleSinceMs / 60000)} />} />;
return <CardReal data={data} />;
```

Aplicar lógica equivalente a:
- `safety/compliance-card.tsx`
- `safety/iam-roles-card.tsx`
- `safety/iam-sessions-table.tsx`

## 8. Realtime Tick — animación CSS

El componente `RealtimeTick` necesita una animación CSS (Pencil es estático):

```css
@keyframes realtime-pulse {
  0%   { transform: scale(1); opacity: 0; }
  50%  { transform: scale(2.5); opacity: 0.25; }
  100% { transform: scale(3); opacity: 0; }
}
.realtime-tick-halo { animation: realtime-pulse 200ms ease-out; }
```

Disparar la animación cuando el valor renderizado cambia entre polls (key prop o useEffect comparando prev vs current).

## 9. Verificación

1. `npm run test:admin` — tests existentes 15/15 deben seguir verdes.
2. Agregar tests para los 5 nuevos componentes (snapshot tests + render tests por estado).
3. `npm run build` (vite) — debe pasar sin errores de TypeScript.
4. Smoke visual: levantar el panel local, ir a Seguridad, verificar visualmente:
   - Primera carga → skeleton aparece y luego data real
   - Apagar gateway → tras 30s, banner fallback aparece encima de Main
   - Esperar que cache expire → stale badge aparece en cards
   - Vaciar audit log temporalmente → empty card en iam/sessions
5. **`mcp__pencil-desktop__get_screenshot` del frame `Gcf2v`** y comparar visualmente con el panel renderizado. Debe ser 1:1 en tokens, dimensiones y jerarquía.

## 10. Reporte esperado al terminar

```
SAFETY REAL-TIME OLA 1 PORT REACT — implementado

componentes nuevos: 5 en apps/admin-panel/src/shared/ui/realtime/
componentes cableados: compliance-card, iam-roles-card, iam-sessions-table
tests: <N>/<N> verdes (X nuevos para componentes realtime)
build vite: OK
fidelity vs Pencil Gcf2v: 1:1 confirmado por screenshot side-by-side

next action: <"operator review" | "blocker reported">
```

## 11. Restricciones

- **No** modificar los builders de `packages/domain/src/` ni los handlers del gateway. Backend ya está cerrado por commit `9d31d7d`.
- **No** inventar tokens nuevos. Si falta uno en Tailwind, agregarlo con el valor exacto del `.pen`.
- **No** alterar la estructura de los componentes Pencil (jerarquía, dimensiones, padding). Cualquier desviación es "interpretación" y viola la regla rectora.
- **No** romper tests existentes.
- **No** tocar `OPS_OPENCLAW_SAFETY_REALTIME_OLA1.md` (la spec backend, ya consumida).
- **No** invadir el scope de Ola 2 (Learning). Solo tocar Safety.

## 12. Commits sugeridos

1. `docs: add Safety real-time Ola 1 port React spec` (este OPS) + `chore: add Panel Front End pencil source to design dir` (commitea el `.pen`)
2. `feat(panel): port 5 Pencil components for Safety real-time degraded states`
3. `feat(panel): wire Safety cards/table to meta.dataSource/staleSinceMs`
4. `test(panel): cover Safety real-time degraded states`

## 13. Referencias

- Spec backend (ya implementada): `DOCUMENTACION/OPS_OPENCLAW_SAFETY_REALTIME_OLA1.md` §8 (con IDs Pencil)
- Pencil source: `DOCUMENTACION/design/Panel_Front_End.pen`
- Feedback memory rule: `port 1:1 no interpretacion` (Hito 5.10)
- Sub-hito sucesor: Ola 2 — Learning (`/v1/openclaw/skills/audit`, `/v1/openclaw/evidence`)
