---
slug: delivrix-alert-ops
version: 1.0.0
trigger: "qué alertas hay | qué gates están abiertos | qué requiere mi atención | está bien todo | algo crítico"
delivrix_actions:
  - read_admin_overview
  - read_audit_events
  - read_kill_switch
  - read_operating_north
  - read_openclaw_live_canvas
returns: structured-markdown
audit_id_prefix: oc.skill.alert_ops
fallback: none
hito: 5.11.B
---

# Delivrix Alert Ops

## Propósito

Detecta qué necesita atención humana **ahora mismo**. Kill switch, gates
abiertos, eventos críticos en audit log, drift sin atender, sender nodes
quarantined. Si encuentra algo crítico, también crea tarjeta en Notion
Bugs & Blockers.

## Cuándo se invoca

- Operador pregunta sobre alertas o estado general.
- Cron del agente cada 5 min (loop de alerting).
- Otra skill detecta anomalía y delega a esta para evaluar severidad.

## Endpoints que consume

| Orden | Endpoint | Por qué |
| --- | --- | --- |
| 1 | `GET /v1/kill-switch` | Estado del kill switch (gate último) |
| 2 | `GET /v1/admin/overview` | Alerts de alto nivel y health summary |
| 3 | `GET /v1/operating-north` | Gates abiertos (de 31 totales) |
| 4 | `GET /v1/openclaw/live-canvas` | Propuestas pendientes y currentStepId |
| 5 | `GET /v1/audit-events?since=24h` | Eventos críticos últimas 24h |

## Formato de respuesta

```markdown
## Alertas — snapshot {ISO}

**Severidad máxima detectada: {critical | high | medium | low | none}**

### Kill switch
- Estado: {armed | active}
- Última actualización: {ISO + actor}

### Gates abiertos ({N} de 31)
{lista corta}

### Alertas críticas (últimas 24h, ordenadas por severidad)
{tabla: timestamp | severity | source | mensaje}

### Propuestas pendientes
{lista de propuestas del canvas.prompt no resueltas}

### Recomendación
{1-2 oraciones del agente sobre qué atender primero}

_Evidencia_: {audit IDs}
```

## Errores y fallback

| Escenario | Acción |
| --- | --- |
| Kill switch endpoint no responde | Escalar severidad a `critical`, reportar "no puedo verificar gate último" |
| Audit log vacío en 24h | Reportar honestamente, no inventar eventos |
| Todos los endpoints fallan | Reportar "agente sin visibilidad operativa" + recomendar revisión manual urgente |

## Side-effect permitido

Cuando detecta evento `critical` que **no** tiene tarjeta abierta en Notion
Bugs & Blockers, crea una automáticamente:

```python
flag_issue(
  issue_title=f"{action} → {target}",
  category="Agent Error" | "Flagged Server" | "DNS/Config",
  severity="Critical",
  affected_server=target_id,
  description=event.metadata.errorMessage or event.action
)
```

Plantilla viene del `Agent Integration Guide` (Notion). Audita la creación
con `oc.notion.bug_created` + ID de la página.

## Gates duros

- No despierta al operador con notificación push; sólo escribe a Notion.
  Despertar al humano queda para hito posterior con sistema de paging.
- No deduce causas raíz; sólo correlaciona y reporta. La causa raíz se
  investiga en runbook de incidente.
- Si la skill se invoca y devuelve `severidad: none` durante 7 días
  consecutivos, no se considera anómalo (es la operación normal).

## Ejemplo de prompt del operador

> "está pasando algo malo?"

## Ejemplo de respuesta esperada (caso con incidente)

```markdown
## Alertas — snapshot 2026-05-18T03:20:00Z

**Severidad máxima detectada: high**

### Kill switch
- Estado: armed
- Última actualización: 2026-05-15T10:00:00Z · operador@delivrix

### Gates abiertos (3 de 31)
- `no_real_email_from_delivrix` (esperado en MVP)
- `manual_snapshot_ingestion_requires_supervised_human_approval` (esperado)
- `kill_switch_proof_before_phase_5_demo` (pendiente — falta prueba de switch)

### Alertas críticas (últimas 24h)
| timestamp | severity | source | mensaje |
|---|---|---|---|
| 2026-05-18T01:45Z | high | drift-monitor | svc-warmup-02 status mismatch (Webdock stopped, registry active) |
| 2026-05-17T22:10Z | medium | hardware-collector | telemetry_stale > 6h |

### Propuestas pendientes
- `pause-svc-warmup-02` (high) — esperando firma humana

### Recomendación
Atender primero la propuesta `pause-svc-warmup-02`: Webdock reporta el server
detenido pero el registry local lo tiene activo. Si entra un job, fallará.
Tarjeta de Notion creada: bug-7f3a2c1.

_Evidencia_: `oc.read.kill_switch#a1`, `oc.read.admin_overview#b2`,
`oc.read.north#c3`, `oc.read.canvas#d4`, `oc.read.audit#e5`
```

## Implementación (Codex)

- Plugin TypeScript en `/openclaw/plugins/delivrix-alert-ops/index.ts`.
- Sin cache: alertas deben ser frescas.
- Timeout 6s; si excede, devuelve lo que pudo + flag de degradación.
- Cliente Notion via `NOTION_API_KEY` env var. Si falla, reporta pero no
  bloquea la respuesta principal.
