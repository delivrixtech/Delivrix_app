# OPS — Safety Real-Time Ola 1 · Port Pencil → React (v2, self-contained)

**Fecha:** 2026-05-20
**Versión:** v2 — supersede `OPS_OPENCLAW_SAFETY_REALTIME_OLA1_PORT_REACT.md` (v1 requería Pencil MCP de Codex que falló por path con ñ)
**Sub-hito:** Ola 1 Frontend — porting de 5 componentes Pencil al admin panel + cableo a `meta.dataSource` / `meta.staleSinceMs`
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Pre-requisito:** Backend Safety real-time ya implementado (commit `9d31d7d`)
**Regla rectora:** `port 1:1 no interpretacion`. Esta v2 incluye la spec JSON literal leída por Claude vía Pencil MCP directamente del `.pen` commiteado en `02db4bb`. Codex implementa desde esta spec sin tocar Pencil MCP.

## 1. Por qué v2

La v1 pedía a Codex leer los 5 componentes vía `mcp__pencil-desktop__batch_get` apuntando a `DOCUMENTACION/diseño/Panel_Front_End.pen`. La MCP de Codex no encontraba los IDs aunque estaban en el archivo en disco y en git HEAD (verificado por grep + `git show HEAD:archivo | grep`). Causa más probable: la **ñ** en el path (`diseño`) rompe el manejo en su MCP, o su Pencil cacheó una versión vieja.

**Fix permanente paralelo:** renombrar la carpeta `DOCUMENTACION/diseño/` → `DOCUMENTACION/design/` (ver §10). Mientras tanto, esta v2 incluye la spec inline para desbloquear ya.

## 2. Componentes a portar (spec JSON literal)

Las siguientes specs fueron leídas por Claude vía `mcp__pencil-desktop__batch_get` (filePath=`DOCUMENTACION/diseño/Panel_Front_End.pen`, readDepth=3). **Son la fuente de verdad para el port 1:1.**

### 2.1 `JeXwj` — Component / Stale Data Badge

```json
{
  "type": "frame",
  "name": "Component / Stale Data Badge",
  "reusable": true,
  "layout": "horizontal",
  "alignItems": "center",
  "padding": [4, 10],
  "gap": 6,
  "cornerRadius": "$radius-sm",
  "fill": "$state-warning-bg",
  "children": [
    {
      "type": "icon_font",
      "iconFontFamily": "Material Symbols Rounded",
      "iconFontName": "schedule",
      "width": 12, "height": 12,
      "fill": "$state-warning"
    },
    {
      "type": "text",
      "content": "Hace 12 min",
      "fontFamily": "$font-data",
      "fontSize": 11,
      "fontWeight": "normal",
      "fill": "$state-warning"
    }
  ]
}
```

**React target:** `<StaleBadge minutesAgo={number} />`. Pill amber con icono schedule + texto monospaced.

### 2.2 `GVCBF` — Component / Fallback Banner

```json
{
  "type": "frame",
  "name": "Component / Fallback Banner",
  "reusable": true,
  "layout": "horizontal",
  "alignItems": "center",
  "padding": [12, 16],
  "gap": 12,
  "cornerRadius": "$radius-md",
  "fill": "$state-warning-bg",
  "width": 480,
  "stroke": { "align": "inside", "fill": "$state-warning", "thickness": { "left": 3 } },
  "children": [
    {
      "type": "icon_font",
      "iconFontFamily": "Material Symbols Rounded",
      "iconFontName": "warning",
      "width": 20, "height": 20,
      "fill": "$state-warning"
    },
    {
      "type": "frame",
      "layout": "vertical",
      "gap": 2,
      "width": "fill_container",
      "children": [
        {
          "type": "text",
          "content": "Mostrando valores de respaldo",
          "fontFamily": "$font-caption",
          "fontSize": 12,
          "fontWeight": "600",
          "fill": "$state-warning",
          "textGrowth": "fixed-width",
          "width": "fill_container"
        },
        {
          "type": "text",
          "content": "Agente no disponible · datos pueden estar desactualizados",
          "fontFamily": "$font-caption",
          "fontSize": 11,
          "fontWeight": "normal",
          "fill": "$foreground-secondary",
          "textGrowth": "fixed-width",
          "width": "fill_container"
        }
      ]
    }
  ]
}
```

