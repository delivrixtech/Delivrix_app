# OPS — Rediseño Panel v2 · Port Pencil → React (self-contained)

**Fecha:** 2026-05-20
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Sub-hito:** Rediseño profesional de las 3 pantallas más usadas (Overview + Canvas + Seguridad) con building blocks reutilizables. Hito 5.11.C.
**Pre-requisitos:** Bugs críticos cerrados (CRIT-1/CRIT-2/HIGH-1/HIGH-2/MEDIUM-1, commits 45678c4 / cf75dd5 / 90c419f).
**Regla rectora:** `port 1:1 no interpretacion`. Esta v2 incluye specs JSON literal leídas por Claude vía Pencil MCP de los 3 frames v2 (`qLtC3` Overview, `o5lbP` Canvas, `jxinc` Seguridad). El `.pen` físico quedó en limbo por el rename diseño→design + Pencil cacheando path antiguo — por eso esta spec es **self-contained**: Codex implementa sin tocar Pencil MCP.

## 1. Por qué este rediseño

Auditoría conjunta Claude (Chrome MCP) + Codex (terminales) descubrió que el panel:

- Ya no se ve "horrible" — los CRIT bugs estaban escondiendo el render real
- Pero le falta **sensación de "vivo"** (sin pulse, sin "hace Ns" relativo, sin tick entre polls)
- Inconsistencias visuales: KPIs con/sin sparkline, banner OpenClaw verboso, severity sin jerarquía clara

Los 3 v2 atacan esto con **10 building blocks reutilizables** + reorganización de 3 features.

## 2. Building blocks nuevos (`apps/admin-panel/src/shared/ui/`)

Crear carpeta `apps/admin-panel/src/shared/ui/v2/` con estos componentes:

### 2.1 `<LiveIndicator pollIntervalSec={number} lastUpdateSec={number} />`

```json
{
  "type": "frame",
  "layout": "horizontal",
  "alignItems": "center",
  "gap": 8,
  "padding": [6, 12],
  "cornerRadius": 9999,
  "fill": "$state-success-bg",
  "children": [
    {
      "type": "frame",
      "layout": "none",
      "width": 8, "height": 8,
      "children": [
        { "type": "ellipse", "x": 0, "y": 0, "width": 8, "height": 8, "fill": "$state-success", "opacity": 0.3 },
        { "type": "ellipse", "x": 2, "y": 2, "width": 4, "height": 4, "fill": "$state-success" }
      ]
    },
    {
      "type": "text",
      "content": "Live · poll {pollIntervalSec}s · hace {lastUpdateSec}s",
      "fontFamily": "$font-data",
      "fontSize": 11,
      "fontWeight": "600",
      "fill": "$state-success"
    }
  ]
}
```

**Animación:** halo (ellipse 8×8 opacity 0.3) pulse infinito 2s scale 1 → 1.4 → 1 + opacity 0.3 → 0 → 0.3. Inner dot estático.

### 2.2 `<KpiCardV2 label icon value delta deltaTone={"success"|"warning"|"critical"} />`

```json
{
  "type": "frame",
  "width": 280, "height": 132,
  "layout": "vertical",
  "padding": 20, "gap": 8,
  "fill": "$surface-tertiary",
  "cornerRadius": "$radius-md",
  "stroke": { "align": "inside", "fill": "$border-subtle", "thickness": 1 },
  "children": [
    {
      "type": "frame",
      "layout": "horizontal", "alignItems": "center", "gap": 8,
      "children": [
        { "type": "icon_font", "iconFontFamily": "Material Symbols Rounded", "iconFontName": "{icon}", "width": 16, "height": 16, "fill": "$foreground-tertiary" },
        { "type": "text", "content": "{label}", "fontFamily": "$font-caption", "fontSize": 12, "fontWeight": "600", "fill": "$foreground-secondary" }
      ]
    },
    { "type": "text", "content": "{value}", "fontFamily": "$font-heading", "fontSize": 32, "fontWeight": "600", "fill": "$foreground-primary" },
    {
      "type": "frame",
      "layout": "horizontal", "padding": [2, 8], "cornerRadius": "$radius-sm",
      "fill": "$state-{deltaTone}-bg",
      "children": [
        { "type": "text", "content": "{delta}", "fontFamily": "$font-data", "fontSize": 10, "fontWeight": "600", "fill": "$state-{deltaTone}" }
      ]
    }
  ]
}
```

