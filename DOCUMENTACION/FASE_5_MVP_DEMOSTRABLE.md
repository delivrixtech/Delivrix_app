# Fase 5: MVP demostrable

Fecha: 2026-05-03

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Fase anterior: `FASE_4_OPENCLAW_INFRAESTRUCTURA.md`.

## Objetivo

Demostrar Delivrix como control plane inteligente para gobernar capacidad preparada de mailing autorizado, sin enviar correo real y sin mutar infraestructura live.

La demo debe mostrar el recorrido completo:

```txt
Gateway -> Policy -> Queue -> Worker -> Sender Node -> Result Tracking -> Reputation -> Admin/OpenClaw
```

## Regla principal

Fase 5 no cambia el norte:

- Delivrix no envia email real en el MVP.
- OpenClaw no ejecuta infraestructura live.
- NFC sigue fuera del camino critico.
- La demo debe ser auditable, explicable y detenible con kill switch.

## Enfoque inteligente

La demo no debe sentirse como una cadena rigida de endpoints. Debe mostrar que el software entiende:

- que datos faltan;
- que gates estan pasando;
- que acciones estan permitidas;
- que acciones requieren humano;
- que acciones siguen prohibidas;
- que evidencia existe para avanzar;
- que debe detenerse si aparece riesgo.

## Hitos Fase 5

### Hito 5.0: Demo blueprint y revision de patrones

Estado: implementado. Detalle operativo en `HITO_5_0_DEMO_BLUEPRINT_REVISION_PATRONES.md`.

Objetivo:

- construir el contrato inteligente de la demo end-to-end antes de ejecutar estado local.

Entregables:

- blueprint MVP;
- revision de patrones de arquitectura;
- loop inteligente observe-decide-propose-approve-verify-stop;
- endpoint `POST /v1/demo/mvp/blueprint`;
- auditoria `demo.mvp_blueprint_created`;
- decision `ready_for_demo`, `needs_review` o `blocked`.

Gate:

- no ejecutar demo local si el blueprint esta bloqueado.

### Hito 5.1: Demo runner local

Estado: implementado. Detalle operativo en `HITO_5_1_DEMO_RUNNER_LOCAL.md`.

Objetivo:

- ejecutar una demo local-state-only del recorrido Gateway -> Queue -> Worker -> Sender Node -> Result Tracking.

Entregables esperados:

- seed controlado de sender node demo;
- send request autorizado;
- job en cola;
- procesamiento worker simulado;
- resultado simulado;
- reputacion/health evaluada;
- resumen operativo;
- auditoria enlazada por `demoRunId`.
- endpoint `POST /v1/demo/mvp/run`;
- reporte `5.1-demo-runner-local-state`.
- decision de demo basada en el sender node usado por el demo, sin contaminarse por incidentes historicos de otros nodos.

Gate:

- SMTP real sigue apagado.

### Hito 5.2: Demo OpenClaw con incidente simulado

Estado: implementado. Detalle operativo en `HITO_5_2_OPENCLAW_INCIDENTE_SIMULADO.md`.

Objetivo:

- mostrar OpenClaw detectando riesgo y proponiendo accion.

Entregables:

- escenario de bounce/complaint/deferred/failed;
- alert-ops propone accion;
- runbook evalua permiso;
- humano aprueba solo cambio local;
- kill switch bloquea cuando esta activo.
- endpoint `POST /v1/demo/openclaw/incident`;
- reporte `5.2-openclaw-incident-demo`;
- accion local de `quarantine` o `degrade` sobre sender node cuando corresponde.

Gate:

- ninguna accion live.

### Hito 5.3: Demo report final

Estado: implementado. Detalle operativo en `HITO_5_3_DEMO_REPORT_FINAL.md`.

Objetivo:

- empaquetar una salida ejecutiva para sponsor.

Entregables:

- reporte end-to-end;
- evidencia de auditoria;
- riesgos pendientes;
- ruta a produccion limitada;
- checklist de avance.
- endpoint `POST /v1/demo/mvp/final-report`;
- decision `ready_for_sponsor`, `needs_review` o `blocked`.

Gate:

- no prometer volumen, solo capacidad gobernada y condicionada por reputacion/warming.

### Hito 5.4: Admin panel visual MVP

Estado: documentado. Detalle operativo en `HITO_5_4_ADMIN_PANEL_VISUAL_ARQUITECTURA.md`.

Objetivo:

- definir el panel visual antes de implementarlo, con separacion estricta entre frontend y backend.

Entregables:

- stack frontend recomendado;
- estructura propuesta para `apps/admin-panel`;
- reglas de separacion frontend/backend;
- endpoints iniciales del Gateway;
- pantallas MVP;
- gates de seguridad, compliance y auditoria.

Gate:

- el panel inicia `GET-only`; no puede ejecutar mutaciones ni `POST` automaticos sin autenticacion, autorizacion, aprobacion humana y auditoria.

Subhito implementado:

- `HITO_5_4A_ADMIN_PANEL_READ_ONLY.md`: primer panel local, separado del backend, con proxy `GET-only`.
- `HITO_5_4B_ADMIN_PANEL_WORKFLOW.md`: workflow operativo expuesto por backend para evitar rutas hardcodeadas en frontend.
- `HITO_5_4C_ADMIN_CLUSTERS_OPENCLAW_LEARNING.md`: contratos backend para clusters/VPS y aprendizaje supervisado OpenClaw, consumidos por el panel.

## Criterio de salida de Fase 5

Fase 5 queda lista si:

- el sponsor puede ver una operacion controlada;
- hay trazabilidad de cada paso;
- OpenClaw explica riesgos y propone acciones;
- el kill switch detiene procesamiento;
- la demo no depende de NFC;
- no hay envio real;
- el panel visual tiene arquitectura documentada y no mezcla UI con reglas de dominio;
- el panel lee clusters/VPS y aprendizaje OpenClaw desde contratos backend;
- queda clara la ruta hacia ejecucion limitada futura.
