# Hito 5.4: Admin panel visual MVP

Fecha: 2026-05-03

Propiedad: Delivrix LLC.
Desarrollado por JECT.

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Documento de fase: `FASE_5_MVP_DEMOSTRABLE.md`.
Hito anterior: `HITO_5_3_DEMO_REPORT_FINAL.md`.

## Objetivo

Definir la arquitectura del panel visual de Delivrix antes de implementarlo.

Este hito existe para evitar un error comun: construir pantallas que terminen mezclando UI, reglas de negocio, lectura directa de estado local, permisos, decisiones de OpenClaw y acciones de infraestructura.

El panel visual debe ser una consola operativa clara para entender el sistema, no un segundo backend dentro del navegador.

## Regla principal

El frontend no decide operaciones criticas.

El frontend:

- muestra estado;
- permite explorar evidencia;
- prepara solicitudes;
- muestra gates, alertas y decisiones;
- exige confirmacion humana cuando aplique.

El backend:

- valida;
- autoriza;
- evalua politicas;
- calcula decisiones;
- escribe auditoria;
- aplica kill switch;
- controla adaptadores;
- mantiene dry-run o live mode segun permisos.

## Stack recomendado

La decision tecnica para el panel visual MVP es:

| Capa | Tecnologia | Uso |
| --- | --- | --- |
| App frontend | Vite + React + TypeScript | desarrollo rapido, build simple, tipado estricto |
| UI base | Tailwind CSS + shadcn/ui + Radix UI | componentes accesibles, composables y personalizables |
| Iconos | Lucide React | iconografia consistente para operaciones |
| Server state | TanStack Query | cache, loading, retry, invalidacion y refetch controlado |
| Routing | TanStack Router | rutas tipadas y escalables |
| Tablas | TanStack Table | sender nodes, jobs, audit log y reportes densos |
| Charts iniciales | Recharts | metricas simples y rapidas para MVP |
| Charts avanzados futuro | Apache ECharts | flotas grandes, series complejas y analitica pesada |
| Formularios | React Hook Form + Zod | validacion explicita antes de llamar API |
| Tests frontend | Vitest + Testing Library | componentes, hooks y transformadores |
| E2E visual | Playwright | flujos reales, responsive y regresion visual |

Principio: empezar simple con Recharts y componentes propios sobre shadcn/ui. Migrar a ECharts solo cuando la densidad de datos lo justifique.

## Ubicacion propuesta

```txt
apps/
  admin-panel/
    package.json
    index.html
    src/
      app/
        routes/
        providers/
        layout/
      features/
        overview/
        openclaw/
        sender-nodes/
        jobs/
        audit-log/
        reports/
        settings/
      shared/
        api/
        config/
        lib/
        types/
        ui/
```

## Separacion frontend/backend

### Frontend permitido

- Consumir endpoints versionados del Gateway (`/v1/...`).
- Usar DTOs o schemas de contrato, no servicios de dominio.
- Transformar datos solo para presentacion.
- Mantener estado local de UI: filtros, tabs, modales, orden de tablas.
- Usar TanStack Query para server state.
- Mostrar errores del backend sin ocultar la razon operativa.
- Renderizar estados `loading`, `empty`, `error`, `blocked`, `degraded`, `ready`.

### Frontend prohibido

- Leer archivos de `runtime/` directamente.
- Importar stores locales, adaptadores o servicios de dominio ejecutables.
- Duplicar reglas del `mail-policy-engine`.
- Decidir `go/no-go`, cuarentena, permisos OpenClaw o readiness.
- Guardar secretos, tokens SSH, credenciales SMTP o llaves privadas.
- Ejecutar SSH, DNS live, SMTP, Proxmox live o NFC production writes.
- Simular exito cuando el backend responde `blocked` o `needs_review`.

### Backend responsable

- Gateway API expone contratos versionados.
- Dominio calcula decisiones, gates y riesgos.
- Stores/adaptadores quedan detras del backend.
- Audit log registra toda accion humana, simulada o autonoma.
- Kill switch bloquea operaciones antes de que el frontend pueda forzarlas.
- OpenClaw sigue bajo matriz de permisos y runbook.

## Contratos API

El panel visual MVP debe iniciar con endpoints existentes:

| Vista | Endpoint inicial | Modo |
| --- | --- | --- |
| Health | `GET /health` | read-only |
| Overview operativo | `GET /v1/admin/overview` | read-only |
| Norte operativo | `GET /v1/operating-north` | read-only |
| Demo final | `POST /v1/demo/mvp/final-report` | genera reporte local auditado |
| Kill switch | `GET /v1/kill-switch` | read-only inicial |

