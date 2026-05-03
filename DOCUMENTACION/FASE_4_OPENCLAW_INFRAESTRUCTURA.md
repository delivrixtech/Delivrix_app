# Fase 4: OpenClaw MVP para infraestructura propia

Fecha: 2026-05-02

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Hito de alineacion: `HITO_4_0_ALINEACION_CONTROL_PLANE.md`.

## Enfoque

Fase 4 construye el primer OpenClaw util: una IA operativa que actua como un operador tecnico guiado para preparar infraestructura propia de mailing sobre un servidor fisico.

El foco no es conectar NFC. El foco es:

- onboarding inteligente;
- diseno de clusters;
- planificacion de VPS/LXC;
- preparacion de sender nodes;
- Postfix, OpenDKIM, TLS y DNS;
- warming;
- reputacion;
- auditoria, aprobaciones y kill switch.

NFC fue revisado para entender un sistema externo que podria consumir esta capacidad mas adelante. En el MVP, NFC no dirige la fase y no es dependencia operativa.

## Que debe hacer OpenClaw en esta fase

OpenClaw debe comportarse como un operador humano asistido por IA:

1. pregunta lo necesario;
2. entiende el servidor fisico y sus restricciones;
3. valida riesgos;
4. propone una topologia;
5. genera planes dry-run;
6. explica que falta;
7. pide aprobacion antes de cualquier accion real;
8. registra auditoria de decisiones;
9. prepara la base para ejecutar infraestructura real en una fase posterior.

## Alcance principal

### 1. Onboarding inteligente

OpenClaw debe recopilar y validar:

- modelo y estado del servidor fisico;
- CPU, RAM, discos, red, temperatura y UPS;
- Proxmox disponible o pendiente;
- IPs disponibles, tipo de IP y reputacion inicial;
- dominios y subdominios;
- acceso DNS;
- limites iniciales por VPS/IP/dominio;
- objetivo de capacidad;
- restricciones legales, proveedor e ISP;
- nivel de autonomia permitido.

El onboarding debe generar un snapshot auditable.

### 2. Topology planner

Con la informacion del onboarding, OpenClaw debe proponer:

- cantidad inicial de VPS/LXC;
- recursos por nodo;
- asignacion IP/dominio;
- hostname por sender node;
- limites de warming;
- orden de creacion;
- riesgos;
- gates antes de avanzar.

### 3. Provisioning plan

OpenClaw debe generar un plan dry-run para:

- crear VPS/LXC en Proxmox;
- asignar IP;
- preparar Postfix;
- preparar OpenDKIM;
- preparar TLS;
- preparar DNS rutinario;
- iniciar warming.

En MVP, el plan no debe tocar infraestructura real sin aprobacion humana explicita.

### 4. Warming y reputacion

OpenClaw debe preparar reglas para:

- limites por sender node;
- limites por IP;
- limites por dominio;
- crecimiento progresivo;
- deteccion de bounces, complaints, deferred y blacklist;
- pausa, degradacion o cuarentena;
- reportes diarios.

### 5. Operacion segura

OpenClaw debe incluir:

- scheduler;
- skills `fleet-ops`, `alert-ops`, `report-ops`;
- LLM router con modo degradado sin LLM;
- action executor en dry-run;
- verificacion post-ejecucion;
- rollback donde aplique;
- presupuesto diario de IA;
- audit log;
- kill switch.

## NFC en esta fase

NFC queda como integracion futura opcional.

Reglas:

- no se escribe en NFC;
- no se llama API real de NFC;
- no se crean providers reales;
- no se activan SMTP servers;
- no se depende del desarrollador de NFC para completar el MVP;
- el bridge queda apagado o en mock para referencia futura.

Modo recomendado:

```txt
NFC_BRIDGE_MODE=disabled   # default MVP
NFC_BRIDGE_MODE=mock       # solo genera payloads de referencia
NFC_BRIDGE_MODE=supervised # futuro, con API real y aprobacion humana
```

El conocimiento de NFC se conserva porque mas adelante Delivrix puede conectarse con ese sistema mediante API/bridge, pero no forma parte del camino critico de Fase 4.

## Hitos Fase 4

### Hito 4.1: OpenClaw intelligent onboarding

Estado: implementado. Detalle operativo en `HITO_4_1_OPENCLAW_ONBOARDING.md`.

