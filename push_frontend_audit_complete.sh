#!/bin/bash
# Push CONSOLIDADO frontend — auditoría completa jueves 28-may
#
# Incluye TODOS los fixes de Claude en una sola corrida (no fueron pusheados
# antes porque Codex estaba trabajando en backend en paralelo). Hoy Codex
# pusheó 6500a15 con todos los contratos backend ES; este commit aterriza
# los fixes Claude + las adaptaciones para consumir esos contratos.
#
# Después de este commit el panel admin queda 100% en español operativo,
# integrado con los contratos backend nuevos de Codex.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# 1) Limpiar locks stale
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# 2) Pull primero
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# 3) Stage frontend + docs
git add \
  apps/admin-panel/src/features/hardware/index.tsx \
  apps/admin-panel/src/features/canvas/canvas-v4.tsx \
  apps/admin-panel/src/features/canvas/canvas-live-client.ts \
  apps/admin-panel/src/features/canvas/live-tool.tsx \
  apps/admin-panel/src/features/overview/index.tsx \
  apps/admin-panel/src/features/onboarding/index.tsx \
  apps/admin-panel/src/features/infrastructure/index.tsx \
  apps/admin-panel/src/features/clusters/index.tsx \
  apps/admin-panel/src/features/collector/index.tsx \
  apps/admin-panel/src/features/safety/index.tsx \
  apps/admin-panel/src/shared/api/client.ts \
  DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_BD_ORBSTACK_2026_05_28.md \
  DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "fix(panel): cierra auditoría frontend completa + adapta contratos Codex 6500a15

Auditoría completa de las 11 vistas del panel + microinteracciones
ejecutada por Claude con Chrome MCP y criterio senior frontend.
33 hallazgos consolidados (AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md).

Este commit cierra los items frontend (Claude) + adapta el panel para
consumir los contratos backend ES que Codex entregó en 6500a15.

== 4 CRÍTICOS ==

A-CRIT-01-B canvas-live-client.ts + canvas-v4.tsx
  Filtro frontend de tareas fallidas conversacionales. El extractor de
  intent del Bloque 9 a veces convierte mensajes conversacionales en
  tasks que fallan sin ejecutar nada. Heurística: failed + root +
  sin actions/artifacts → ocultar. Toggle 'Mostrar N ocultas' para
  auditoría. Sin chequeo de edad (Codex confirmó que los archivos
  no existen en workspace, son state runtime persistido).

A-CRIT-02 canvas-v4.tsx ThinkingChip
  Antes 'Live' verde + 'Idle' gris simultáneos generaban contradicción
  visual. Ahora el chip Idle no renderiza si no hay actividad — el
  chip Live del WSS ya comunica conexión. Chip 'Pensando…/Enviando'
  solo cuando hay activity real.

A-CRIT-03 canvas-v4.tsx ChatErrorBanner + translateGatewayError
  'SSH command failed with exit 255' crudo → componente operativo con
  título + body + <details> colapsable con stderr. Patterns traducidos:
  SSH exit 255/1/127, gateway 502, timeout, permission denied. Fallback
  envuelve cualquier error en estructura aceptable.

A-CRIT-04 hardware/index.tsx HistorialEmpty + ChartFromSeries
  Antes 3 gráficas con fallbackBars hardcoded (38/66/48) contradecían
  'Sin series disponibles'. Ahora si series=[] muestra empty state
  honesto. Defensa por sub-métrica: si points=[] placeholder discreto.
  shared/api/client.ts: agrega lastCaptureAt? opcional al HistoryPayload.

== 4 ALTOS ==

A-ALT-01 overview/index.tsx
  Antes badge '7' pero slice(0,3). Ahora APPROVALS_INITIAL_VISIBLE=6 +
  toggle 'Ver N más ↓' si el total excede.

A-ALT-03 infrastructure/index.tsx
  Cards minmax 280→320 para evitar 'Servid...' truncado.

A-ALT-05 clusters/index.tsx
  CLUSTER_COL_DEFS array + Tooltip por header de tabla + leyenda
  compacta inline ('ACT activos · CAL calentamiento · ...').

A-ALT-06 onboarding/index.tsx
  Tag '0 interfaces' en warning (no verde) — 0 interfaces es estado
  problemático, no OK.

== 4 MEDIOS ==

