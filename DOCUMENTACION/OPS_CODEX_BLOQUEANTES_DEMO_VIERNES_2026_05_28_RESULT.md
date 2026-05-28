# RESULT — OPS Codex bloqueantes demo viernes (cierre)

Sha de cierre: `484f399 fix(gateway): unblock demo warmup and smtp retry`

## B-DEMO-01 Warmup seed — CERRADO en código

- Helper `resolveSeedInboxes` + `parseSeedInboxCsv` en
  `apps/gateway-api/src/routes/warmup.ts`.
- Fallback a `WARMUP_DEFAULT_SEED_INBOXES` cuando el body no trae exactamente
  tres seeds.
- Endpoint demo `POST /v1/warmup/seed` habilitado manteniendo compatibilidad con
  `POST /v1/warmup/start`.
- Action de éxito renombrado a `oc.warmup.seed_sent`.
- `warmup.test.ts` verde en suite completa.
- `.env.example` documenta `WARMUP_ENABLE_SEND` y
  `WARMUP_DEFAULT_SEED_INBOXES`.
- Smoke E2E real: **bloqueado por precondición de `.env.local`**. Ver
  `SMOKE_DEMO_VIERNES_RESULT_2026_05_28.md`.

## B-DEMO-02 SMTP retry — CERRADO en código + telemetría

- `runSmtpStepWithCloudInitRetry`: 3 intentos, backoffs `[30s, 60s]`.
- El retry se aplica al primer paso SSH/cloud-init del plan
  `install_smtp_stack`.
- El operador ve una sola task externa; los retries internos no crean
  executions failed separadas para el mismo invocation.
- Telemetría `sshConnectAttempts` + `cloudInitSettleSeconds` en response,
  evidence y audit metadata.
- `progressDetail` para Canvas Live:
  `esperando cloud-init... intento N de 3`.
- `smtp-provisioning.test.ts` verde en suite completa.
- Runbook `register-sender-node-local-runbook.md` actualizado con criterio de
  escalamiento si `sshConnectAttempts > 2`.
- Smoke E2E real: **bloqueado por precondición de Mailtrap/cap operativo**. Ver
  `SMOKE_DEMO_VIERNES_RESULT_2026_05_28.md`.

## Checks ya ejecutados sobre el cierre `484f399`

- `npm test`: 360/360 pass.
- `npm run test:admin`: 25/25 pass + Vite build pass.
- Gateway local: `/health` OK, Postgres OK, Redis OK.
- Admin panel dev server: puerto `5173` vivo.
- Smoke seguro `/v1/warmup/seed` sin approval válido: endpoint existente,
  seed fallback activo (`seedCount=3`) y sin envío real.

## Riesgo abierto antes del demo

El código de los bloqueantes está cerrado, pero el smoke real de punta a punta
queda pendiente hasta reemplazar los seed inboxes placeholder por tres inboxes
reales de Mailtrap y alinear el cap esperado por preflight.
