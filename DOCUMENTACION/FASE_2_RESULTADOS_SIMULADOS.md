# Fase 2: Hito 2.8 Resultados simulados

Fecha: 2026-05-02

## Objetivo

Registrar resultados de envio sin SMTP real.

Este hito prepara la plataforma para observar estados operativos antes de conectar Webdock o Postfix.

## Estados soportados

- `sent`
- `bounce`
- `complaint`
- `deferred`
- `failed`

## Implementacion

Se agrego:

- `SendResult` en dominio.
- `simulateSendResult`.
- `LocalFileSendResultStore`.
- Endpoint `GET /v1/send-results`.
- Metricas de resultados en `GET /v1/operational-summary`.

## Simulacion

El Worker genera resultados sin SMTP real.

Formas de simular:

- Por metadata: `metadata.simulatedResult`.
- Por patron de email:
  - contiene `bounce` -> `bounce`.
  - contiene `complaint` -> `complaint`.
  - contiene `defer` -> `deferred`.
  - contiene `fail` -> `failed`.
  - cualquier otro -> `sent`.

Ejemplo:

```json
{
  "metadata": {
    "simulatedResult": "bounce"
  }
}
```

## Persistencia local

Resultados:

- `runtime/send-results.json`

## Verificacion realizada

1. Se registro un sender node de prueba con limite suficiente.
2. Se encolo un job valido con `metadata.simulatedResult = bounce`.
3. El Worker asigno sender node.
4. El Worker genero resultado simulado `bounce`.
5. `GET /v1/send-results` devolvio:
   - `status: bounce`
   - `smtpResponse: 550 5.1.1 user unknown`
   - `bounceCode: 5.1.1`
6. `GET /v1/operational-summary` incluyo:
   - `totals.sendResults`
   - `sendResultsByStatus.bounce`
   - `sendResultsByCampaign`
   - `sendResultsBySenderNode`

## Importante

Un resultado `bounce` o `complaint` queda registrado, pero todavia no dispara cuarentena, suppression list automatica ni cambio de estado del sender node.

Eso corresponde al siguiente bloque de trabajo.

## Siguiente hito recomendado

**Hito 2.9: health checks y estados de sender nodes**

Debe empezar a conectar resultados con estado operativo:

- `bounce` recurrente -> degradacion.
- `complaint` -> alerta y posible suppression.
- `deferred` -> warning.
- `failed` -> diagnostico.
