---
slug: delivrix-report-ops
version: 1.0.0
trigger: "reporte diario | resumen del día | qué pasó hoy | daily standup"
schedule: "0 23 * * *"
delivrix_actions:
  - read_operational_summary
  - read_audit_events
  - read_send_results
  - read_ip_reputation_reports
  - read_sender_nodes
returns: structured-markdown
audit_id_prefix: oc.skill.report_ops
fallback: partial-report
hito: 5.11.B
---

# Delivrix Report Ops

## Propósito

Reporte ejecutivo de fin de día. KPIs, eventos críticos, propuestas
aprobadas/rechazadas, próximos pasos. Se publica automáticamente a la DB
de Notion `📝 Daily Standup` y queda disponible para el operador.

## Cuándo se invoca

- Cron diario `0 23 * * *` UTC.
- Operador la pide manualmente con prompt natural.
- Cierre de hito o evento operacional importante.

## Endpoints que consume

| Orden | Endpoint | Por qué |
| --- | --- | --- |
| 1 | `GET /v1/operational-summary` | KPIs canónicos del día |
| 2 | `GET /v1/audit-events?since=24h` | Eventos del día, ordenados |
| 3 | `GET /v1/send-results?since=24h` | Bounces/complaints/sent |
| 4 | `GET /v1/ip-reputation/reports` | Salud de IPs |
| 5 | `GET /v1/sender-nodes` | Cambios de estado de nodos |

## Formato de respuesta

```markdown
# Daily Standup — {YYYY-MM-DD}

## KPIs
- SMTPs activos: {N}
- SMTPs en warming: {N}
- SMTPs ready: {N}
- Reputación promedio: {score} / 100
- Quejas día: {%}
- Bounces día: {%}

## Eventos críticos del día
{lista o "ninguno"}

## Propuestas de OpenClaw
- Aprobadas: {N}
- Rechazadas: {N}
- Pendientes: {N}

## Cambios de estado de sender nodes
{tabla: timestamp | nodeId | from | to | razón}

## Próximos pasos sugeridos
1. ...
2. ...
3. ...

## Bandera humanReviewRequired
{true | false} — {razón si true}

_Generado por OpenClaw {modelVersion} · prompt {promptVersion} · {tokens} tokens_
```

## Side-effect permitido (auditado)

Postea el reporte a Notion Daily Standup DB con plantilla del
Agent Integration Guide:

```python
post_standup_summary(
  smtps_built=kpis.built,
  smtps_in_warmup=kpis.warming,
  smtps_ready=kpis.ready,
  completed_today=eventsSummary,
  blockers=criticalEventsList,
  next_steps=recommendations
)
```

Audita con `oc.notion.standup_posted` + URL.

## Errores y fallback

| Escenario | Acción |
| --- | --- |
| 1-2 endpoints fallan | Reportar "datos insuficientes para sección X" y continuar |
| 3+ endpoints fallan | Aborta reporte, audita `oc.skill.report_ops.aborted`, alerta operador |
| Notion API falla | Devuelve reporte por respuesta directa pero audita `oc.notion.post_failed` |
| Tokens del LLM exceden quota | Reporta hasta donde alcanzó + flag de truncado |

## Gates duros

- Reporte no se ejecuta si kill switch está active (sólo lecturas, sin
  side-effect a Notion).
- Reporte nunca incluye PII de destinatarios. Solo agregados.
- Reporte nunca afirma volumen futuro ("vamos a enviar X correos mañana").
  Sólo describe el día pasado.

## Ejemplo de prompt del operador

> "dame el reporte de hoy"

## Implementación (Codex)

- Plugin TypeScript en `/openclaw/plugins/delivrix-report-ops/index.ts`.
- Llamadas paralelas a los 5 endpoints (timeout 5s c/u).
- Plantilla Markdown renderizada con template engine simple (no Mustache,
  template literals nativos).
- Cliente Notion: `NOTION_API_KEY` env var + DB ID
  `2ce92c3910bd4b8a8f2b1e031a36a749` del Agent Integration Guide.
