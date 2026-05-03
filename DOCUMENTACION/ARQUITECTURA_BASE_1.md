# Arquitectura Base 1

Fecha: 2026-05-02

## Objetivo de esta base

Crear el primer esqueleto ejecutable de la plataforma Delivrix sin depender todavia de servicios externos. Esta base no envia correo real. Su objetivo es validar la ruta segura:

Gateway -> Policy Engine -> Audit Log -> Queue -> Worker seguro.

Esta base debe leerse bajo `NORTE_OPERATIVO_DELIVRIX.md`: el Gateway/Worker local valida contratos, politicas, auditoria y simulacion. No reemplaza el envio real de NFC en la fase actual.

## Decisiones tomadas

- El nucleo de dominio queda en `packages/domain`.
- La primera API queda en `apps/gateway-api`.
- El primer worker queda en `apps/worker`.
- La Fase 1 usa implementaciones en memoria para evitar bloquearse por PostgreSQL/Redis mientras se estabilizan los contratos.
- La cola real BullMQ, PostgreSQL y NestJS se integran en el siguiente incremento sin cambiar las reglas de dominio.

## Gates implementados desde el inicio

- Se bloquea un envio si el destinatario esta en suppression list.
- Se bloquea un envio comercial sin prueba de autorizacion.
- Se bloquea un envio comercial sin URL de unsubscribe.
- Se bloquea un envio comercial sin direccion fisica.
- Se bloquea un envio sin asunto, remitente o dominio.
- Toda aceptacion o rechazo queda auditada.

## Siguiente incremento recomendado

1. Sustituir in-memory audit log por PostgreSQL append-only.
2. Sustituir in-memory queue por Redis/BullMQ.
3. Migrar el Gateway HTTP minimo a NestJS.
4. Agregar persistencia de suppression list.
5. Crear migraciones iniciales de base de datos.

## Hito 1.2 agregado

Se agrego el modelo PostgreSQL inicial en `infra/postgres/migrations`.

Tablas principales:

- `operators`
- `campaigns`
- `recipients`
- `consent_proofs`
- `suppression_entries`
- `ip_addresses`
- `sender_nodes`
- `send_jobs`
- `send_results`
- `audit_events`

El audit log incluye triggers `BEFORE UPDATE` y `BEFORE DELETE` para mantenerlo append-only.

## Hito 1.3 agregado

Se agrego una cola local compartida en `packages/queue`:

- `LocalFileSendQueue` escribe en `runtime/send-jobs.json`.
- El Gateway encola jobs validos usando ese adaptador.
- El Worker puede reclamar un job y completarlo en modo dry-run.

Esta cola no es para produccion. Sirve para validar el contrato Gateway -> Queue -> Worker antes de conectar Redis/BullMQ.

## Hito 1.4 agregado

El Gateway ahora usa repositorios locales persistentes:

- `LocalFileAuditLog`
- `LocalFileSuppressionList`

Tambien se agregaron endpoints para gestionar suppression entries:

- `GET /v1/suppression-entries`
- `POST /v1/suppression-entries`

Esto mantiene la regla central: si un destinatario esta suprimido por unsubscribe, complaint, hard bounce, bloqueo manual o legal, el policy engine bloquea el job antes de encolarlo.

## Hito 1.5 agregado

El Worker queda conectado a la cola local compartida:

- Reclama el siguiente job `queued`.
- Lo pasa a `processing`.
- No ejecuta SMTP real en Base 1.
- Marca el job como `completed` en dry-run.
- Registra auditoria `send_job.claimed` y `send_job.dry_run_completed`.

Con esto queda probado el flujo Base 1:

Gateway -> Policy Engine -> Audit Log -> Queue -> Worker -> Audit Log.

## Fase 2 iniciada

El puente Webdock en modo seguro queda documentado en `DOCUMENTACION/FASE_2_PIPELINE_WEBDOCK.md`.
