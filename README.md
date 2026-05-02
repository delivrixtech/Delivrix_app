# Delivrix MailOps Platform

Base tecnica inicial para la plataforma propia de mailing autorizado de Delivrix.

## Propiedad intelectual

Copyright (c) 2026 Delivrix LLC. Todos los derechos reservados.  
Desarrollado por JECT.

Ver `NOTICE.md`.

La arquitectura nace con tres reglas:

1. Ningun envio entra a cola sin pasar por el `mail-policy-engine`.
2. Toda decision queda registrada en `audit-log`.
3. La Fase 1 no envia correo real; valida, audita y encola de forma controlada.

Estandares de ingenieria: ver `DOCUMENTACION/ESTANDARES_INGENIERIA.md`.

## Estructura

- `apps/gateway-api`: API HTTP minima para recibir solicitudes.
- `apps/worker`: worker seguro de Fase 1, sin SMTP real.
- `packages/domain`: contratos, politicas, auditoria, suppression list y modelos.
- `packages/adapters`: adaptadores externos en modo seguro.
- `DOCUMENTACION`: tesis, roadmap y arquitectura del proyecto.

## Comandos

```bash
node --test packages/domain/src/mail-policy.engine.test.ts
node --test packages/domain/src/*.test.ts
node apps/gateway-api/src/main.ts
node apps/worker/src/main.ts
```

La migracion a NestJS, PostgreSQL, Redis/BullMQ y adaptadores reales queda preparada como siguiente incremento.

En esta base, el Gateway usa una cola local compartida en `runtime/send-jobs.json`. Es un adaptador de desarrollo para validar el contrato que luego se reemplaza por BullMQ.

Tambien usa almacenamiento local para auditoria y suppression list:

- `runtime/audit-events.json`
- `runtime/suppression-entries.json`
- `runtime/sender-nodes.json`
- `runtime/rate-limit-counters.json`
- `runtime/send-results.json`
- `runtime/kill-switch.json`

## Infraestructura local preparada

La base de datos y Redis quedan definidos en `infra/docker-compose.yml`.

```bash
docker compose -f infra/docker-compose.yml up -d
```

Migraciones iniciales:

- `infra/postgres/migrations/001_initial_schema.sql`
- `infra/postgres/migrations/002_seed_development.sql`

## Webdock bridge seguro

Ejemplo de nodos puente:

- `config/webdock.nodes.example.json`

Endpoint de seed local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/webdock/bridge-nodes/seed \
  -H 'content-type: application/json' \
  -d '{"nodes":[]}'
```

El adaptador Webdock actual no toca servidores reales. Solo registra nodos para dry-run.

## Rate limits

El Gateway y Worker ya aplican limites diarios en modo local:

- campana.
- dominio remitente.
- dominio destinatario.
- sender node.

Contadores locales:

- `runtime/rate-limit-counters.json`

## Operational summary

Endpoint local:

```bash
curl -s http://127.0.0.1:3000/v1/operational-summary
```

Resume jobs, sender nodes, dominios, campanas, acciones auditadas y contadores de rate limit.

## Send results simulados

Endpoint local:

```bash
curl -s http://127.0.0.1:3000/v1/send-results
```

El Worker genera resultados simulados usando `metadata.simulatedResult` o patrones en el email del destinatario.

## Sender node health

Endpoints locales:

```bash
curl -s http://127.0.0.1:3000/v1/sender-node-health
curl -s -X POST http://127.0.0.1:3000/v1/sender-node-health/reconcile
```

`reconcile` aplica cambios locales auditados como `degraded` o `quarantined`; no toca infraestructura real.

## Sender node manual controls

Endpoints locales:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sender-nodes/sender_webdock_bridge_001/pause \
  -H 'content-type: application/json' \
  -d '{"reason":"Provider maintenance","actorId":"operator_local"}'
```

Acciones disponibles: `pause`, `reactivate`, `degrade`, `quarantine`. Todas requieren `reason` y quedan auditadas. No ejecutan SSH, SMTP ni cambios reales en Webdock.

## Admin overview

Endpoint local:

```bash
curl -s http://127.0.0.1:3000/v1/admin/overview
```

Consolida summary, health, alertas operativas y auditoria reciente para el futuro panel admin.

## Stuck job recovery

Endpoints locales:

```bash
curl -s http://127.0.0.1:3000/v1/stuck-jobs
curl -s -X POST http://127.0.0.1:3000/v1/stuck-jobs/recover \
  -H 'content-type: application/json' \
  -d '{"action":"fail"}'
```

Detecta jobs que quedaron en `processing` mas tiempo que `STUCK_JOB_THRESHOLD_MS` y permite recuperarlos con auditoria. No envia correo ni reintenta infraestructura real.

## Kill switch operativo

Endpoints locales:

```bash
curl -s http://127.0.0.1:3000/v1/kill-switch
curl -s -X POST http://127.0.0.1:3000/v1/kill-switch \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"reason":"Manual incident response","actorId":"operator_local"}'
```

Cuando esta activo, el Gateway no encola nuevas solicitudes y el Worker no reclama jobs. Cada cambio y bloqueo queda auditado.
