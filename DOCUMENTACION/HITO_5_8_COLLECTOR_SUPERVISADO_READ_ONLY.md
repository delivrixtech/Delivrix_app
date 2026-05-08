# Hito 5.8: Collector supervisado read-only

Fecha: 2026-05-08

Documentos rectores:

- `RESUMEN_RUTA_PROYECTO.md`
- `HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md`
- `HITO_5_6_CONTRATOS_CANVAS_HARDWARE_ML_DEVOPS.md`
- `HITO_5_7_ADMIN_PANEL_REACT_CANVAS.md`

## Objetivo

Preparar el camino para que Delivrix deje de depender de mocks de hardware y empiece a recibir evidencia real supervisada, sin activar acciones live.

Este hito no instala agentes en produccion ni ejecuta comandos remotos. Define y expone el contrato que ordena:

- que fuentes read-only puede usar el collector;
- que permisos minimos necesita cada fuente;
- que datos debe recolectar;
- que falta para dejar de estar en mock;
- como se auditan y redaccionan los snapshots;
- que acciones siguen bloqueadas por seguridad.

## Regla principal

Hito 5.8 sigue siendo `GET-only` desde el admin panel.

No habilita:

- SSH automatico;
- escritura Proxmox;
- power actions via IPMI;
- DNS live changes;
- SMTP real;
- NFC writes;
- almacenamiento de secretos en snapshots;
- ingestion automatica desde la UI.

## Contrato nuevo

Endpoint:

```txt
GET /v1/devops/collector/supervised-plan
```

Respuesta:

```txt
supervisedCollector
```

El contrato declara:

- `collectorMode: supervised_read_only`;
- `status`;
- fuentes `local`, `proxmox`, `prometheus` e `ipmi`;
- transporte seguro por fuente;
- permisos minimos;
- frescura por fuente;
- bloqueos por fuente;
- politica de ingestion;
- politica de auditoria;
- gates;
- siguientes acciones seguras;
- acciones bloqueadas.

## Fuentes contempladas

### Local hardware snapshot

Uso: inventario inicial del servidor fisico.

Datos esperados:

- CPU cores/threads;
- RAM total;
- storage usable;
- interfaces de red;
- kernel;
- uptime.

Estado inicial: `needs_review`.

### Proxmox read-only API

Uso: lectura de version, nodos, storage y conteo de LXC/VM.

Estado inicial: `blocked`.

Bloqueos:

- endpoint faltante;
- token read-only faltante;
- aprobacion humana requerida.

### Prometheus / Node Exporter

Uso: metricas de CPU, memoria, storage, red y sensores.

Estado inicial: `blocked`.

Bloqueos:

- Node Exporter no confirmado;
- URL Prometheus faltante.

### IPMI / Redfish

Uso: energia, temperatura, ventiladores y chasis si el hardware lo soporta.

Estado inicial: `blocked`.

Bloqueos:

- capacidad del hardware no confirmada;
- red BMC faltante;
- credenciales read-only faltantes.

## Auditoria y redaccion

Todo snapshot real futuro debe:

- generar evento append-only;
- tener hash de snapshot;
- redaccionar secretos;
- rechazar `private_key`, `password`, `token`, `secret`, `smtp_credentials` y `ssh_private_key`;
- conservar solo campos operativos no sensibles.

## Frontend reforzado

El admin panel ahora tiene seccion `Collector`.

La UI muestra:

- estado del plan supervisado;
- fuentes read-only;
- permisos minimos;
- transporte por fuente;
- frescura;
- bloqueos;
- politica de ingestion;
- politica de auditoria;
- gates;
- siguientes acciones seguras;
- acciones bloqueadas.

La UI sigue sin ejecutar comandos ni mutaciones.

## Cambios de codigo

Backend/domain:

- `packages/domain/src/supervised-collector-plan.ts`
- tests `hito-5-8-supervised-collector.test.ts`
- operating north actualizado a fase `5.8-supervised-collector-read-only`
- workflow del panel incluye paso `collector`

Gateway:

- `GET /v1/devops/collector/supervised-plan`
- health expone `supervisedCollectorPlanEnabled`

Frontend:

- read boundary incluye el nuevo endpoint;
- cliente TypeScript consume `supervisedCollector`;
- nueva seccion visual `Collector`;
- topbar muestra estado del collector;
- proxy local conserva bloqueo de metodos no `GET`.

## Criterio de cierre

Hito 5.8 queda cerrado si:

- el contrato supervisado existe y es `read_only`;
- todas las fuentes declaran `readOnly: true`;
- todas las colecciones declaran `writesEnabled: false`;
- las acciones live siguen bloqueadas;
- el panel renderiza la seccion Collector desde backend;
- los tests de dominio y admin panel pasan;
- la documentacion queda alineada.

## Que sigue

Hito 5.9 recomendado:

- ingestion manual auditada de un snapshot local redaccionado;
- hash y audit event del snapshot;
- parser seguro para convertir snapshot en `physical-host` y `telemetry`;
- sin UI write automatico;
- sin SSH automatico.
