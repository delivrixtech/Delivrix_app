# Hito 5.4C: Panel clusters y aprendizaje OpenClaw

Fecha: 2026-05-03

Documentos rectores:

- `NORTE_OPERATIVO_DELIVRIX.md`
- `FASE_5_MVP_DEMOSTRABLE.md`
- `HITO_5_4B_ADMIN_PANEL_WORKFLOW.md`

## Objetivo

Corregir el panel para que no dependa de contenido hardcodeado y dejar claro que el panel administrara clusters/VPS desde contratos backend.

Tambien se define como OpenClaw debe "aprender": por evidencia curada, auditoria, dry-runs, resultados simulados/evaluados y feedback humano. En el MVP no hay auto-entrenamiento, llamadas externas de training ni acciones live autonomas.

## Entregables

- Contrato dominio `buildAdminClusterOverview`.
- Endpoint `GET /v1/admin/clusters`.
- Contrato dominio `buildOpenClawLearningPlan`.
- Endpoint `GET /v1/openclaw/learning-plan`.
- Workflow backend actualizado con rutas `Clusters` y `Aprendizaje`.
- Admin panel consume ambos contratos desde el proxy local `GET-only`.
- `operating-north` actualizado a `5.4C-admin-cluster-learning-contracts`.

## Como debe funcionar

1. El Gateway lee sender nodes, health, provisioning dry-runs, auditoria y resultados.
2. El backend produce una vista de clusters/VPS con estado, gates y acciones propuestas.
3. El frontend solo renderiza el contrato. No decide permisos, no calcula gates y no toca stores.
4. OpenClaw puede observar y proponer administracion de clusters/VPS.
5. Cualquier accion real queda bloqueada hasta una fase futura con aprobacion humana, auditoria y runbook.
6. El aprendizaje de OpenClaw se alimenta con evidencia permitida y excluye secretos, llaves, tokens y PII no necesaria.

## Frontera MVP

Permitido:

- leer inventario de clusters/VPS/sender nodes;
- leer dry-runs de provisioning;
- leer auditoria y signals de reputacion;
- proponer topologia, warming, cuarentena o revision;
- mostrar gates y acciones futuras.

Bloqueado:

- crear VPS/LXC reales;
- abrir SSH real;
- aplicar DNS/PTR/DKIM live;
- activar SMTP real;
- escribir en NFC produccion;
- entrenar o promover capacidades sin aprobacion humana.

## Contratos

`GET /v1/admin/clusters`

- `clusterOverview.mode`: `read_only`;
- `managementScope`: que administra OpenClaw, que aprueba humano y que queda fuera del MVP;
- `clusters`: clusters agrupados por proveedor con sender nodes, health y dry-runs;
- `nextActions`: propuestas o revisiones, marcando si estan bloqueadas en MVP;
- `safety`: todos los writes live permanecen `false`.

`GET /v1/openclaw/learning-plan`

- `mode`: `supervised_evaluation_only`;
- `dataSources`: fuentes permitidas y campos excluidos;
- `stages`: observe -> label -> propose -> evaluate -> promote;
- `evaluationGates`: trazabilidad, dry-run, reputacion y aprobacion humana;
- `promotionPolicy.canSelfPromote`: `false`;
- `safety.externalTrainingCallsEnabled`: `false`.

## Criterio de salida

- El panel muestra `Clusters` y `Aprendizaje` desde backend.
- El frontend no contiene el norte operacional como logica de negocio.
- Los nuevos endpoints son `GET`.
- El proxy local rechaza metodos de escritura.
- La documentacion deja claro que OpenClaw administra clusters/VPS en modo read-only/supervisado, no envio real.

## Verificacion

```bash
node --test packages/domain/src/admin-cluster-overview.test.ts packages/domain/src/openclaw-learning-plan.test.ts packages/domain/src/admin-panel-workflow.test.ts packages/domain/src/operating-north.test.ts
node --test apps/admin-panel/src/shared/api/client.test.mjs apps/admin-panel/src/shared/lib/formatters.test.mjs
find apps/admin-panel/src -name '*.js' -exec node --check {} \;
node --check apps/gateway-api/src/main.ts
```