**React target:** `<FallbackBanner message?={string} />`. Banner amber con border-left amber 3px, icon warning, título + descripción en stack vertical. En el panel toma full-width (ignorar el 480 fijo, en el componente Pencil es solo el ancho de demo).

### 2.3 `uDAHQ` — Component / Skeleton KPI Card

```json
{
  "type": "frame",
  "name": "Component / Skeleton KPI Card",
  "reusable": true,
  "layout": "vertical",
  "gap": 12,
  "padding": [16, 20],
  "cornerRadius": "$radius-md",
  "fill": "$surface-tertiary",
  "width": 220,
  "stroke": { "align": "inside", "fill": "$border-subtle", "thickness": 1 },
  "children": [
    { "type": "rectangle", "width": 80, "height": 10, "cornerRadius": "$radius-sm", "fill": "$state-neutral-bg" },
    { "type": "rectangle", "width": 60, "height": 24, "cornerRadius": "$radius-sm", "fill": "$state-neutral-bg" },
    { "type": "rectangle", "width": 120, "height": 8, "cornerRadius": "$radius-sm", "fill": "$state-neutral-bg" }
  ]
}
```

**React target:** `<SkeletonKpiCard />`. Card 220×100 (height auto) con borde subtle, 3 rectángulos gris claro (label 80×10, valor 60×24, sparkline 120×8). Animación shimmer opcional (CSS).

### 2.4 `hlLkJ` — Component / Realtime Tick

```json
{
  "type": "frame",
  "name": "Component / Realtime Tick",
  "reusable": true,
  "layout": "horizontal",
  "alignItems": "center",
  "padding": [16, 20],
  "gap": 20,
  "cornerRadius": "$radius-md",
  "fill": "$surface-tertiary",
  "width": 440,
  "stroke": { "align": "inside", "fill": "$border-subtle", "thickness": 1 },
  "children": [
    {
      "type": "frame", "layout": "vertical", "alignItems": "center", "gap": 6,
      "children": [
        { "type": "ellipse", "width": 6, "height": 6, "fill": "$state-success" },
        { "type": "text", "content": "idle", "fontFamily": "$font-caption", "fontSize": 10, "fill": "$foreground-tertiary" }
      ]
    },
    {
      "type": "frame", "layout": "vertical", "alignItems": "center", "gap": 6,
      "children": [
        {
          "type": "frame", "layout": "none", "width": 14, "height": 14,
          "children": [
            { "type": "ellipse", "x": 0, "y": 0, "width": 14, "height": 14, "fill": "$state-success", "opacity": 0.25 },
            { "type": "ellipse", "x": 3, "y": 3, "width": 8, "height": 8, "fill": "$state-success" }
          ]
        },
        { "type": "text", "content": "tick 200ms", "fontFamily": "$font-caption", "fontSize": 10, "fill": "$foreground-tertiary" }
      ]
    },
    {
      "type": "frame", "layout": "vertical", "gap": 4, "width": "fill_container",
      "children": [
        { "type": "text", "content": "Realtime tick", "fontFamily": "$font-caption", "fontSize": 12, "fontWeight": "600", "fill": "$foreground-primary", "textGrowth": "fixed-width", "width": "fill_container" },
        { "type": "text", "content": "Pulse suave en valores que cambian entre polls", "fontFamily": "$font-caption", "fontSize": 10, "fill": "$foreground-secondary", "textGrowth": "fixed-width", "width": "fill_container" }
      ]
    }
  ]
}
```

**React target:** documentación visual para Codex. El componente RUNTIME es solo el dot animado: `<RealtimeTick active={bool} />`. Idle = ellipse 6×6 `state-success`. Pulse = ellipse 8×8 `state-success` con halo concéntrico (14×14 opacity 0.25) animado 200ms (CSS keyframes scale + fade). Sin sonido.

