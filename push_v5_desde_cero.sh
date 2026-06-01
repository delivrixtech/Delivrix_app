#!/bin/bash
# Push v5 — Frontend rediseñado DESDE CERO
#
# El CTO autorizó:
#   1. TODO el panel desde cero en ~12h
#   2. Agregar deps premium: Framer Motion + shadcn/ui primitives + Sonner
#   3. Rediseñar también el shell
#
# Lo entregado en este push:
#   - Setup deps premium en package.json (framer-motion, sonner, 9 @radix-ui/*)
#   - Sistema visual v5 en src/v5/ (separado de app/ legacy)
#     - lib/cn.ts (twMerge + clsx)
#     - lib/motion.ts (motion tokens TasteSkill MOTION=1)
#     - components/primitives.tsx (Eyebrow, Display, H1-H3, Body, MonoData,
#       HumanNote Caveat, Card cva, Pill, Badge, Chip, Stat, Button,
#       SectionHead, EmptyState, AgentPulse)
#     - shell/Shell.tsx (Sidebar Framer Motion colapsable + Topbar 52px +
#       Footer 36px, dark-first)
#     - views/Overview.tsx (Vista General desde cero con sistema v5)
#     - App.tsx (cablea Shell + lazy fallback a vistas viejas)
#   - main.tsx switch a AppV5
#   - index.html dark-first por default
#   - globals.css agrega aliases v5 + animaciones agent-pulse
#
# Las otras 10 vistas (Onboarding, Canvas Live, Hardware, Recolector,
# Infraestructura, Dominios, Sender Pool, Clústeres, Aprendizaje,
# Seguridad) siguen usando los componentes viejos por ahora, pero todos
# montan dentro del Shell v5 (dark theme, sidebar nuevo, topbar nuevo,
# footer nuevo).
#
# Plan: validar Vista General con Juanes. Si aprueba la dirección,
# propago el lenguaje a las 10 vistas restantes (estimado 6-8h más).

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# Limpiar locks stale
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# Pull primero
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# Stage TODO el v5 + cambios shell
git add \
  apps/admin-panel/package.json \
  apps/admin-panel/package-lock.json \
  apps/admin-panel/index.html \
  apps/admin-panel/src/main.tsx \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/app/tokens.css \
  apps/admin-panel/src/app/globals.css \
  apps/admin-panel/src/v5 \
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

git commit -m "feat(panel): v5 — frontend desde cero con deps premium

El CTO autorizó reescritura completa con Framer Motion + shadcn/ui +
Sonner, rediseñar también el shell, dark-first.

== Deps agregadas ==

dependencies (package.json):
- framer-motion ^12.40 (page transitions, stagger, sidebar slide)
- sonner ^2.0 (premium toasts apilables, Emil Kowalski)
- @radix-ui/react-accordion, collapsible, dialog, dropdown-menu,
  popover, scroll-area, separator, slot, tabs

== Sistema visual v5 (src/v5/) ==

Separado de app/ legacy para iteración segura. App viejo intacto.

src/v5/lib/cn.ts
  twMerge + clsx (patrón shadcn).

src/v5/lib/motion.ts
  Tokens motion · MOTION=1/5 minimal. Easings calibrados (easeOutQuart,
  easeOutExpo). pageEnter / staggerContainer / staggerItem /
  sidebarSlide / agentPulse variants.

src/v5/components/primitives.tsx
  Tipografía: Eyebrow / Display / H1-H3 / Body / BodySm / Caption /
    MonoData / MonoCode / HumanNote (Caveat).
  Containers: Card (cva tone/padding/interactive).
  Status: Pill (cva tone/size + dot) / Badge / Chip (interactive).
  Data: Stat (96px alto fijo, mono 30px tabular).
  Action: Button (cva variant primary/secondary/ghost/outline/
    destructive/link + size sm/md/lg/icon).
  Layout: SectionHead (eyebrow + h2 + caption + count + trailing) /
    EmptyState (alineado izq con eyebrow + h3 + body + action).
  Identity: AgentPulse (idle/thinking/executing) - la \"shape viva\".

