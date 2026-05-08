# Hito 5.6: Contratos canvas, hardware, ML y DevOps

Fecha: 2026-05-08

Documentos rectores:

- `NORTE_OPERATIVO_DELIVRIX.md`
- `ESTANDARES_INGENIERIA.md`
- `HITO_5_5_AUDITORIA_FRONTEND_UI_PROCESOS.md`
- `HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md`

## Objetivo

Disenar los contratos read-only que permiten que Delivrix funcione como consola inteligente: frontend visual, backend de dominio, OpenClaw/ML y DevOps observability trabajando sobre la misma verdad.

El objetivo no es solo exponer datos. Es crear contratos que permitan:

- renderizar un canvas vivo;
- entender el estado real del servidor fisico;
- medir capacidad y riesgo;
- explicar decisiones de OpenClaw;
- alimentar evaluaciones ML supervisadas;
- habilitar telemetria DevOps sin acciones live;
- mantener el frontend libre de reglas de dominio.

## Regla principal

Hito 5.6 es `GET-only`.

No habilita:

- SSH automatico;
- Proxmox live mutation;
- DNS live changes;
- SMTP real;
- escritura en NFC;
- auto-entrenamiento;
- acciones autonomas.

Todo contrato debe poder mostrar `unknown`, `stale`, `mock`, `blocked` o `needs_review` sin inventar datos.

## Responsabilidades por disciplina

### Full stack/backend

- Define DTOs versionados.
- Construye snapshots desde dominio, stores y adaptadores.
- Normaliza estados y errores.
- Expone endpoints `GET`.
- Garantiza que no salen secretos.
- Mantiene tests de contratos.

### Frontend

- Consume contratos.
- Renderiza canvas, tablas, timeline y drill-down.
- No calcula readiness ni permisos.
- No lee hardware ni runtime directo.
- No ejecuta comandos.
- Muestra calidad/frescura del dato.

### Machine learning/OpenClaw

- Produce recomendaciones explicables.
- Usa evidencia curada y features sanitizadas.
- Reporta confianza, cobertura y razonamiento.
- No se auto-promueve.
- No entrena con secretos, PII innecesaria ni comandos sensibles.

### DevOps/observability

- Define como se recolecta hardware telemetry.
- Separa mock/local/supervised/live-read-only.
- Expone freshness, source, collector status y errores.
- Usa permisos minimos.
- Audita snapshots y cambios de fuente.

## Principios de contrato

Todo contrato read-only debe incluir:

```json
{
  "schemaVersion": "2026-05-08.v1",
  "generatedAt": "2026-05-08T00:00:00.000Z",
  "mode": "read_only",
  "source": {
    "kind": "mock | local | collector | proxmox | ipmi | prometheus",
    "trusted": false,
    "freshness": "fresh | stale | unknown",
    "collectedAt": null
  },
  "quality": {
    "completeness": 0,
    "confidence": 0,
    "unknownFields": []
  },
  "safety": {
    "liveInfrastructureWritesEnabled": false,
    "sshEnabled": false,
    "smtpEnabled": false,
    "nfcWritesEnabled": false
  }
}
```

Campos obligatorios:

- `schemaVersion`;
- `generatedAt`;
- `mode`;
- `source`;
- `quality`;
- `safety`.

## Endpoints Hito 5.6

```txt
GET /v1/hardware/physical-host
GET /v1/hardware/telemetry/latest
GET /v1/hardware/telemetry/history
GET /v1/openclaw/live-canvas
GET /v1/openclaw/onboarding/state
GET /v1/openclaw/provisioning/state
GET /v1/openclaw/readiness-signals
GET /v1/devops/collector/status
```

Todos deben estar disponibles primero con datos mock/local seguros.

## Estado de implementacion

Implementado en codigo:

- contratos base con `schemaVersion`, `generatedAt`, `mode`, `source`, `quality` y `safety`;
- builders puros para physical host, telemetry latest/history, live canvas, onboarding state, provisioning state, readiness signals y collector status;
- endpoints `GET` en Gateway para los ocho contratos del hito;
- proxy read-only del admin panel actualizado para permitir solo esos endpoints;
- pruebas de dominio que validan estados `unknown/stale/mock`, seguridad apagada, ausencia de self-promotion ML y canvas sin acciones live.

