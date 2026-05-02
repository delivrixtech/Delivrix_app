# Fase 2: Hito 2.12 Kill switch operativo local

Fecha: 2026-05-02

## Objetivo

Agregar una palanca operativa global para pausar el pipeline de envio en modo local, con persistencia, visibilidad y auditoria.

Este hito no envia correo real, no toca SMTP, no abre SSH y no modifica Webdock.

## Regla implementada

Cuando el kill switch esta activo:

- El Gateway rechaza nuevas solicitudes de envio antes de validarlas o encolarlas.
- El Worker no reclama jobs de la cola.
- El admin overview muestra alerta critica `kill_switch_active`.
- Cada activacion, desactivacion y bloqueo operativo queda auditado.

## Persistencia local

Archivo por defecto:

```bash
runtime/kill-switch.json
```

Variable configurable:

```bash
LOCAL_KILL_SWITCH_FILE=runtime/kill-switch.json
```

`runtime/` permanece fuera de Git porque contiene estado operativo local.

## Endpoints

Consultar estado:

```bash
GET /v1/kill-switch
```

Activar:

```bash
POST /v1/kill-switch
```

Payload:

```json
{
  "enabled": true,
  "reason": "Manual incident response",
  "actorId": "operator_local"
}
```

Desactivar:

```json
{
  "enabled": false,
  "reason": "Incident resolved",
  "actorId": "operator_local"
}
```

## Auditoria

Acciones registradas:

- `kill_switch.activated`
- `kill_switch.deactivated`
- `send_request.blocked_by_kill_switch`
- `worker.blocked_by_kill_switch`

Activar el kill switch usa `riskLevel = critical`. Desactivarlo usa `riskLevel = high` porque reanuda la capacidad operativa.

## Archivos principales

- `packages/domain/src/kill-switch.ts`
- `packages/local-store/src/local-file-kill-switch-store.ts`
- `apps/gateway-api/src/main.ts`
- `apps/worker/src/main.ts`
- `packages/domain/src/admin-overview.ts`

## Verificacion realizada

Comandos:

```bash
node --test packages/domain/src/*.test.ts
node --check apps/gateway-api/src/main.ts
node --check apps/worker/src/main.ts
```

Prueba local:

```bash
curl -s http://127.0.0.1:3000/v1/kill-switch
curl -s -X POST http://127.0.0.1:3000/v1/kill-switch \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"reason":"Manual incident response","actorId":"operator_local"}'
```

Resultado observado:

- `GET /v1/kill-switch` inicio en `enabled = false`.
- `POST /v1/kill-switch` activo la pausa con `reason = Manual incident response`.
- `/v1/admin/overview` incluyo alerta critica `kill_switch_active`.
- `POST /v1/send-requests` respondio `423` con `reason = kill_switch_active`.
- `node apps/worker/src/main.ts` no reclamo jobs y registro `worker.blocked_by_kill_switch`.
- `POST /v1/kill-switch` desactivo la pausa y dejo el estado final en `enabled = false`.

## Siguiente hito recomendado

**Hito 2.13: controles manuales de sender nodes**

Motivo: despues del kill switch global, necesitamos acciones granulares para pausar, degradar o reactivar sender nodes con auditoria y reglas de seguridad.
