# Fase 2: Hito 2.6 Rate limits

Fecha: 2026-05-02

## Objetivo

Agregar limites de volumen antes de cualquier integracion real con Webdock o SMTP.

El objetivo no es maximizar envio; es impedir que la plataforma avance si supera limites diarios definidos.

## Alcance implementado

Se agrego `RateLimitService` en dominio con soporte para:

- `campaign`: limite diario por campana.
- `sender_domain`: limite diario por dominio remitente.
- `recipient_domain`: limite diario por dominio destinatario.
- `sender_node`: limite diario por nodo de envio.

## Comportamiento

### Gateway

El Gateway ejecuta precheck antes de encolar:

- campana.
- dominio remitente.
- dominio destinatario.

Si alguno excede limite, devuelve `429` y audita `send_request.rate_limited`.

### Worker

El Worker ejecuta enforcement al procesar:

- campana.
- dominio remitente.
- dominio destinatario.
- sender node asignado.

Si pasa, consume contadores y completa dry-run.  
Si falla, marca el job como `blocked` y audita `send_job.rate_limited`.

## Persistencia local

Los contadores se guardan en:

- `runtime/rate-limit-counters.json`

Este mecanismo es de desarrollo. Para produccion, el consumo de limites debe moverse a PostgreSQL con transacciones o Redis/BullMQ con locking atomico.

## Variables

Configurables en `.env.example`:

- `RATE_LIMIT_CAMPAIGN_DAILY`
- `RATE_LIMIT_SENDER_DOMAIN_DAILY`
- `RATE_LIMIT_RECIPIENT_DOMAIN_DAILY`

El limite de `sender_node` viene de `SenderNode.dailyLimit`.

## Verificacion realizada

1. Se registro un sender node activo con `dailyLimit: 1`.
2. Se encolaron dos jobs validos.
3. El primer procesamiento consumio el limite del nodo.
4. El segundo procesamiento quedo bloqueado por `sender_node`.
5. El audit log registro `send_job.rate_limited`.

## Nota tecnica

Durante una prueba paralela con dos workers locales se detecto una colision de archivos `.tmp`. Se corrigio usando nombres temporales unicos. Aun asi, el worker local no debe usarse como mecanismo concurrente real. La concurrencia correcta llega con BullMQ/Redis y persistencia transaccional.
