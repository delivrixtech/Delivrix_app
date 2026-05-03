# Hito 4.4: OpenClaw scheduler y skills

Fecha: 2026-05-02

Propiedad: Delivrix LLC.
Desarrollado por JECT.

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Documento de fase: `FASE_4_OPENCLAW_INFRAESTRUCTURA.md`.
Hito anterior: `HITO_4_3_PROVISIONING_DRY_RUN.md`.

## Objetivo

Crear el primer loop operativo de OpenClaw para infraestructura propia de mailing autorizado.

Este hito no ejecuta infraestructura real. OpenClaw queda en modo observador: agenda chequeos, ejecuta skills deterministicas, genera reporte diario y propone acciones para revision humana.

## Cambio de foco confirmado

OpenClaw no es un sistema de envio de emails en este MVP.

OpenClaw es el operador tecnico asistido por IA para:

- leer onboarding;
- analizar servidor fisico, Proxmox, IPs, dominios y DNS;
- usar topology planner;
- usar provisioning dry-run;
- observar riesgos;
- preparar reportes;
- proponer acciones;
- esperar aprobacion humana antes de cualquier accion real.

NFC u otros sistemas externos quedan como bridge/API futuro, apagado o mock. No bloquean este hito.

## Cambios implementados

### 1. Dominio scheduler

Archivo:

- `packages/domain/src/openclaw-scheduler.ts`

Expone:

- `runOpenClawScheduler`

El scheduler:

- acepta `provisioningPlan` existente o `provisioningInput`;
- puede generar un provisioning dry-run internamente si recibe input;
- queda bloqueado si no tiene provisioning dry-run;
- corre en `dryRun: true`;
- registra `sideEffects: none`;
- nunca llama LLM externo por defecto;
- nunca abre SSH;
- nunca toca Proxmox real;
- nunca cambia DNS real;
- nunca activa Postfix/SMTP;
- nunca escribe en NFC.

### 2. Tareas agendadas

El loop inicial define cuatro tareas:

| Tarea | Cadencia | Skill | Proposito |
| --- | --- | --- | --- |
| `health-check` | cada 5 minutos | `alert-ops` | revisar kill switch, estados, bloqueos y alertas |
| `fleet-analysis` | cada 15 minutos | `fleet-ops` | analizar flota planificada, capacidad y nodos |
| `ip-reputation-check` | cada 6 horas | `alert-ops` | revisar reputacion, PTR, warming y riesgos |
| `daily-report` | diario | `report-ops` | producir reporte diario para el operador |

En esta version las tareas son simuladas y auditables. No crean un daemon real ni mutan infraestructura.

### 3. Skills iniciales

#### `fleet-ops`

Lee provisioning dry-run y resume:

- cluster;
- nodos planificados;
- capacidad inicial estimada;
- DNS planificado;
- estado de seguridad.

Propone revisar la flota y preparar payloads locales en dry-run.

#### `alert-ops`

Lee riesgos del provisioning dry-run y produce:

- conteo de riesgos;
- mayor severidad;
- acciones propuestas para revision humana;
- bloqueo de live actions.

Si existen riesgos `high` o `critical`, el scheduler queda en `needs_review`.

#### `report-ops`

Genera reporte diario con:

- resumen ejecutivo;
- estado de flota;
- conteo de alertas;
- proximos pasos;
- bandera `humanReviewRequired`.

### 4. LLM router

El router existe con dos modos:

```txt
disabled # default del MVP
mock     # pruebas locales de contrato
```

En `disabled`, OpenClaw usa reglas deterministicas.

En `mock`, se valida el contrato sin llamar modelos externos.

No hay llamadas LLM reales, no hay presupuesto consumido y no hay decisiones autonomas con impacto productivo.

### 5. Gateway API

Endpoint nuevo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/scheduler/run \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

Con provisioning input corto para validar contrato. Si faltan datos criticos, el scheduler respondera `blocked` y explicara que debe completarse el dry-run:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/scheduler/run \
  -H 'content-type: application/json' \
  -d '{
    "actorId": "operator_local",
    "llmMode": "disabled",
    "provisioningInput": {
      "topologyInput": {
        "clusterName": "delivrix-pilot",
        "onboarding": {
          "server": { "model": "IBM System x3630 M4" }
        }
      }
    }
  }'
```

El endpoint:

- ejecuta el scheduler en modo simulado;
- audita `openclaw_scheduler.run_simulated`;
- devuelve tareas, skills, reporte diario, acciones propuestas y gates;
- mantiene live actions apagadas.

## Respuesta operativa

El scheduler devuelve:

- `phase`: `4.4-openclaw-scheduler-and-skills`;
- `llmRouter`;
- `tasks`;
- `skills`;
- `dailyReport`;
- `proposedActions`;
- `decision`;
- `gates`;
- `requiredApprovals`;
- `blockedActions`;
- `safety`.

Estados posibles:

| Estado | Significado |
| --- | --- |
| `report_ready` | OpenClaw genero reporte diario y puede pasar a revisar Hito 4.5 |
| `needs_review` | hay riesgos o plan que requieren revision humana |
| `blocked` | falta provisioning dry-run o existe un bloqueo critico |

## Frontera de responsabilidades

| Pregunta | Respuesta |
| --- | --- |
| Que componente toma la decision? | `runOpenClawScheduler` calcula decision de observacion |
| Que componente ejecuta la accion? | Ninguno ejecuta acciones reales en Hito 4.4 |
| Que datos se comparten? | provisioning dry-run, riesgos, tareas, skills y reporte |
| Que queda en dry-run? | todo el scheduler, todas las skills y todas las acciones propuestas |
| Que requiere aprobacion humana? | cualquier accion live, riesgo alto, cambio de capacidad o paso a 4.5 |
| Como se audita? | Gateway registra `openclaw_scheduler.run_simulated` |
| Como se detiene? | kill switch sigue siendo gate obligatorio antes de ejecucion limitada |

## Gates

- OpenClaw primero observa, reporta y propone.
- Las skills solo pueden leer, reportar y proponer.
- LLM debe tener fallback sin LLM.
- Reporte diario antes de ejecucion real.
- Aprobacion humana antes de cualquier accion live.
- Kill switch requerido antes de pasar a ejecucion limitada.
- Bridge externo no es dependencia.

## Criterio de salida

Hito 4.4 queda cerrado si:

- existe scheduler de dominio;
- existen skills `fleet-ops`, `alert-ops`, `report-ops`;
- existe LLM router con modo sin LLM;
- se genera reporte diario;
- el Gateway expone endpoint auditado;
- el norte operativo declara fase 4.4;
- ninguna prueba permite SSH, Proxmox live, DNS live, SMTP real o NFC production writes.

## Pruebas

Comando:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Resultado esperado al cierre del hito:

- pruebas de dominio y adaptadores pasando.

## Que queda para Hito 4.5

- Runbook operativo.
- Matriz de permisos.
- Lista de acciones permitidas, supervisadas y prohibidas.
- Kill switch probado contra acciones del scheduler.
- Checklist para produccion limitada.
