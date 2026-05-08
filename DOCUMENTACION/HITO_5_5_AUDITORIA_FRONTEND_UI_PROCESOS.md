# Hito 5.5: Auditoria frontend y UI por procesos

Fecha: 2026-05-07

Documentos rectores:

- `NORTE_OPERATIVO_DELIVRIX.md`
- `ESTANDARES_INGENIERIA.md`
- `HITO_5_4_ADMIN_PANEL_VISUAL_ARQUITECTURA.md`
- `HITO_5_4C_ADMIN_CLUSTERS_OPENCLAW_LEARNING.md`

## Objetivo

Auditar el admin panel actual como producto frontend y definir la primera version profesional de UI para Delivrix.

Este hito no busca embellecer pantallas aisladas. Busca ordenar los procesos reales que el operador debe ejecutar: entender estado, revisar infraestructura, analizar OpenClaw, leer evidencia, controlar riesgos y preparar acciones supervisadas futuras.

## Diagnostico ejecutivo

El panel actual cumple como MVP read-only:

- esta separado del backend;
- consume contratos `GET`;
- no ejecuta mutaciones;
- muestra workflow, overview, OpenClaw, clusters, sender nodes, auditoria, aprendizaje, reportes y seguridad;
- mantiene la frontera de seguridad visible.

Pero aun no cumple el estandar frontend final:

- usa render manual con DOM helpers, no React/Vite/TypeScript;
- no hay routing URL real por pantalla;
- carga todos los endpoints al inicio, aunque el usuario solo mire una seccion;
- no hay TanStack Query ni cache por feature;
- `styles.css` es monolitico;
- las tablas son basicas, sin filtros, sorting, columnas configurables ni vistas densas;
- no hay contratos tipados/schemas compartidos para DTO frontend;
- no hay pruebas visuales desktop/mobile;
- faltan pantallas dedicadas para Jobs, Warming/Reputation y Onboarding.

Decision: conservar el panel actual como prototipo validado y planear una migracion controlada a frontend profesional.

## Mapa de procesos de la primera version

| Proceso | Pregunta del operador | UI MVP requerida | Estado actual |
| --- | --- | --- | --- |
| Ruta operativa | Que debo revisar primero? | Command center con secuencia, estado y siguiente paso | Implementado basico |
| Overview | El sistema esta sano o critico? | KPIs, alertas, distribuciones, resumen ejecutivo | Implementado basico |
| OpenClaw | Que puede observar/proponer la IA? | Capacidades, gates, permisos, modo actual | Implementado basico |
| Onboarding | Que datos faltan del servidor fisico? | Checklist inteligente, readiness, preguntas y bloqueos | Falta pantalla |
| Clusters/VPS | Que infraestructura administrara OpenClaw? | Clusters, VPS/LXC, capacidad, gates, acciones propuestas | Implementado basico |
| Sender nodes | Que nodos requieren accion? | Tabla densa, health, warming, reputacion, recomendaciones | Implementado basico |
| Jobs/resultados | Que esta en cola y que resultados hay? | Cola, estados, resultados simulados, errores | Falta pantalla dedicada |
| Warming/reputacion | Podemos aumentar capacidad? | Curvas, thresholds, bounces, complaints, deferred, blacklists | Falta pantalla dedicada |
| Auditoria | Que evidencia explica el estado? | Timeline, filtros, actor, accion, target, riesgo | Implementado basico |
| Aprendizaje OpenClaw | Como mejora OpenClaw sin auto-entrenarse? | Fuentes, stages, gates, evals, promocion bloqueada | Implementado basico |
| Reportes | Que evidencia se muestra al sponsor? | Reporte MVP, riesgos, gates, export futuro | Implementado minimo |
| Seguridad | Que sigue apagado y por que? | Kill switch, live writes, NFC, SMTP, entorno | Implementado basico |

## Auditoria por pantalla actual

### 1. Ruta operativa

Funciona:

- el orden viene del backend;
- muestra frontera `GET-only`;
- muestra estados `ready`, `needs_review`, `blocked`.

Brechas:

