# Fase 2: Hito 2.7 Metricas basicas

Fecha: 2026-05-02

## Objetivo

Agregar visibilidad operativa antes de conectar Webdock real o SMTP.

Este hito permite responder preguntas basicas:

- Cuantos jobs hay por estado.
- Que campanas generan mas actividad.
- Que sender nodes estan asignados.
- Que dominios remitentes y destinatarios aparecen.
- Que acciones se estan auditando.
- Que contadores de rate limit estan activos.

## Implementacion

Se agrego `buildOperationalSummary` en dominio.

Endpoint nuevo:

- `GET /v1/operational-summary`

El endpoint agrega datos desde:

- `send-jobs`.
- `audit-events`.
- `sender-nodes`.
- `rate-limit-counters`.

## Campos principales

- `totals.jobs`
- `totals.auditEvents`
- `totals.senderNodes`
- `jobsByStatus`
- `senderNodesByStatus`
- `jobsByCampaign`
- `jobsBySenderNode`
- `jobsBySenderDomain`
- `jobsByRecipientDomain`
- `auditActions`
- `rateLimitCounters`

## Verificacion realizada

Se consulto:

```bash
curl -s http://127.0.0.1:3000/v1/operational-summary
```

Resultado observado:

- 5 jobs totales.
- 3 completados.
- 1 bloqueado.
- 1 en processing heredado de una prueba interrumpida.
- 4 sender nodes.
- 1 contador de rate limit activo.

## Nota tecnica

El estado `processing` heredado demuestra que necesitamos un hito posterior para recuperacion de jobs atascados. Eso debe resolverse antes de cualquier worker real concurrente.

Hito sugerido futuro: `2.x stuck job recovery`.

## Siguiente hito recomendado

**Hito 2.8: registro de resultados simulado**

Estados esperados:

- `sent`
- `bounce`
- `complaint`
- `deferred`
- `failed`

Todavia sin SMTP real.