Objetivo:

- construir el flujo de onboarding inteligente para infraestructura propia.

Entregables:

- schema de onboarding;
- preguntas guiadas;
- validadores;
- snapshot auditable;
- reporte de faltantes;
- decision Go/No-Go.
- endpoint `GET /v1/openclaw/onboarding/questionnaire`;
- endpoint `POST /v1/openclaw/onboarding/evaluate`;
- auditoria `openclaw_onboarding.evaluated`.

Gate:

- no generar plan de clusters si faltan datos criticos.

### Hito 4.2: Cluster topology planner

Estado: implementado. Detalle operativo en `HITO_4_2_CLUSTER_TOPOLOGY_PLANNER.md`.

Objetivo:

- convertir el onboarding en un plan tecnico de VPS/LXC.

Entregables:

- plan de clusters;
- sizing por nodo;
- asignacion IP/dominio;
- orden de provisioning;
- limites iniciales;
- riesgos por recurso.
- endpoint `POST /v1/openclaw/topology/plan`;
- auditoria `openclaw_topology.plan_created`.

Gate:

- no prometer volumen; solo capacidad estimada y condicionada por warming/reputacion.

### Hito 4.3: Provisioning dry-run executor

Estado: implementado. Detalle operativo en `HITO_4_3_PROVISIONING_DRY_RUN.md`.

Objetivo:

- convertir el topology plan en acciones dry-run.

Entregables:

- plan Proxmox;
- plan Postfix;
- plan OpenDKIM;
- plan TLS;
- plan DNS;
- plan warming.
- endpoint `POST /v1/openclaw/provisioning/dry-run`;
- auditoria `openclaw_provisioning.dry_run_created`.

Gate:

- ninguna accion real sin aprobacion humana.

### Hito 4.4: OpenClaw scheduler y skills

Estado: implementado. Detalle operativo en `HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md`.

Objetivo:

- crear el loop operativo inicial de OpenClaw.

Entregables:

- scheduler;
- `fleet-ops`;
- `alert-ops`;
- `report-ops`;
- LLM router;
- modo sin LLM;
- reporte diario.
- endpoint `POST /v1/openclaw/scheduler/run`;
- auditoria `openclaw_scheduler.run_simulated`.

Gate:

- OpenClaw primero observa, reporta y propone.

### Hito 4.5: Runbook, permisos y kill switch

Objetivo:

- cerrar Fase 4 con reglas operativas claras.

Entregables:

- matriz de permisos;
- lista de acciones permitidas;
- lista de acciones que requieren aprobacion;
- lista de acciones prohibidas;
- kill switch probado;
- runbook operativo;
- checklist de produccion limitada.

Gate:

- no pasar a ejecucion real si no hay auditoria, aprobacion humana y kill switch.

### Hito futuro: bridge NFC opcional

Objetivo:

- mantener una puerta tecnica para conectar con NFC despues del MVP.

Estado:

- fuera del camino critico;
- apagado por defecto;
- mock solamente;
- no bloquea OpenClaw ni infraestructura.

## Acciones permitidas en Fase 4

- Leer inventario local y simulado.
- Hacer preguntas de onboarding.
- Validar datos.
- Generar planes de clusters.
- Generar planes de provisioning.
- Generar planes de warming.
- Ejecutar scheduler OpenClaw en modo observador.
- Ejecutar skills `fleet-ops`, `alert-ops` y `report-ops` en dry-run.
- Generar reporte diario.
- Detectar riesgos.
- Proponer acciones.
- Simular acciones.
- Registrar auditoria.

## Acciones prohibidas sin aprobacion explicita

- Crear o destruir VPS reales.
- Conectarse por SSH a servidores productivos.
- Modificar DNS real.
- Activar SMTP real.
- Enviar emails.
- Purgar colas.
- Rotar IPs para sostener volumen.
- Escribir en NFC.
- Activar bridge NFC real.
- Subir secretos al repo.

## Criterio de salida

Fase 4 queda lista cuando:

- existe onboarding inteligente;
- existe topology planner;
- OpenClaw genera planes dry-run;
- OpenClaw registra auditoria;
- los gates bloquean acciones peligrosas;
- el kill switch esta probado;
- NFC queda documentado como integracion futura opcional, no como dependencia MVP.
