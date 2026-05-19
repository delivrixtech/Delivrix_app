---
id: daily-report
version: 1.0.0
matrix_category: allowed_dry_run
delivrix_actions:
  - generate_daily_report
required_approvals: 0
estimated_minutes: 2
reversible: n/a
hito: 5.11.B
schedule: "0 23 * * *"
---

# Runbook · Reporte diario

## Propósito

Generar el reporte ejecutivo de fin de día y publicarlo a Notion Daily
Standup. No requiere aprobaciones porque no muta estado operativo —
solo escribe a Notion (audit trail).

## Preconditions

1. Cron `0 23 * * *` UTC dispara, **o** operador lo pide manualmente.
2. Kill switch armado pero no activo (en `active` no se postea side-effect
   a Notion; se devuelve el reporte por respuesta directa con flag de
   degradación).
3. Skill `delivrix-report-ops` cargada y healthy.

## Steps

1. **OpenClaw invoca `delivrix-report-ops`.** La skill lee los 5 endpoints
   declarados en su `SKILL.md`.
2. **Construye Markdown** según plantilla del SKILL.md.
3. **Postea a Notion** vía `post_standup_summary()` del Agent Integration
   Guide:
   ```python
   post_standup_summary(
     smtps_built=summary.totals.senderNodes - summary.warming - summary.ready,
     smtps_in_warmup=summary.senderNodesByStatus.warming,
     smtps_ready=summary.senderNodesByStatus.active,
     completed_today=eventsSummary,
     blockers=criticalEventsList,
     next_steps=recommendations
   )
   ```
4. **Audit.** Eventos:
   - `oc.skill.report_ops.invoke` (siempre).
   - `oc.notion.standup_posted` con URL del page creado.
   - Si Notion falla: `oc.notion.post_failed` + reporte devuelto por
     respuesta directa.

## Postconditions

- Hay fila nueva en `📝 Daily Standup` con `Log Date = today`.
- Audit log refleja el invoke y el post.
- Si fue manual, operador recibe el reporte en chat.

## Rollback

No aplica (no muta estado operativo). Si el reporte tuvo error de datos:

1. Borrar manualmente la fila incorrecta en Notion (decisión del operador,
   no automatizado).
2. Re-correr el runbook con `force=true` opcional.

## Audit IDs

| Evento | ID |
| --- | --- |
| Invoke | `oc.skill.report_ops.invoke` |
| Notion OK | `oc.notion.standup_posted` |
| Notion fail | `oc.notion.post_failed` |
| Aborto por kill switch | `oc.runbook.daily_report.aborted_kill_switch` |
| Data insuficiente | `oc.skill.report_ops.partial` |

## Quién puede invocar

- Cron interno de OpenClaw (scheduler nativo).
- Operador con prompt natural ("dame el reporte de hoy").
- Skill `delivrix-alert-ops` cuando cierra un incidente crítico (genera
  reporte fuera de turno con contexto).

## Quién aprueba

- Nadie. Es dry-run sin mutación operativa.

## Ejemplo de mensaje al ejecutarse automáticamente

```
[2026-05-18T23:00:00Z] OpenClaw scheduler trigger
→ delivrix-report-ops invoked
→ Reading 5 endpoints (1.2s parallel)
→ Markdown rendered (487 tokens)
→ POST https://api.notion.com/v1/pages → 200 OK
→ Page: https://notion.so/.../daily-standup-2026-05-18
→ Audit: oc.skill.report_ops.invoke#a1b2, oc.notion.standup_posted#c3d4
```
