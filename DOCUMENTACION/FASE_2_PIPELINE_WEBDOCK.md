# Fase 2: Pipeline operativo con Webdock

Fecha de inicio: 2026-05-02

## Hito 2.1 a 2.5 completados

Se construyo el puente inicial con Webdock en modo seguro y sin efectos externos.

## Que quedo implementado

- `SenderNodeRegistry` en dominio.
- Seleccion segura de sender nodes:
  - Solo `active` o `warming`.
  - Excluye `paused`, `quarantined`, `degraded`, `retired_pending_approval`.
  - Excluye nodos con `dailyLimit` igual a 0.
- Persistencia local de sender nodes en `runtime/sender-nodes.json`.
- `WebdockAdapter` seguro:
  - No abre SSH.
  - No modifica Postfix.
  - No envia correo.
  - No aumenta volumen.
  - Solo registra/lista/selecciona nodos para dry-run.
- Endpoints Gateway:
  - `GET /v1/sender-nodes`
  - `POST /v1/sender-nodes`
  - `POST /v1/webdock/bridge-nodes/seed`
- Worker actualizado:
  - Reclama jobs.
  - Busca sender node disponible.
  - Asigna `senderNodeId`.
  - Completa dry-run sin SMTP real.
  - Audita `send_job.sender_node_assigned`.

## Configuracion de ejemplo

Ver `config/webdock.nodes.example.json`.

Usa direcciones `203.0.113.x`, que son IPs de documentacion, no IPs reales.

## Verificacion realizada

1. Se sembraron tres nodos Webdock de ejemplo.
2. Se encolo un job comercial valido.
3. El Worker reclamo el job.
4. El Worker asigno `sender_webdock_bridge_001`.
5. El Worker completo el job en dry-run.
6. El audit log registro:
   - `webdock_bridge_nodes.seeded`
   - `send_request.accepted`
   - `send_job.claimed`
   - `send_job.sender_node_assigned`
   - `send_job.dry_run_completed`

## Lo que sigue

Hito 2.6 completado en `DOCUMENTACION/FASE_2_RATE_LIMITS.md`.
Hito 2.7 completado en `DOCUMENTACION/FASE_2_METRICAS_BASICAS.md`.
Hito 2.8 completado en `DOCUMENTACION/FASE_2_RESULTADOS_SIMULADOS.md`.
Hito 2.9 completado en `DOCUMENTACION/FASE_2_HEALTH_CHECKS.md`.
Hito 2.10 completado en `DOCUMENTACION/FASE_2_ADMIN_OVERVIEW.md`.
Hito 2.11 completado en `DOCUMENTACION/FASE_2_STUCK_JOB_RECOVERY.md`.
Hito 2.12 completado en `DOCUMENTACION/FASE_2_KILL_SWITCH.md`.

Siguiente hito recomendado: **Hito 2.13 controles manuales de sender nodes**.

Antes de cualquier envio real, faltan:

- Credenciales seguras.
- Confirmacion del proveedor y condiciones operativas.
- Bounce/complaint ingestion.
- Kill switch operativo.
- Modo supervised antes de cualquier efecto externo.
