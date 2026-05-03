# Delivrix MailOps Platform

Base tecnica inicial para el control plane de mailing autorizado de Delivrix: infraestructura, reputacion, compliance, auditoria, sender nodes, onboarding inteligente con OpenClaw e integraciones futuras opcionales.

## Propiedad intelectual

Copyright (c) 2026 Delivrix LLC. Todos los derechos reservados.  
Desarrollado por JECT.

Ver `NOTICE.md`.

La arquitectura nace con tres reglas:

1. Ningun envio entra a cola sin pasar por el `mail-policy-engine`.
2. Toda decision queda registrada en `audit-log`.
3. La plataforma local no envia correo real; valida, audita, simula y gobierna capacidad de forma controlada.

Norte operativo: ver `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md`.
Estandares de ingenieria: ver `DOCUMENTACION/ESTANDARES_INGENIERIA.md`.
Runbook operativo Fase 2: ver `DOCUMENTACION/FASE_2_RUNBOOK_OPERATIVO.md`.
Runbook Fase 3: ver `DOCUMENTACION/FASE_3_INFRAESTRUCTURA_PROPIA.md`.
Documento Fase 4/OpenClaw infraestructura: ver `DOCUMENTACION/FASE_4_OPENCLAW_INFRAESTRUCTURA.md`.
Hito 4.0/alineacion control plane: ver `DOCUMENTACION/HITO_4_0_ALINEACION_CONTROL_PLANE.md`.
Hito 4.1/OpenClaw onboarding: ver `DOCUMENTACION/HITO_4_1_OPENCLAW_ONBOARDING.md`.
Hito 4.2/topology planner: ver `DOCUMENTACION/HITO_4_2_CLUSTER_TOPOLOGY_PLANNER.md`.
Hito 4.3/provisioning dry-run: ver `DOCUMENTACION/HITO_4_3_PROVISIONING_DRY_RUN.md`.
Hito 4.4/OpenClaw scheduler y skills: ver `DOCUMENTACION/HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md`.
Hito 4.5/runbook, permisos y kill switch: ver `DOCUMENTACION/HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md`.
Fase 5/MVP demostrable: ver `DOCUMENTACION/FASE_5_MVP_DEMOSTRABLE.md`.
Hito 5.0/demo blueprint y revision de patrones: ver `DOCUMENTACION/HITO_5_0_DEMO_BLUEPRINT_REVISION_PATRONES.md`.
Hito 5.1/demo runner local: ver `DOCUMENTACION/HITO_5_1_DEMO_RUNNER_LOCAL.md`.
Hito 5.2/OpenClaw incidente simulado: ver `DOCUMENTACION/HITO_5_2_OPENCLAW_INCIDENTE_SIMULADO.md`.

## Estructura

- `apps/gateway-api`: API HTTP minima para recibir solicitudes.
- `apps/worker`: worker seguro de Fase 1, sin SMTP real.
- `packages/domain`: contratos, politicas, auditoria, suppression list y modelos.
- `packages/adapters`: adaptadores externos en modo seguro.
- `DOCUMENTACION`: tesis, roadmap y arquitectura del proyecto.

## Comandos

```bash
node --test packages/domain/src/mail-policy.engine.test.ts
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
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
- `runtime/provisioning-runs.json`
- `runtime/ip-reputation-reports.json`
- `runtime/backup-simulations.json`

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

## Mock ingestion de resultados externos

Endpoint local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/send-results/ingest \
  -H 'content-type: application/json' \
  -d '{"sendJobId":"sendjob_x","status":"complaint","complaintSource":"mock-fbl","actorId":"operator_local"}'
```

Registra `bounce`, `complaint`, `deferred` o `failed` como eventos externos simulados. Las complaints y hard bounces agregan suppression entries locales.

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

## Proxmox mock y Fase 3

Endpoints locales:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/proxmox/provisioning-plan \
  -H 'content-type: application/json' \
  -d '{"id":"sender_proxmox_001","label":"Proxmox Sender 001"}'

curl -s -X POST http://127.0.0.1:3000/v1/proxmox/provisioning-runs/simulate \
  -H 'content-type: application/json' \
  -d '{"node":{"id":"sender_proxmox_001","label":"Proxmox Sender 001"},"registerSenderNode":true}'

