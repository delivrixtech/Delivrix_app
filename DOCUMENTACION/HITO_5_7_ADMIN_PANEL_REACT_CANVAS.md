# Hito 5.7: Admin panel React y canvas operacional

Fecha: 2026-05-08

Documentos rectores:

- `NORTE_OPERATIVO_DELIVRIX.md`
- `RESUMEN_RUTA_PROYECTO.md`
- `HITO_5_5_AUDITORIA_FRONTEND_UI_PROCESOS.md`
- `HITO_5_6_CONTRATOS_CANVAS_HARDWARE_ML_DEVOPS.md`

## Objetivo

Migrar el panel visual a una base frontend profesional con React, Vite y TypeScript, manteniendo separacion estricta entre frontend y backend.

El panel debe empezar a mostrar el onboarding como consola operacional:

- canvas vivo de OpenClaw;
- estado del servidor fisico;
- telemetria hardware mock/read-only;
- estado del collector DevOps;
- workflow operativo desde backend;
- gates de seguridad y aprendizaje supervisado.

## Decision tecnica

Base implementada:

- React + TypeScript;
- Vite para desarrollo y build;
- TanStack Query para server state;
- React Flow para canvas;
- lucide-react para iconos;
- `server.mjs` como servidor de build y proxy read-only.

No se introdujeron mutaciones desde UI.

## Frontera frontend/backend

El frontend:

- consume solo `GET`;
- consume contratos versionados de Gateway;
- no importa dominio, stores, adapters ni runtime;
- no calcula readiness, permisos ni safety;
- no ejecuta comandos;
- no activa SSH, DNS, SMTP, Proxmox ni NFC.

La frontera de lectura vive en:

```txt
apps/admin-panel/src/shared/api/read-boundary.ts
```

## Vistas implementadas

### Canvas

Renderiza `GET /v1/openclaw/live-canvas` con React Flow:

- nodos;
- edges;
- timeline;
- bloqueos;
- aprobaciones humanas;
- drill-down por endpoint.

### Hardware

Renderiza:

- `GET /v1/hardware/physical-host`;
- `GET /v1/hardware/telemetry/latest`;
- `GET /v1/devops/collector/status`.

Los campos desconocidos se muestran como `unknown`; no se inventan datos.

### Ruta, clusters, aprendizaje y seguridad

Reutilizan contratos existentes:

- `GET /v1/admin/workflow`;
- `GET /v1/admin/clusters`;
- `GET /v1/openclaw/learning-plan`;
- `GET /v1/openclaw/readiness-signals`;
- `GET /v1/operating-north`;
- `GET /v1/kill-switch`.

## Estado de seguridad

Sigue apagado:

- real email;
- SMTP real;
- SSH automatico;
- Proxmox live mutation;
- DNS live changes;
- NFC production writes;
- auto-entrenamiento ML;
- acciones autonomas.

## Como correr

Desarrollo:

```bash
npm run dev:gateway
npm run dev:admin
```

Build + servidor controlado:

```bash
npm --workspace @delivrix/admin-panel run build
npm run serve:admin
```

## Verificacion

Comandos de cierre:

```bash
npm --workspace @delivrix/admin-panel run check
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Checks operativos:

- `GET /health` reporta fase `5.6-canvas-hardware-ml-devops-contracts`;
- `GET /v1/openclaw/live-canvas` responde `200`;
- `POST /v1/openclaw/live-canvas` responde `405` por proxy.

## Criterio de cierre

Hito 5.7 queda cerrado si:

- el panel compila con Vite;
- los tests del cliente read-only pasan;
- el canvas se alimenta de contratos 5.6;
- la vista hardware usa contratos backend;
- el proxy bloquea metodos no GET;
- la documentacion queda alineada.

## Que sigue

Hito 5.8 implementado en `HITO_5_8_COLLECTOR_SUPERVISADO_READ_ONLY.md`:

- collector supervisado read-only para hardware/Proxmox/IPMI/Prometheus;
- ingestion auditada de snapshots;
- frescura real de telemetria;
- sin live writes.
