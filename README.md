# Delivrix MailOps Platform

Control plane de Delivrix para onboarding inteligente con OpenClaw, preparacion de clusters/VPS/sender nodes, warming, reputacion, auditoria y gobierno de capacidad de mailing autorizado.

## Propiedad intelectual

Copyright (c) 2026 Delivrix LLC. Todos los derechos reservados.  
Desarrollado por JECT.

Ver `NOTICE.md`.

## Norte

Delivrix en el MVP actual:

- valida, planifica, simula, audita y gobierna capacidad;
- no envia correo real;
- no ejecuta SSH, DNS live, Proxmox live ni SMTP real;
- no escribe en NFC productivo;
- exige gates, auditoria y aprobacion humana antes de cualquier mutacion futura.

Documento rector: `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md`.

## Estructura

- `apps/gateway-api`: API HTTP del control plane.
- `apps/worker`: worker local seguro, sin SMTP real.
- `apps/admin-panel`: UI local read-only separada del backend.
- `packages/domain`: reglas, contratos, gates, auditoria y decisiones.
- `packages/adapters`: adaptadores externos en modo seguro/mock.
- `packages/local-store`: persistencia local de desarrollo.
- `packages/queue`: cola local de desarrollo.
- `DOCUMENTACION`: documentos rectores, fases e hitos.

## Comandos

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
node --test apps/admin-panel/src/shared/api/client.test.mjs apps/admin-panel/src/shared/lib/formatters.test.mjs

node apps/gateway-api/src/main.ts
node apps/worker/src/main.ts
node apps/admin-panel/server.mjs
```

## URLs locales

Gateway:

```txt
http://127.0.0.1:3000/health
```

Admin panel:

```txt
http://127.0.0.1:5173
```

## Admin panel

El panel vive separado del backend y consume solo contratos `GET`:

- `GET /health`
- `GET /v1/admin/clusters`
- `GET /v1/admin/overview`
- `GET /v1/admin/workflow`
- `GET /v1/openclaw/learning-plan`
- `GET /v1/operating-north`
- `GET /v1/kill-switch`

El proxy local del panel bloquea `POST`, `PUT`, `PATCH` y `DELETE` con `405`.

Documentos:

- `DOCUMENTACION/HITO_5_4_ADMIN_PANEL_VISUAL_ARQUITECTURA.md`
- `DOCUMENTACION/HITO_5_4A_ADMIN_PANEL_READ_ONLY.md`
- `DOCUMENTACION/HITO_5_4B_ADMIN_PANEL_WORKFLOW.md`
- `DOCUMENTACION/HITO_5_4C_ADMIN_CLUSTERS_OPENCLAW_LEARNING.md`
- `DOCUMENTACION/HITO_5_5_AUDITORIA_FRONTEND_UI_PROCESOS.md`
- `DOCUMENTACION/HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md`
- `DOCUMENTACION/HITO_5_6_CONTRATOS_CANVAS_HARDWARE_ML_DEVOPS.md`

## Documentacion principal

Leer en este orden:

1. `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md`
2. `DOCUMENTACION/INDICE_DOCUMENTACION.md`
3. `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md`
4. `DOCUMENTACION/ROADMAP_PROYECTO.md`
5. `DOCUMENTACION/ESTANDARES_INGENIERIA.md`
6. Documento del hito en curso.

Los documentos de hito son historicos/operativos. El README no duplica sus endpoints ni sus notas de seguridad para evitar ruido.