### 2.3 `<SectionDivider title count?={number} caption?={string} />`

```json
{
  "type": "frame",
  "layout": "horizontal", "alignItems": "center", "gap": 12,
  "width": "fill_container", "height": 28,
  "children": [
    { "type": "text", "content": "{title}", "fontFamily": "$font-heading", "fontSize": 14, "fontWeight": "600", "fill": "$foreground-primary" },
    { "type": "frame", "padding": [2, 8], "cornerRadius": "$radius-sm", "fill": "$state-warning-bg", "children": [{ "type": "text", "content": "{count}", "fontFamily": "$font-data", "fontSize": 10, "fontWeight": "600", "fill": "$state-warning" }] },
    { "type": "rectangle", "width": "fill_container", "height": 1, "fill": "$border-subtle" },
    { "type": "text", "content": "{caption}", "fontFamily": "$font-caption", "fontSize": 11, "fill": "$foreground-tertiary" }
  ]
}
```

### 2.4 `<BannerOpenClawV2 title body primaryCta secondaryCta onPrimary onSecondary />`

```json
{
  "type": "frame",
  "width": "fill_container", "height": 88,
  "layout": "horizontal", "alignItems": "center", "gap": 16,
  "padding": [16, 20],
  "cornerRadius": "$radius-md",
  "fill": "$state-warning-bg",
  "stroke": { "align": "inside", "fill": "$state-warning", "thickness": { "left": 4 } },
  "children": [
    { "type": "ellipse", "width": 40, "height": 40, "fill": "$accent-tertiary" },
    {
      "type": "frame", "layout": "vertical", "gap": 4, "width": "fill_container",
      "children": [
        { "type": "text", "content": "{title}", "fontFamily": "$font-heading", "fontSize": 14, "fontWeight": "600", "fill": "$state-warning" },
        { "type": "text", "content": "{body}", "fontFamily": "$font-body", "fontSize": 12, "fill": "$foreground-secondary" }
      ]
    },
    {
      "type": "frame", "layout": "horizontal", "gap": 8,
      "children": [
        { "type": "frame", "padding": [8, 14], "cornerRadius": "$radius-sm", "fill": "$state-warning", "children": [{ "type": "text", "content": "{primaryCta}", "fontFamily": "$font-caption", "fontSize": 13, "fontWeight": "600", "fill": "$foreground-inverse" }] },
        { "type": "frame", "padding": [8, 14], "cornerRadius": "$radius-sm", "stroke": { "fill": "$state-warning", "thickness": 1 }, "children": [{ "type": "text", "content": "{secondaryCta}", "fontFamily": "$font-caption", "fontSize": 13, "fontWeight": "600", "fill": "$state-warning" }] }
      ]
    }
  ]
}
```

### 2.5 `<ApprovalRow title body severityTone severityLabel onReview />`

Card horizontal 80h con: sev dot circular 40×40 (`bg=state-{tone}-bg`, icon `priority_high` 20px `fg=state-{tone}`) → body title/body verticales → sev pill → CTA "Revisar →" outline.

### 2.6 `<ComplianceCardV2 title state body runbookRef icon evaluatedSec />`

