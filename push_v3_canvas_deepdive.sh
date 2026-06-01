#!/bin/bash
# Push v3 — Canvas Live rediseño profundo + user journey
#
# Pedido directo CTO: "uno se pierde como usuario" + "ese canvas live, es
# horrible". Aplicado TasteSkill v2 (taste-skill + redesign-skill +
# minimalist-skill) + Impeccable + 7-point plan del agente Plan.
#
# Cambios sobre push anterior (rebrand B/W + Sidebar/Topbar/Footer):
#
# 1. Toggle sidebar movido del topbar al header del sidebar
#    (Linear/Notion/Cursor style — el control vive con el componente).
#
# 2. Canvas Live deep redesign (cambios 4-7 del plan + dos más):
#    - TasksColumn 220px (era 240) con Cursor-style active row:
#      barra 2px izquierda + surface-sunken bg, no border completo.
#    - TaskNodeRow radius 4 (era 8). Sin border decorativo. Padding
#      compacto. Tipografía consistente. Badges (sub, ×N) sin pill
#      saturado, solo mono text-tertiary.
#    - ColHead minimal: mono 10px uppercase tracking-widest
#      text-tertiary (era caption 11px semibold).
#    - ActionEmpty (Manus-style): alineado izquierda no centered.
#      Eyebrow mono uppercase + body + hint contextual de qué hacer.
#      Empty state inteligente por tab/status.
#    - methodTone: GET = neutral surface-sunken (lectura segura),
#      POST/PUT/PATCH/DELETE = pastels desaturados taste-minimalist §4.
#    - ArtifactStatusCard (Plan aprobado / Rechazado / Reporte read-only):
#      surface-sunken bg + hairline + dot indicator en lugar de soft
#      bg + border full color saturado.
#    - Artifact kind badge: dot color indicator + uppercase mono
#      tracking-widest + border 1px (era pill saturada soft).
#
# 3. Overview KPI heads pulidos:
#    - Labels mono 10px uppercase tracking-widest text-tertiary
#      (era caption 11px semibold text-secondary cramped).
#    - Pills ACTIVOS/EN CURSO/CRÍTICO/ESPERAN APROBACIÓN con
#      border 1px en lugar de fill saturado.
#    - Hierarchy clara: head label + value 32px tabular-nums +
#      detail mono.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# Limpiar locks stale
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# Pull primero
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# Stage frontend + docs
git add \
  apps/admin-panel/index.html \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/app/tokens.css \
  apps/admin-panel/src/shared/api/client.ts \
  apps/admin-panel/src/shared/ui/card.tsx \
  apps/admin-panel/src/shared/ui/v2/KillSwitchV2.tsx \
  apps/admin-panel/src/shared/ui/v2/BannerOpenClawV2.tsx \
  apps/admin-panel/src/shared/ui/v2/Toast.tsx \
  apps/admin-panel/src/shared/ui/realtime/FallbackBanner.tsx \
  apps/admin-panel/src/features/canvas/index.tsx \
  apps/admin-panel/src/features/canvas/canvas-v4.tsx \
  apps/admin-panel/src/features/canvas/canvas-live-client.ts \
  apps/admin-panel/src/features/canvas/live-tool.tsx \
  apps/admin-panel/src/features/hardware/index.tsx \
  apps/admin-panel/src/features/overview/index.tsx \
  apps/admin-panel/src/features/onboarding/index.tsx \
  apps/admin-panel/src/features/infrastructure/index.tsx \
  apps/admin-panel/src/features/clusters/index.tsx \
  apps/admin-panel/src/features/collector/index.tsx \
  apps/admin-panel/src/features/safety/index.tsx \
  apps/admin-panel/src/features/sender-pool/index.tsx \
  apps/admin-panel/src/features/sender-pool/wallet-widget.tsx \
  apps/admin-panel/src/features/domains/index.tsx \
  DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_BD_ORBSTACK_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md \
  DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md \
  DOCUMENTACION/REPORTE_READINESS_DEMO_VIERNES_2026_05_28.md

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "feat(panel): v3 — Canvas Live rediseño profundo + toggle sidebar fix

Tercer pase del rebrand B/W. Trabajo continuo del jueves con las 3
nuevas skills + agentes en paralelo.

== Fix · toggle sidebar al lugar correcto ==

El CTO marcó: '¿por qué ese botón está en el header y no en el
sidebar? en la barra lateral? espacio hay no?'.