### 2.5 `ZXqFn` — Component / Empty Sessions Card

```json
{
  "type": "frame",
  "name": "Component / Empty Sessions Card",
  "reusable": true,
  "layout": "vertical",
  "alignItems": "center",
  "gap": 12,
  "padding": [24, 20],
  "cornerRadius": "$radius-md",
  "fill": "$surface-tertiary",
  "width": 360,
  "stroke": { "align": "inside", "fill": "$border-subtle", "thickness": 1 },
  "children": [
    { "type": "icon_font", "iconFontFamily": "Material Symbols Rounded", "iconFontName": "person_off", "width": 32, "height": 32, "fill": "$foreground-tertiary" },
    { "type": "text", "content": "Sin sesiones activas", "fontFamily": "$font-heading", "fontSize": 16, "fontWeight": "600", "fill": "$foreground-primary" },
    { "type": "text", "content": "Sin actividad de operador en los últimos 15 minutos", "fontFamily": "$font-caption", "fontSize": 12, "fill": "$foreground-secondary", "textAlign": "center", "textGrowth": "fixed-width", "width": "fill_container" },
    { "type": "text", "content": "Refresca cada 30 s", "fontFamily": "$font-data", "fontSize": 10, "fill": "$foreground-tertiary" }
  ]
}
```

**React target:** `<EmptySessionsCard pollIntervalSeconds?={number} />`. Card 360 wide, centrada vertical, icono person_off 32px, título heading 16, body caption 12 centrado, footer mono 10.

## 3. Tokens (mapeo Pencil → Tailwind/CSS)

Todos los tokens del Hito 5.10 ya existen en el design system del bundle. Mapear así (los valores hex son fuente de verdad si Tailwind no los tiene):

| Token Pencil | Light | Dark | Tailwind alias |
|---|---|---|---|
| `$state-warning-bg` | `#FEF3C7` | `#3A2A10` | `bg-state-warning-bg` |
| `$state-warning` | `#B45309` | `#FBBF24` | `text-state-warning` / `border-state-warning` |
| `$state-success` | `#15803D` | `#4ADE80` | `text-state-success` / `bg-state-success` |
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

Si algún token falta en Tailwind config, agregarlo con el hex exacto de arriba. NUNCA inventar.

## 4. Ubicación de los nuevos componentes en el bundle

```
apps/admin-panel/src/shared/ui/realtime/
  StaleBadge.tsx
  FallbackBanner.tsx
  SkeletonKpiCard.tsx
  RealtimeTick.tsx
  EmptySessionsCard.tsx
  index.ts          (re-exports)
```

Patrón: functional components, props tipadas, sin estado interno excepto donde sea necesario para animación. Tomar `apps/admin-panel/src/shared/ui/openclaw-prompt-panel.tsx` como referencia de estilo.

## 5. Props sugeridas

```ts
interface StaleBadgeProps { minutesAgo: number; }
interface FallbackBannerProps { message?: string; }
interface SkeletonKpiCardProps {}
interface RealtimeTickProps { active: boolean; }
interface EmptySessionsCardProps { pollIntervalSeconds?: number; }
```

## 6. Cableo a `meta` del payload

En los componentes que consumen los endpoints Safety:

```tsx
const { data, isLoading } = useSafetyCompliance();

if (isLoading) return <SkeletonKpiCard />;
if (data.meta.dataSource === "fallback") {
  return (<>
    <FallbackBanner />
    <ComplianceCardReal data={data} />
  </>);
}
if (data.meta.dataSource === "cached") {
  return (
    <ComplianceCardReal
      data={data}
      stale={<StaleBadge minutesAgo={Math.floor(data.meta.staleSinceMs / 60000)} />}
    />
  );
}
return <ComplianceCardReal data={data} />;
```

Aplicar lógica equivalente a:
- `safety/compliance-card.tsx`
- `safety/iam-roles-card.tsx`
- `safety/iam-sessions-table.tsx`