- no permite saltar al detalle desde cada paso;
- no muestra prioridad operacional ni "owner" del siguiente paso;
- no diferencia bloqueos por datos faltantes, riesgo o seguridad.

Recomendacion:

- convertirla en Command Center inicial;
- cada paso debe tener CTA de navegacion, owner, severidad y evidencia faltante;
- debe ser la pantalla home por defecto.

### 2. Overview

Funciona:

- muestra KPIs principales;
- alerta estado critico;
- resume jobs, sender nodes y resultados.

Brechas:

- falta jerarquia de decision: que debo hacer ahora;
- las alertas no agrupan por causa;
- no hay tendencia ni comparacion temporal;
- no existe filtro por entorno o demo run.

Recomendacion:

- agregar panel "Siguiente decision";
- separar `incidentes`, `capacidad`, `reputacion` y `safety`;
- preparar mini charts solo cuando existan series reales.

### 3. OpenClaw

Funciona:

- muestra rol, fase, acciones permitidas/bloqueadas y gates;
- mantiene live actions apagadas.

Brechas:

- no conecta visualmente onboarding -> topology -> provisioning -> scheduler -> runbook;
- no muestra ultima recomendacion ni evidencia asociada;
- no separa "capacidad tecnica" de "permiso operacional".

Recomendacion:

- crear una vista tipo pipeline de OpenClaw;
- cada modulo debe mostrar estado, entrada, salida, riesgos y siguiente accion permitida.

### 4. Clusters/VPS

Funciona:

- consume `GET /v1/admin/clusters`;
- agrupa clusters por proveedor;
- muestra sender nodes, gates y acciones futuras.

Brechas:

- la tabla crece rapido y necesita filtros/colapsables;
- no hay vista por cluster fisico vs pool temporal;
- faltan recursos de infraestructura: CPU, RAM, storage, IP pool, PTR/DNS readiness;
- las acciones propuestas no tienen detalle de razon/evidencia.

Recomendacion:

- pantalla de clusters con layout master/detail;
- cards de cluster arriba, tabla filtrable abajo;
- drawer de detalle por VPS/sender node;
- vista futura de topology plan y provisioning dry-run.

### 5. Sender nodes

Funciona:

- tabla de health por nodo;
- estados actual/recomendado;
- metricas sent/bounce/complaint/deferred/failed.

Brechas:

- no tiene sorting ni filtros;
- no muestra hostname/IP/dominio en la vista principal;
- no conecta con cluster/proveedor;
- no diferencia health actual vs accion propuesta.

Recomendacion:

- TanStack Table;
- filtros por proveedor, status, health, cluster, warmup day;
- columna de recomendacion con razon resumida;
- detalle lateral con historial, resultados y auditoria.

### 6. Auditoria

Funciona:

- muestra eventos recientes;
- actor, accion, target y riesgo.

Brechas:

- no hay filtros por actor, target, riesgo o demoRunId;
- no hay detalle de metadata;
- no se puede copiar evidencia para reporte.

Recomendacion:

- timeline + tabla;
- panel de detalle JSON seguro, ocultando campos sensibles;
- filtros persistentes en URL.

### 7. Aprendizaje OpenClaw

Funciona:

- muestra fuentes, etapas, gates y politica de promocion;
- deja claro que no hay auto-entrenamiento.

Brechas:

- "aprendizaje" puede sonar ambiguo para operadores no tecnicos;
- falta separar aprendizaje de modelo vs aprendizaje operacional;
- no hay score de confianza ni cobertura de evals.

Recomendacion:

- renombrar UI a "Evals OpenClaw" o "Aprendizaje supervisado";
- mostrar cobertura: audit events, dry-runs, results, casos no-go;
- agregar estado "no puede promoverse solo" como gate destacado.

### 8. Reportes

Funciona:

- muestra que el reporte final no se genera desde UI;
- mantiene `POST` bloqueado.

Brechas:

- no existe contrato `GET` para leer el ultimo reporte;
- no hay preview sponsor-ready;
- no hay export o snapshot.

Recomendacion:

- crear `GET /v1/admin/reports/mvp-final`;
- mostrar reporte generado, evidencia y riesgos;
- export futuro solo despues de auth/auditoria.

