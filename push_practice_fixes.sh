#!/bin/bash
# Push de los fixes del practice run jueves 28-may (M-6 + M-7)
#
# Hallazgos cerrados en este commit:
# - M-6: Sender Pool — empty state único cuando los 3 KPIs son 0 (en vez
#   de 3 columnas idénticas con "0" que no agregan información). Se
#   reemplaza por un row con SendHorizontal icon en accent y mensaje
#   "Sender pool aún vacío — Cuando OpenClaw aprovisione el primer
#   dominio sender los verás aparecer acá. Usá el botón Onboard con
#   OpenClaw para iniciar el primero."
# - M-7: Sender Pool — banner de endpoint pendiente con icono Info azul
#   (en vez de TriangleAlert naranja que se lee como error). Texto
#   suavizado: "Próximo paso · GET /v1/sender-pool/status en backend"
#   + "No afecta el demo."
#
# Hallazgos cancelados (false positives):
# - M-3: Provisionamiento card warning — confirmado como variant
#   intencional "in_progress" con progress bar 62%. No es bug.
#
# Hallazgos que requieren tu decisión (NO van en este commit):
# - M-5 (ALTA): Tarea fallida "Ok, hemos adquirido un nuevo VPS..."
#   visible top de Canvas Live sidebar. Opción A/B/C en el reporte.
# - M-2 (Media): Inconsistencia 5 vs 42 IPs en calentamiento.
# - M-1 (Baja): Tags Gates abiertos en inglés técnico.
#
# Ver: DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# 1) Limpiar locks stale del sandbox si quedaron
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# 2) Pull primero por si Codex pusheó algo
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# 3) Stage los archivos del fix + el report del practice run
git add \
  apps/admin-panel/src/features/sender-pool/index.tsx \
  DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "fix(panel): 2 fixes del practice run jueves 28-may pre-demo

Practice run completo del panel hecho por Claude con Chrome MCP,
criterio senior frontend + UX. 7 hallazgos consolidados en
DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md.

Este commit cierra M-6 y M-7 (frontend simple, sin decisión CTO).
Los otros 4 hallazgos quedan documentados en el reporte:
- M-5 (ALTA) requiere decisión CTO Opción A/B/C
- M-2 (Media) investigación pendiente 5 vs 42 IPs
- M-1 (Baja) traducción tags Gates post-demo
- M-3 cancelado (false positive — variant in_progress intencional)

== M-6: Sender Pool empty state único ==

Antes: 3 KPI cards idénticas \"ACTIVOS ENVIANDO 0\", \"TOTAL
PROVISIONADOS 0\", \"PLANEADOS PRÓXIMOS 7 DÍAS 0\". Visualmente
ruido sin valor — tres columnas con el mismo \"0\" no agregan info
para un jefe que ve el panel por primera vez.

Después: cuando los 3 contadores están en 0 (estado típico
pre-demo), renderiza un row único con icono SendHorizontal en
accent + título \"Sender pool aún vacío\" + subtítulo \"Cuando
OpenClaw aprovisione el primer dominio sender los verás aparecer
acá. Usá el botón Onboard con OpenClaw para iniciar el primero.\"

El componente se mantiene defensivo: en cuanto el primer dominio
sea provisionado y capacity.activeDomains o capacity.totalDomains
o capacity.plannedDomains pase a >0, vuelve a renderizar las 3
KPI cards normales. No se pierde funcionalidad.

== M-7: Banner endpoint pendiente con tono info ==

Antes: card con TriangleAlert naranja (var(--color-warning)) +
texto \"Endpoint /v1/sender-pool/status pendiente · Codex lo
expone en Bloque 10\". Visualmente se lee como \"hay un error\".

Después: card con Info azul (var(--color-accent)) + texto
\"Próximo paso · GET /v1/sender-pool/status en backend\" +
footer suavizado \"No afecta el demo.\"

Justificación UX: warning (naranja/amarillo) debe reservarse para
estados que requieren atención del operador (cap del wallet al
80%, dominio cerca de blacklist, warmup estancado). Un endpoint
de backend que todavía no está expuesto es información, no
problema operativo. Info azul es la semántica correcta.

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- vite build → ✓ canvas-v4 chunk 277 kB gz 80 kB
- Verificado visualmente en localhost:5173/sender-pool con
  Chrome MCP: empty state renderiza correcto, banner info azul
  comunica próximo paso sin alarmismo.

== Reporte completo ==

DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md detalla los 7
hallazgos del practice run con evidencia visual, severidad,
owner y estado. Incluye sección \"Lo que estaba EXCELENTE\" para
preservar los aciertos del Bloque 10."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
