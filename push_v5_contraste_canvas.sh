#!/bin/bash
# Push v5 — fix de contraste en dark + Canvas Live limpio
#
# Bug raíz: el token --color-surface-inverse se voltea con el tema. En
# dark mode pasaba a #ffffff (blanco). Los componentes "siempre dark"
# (CLI snippet, kill switch, banner OpenClaw, prompt panel, code blocks)
# lo usaban como background → en dark mode se renderizaban como tarjetas
# blancas dentro del shell dark, ilegibles y con un contraste pésimo.
#
# Fix: nuevos tokens --color-always-dark-* que NO invierten con el tema.
# Migración de los 8 sitios que querían "siempre dark".
#
# Bonus: limpieza Canvas Live — header v5 redundante removido y la
# columna de tareas ya no repite "completada · hace 20h" 7 veces.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short | head -20

git add \
  apps/admin-panel/src/app/tokens.css \
  apps/admin-panel/src/shared/ui/dark-cli-snippet.tsx \
  apps/admin-panel/src/shared/ui/openclaw-prompt-panel.tsx \
  apps/admin-panel/src/shared/ui/v2/MarkdownText.tsx \
  apps/admin-panel/src/features/collector/index.tsx \
  apps/admin-panel/src/features/hardware/index.tsx \
  apps/admin-panel/src/features/clusters/index.tsx \
  apps/admin-panel/src/features/learning/index.tsx \
  apps/admin-panel/src/features/overview/index.tsx \
  apps/admin-panel/src/features/safety/index.tsx \
  apps/admin-panel/src/features/canvas/live-tool.tsx \
  apps/admin-panel/src/v5/views/CanvasLive.tsx

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "fix(panel v5): contraste dark + Canvas Live duplicaciones

== Bug crítico de contraste en dark ==

El token --color-surface-inverse se voltea con el tema. En light está
fijado a #0a0a0a (dark surface), en dark vira a #ffffff (blanco).
Componentes que conceptualmente son 'siempre dark' (terminal CLI, kill
switch, banner OpenClaw, prompt panel, code blocks de markdown) lo
usaban como background y por eso en dark mode aparecían como tarjetas
BLANCAS dentro del shell dark — contraste cero y texto on-dark-medium
(rgba 0.7 blanco) ilegible sobre blanco.

Fix: nuevos tokens always-dark en :root (no se sobreescriben en
[data-theme='dark']):

  --color-always-dark-bg: #0a0a0a;
  --color-always-dark-surface: #141414;
  --color-always-dark-raised: #1a1a1a;
  --color-always-dark-border: rgba(255, 255, 255, 0.15);
  --color-always-dark-border-strong: rgba(255, 255, 255, 0.22);

Migración de los 8 puntos que querían 'siempre dark':

- shared/ui/dark-cli-snippet.tsx (terminal CLI)
- shared/ui/openclaw-prompt-panel.tsx (botón prompt)
- shared/ui/v2/MarkdownText.tsx (code blocks)
- features/collector/index.tsx (CliSnippet local)
- features/hardware/index.tsx (botón snapshot manual)
- features/clusters/index.tsx (botón kill switch)
- features/learning/index.tsx (sección bitácora)
- features/overview/index.tsx (sección dark)
- features/safety/index.tsx (Kill Switch hero + KillStat)

Verificado: el CliSnippet del Collector ahora computed bg
rgb(10, 10, 10) en dark; antes era rgb(255, 255, 255).

== Canvas Live: duplicaciones removidas ==

src/v5/views/CanvasLive.tsx
  Antes envolvía CanvasV4 con un sub-header propio:
    'SESIÓN OPENCLAW · live · chat / actions / propuesta · split canvas'
  Pero el CanvasV4 ya monta su propio header 'OpenClaw · Live ·
  agent:main:operator · feed hace Ns'. Esto dejaba DOS barras de sesión
  apiladas. Se eliminó el header v5 para que el breadcrumb del shell
  ('Operación › Canvas Live') + AgentPulse vivo de la topbar sean los
  únicos indicadores de sesión.

features/canvas/live-tool.tsx — TaskNodeRow
  La columna de tareas pintaba un meta-row 'estado · hace Xh' para CADA
  fila. En una sesión con 7 tareas completadas, eso significaba ver
  'completada · hace 20h' siete veces seguidas, exactamente la misma
  string — visualmente spam. Ahora el meta-row solo se renderiza para
  estados activos/anormales (running / awaiting_approval / failed /
  idle). Para completed el dot izquierda + el título dimmed bastan.

Verificado en Chrome MCP:
  /canvas → sesionOpenClawCount=0, splitCanvasCount=0,
            completadaHaceCount=0, openClawCount=2 (1 header + 1 chat).

== Verificación ==

- tsc --noEmit → 0 errores.
- /collector → CliSnippet dark sólido en dark mode.
- /canvas → header único, lista de tareas sin repetición.

== Pendiente para próximo polish ==

- Canvas Live: panel 'API · SIN ACTIVIDAD' ocupa 1/3 del workspace
  sin valor. Cuando no haya request, debería colapsar y dejar más
  espacio al artifact panel.
- Counts '×2 / ×3 / ×5' aún están pegados al título, conviene moverlos
  a chip mono separado a la derecha.
- Reescritura completa de CanvasV4 al sistema v5 (pendiente para
  post-demo viernes)."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
