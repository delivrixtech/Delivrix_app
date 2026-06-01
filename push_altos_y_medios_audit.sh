#!/bin/bash
# Push de los ALTOS + MEDIOS de la auditoría frontend (post-CRÍTICOS)
# Jueves 28-may, tarde.
#
# Para correr DESPUÉS de push_critical_audit_fixes.sh.
#
# 4 ALTOS + 4 MEDIOS cerrados en esta sesión, todos en archivos que NO
# toca Codex (sin riesgo de conflict con su OPS backend paralelo).

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# 1) Limpiar locks stale del sandbox si quedaron
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# 2) Pull primero por si Codex pusheó algo
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# 3) Stage los archivos modificados
git add \
  apps/admin-panel/src/features/overview/index.tsx \
  apps/admin-panel/src/features/onboarding/index.tsx \
  apps/admin-panel/src/features/infrastructure/index.tsx \
  apps/admin-panel/src/features/clusters/index.tsx \
  apps/admin-panel/src/features/canvas/canvas-v4.tsx \
  apps/admin-panel/src/features/canvas/live-tool.tsx

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "fix(panel): 4 ALTOS + 4 MEDIOS auditoría frontend jueves 28-may

Continuación del trabajo de auditoría completa. Los 4 CRÍTICOS ya
fueron cerrados en el commit anterior; este cubre ALTOS y MEDIOS
sin tocar archivos que Codex está modificando para su OPS backend
(operating-north, collector, infrastructure-inventory, iam-roles).

== A-ALT-01: Aprobaciones pendientes — 7 visibles (o 'Ver N más') ==

Antes: badge decía '7' pero la lista renderizaba solo 3 (slice(0,3)
hardcoded en features/overview/index.tsx). Operador veía contador
mentiroso.

Después: muestra hasta APPROVALS_INITIAL_VISIBLE=6. Si hay más,
toggle 'Ver N más ↓' / 'Mostrar menos ↑' debajo. El badge sigue
mostrando el total real para que coincidan.

== A-ALT-03: Infraestructura — cards min-width 280 → 320 ==

Antes: card 'Servid... · Servidor fisi...' truncado ilegible en
features/infrastructure/index.tsx.

Después: grid con minmax(320px, 1fr) — los brand + accountSuffix
caben sin truncate en la mayoría de los casos.

== A-ALT-05: Clústeres — tooltip + leyenda ACT/CAL/PAU/DEG/CUA/REP ==

Antes: tabla con headers ACT/CAL/PAU/DEG/CUA/REP sin contexto.
Imposible para un operador externo descifrarlos.

Después en features/clusters/index.tsx:
- CLUSTER_COL_DEFS array con {key, full, hint} por columna.
- Cada header envuelto en <Tooltip hint='...'> + cursor: help.
- Leyenda compacta visible debajo del header de la tabla:
  'ACT activos · CAL calentamiento · PAU pausados · DEG degradados ·
   CUA cuarentena · REP reputación'.

Cobertura dual: el operador que conoce hover descubre el tooltip;
el que no, ve la leyenda inline.

== A-ALT-06: Tag '0 interfaces' en warning (no verde) ==

Antes en features/onboarding/index.tsx SECCIÓN 3: tag verde
'0 interfaces declaradas' aunque 0 sea un estado problemático
(servidor de envío sin interfaces de red no puede operar).

Después: IIFE que detecta isZero y aplica colores warning
(iconBg/iconColor/pillBg/pillFg/pillDot todos var(--color-warning)
en lugar de var(--color-success)) + texto adaptado a
'0 interfaces · pendiente de captura'.

== A-MED-01: Renombrar tab 'Files (N)' → 'Lecturas (N)' ==

Antes en canvas-v4.tsx: tab top 'Files' tenía mismo naming que tab
medio 'Archivos'. Confundía conceptos distintos:
- Top 'Files': lo que el agente LEYÓ (audit-events oc.skill.read_file).
- Medio 'Archivos': filesystem del workspace (browser).

Después: top renombrado a 'Lecturas'. Empty state actualizado para
mencionar el tab 'Archivos' del medio: 'Para ver el filesystem
completo del workspace, abrí el tab Archivos del panel medio.'

== A-MED-04: Tooltip sub-tareas en badges ×N ==

Antes en live-tool.tsx: badges '×2', '×5' sin explicación.

Después: title nativo en hover: '${N} tareas con el mismo título
agrupadas (la más reciente se muestra arriba)' + cursor: help.

== A-MED-06: Microcopy 'ítems pendientes' no 'bloqueos' ==

Antes en features/onboarding/index.tsx: 'Tengo 26 bloqueos
pendientes' + pillText '${N} bloqueos' alarmista.

Después: 'ítems pendientes' — comunica igual sin disparar lectura
de problema crítico. Card 'Cumplimiento pendiente' pill también
cambiada a '${N} pendientes'.

== A-MED-12: Format timestamps relativos en cards Infra ==

Antes en features/infrastructure/index.tsx CompactProviderCard:
'últ. fetch 2026-05-28T16:18:4...' ISO crudo truncado feo.

Después: usa formatRelativeOrIso(provider.lastFetched) — output
'hace 2m' / 'hace 10 d' + title nativo con el ISO completo si el
operador quiere verlo en hover.

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- vite HMR vivo, verificado visualmente con Chrome MCP:
  * /  → 6 aprobaciones visibles + 'Ver 1 más ↓' funcionando
  * /clusters → leyenda compacta + tooltips por header
  * /infrastructure → cards más anchas + timestamps 'hace 3s'
  * /onboarding → card SECCIÓN 3 con tag warning si 0 interfaces
  * /canvas → tab 'Lecturas' en top, badges ×N con tooltip

== Pendiente en próxima sesión ==

Los siguientes MEDIOS aún en backlog Claude:
- A-MED-02 banner propuesta 'completado' cuando sub-tareas done
- A-MED-08 tooltip CTA disabled con campos faltantes
- A-MED-13 leyenda Topología

Para post-demo viernes si el tiempo aprieta.

Codex sigue con su OPS backend (10 tareas, ~6h). Próximo practice
run de Claude apenas Codex confirme cierre de Tarea 1 (limpieza
workspace) + Tarea 2 (22 gates en español)."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
