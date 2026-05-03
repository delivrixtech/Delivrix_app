# Hito 5.0: Demo blueprint y revision de patrones

Fecha: 2026-05-03

Propiedad: Delivrix LLC.
Desarrollado por JECT.

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Documento de fase: `FASE_5_MVP_DEMOSTRABLE.md`.
Hito anterior: `HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md`.

## Objetivo

Crear el blueprint inteligente de la demo MVP antes de ejecutar estado local.

Este hito repasa y refuerza los patrones que venimos construyendo para que Delivrix funcione como software inteligente: no adivina, no salta gates, no activa live actions y explica por que puede o no avanzar.

## Cambios implementados

### 1. Dominio demo blueprint

Archivo:

- `packages/domain/src/mvp-demo-blueprint.ts`

Expone:

- `buildDelivrixMvpDemoBlueprint`

El blueprint compone:

- onboarding inteligente;
- topology planner;
- provisioning dry-run;
- scheduler OpenClaw;
- runbook 4.5;
- pipeline de demo Gateway -> Queue -> Worker -> Sender Node -> Result Tracking;
- revision de patrones;
- loop inteligente;
- decision de avance.

### 2. Endpoint Gateway

Endpoint nuevo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/demo/mvp/blueprint \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El endpoint:

- genera blueprint de demo;
- audita `demo.mvp_blueprint_created`;
- no registra sender nodes;
- no encola jobs;
- no llama worker real;
- no envia correo;
- no toca infraestructura;
- no llama NFC.

### 3. Ruta demo

La ruta declarada es:

```txt
Gateway -> Policy -> Queue -> Worker -> Sender Node -> Result Tracking -> Reputation -> Admin/OpenClaw
```

El objetivo es que el siguiente hito pueda ejecutar esta ruta en estado local controlado.

### 4. Revision de patrones

El blueprint revisa estos patrones:

| Patron | Que valida |
| --- | --- |
| `domain-first orchestration` | reglas en dominio antes de Gateway |
| `dry-run before side effects` | planes y decisiones sin efectos live |
| `explicit gates and kill switch` | gates y detencion antes de accion |
| `human-in-the-loop autonomy` | OpenClaw propone, humano aprueba |
| `observability and auditability` | cada paso tiene accion auditable |
| `external bridge isolation` | NFC no bloquea el MVP |
| `input completeness over guessing` | si falta data, se bloquea en vez de inventar |

### 5. Loop inteligente

El hito formaliza el ciclo:

```txt
observe -> decide -> propose -> approve -> act -> verify -> stop
```

En Hito 5.0, `act` significa producir blueprint. No se ejecuta estado local todavia.

## Decision del hito

Estados posibles:

| Estado | Significado |
| --- | --- |
| `ready_for_demo` | el siguiente hito puede ejecutar demo local |
| `needs_review` | hay advertencias o riesgos que revisar |
| `blocked` | falta data critica o un gate esta roto |

Aunque este hito marque `ready_for_demo`, `canSendRealEmail` y `canMutateLiveInfrastructure` siguen en `false`.

## Frontera de responsabilidades

| Pregunta | Respuesta |
| --- | --- |
| Que componente toma la decision? | `buildDelivrixMvpDemoBlueprint` |
| Que componente ejecuta la accion? | Ninguno ejecuta estado local en Hito 5.0 |
| Que datos se comparten? | OpenClaw artifacts, pipeline blueprint, patrones, gates |
| Que queda en dry-run? | todo el blueprint y la revision |
| Que requiere aprobacion humana? | cualquier accion supervisada del siguiente hito |
| Como se audita? | Gateway registra `demo.mvp_blueprint_created` |
| Como se detiene? | kill switch permanece como gate para Hito 5.1 |

## Gates

- Demo end-to-end pero dry-run/control.
- Gateway policy antes de cola.
- Queue antes de worker.
- Worker simula resultado, no envia SMTP.
- Sender node local o mock.
- Result tracking antes de reputacion.
- OpenClaw report antes de afirmar demo lista.
- Runbook y kill switch antes de accion supervisada.
- NFC no es dependencia.

## Criterio de salida

Hito 5.0 queda cerrado si:

- existe dominio `mvp-demo-blueprint`;
- endpoint Gateway expone blueprint;
- se revisan patrones de arquitectura;
- el blueprint bloquea input incompleto;
- se mantiene SMTP, SSH, DNS live, infraestructura live y NFC apagados;
- las pruebas pasan.

## Pruebas

Comando:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Resultado esperado:

- pruebas de dominio y adaptadores pasando.

## Que sigue

Hito 5.1: Demo runner local.

Ese hito debe ejecutar el recorrido local-state-only y enlazar auditoria, job, sender node, resultado simulado y resumen operativo.
