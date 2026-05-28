# RESULT — Smoke demo viernes Final.0

**Fecha:** 2026-05-28  
**Owner ejecución:** Codex  
**OPS origen:** `OPS_CODEX_DEMO_VIERNES_FINAL_2026_05_28.md`  
**Commit base verificado:** `484f399 fix(gateway): unblock demo warmup and smtp retry`

## Veredicto

**BLOQUEADO por precondiciones de entorno.** No se ejecutó el smoke E2E real
post-`484f399` porque `.env.local` todavía contiene seed inboxes de ejemplo y
el preflight pedido por el OPS no tiene `WALLET_MONTHLY_CAP_USD=50`.

No se provisionó VPS Webdock, no se compró/provisionó dominio nuevo, no se
instaló SMTP contra un VPS fresh y no se envió warmup real.

## Precondiciones verificadas

| Check | Resultado | Evidencia |
|---|---:|---|
| Gateway local | OK | PID `69566`, `127.0.0.1:3000` |
| Admin panel local | OK | PID `20140`, `127.0.0.1:5173` |
| `/health` gateway | OK | `status=ok`, Postgres `ok`, Redis `ok` |
| `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true` | OK | presente en `.env.local` |
| Cap mensual backend | OK | `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50` presente |
| Cap mensual pedido por OPS/preflight | BLOQUEADO | `WALLET_MONTHLY_CAP_USD=50` no aparece en `.env.local` |
| Warmup flag | OK | `WARMUP_ENABLE_SEND=true` |
| Grace SSH Webdock | OK | `WEBDOCK_SSH_ACCESS_SETTLE_MS=120000` |
| Seed inboxes Mailtrap reales | BLOQUEADO | `WARMUP_DEFAULT_SEED_INBOXES=seed-1@xxxxx.mailtrap.io,seed-2@xxxxx.mailtrap.io,seed-3@xxxxx.mailtrap.io` |

## Executions del smoke post-484f399

No hay executions del smoke real porque el OPS ordena parar antes de acciones
externas si faltan las precondiciones de Mailtrap/cap.

| Paso | Status | Execution | SHA/hash |
|---|---:|---|---|
| Provision Webdock fresh | No ejecutado | n/a | n/a |
| Install SMTP stack | No ejecutado | n/a | n/a |
| Bind dominio-servidor | No ejecutado | n/a | n/a |
| Warmup seed | No ejecutado | n/a | n/a |
| Verificación Mailtrap | No ejecutado | n/a | n/a |

## Mailtrap

No hay screenshot ni link de sandbox: no se enviaron emails reales. Para cerrar
el smoke, Juanes debe reemplazar los tres placeholders por inboxes reales del
sandbox Mailtrap y vaciar el inbox antes del practice run.

## Telemetría observada

No aplica al smoke real porque no se inició. La telemetría implementada en
`484f399` ya está cubierta por tests:

- `sshConnectAttempts`
- `cloudInitSettleSeconds`
- retries internos silenciosos en `install_smtp_stack`
- `progressDetail` para Canvas Live

## Observaciones para el demo

- Los endpoints reales del gateway no coinciden exactamente con los ejemplos
  cortos del OPS:
  - Webdock create: `POST /v1/webdock/servers/create`
  - SMTP install: `POST /v1/servers/:serverSlug/provision-smtp`
  - Bind: `POST /v1/domains/bind`
  - Warmup: `POST /v1/warmup/seed`
- El audit event real de bind es `oc.domain.bound_to_server`, no
  `oc.bind.completed`.
- El backend usa `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD` como guardrail de compra.
  Si el preflight visual exige literalmente `WALLET_MONTHLY_CAP_USD`, hay que
  agregar esa variable como alias operativo o ajustar el checklist antes del
  viernes 10:00 COT.

## Próximo paso requerido

Juanes debe actualizar `.env.local` con:

```bash
WARMUP_DEFAULT_SEED_INBOXES=<mailtrap-real-1>,<mailtrap-real-2>,<mailtrap-real-3>
WALLET_MONTHLY_CAP_USD=50
```

Después de eso, reiniciar el gateway para cargar `.env.local` y ejecutar el
smoke real con token de aprobación vigente.
