# Fase 2: Hito 2.11 Stuck job recovery

Fecha: 2026-05-02

## Objetivo

Agregar una politica operativa para detectar y recuperar jobs que quedan en `processing` despues de una interrupcion del worker, reinicio local o fallo controlado.

Este hito no envia correo real, no abre SMTP, no toca Webdock y no modifica infraestructura externa.

## Regla implementada

Un job se considera atascado cuando:

- `status = processing`.
- `processingStartedAt` o, para jobs antiguos, `createdAt` supera el umbral configurado.

Umbral por defecto:

```bash
STUCK_JOB_THRESHOLD_MS=300000
```

Equivale a 5 minutos.

## Endpoints

Listar jobs atascados:

```bash
GET /v1/stuck-jobs
GET /v1/stuck-jobs?staleAfterMs=300000
```

Recuperar jobs atascados:

```bash
POST /v1/stuck-jobs/recover
```

Payload recomendado:

```json
{
  "action": "fail"
}
```

Acciones soportadas:

- `fail`: marca el job como `failed`, registra `failureReason`, `completedAt`, `recoveredAt` y `recoveryReason`.
- `requeue`: devuelve el job a `queued`, limpia asignacion de sender node y permite reprocesarlo de forma controlada.

La accion por defecto es `fail` porque es la opcion mas segura para evitar reintentos automaticos no deseados.

## Auditoria

Cada recuperacion registra:

- `action = send_jobs.stuck_recovered`
- `targetType = send_job`
- `riskLevel = medium` cuando recupera al menos un job.
- `metadata` con accion, umbral, cantidad detectada y jobs recuperados.

## Archivos principales

- `packages/domain/src/stuck-job-recovery.ts`
- `packages/queue/src/local-file-send-queue.ts`
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
curl -s http://127.0.0.1:3000/v1/stuck-jobs
curl -s -X POST http://127.0.0.1:3000/v1/stuck-jobs/recover \
  -H 'content-type: application/json' \
  -d '{"action":"fail"}'
```

Resultado observado:

- `/v1/stuck-jobs` detecto 1 job viejo en `processing`.
- `POST /v1/stuck-jobs/recover` con `action = fail` recupero el job `sendjob_11ce89f8-6bbd-4ee6-a995-72cfea02cb51`.
- Despues de recuperar, `/v1/stuck-jobs` quedo en `count = 0`.
- `/v1/admin/overview` paso de `processing = 1` a `processing = 0`.
- Se registro auditoria `send_jobs.stuck_recovered`.

## Siguiente hito recomendado

**Hito 2.12: kill switch operativo local**

Motivo: antes de aumentar automatizacion o workers concurrentes, necesitamos una palanca global auditable para pausar procesamiento.
