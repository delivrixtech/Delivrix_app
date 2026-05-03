# Hito 5.1: Demo runner local

Fecha: 2026-05-03

Propiedad: Delivrix LLC.
Desarrollado por JECT.

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Documento de fase: `FASE_5_MVP_DEMOSTRABLE.md`.
Hito anterior: `HITO_5_0_DEMO_BLUEPRINT_REVISION_PATRONES.md`.

## Objetivo

Ejecutar la demo MVP en estado local controlado.

Este hito toma el blueprint 5.0 y recorre la ruta:

```txt
Gateway -> Policy -> Queue -> Worker -> Sender Node -> Result Tracking -> Reputation -> Admin/OpenClaw
```

La ejecucion es `local-state-only`. No envia correo real, no abre SMTP, no toca Proxmox, no abre SSH, no cambia DNS y no escribe en NFC.

## Cambios implementados

### 1. Dominio demo runner

Archivo:

- `packages/domain/src/mvp-demo-runner.ts`

Expone:

- `buildDelivrixMvpDemoRunReport`

El reporte enlaza:

- blueprint;
- sender node demo;
- send job;
- send result simulado;
- health/reputation decisions;
- operational summary;
- audit events por `demoRunId`.

### 2. Endpoint Gateway

Endpoint nuevo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/demo/mvp/run \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El endpoint:

- genera blueprint;
- valida kill switch;
- registra sender node demo local;
- valida policy engine;
- valida rate limits;
- encola send request;
- reclama exactamente el job de demo por id;
- asigna sender node;
- consume rate limits de worker;
- registra resultado simulado;
- evalua health/reputation;
- genera operational summary;
- audita cada paso con `demoRunId`.

La decision del runner se calcula sobre el sender node que participo en la demo. El reporte puede mostrar health global para contexto operativo, pero incidentes historicos de otros nodos no contaminan una demo limpia.

### 3. Cola local reforzada

Archivo:

- `packages/queue/src/local-file-send-queue.ts`

Se agrego:

- `claim(jobId)`

Motivo:

- el runner debe reclamar exactamente el job de la demo;
- evita contaminar la evidencia si existieran jobs viejos en cola.

### 4. Worker copy aclarado

El worker ahora declara de forma explicita:

```txt
delivrix_smtp_enabled=false external_bridges=disabled_or_mock
```

Esto evita confundir el MVP con NFC o envio real.

## Decision del hito

Estados posibles:

| Estado | Significado |
| --- | --- |
| `completed` | la demo local-state-only completo el recorrido |
| `needs_review` | la demo completo con incidente simulado o con health no saludable en el sender node usado por la demo |
| `blocked` | falto un artefacto, policy rechazo, kill switch bloqueo o el resultado no fue simulado |

Aunque sea `completed`, el reporte mantiene:

- `canSendRealEmail: false`;
- `canMutateLiveInfrastructure: false`;
- `sideEffects: local-state-only`.

## Frontera de responsabilidades

| Pregunta | Respuesta |
| --- | --- |
| Que componente toma la decision? | `buildDelivrixMvpDemoRunReport` |
| Que componente ejecuta la accion? | Gateway ejecuta solo estado local controlado |
| Que datos se comparten? | blueprint, job, node, result, health, summary y audit ids |
| Que queda en dry-run/local? | todo el recorrido de demo |
| Que requiere aprobacion humana? | cualquier accion fuera de estado local |
| Como se audita? | todos los audit events incluyen `demoRunId` |
| Como se detiene? | kill switch bloquea antes de acciones locales supervisadas |

## Gates

- Blueprint listo antes del runner.
- Kill switch inactivo antes de acciones local-state.
- Policy acepta request antes de cola.
- Sender node registrado antes de worker.
- Worker registra resultado simulado solamente.
- Result tracking antes de health review.
- Audit events enlazados por `demoRunId`.
- SMTP apagado.
- Sin infraestructura live.

## Criterio de salida

Hito 5.1 queda cerrado si:

- existe dominio `mvp-demo-runner`;
- existe endpoint `POST /v1/demo/mvp/run`;
- se registra sender node demo local;
- se encola y procesa job local;
- se registra resultado simulado;
- se evalua health/reputation;
- se genera operational summary;
- la auditoria queda enlazada por `demoRunId`;
- las pruebas pasan.

## Pruebas

Comando:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Resultado esperado:

- pruebas de dominio y adaptadores pasando.
- endpoint `POST /v1/demo/mvp/run` respondiendo con `decision.status: completed` para una demo limpia y `canSendRealEmail: false`.

## Que sigue

Hito 5.2: Demo OpenClaw con incidente simulado.

Ese hito debe usar `bounce`, `complaint`, `deferred` o `failed` para mostrar a OpenClaw detectando riesgo, proponiendo accion y respetando runbook/kill switch.
