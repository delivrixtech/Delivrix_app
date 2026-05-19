---
slug: delivrix-fleet-ops
version: 1.0.0
trigger: "estado de la flota | clusters | sender nodes | qué hay corriendo | cómo está la operación"
delivrix_actions:
  - read_admin_clusters
  - read_sender_nodes
  - read_openclaw_live_canvas
  - read_webdock_inventory
returns: structured-markdown
audit_id_prefix: oc.skill.fleet_ops
fallback: rules-engine-local
hito: 5.11.B
---

# Delivrix Fleet Ops

## Propósito

Da una foto operativa de la flota: cuántos clústeres, cuántos sender nodes,
cómo van vs el inventario real de Webdock, qué nodos están atorados.

## Cuándo se invoca

- El operador pregunta sobre estado de flota en lenguaje natural.
- Cron del agente cada 30 min (chequeo de salud).
- Una propuesta de OpenClaw necesita citar el estado actual de la flota.

## Endpoints que consume

| Orden | Endpoint | Por qué |
| --- | --- | --- |
| 1 | `GET /v1/admin/clusters` | Lista de clústeres + totales |
| 2 | `GET /v1/sender-nodes` | Sender nodes con status y warmupDay |
| 3 | `GET /v1/openclaw/live-canvas` | Estado canvas actual + currentStepId |
| 4 | `GET /v1/webdock/inventory` | Cruzar con realidad del proveedor |

Cada lectura emite `oc.read.<endpoint>` en audit.

## Formato de respuesta

```markdown
## Flota — snapshot {ISO timestamp}

**Resumen**
- Clústeres: {N} ({estado dominante})
- Sender nodes: {N} activos / {N} warming / {N} pausados
- Webdock real: {N} running, {N} stopped, {N} suspended
- Canvas current step: {currentStepId}

**Por clúster**
{tabla: cluster_id | provider | mgmt_state | sender_nodes_count}

**Sender nodes (top 5 por warmupDay)**
{tabla: id | provider | status | ipv4 | warmupDay | dailyLimit}

**Drift detectado**
{lista de slugs que aparecen en Webdock pero no en registry, o viceversa}

_Evidencia_: {hashes audit ID de cada read}
```

## Errores y fallback

| Escenario | Acción |
| --- | --- |
| `GET /v1/sender-nodes` falla | Continúa con los otros 3; reporta "registry local no respondió" |
| Todos los endpoints fallan | Cae al rules engine local (`openclaw-rules.ts`) y reporta degradación |
| `GET /v1/webdock/inventory` devuelve `source.kind: mock` | Lo advierte en la respuesta |

## Gates duros heredados

- Esta skill **no** propone acciones; sólo reporta. Para proponer usa
  `drift-monitor` o `delivrix-alert-ops`.
- Esta skill **no** modifica nada local. Es 100% lectura.

## Ejemplo de prompt del operador

> "¿cómo va la flota?"

## Ejemplo de respuesta esperada

```markdown
## Flota — snapshot 2026-05-18T03:15:00Z

**Resumen**
- Clústeres: 1 (svc-warmup-01 — managed)
- Sender nodes: 2 warming / 0 activos / 0 pausados
- Webdock real: 2 running, 1 stopped, 0 suspended
- Canvas current step: `warming_plan`

**Por clúster**
| cluster_id | provider | mgmt_state | sender_nodes |
|---|---|---|---|
| svc-warmup-01 | webdock | managed | 2 |

**Sender nodes (top 5 por warmupDay)**
| id | provider | status | ipv4 | warmupDay | dailyLimit |
|---|---|---|---|---|---|
| svc-warmup-01 | webdock | warming | 185.243.12.31 | 7 | 50 |
| svc-warmup-02 | webdock | warming | 185.243.12.32 | 5 | 50 |

**Drift detectado**
- `svc-prod-eu-01` aparece en Webdock (`stopped`) pero no en sender_node registry.
  Sugerencia: ver `drift-monitor` para propuesta de registro o ignorar.

_Evidencia_: `oc.read.admin_clusters#a1b2c3`, `oc.read.sender_nodes#d4e5f6`,
`oc.read.canvas#7g8h9i`, `oc.read.webdock#j0k1l2`
```

## Implementación (Codex)

- Plugin TypeScript en el container OpenClaw, no `SKILL.md` puro: requiere
  llamar 4 endpoints en paralelo + parsear + formatear, lógica suficiente
  para justificar plugin.
- Path: `/openclaw/plugins/delivrix-fleet-ops/index.ts`.
- Cache local 30s: si el operador pregunta dos veces en menos de 30s, reusar.
- Timeout total: 8s. Si excede, devuelve datos parciales + lista de timeouts.