```json
{
  "type": "frame",
  "width": 360, "height": 200,
  "layout": "vertical", "padding": 20, "gap": 12,
  "fill": "$surface-tertiary",
  "cornerRadius": "$radius-md",
  "stroke": { "fill": "$state-{state}", "thickness": { "top": 3 } },
  "children": [
    {
      "type": "frame", "layout": "horizontal", "alignItems": "center", "gap": 10,
      "children": [
        { "type": "frame", "width": 28, "height": 28, "cornerRadius": "$radius-sm", "fill": "$state-{state}-bg", "children": [{ "type": "icon_font", "iconFontName": "{icon}", "width": 16, "height": 16, "fill": "$state-{state}" }] },
        { "type": "text", "content": "{title}", "fontFamily": "$font-heading", "fontSize": 14, "fontWeight": "600" },
        { "type": "frame", "padding": [2, 8], "cornerRadius": "$radius-sm", "fill": "$state-{state}-bg", "children": [{ "type": "text", "content": "{STATE_LABEL}", "fontFamily": "$font-caption", "fontSize": 10, "fontWeight": "600", "letterSpacing": 1, "fill": "$state-{state}" }] }
      ]
    },
    { "type": "text", "content": "{body}", "fontFamily": "$font-body", "fontSize": 12, "fill": "$foreground-secondary" },
    {
      "type": "frame", "layout": "horizontal", "alignItems": "center", "gap": 6,
      "children": [
        { "type": "icon_font", "iconFontName": "schedule", "width": 10, "height": 10, "fill": "$foreground-tertiary" },
        { "type": "text", "content": "evaluado hace {evaluatedSec} s", "fontFamily": "$font-data", "fontSize": 10, "fill": "$foreground-tertiary" },
        { "type": "rectangle", "width": "fill_container", "height": 1, "fill": "#00000000" },
        { "type": "icon_font", "iconFontName": "description", "width": 10, "height": 10, "fill": "$foreground-tertiary" },
        { "type": "text", "content": "{runbookRef}", "fontFamily": "$font-data", "fontSize": 10, "fill": "$foreground-secondary" }
      ]
    }
  ]
}
```

State map: `ok → state-success`, `warning → state-warning`, `info → state-info`, `critical → state-critical`.

### 2.7 `<IamRoleRow name color={"amber"|"green"|"blue"|"violet"} userCount permsCount />`

Row 56h fill `surface-secondary`: avatar circular 36×36 con inicial del nombre + body (nombre + "{permsCount} permisos" font-data) + badge cuadrado 36×24 con count grande.

### 2.8 `<IamSessionRow actor location transport last risk={"low"|"medium"|"high"} />`

Row 56h: avatar circular 32×32 fill `accent-tertiary` + body (actor monospaced + risk pill inline + meta location · transport · last seen).

### 2.9 `<KillSwitchV2 state={"armed"|"disarmed"} reason lastVerifiedSec onHistory />`

Card full-width 130h con border-left 4px `state-success` (armed) / `state-warning` (disarmed): icon wrap circular 64×64 con `power_settings_new` 32px + body (título grande + body) + CTA "Ver historial" outline con icon `history`.

### 2.10 Componentes Canvas v2 específicos

- **`<PromptStripTop title body primaryCta secondaryCta />`** — variante de BannerOpenClawV2 pero más alto (92px), avatar 40×40 con halo pulsante (overlay ellipse opacity 0.3 + inner 32×32 sólido)
- **`<LaneCard nodeName status laneColor isActive lastSec />`** — Card 200×110 con: status pill ALL CAPS 9px + nombre 13px heading + "hace Ns" font-data 10px. **Si `isActive: true`** → overlay rect detrás (-4, -4, 208×118) con `laneColor` opacity 0.15 + stroke 2px `laneColor`.
- **`<TimelineLive events autoScroll />`** — Card con header "Bitácora en vivo" + pulse tick + "auto-scroll · últimos N" caption + lista vertical de eventos (time mono 10px / tag pill / actor mono 11px / body 12px).
- **`<DetailPanelFreshness lastReadSec />`** — Mini badge `bg=state-success-bg` con icon `schedule` 10px + texto "última lectura · hace {N} s" font-data 10px weight 600.

## 3. Reorganización por feature

### 3.1 `apps/admin-panel/src/features/overview/index.tsx`

Reescribir layout siguiendo `qLtC3`:

```
<Topbar>
  <Breadcrumb />
  <Spacer />
  <LiveIndicator pollIntervalSec={30} lastUpdateSec={3} />
  <EnvChip text="GET-only · MVP" />
  <UserChip name="op-juanes-a" />
</Topbar>

<Content padding={32} gap={32}>
  <Hero title="..." subtitle="..." />

  <Row gap={16}>
    <KpiCardV2 label="Nodos activos" icon="schema" value="148" delta="+12" deltaTone="success" />
    <KpiCardV2 label="En calentamiento" icon="local_fire_department" value="44" delta="44/148" deltaTone="warning" />
    <KpiCardV2 label="Reputación promedio" icon="verified" value="94.2%" delta="+0.4" deltaTone="success" />
    <KpiCardV2 label="Alertas críticas" icon="warning" value="3" delta="últimas 24h" deltaTone="critical" />
  </Row>

  <SectionDivider title="Flujo operativo" caption="5 etapas · firmadas por humano" />
  <Pipeline stages={...} /> {/* ya existe, mantener pero asegurar active border 2px amber */}

  <BannerOpenClawV2 ... />

  <SectionDivider title="Aprobaciones pendientes" count={3} caption="Regla de 2 personas" />
  <ApprovalsList>
    <ApprovalRow ... />
  </ApprovalsList>
</Content>
```

