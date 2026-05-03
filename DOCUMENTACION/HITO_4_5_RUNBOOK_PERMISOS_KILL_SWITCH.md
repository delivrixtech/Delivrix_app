# Hito 4.5: Runbook, permisos y kill switch

Fecha: 2026-05-03

Propiedad: Delivrix LLC.
Desarrollado por JECT.

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Documento de fase: `FASE_4_OPENCLAW_INFRAESTRUCTURA.md`.
Hito anterior: `HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md`.

## Objetivo

Cerrar Fase 4 con reglas operativas claras antes de cualquier ejecucion limitada.

Este hito no habilita produccion limitada. Define el runbook, la matriz de permisos, el checklist y la prueba de kill switch para que la fase siguiente pueda demostrarse sin ambiguedad.

## Regla principal

OpenClaw puede leer, analizar, reportar y proponer.

OpenClaw no puede ejecutar acciones reales de infraestructura, DNS, SSH, SMTP, volumen o NFC en Hito 4.5.

## Cambios implementados

### 1. Dominio runbook

Archivo:

- `packages/domain/src/openclaw-runbook.ts`

Expone:

- `buildOpenClawOperationalRunbook`
- `evaluateOpenClawActionPermission`

El dominio genera:

- matriz de permisos;
- runbook operativo;
- checklist de produccion limitada;
- prueba de kill switch;
- decisiones de ejemplo;
- gates y acciones bloqueadas.

### 2. Matriz de permisos

La matriz clasifica acciones en cinco categorias:

| Categoria | Significado |
| --- | --- |
| `allowed_read_only` | lectura, diagnostico, reporte y observacion |
| `allowed_dry_run` | planes y payloads sin efectos externos |
| `supervised_local_state` | cambios locales con aprobacion humana y kill switch inactivo |
| `future_live_requires_new_phase` | live actions bloqueadas hasta una fase futura |
| `prohibited` | acciones que el MVP no debe permitir |

Ejemplos:

| Accion | Categoria | Estado |
| --- | --- | --- |
| `run_scheduler_observer` | `allowed_read_only` | permitida |
| `build_provisioning_dry_run` | `allowed_dry_run` | permitida |
| `register_local_sender_node` | `supervised_local_state` | requiere aprobacion humana y kill switch inactivo |
| `proxmox_live_create` | `future_live_requires_new_phase` | bloqueada en Hito 4.5 |
| `smtp_send` | `prohibited` | prohibida en el MVP |
| `nfc_production_write` | `prohibited` | prohibida en el MVP |

### 3. Evaluacion de acciones

`evaluateOpenClawActionPermission` decide si una accion puede ejecutarse segun:

- categoria;
- modo solicitado;
- aprobacion humana;
- estado del kill switch;
- fase actual.

Reglas:

- read-only y dry-run se permiten dentro del control plane;
- acciones locales supervisadas requieren aprobacion humana;
- acciones locales supervisadas requieren kill switch inactivo;
- acciones live siguen bloqueadas en Hito 4.5;
- acciones prohibidas siguen bloqueadas aunque exista aprobacion humana.

### 4. Kill switch probado

El runbook genera una prueba simulada con kill switch activo y verifica que bloquee:

- acciones propuestas por OpenClaw;
- acciones locales supervisadas;
- acciones live de infraestructura;
- procesamiento de cola.

Tambien se extendio el contrato de `kill-switch.ts` para cubrir operaciones OpenClaw:

- `execute_openclaw_proposed_action`;
- `apply_supervised_local_action`;
- `apply_live_infrastructure_action`.

### 5. Gateway API

Endpoint nuevo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/runbook/evaluate \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El endpoint:

- lee el kill switch local actual;
- genera el runbook 4.5;
- audita `openclaw_runbook.evaluated`;
- devuelve matriz, checklist, prueba de kill switch y decision;
- no ejecuta acciones reales.

## Runbook operativo

### Paso 1: revisar reporte diario

Owner: operador.

Permitido:

- leer norte operativo;
- generar reporte diario;
- correr scheduler observador.

Detener si:

- el reporte esta bloqueado;
- existe riesgo alto sin resolver;
- el kill switch esta activo para acciones supervisadas.

### Paso 2: aprobar cambios locales supervisados

Owner: operador.

Permitido con aprobacion:

- registrar sender node local;
- pausar sender node local;
- degradar sender node local;
- cuarentenar sender node local.

Detener si:

- falta aprobacion explicita;
- falta razon;
- kill switch esta activo.

### Paso 3: validar kill switch antes de cualquier accion

Owner: sistema.

Permitido:

- simular provisioning;
- revisar permisos;
- auditar decision.

Detener si:

- kill switch esta activo o no disponible.

### Paso 4: escalar live infrastructure futura

Owner: operador.

Acciones como SSH real, Proxmox live, DNS live, Postfix live, SMTP real y NFC production write quedan siempre bloqueadas en Hito 4.5.

## Checklist de produccion limitada

El checklist incluye:

- matriz de permisos definida;
- auditoria obligatoria;
- aprobacion humana obligatoria;
- kill switch probado;
- reporte scheduler revisado;
- live actions bloqueadas;
- NFC fuera del camino critico;
- produccion limitada no habilitada todavia.

## Frontera de responsabilidades

| Pregunta | Respuesta |
| --- | --- |
| Que componente toma la decision? | `evaluateOpenClawActionPermission` y `buildOpenClawOperationalRunbook` |
| Que componente ejecuta la accion? | Ninguno ejecuta live actions en Hito 4.5 |
| Que datos se comparten? | kill switch, scheduler report opcional, matriz, checklist y gates |
| Que queda en dry-run? | runbook, permisos, prueba de kill switch y checklist |
| Que requiere aprobacion humana? | acciones locales supervisadas y cualquier paso futuro live |
| Como se audita? | Gateway registra `openclaw_runbook.evaluated` |
| Como se detiene? | kill switch bloquea acciones supervisadas, live actions y procesamiento |

## Decision del hito

Estados posibles:

| Estado | Significado |
| --- | --- |
| `ready_for_phase_5_demo` | Fase 4 queda cerrada para demo, no para produccion limitada |
| `needs_review` | falta revisar reporte scheduler o checklist |
| `blocked` | fallo la prueba de kill switch o un gate obligatorio |

Aunque el estado sea `ready_for_phase_5_demo`, `canStartLimitedProduction` permanece en `false`.

## Gates

- Matriz de permisos antes de ejecucion limitada.
- Aprobacion humana antes de cambios locales supervisados.
- Kill switch debe bloquear acciones supervisadas y live.
- Auditoria para cada accion humana o OpenClaw.
- Reporte diario antes de ejecucion real.
- No live infrastructure en Hito 4.5.
- No envio real desde Delivrix.
- Bridge externo no es dependencia.

## Criterio de salida

Hito 4.5 queda cerrado si:

- existe matriz de permisos;
- existen acciones permitidas, supervisadas, futuras y prohibidas;
- kill switch bloquea operaciones OpenClaw y cola;
- existe endpoint auditado;
- la documentacion deja claro que no hay produccion limitada todavia;
- las pruebas automatizadas pasan.

## Pruebas

Comando:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Resultado esperado:

- pruebas de dominio y adaptadores pasando.

## Que sigue

Fase 5: demo end-to-end.

La demo debe mostrar Delivrix gobernando capacidad preparada en dry-run/control, con OpenClaw reportando y proponiendo bajo permisos, auditoria y kill switch.
