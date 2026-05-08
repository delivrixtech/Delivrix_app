# Hito 5.5A: Canvas OpenClaw y telemetria de hardware

Fecha: 2026-05-08

Documentos rectores:

- `NORTE_OPERATIVO_DELIVRIX.md`
- `HITO_5_5_AUDITORIA_FRONTEND_UI_PROCESOS.md`
- `FASE_4_OPENCLAW_INFRAESTRUCTURA.md`
- `FASE_3_INFRAESTRUCTURA_PROPIA.md`

## Objetivo

Complementar la propuesta frontend con una capa esencial: OpenClaw no solo debe responder preguntas o mostrar tablas. Debe poder operar por debajo y, cuando convenga, mostrar un canvas vivo donde el operador vea como avanza el onboarding, que esta configurando, que detecta del servidor fisico y que bloqueos impiden continuar.

Esto convierte el panel en una consola operacional visual, no solo en un dashboard.

## Decision de producto

Delivrix necesita dos modos visuales para OpenClaw:

1. **Modo silencioso**: OpenClaw trabaja por debajo, analiza evidencia, propone acciones y actualiza estados.
2. **Modo canvas vivo**: OpenClaw muestra visualmente el proceso: servidor fisico -> Proxmox -> clusters -> VPS/LXC -> sender nodes -> warming -> reputacion.

El operador debe poder entender el sistema sin leer logs crudos ni inspeccionar servidores manualmente.

## Que debe mostrar el canvas

El canvas debe responder estas preguntas:

- en que fase del onboarding estamos;
- que datos faltan del servidor fisico;
- que hardware existe y cuanto recurso queda;
- que esta midiendo OpenClaw;
- que clusters/VPS se estan planeando;
- que pasos de configuracion van listos;
- que riesgos bloquean avanzar;
- que requiere aprobacion humana;
- que queda apagado por seguridad;
- como se transforma el servidor fisico en infraestructura preparada.

## Mapa visual esperado

```txt
Servidor fisico
  -> Hardware telemetry
  -> Proxmox host
  -> Cluster plan
  -> VPS/LXC plan
  -> Sender nodes
  -> DNS / PTR / DKIM / TLS
  -> Warming
  -> Reputation gates
  -> Capacidad preparada
```

El canvas no debe ejecutar acciones por si mismo. Debe mostrar estado, evidencia, riesgos y propuestas.

## Telemetria de hardware requerida

El sistema debe conocer el estado interno del servidor fisico y sus recursos. Como minimo:

### Identidad del servidor

- modelo;
- serial/tag interno si aplica;
- ubicacion;
- sistema operativo;
- version de kernel;
- version Proxmox cuando exista;
- uptime.

### CPU

- modelo;
- sockets;
- cores/hilos;
- uso actual;
- carga promedio;
- temperatura si el sensor esta disponible;
- capacidad reservada para Proxmox/control plane.

### Memoria

- RAM total;
- RAM disponible;
- RAM usada;
- swap;
- memoria reservada por VM/LXC;
- margen seguro antes de crear nuevos VPS.

### Almacenamiento

- discos detectados;
- tipo: HDD/SSD/NVMe si se puede inferir;
- SMART health;
- capacidad total/usada/libre;
- IO wait;
- estado de RAID/ZFS/LVM si aplica;
- espacio reservado para logs/backups.

### Red

- interfaces;
- velocidad de enlace;
- IPs asignadas;
- gateway;
- throughput actual;
- errores/drops;
- latencia basica;
- disponibilidad de IP pool.

### Energia y fisico

Depende del soporte del hardware, pero el diseño debe contemplar:

- consumo energetico aproximado o reportado;
- estado de fuentes de poder;
- sensores de voltaje si existen;
- ventiladores;
- temperatura ambiente/chasis;
- estado UPS si existe;
- eventos de apagado/reinicio.

En servidores IBM/Lenovo antiguos, parte de esta informacion puede venir de IMM/IPMI/Redfish si esta disponible. Si no existe acceso, el sistema debe marcar esos campos como `unknown`, no inventarlos.

## Coleccion de datos propuesta

### MVP local/mock

- contrato backend read-only con datos simulados o capturados manualmente;
- sin SSH automatico;
- sin modificar Proxmox;
- sin recolectar secretos.

### Fase supervised

- agente ligero instalado en el servidor fisico;
- lectura local de `/proc`, `lsblk`, `smartctl`, `sensors`, `ip`, `uptime`, Proxmox API read-only;
- envio de snapshots al Gateway;
- auditoria de cada snapshot recibido;
- sanitizacion antes de mostrar datos.

