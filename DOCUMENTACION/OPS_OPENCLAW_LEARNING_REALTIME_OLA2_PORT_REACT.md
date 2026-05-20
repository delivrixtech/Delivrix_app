# OPS — Learning Real-Time Ola 2 · Port Pencil → React (self-contained)

**Fecha:** 2026-05-20
**Sub-hito:** Ola 2 Frontend — porting de 3 componentes nuevos + reuso de Ola 1 + cableo en learning section
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Pre-requisito:** Backend Ola 2 ya implementado (`2b88ab5`). Ola 1 frontend ya implementado (`f579368`).
**Regla rectora:** `port 1:1 no interpretacion`. Las specs JSON inline en §3 son la fuente de verdad. Codex implementa sin necesidad de Pencil MCP (Pencil tuvo un bug de rendering en los componentes nuevos que evitamos con este enfoque self-contained).

## 1. Por qué self-contained (como v2 de Ola 1)

Diseñé los 3 componentes nuevos en Pencil pero el motor de layout no los rendea correctamente (`snapshot_layout` reporta `fully clipped` aunque el patrón estructural es idéntico al de los componentes de Ola 1 que sí renderean). En vez de debuggear el bug de Pencil (no bloqueante para la implementación), entrego specs inline para que Codex implemente. La regla `port 1:1 no interpretacion` se respeta porque las specs aquí son derivadas literalmente de los patrones probados de Ola 1.

## 2. Componentes existentes a reusar (de Ola 1)

Ya están en `apps/admin-panel/src/shared/ui/realtime/` (commit `f579368`):

- **`StaleBadge`** — para corner de cards de Bitácora/Evidencia cuando `meta.dataSource === "cached"`
- **`FallbackBanner`** — para top de sección Aprendizaje cuando `meta.dataSource === "fallback"` en cualquiera de los 2 endpoints Learning
- **`RealtimeTick`** — para indicar item nuevo en la lista cuando llega evento fresh entre polls

## 3. Componentes nuevos a portar (spec JSON inline)

Crear en `apps/admin-panel/src/shared/ui/realtime/`:

### 3.1 `SkeletonRow.tsx` (variante horizontal del SkeletonKpiCard)

```json
{
  "type": "frame",
  "layout": "horizontal",
  "alignItems": "center",
  "padding": [12, 16],
  "gap": 12,
  "cornerRadius": "$radius-md",
  "fill": "$surface-tertiary",
  "stroke": { "align": "inside", "fill": "$border-subtle", "thickness": 1 },
  "width": "fill_container",
  "children": [
    { "type": "rectangle", "width": 80, "height": 10, "cornerRadius": "$radius-sm", "fill": "$state-neutral-bg" },
    {
      "type": "frame", "layout": "vertical", "gap": 6, "width": "fill_container",
      "children": [
        { "type": "rectangle", "width": "fill_container", "height": 12, "cornerRadius": "$radius-sm", "fill": "$state-neutral-bg" },
        { "type": "rectangle", "width": 160, "height": 8, "cornerRadius": "$radius-sm", "fill": "$state-neutral-bg" }
      ]
    },
    { "type": "rectangle", "width": 60, "height": 20, "cornerRadius": "$radius-sm", "fill": "$state-neutral-bg" }
  ]
}
```

**React target:** `<SkeletonRow />`. Fila ~52px alta, full-width: pill timestamp 80×10 | body vertical (rect 12 + rect 160×8) | badge 60×20. Animación shimmer opcional reutilizando la del SkeletonKpiCard.

```tsx
interface SkeletonRowProps {}

export function SkeletonRow(): JSX.Element {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-md border border-border-subtle bg-surface-tertiary w-full"
    >
      <div className="h-2.5 w-20 rounded-sm bg-state-neutral-bg animate-pulse" />
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="h-3 w-full rounded-sm bg-state-neutral-bg animate-pulse" />
        <div className="h-2 w-40 rounded-sm bg-state-neutral-bg animate-pulse" />
      </div>
      <div className="h-5 w-15 rounded-sm bg-state-neutral-bg animate-pulse" />
    </div>
  );
}
```

### 3.2 `EmptyEventsCard.tsx` (variante de EmptySessionsCard)