Estado operacional:

- modo actual: `mock/read_only`;
- sin SSH automatico;
- sin Proxmox live mutation;
- sin DNS live changes;
- sin SMTP real;
- sin escrituras NFC;
- sin auto-entrenamiento.

## Contrato: physical host

`GET /v1/hardware/physical-host`

Proposito: describir el servidor fisico y su capacidad base.

```json
{
  "physicalHost": {
    "schemaVersion": "2026-05-08.v1",
    "generatedAt": "2026-05-08T00:00:00.000Z",
    "mode": "read_only",
    "identity": {
      "hostId": "physical_host_primary",
      "label": "Servidor fisico primario",
      "vendor": "IBM/Lenovo",
      "model": "unknown",
      "serialNumber": "redacted_or_unknown",
      "location": "Popayan",
      "operatingSystem": "unknown",
      "kernelVersion": "unknown",
      "proxmoxVersion": "unknown",
      "uptimeSeconds": null
    },
    "capacity": {
      "cpuCores": null,
      "cpuThreads": null,
      "memoryGb": null,
      "storageUsableGb": null,
      "networkInterfaces": 0,
      "ipPoolSize": null
    },
    "readiness": {
      "status": "unknown",
      "blockers": [],
      "warnings": [],
      "requiredHumanInputs": []
    },
    "source": {},
    "quality": {},
    "safety": {}
  }
}
```

Frontend esperado:

- card de identidad;
- capacidad base;
- readiness;
- campos `unknown` visibles sin alarmismo falso.

## Contrato: telemetry latest

`GET /v1/hardware/telemetry/latest`

Proposito: mostrar salud actual del hardware.

```json
{
  "telemetry": {
    "schemaVersion": "2026-05-08.v1",
    "generatedAt": "2026-05-08T00:00:00.000Z",
    "mode": "read_only",
    "summary": {
      "status": "unknown",
      "riskLevel": "unknown",
      "stale": true
    },
    "cpu": {
      "usagePercent": null,
      "loadAverage": [],
      "temperatureCelsius": null,
      "thermalStatus": "unknown"
    },
    "memory": {
      "totalGb": null,
      "usedGb": null,
      "availableGb": null,
      "usagePercent": null,
      "swapUsagePercent": null
    },
    "storage": {
      "totalGb": null,
      "usedGb": null,
      "availableGb": null,
      "usagePercent": null,
      "smartStatus": "unknown",
      "ioWaitPercent": null
    },
    "network": {
      "interfaces": [],
      "rxMbps": null,
      "txMbps": null,
      "packetDrops": null,
      "latencyMs": null
    },
    "power": {
      "watts": null,
      "psuStatus": "unknown",
      "upsStatus": "unknown",
      "fanStatus": "unknown",
      "chassisTemperatureCelsius": null
    },
    "source": {},
    "quality": {},
    "safety": {}
  }
}
```

Frontend esperado:

- Hardware Health;
- gauges discretos;
- `unknown` como estado normal cuando no hay sensor;
- alerta si `stale` o `riskLevel` sube.

## Contrato: telemetry history

`GET /v1/hardware/telemetry/history`

Proposito: series historicas para tendencias, no para decision live en MVP.

Reglas:

- aceptar filtros futuros: `window`, `metric`, `resolution`;
- limitar datos para no saturar UI;
- marcar gaps;
- no inferir energia si no hay sensor.

```json
{
  "history": {
    "schemaVersion": "2026-05-08.v1",
    "generatedAt": "2026-05-08T00:00:00.000Z",
    "mode": "read_only",
    "window": "1h",
    "series": [
      {
        "metric": "cpu.usagePercent",
        "unit": "percent",
        "points": []
      }
    ],
    "gaps": [],
    "source": {},
    "quality": {},
    "safety": {}
  }
}
```

## Contrato: OpenClaw live canvas

`GET /v1/openclaw/live-canvas`

Proposito: alimentar React Flow o un canvas similar con un grafo operacional.