curl -s http://127.0.0.1:3000/v1/admin/phase-3-overview
```

El adapter Proxmox actual es mock: no usa API real, SSH, Postfix, OpenDKIM, DNS, SMTP ni S3. Sirve para validar provisioning, reputacion IP, cuarentena local, acciones humanas y backups simulados.

## Hito 4.0: norte operativo e integraciones opcionales

Endpoints locales:

```bash
curl -s http://127.0.0.1:3000/v1/operating-north

curl -s -X POST http://127.0.0.1:3000/v1/nfc/bridge/capacity-plan \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El bridge externo mock queda como referencia futura para NFC: solo genera payloads dry-run e inactivos para `email_providers` y `smtp_servers`. No escribe en NFC, no guarda secretos, no activa providers y no envia correo. El MVP se enfoca en OpenClaw, onboarding inteligente y preparacion de infraestructura propia.

## Hito 4.1: OpenClaw intelligent onboarding

Endpoints locales:

```bash
curl -s http://127.0.0.1:3000/v1/openclaw/onboarding/questionnaire

curl -s -X POST http://127.0.0.1:3000/v1/openclaw/onboarding/evaluate \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local","server":{"model":"IBM System x3630 M4"}}'
```

La evaluacion genera un snapshot dry-run con decision `go`, `needs_review` o `no_go`. No toca Proxmox, SSH, DNS, SMTP, NFC ni infraestructura real.

## Hito 4.2: Cluster topology planner

Endpoint local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/topology/plan \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local","onboarding":{"server":{"model":"IBM System x3630 M4"}}}'
```

El planner convierte onboarding en un plan de clusters/VPS/LXC cuando los gates lo permiten. Si el onboarding esta incompleto, responde `blocked`. Si genera plan, sigue siendo dry-run: no toca Proxmox, SSH, DNS, SMTP, NFC ni infraestructura real.

## Hito 4.3: Provisioning dry-run executor

Endpoint local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/provisioning/dry-run \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local","topologyInput":{"onboarding":{"server":{"model":"IBM System x3630 M4"}}}}'
```

El executor convierte topology plan en planes Proxmox, Postfix, OpenDKIM, TLS, DNS y warming. Si el topology plan esta bloqueado, responde `blocked`. Si genera planes, siguen siendo dry-run y no ejecutan acciones reales.

## Hito 4.4: OpenClaw scheduler y skills

Endpoint local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/scheduler/run \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El scheduler ejecuta un ciclo observador con tareas `health-check`, `fleet-analysis`, `ip-reputation-check` y `daily-report`. Corre skills `fleet-ops`, `alert-ops` y `report-ops`, usa router LLM en modo `disabled` por defecto y genera reporte diario. No ejecuta SSH, Proxmox live, DNS live, SMTP real ni escrituras NFC.

## Hito 4.5: Runbook, permisos y kill switch

Endpoint local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/runbook/evaluate \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El runbook define la matriz de permisos de OpenClaw, acciones permitidas, acciones supervisadas, acciones futuras bloqueadas y acciones prohibidas. Tambien prueba que el kill switch bloquea acciones OpenClaw, acciones locales supervisadas, live infrastructure y procesamiento de cola. La produccion limitada sigue apagada.

## Hito 5.0: Demo blueprint y revision de patrones

Endpoint local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/demo/mvp/blueprint \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El blueprint compone onboarding, topology planner, provisioning dry-run, scheduler, runbook y la ruta Gateway -> Policy -> Queue -> Worker -> Sender Node -> Result Tracking -> Reputation -> Admin/OpenClaw. Tambien revisa patrones de arquitectura para reforzar que el software avance de forma inteligente, auditable y sin adivinar datos faltantes.

## Hito 5.1: Demo runner local

Endpoint local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/demo/mvp/run \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El runner ejecuta la demo en estado local: registra sender node demo, valida policy/rate limits, encola job, reclama el job por id, asigna sender node, registra resultado simulado, evalua health/reputation y genera operational summary. La decision del demo se basa en el sender node usado por esa ejecucion, aunque el reporte mantenga contexto global. Todos los eventos quedan enlazados por `demoRunId`. SMTP, SSH, DNS live, Proxmox live y NFC siguen apagados.

## Hito 5.2: OpenClaw incidente simulado

Endpoint local:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/demo/openclaw/incident \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local","incidentStatus":"complaint"}'
```

OpenClaw ejecuta la demo de incidente con `alert-ops`: detecta una `complaint`, propone cuarentena local, prueba que sin humano no actua, prueba que el kill switch activo bloquea y aplica solo estado local si existe aprobacion humana. SMTP, SSH, DNS live, Proxmox live y NFC siguen apagados.