Mismo patrón estructural que `EmptySessionsCard` con 3 cambios:
- `iconFontName`: `"inbox"` (en vez de `"person_off"`)
- title: `"Sin eventos del agente"`
- body: `"OpenClaw no registró actividad nueva en los últimos 30 minutos"`

```json
{
  "type": "frame",
  "layout": "vertical",
  "alignItems": "center",
  "gap": 12,
  "padding": [24, 20],
  "cornerRadius": "$radius-md",
  "fill": "$surface-tertiary",
  "stroke": { "align": "inside", "fill": "$border-subtle", "thickness": 1 },
  "width": 360,
  "children": [
    { "type": "icon_font", "iconFontFamily": "Material Symbols Rounded", "iconFontName": "inbox", "width": 32, "height": 32, "fill": "$foreground-tertiary" },
    { "type": "text", "content": "Sin eventos del agente", "fontFamily": "$font-heading", "fontSize": 16, "fontWeight": "600", "fill": "$foreground-primary" },
    { "type": "text", "content": "OpenClaw no registró actividad nueva en los últimos 30 minutos", "fontFamily": "$font-caption", "fontSize": 12, "fill": "$foreground-secondary", "textAlign": "center", "textGrowth": "fixed-width", "width": "fill_container" },
    { "type": "text", "content": "Refresca cada 30 s", "fontFamily": "$font-data", "fontSize": 10, "fill": "$foreground-tertiary" }
  ]
}
```

**React target:** `<EmptyEventsCard pollIntervalSeconds?={number} />`. Idéntico a `EmptySessionsCard` con los 3 cambios listados. Si quieres ahorrar duplicación, puedes refactorizar a un `<EmptyDataCard kind="events" | "evidence" | "sessions" />` genérico (decisión de Codex).

### 3.3 `EmptyEvidenceCard.tsx` (variante de EmptySessionsCard)

Mismos cambios que EmptyEventsCard pero con:
- `iconFontName`: `"folder_off"`
- title: `"Sin evidencia curada"`
- body: `"OpenClaw no ha promovido lecciones nuevas. Espera la próxima sesión supervisada."`

```json
{
  "type": "frame",
  "layout": "vertical",
  "alignItems": "center",
  "gap": 12,
  "padding": [24, 20],
  "cornerRadius": "$radius-md",
  "fill": "$surface-tertiary",
  "stroke": { "align": "inside", "fill": "$border-subtle", "thickness": 1 },
  "width": 360,
  "children": [
    { "type": "icon_font", "iconFontFamily": "Material Symbols Rounded", "iconFontName": "folder_off", "width": 32, "height": 32, "fill": "$foreground-tertiary" },
    { "type": "text", "content": "Sin evidencia curada", "fontFamily": "$font-heading", "fontSize": 16, "fontWeight": "600", "fill": "$foreground-primary" },
    { "type": "text", "content": "OpenClaw no ha promovido lecciones nuevas. Espera la próxima sesión supervisada.", "fontFamily": "$font-caption", "fontSize": 12, "fill": "$foreground-secondary", "textAlign": "center", "textGrowth": "fixed-width", "width": "fill_container" },
    { "type": "text", "content": "Refresca cada 30 s", "fontFamily": "$font-data", "fontSize": 10, "fill": "$foreground-tertiary" }
  ]
}
```

## 4. Tokens (todos ya existen, ver §3 del OPS de Ola 1 v2 para tabla completa)

Mismos tokens del Hito 5.10 + Ola 1. Si Codex implementa `EmptyDataCard` genérico, asegurar que la API permita pasar `iconFontName`, `title`, `body` como props.

## 5. Cableo en `apps/admin-panel/src/features/learning/index.tsx`

El feature Learning hoy renderiza dos cards principales: "Bitácora del aprendizaje" y "Evidencia curada por OpenClaw". Aplicar el mismo patrón que Safety:

