#!/bin/bash
# Push v4 — Sistema visual desde principios con TasteSkill v2
#
# Pedido CTO directo: "no me gusta el diseño actual ... preferiblemente
# hacerlo nuevamente por completo en el front end usando las nuevas skills".
#
# Lancé agente Plan con instrucción de diseñar SISTEMA completo (no patches).
# Respuesta: documento de 1200 palabras con Brief inference §0 +
# Three Dials §1 + Design System Map §2 (Linear lead + Vercel Observability
# + Datadog) + Tipografía §3 + Color §4 + Spacing §5 + Componentes §6 +
# Layout §7 + Priority §8 + Anti-patterns §9 + §14 Hard pre-flight check
# Delivrix-specific (20 boxes).
#
# Three Dials específicos para Delivrix:
#   DESIGN_VARIANCE: 2/5 (low)  · cockpit operativo, consistencia > delight
#   MOTION_INTENSITY: 1/5 (minimal) · solo movimiento funcional
#   VISUAL_DENSITY: 4/5 (high) · Datadog/Linear-density, no Notion
#
# Implementación: utility classes ds-* en globals.css + aplicación a
# Vista General Welcome + KpiShell + KpiValue.

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
  apps/admin-panel/src/app/globals.css \
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

git commit -m "feat(panel): v4 — Sistema visual desde principios (TasteSkill §0-§14)

El CTO marcó: 'no me gusta el diseño actual ... hacerlo nuevamente por
completo en el front end usando las nuevas skills'. Lancé agente Plan
con instrucción de diseñar SISTEMA completo (no patches). Respuesta:
documento con TasteSkill v2 §0 Brief Inference + §1 Three Dials + §2
Design System Map + §3-§7 sistema visual + §8 Priority + §9 No-do's +
§14 Hard pre-flight check Delivrix-specific.

== §0 BRIEF INFERENCE ==

Reading: Operational control plane / cockpit técnico (no SaaS
marketing, no dashboard genérico). Audiencia CTOs y jefes técnicos
no-developers. Lectura en 3 segundos por vista. B/W oficial,
semantic solo para estado, agente IA como objeto observado.

Tensión central: tokens correctos pero vocabulario inconsistente
entre 11 vistas = lee 'demo prototype'.

== §1 THREE DIALS para Delivrix ==

- DESIGN_VARIANCE: 2/5 (low) · consistencia > delight, cockpit.
- MOTION_INTENSITY: 1/5 (minimal) · solo movimiento funcional.
- VISUAL_DENSITY: 4/5 (high) · Datadog/Linear-density.

== §2 DESIGN SYSTEM MAP ==

Lead: Linear (shell + sidebar + tipografía).
Secondary: Vercel Observability (densidad + stat cards).
Tertiary: Datadog (evidencia operativa + audit timelines).
Canvas Live → Cursor agent panel.
Aprobaciones → GitHub PR review.
Audit chain → Stripe Dashboard event log.

== Implementación · utility classes ds-* ==

apps/admin-panel/src/app/globals.css agregadas las primitivas del
sistema como utility classes para que las features las inviten sin
reescribir componentes existentes:

Tipografía:
- .ds-eyebrow  · mono 10px 600 tracking 0.12em uppercase tertiary
- .ds-display  · Montserrat 32px 700 -0.02em 1.05 (solo Vista
  General hero, 1 por vista)
- .ds-h1       · Montserrat 22px 700 -0.015em 1.15
- .ds-h2       · Montserrat 16px 600 -0.01em 1.25
- .ds-h3       · Montserrat 13px 600 1.3
- .ds-body     · Montserrat 14px 400 1.5 text-secondary text-wrap pretty
- .ds-body-sm  · idem 13px
- .ds-caption  · 12px 500 1.4 tertiary
- .ds-mono-data    · JetBrains 13px 500 tabular-nums
- .ds-mono-code    · JetBrains 12px 400 secondary
- .ds-mono-stat-xl · JetBrains 28px 600 -0.01em tabular-nums
- .ds-caveat       · Caveat 14px 500 (solo human notes, max 1/vista)

Componentes:
- .ds-card  · surface + border hairline + radius 8 + padding 16.
  SIN shadow. Hover = border-strong (no lift, no shadow).
- .ds-card--quiet · sunken bg
- .ds-card--hero  · padding 24
- .ds-stat  · 96px alto fijo. label uppercase + valor mono-stat-xl.
- .ds-pill  · dot + texto, gradient OFF. max-width 18ch.
- .ds-badge · borde hairline + bg surface + text mono. SIN color.
- .ds-chip  · sunken bg + secondary + radius 4. Click → border-strong.
- .ds-section-divider · hairline + eyebrow + caption

Reglas duras del sistema:
- font-variant-numeric: tabular-nums en .ds-mono-data, .ds-mono-stat-xl.
- Caveat NUNCA en headings, NUNCA en CTAs, NUNCA en datos.
- Montserrat NUNCA en valores numéricos comparables.
- Tracking widest solo en eyebrows.
- Border 1px hairline siempre. Cero borders 2px+ excepto focus ring.
- Semantic dot 6px + soft bg en pills. SIN pills saturadas.

== Aplicación · Vista General ==

features/overview/index.tsx:
- Welcome (PageHeader trio): ds-eyebrow 'Inicio operativo' + dot
  separator + ds-mono-code timestamp · ds-display h1
  'Capacidad preparada, sin envíos reales.' · ds-body con
  max-width 720 (text-wrap balance) · LiveIndicator a la derecha.
- KpiShell: ds-card (sin shadow, sin hover-lift transform). Hover
  state = border-strong via .ds-card:hover. cursor help cuando
  tooltipHint presente.
- KpiValue: ds-mono-stat-xl (era inline 32px font-mono font-bold).

Cambios anteriores del v3 mantenidos:
- KpiHead labels mono uppercase tracking-widest.
- Pills ACTIVOS/EN CURSO/CRÍTICO/ESPERAN APROBACIÓN border 1px.

== Verificación visual con Chrome MCP ==

Vista General:
- Eyebrow 'INICIO OPERATIVO · actualizado 28/05/2026, 3:57 p.m.'
  con dot separator hairline.
- Hero h1 'Capacidad preparada, sin envíos reales.' grande
  Montserrat 32px tracking tight balance.
- Body 14px Montserrat text-secondary con max-width 720
  (Vercel/Linear reading measure).
- KPI cards sin shadow, hover border-strong.
- Pills con border hairline (sin fill saturado).

== Pendientes para v5 (post-demo S1) ==

Pública (no toqué aún este pase):
- Canvas Live: implementar AgentPulse component (idle/thinking/
  executing) con barra 60×2px que viaja en topbar.
- Canvas Live: ArtifactColumn estilo Lovable (un solo bloque
  editable scroll + footer sticky de acciones).
- Aprobaciones (priority #3 del agente): GitHub PR review style.
- Audit chain: Stripe Dashboard event log style.
- Propagar ds-* utilities a otras 8 vistas (Onboarding, Hardware,
  Recolector, Infraestructura, Dominios, Sender Pool, Clústeres,
  Aprendizaje, Seguridad).

== Bloqueantes demo viernes ==

OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md sigue pendiente:
- warmup_seed wiring + smoke con 3 seed inboxes.
- SMTP install retry interno con backoff."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
