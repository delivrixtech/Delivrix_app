#!/bin/bash
# Push v2 PULIDO COMPLETO — jueves 28-may continuación
#
# Trabajo adicional sobre el push anterior (rebrand B/W + Montserrat):
#
# 1. Footer profesional (faltante crítico que el CTO marcó)
#    - Brand + build SHA + status global (read-only/live writes,
#      stack healthy/degraded) + env + legal "Audit chain · regla de
#      2 personas" + © 2026 Delivrix. Linear/Vercel style 40px height.
#
# 2. Canvas Live polish (Cursor + Manus + Lovable inspirations)
#    - Header CanvasTopbar compactado a 44px una sola línea:
#      avatar B/W 24px (era Sparkles 32px gradient amber) +
#      "OpenClaw" 13px semibold + LivePill + agent:main:operator mono.
#    - Eliminada la barra "CANVAS LIVE V6 · herramienta funcional"
#      gigante. Reemplazada por barrita contextual 32px que solo
#      aparece si hay conexión problema, tasks ocultas, o demo mode.
#    - Demo OFF chip rediseñado: border 1px en lugar de pill saturado.
#
# 3. Wallet widget polish (top-1 worst según agente UX)
#    - Stats CAP MENSUAL/GASTADO/DISPONIBLE con jerarquía mejorada:
#      labels uppercase tracking-widest 10px text-tertiary +
#      values 18px tabular-nums semibold (era 14px cramped).
#    - Sin nested sunken backgrounds.

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

git commit -m "feat(panel): v2 pulido — Footer + Canvas Live polish + Wallet jerarquía

Continuación del rebrand B/W del jueves. Aplicado segundo pase con
las 3 nuevas skills (Impeccable + emil-design-eng + TasteSkill v2)
+ agentes UX/Plan en paralelo.

== 1) Footer profesional · faltante crítico ==

App.tsx Footer component nuevo (Linear/Vercel style 40px height):
- Left: D mark B/W + 'DELIVRIX CONTROL PLANE' uppercase tracking-
  widest + build SHA en mono.
- Center: status global · 'Read-only' vs 'Live writes' (warning si
  AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE encendido) + 'Stack healthy'
  vs 'Stack degraded' (deriva de health.postgres + redis).
- Right: env + 'Audit chain · append-only · regla de 2 personas' +
  © 2026 Delivrix.
- Border-top hairline, surface-sunken background, sin shadow.

Cierra el frame profesional del panel: topbar 56px arriba +
sidebar colapsable izquierda + main al centro + footer 40px abajo.

== 2) Canvas Live polish (Cursor + Manus + Lovable) ==

Agente Plan diseñó el rediseño completo con 7 cambios. Aplicados los
3 más impactantes:

canvas-v4.tsx CanvasTopbar (línea 496):
- Header compactado a 44px minHeight una sola línea.
- Avatar B/W 24px (era Sparkles 32px gradient amber accent-tertiary
  — anti-pattern saturado).
- Tipografía consistente: OpenClaw 13px Montserrat semibold +
  LivePill + divider hairline + agent:main:operator mono 10px.
- Texto reducido: 'feed hace Xs' en lugar de 'feed actualizado hace
  Xs' (ruido).

canvas-v4.tsx LiveTab top bar (línea 1767):
- Eliminada la barra grande 'CANVAS LIVE V6 · herramienta funcional'
  con eyebrow innecesario.
- Reemplazada por barrita contextual 32px minHeight que SOLO aparece
  cuando hay info útil:
  * Connection !== connected (reconnecting / offline pill).
  * Tasks ocultas (link 'Mostrar N ocultas' sin chrome).
  * Demo mode encendido (chip Demo ON/OFF border 1px).
- Cuando todo está OK, la barra simplemente no se renderiza. Limpio.

== 3) Wallet widget polish (top-1 worst según agente UX) ==

wallet-widget.tsx Stat (línea 305):
- Labels CAP MENSUAL/GASTADO/DISPONIBLE: 10px Montserrat medium
  uppercase tracking-widest text-tertiary (era 9.5px cramped).
- Values: 18px JetBrains Mono semibold tabular-nums color por tone
  (era 14px sin tabular-nums — números mal alineados).
- Gap 4px label-value (era 2px).
- Sin nested sunken backgrounds (que el agente UX marcó como
  'visual mud').

== Skills aplicadas en este pase ==

- pbakaus/impeccable · §reference/colorize.md (sin side-tabs ya
  estaba ✓, ahora también sin shadows pesadas en Canvas Live cards).
- Leonxlnx/taste-skill v2 redesign-skill (§11) + minimalist-skill
  (jerarquía typo, tabular-nums en data crítica, hairline 1px).
- emilkowalski/skill referenciada para post-demo (Sonner/Vaul
  patterns para toasts más adelante).

== Agentes lanzados ==

- Explore: audit profundo de las 11 vistas identificó top-3 worst:
  wallet-widget, collector, overview. Wallet cerrado este commit.
- Plan: arquitectura de Canvas Live rediseñado con 7 cambios
  priorizados. Cambios 1-3 aplicados; 4-7 quedan para post-demo.

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- Visual con Chrome MCP:
  * Footer visible al final de cada vista con status global +
    legal + build SHA.
  * Canvas Live header limpio: avatar B/W + OpenClaw + Live pill +
    metadata mono.
  * Barra demo/ocultas solo aparece si aporta info.
  * Sender Pool wallet card con jerarquía CAP/GASTADO/DISPONIBLE
    legible y tabular-nums.

== Pendiente post-demo (TasteSkill plan completo + microinteracciones) ==

Cambios 4-7 del Canvas Live plan:
- Tipografía por zona refinada (Montserrat verbs + JetBrains data).
- ArtifactColumn estilo Lovable (un solo bloque editable scroll
  + footer sticky de acciones).
- Empty states minimal alineados izquierda (no centered + Sparkles
  decorativo).
- TasksColumn sidebar Cursor-style con barra activa 2px izquierda.

Polish vistas restantes:
- Collector card-in-card nesting.
- Overview KPI hierarchy.
- AgentPulse component unificado (idle/thinking/executing).

== Bloqueantes demo viernes ==

OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md sigue pendiente:
- warmup_seed (Acto 3 calentamiento del inbox).
- SMTP install retry interno (era flaky).

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