```tsx
const skillsAudit = useQuery({ queryKey: ["openclaw", "skills-audit"], queryFn: ..., refetchInterval: 30_000 });
const evidence = useQuery({ queryKey: ["openclaw", "evidence"], queryFn: ..., refetchInterval: 30_000 });

// Bitácora card
if (skillsAudit.isLoading) {
  return <div className="flex flex-col gap-2">{Array.from({length:5}).map((_,i) => <SkeletonRow key={i} />)}</div>;
}
const skills = skillsAudit.data;
const showFallback = skills.meta.dataSource === "fallback";
const showStale = skills.meta.dataSource === "cached";
const noEvents = skills.events.length === 0;

return (
  <>
    {showFallback && <FallbackBanner />}
    <BitacoraCardReal
      events={skills.events}
      stale={showStale ? <StaleBadge minutesAgo={Math.floor(skills.meta.staleSinceMs / 60000)} /> : null}
    />
    {noEvents && <EmptyEventsCard />}
  </>
);
```

Aplicar lógica equivalente para Evidence card con `<EmptyEvidenceCard />`.

**Importante:** los 2 arrays hardcoded en `learning/index.tsx` (`PLAN_MILESTONES` línea 411 y `SKILLS` línea 567) son FALLBACK para cuando `data.readinessSignals.recommendations` está vacío. Esos NO se tocan en este OPS — pertenecen al cleanup tokenization (`OPS_PANEL_TOKENIZATION_CLEANUP.md`).

## 6. Verificación

1. `npm run test:admin` — 17/17 actuales deben seguir verdes.
2. Agregar tests para los 3 nuevos componentes (snapshot + render por estado).
3. `npm run build` — sin errores TS.
4. Smoke visual: levantar panel local, ir a Aprendizaje, verificar:
   - Loading inicial → SkeletonRow ×5 aparecen, luego data real
   - Apagar gateway → FallbackBanner aparece tras 30s
   - Cache expira → StaleBadge en cards
   - Audit vacío temporalmente → EmptyEventsCard / EmptyEvidenceCard según card
5. Curl smoke (ya verificados en backend Ola 2):
   - `curl http://localhost:3000/v1/openclaw/skills/audit | jq '.meta'` → dataSource live
   - `curl http://localhost:3000/v1/openclaw/evidence | jq '.curated | length'` → > 0

## 7. Restricciones

- **No** modificar builders `packages/domain/src/openclaw-skills-audit.ts` ni handlers `apps/gateway-api/src/main.ts`. Backend ya cerrado (`2b88ab5`).
- **No** modificar los 5 componentes Ola 1 existentes en `apps/admin-panel/src/shared/ui/realtime/`. Solo agregar los 3 nuevos.
- **No** inventar tokens. Si falta uno en Tailwind, agregarlo con el hex exacto del Ola 1 OPS v2 §3.
- **No** tocar `PLAN_MILESTONES` o `SKILLS` en learning/index.tsx. Eso es parte del OPS de tokenization cleanup.
- **No** invadir Ola 1 Safety ni otros features.

## 8. Reporte esperado al terminar

```
LEARNING REAL-TIME OLA 2 PORT REACT — implementado

componentes nuevos: 3 en apps/admin-panel/src/shared/ui/realtime/ (SkeletonRow, EmptyEventsCard, EmptyEvidenceCard)
componentes cableados: Bitácora card + Evidencia card en features/learning/index.tsx
tests: <N>/<N> verdes (X nuevos)
build vite: OK
smoke visual: 4 estados (loading, live, cached, fallback, empty) verificados

next action: operator review
```

## 9. Commits sugeridos

1. `docs: add Learning real-time port React spec (self-contained Ola 2)` (este OPS)
2. `feat(panel): add SkeletonRow + EmptyEventsCard + EmptyEvidenceCard realtime components`
3. `feat(panel): wire Learning Bitácora and Evidence to meta.dataSource/staleSinceMs`
4. `test(panel): cover Learning real-time degraded states`

## 10. Referencias

- Backend spec: `DOCUMENTACION/OPS_OPENCLAW_LEARNING_REALTIME_OLA2.md` (ya implementada en `2b88ab5`)
- Patrón a copiar (Ola 1): `DOCUMENTACION/OPS_OPENCLAW_SAFETY_REALTIME_OLA1_PORT_REACT_V2.md` §2 (specs JSON inline)
- Componentes Ola 1 existentes: `apps/admin-panel/src/shared/ui/realtime/`
- Hooks API: `apps/admin-panel/src/shared/api/client.ts` (agregar `getJson` para skills-audit y evidence si no existe)
- Cleanup tokenization (ejecutar después): `DOCUMENTACION/OPS_PANEL_TOKENIZATION_CLEANUP.md`