Fix App.tsx:
- Botón toggle removido del Topbar (era anti-pattern semántico).
- Agregado al header del sidebar: expandido en esquina derecha,
  colapsado debajo del logo D centrado.
- Atajo ⌘\\ sigue funcionando global.
- Estilo Linear / Notion / Cursor: el control de visibilidad del
  sidebar vive con el sidebar.

Plus: el Tooltip component flotante que overlap el breadcrumb fue
reemplazado por title= nativo HTML (más sutil, sin chrome flotante).

== Canvas Live rediseño profundo ==

Pedido directo CTO: 'ese canvas live es horrible'. Agente Plan
diseñó 7-point plan con inspiraciones Cursor + Manus + Lovable.
Aplicados cambios 4-7 + bonus.

live-tool.tsx TasksColumn (Cursor-style):
- Width 240 → 220px.
- Empty state alineado izquierda con eyebrow mono + body + hint:
  'Cuando OpenClaw arranque una tarea, aparece acá con su estado
   en vivo.' (era 'Sin tareas activas' texto seco).

live-tool.tsx TaskNodeRow:
- Active state: barra vertical 2px izquierda text-primary +
  surface-sunken bg. Sin border completo (anti-pattern Impeccable).
- Radius 4 (era 8). Padding compacto 8px 10px.
- Badges 'N sub' / '×N' sin pill saturado: solo mono text-tertiary
  con símbolo ⌥ para sub-tareas. Cleaner.

live-tool.tsx ColHead:
- Mono 10px uppercase tracking-widest text-tertiary fontWeight 500
  (era caption 11px semibold 0.6px tracking). Cursor/Notion style.

live-tool.tsx ActionEmpty (Manus-style):
- Alineado izquierda (era centered). Padding 20px 24px.
- Eyebrow mono uppercase contextual ('sin tarea seleccionada',
  'tarea · idle', 'api · sin actividad').
- Body sans 13px text-secondary 500.
- Hint sutil text-tertiary 12px explicando qué hacer.

live-tool.tsx ArtifactStatusCard (Plan aprobado/Rechazado/Reporte):
- Surface-sunken bg + hairline 1px border + dot indicator color.
- Antes: bg saturado soft + border full color saturado.

live-tool.tsx artifact kind badge:
- Mono uppercase tracking-widest + dot color indicator + border 1px.
- Antes: pill caption semibold con bg saturado (info-soft amber/
  warning-soft / success-soft).

live-tool.tsx methodTone:
- GET = neutral surface-sunken text-secondary (lectura segura,
  TasteSkill minimalist §4).
- POST/PUT/PATCH/DELETE = pastels desaturados con \\\\\\\\\\\\\\\*-fg colors
  para legibilidad sobre soft bg.

== Overview KPI heads pulidos ==

overview/index.tsx KpiHead:
- Labels mono 10px uppercase tracking-widest text-tertiary
  fontWeight 500.
- Antes: caption 11px semibold text-secondary tracking-wide (mucha
  weight + poco tracking = cramped).
- Pills (ACTIVOS / EN CURSO / CRÍTICO / ESPERAN APROBACIÓN) con
  border 1px currentColor en lugar de fill saturado pillBg.

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- Visual Chrome MCP:
  * / : KPI heads consistentes 'NODOS DE ENVÍO / IPS EN
    CALENTAMIENTO / ÍNDICE DE REPUTACIÓN / GATES ABIERTOS' mono
    uppercase. Pills con border hairline. Values 32px tabular-nums.
  * /canvas : TasksColumn Cursor-style con barra activa 2px.
    ActionEmpty Manus-style alineado izquierda con eyebrow + body
    + hint. ArtifactStatusCard sutil con dot indicator. Kind badge
    'PROPUESTA' mono uppercase con border.
  * Sidebar: toggle en su lugar correcto. Topbar limpio sin botón
    flotante que overlap breadcrumb.

== Backlog post-demo ==

Polish vistas restantes:
- Collector card-in-card nesting.
- Onboarding stepper visual.
- Aprendizaje hierarchy.

Canvas Live plan completo:
- AgentPulse component (idle/thinking/executing) con barra 60×2px
  que viaja en topbar cuando ejecuta.
- ArtifactColumn estilo Lovable (un solo bloque editable scroll
  + footer sticky de acciones).

== Bloqueantes demo viernes ==

OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md sigue pendiente:
- warmup_seed (Acto 3 calentamiento del inbox).
- SMTP install retry interno (era flaky)."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
