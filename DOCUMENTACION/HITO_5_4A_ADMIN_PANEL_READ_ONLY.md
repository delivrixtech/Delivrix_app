# Hito 5.4A: Admin panel read-only local

Fecha: 2026-05-03

Propiedad: Delivrix LLC.
Desarrollado por JECT.

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Documento padre: `HITO_5_4_ADMIN_PANEL_VISUAL_ARQUITECTURA.md`.

## Objetivo

Crear el primer panel visual usable sin romper la separacion frontend/backend.

Este incremento entrega una UI local de lectura para visualizar estado operativo, OpenClaw, sender nodes, auditoria, reportes y safety. No ejecuta mutaciones.

## Decision tecnica del incremento

El entorno local actual tiene Node 24 disponible, pero no trae `npm` en PATH. Para no bloquear el avance ni introducir dependencias descargadas manualmente, este hito implementa un panel frontend sin dependencias externas.

La estructura queda lista para migrar a Vite + React + TypeScript cuando el runtime tenga package manager disponible.

## Archivos creados

- `apps/admin-panel/package.json`
- `apps/admin-panel/server.mjs`
- `apps/admin-panel/index.html`
- `apps/admin-panel/src/app/main.js`
- `apps/admin-panel/src/app/styles.css`
- `apps/admin-panel/src/features/*`
- `apps/admin-panel/src/shared/api/*`
- `apps/admin-panel/src/shared/lib/*`
- `apps/admin-panel/src/shared/ui/*`

## Separacion de capas

### Frontend

- Renderiza UI.
- Consume `GET` relativos.
- Maneja estado visual local.
- Muestra errores, loading y estados vacios.
- No importa paquetes backend.
- No lee `runtime/`.

### Dev server del panel

- Sirve archivos estaticos.
- Proxya solo endpoints `GET` permitidos hacia Gateway.
- Bloquea cualquier metodo no GET con `405`.
- No contiene reglas de negocio.

### Backend

- Gateway sigue siendo la fuente de datos.
- Dominio sigue calculando overview, gates, auditoria, kill switch y safety.

## Endpoints permitidos

El panel solo consume:

| Endpoint | Uso |
| --- | --- |
| `GET /health` | estado del Gateway, OpenClaw y safety |
| `GET /v1/admin/clusters` | lectura de clusters/VPS y acciones propuestas |
| `GET /v1/admin/overview` | resumen operativo, alertas, health y auditoria |
| `GET /v1/admin/workflow` | ruta operacional que debe seguir el panel |
| `GET /v1/openclaw/learning-plan` | aprendizaje supervisado y gates de evaluacion |
| `GET /v1/operating-north` | gates, acciones permitidas y bloqueadas |
| `GET /v1/kill-switch` | estado del kill switch |

El panel no llama:

- `POST /v1/demo/mvp/final-report`;
- `POST /v1/kill-switch`;
- endpoints de seed;
- endpoints de recovery;
- endpoints de OpenClaw que generen auditoria;
- endpoints NFC.

## Pantallas entregadas

- Overview.
- OpenClaw.
- Clusters.
- Sender nodes.
- Auditoria reciente.
- Aprendizaje OpenClaw.
- Reportes.
- Seguridad operacional.

## Comandos

Gateway:

```bash
node apps/gateway-api/src/main.ts
```

Admin panel:

```bash
node apps/admin-panel/server.mjs
```

URL:

```txt
http://127.0.0.1:5173
```

Pruebas del panel:

```bash
node --test apps/admin-panel/src/shared/api/client.test.mjs apps/admin-panel/src/shared/lib/formatters.test.mjs
```

## Verificacion realizada

- `node --check apps/admin-panel/server.mjs`.
- `find apps/admin-panel/src -name '*.js' -exec node --check {} \;`.
- `node --test apps/admin-panel/src/shared/api/client.test.mjs apps/admin-panel/src/shared/lib/formatters.test.mjs`.
- `GET http://127.0.0.1:5173/health` responde desde Gateway via proxy.
- `GET http://127.0.0.1:5173/v1/admin/clusters` responde desde Gateway via proxy.
- `GET http://127.0.0.1:5173/v1/admin/overview` responde desde Gateway via proxy.
- `GET http://127.0.0.1:5173/v1/admin/workflow` responde desde Gateway via proxy.
- `GET http://127.0.0.1:5173/v1/openclaw/learning-plan` responde desde Gateway via proxy.
- `POST http://127.0.0.1:5173/v1/kill-switch` responde `405`.

## Gates

Este hito no queda cerrado si:

- el panel ejecuta `POST`, `PUT`, `PATCH` o `DELETE`;
- el frontend lee `runtime/`;
- el frontend importa dominio, stores o adaptadores;
- el panel oculta que SMTP, SSH, DNS live, Proxmox live y NFC writes siguen apagados;
- se presenta `live mode` como editable.

## Que sigue

Cuando el entorno tenga package manager:

- migrar el shell a Vite + React + TypeScript;
- introducir TanStack Query para server state;
- agregar TanStack Router;
- agregar TanStack Table para tablas densas;
- mantener exactamente la misma frontera `GET-only` mientras no exista autenticacion y auditoria de mutaciones.

Siguiente ajuste implementado:

- `HITO_5_4B_ADMIN_PANEL_WORKFLOW.md`.
