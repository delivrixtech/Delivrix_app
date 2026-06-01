#!/bin/bash
# Push FINAL del jueves 28-may: Rebrand B/W + Montserrat + TasteSkill audit
#
# Consolida TODO el trabajo frontend Claude del jueves:
#  - Auditoría completa 33 hallazgos (12 cerrados: 4 CRIT + 4 ALT + 4 MED)
#  - Adaptaciones a contratos backend Codex (6500a15)
#  - Chips postgres/redis al topbar (Codex 50876e5 /health)
#  - 7 anti-patterns Impeccable eliminados (side-tabs)
#  - Rebrand B/W oficial + Montserrat + JetBrains Mono + Caveat
#  - Sidebar profesional Linear-style (expandido + colapsado icon-only)
#  - Topbar profesional refactor
#  - TasteSkill §14 Hard pre-flight: cero em-dashes en UI text
#
# Codex sigue en paralelo con bloqueantes warmup_seed + SMTP retry.

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

git commit -m "feat(panel): rebrand B/W + Montserrat + Sidebar/Topbar pro + TasteSkill §14

Cierre frontend jueves 28-may pre-demo viernes. Trabajo consolidado:

== 1) Auditoría completa (33 hallazgos, 12 cerrados) ==

4 CRÍTICOS + 4 ALTOS + 4 MEDIOS. Reporte completo en
DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md.

CRÍTICOS:
- A-CRIT-04 hardware/index.tsx · guard de gráficas vacías
- A-CRIT-02 canvas-v4.tsx · chips Live + Idle unificados
- A-CRIT-03 canvas-v4.tsx · errors SSH a lenguaje operativo
- A-CRIT-01-B canvas-v4.tsx + canvas-live-client.ts · filtro frontend
  de tareas fallidas conversacionales del extractor Bloque 9

ALTOS:
- A-ALT-01 overview · 6 aprobaciones + 'Ver N más'
- A-ALT-03 infrastructure · cards min-width 320
- A-ALT-05 clusters · tooltips ACT/CAL/PAU/DEG/CUA/REP + leyenda
- A-ALT-06 onboarding · '0 interfaces' en warning

MEDIOS:
- A-MED-01 'Files' → 'Lecturas'
- A-MED-04 tooltip badges xN
- A-MED-06 'bloqueos' → 'ítems pendientes'
- A-MED-12 timestamps relativos en cards Infra

== 2) Adaptaciones a contratos backend Codex 6500a15 ==

shared/api/client.ts agregó types y features los consumen:
- OperatingNorthPayload.gateDetails / environment / releasePhase /
  roleDisplayNames · GatesCard usa displayLabel ES.
- IamRole.displayName · RolesCard muestra 'Operador supervisado'.
- Provider.statusLabel · ProviderCard 'Aún offline' en lugar de raw.
- OpenClawOnboardingState.sections / environment · Form muestra
  'mvp.local' y warning si detectedFieldCount=0.
- SupervisedCollectorSource.blockedReasonOperator + expectedInMvp
  + url null · SourcesRow rinde razón ES y tag 'ESPERADO MVP'.

== 3) Chips postgres/redis (Codex 50876e5 /health) ==

shared/api/client.ts HealthPayload con postgres? / redis? /
dependencies?. App.tsx Topbar nuevo DependencyChip · dot color
+ tooltip checkedAt o message. Topbar muestra '● pg · ● redis'.

== 4) Impeccable polish — 7 side-tabs eliminados ==

Detector pbakaus/impeccable identificó 11 anti-patterns; cerré los
7 más visibles (side-tab thick borders, uno de los 3 absolutamente
prohibidos · reference/colorize.md):
- shared/ui/card.tsx · toneBorder map sin border-l-4
- shared/ui/v2/KillSwitchV2.tsx · border perimeter en lugar de side
- shared/ui/v2/BannerOpenClawV2.tsx · idem
- shared/ui/v2/Toast.tsx · idem
- shared/ui/realtime/FallbackBanner.tsx · idem
- features/canvas/index.tsx · surface tint en lugar de side-tab

== 5) Rebrand B/W oficial · pedido directo CTO ==

Colores: NEGRO + BLANCO con grises tintados.
Tipografía: Montserrat (sans + heading) + JetBrains Mono (mono) +
Caveat (decorativa human-notes).

index.html carga Google Fonts con preconnect (Montserrat 300-900 +
italics, JetBrains Mono 400-700, Caveat 400-700).

tokens.css reescritura completa:
- Surfaces: blanco puro #ffffff / sunken #f6f6f6 / inverse #0a0a0a.
- Borders: hairlines #e5e5e5 / #d1d1d1 / focus #0a0a0a.
- Foreground: #0a0a0a / #525252 / #8a8a8a / #b5b5b5.
- Accent: NEGRO puro #0a0a0a (era amber gradient).
- Semantic desaturados y sobrios (Linear-style).
- Dark theme: negros profundos con blanco como accent.
- Letter-spacing recalibrado para Montserrat.

== 6) Sidebar profesional Linear-style ==

App.tsx Sidebar refactor:
- Modo expandido 240-256px con grupos y labels.
- Modo COLAPSADO 64px icon-only con tooltips on hover (Linear-style).
- Brand mark B/W puro (era gradient amber).
- Active state: surface bg + ring izquierdo 2px hairline.
- Status dots por sección (success/warning/critical).
- Borders entre grupos en modo colapsado.

KillSwitchCard nuevo prop collapsed: card completa expandida vs
Power icon con dot armado/activo cuando colapsado.

== 7) Topbar profesional ==

App.tsx Topbar refactor:
- Sticky, height 56px fijo.
- Breadcrumb 'Grupo > Sección' (toma el group real).
- Section title Montserrat 14px semibold.
- Search con border + ⌘K kbd en JetBrains Mono.
- Vertical dividers entre grupos lógicos.
- Status chips uniformes border 1px.
- User avatar B/W puro.

== 8) TasteSkill §14 Hard pre-flight ==

Apliqué Leonxlnx/taste-skill v2 redesign-skill + §14 sobre el panel:

§14 ZERO em-dashes (—) en UI text · ban absoluto.
Barrido en sender-pool / wallet-widget / hardware / domains /
clusters / collector reemplazando '—' por '·' (mid-dot) en
display strings. Comentarios y markdown content de demos no
afectados.

Antes: 57 em-dashes en código.
Después: 0 en UI text · solo en comentarios y demo content.

§0 Design Read declarado:
'B2B operational control panel para CTOs y jefes técnicos no-
desarrolladores, con un Linear-clean minimalist + technical
density language, leaning toward Tailwind utilities + Montserrat
+ JetBrains Mono + restrained motion. Dials: VARIANCE=4 /
MOTION=3 / DENSITY=6.'

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- Visual con Chrome MCP en 11 vistas: rebrand B/W aplicado,
  sidebar colapsado funcional, em-dashes eliminados en UI.

== Pendiente para llegar al viernes 11h ==

OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md:
- warmup_seed wiring + smoke con 3 seed inboxes.
- SMTP install retry interno con backoff.

Carril Juanes:
- Mailtrap free + 3 seed inboxes + 2 env vars.
- Practice run #3 E2E real con dominio descartable."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