A-MED-01 canvas-v4.tsx
  Tab 'Files (N)' renombrado a 'Lecturas (N)' para distinguir del tab
  'Archivos' del workspace. Empty state actualizado.

A-MED-04 live-tool.tsx
  Tooltip nativo en badges ×N: '\${N} tareas con el mismo título
  agrupadas' + cursor: help.

A-MED-06 onboarding/index.tsx
  'bloqueos' → 'ítems pendientes' en banner OpenClaw + pill
  Cumplimiento. Lenguaje neutral sin perder info.

A-MED-12 infrastructure/index.tsx
  Timestamps relativos en cards: 'últ. fetch · hace 3s' en vez de
  '2026-05-28T16:18:4...' ISO crudo truncado.

== Adaptaciones a contratos Codex 6500a15 ==

shared/api/client.ts
  + OperatingNorthGateDetail { id, displayLabel, description? }
  + OperatingNorthRoleDisplayNames
  + OperatingNorthPayload.gateDetails?, .environment?, .releasePhase?,
    .roleDisplayNames?
  + IamRole.displayName?
  + Provider.statusLabel?
  + OpenClawOnboardingSectionState { id, displayName, detectedFieldCount,
    totalFieldCount, source }
  + OpenClawOnboardingStatePayload.environment?, .releasePhase?, .sections?

overview/index.tsx GatesCard
  Consume gateDetails[] cuando está disponible (fallback a humanize()).
  Los 22 gates en inglés técnico ahora aparecen en ES: 'Sin envío real
  desde Delivrix', 'Panel lee clusters desde contrato backend', etc.
  GateRow acepta description opcional para tooltip extendido.

infrastructure/index.tsx ProviderCard
  Usa provider.statusLabel si está (ej. 'Aún offline' en vez de
  'not_online_yet' snake_case). Fallback al STATUS_META local.

safety/index.tsx RolesCard
  Usa role.displayName si está ('Operador supervisado (sólo lectura)'
  en vez de 'Operador'). Tooltip con rawName para debug.

collector/index.tsx SourcesRow + SourceCard
  Consume url:null (deja de mostrar example.invalid),
  blockedReasonOperator (razón ES visible debajo de cada card),
  expectedInMvp (tag azul 'ESPERADO MVP' + suaviza badge crítico).

onboarding/index.tsx Form
  Usa onboardingState.environment ('mvp.local' en lugar del sprint
  phase). Sections[] con detectedFieldCount permite tag warning
  cuando server.detectedFieldCount=0 ('pendiente · esperando snapshot'
  en lugar del verde engañoso).

== Verificación visual con Chrome MCP ==

- / Vista General: 6 aprobaciones + 'Ver 1 más' + gates 22 en español.
- /onboarding: ENTORNO 'mvp.local', SECCIÓN 2 warning, SECCIÓN 3 '0
  interfaces · pendiente de captura', banner '26 ítems pendientes'.
- /hardware: empty state honesto cuando series vacías.
- /collector: 'URL pendiente', 'ESPERADO MVP', razón ES por card.
- /infrastructure: 3 Webdock separadas (Claude·DK, Ops, Account),
  'Aún offline' ES, timestamps relativos.
- /clusters: tooltip + leyenda ACT/CAL/PAU/DEG/CUA/REP.
- /safety: roles en español 'Operador supervisado (sólo lectura)'.
- /canvas: tab 'Lecturas', sin chip Idle, toggle 'Mostrar 6 ocultas'
  funcionando, TAREAS 46 (sin 2 conversacionales fallidas).

== Verificación técnica ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- HMR vivo verificado en localhost:5173

== Documentos adicionales ==

DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md
DOCUMENTACION/OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md (cerrado por
  Codex en 6500a15)
DOCUMENTACION/OPS_CODEX_BD_ORBSTACK_2026_05_28.md (próximo OPS Codex,
  pedido directo Juanes — consolidar pgvector + postgres + redis en
  OrbStack con migraciones reproducibles + seed dev + README)
DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md

== Backlog Claude post-demo ==

- A-MED-02 banner propuesta 'completado' cuando sub-tareas done
- A-MED-08 tooltip CTA disabled con campos faltantes
- A-MED-13 leyenda Topología
- Plus: chip postgres/redis en topbar /health cuando Codex cierre
  OPS_CODEX_BD_ORBSTACK."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
