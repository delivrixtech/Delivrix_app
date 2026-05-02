# Fase 2: Hito 2.14 Mock ingestion de bounces y complaints

Fecha: 2026-05-02

## Objetivo

Agregar una entrada local y auditada para simular eventos externos de reputacion:

- `bounce`
- `complaint`
- `deferred`
- `failed`

Este hito no envia correo real, no abre SMTP, no abre SSH y no modifica Webdock. Solo escribe resultados locales, auditoria y suppression entries cuando aplica.

## Endpoint

```bash
POST /v1/send-results/ingest
```

Payload de complaint:

```json
{
  "sendJobId": "sendjob_x",
  "status": "complaint",
  "complaintSource": "mock-feedback-loop",
  "actorId": "operator_local"
}
```

Payload de hard bounce:

```json
{
  "sendJobId": "sendjob_x",
  "status": "bounce",
  "bounceCode": "5.1.1",
  "smtpResponse": "550 5.1.1 user unknown",
  "actorId": "operator_local"
}
```

## Reglas implementadas

- El `sendJobId` debe existir.
- Si el job ya tiene `senderNodeId`, el evento debe respetar ese sender node.
- Si el job no tiene `senderNodeId`, el payload debe incluir uno existente.
- No se permite `sent` en este endpoint porque esta ruta es para eventos externos de reputacion.
- `complaint` crea suppression entry con reason `complaint`.
- `bounce` con codigo 5xx crea suppression entry con reason `hard_bounce`.
- Soft bounces 4xx no agregan suppression.

## Auditoria

Acciones registradas:

- `send_result.ingested`
- `send_result.ingestion_rejected`

La metadata incluye:

- decision de dominio.
- job.
- sender node.
- status.
- suppression entry cuando aplica.
- `smtpEnabled = false`.
- `sideEffects = local-state-only`.

## Efecto en health checks

Los resultados ingresados por mock ingestion son consumidos por:

- `GET /v1/send-results`
- `GET /v1/operational-summary`
- `GET /v1/sender-node-health`
- `POST /v1/sender-node-health/reconcile`
- `GET /v1/admin/overview`

Por ejemplo, una complaint registrada para un sender node hace que health recomiende `quarantined`.

## Archivos principales

- `packages/domain/src/send-result-ingestion.ts`
- `packages/domain/src/send-result-ingestion.test.ts`
- `apps/gateway-api/src/main.ts`

## Verificacion realizada

Comandos:

```bash
node --test packages/domain/src/*.test.ts
node --check apps/gateway-api/src/main.ts
node --check apps/worker/src/main.ts
```

Prueba local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/send-results/ingest \
  -H 'content-type: application/json' \
  -d '{"sendJobId":"sendjob_x","status":"complaint","complaintSource":"mock-fbl","actorId":"operator_local"}'
```

Resultado observado:

- Se ingesto una `complaint` para `sendjob_97756771-2989-473a-89c8-6def9750adfe`.
- Se creo `sendresult_f2de50ce-0899-46da-8d0c-5394d11c5477` con `metadata.ingested = true`.
- Se creo suppression entry para `bounce-result-2@example.com` con reason `complaint`.
- `GET /v1/sender-node-health` recomendo `quarantined` para `sender_results_test_001`.
- Se provo un sender node mismatch y respondio `422`.
- El rechazo queda auditado como `send_result.ingestion_rejected`.

## Siguiente hito recomendado

**Hito 2.15: runbook operativo de Fase 2**

Motivo: ya existen controles, health, kill switch, manual node controls e ingestion mock. Antes de pasar a Fase 3, conviene documentar el procedimiento operativo completo y gates de uso.
