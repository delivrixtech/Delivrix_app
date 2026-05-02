# Fase 2: Hito 2.9 Health checks y estados de sender nodes

Fecha: 2026-05-02

## Objetivo

Conectar resultados simulados con salud operativa de sender nodes.

Este hito no toca Webdock real, no abre SSH, no modifica Postfix y no envia correo. Solo evalua datos locales y actualiza estados locales de sender nodes.

## Estados operativos

Estados existentes:

- `active`
- `warming`
- `paused`
- `quarantined`
- `degraded`
- `retired_pending_approval`

## Evaluacion de salud

Se agrego `evaluateSenderNodeHealth`.

Metricas por sender node:

- `sent`
- `bounce`
- `complaint`
- `deferred`
- `failed`
- `total`

Umbrales actuales:

- `complaint >= 1` -> `quarantined`
- `bounce >= 2` -> `degraded`
- `deferred >= 3` -> `degraded`
- `failed >= 2` -> `degraded`

## Endpoints

Lectura:

```bash
GET /v1/sender-node-health
```

Aplicacion local auditada:

```bash
POST /v1/sender-node-health/reconcile
```

## Reconcile

`reconcile` aplica cambios locales cuando:

- `currentStatus` es distinto de `recommendedStatus`.
- El nodo no esta en `retired_pending_approval`.

Cada ejecucion se audita como:

- `sender_node_health.reconciled`

## Verificacion realizada

1. Se registro `sender_health_complaint_001`.
2. Se encolo un job con `metadata.simulatedResult = complaint`.
3. El Worker genero `send_result` con `status = complaint`.
4. `GET /v1/sender-node-health` recomendo:
   - `sender_health_complaint_001`
   - `recommendedStatus = quarantined`
   - `severity = critical`
5. `POST /v1/sender-node-health/reconcile` aplico:
   - `active -> quarantined`
6. `GET /v1/sender-nodes` mostro el nodo en `quarantined`.
7. `GET /v1/operational-summary` conto:
   - `senderNodesByStatus.quarantined = 1`

## Decision conservadora

El sistema no restaura automaticamente nodos desde `degraded`, `paused` o `quarantined` a `active`. La recuperacion de reputacion debe ser un flujo posterior con aprobacion o reglas explicitas.

## Siguiente hito recomendado

**Hito 2.10: admin/operational summary completo**

Debe consolidar:

- resumen operativo.
- health checks.
- sender nodes.
- rate limits.
- send results.
- acciones auditadas recientes.
- alerta visible si existen nodos `degraded` o `quarantined`.
