# Indice de documentacion Delivrix

Fecha: 2026-05-03

## Regla de lectura

Para evitar confusion, leer en este orden:

1. `NORTE_OPERATIVO_DELIVRIX.md`
2. `RESUMEN_RUTA_PROYECTO.md`
3. `ROADMAP_PROYECTO.md`
4. `ESTANDARES_INGENIERIA.md`
5. Documento del hito activo.

## Documentos rectores

- `NORTE_OPERATIVO_DELIVRIX.md`: verdad operacional y limites.
- `RESUMEN_RUTA_PROYECTO.md`: mapa tecnico.
- `ROADMAP_PROYECTO.md`: fases e hitos.
- `ESTANDARES_INGENIERIA.md`: buenas practicas.
- `ANALISIS_CRITICO_ROADMAP.md`: riesgos y criterios criticos.

## Documentos de fase

- `FASE_2_*`: pipeline operativo local/Webdock mock.
- `FASE_3_INFRAESTRUCTURA_PROPIA.md`: Proxmox/mock infraestructura.
- `FASE_4_OPENCLAW_INFRAESTRUCTURA.md`: OpenClaw infraestructura.
- `FASE_5_MVP_DEMOSTRABLE.md`: demo end-to-end y panel.

## Hitos activos recientes

- `HITO_5_4_ADMIN_PANEL_VISUAL_ARQUITECTURA.md`
- `HITO_5_4A_ADMIN_PANEL_READ_ONLY.md`
- `HITO_5_4B_ADMIN_PANEL_WORKFLOW.md`
- `HITO_5_4C_ADMIN_CLUSTERS_OPENCLAW_LEARNING.md`
- `HITO_5_5_AUDITORIA_FRONTEND_UI_PROCESOS.md`
- `HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md`
- `HITO_5_6_CONTRATOS_CANVAS_HARDWARE_ML_DEVOPS.md`

## Politica anti-repeticion

- README no debe duplicar cada endpoint de cada hito.
- Cada hito debe documentar solo su propio cambio, verificacion y limites.
- Las reglas globales de seguridad se escriben en documentos rectores y se referencian.
- Si dos documentos dicen lo mismo, conservarlo en el documento rector y reemplazar la copia por una referencia.
- Los documentos historicos no se borran solo por ser antiguos; se corrigen cuando contradicen el norte o repiten reglas globales innecesariamente.