```json
{
  "canvas": {
    "schemaVersion": "2026-05-08.v1",
    "generatedAt": "2026-05-08T00:00:00.000Z",
    "mode": "read_only",
    "currentStepId": "hardware_discovery",
    "nodes": [
      {
        "id": "physical_host",
        "kind": "hardware",
        "label": "Servidor fisico",
        "status": "unknown",
        "progressPercent": 0,
        "riskLevel": "unknown",
        "summary": "Esperando telemetria",
        "metrics": [],
        "badges": ["read_only"],
        "drilldown": {
          "endpoint": "/v1/hardware/physical-host",
          "label": "Ver hardware"
        }
      }
    ],
    "edges": [
      {
        "id": "physical_to_proxmox",
        "from": "physical_host",
        "to": "proxmox_host",
        "status": "not_started",
        "label": "base para virtualizacion"
      }
    ],
    "timeline": [
      {
        "id": "event_1",
        "occurredAt": "2026-05-08T00:00:00.000Z",
        "actor": "openclaw",
        "action": "hardware_discovery_pending",
        "status": "unknown",
        "evidenceRefs": []
      }
    ],
    "blockedBy": [],
    "requiresHumanApproval": [],
    "source": {},
    "quality": {},
    "safety": {}
  }
}
```

Estados permitidos para nodos/edges:

- `unknown`;
- `not_started`;
- `collecting`;
- `ready`;
- `needs_review`;
- `blocked`;
- `requires_approval`;
- `disabled_by_mvp`;
- `error`.

Frontend esperado:

- canvas con nodos clicables;
- timeline lateral;
- drill-down por endpoint;
- sin logica de decisiones en UI.

## Contrato: onboarding state

`GET /v1/openclaw/onboarding/state`

Proposito: convertir onboarding en una experiencia visual y auditable.

Debe incluir:

- readiness por categoria;
- preguntas pendientes;
- inputs conocidos;
- blockers;
- warnings;
- siguiente pregunta recomendada;
- si puede o no generar topology plan.

El frontend debe renderizar:

- checklist inteligente;
- progreso por categoria;
- preguntas faltantes;
- bloqueo claro si falta dato critico.

## Contrato: provisioning state

`GET /v1/openclaw/provisioning/state`

Proposito: mostrar estado del plan sin aplicar cambios reales.

Debe incluir:

- topology source;
- provisioning steps;
- DNS/DKIM/TLS/Postfix/Warming readiness;
- required approvals;
- blocked actions;
- dry-run artifacts.

El frontend debe renderizar:

- pipeline de pasos;
- estado de cada paso;
- evidencia y riesgos;
- boton futuro deshabilitado para "solicitar aprobacion".

## Contrato: readiness signals ML/OpenClaw

`GET /v1/openclaw/readiness-signals`

Proposito: exponer senales calculadas para recomendaciones, sin ocultar evidencia.

```json
{
  "signals": {
    "schemaVersion": "2026-05-08.v1",
    "generatedAt": "2026-05-08T00:00:00.000Z",
    "mode": "read_only",
    "scores": {
      "hardwareCapacity": {
        "score": null,
        "confidence": 0,
        "status": "unknown",
        "reason": "telemetry_not_available"
      },
      "thermalRisk": {
        "score": null,
        "confidence": 0,
        "status": "unknown",
        "reason": "sensor_not_available"
      },
      "provisioningReadiness": {
        "score": 0,
        "confidence": 0,
        "status": "needs_review",
        "reason": "dry_run_required"
      }
    },
    "recommendations": [],
    "modelGovernance": {
      "modelMode": "rules_and_evals",
      "modelVersion": "none",
      "promptVersion": "none",
      "canSelfPromote": false,
      "requiresHumanApproval": true
    },
    "source": {},
    "quality": {},
    "safety": {}
  }
}
```

Reglas ML:

- no entrenar con secretos;
- no usar PII innecesaria;
- cada score debe tener razon;
- si no hay datos, score `null`, no `0` falso;
- recomendaciones deben tener evidencia;
- promocion de capacidades siempre bloqueada en MVP.

## Contrato: collector status DevOps

`GET /v1/devops/collector/status`

Proposito: saber si la telemetria es confiable.

Debe responder:

- modo: `mock`, `local`, `agent`, `prometheus`, `proxmox`, `ipmi`;
- ultima lectura;
- permisos;
- errores;
- fuentes activas;
- campos no disponibles;
- version del collector;
- si hay datos stale.

