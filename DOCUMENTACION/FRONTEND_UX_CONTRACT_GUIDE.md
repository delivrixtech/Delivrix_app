# Frontend UX contract guide

Fecha: 2026-05-08

Objetivo: permitir mejoras visuales profesionales del admin panel sin hardcodear datos, permisos, estados ni decisiones de dominio.

## Regla principal

El frontend muestra y organiza informacion. El backend decide.

La UI no debe:

- importar stores locales;
- leer `runtime/`;
- crear reglas de negocio;
- inferir permisos;
- inventar estados operativos;
- ejecutar `POST`, `PUT`, `PATCH` o `DELETE`;
- conectar SSH, Proxmox, DNS, SMTP o NFC;
- guardar secretos.

## Fuente de verdad del frontend

Usar estos archivos como entrada tecnica:

- `apps/admin-panel/src/shared/api/read-boundary.ts`
- `apps/admin-panel/src/shared/api/client.ts`
- `packages/domain/src/admin-panel-workflow.ts`
- `packages/domain/src/control-plane-contract.ts`
- `DOCUMENTACION/HITO_5_9_INGESTA_MANUAL_SNAPSHOT_UX.md`

Todo estado visual debe venir de contratos `GET` del Gateway.

## Contratos que puede consumir el panel

El panel solo puede leer endpoints listados en `READ_ENDPOINTS`.

Si una pantalla necesita un dato nuevo:

1. definir el contrato en dominio/backend;
2. exponerlo por Gateway como `GET`;
3. agregarlo a `READ_ENDPOINTS`;
4. tiparlo en `client.ts`;
5. renderizarlo sin transformar decisiones de negocio en la UI.

## Pantallas prioritarias

### Canvas

Debe ayudar a entender:

- en que punto esta OpenClaw;
- que datos faltan;
- que nodos/gates bloquean avance;
- que requiere aprobacion humana;
- que sigue apagado por seguridad.

Mejoras permitidas:

- layouts mas legibles;
- zoom y minimap mas claros;
- panel lateral con detalle del nodo seleccionado;
- agrupacion por onboarding, hardware, provisioning, warming y reputacion;
- colores de estado provenientes de backend.

### Hardware

Debe mostrar el estado del servidor fisico:

- inventario;
- CPU;
- RAM;
- storage;
- red;
- energia;
- sensores cuando existan;
- frescura de telemetria;
- campos desconocidos.

Mejoras permitidas:

- graficas de series cuando `telemetryHistory.series` tenga datos;
- tarjetas de capacidad con unidad clara;
- estados `unknown`, `stale`, `needs_review` y `ready` diferenciados;
- lista de datos faltantes priorizada.

### Collector

Debe mostrar como la evidencia entra al sistema:

- fuentes read-only;
- permisos minimos;
- transporte;
- redaccion;
- hash;
- auditoria;
- endpoint manual fuera del panel;
- gates.

Mejoras permitidas:

- dividir fuentes por estado;
- mostrar tabla de campos aceptados;
- explicar visualmente que la UI no hace `POST`;
- usar progressive disclosure para listas largas.

### Workflow

Debe ordenar la operacion:

- que revisar primero;
- que evidencia sostiene cada paso;
- que pantalla sigue;
- que se considera bloqueado.

Mejoras permitidas:

- stepper vertical u horizontal;
- estado de cada paso;
- enlaces internos entre secciones;
- resumen ejecutivo del paso activo.

## Componentizacion recomendada

Mantener componentes pequenos y contract-first:

- `StatusPill`
- `MetricCard`
- `EvidenceList`
- `ContractTable`
- `GateList`
- `ReadOnlyBanner`
- `Timeline`
- `FlowCanvas`
- `TelemetryChart`
- `UnknownFieldsPanel`

Los componentes reciben datos ya tipados desde `DashboardData`.

## Buenas practicas visuales

- Mantener densidad operacional; esto no es landing page.
- No usar heroes, orbes, gradientes decorativos ni cards anidadas.
- Evitar textos largos dentro de chips.
- Usar estados vacios claros para `unknown` y `stale`.
- Usar dimensiones estables para canvas, tablas, toolbars y cards.
- Asegurar responsive sin solapar texto.
- Usar iconos funcionales solo cuando ayuden a escanear.
- Mantener paleta sobria con codificacion por estado: success, warning, critical, neutral.

## Gates antes de mutaciones futuras

No agregar botones de accion real hasta tener:

- autenticacion;
- autorizacion por rol;
- aprobacion humana explicita;
- audit log append-only;
- dry-run previo;
- rollback definido si aplica;
- kill switch probado;
- contrato backend versionado;
- prueba que el panel no ejecuta acciones al cargar.

## Checklist para Claude u otro frontend senior

Antes de proponer cambios visuales:

- leer `RESUMEN_RUTA_PROYECTO.md`;
- leer este documento;
- leer `client.ts` y `read-boundary.ts`;
- no agregar datos constantes de negocio en componentes;
- si falta un dato, pedir o crear contrato backend primero;
- mantener `GET-only`;
- ejecutar `npm --workspace @delivrix/admin-panel run check`;
- verificar visualmente desktop y mobile.