### 3.2 `apps/admin-panel/src/features/canvas/index.tsx`

Reescribir siguiendo `o5lbP`:

```
<Topbar>
  <Breadcrumb />
  <Spacer />
  <LiveIndicator pollIntervalSec={5} lastUpdateSec={2} />
  <EnvChip />
</Topbar>

<Content layout="horizontal" gap={24}>
  <BoardArea width={870}>
    <Hero title="Flujo OpenClaw en vivo" subtitle="..." />
    <PromptStripTop title="OpenClaw propone..." body="..." primaryCta="Revisar runbook" />
    <Toolbar cluster="..." timeRanges={...} />

    <Swimlanes>
      {lanes.map(lane => (
        <Lane name={lane.name} color={lane.color}>
          {lane.nodes.map(n => <LaneCard ... isActive={n.status === "active"} />)}
          {/* arrows entre cards con icon arrow_forward */}
        </Lane>
      ))}
    </Swimlanes>

    <TimelineLive events={...} autoScroll />
  </BoardArea>

  <DetailPanel width={282}>
    <Title /> <FreshnessBadge lastReadSec={8} />
    <Section title="RESUMEN" body="..." />
    <Section title="MÉTRICAS OBSERVADAS" body="..." />
    <Section title="BLOQUEOS Y DEPENDENCIAS" body="..." />
    <Section title="APROBACIONES HUMANAS" body="..." />
    <Section title="BITÁCORA RECIENTE" body="..." />
  </DetailPanel>
</Content>
```

Animaciones a agregar (CSS):
- **Halo activo:** keyframe scale 1 → 1.05 → 1, opacity 0.15 → 0.25 → 0.15, loop 3s ease-in-out
- **Edge flow:** stroke-dasharray + dashoffset animation cuando edge tiene status active
- **Tick pulse:** mismo que LiveIndicator (200ms cuando cambia un valor)

### 3.3 `apps/admin-panel/src/features/safety/index.tsx`

Reescribir siguiendo `jxinc`:

```
<Topbar>
  <Breadcrumb />
  <Spacer />
  <LiveIndicator pollIntervalSec={30} lastUpdateSec={4} />
</Topbar>

<Content padding={32} gap={24}>
  <Hero title="Sin acciones reales, con todas las barandillas" subtitle="..." />

  <Row gap={16}>
    <ComplianceCardV2 title="GDPR · Privacidad" state="ok" body="..." runbookRef="privacy-runbook.md" icon="verified" evaluatedSec={4} />
    <ComplianceCardV2 title="Cumplimiento operativo" state="warning" ... icon="policy" />
    <ComplianceCardV2 title="Sin acciones reales" state="info" ... icon="block" />
  </Row>

  <SectionDivider title="IAM supervisado" caption="4 roles canónicos · 2 sesiones activas" />

  <Row gap={16}>
    <Card title="Roles">
      <IamRoleRow name="Operador" color="amber" userCount={4} permsCount={5} />
      <IamRoleRow name="SRE" color="green" ... />
      <IamRoleRow name="Auditor externo" color="blue" ... />
      <IamRoleRow name="Sólo lectura" color="violet" ... />
    </Card>
    <Card title="Sesiones activas" tickActive>
      <IamSessionRow actor="op-juanes-a" location="Popayán · CO" transport="vpn" last="hace 7 m" risk="low" />
      <IamSessionRow actor="sre-01" location="Bogotá · CO" transport="internal" last="hace 23 m" risk="low" />
    </Card>
  </Row>

  <SectionDivider title="Interruptor de corte" count={"ARMADO"} caption="última verificación hace 4 s" />
  <KillSwitchV2 state="armed" reason="..." lastVerifiedSec={4} />
</Content>
```