Antes de habilitar mutaciones desde UI, deben existir:

- autenticacion;
- roles/permisos;
- confirmacion humana explicita;
- auditoria con `actorId`;
- proteccion CSRF/CORS cuando aplique;
- contrato de errores estable;
- pruebas E2E del flujo bloqueado y permitido.

## Contrato de errores recomendado

Las respuestas de error deben tender a una forma estable:

```json
{
  "error": {
    "code": "OPENCLAW_ACTION_BLOCKED",
    "message": "Action is blocked by kill switch.",
    "severity": "high",
    "reason": "kill_switch_enabled",
    "auditEventId": "audit_x"
  }
}
```

El frontend puede traducir y presentar el error, pero no debe reinterpretar la decision.

## Pantallas MVP

### 1. Overview

- estado general;
- health del Gateway;
- resumen operativo;
- alertas principales;
- gates activos;
- estado del kill switch.

### 2. OpenClaw

- fase actual;
- onboarding status;
- topology plan status;
- provisioning dry-run status;
- scheduler/report status;
- acciones permitidas, supervisadas y prohibidas.

### 3. Sender nodes

- tabla densa de nodos;
- estado;
- warming;
- reputacion;
- capacidad estimada;
- razones de bloqueo.

### 4. Jobs y resultados

- cola;
- estados;
- ultimos resultados simulados;
- bounces, complaints, deferred, failed.

### 5. Auditoria

- timeline de eventos;
- actor;
- accion;
- severidad;
- relacion con demoRunId o entidad.

### 6. Reportes

- reporte final MVP;
- evidencia 5.0, 5.1 y 5.2;
- riesgos residuales;
- gates hacia produccion limitada.

### 7. Configuracion segura

- entorno;
- API base URL;
- modo dry-run/live;
- integraciones externas visibles como apagadas o mock.

## Buenas practicas de componentes

- Las paginas componen features; no contienen logica pesada.
- Los componentes UI no conocen endpoints.
- Los hooks de datos viven cerca de cada feature.
- Los clientes API viven en `shared/api`.
- Las query keys son constantes, no strings sueltos repetidos.
- Las tablas tienen columnas tipadas y estados vacios profesionales.
- Las acciones peligrosas usan dialogos con motivo obligatorio.
- Los badges de estado usan vocabulario del backend.
- El panel debe ser denso, sobrio y operativo, no una landing page.

## Estado y cache

Regla:

- TanStack Query maneja server state.
- React state maneja estado visual local.
- No se agrega store global hasta que exista una necesidad real.

No duplicar en frontend:

- sender node registry;
- rate limits;
- kill switch;
- audit log;
- decisiones OpenClaw.

## Seguridad y compliance

El panel no debe exponer:

- claves SSH;
- passwords;
- tokens;
- SMTP credentials;
- secretos de proveedores;
- payloads NFC sensibles;
- llaves privadas;
- datos personales innecesarios.

El panel debe mostrar:

- que el MVP no envia correo real;
- que NFC esta apagado/mock;
- que infraestructura live esta bloqueada;
- que produccion limitada requiere gates adicionales;
- que toda accion futura debe quedar auditada.

## Testing requerido

Para considerar cerrado el hito de implementacion visual:

- build frontend exitoso;
- tests unitarios de componentes criticos;
- tests de transformadores API;
- test E2E de carga del dashboard;
- test visual desktop y mobile;
- verificacion de que no hay llamadas fuera de `/health` y `/v1/...`;
- verificacion de estados `loading`, `error`, `empty` y `blocked`;
- verificacion de que no se muestran secretos.

## Gates

El panel visual no puede considerarse listo si:

- llama adaptadores o runtime directo;
- reimplementa reglas de negocio;
- oculta estados bloqueados;
- permite mutaciones sin autenticacion y auditoria;
- promete envio real o volumen;
- trata NFC como dependencia del MVP;
- permite acciones OpenClaw fuera del runbook.

## Criterio de salida documental

Este hito documental queda cerrado si:

- existe arquitectura frontend/backend documentada;
- queda definido el stack visual;
- queda definida la estructura de carpetas;
- quedan claras las responsabilidades por capa;
- quedan definidos endpoints iniciales;
- quedan documentados gates de seguridad;
- README, roadmap, resumen y estandares apuntan al hito.

## Que sigue

Siguiente incremento sugerido:

`Hito 5.4A: scaffolding admin-panel read-only`.

Ese incremento debe crear `apps/admin-panel`, conectar solo endpoints read-only del Gateway y levantar el primer dashboard local sin mutaciones.
