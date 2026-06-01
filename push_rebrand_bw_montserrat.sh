#!/bin/bash
# Push REBRAND B/W + Montserrat completo — jueves 28-may
#
# Pedido directo Juanes: rediseño profesional total del panel.
# Colores oficiales: NEGRO + BLANCO.
# Tipografía: Montserrat (principal) + JetBrains Mono (mono) + Caveat (decorativa).
# Sidebar + Topbar profesionales tipo Linear/Notion/Stripe.
#
# Este push consolida los 3 commits frontend Claude del jueves
# (auditoría + Impeccable + DB chips) + el rebrand B/W + Montserrat
# + Sidebar profesional Linear-style + Topbar refactor.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# Limpiar locks stale
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# Pull primero (Codex puede haber pusheado los bloqueantes)
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# Stage TODOS los archivos frontend + docs
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
  DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_BD_ORBSTACK_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md \
  DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md \
  DOCUMENTACION/REPORTE_READINESS_DEMO_VIERNES_2026_05_28.md

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "feat(panel): rebrand B/W + Montserrat + Sidebar/Topbar profesionales

Push consolidado del jueves 28-may con TODO el trabajo frontend Claude
acumulado, integrado con los 2 commits backend que Codex pusheó hoy
(6500a15 contratos ES + 50876e5 OrbStack BD).

== Rebrand B/W oficial (pedido directo Juanes) ==

CTO pidió rediseño profesional total. Colores oficiales: NEGRO +
BLANCO. Tipografía: Montserrat (sans/heading), JetBrains Mono (mono),
Caveat (decorativa). Sidebar + Topbar profesionales Linear/Notion.

apps/admin-panel/src/app/tokens.css — reescritura completa:
- Surfaces: blanco puro (era cream warm).
- Borders: hairlines neutros #e5e5e5.
- Foreground: negro #0a0a0a / 525252 / 8a8a8a / b5b5b5.
- Accent: negro puro (era amber gradient).
- Semantic: success/warning/critical/info DESATURADOS y SOBRIOS,
  comunican estado sin gritar. Linear-style.
- Dark theme: negros profundos con blanco como accent.

apps/admin-panel/index.html — carga Google Fonts con preconnect:
- Montserrat 300-900 + italics (display principal).
- JetBrains Mono 400-700 + italics (datos/code/audit).
- Caveat 400-700 (touch decorativo human-notes).

tokens.css fonts:
+ --font-sans/heading/body/caption: Montserrat.
+ --font-mono: JetBrains Mono.
+ --font-display: Caveat (para componentes que la pidan explícito).

Letter-spacing recalibrado para Montserrat:
- tracking-tightest -0.5px (display)
- tracking-tight -0.25px (headings)
- tracking-wide 0.3px
- tracking-wider 0.6px
- tracking-widest 1.4px

== Sidebar profesional Linear-style ==

apps/admin-panel/src/app/App.tsx Sidebar refactor:
- Modo expandido (240/256px): nav completo con grupos.
- Modo COLAPSADO (64px): solo iconos centrados con tooltip al hover.
  Brand + Kill Switch siempre visibles, colapsando solo el text.
- Active state: surface-sunken bg + accent ring izquierdo 2px
  (hairline, NO un side-tab que sería un anti-pattern Impeccable).
- Hover smooth con transition-colors 120ms.
- Brand mark monocromático (era gradient amber).
- Status dots por sección (success/warning/critical) en esquina
  superior derecha cuando colapsado, al final del item cuando
  expandido.
- Borders entre grupos en modo colapsado (visual separator).

KillSwitchCard ahora soporta prop `collapsed`:
- Expandido: card completa con label + pill armado/activo + caption.
- Colapsado: solo Power icon con dot armado/activo en esquina.

== Topbar profesional ==

apps/admin-panel/src/app/App.tsx Topbar refactor:
- Sticky, height fijo 56px (era flex-wrap variable).
- Mejor jerarquía visual: toggle / breadcrumb / search / divider /
  status chips / divider / actions / user.
- Breadcrumb: 'Grupo > Sección' (era 'Operar > Sección', ahora
  muestra el grupo real — Estado/Operación/Barandillas).
- Section title: Montserrat 14px semibold con tracking -0.2.
- Búsqueda con border + hover-state mejorado, ⌘K en JetBrains Mono.
- Vertical dividers 1px entre grupos lógicos de chips.
- Status chips uniformes: 'Solo lectura' + 'pg' + 'redis' + 'mvp.local',
  todos con border 1px y bg surface (sin color gritando).
- User avatar B/W puro (era amber gradient).

== Bloque previo: 12 fixes auditoría + Impeccable + DB chips ==

Auditoría frontend completa (33 hallazgos, 12 cerrados): 4 CRÍTICOS
+ 4 ALTOS + 4 MEDIOS. Detalle en
DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md.

Impeccable detector (pbakaus): 11 → 4 anti-patterns. 7 side-tabs
eliminados (uno de los 3 prohibidos absolutos del skill).

Chips postgres/redis en topbar consumiendo /health real (Codex
50876e5): DependencyChip component con dot color + tooltip
checkedAt o message.

Adaptaciones a contratos backend Codex 6500a15: gateDetails ES,
statusLabel, displayName roles, blockedReasonOperator, sections
detectedFieldCount, environment / releasePhase.

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores.
- Verificación visual con Chrome MCP:
  * Sidebar expandido: logo D negro, grupos con tracking-widest,
    items con icons + active ring + tone dots.
  * Sidebar colapsado: solo iconos, tooltips on hover, dots en
    esquina, divisores horizontales entre grupos, kill switch
    como Power icon con dot armado.
  * Topbar: breadcrumb 'Estado > Vista general', search con ⌘K,
    chips uniformes, refresh + chat + user avatar B/W.
  * Vista General: hero title 28px Montserrat, métricas operativas
    con grays sutiles (las barras son B/W ahora).
  * Canvas Live: tabs Lecturas/Live/Terminal/Diff/Topología limpio.
  * Sender Pool: BLOQUE 10 eyebrow + título grande, Wallet
    operativo card profesional con CAP MENSUAL / GASTADO /
    DISPONIBLE jerarquizados.
  * Safety: Kill Switch global card dark con texto on-dark.

== Bloqueantes demo viernes pendientes ==

OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md — Codex está
trabajando en:
- warmup_seed wiring + smoke E2E con 3 seed inboxes.
- SMTP install retry interno con backoff (era flaky).

Cuando Codex cierre, practice run #3 E2E real."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
