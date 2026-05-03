# Fase 3: Infraestructura propia piloto

Fecha: 2026-05-02

## Objetivo

Preparar Delivrix para operar sender nodes propios sobre Proxmox sin depender todavia de infraestructura real. Esta fase deja contratos estables, endpoints auditados y simulaciones completas para no frenar desarrollo mientras se valida hardware, red, IPs, DNS, seguridad y compliance.

Esta fase sigue en modo seguro:

- sin Proxmox API real.
- sin SSH real.
- sin Postfix real.
- sin OpenDKIM real.
- sin cambios DNS reales.
- sin SMTP real.
- sin S3 real.
- sin aumento de volumen.

## Hitos cubiertos

### Hito 3.1: ProxmoxAdapter mock e interfaz estable

Archivos principales:

- `packages/adapters/src/proxmox-adapter.ts`
- `packages/domain/src/sender-node-provisioning.ts`

El adapter expone:

- `planProvisioning`
- `simulateProvisioning`
- `toSenderNodeInput`
- `describeCapabilities`

Capacidades bloqueadas por diseno:

- crear VPS/LXC real.
- conectar por SSH.
- aplicar Postfix/OpenDKIM/TLS reales.
- publicar DNS real.
- enviar correo.
- aumentar volumen.

### Hito 3.2: Provisioning flow simulado

Flujo soportado:

1. crear VPS/LXC.
2. asignar IP.
3. configurar Postfix.
4. configurar OpenDKIM.
5. configurar TLS.
6. registrar DNS rutinario.
7. iniciar warming.

Todos los pasos quedan como plan o simulacion local. Un provisioning run puede registrar un sender node local en estado `warming`, pero no toca infraestructura externa.

Endpoints:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/proxmox/provisioning-plan \
  -H 'content-type: application/json' \
  -d '{"id":"sender_proxmox_001","label":"Proxmox Sender 001","hostname":"mx001.delivrix.local","ipAddress":"203.0.113.10","actorId":"operator_local"}'
```

```bash
curl -s -X POST http://127.0.0.1:3000/v1/proxmox/provisioning-runs/simulate \
  -H 'content-type: application/json' \
  -d '{"node":{"id":"sender_proxmox_001","label":"Proxmox Sender 001","hostname":"mx001.delivrix.local","ipAddress":"203.0.113.10"},"registerSenderNode":true,"actorId":"operator_local"}'
```

```bash
curl -s http://127.0.0.1:3000/v1/provisioning-runs
```

### Hito 3.3: IP reputation service inicial

Archivo principal:

- `packages/domain/src/ip-reputation.ts`

Evalua por sender node:

- sent.
- bounce.
- complaint.
- deferred.
- failed.
- bounce rate.
- complaint rate.
- deferred rate.
- senales externas mock como blacklist o manual review.

Endpoint de lectura:

```bash
curl -s http://127.0.0.1:3000/v1/ip-reputation/reports
```

Endpoint historico:

```bash
curl -s http://127.0.0.1:3000/v1/ip-reputation/history
```

### Hito 3.4: Cuarentena automatica por thresholds

Endpoint:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/ip-reputation/reconcile \
  -H 'content-type: application/json' \
  -d '{"signals":[{"senderNodeId":"sender_proxmox_001","type":"blacklist","source":"mock-rbl","severity":"critical","message":"Simulated blacklist hit"}],"actorId":"operator_local"}'
```

Reglas conservadoras:

- complaint `>= 1` recomienda `quarantined`.
- blacklist critica recomienda `quarantined`.
- bounce rate critico recomienda `quarantined`.
- warning reputacional recomienda `degraded`.
- nodos `retired` o `retired_pending_approval` no se reactivan ni cambian por reputacion.

La reconciliacion solo aplica cambios locales en `runtime/sender-nodes.json` y audita `ip_reputation.reconciled`.

### Hito 3.5: Acciones humanas de panel/admin

Acciones disponibles:

- `pause`
- `reactivate`
- `degrade`
- `quarantine`
- `approve-retirement`
- `activate-kill-switch`

Ejemplo de aprobacion de retiro:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sender-nodes/sender_proxmox_001/approve-retirement \
  -H 'content-type: application/json' \
  -d '{"reason":"Retiro aprobado despues de migracion","actorId":"operator_local"}'
```

Reglas:

- toda accion humana requiere `reason`.
- `approve-retirement` solo aplica desde `retired_pending_approval`.
- `quarantined` no se reactiva por el endpoint manual general.
- `retired` no se modifica por controles operativos.

Overview de Fase 3:

```bash
curl -s http://127.0.0.1:3000/v1/admin/phase-3-overview
```

### Hito 3.6: Backups iniciales con interfaz preparada

Archivo principal:

- `packages/domain/src/backup-plan.ts`

Recursos incluidos:

- audit events.
- sender nodes.
- send jobs.
- send results.
- suppression entries.
- rate limit counters.
- provisioning runs.
- IP reputation reports.

Endpoint de plan:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/backups/plan \
  -H 'content-type: application/json' \
  -d '{"targetKind":"local-dry-run"}'
```

Endpoint de simulacion:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/backups/simulate \
  -H 'content-type: application/json' \
  -d '{"targetKind":"local-dry-run"}'
```

Para `s3-compatible`, el contrato exige `bucket`, pero no ejecuta `put-object` real.

## Archivos runtime locales

Estos archivos son estado operativo local y no se suben a Git:

- `runtime/provisioning-runs.json`
- `runtime/ip-reputation-reports.json`
- `runtime/backup-simulations.json`

Se suman a los archivos runtime de Fase 1 y Fase 2.

## Verificacion

Suite completa:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Checks:

```bash
node --check apps/gateway-api/src/main.ts
node --check apps/worker/src/main.ts
```

Arranque local:

```bash
node apps/gateway-api/src/main.ts
```

Health:

```bash
curl -s http://127.0.0.1:3000/health
```

## Gate de salida

Fase 3 se considera lista para pasar a Fase 4 cuando:

- ProxmoxAdapter queda estable y testeado.
- provisioning flow completo funciona en simulacion.
- sender nodes Proxmox mock se registran en `warming`.
- reputacion IP genera reportes y puede reconciliar cuarentena/degradacion.
- acciones humanas criticas estan auditadas.
- backups tienen contrato y simulacion.
- ningun endpoint ejecuta cambios externos reales.

## Siguiente fase

La siguiente fase es OpenClaw MVP con integracion NFC documentada en `FASE_4_OPENCLAW_NFC_INTEGRACION.md`.

Correccion de alcance:

- NFC mantiene el envio real por ahora.
- Delivrix/OpenClaw construye onboarding inteligente, planner de clusters/VPS y bridge de capacidad.
- No se activa SMTP real ni se escribe en NFC produccion sin contrato, dry-run, auditoria y aprobacion humana.

Hitos principales:

- scheduler.
- skills iniciales.
- read-only primero.
- dry-run para acciones sensibles.
- verificacion post-ejecucion.
- rollback donde aplique.
- audit log para toda accion autonoma.