### Fase avanzada

- Prometheus Node Exporter;
- Proxmox exporter;
- IPMI/Redfish exporter si el hardware lo permite;
- alertas por thresholds;
- series historicas;
- correlacion con decisiones OpenClaw.

## Contratos backend necesarios

El frontend no debe leer hardware directamente. Debe consumir contratos del Gateway.

Endpoints sugeridos:

```txt
GET /v1/hardware/physical-host
GET /v1/hardware/telemetry/latest
GET /v1/hardware/telemetry/history
GET /v1/openclaw/live-canvas
GET /v1/openclaw/onboarding/state
GET /v1/openclaw/provisioning/state
```

Todos deben iniciar `GET-only`.

## Contrato del canvas

`GET /v1/openclaw/live-canvas` deberia devolver un grafo, no HTML:

```json
{
  "canvas": {
    "mode": "read_only",
    "nodes": [],
    "edges": [],
    "timeline": [],
    "currentStep": "hardware_discovery",
    "blockedBy": [],
    "requiresHumanApproval": [],
    "safety": {
      "liveInfrastructureWritesEnabled": false,
      "sshEnabled": false,
      "smtpEnabled": false
    }
  }
}
```

El frontend puede usar ese grafo para renderizar un canvas interactivo, pero no debe construir la logica de negocio.

## Tecnologias frontend para el canvas

Sugerencia:

- **React Flow** para grafo/canvas operativo.
- **TanStack Query** para refrescar snapshots.
- **SSE o WebSocket futuro** para eventos en vivo.
- **Recharts/ECharts** para metricas historicas.
- **TanStack Table** para drill-down tecnico.

Regla: el canvas debe ser utilitario, denso y operacional. No debe parecer landing page ni animacion decorativa.

## Estados visuales obligatorios

Cada nodo del canvas debe tener:

- `unknown`;
- `not_started`;
- `collecting`;
- `ready`;
- `needs_review`;
- `blocked`;
- `requires_approval`;
- `disabled_by_mvp`;
- `error`.

## OpenClaw: que se ve vs que pasa por debajo

OpenClaw puede trabajar por debajo:

- leyendo contratos;
- evaluando readiness;
- proponiendo preguntas;
- generando planes;
- comparando plan vs capacidad real;
- detectando riesgos.

El canvas muestra:

- que observo;
- que concluyo;
- que paso propone;
- que evidencia uso;
- que no puede hacer todavia.

No debe mostrar:

- secretos;
- llaves SSH;
- tokens;
- comandos con credenciales;
- payloads sensibles;
- datos personales innecesarios.

## Riesgos

- Mostrar un canvas bonito sin telemetria real puede crear falsa confianza.
- Medir hardware sin permisos/read-only puede abrir riesgo de seguridad.
- Mezclar UI con comandos SSH seria un error grave.
- Inventar consumo energetico cuando el hardware no lo reporta seria peligroso.
- OpenClaw no debe "parecer" que ejecuto algo si solo hizo dry-run.

## Recomendacion de implementacion

Antes de migrar todo el panel, agregar contratos backend de lectura:

1. `HardwareInventorySnapshot`.
2. `HardwareTelemetrySnapshot`.
3. `OpenClawCanvasSnapshot`.

Luego el frontend React puede renderizar:

- Onboarding visual;
- Live Canvas;
- Hardware Health;
- Capacity Planning;
- Proxmox/VPS readiness.

## Hitos sugeridos

### Hito 5.6: Contratos de hardware y canvas read-only

- dominio para hardware inventory;
- dominio para telemetry snapshot;
- dominio para OpenClaw canvas graph;
- endpoints `GET`;
- datos mock seguros;
- tests.

### Hito 5.7: UI React base con canvas

- migracion React/Vite/TypeScript;
- React Flow para canvas;
- TanStack Query;
- pantalla Onboarding + Hardware + Canvas;
- sin mutaciones.

### Hito 5.8: Telemetria real supervisada

- agente read-only o collector;
- Proxmox API read-only;
- Node Exporter/Prometheus si aplica;
- IPMI/Redfish si el hardware lo soporta;
- auditoria y sanitizacion.

## Criterio de salida

Este hito queda claro si:

- el frontend ya contempla un canvas operativo vivo;
- la telemetria de hardware queda como requisito de producto;
- OpenClaw puede operar oculto o visible;
- el canvas depende de contratos backend, no de logica frontend;
- no se habilitan SSH, Proxmox live, DNS live ni SMTP real;
- los datos desconocidos se muestran como `unknown`, no se inventan.
