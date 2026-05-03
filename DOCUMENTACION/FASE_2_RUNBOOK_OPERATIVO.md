# Fase 2: Hito 2.15 Runbook operativo

Fecha: 2026-05-02

## Objetivo

Definir el procedimiento operativo de Fase 2 para ejecutar, inspeccionar, pausar, recuperar y simular incidentes del pipeline Webdock en modo seguro.

Este runbook no habilita envio real. La Fase 2 sigue en modo local/dry-run:

- sin SMTP real.
- sin SSH.
- sin cambios reales en Webdock.
- sin aumento de volumen.
- sin autonomia de OpenClaw.

## Estado esperado de Fase 2

La plataforma debe poder:

- registrar sender nodes Webdock como puente local.
- aceptar solicitudes autorizadas.
- aplicar policy engine, suppression list y rate limits.
- crear jobs locales.
- procesar jobs con Worker en dry-run.
- registrar resultados simulados o ingested.
- evaluar health de sender nodes.
- pausar todo con kill switch.
- operar sender nodes individualmente.
- recuperar jobs atascados.
- mostrar overview operativo.
- auditar toda accion relevante.

## Archivos runtime locales

Estos archivos son estado operativo local y no se suben a Git:

- `runtime/send-jobs.json`
- `runtime/audit-events.json`
- `runtime/suppression-entries.json`
- `runtime/sender-nodes.json`
- `runtime/rate-limit-counters.json`
- `runtime/send-results.json`
- `runtime/kill-switch.json`

## Arranque local

Gateway:

```bash
node apps/gateway-api/src/main.ts
```

Worker:

```bash
node apps/worker/src/main.ts
```

Tests de dominio:

```bash
node --test packages/domain/src/*.test.ts
```

Checks de sintaxis:

```bash
node --check apps/gateway-api/src/main.ts
node --check apps/worker/src/main.ts
```

## Checklist inicial antes de operar

1. Confirmar que el repo esta limpio o entender cambios pendientes:

```bash
git status --short --branch
```

2. Confirmar health del Gateway:

```bash
curl -s http://127.0.0.1:3000/health
```

3. Confirmar kill switch:

```bash
curl -s http://127.0.0.1:3000/v1/kill-switch
```

Estado esperado para operar en dry-run:

- `enabled = false`

4. Revisar overview:

```bash
curl -s http://127.0.0.1:3000/v1/admin/overview
```

5. Revisar sender nodes:

```bash
curl -s http://127.0.0.1:3000/v1/sender-nodes
```

## Operacion normal dry-run

### Registrar sender nodes Webdock de ejemplo

```bash
curl -s -X POST http://127.0.0.1:3000/v1/webdock/bridge-nodes/seed \
  -H 'content-type: application/json' \
  -d '{"nodes":[]}'
```

Nota: el ejemplo real se toma de `config/webdock.nodes.example.json`. Los nodos son de documentacion y no apuntan a infraestructura real.

### Encolar solicitud autorizada

```bash
curl -s -X POST http://127.0.0.1:3000/v1/send-requests \
  -H 'content-type: application/json' \
  -d '{"campaignId":"campaign_demo","recipient":{"email":"demo@example.com","consentProofId":"crm_optin_demo"},"sender":{"address":"hello@delivrix.com","domain":"delivrix.com"},"subject":"Demo","bodyText":"Dry run only.","classification":"commercial","unsubscribeUrl":"https://delivrix.com/unsubscribe/example","physicalAddress":"Delivrix LLC physical mailing address"}'
```

### Procesar un job

```bash
node apps/worker/src/main.ts
```

### Revisar resultados

```bash
curl -s http://127.0.0.1:3000/v1/send-jobs
curl -s http://127.0.0.1:3000/v1/send-results
curl -s http://127.0.0.1:3000/v1/audit-events
```

## Pausa global: kill switch

Activar:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/kill-switch \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"reason":"Manual incident response","actorId":"operator_local"}'
```

Efectos esperados:

- Gateway rechaza nuevas solicitudes con `423 kill_switch_active`.
- Worker no reclama jobs.
- Admin overview muestra alerta critica `kill_switch_active`.
- Se audita `kill_switch.activated`.

Desactivar:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/kill-switch \
  -H 'content-type: application/json' \
  -d '{"enabled":false,"reason":"Incident resolved","actorId":"operator_local"}'
```

Desactivar el kill switch reanuda capacidad operativa local; por eso se audita con `riskLevel = high`.

## Operacion por sender node

Pausar nodo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sender-nodes/sender_webdock_bridge_001/pause \
  -H 'content-type: application/json' \
  -d '{"reason":"Provider maintenance","actorId":"operator_local"}'