```json
{
  "collector": {
    "schemaVersion": "2026-05-08.v1",
    "generatedAt": "2026-05-08T00:00:00.000Z",
    "mode": "mock",
    "status": "ready",
    "sources": [
      {
        "kind": "mock",
        "enabled": true,
        "readOnly": true,
        "lastCollectedAt": null,
        "error": null
      }
    ],
    "permissions": {
      "sshEnabled": false,
      "proxmoxApiWriteEnabled": false,
      "ipmiEnabled": false,
      "prometheusEnabled": false
    },
    "unknownCapabilities": [
      "power.watts",
      "fanStatus",
      "chassisTemperatureCelsius"
    ],
    "safety": {}
  }
}
```

## Seguridad de datos

Nunca exponer:

- llaves privadas SSH;
- tokens de Proxmox;
- credenciales SMTP;
- secrets de DNS;
- serial real si se decide redacted;
- comandos con credenciales;
- datos personales innecesarios;
- payloads NFC sensibles.

Exponer de forma segura:

- estado;
- capacidad;
- health;
- readiness;
- evidencia referenciada;
- razones de bloqueo;
- campos `unknown`.

## Calidad y frescura

El frontend debe mostrar si la informacion es:

- `fresh`: lectura reciente;
- `stale`: lectura vieja;
- `unknown`: no existe fuente;
- `mock`: dato de demo;
- `untrusted`: fuente no verificada.

Los contratos deben incluir TTL recomendado:

| Contrato | TTL MVP sugerido |
| --- | --- |
| physical-host | 10 min |
| telemetry/latest | 30 sec |
| telemetry/history | 5 min |
| live-canvas | 10 sec |
| onboarding/state | 1 min |
| provisioning/state | 1 min |
| readiness-signals | 1 min |
| collector/status | 30 sec |

## Errores

Forma recomendada:

```json
{
  "error": {
    "code": "TELEMETRY_SOURCE_UNAVAILABLE",
    "message": "Telemetry source is unavailable.",
    "severity": "warning",
    "reason": "collector_not_configured",
    "safeToDisplay": true,
    "auditEventId": null
  }
}
```

El frontend muestra el error; no lo reinterpreta.

## Implementacion backend sugerida

Nuevos modulos dominio:

- `hardware-inventory.ts`;
- `hardware-telemetry.ts`;
- `openclaw-canvas.ts`;
- `openclaw-readiness-signals.ts`;
- `devops-collector-status.ts`.

Cada modulo debe tener:

- builder puro;
- input tipado;
- output tipado;
- tests;
- datos mock seguros;
- `unknown` explicito para datos faltantes.

## Implementacion frontend sugerida

Las features React futuras deben consumir:

- `usePhysicalHostQuery`;
- `useHardwareTelemetryQuery`;
- `useOpenClawCanvasQuery`;
- `useOpenClawOnboardingStateQuery`;
- `useOpenClawProvisioningStateQuery`;
- `useReadinessSignalsQuery`;
- `useCollectorStatusQuery`.

Query keys:

```txt
["hardware", "physical-host"]
["hardware", "telemetry", "latest"]
["openclaw", "live-canvas"]
["openclaw", "onboarding-state"]
["openclaw", "provisioning-state"]
["openclaw", "readiness-signals"]
["devops", "collector-status"]
```

## Gates de cierre 5.6

Hito 5.6 queda cerrado si:

- existen contratos de dominio tipados;
- existen endpoints `GET`;
- existen tests de cada builder;
- el admin panel proxy permite solo esos `GET`;
- el frontend puede renderizar canvas/hardware sin inventar datos;
- todos los writes live siguen apagados;
- `unknown` y `stale` se modelan explicitamente;
- ML/OpenClaw reporta evidencia, confianza y limites;
- DevOps expone estado del collector y fuentes;
- la documentacion queda actualizada.

## Que sigue

Despues de 5.6:

- **Hito 5.7**: migrar base UI a React/Vite/TypeScript y renderizar el canvas con datos de 5.6.
- **Hito 5.8**: collector supervisado real para hardware/Proxmox/IPMI/Prometheus, aun read-only.
