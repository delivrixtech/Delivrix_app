# Hito 5.9: Ingesta manual auditada y UX contract-first

Fecha: 2026-05-08

Documentos rectores:

- `NORTE_OPERATIVO_DELIVRIX.md`
- `RESUMEN_RUTA_PROYECTO.md`
- `HITO_5_8_COLLECTOR_SUPERVISADO_READ_ONLY.md`
- `HITO_5_7_ADMIN_PANEL_REACT_CANVAS.md`

## Objetivo

Permitir que Delivrix reciba evidencia manual redaccionada del servidor fisico para reemplazar gradualmente datos `unknown` o mock, sin abrir escrituras desde el panel visual.

Este hito crea el puente seguro entre:

- el operador humano que captura un snapshot local;
- el Gateway que redacciona, hashea, parsea y audita;
- el frontend que solo consume contratos `GET`;
- OpenClaw que observa evidencia y sigue proponiendo sin ejecutar acciones reales.

## Regla principal

El admin panel sigue siendo `GET-only`.

No se habilita:

- carga de archivos desde UI;
- boton de ingesta en UI;
- SSH automatico;
- escritura Proxmox;
- cambios DNS live;
- SMTP real;
- NFC writes;
- almacenamiento de secretos o payload crudo.

## Contratos nuevos

### Contrato visible para frontend

```txt
GET /v1/devops/collector/snapshot-ingestion
```

Respuesta:

```txt
snapshotIngestion
```

Declara:

- schema del snapshot manual;
- endpoint manual backend;
- politica UI `GET-only`;
- campos aceptados;
- campos rechazados por redaccion;
- parser outputs `physicalHost` y `telemetry`;
- gates;
- siguientes acciones seguras;
- acciones bloqueadas.

### Endpoint manual fuera del panel

```txt
POST /v1/devops/collector/manual-snapshots/ingest
```

Condiciones:

- requiere `humanApproved: true`;
- se evalua por `evaluateOperatingActionGate`;
- redacciona antes de hashear;
- calcula hash SHA-256 del payload redaccionado;
- genera `snapshotId`;
- parsea a contratos `physicalHost` y `telemetry`;
- registra evento append-only `collector.manual_snapshot_ingested`;
- devuelve `202` si el snapshot queda aceptado o en revision;
- devuelve `422` si el payload no tiene campos operativos reconocidos.

## Campos aceptados

El snapshot manual puede incluir, entre otros:

- `host.model`
- `host.operatingSystem`
- `host.kernelVersion`
- `host.proxmoxVersion`
- `host.uptimeSeconds`
- `capacity.cpuCores`
- `capacity.cpuThreads`
- `capacity.memoryGb`
- `capacity.storageUsableGb`
- `capacity.networkInterfaces`
- `capacity.ipPoolSize`
- `telemetry.cpu.usagePercent`
- `telemetry.cpu.temperatureCelsius`
- `telemetry.memory.usagePercent`
- `telemetry.storage.smartStatus`
- `telemetry.network.rxMbps`
- `telemetry.network.txMbps`
- `telemetry.power.watts`

## Redaccion

El sistema rechaza llaves secret-like antes de hashear o auditar:

- `private_key`
- `password`
- `token`
- `secret`
- `smtp_credentials`
- `ssh_private_key`
- patrones tipo `api_key`, `credential`, `private-key`.

El resultado no conserva el payload crudo. Solo conserva:

- paths rechazados;
- top-level keys retenidas;
- hash del snapshot redaccionado;
- campos reconocidos;
- salida parseada segura;
- evento de auditoria candidato.

## Frontend reforzado

El panel ahora muestra en `Collector`:

- si el panel puede hacer `POST` o no;
- endpoint manual declarado por backend;
- schema version del snapshot;
- campos requeridos;
- politica de redaccion;
- outputs del parser;
- gates y acciones bloqueadas.

Esto evita hardcoding porque la UI no inventa:

- metodos permitidos;
- schema de campos;
- acciones seguras;
- estado del endpoint;
- seguridad de ingestion.

Todo eso viene desde el Gateway.

## Cambios de codigo

Backend/domain:

- `packages/domain/src/collector-snapshot-ingestion.ts`
- tests `hito-5-9-manual-snapshot-ingestion.test.ts`
- `operating-north` actualizado a fase `5.9-manual-snapshot-ingestion-ux`
- gate especial para `ingest_manual_collector_snapshot`
- workflow del panel incluye `snapshot-ingestion`.

Gateway:

- `GET /v1/devops/collector/snapshot-ingestion`
- `POST /v1/devops/collector/manual-snapshots/ingest`
- health expone `manualSnapshotIngestionContractEnabled`.

Frontend:

- read boundary incluye solo el `GET` del contrato;
- proxy local permite solo `GET /v1/devops/collector/snapshot-ingestion`;
- cliente TypeScript consume `snapshotIngestion`;
- seccion `Collector` muestra el contrato manual sin ejecutar mutaciones;
- tests verifican que no exista endpoint `manual-snapshots` en constantes del panel.

## Guia para UX

La guia `FRONTEND_UX_CONTRACT_GUIDE.md` define como mejorar el panel visual sin hardcodear estado ni romper la frontera frontend/backend.

## Criterio de cierre

Hito 5.9 queda cerrado si:

- el contrato `snapshotIngestion` existe;
- el panel sigue sin endpoint de escritura;
- el endpoint manual exige aprobacion humana;
- la ingesta redacciona secretos antes de hashear;
- el hash del snapshot se incluye en auditoria;
- el parser produce `physicalHost` y `telemetry`;
- las acciones live siguen bloqueadas;
- las pruebas de dominio y admin panel pasan;
- la documentacion queda alineada.

## Que sigue

Siguiente hito recomendado:

- UX visual profesional sobre contratos reales;
- mejores visualizaciones para onboarding, hardware, collector y canvas;
- historial grafico de telemetria cuando exista collector real;
- states de vacio/unknown/review mas claros;
- autenticacion/autorizacion antes de exponer cualquier mutacion en UI.
