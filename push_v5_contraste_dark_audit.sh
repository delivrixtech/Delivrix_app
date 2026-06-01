#!/bin/bash
# Push v5 — audit sistemático de contrastes en dark mode
#
# Continuación del fix anterior (always-dark tokens). Este pass cubre el
# OTRO patrón de bug:
#   bg accent-tertiary (vira a #fff en dark) + color on-dark-strong (siempre
#   #fff) = icon container blanco con sparkle invisible.
# El usuario lo detectó en el banner 'Telemetría stale' del Hardware.
#
# Auditados todos los usos de accent-tertiary y accent como background. Se
# fixearon 6 sitios:
#   - BannerOpenClawV2 icon container (raíz del bug del screenshot)
#   - Canvas-v4: 2 icon containers OpenClaw (EmptyChatState + mensaje)
#   - Canvas-v4: 3 botones primarios "Aprobar dry-run", "Enviar", action
#   - Hardware: botón "Ingestar snapshot" en modal
#   - Collector: botón "Ingestar snapshot" en captura manual
#
# Patrón de fix:
#   - Icon containers OpenClaw "siempre dark"  → always-dark-bg + on-dark-strong
#   - Botones primarios accent invert         → accent + accent-fg
#     (accent-fg se voltea correctamente: white sobre dark, dark sobre white)

set -e
cd "/Users/juanescanar/Documents/delivrix app"

rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short | head -20

git add \
  apps/admin-panel/src/shared/ui/v2/BannerOpenClawV2.tsx \
  apps/admin-panel/src/features/canvas/canvas-v4.tsx \
  apps/admin-panel/src/features/hardware/index.tsx \
  apps/admin-panel/src/features/collector/index.tsx

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "fix(panel v5): contraste dark — accent-tertiary como bg

Continuación del audit anterior. Patrón pendiente: componentes que usaban
--color-accent-tertiary como BACKGROUND quedaban como cuadrados/botones
blancos en dark mode (porque accent-tertiary = #ffffff en dark) con texto
on-dark-strong (también blanco) encima — el sparkle/contenido era
totalmente invisible.

El usuario detectó el caso del banner OpenClaw 'Telemetría stale' del
Hardware: cuadrado blanco al lado del título amarillo, con Sparkles
invisible adentro.

== Icon containers 'siempre dark' ==

  bg: accent-tertiary  →  bg: always-dark-bg
  color: '#fffbf5'     →  color: on-dark-strong
  color: '#e6edf3'     →  color: on-dark-strong

Fixed en:
- shared/ui/v2/BannerOpenClawV2.tsx (Sparkles del banner — raíz del
  screenshot que reportó el usuario)
- features/canvas/canvas-v4.tsx EmptyChatState (avatar OpenClaw
  cuando el chat está vacío)
- features/canvas/canvas-v4.tsx AgentMessage header (avatar OpenClaw
  en cada mensaje del chat)

Visual antes (dark): cuadrado blanco invisible
Visual ahora (dark): cuadrado negro con sparkle blanco

== Botones primarios accent invert ==

  bg: accent-tertiary  →  bg: accent
  color: on-dark-strong →  color: accent-fg

accent-fg SÍ se voltea con el tema (white sobre dark accent en light,
dark sobre white accent en dark), manteniendo contraste correcto en
ambos modos.

Fixed en:
- features/canvas/canvas-v4.tsx:1175 'Aprobar dry-run'
- features/canvas/canvas-v4.tsx:1373 botón 'Enviar' (composer)
- features/canvas/canvas-v4.tsx:2523 action button
- features/hardware/index.tsx:1096 'Ingestar snapshot' (modal)
- features/collector/index.tsx:342 'Ingestar snapshot' (captura manual)

Antes: botón blanco con texto blanco invisible
Ahora: botón blanco con texto negro (dark mode)

== Verificación ==

- tsc --noEmit → 0 errores.
- Chrome MCP /hardware en dark: icon negro con sparkles visible ✓
- Chrome MCP /hardware en light: icon negro (always-dark) sobre banner
  amarillo soft, sigue legible ✓
- Chrome MCP /canvas en dark/light: avatar dark + sparkles visible
  consistente ✓
- Chrome MCP /safety en dark: BannerOpenClaw 'gates abiertos' icon
  negro consistente ✓"

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
