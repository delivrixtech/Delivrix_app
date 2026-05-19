---
slug: drift-monitor
version: 1.0.0
trigger: "hay algo desalineado | drift | qué propone OpenClaw | inconsistencias"
schedule: "*/5 * * * *"
delivrix_actions:
  - read_webdock_inventory
  - read_sender_nodes
  - read_openclaw_live_canvas
returns: structured-markdown
audit_id_prefix: oc.skill.drift
fallback: rules-engine-local
hito: 5.11.A (rules engine) + 5.11.B (uso como skill)
---

# Drift Monitor

## Propósito

Detecta drift entre el inventario real de Webdock y el sender_node registry
local. Emite propuestas tipadas (resume, pause, register, orphan) ordenadas
por severidad. Las propuestas válidas se inyectan al `prompt` del Canvas
Delivrix vía POST `/v1/agent/proposals` (Doc 4 §4.2).

## Cuándo se invoca

- Cron cada 5 min (loop principal del agente).
- Operador pregunta explícitamente.
- `delivrix-alert-ops` delega cuando detecta anomalía en sender_node status.

## Endpoints que consume

| Orden | Endpoint | Por qué |
| --- | --- | --- |
| 1 | `GET /v1/webdock/inventory` | Inventario Webdock + propuestas drift del rules engine |
| 2 | `GET /v1/sender-nodes` | Registry local para cruzar |
| 3 | `GET /v1/openclaw/live-canvas` | Verificar si propuestas ya están en `canvas.prompt` |

## Lógica del agente

1. Lee los 3 endpoints.
2. El Gateway ya devuelve `drift.proposals[]` calculadas por el rules engine
   local (`evaluateWebdockDrift`).
3. La skill **no** recalcula la lógica; sólo decide qué hacer con cada propuesta:
   - **Si la propuesta ya está en `canvas.prompt`** → ignora, no duplica.
   - **Si la propuesta es nueva** → emite `POST /v1/agent/proposals` (Doc 4
     §4.2) con el payload completo.
   - **Si severidad es `high`** → además crea tarjeta Notion Bugs & Blockers
     vía `delivrix-alert-ops` (delegación).

## Formato de respuesta

```markdown
## Drift — snapshot {ISO}

**Total propuestas detectadas: {N}**

### Por severidad
- High: {N}
- Medium: {N}
- Low: {N}

### Detalle
{tabla: id | severity | category | target | acción_propuesta}

### Inyectadas al canvas en este run
{lista de IDs nuevos}

### Ignoradas (ya en canvas o snooze)
{lista}

_Evidencia_: `oc.read.webdock#{h1}`, `oc.read.sender_nodes#{h2}`
```

## Errores y fallback

| Escenario | Acción |
| --- | --- |
| Gateway devuelve `source.kind: mock` | Continúa con datos mock; reporta degradación |
| POST `/v1/agent/proposals` falla | Audita `oc.proposal.submit_failed`, reintenta backoff 2/4/8s |
| Webdock API caída (mock fallback en Gateway) | Confía en el rules engine local |
| Propuesta rechazada por Gateway (403) | Audita y no reintenta; lee el `rejectReason` |

## Gates duros

- Propuestas que requieren `supervised_local_state` no se ejecutan
  automáticamente — solo se proponen para firma humana.
- Propuestas de categoría `future_live_requires_new_phase` o `prohibited`
  no se generan (el rules engine no las emite; si llegan por bug, se filtran).
- Idempotencia: misma propuesta detectada dos veces seguidas no se reinyecta
  al canvas. Se mide con hash del `targetRef + category`.
- Rate limit: máx 10 propuestas por run. Si el drift detecta más, se reportan
  todas pero solo se inyectan las 10 de mayor severidad.

## Ejemplo de prompt del operador

> "qué está desalineado?"

## Ejemplo de respuesta esperada

```markdown
## Drift — snapshot 2026-05-18T03:35:00Z

**Total propuestas detectadas: 2**

### Por severidad
- High: 1
- Medium: 0
- Low: 1

### Detalle
| id | severity | category | target | acción |
|---|---|---|---|---|
| pause-svc-warmup-02 | high | node_pause_proposed | svc-warmup-02 | Pausar nodo: Webdock reporta stopped |
| register-svc-prod-eu-01 | low | node_register_proposed | svc-prod-eu-01 | Registrar nodo en registry local |

### Inyectadas al canvas en este run
- pause-svc-warmup-02

### Ignoradas
- register-svc-prod-eu-01 (ya en canvas.prompt, no se reinyecta)

_Evidencia_: `oc.read.webdock#a8c3`, `oc.read.sender_nodes#d2e1`
```

## Implementación (Codex)

- Plugin TypeScript en `/openclaw/plugins/drift-monitor/index.ts`.
- Scheduler interno del container OpenClaw lo dispara cada 5 min.
- Persistencia de propuestas inyectadas (dedupe) en SQLite local del
  container con TTL 6h por hash.
- Cliente HTTP al Gateway con `DELIVRIX_OPENCLAW_TOKEN` (refresh cada 15 min).
