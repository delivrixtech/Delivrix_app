# Fase 2: Hito 2.13 Controles manuales de sender nodes

Fecha: 2026-05-02

## Objetivo

Agregar controles manuales granulares para operar sender nodes sin pausar toda la plataforma.

Este hito no envia correo real, no abre SMTP, no abre SSH y no modifica Webdock. Solo cambia estado local persistido y auditable.

## Acciones soportadas

- `pause`: cambia un nodo a `paused`.
- `reactivate`: cambia un nodo `paused` o `degraded` a `active`.
- `degrade`: cambia un nodo a `degraded`.
- `quarantine`: cambia un nodo a `quarantined`.

Todas las acciones requieren `reason`.

## Reglas de seguridad

- No se permiten cambios manuales sobre nodos `retired_pending_approval`.
- Un nodo `quarantined` no puede reactivarse con el endpoint manual general.
- Reactivar usa `riskLevel = high`.
- Cuarentena usa `riskLevel = critical`.
- Cualquier rechazo peligroso queda auditado como `sender_node.manual_control_rejected`.

## Endpoints

```bash
POST /v1/sender-nodes/:senderNodeId/pause
POST /v1/sender-nodes/:senderNodeId/reactivate
POST /v1/sender-nodes/:senderNodeId/degrade
POST /v1/sender-nodes/:senderNodeId/quarantine
```

Payload:

```json
{
  "reason": "Provider maintenance",
  "actorId": "operator_local"
}
```

## Auditoria

Acciones registradas:

- `sender_node.manual_paused`
- `sender_node.manual_reactivated`
- `sender_node.manual_degraded`
- `sender_node.manual_quarantined`
- `sender_node.manual_control_rejected`

La metadata incluye:

- accion solicitada.
- razon.
- estado anterior.
- estado nuevo cuando aplica.
- proveedor.
- `smtpEnabled = false`.
- `sideEffects = local-state-only`.

## Archivos principales

- `packages/domain/src/sender-node-manual-control.ts`
- `apps/gateway-api/src/main.ts`
- `packages/domain/src/sender-node-manual-control.test.ts`

## Verificacion realizada

Comandos:

```bash
node --test packages/domain/src/*.test.ts
node --check apps/gateway-api/src/main.ts
node --check apps/worker/src/main.ts
```

Prueba local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sender-nodes/sender_webdock_bridge_001/pause \
  -H 'content-type: application/json' \
  -d '{"reason":"Provider maintenance","actorId":"operator_local"}'
```

Resultado observado:

- `sender_results_test_001` cambio de `active` a `paused`.
- `GET /v1/sender-nodes` reflejo `sender_results_test_001.status = paused`.
- `sender_results_test_001` se reactivo de `paused` a `active` para dejar el runtime como estaba.
- El audit log registro `sender_node.manual_paused`.
- El audit log registro `sender_node.manual_reactivated`.
- Reactivar `sender_health_complaint_001` desde `quarantined` respondio `422`.
- El rechazo quedo auditado como `sender_node.manual_control_rejected` con `riskLevel = critical`.

## Siguiente hito recomendado

**Hito 2.14: ingestion mock de bounces y complaints**

Motivo: despues de poder controlar nodos manualmente, necesitamos una entrada simulada para eventos externos de reputacion que alimente health checks y cuarentena.