```

Degradar nodo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sender-nodes/sender_webdock_bridge_001/degrade \
  -H 'content-type: application/json' \
  -d '{"reason":"Bounce warning threshold","actorId":"operator_local"}'
```

Cuarentena:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sender-nodes/sender_webdock_bridge_001/quarantine \
  -H 'content-type: application/json' \
  -d '{"reason":"Complaint detected","actorId":"operator_local"}'
```

Reactivar:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sender-nodes/sender_webdock_bridge_001/reactivate \
  -H 'content-type: application/json' \
  -d '{"reason":"Issue resolved","actorId":"operator_local"}'
```

Reglas:

- toda accion requiere `reason`.
- nodos `quarantined` no se reactivan por el endpoint manual general.
- nodos `retired_pending_approval` no se modifican por controles operativos manuales.
- todo queda auditado.

## Simular eventos externos de reputacion

Complaint:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/send-results/ingest \
  -H 'content-type: application/json' \
  -d '{"sendJobId":"sendjob_x","status":"complaint","complaintSource":"mock-fbl","actorId":"operator_local"}'
```

Hard bounce:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/send-results/ingest \
  -H 'content-type: application/json' \
  -d '{"sendJobId":"sendjob_x","status":"bounce","bounceCode":"5.1.1","smtpResponse":"550 5.1.1 user unknown","actorId":"operator_local"}'
```

Efectos:

- `complaint` agrega suppression reason `complaint`.
- hard bounce 5xx agrega suppression reason `hard_bounce`.
- eventos impactan `sender-node-health`.
- rechazos quedan auditados.

## Health checks y reconcile

Lectura:

```bash
curl -s http://127.0.0.1:3000/v1/sender-node-health
```

Aplicar recomendaciones locales:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sender-node-health/reconcile
```

Umbrales actuales:

- `complaint >= 1` -> `quarantined`
- `bounce >= 2` -> `degraded`
- `deferred >= 3` -> `degraded`
- `failed >= 2` -> `degraded`

Decision conservadora:

- no se restaura automaticamente desde `degraded`, `paused` o `quarantined` hacia `active`.

## Recuperacion de jobs atascados

Listar stuck jobs:

```bash
curl -s http://127.0.0.1:3000/v1/stuck-jobs
```

Recuperar como failed:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/stuck-jobs/recover \
  -H 'content-type: application/json' \
  -d '{"action":"fail"}'
```

`fail` es la accion por defecto segura porque evita reintentos accidentales.

## Decision matrix

| Situacion | Accion recomendada |
| --- | --- |
| Complaint nueva | Ingestar evento, revisar health, aplicar reconcile si corresponde |
| Complaint en nodo active/warming | Quarantine o reconcile |
| Bounce aislado | Observar, no pausar por un solo evento |
| Bounce >= 2 | Degrade o reconcile |
| Worker interrumpido | Revisar stuck jobs y recuperar con `fail` |
| Duda operacional seria | Activar kill switch |
| Nodo con mantenimiento proveedor | Pause manual |
| Nodo quarantined pide reactivacion | No reactivar por endpoint manual general |
| Cero nodos active/warming | No procesar jobs; revisar fleet y overview |

## Gates que bloquean cualquier avance a trafico real

- No hay autenticacion/autorizacion en Gateway.
- No hay SMTP real autorizado por proveedor.
- No hay confirmacion escrita de proveedor para el tipo de trafico.
- No hay bounce/complaint ingestion real.
- No hay suppression list global productiva.
- No hay secretos gestionados fuera de archivos locales.
- No hay Redis/BullMQ productivo.
- No hay PostgreSQL productivo conectado al runtime.
- No hay dashboard admin con auth.
- No hay rollback probado para infraestructura real.
- No hay kill switch probado en entorno productivo.

## Checklist de salida de Fase 2

Fase 2 puede considerarse lista para pasar a Fase 3 tecnica cuando:

- `node --test packages/domain/src/*.test.ts` pasa.
- Gateway y Worker hacen `node --check` sin errores.
- `GET /v1/admin/overview` responde.
- kill switch activa y desactiva correctamente.
- Worker se bloquea con kill switch activo.
- stuck job recovery detecta y recupera jobs.
- controles manuales pausan y reactivan un nodo seguro.
- reactivacion de `quarantined` queda bloqueada.
- ingestion mock crea send results.
- complaint mock crea suppression entry.
- health recomienda `quarantined` ante complaint.
- `reconcile` aplica cambios locales auditados.
- no existen envios reales, SSH real ni cambios reales en Webdock.

## Siguiente hito recomendado

**Hito 3.1: ProxmoxAdapter mock e interfaz estable**

Motivo: con Fase 2 operativamente documentada, la siguiente fase puede preparar infraestructura propia sin tocar todavia servidores reales.
