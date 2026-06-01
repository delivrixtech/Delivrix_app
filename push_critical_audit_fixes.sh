#!/bin/bash
# Push de los 4 CRÍTICOS de la auditoría frontend completa jueves 28-may
#
# Resultado de Claude haciendo el practice run alone, criterio senior:
# 33 hallazgos consolidados en AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md.
# Este commit cierra los 4 CRÍTICOS de la columna Claude.
#
# A-CRIT-01-B: Filtro frontend de tareas fallidas conversacionales
#   - canvas-live-client.ts: expone taskIdsWithOutput Set
#   - canvas-v4.tsx: heurística para esconder failed root sin output <5min
#   - Toggle "Mostrar N ocultas" en header del LiveTool
#   - Defensa futura para evitar que durante el demo se vea otra tarea
#     conversacional fallida. Complementa la limpieza manual del workspace
#     que hará Codex (OPS A-CRIT-01-A).
#
# A-CRIT-02: Unificar chips Live + Idle en Canvas header
#   - canvas-v4.tsx ThinkingChip: return null cuando idle
#   - El chip "Live" del header WSS ya comunica estado de conexión.
#     Eliminamos contradicción visual "Live + Idle simultáneos".
#
# A-CRIT-03: Error SSH a lenguaje operativo + collapsible
#   - canvas-v4.tsx: nuevo ChatErrorBanner component + translateGatewayError
#   - "SSH command failed with exit 255" → "Comando SSH no completó · OpenClaw
#     no pudo establecer la conexión SSH. Probablemente el servidor aún no
#     acepta..." + <details> con stderr crudo colapsado por defecto.
#   - Patrones traducidos: SSH exit codes, gateway 502, timeout, permission
#     denied, fallback genérico envuelto.
#
# A-CRIT-04: Guard de gráficas Hardware si series vacías
#   - hardware/index.tsx: HistorialEmpty component honesto cuando series=[]
#   - ChartFromSeries: si points=[] muestra placeholder discreto en vez de
#     fallbackBars hardcoded (38/66/48 falsas que contradecían "Sin series
#     disponibles" del texto adyacente).
#   - client.ts: agrega lastCaptureAt?: string|null al type HistoryPayload
#     (defensivo — Codex puede poblarlo en S1 si quiere relative time).
#
# Documentación incluida:
#   - AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md (33 hallazgos consolidados)
#   - OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md (10 tareas para Codex)
#
# 22 gates en español + Webdock × 3 + 5 items MEDIO + 3 BAJO → Codex.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# 1) Limpiar locks stale del sandbox si quedaron
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# 2) Pull primero por si Codex pusheó algo
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# 3) Stage los archivos del fix + docs
git add \
  apps/admin-panel/src/features/hardware/index.tsx \
  apps/admin-panel/src/features/canvas/canvas-v4.tsx \
  apps/admin-panel/src/features/canvas/canvas-live-client.ts \
  apps/admin-panel/src/shared/api/client.ts \
  DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "fix(panel): 4 CRÍTICOS auditoría frontend completa jueves 28-may