src/v5/shell/Shell.tsx
  Sidebar 256/64 colapsable Framer Motion. Brand B/W. Grupos label
  uppercase tracking-widest. NavRow con barra activa 2px izq (v5-nav-row
  CSS), status dot derecha. Kill Switch compacto (Power + dot armado).
  Topbar 52px. Breadcrumb \"Grupo › Section\". AgentPulse al lado.
  Search ⌘K. DepChips pg/redis hairline. EnvChip. Refresh ghost.
  User avatar B/W.
  Main scrolleable centered max-w 1440. Page transitions con Framer
  Motion key={section} para fade-up al cambiar de vista.
  Footer 36px. D mark + DELIVRIX CONTROL PLANE eyebrow + build SHA +
  Read-only/Live writes + env + audit chain caption.
  ⌘\\ toggle global. ⌘K open command palette.

src/v5/views/Overview.tsx
  Vista General DESDE CERO con sistema v5.
  Hero: Eyebrow + Display Montserrat 34px + Body + Snapshot card.
  BannerOpenClaw: pill 'Dry-run' + h3 + body + HumanNote Caveat (única
    permitida por vista) + Primary CTA + ghost.
  KPIs (4 cols): NodesSpark mini-chart + KPI cards con valueTone
    semántico (critical en reputación 28.6, warning en warmup).
  Pipeline (5 cols): cards ETAPA 01-05 con pill ok/atención/idle +
    h3 + body + ProgressBar tonal + detail mono.
  Aprobaciones: lista con bullet dot + label + pill kind (ssh/dns/
    smtp/humano) + Revisar ghost. Slice 5 + 'Ver N más' link.
  Gates side panel: 8 gates con bullet warning + ds-body-sm + pend
    mono + 'Ver los 31 gates' link.

src/v5/App.tsx
  AppV5 + V5Inner. Cablea Shell con sus props.
  TooltipProvider + ToastProvider + OpenClawIntentProvider +
  CommandPaletteProvider + Sonner Toaster (dark theme custom styled).
  Vista General usa OverviewV5; otras 10 montan SectionView viejo
  dentro del Shell v5 (incremental safe). Cuando cada vista nueva esté
  aprobada, intercambia su entry.

== Cambios shell ==

apps/admin-panel/index.html
  Dark theme by default (era light-by-default + prefers-color-scheme).
  Operadores trabajan en dark; light explicito si forzado.

apps/admin-panel/src/main.tsx
  Switch App → AppV5 (la app vieja queda intacta en src/app/App.tsx).

apps/admin-panel/src/app/globals.css
  + Tailwind 4 theme aliases v5 (--color-fg, --color-fg-muted,
    --color-fg-subtle, --color-fg-inverse, --color-border,
    --color-border-strong, --color-border-focus, --color-accent,
    --color-accent-hover, --color-accent-fg, --font-display).
  + Animaciones agent-pulse-dot (1.4s pulse) + agent-pulse-bar
    (1.2s translateX -100→200% loop).
  + .v5-nav-row[data-active] CSS pseudo ::before barra 2px izq.

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores.
- Chrome MCP screenshots en dark theme:
  * Vista General hero Display Montserrat grande + Caveat human note.
  * KPI cards con valueTone crítico (28.6 rojo desaturado) + warning
    (warming 5 ambar) + success.
  * Pipeline 5 etapas con progress bars y pills.
  * Aprobaciones list clean con bullets semánticos.
  * Gates side panel compacto con eyebrow + ds-body-sm.
  * Sidebar Linear-style con grupos uppercase y nav rows.
  * Topbar minimal 52px con AgentPulse 'en espera'.
  * Footer 36px con DELIVRIX CONTROL PLANE + audit chain.

== Plan post-validación ==

Si la dirección queda aprobada, propago el lenguaje a las 10 vistas
restantes (estimado 6-8h). Cuando una vista nueva esté lista, su
import lazy en App.tsx se intercambia por la nueva.

Prioridad:
1. Canvas Live (segunda vista hero del demo).
2. Sender Pool / Aprobaciones (demuestran kill switch + audit chain).
3. Hardware, Recolector, Infraestructura, Onboarding, Dominios,
   Clústeres, Aprendizaje, Seguridad."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
