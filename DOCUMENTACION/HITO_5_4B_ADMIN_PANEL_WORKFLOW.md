# Hito 5.4B: Admin panel con workflow operativo

Fecha: 2026-05-03

Propiedad: Delivrix LLC.
Desarrollado por JECT.

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Documento padre: `HITO_5_4A_ADMIN_PANEL_READ_ONLY.md`.

## Objetivo

Evitar que el frontend parezca hardcodeado o sin ruta operacional.

Este hito mueve la secuencia principal del panel al backend mediante un contrato `GET`:

```txt
GET /v1/admin/workflow
```

La UI ya no inventa el orden de lectura. El backend define:

- que seccion va primero;
- que pregunta debe responder cada seccion;
- que evidencia debe mostrar;
- que endpoints alimentan cada paso;
- si el paso esta `ready`, `needs_review` o `blocked`;
- cual es el siguiente paso recomendado.

## Ruta operativa

El workflow actual guia al operador asi:

1. Ruta operativa.
2. Overview.
3. OpenClaw.
4. Clusters y VPS.
5. Sender nodes.
6. Auditoria.
7. Aprendizaje OpenClaw.
8. Reportes.
9. Seguridad operacional.

Actualizacion: el detalle de clusters/VPS y aprendizaje supervisado vive en `HITO_5_4C_ADMIN_CLUSTERS_OPENCLAW_LEARNING.md`.

## Separacion de responsabilidades

Backend:

- construye el workflow;
- calcula estado de cada paso;
- expone la frontera `GET-only`;
- define preguntas y evidencia esperada.

Frontend:

- renderiza la ruta;
- navega segun `workflow.steps`;
- mantiene componentes visuales por seccion;
- no calcula gates ni readiness.

## Contratos

Nuevo dominio:

- `packages/domain/src/admin-panel-workflow.ts`

Nuevo endpoint:

- `GET /v1/admin/workflow`

Nuevo test:

- `packages/domain/src/admin-panel-workflow.test.ts`

Endpoint agregado al proxy read-only:

- `apps/admin-panel/server.mjs`

Cliente frontend:

- `apps/admin-panel/src/shared/api/client.js`

Vista nueva:

- `apps/admin-panel/src/features/workflow/workflow.js`

## Documentacion compactada

Tambien se compacto `README.md`.

Regla:

- README es puerta de entrada y comandos actuales.
- Los detalles de endpoints e hitos viven en documentos de hito.
- Las reglas globales viven en `NORTE_OPERATIVO_DELIVRIX.md`.
- No repetir en README cada frase de seguridad que ya esta en documentos rectores.

## Gates

Este hito no queda cerrado si:

- el workflow se define solo en frontend;
- la UI ejecuta mutaciones;
- el proxy permite metodos no GET;
- el README vuelve a duplicar detalles operativos de cada hito;
- las pantallas no responden a una pregunta operacional clara.

## Verificacion esperada

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
node --test apps/admin-panel/src/shared/api/client.test.mjs apps/admin-panel/src/shared/lib/formatters.test.mjs
```
