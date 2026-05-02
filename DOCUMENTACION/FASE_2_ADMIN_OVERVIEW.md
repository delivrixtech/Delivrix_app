# Fase 2: Hito 2.10 Admin overview

Fecha: 2026-05-02

## Objetivo

Consolidar una vista operativa para el futuro panel administrativo.

Este hito es solo lectura. No envia correo, no abre SSH, no modifica Webdock y no cambia infraestructura real.

## Endpoint

```bash
GET /v1/admin/overview
```

## Incluye

- `summary`: resumen operativo completo.
- `health`: decisiones de salud por sender node.
- `alerts`: alertas operativas priorizadas.
- `recentAuditEvents`: ultimos eventos de auditoria.
- `state`: estado global del sistema:
  - `healthy`
  - `warning`
  - `critical`

## Alertas implementadas

Criticas:

- complaints registradas.
- sender nodes con health critical.
- sender nodes en `quarantined`.
- cero nodos `active` o `warming`.

Warnings:

- sender nodes con health warning.
- sender nodes en `degraded`.
- jobs en `processing`.
- jobs `blocked`.
- bounces registrados.

Info:

- `system_nominal` cuando no hay alertas.

## Verificacion realizada

Se consulto:

```bash
curl -s http://127.0.0.1:3000/v1/admin/overview
```

Resultado observado:

- `state = critical`.
- alertas criticas por:
  - complaint registrada.
  - sender node critical.
  - sender node quarantined.
- warnings por:
  - bounce registrada.
  - jobs blocked.
  - job en processing heredado de prueba interrumpida.
- `recentAuditEvents` ordenado del mas reciente al mas antiguo.

## Nota importante

El endpoint todavia no tiene autenticacion porque la plataforma esta en modo local de construccion. Antes de exponer cualquier panel real, debe agregarse autenticacion, autorizacion y proteccion de datos sensibles.

## Siguiente hito recomendado

Con esto queda completa la primera version de la Fase 2 operativa. El siguiente hito recomendado antes de avanzar a integraciones reales es:

**Hito 2.11: stuck job recovery**

Motivo: ya detectamos un job heredado en `processing` por una prueba interrumpida. Antes de workers concurrentes o BullMQ, necesitamos politica de recuperacion para jobs atascados.