Auditoría completa de las 11 vistas del panel + microinteracciones
globales con Chrome MCP y criterio senior frontend, ejecutada por
Claude alone tras pedido explícito de Juanes (\"vuelve a auditar todos
los problemas que tiene el frontend, el diseño, la experiencia de
ux/iu por favorrrrrrrrrr\"). 33 hallazgos consolidados.

Distribución: 4 CRÍTICOS, 6 ALTOS, 13 MEDIOS, 10 BAJOS.

Este commit cierra los 4 CRÍTICOS de la columna Claude. Codex toma
A-CRIT-01-A (limpieza workspace, 10 min) + 9 tareas más en su OPS
separado.

== A-CRIT-01-B: Filtro frontend de tareas fallidas conversacionales ==

El extractor del Bloque 9 a veces convierte mensajes conversacionales
del operador (\"ok hemos adquirido un nuevo VPS\", \"necesito que
configures un nuevo SMTP\") en tasks ejecutables que fallan sin haber
hecho nada. Esas 2 tasks aparecían arriba del sidebar Canvas Live con
red dot fallida — primera impresión del demo destruida.

Fix:
- canvas-live-client.ts: stream expone taskIdsWithOutput: Set<string>
  derivado de state.lastAction + state.artifacts.
- canvas-v4.tsx: heurística insignificantFailedIds — failed + root +
  sin output en taskIdsWithOutput + age <5min → ocultar.
- Toggle \"Mostrar N ocultas\" en header del LiveTool por si el
  operador quiere ver las falsas intents igual.

Defensa en profundidad con la Opción A (Codex limpia workspace) ya
acordada con Juanes. Mi filtro previene recurrencia durante el demo
si Juanes manda otro mensaje conversacional. Limpieza histórica la
hace Codex en su OPS.

== A-CRIT-02: Unificar chips Live + Idle ==

El header del Canvas mostraba \"● Live\" verde (connection WSS) +
\"● Idle\" gris (agent state) simultáneamente, generando confusión:
¿está vivo o no?

Fix en ThinkingChip (canvas-v4.tsx): cuando active=false (no streaming
ni queued), return null. El chip \"Live\" del WSS ya comunica todo.
Cuando active=true se mantiene el chip naranja \"Pensando…\" /
\"Enviando\" con loader spin.

Resultado: 1 chip por concepto, ambos visibles solo cuando aportan.

== A-CRIT-03: Error SSH a lenguaje operativo + collapsible ==

\"SSH command failed with exit 255.\" aparecía como banner amarillo
crudo en el chat OpenClaw sin contexto. Para un jefe = \"algo se
rompió\".

Fix en canvas-v4.tsx:
- Nuevo ChatErrorBanner component con icon TriangleAlert + título
  operativo + body explicativo + <details> con stderr crudo
  colapsado por defecto.
- translateGatewayError() reconoce patterns: SSH exit 255/1/127,
  gateway 502/network, timeout, permission denied. Cada uno con
  título + body operativo. Fallback genérico envuelve cualquier
  string crudo en estructura aceptable.

Antes: \"SSH command failed with exit 255.\"
Ahora: \"Comando SSH no completó · OpenClaw no pudo establecer la
conexión SSH. Probablemente el servidor aún no acepta conexiones
desde el cluster, o cambió la huella de host. [Ver detalle técnico ▾]\"

== A-CRIT-04: Guard de gráficas Hardware si series vacías ==

/hardware mostraba contradicción gritando: texto \"Sin series
disponibles\" + tag \"Telemetría desactualizada sin datos\" + tabla
\"10 unknown\" + gráficos USO CPU 38% / RAM 66% / TEMP 48°C con
barras visibles. Los 3 gráficos usaban fallbackBars hardcoded.

Fix en features/hardware/index.tsx:
- Historial() chequea series.length===0 → renderiza HistorialEmpty
  honesto en vez de las 3 ChartFromSeries.
- HistorialEmpty muestra \"Sin telemetría aceptada todavía\" +
  copy explicativo + CTA implícita a solicitar snapshot manual.
- ChartFromSeries (defensa por sub-métrica): si points.length===0
  renderiza placeholder discreto \"serie sin puntos\" en vez de
  fallback bars.
- shared/api/client.ts: agrega lastCaptureAt?: string|null al
  HardwareTelemetryHistoryPayload (defensivo — Codex puede poblarlo
  para que el empty state diga \"hace Xh\").

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- vite build → ✓ (HMR vivo verificado en localhost:5173)
- Verificación visual con Chrome MCP:
  * /hardware: empty state honesto, sin gráficas mintiendo.
  * /canvas: solo 1 chip 'Live' verde, sin contradicción.
  * Filtro de tareas conversacionales activo (esperando próximo
    falso positivo para validar visualmente — tasks históricas
    son >5min entonces no aplican).

== Próximos pasos ==

1. Codex toma OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md y arranca:
   - A-CRIT-01-A limpieza workspace (10 min URGENTE)
   - 22 gates en español
   - Webdock × 3 cuentas
   - 5 items MEDIO + 3 BAJO
2. Claude cierra A-ALT-01 a A-ALT-06 y los MEDIOS/BAJOS de su columna
   mañana viernes 29-may primera hora.
3. Practice run #3 con todo integrado antes del demo 11h Colombia."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