## 4. Tokens (todos ya existen post-tokenization)

Reusar paleta completa del Hito 5.10 + Ola 1. Sin tokens nuevos.

## 5. Animaciones CSS

```css
@keyframes pulse-ring {
  0%, 100% { transform: scale(1); opacity: 0.3; }
  50%      { transform: scale(1.4); opacity: 0; }
}
.pulse-ring { animation: pulse-ring 2s ease-in-out infinite; }

@keyframes halo-glow {
  0%, 100% { transform: scale(1); opacity: 0.15; }
  50%      { transform: scale(1.05); opacity: 0.25; }
}
.halo-glow { animation: halo-glow 3s ease-in-out infinite; }

@keyframes edge-flow {
  to { stroke-dashoffset: -20; }
}
.edge-flow { stroke-dasharray: 6 4; animation: edge-flow 1.5s linear infinite; }

@keyframes tick-pulse {
  0%   { transform: scale(1); opacity: 0; }
  50%  { transform: scale(2.5); opacity: 0.25; }
  100% { transform: scale(3); opacity: 0; }
}
.tick-pulse { animation: tick-pulse 200ms ease-out; }
```

## 6. Verificación

1. `npm run test:admin` 22/22 verdes + tests nuevos para los 10 building blocks (snapshot + render por variant)
2. `npm test` 205/205 verdes
3. `npm run build` sin errores TS
4. Smoke visual Chrome MCP:
   - Overview: ver LiveIndicator pulsante + 4 KPIs uniformes + dividers + banner OpenClaw v2 + 3 approval rows
   - Canvas: PromptStrip arriba + 5 swimlanes con halo activo + bitácora con tick + detail freshness
   - Seguridad: 3 compliance cards con border-top color + IAM grid 2 cards + kill switch v2 prominente
5. `verify-chain` debe seguir verde (sin nuevos eventos por polls)
6. Lighthouse mobile FCP < 2s

## 7. Restricciones

- **No** modificar backend/builders/handlers (todo cerrado en commits previos)
- **No** inventar tokens (usar los existentes de tokens.css)
- **No** romper tests existentes ni accessibility
- **No** tocar carpetas `realtime/` (Ola 1+2 ya cerradas) — los building blocks v2 van en `v2/`
- **No** invadir Hito 5.12 multi-provider
- **No** mantener arrays hardcoded — todo debe consumir data de props o de loadDashboardData

## 8. Reporte esperado

```
PANEL REDISEÑO V2 — implementado

building blocks: 10 en apps/admin-panel/src/shared/ui/v2/
features rediseñadas: overview, canvas, safety (index.tsx)
tests: N/N verdes (X nuevos para v2 components)
build vite: OK
smoke visual Chrome MCP: 3 pantallas verificadas
animations: pulse-ring + halo-glow + edge-flow + tick-pulse activas

next action: operator review final
```

## 9. Commits sugeridos

1. `docs: add panel rediseño v2 spec (self-contained)`
2. `feat(panel): add 10 v2 building blocks in shared/ui/v2/`
3. `feat(panel): redesign Overview with KPIs uniformes + dividers + banner v2`
4. `feat(panel): redesign Canvas with prompt strip top + lane halo + timeline live + detail freshness`
5. `feat(panel): redesign Seguridad with compliance v2 + IAM grid + kill switch v2`
6. `feat(panel): add pulse-ring + halo-glow + edge-flow + tick-pulse keyframes`
7. `test(panel): cover 10 v2 building blocks + 3 redesigned features`

## 10. Referencias

- Pencil source IDs (memoria del editor): Overview v2 `qLtC3`, Canvas v2 `o5lbP`, Seguridad v2 `jxinc`
- Bugs críticos OPS (ya cerrado): `DOCUMENTACION/OPS_PANEL_CRITICAL_BUGS_POST_AUDIT.md`
- Ola 1+2 specs (referencia patrón): `OPS_OPENCLAW_SAFETY_REALTIME_OLA1_PORT_REACT_V2.md`, `OPS_OPENCLAW_LEARNING_REALTIME_OLA2_PORT_REACT.md`
- Master Notion 5.11.C: https://www.notion.so/3667932c3b4281e5b815d3b527d18f3c