## 7. Realtime Tick — animación CSS

```css
@keyframes realtime-pulse {
  0%   { transform: scale(1); opacity: 0; }
  50%  { transform: scale(2.5); opacity: 0.25; }
  100% { transform: scale(3); opacity: 0; }
}
.realtime-tick-halo { animation: realtime-pulse 200ms ease-out; }
```

Disparar al cambio entre polls (key prop o useEffect comparando prev vs current).

## 8. Verificación

1. `npm run test:admin` — 15/15 deben seguir verdes.
2. Agregar tests para los 5 nuevos componentes (snapshot + render por estado).
3. `npm run build` — sin errores TS.
4. Smoke visual: panel local → Seguridad → verificar:
   - Primera carga → skeleton aparece, luego data real
   - Apagar gateway → tras 30s aparece banner fallback encima de Main
   - Cache expira → stale badge en cards
   - Audit log vacío temporalmente → empty card en iam/sessions
5. Comparación visual: si tu Pencil MCP funciona (después del rename §10), tomar `get_screenshot` del frame `Gcf2v` del `.pen` y comparar con bundle render. Si no, comparar visualmente contra el screenshot que Claude tiene en chat.

## 9. Restricciones

- **No** modificar builders `packages/domain/src/` ni handlers gateway. Backend ya cerrado (`9d31d7d`).
- **No** inventar tokens nuevos. Si falta uno en Tailwind, agregarlo con el hex exacto de §3.
- **No** alterar estructura de los componentes (jerarquía, dimensiones, padding). Cualquier desviación viola la regla.
- **No** romper tests existentes.
- **No** tocar OPS specs anteriores.
- **No** invadir scope Ola 2 (Learning).

## 10. Fix paralelo: rename `diseño/` → `design/`

Para evitar este tipo de bug en el futuro, **renombrar la carpeta** (la ñ rompe paths en algunas MCPs/herramientas):

```bash
git mv DOCUMENTACION/diseño DOCUMENTACION/design
git commit -m "chore(design): rename diseño/ to design/ for path portability"
git push
```

Después del rename, tomar nota:
- Actualizar memoria de Claude (`delivrix_sync_pendings_2026_05_19.md` y feedback `feedback_pencil_file_persistence`)
- Actualizar referencias en cualquier OPS doc que mencione la ruta vieja
- Juanes reabre el `.pen` desde la nueva ruta en Pencil Desktop

## 11. Commits sugeridos

1. `chore(design): rename diseño/ to design/ for path portability`
2. `docs: add Safety real-time port React spec v2 (self-contained)`
3. `feat(panel): port 5 Pencil components for Safety real-time degraded states`
4. `feat(panel): wire Safety cards/table to meta.dataSource/staleSinceMs`
5. `test(panel): cover Safety real-time degraded states`

## 12. Reporte esperado al terminar

```
SAFETY REAL-TIME OLA 1 PORT REACT v2 — implementado

componentes nuevos: 5 en apps/admin-panel/src/shared/ui/realtime/
componentes cableados: compliance-card, iam-roles-card, iam-sessions-table
tests: <N>/<N> verdes (X nuevos)
build vite: OK
fidelity vs Pencil spec §2: confirmado (port literal sin desviaciones)
rename diseño→design: ejecutado (commit <hash>)

next action: <"operator review" | "blocker reported">
```

## 13. Referencias

- Backend spec: `DOCUMENTACION/OPS_OPENCLAW_SAFETY_REALTIME_OLA1.md` (ya implementada en `9d31d7d`)
- Pencil source: `DOCUMENTACION/diseño/Panel_Front_End.pen` (o `DOCUMENTACION/design/` tras §10)
- Feedback memory: `port 1:1 no interpretacion` (Hito 5.10)
- v1 spec: `DOCUMENTACION/OPS_OPENCLAW_SAFETY_REALTIME_OLA1_PORT_REACT.md` (superseded por este v2)
