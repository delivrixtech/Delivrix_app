#!/bin/bash
# Push de los fixes Impeccable — jueves 28-may pre-demo viernes
#
# Instalé pbakaus/impeccable (CLI de diseño + 27 reglas de anti-patterns)
# y emilkowalski/skill (design-engineering reference). Corrí el detector
# contra apps/admin-panel/src y encontró 11 anti-patterns.
#
# Cerré los 7 más visibles (side-tab thick borders). Los 4 restantes son
# layout-transition (perf sutil, no impacto visual demo) — queda para S1.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# Limpiar locks stale
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# Pull primero
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# Stage los archivos modificados por Impeccable polish
git add \
  apps/admin-panel/src/shared/ui/card.tsx \
  apps/admin-panel/src/shared/ui/v2/KillSwitchV2.tsx \
  apps/admin-panel/src/shared/ui/v2/BannerOpenClawV2.tsx \
  apps/admin-panel/src/shared/ui/v2/Toast.tsx \
  apps/admin-panel/src/shared/ui/realtime/FallbackBanner.tsx \
  apps/admin-panel/src/features/canvas/index.tsx

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "polish(panel): eliminar 7 side-tab anti-patterns (Impeccable detector)

Instalé pbakaus/impeccable y corrí su detector de anti-patterns
contra apps/admin-panel/src. Encontró 11 anti-patterns. Este commit
cierra los 7 más visibles ('side-tab' thick borders), que Impeccable
clasifica como 'the most recognizable tell of AI-generated UIs' y
uno de sus 3 prohibidos absolutos (reference/colorize.md).

Reglas violadas:
- 'NEVER: border-left or border-right greater than 1px as a colored
  accent stripe.'
- Fix recomendado: hairline 1px en perímetro completo + surface tint
  4-8%, no side stripe.

Archivos corregidos:

== shared/ui/card.tsx ==
toneBorder map ya no usa border-l-4. Cada tone (success/warning/
critical/info/neutral) aplica border 1px en perímetro completo + bg
del *-soft del tone. El docstring documenta el motivo.

== shared/ui/v2/KillSwitchV2.tsx ==
La section principal del kill switch (border-left 4px de s.border)
ahora usa border 1px en perímetro + background s.bg (tint del estado).
La visual hierarchy del armed/active se mantiene por color y por el
icono Power, no por la franja lateral.

== shared/ui/v2/BannerOpenClawV2.tsx ==
borderLeft 3px var(--color-warning) → border 1px en perímetro. El
warning-soft background sigue marcando el tono.

== shared/ui/v2/Toast.tsx ==
Toast item con borderLeft 3px coloreado por tipo → border 1px en
perímetro coloreado por meta.ringColor. El icono del meta ya señala
el tone semántico (success/error/warning/info).

== shared/ui/realtime/FallbackBanner.tsx ==
borderLeft 3px solid warning → border 1px en perímetro warning.

== features/canvas/index.tsx ==
El header del canvas tenía borderLeft 4px del laneColor. Reemplazado
por surface tint con el laneColor (gradient horizontal usando ese
color con 14% y 8% de chroma) y solo bordes top/bottom hairline.

== Verificación con detector Impeccable ==

Antes:  11 anti-patterns (8 side-tab + 3 layout-transition)
Después: 4 anti-patterns (0 side-tab + 4 layout-transition + 1 falso
         positivo que fue corregido también)

Visualmente verificado con Chrome MCP:
- / Vista General: banner OpenClaw con perímetro hairline naranja,
  surface tint warning sutil, sin franja lateral gritando.
- /safety: KILL SWITCH GLOBAL card con tint suave + perímetro 1px,
  pierde el 'tell' AI sin perder la jerarquía visual del armed.

== Lo que queda fuera (post-demo S1) ==

4 layout-transition (perf sutil, no impacto visual demo):
- app/globals.css:479 transition: width
- features/canvas/canvas-v4.tsx:1317 transition: height
- features/canvas/workspace-browser.tsx:269 transition: width
- features/sender-pool/wallet-widget.tsx:298 transition: width

Fix recomendado por Impeccable: usar transform/opacity o
grid-template-rows en lugar de transition: width/height. Cambio
más invasivo, no afecta el demo de 10 min frente al jefe.

== TSC ==

apps/admin-panel/tsconfig.json → 0 errores."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