### 9. Seguridad

Funciona:

- muestra kill switch, email real, infra live y NFC writes;
- confirma frontera actual.

Brechas:

- no hay matriz de permisos OpenClaw;
- no hay vista de secretos/configuracion segura;
- no distingue entorno local/dev/staging.

Recomendacion:

- dividir en `Safety`, `Permissions`, `Integrations`;
- mostrar kill switch como estado critico visible global;
- cualquier accion futura debe pedir motivo, role y auditoria.

## Arquitectura frontend propuesta

### Stack objetivo

- Vite + React + TypeScript.
- TanStack Router para rutas tipadas.
- TanStack Query para server state.
- TanStack Table para tablas operativas.
- shadcn/ui + Radix UI para componentes accesibles.
- Lucide React para iconografia.
- Recharts para graficas MVP.
- React Hook Form + Zod para formularios futuros.
- Vitest + Testing Library para componentes.
- Playwright para E2E y screenshots desktop/mobile.

### Estructura objetivo

```txt
apps/admin-panel/
  src/
    app/
      router/
      providers/
      layout/
    features/
      command-center/
      overview/
      openclaw/
      onboarding/
      clusters/
      sender-nodes/
      jobs/
      reputation/
      audit-log/
      learning/
      reports/
      safety/
    shared/
      api/
      contracts/
      ui/
      lib/
      test/
```

### Regla de contratos

El frontend puede tener view-models, pero no reglas de dominio.

Permitido:

- ordenar columnas;
- filtrar por estado;
- agrupar datos ya calculados;
- traducir labels;
- formatear fechas/numeros.

Prohibido:

- decidir cuarentena;
- decidir readiness;
- calcular permisos OpenClaw;
- habilitar live mode;
- reconstruir gates;
- leer stores, runtime o adaptadores.

## Primera version UI recomendada

### Navegacion

Orden principal:

1. Command Center.
2. Overview.
3. OpenClaw.
4. Onboarding.
5. Clusters/VPS.
6. Sender Nodes.
7. Jobs.
8. Reputation/Warming.
9. Audit.
10. Learning/Evals.
11. Reports.
12. Safety.

### Layout

- Topbar: estado Gateway, operacion, kill switch, modo MVP.
- Sidebar: procesos, no "paginas sueltas".
- Content: header con pregunta operacional, estado y acciones permitidas.
- Detail drawer: evidencia, metadata y trazabilidad.
- Tables: densas, filtrables, con empty/error/loading states.

### Estados obligatorios por pantalla

- loading;
- empty;
- error backend;
- blocked;
- needs_review;
- ready;
- critical;
- stale data;
- no permission para mutacion futura.

## Hitos frontend siguientes

### Hito 5.6: Migracion base a React/Vite/TypeScript

- crear app React sin cambiar contratos backend;
- mantener proxy `GET-only`;
- implementar layout, router y QueryClient;
- portar `Command Center`, `Overview`, `Safety`;
- tests unitarios basicos.

### Hito 5.7: Tablas operativas y detalle

- TanStack Table para Sender nodes, Clusters y Audit;
- filtros por estado, proveedor, riesgo y actor;
- drawer de detalle;
- estados empty/error/loading.

### Hito 5.8: Onboarding y OpenClaw pipeline

- pantalla dedicada de onboarding;
- pipeline OpenClaw: onboarding -> topology -> provisioning -> scheduler -> runbook;
- contratos GET para snapshots si faltan;
- no mutaciones desde UI.

### Hito 5.9: Reports y QA visual

- contrato GET para reporte final;
- preview sponsor-ready;
- pruebas Playwright desktop/mobile;
- auditoria de accesibilidad basica.

## Gates de cierre 5.5

Este hito queda cerrado si:

- existe mapa de procesos UI primera version;
- cada pantalla actual tiene diagnostico y recomendacion;
- queda claro que el shell actual es prototipo, no arquitectura final;
- se define stack objetivo y estructura frontend;
- se define ruta de migracion sin romper contratos backend;
- no se habilitan mutaciones ni promesas de envio real.
