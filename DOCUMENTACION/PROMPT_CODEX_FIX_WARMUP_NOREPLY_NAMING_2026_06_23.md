# BRIEF CODEX — Fix: el warmup usa `noreply@` (remitente prohibido por el propio sistema)

Fecha: 2026-06-23 · Ejecuta: **Codex** (backend + deploy) · Coordina: Juanes (CTO) · Auditado por Claude · Severidad: media (protocolo/reputacion; NO bloquea entrega — el seed llego a inbox)

## Contexto (auditado en vivo 2026-06-23)

El warmup seed de infranationalreport.com **llego a INBOX** (entrega OK), pero salio con `From: noreply@infranationalreport.com`. OpenClaw lo flageo: `noreply` esta en la lista prohibida de naming [11A]. Y es una **auto-contradiccion del codigo**:

- `apps/gateway-api/src/services/naming-validator.ts:5` -> `PROHIBITED_DOMAIN_WORDS` incluye `"noreply"`.
- `apps/gateway-api/src/routes/send-email.ts:88-89` -> `SPAM_FLAG_WORDS` incluye `"noreply"`, `"no-reply"`.
- PERO el warmup **usa `noreply@`** en 4 lugares:
  - `apps/gateway-api/src/routes/warmup.ts:228` -> envelope sender (`sendmail -t -f noreply@<domain>`)
  - `apps/gateway-api/src/routes/warmup.ts:391` -> `From: Delivrix Warmup <noreply@<domain>>`
  - `apps/gateway-api/src/routes/warmup-ramp.ts:350` -> envelope sender
  - `apps/gateway-api/src/routes/warmup-ramp.ts:887` -> `From: Delivrix Ramp <noreply@<domain>>`

## Objetivo

Que el warmup (y el smoke) salgan de un local-part **permitido**, no de `noreply@`.

## Fix

1. Cambiar `noreply@${domain}` -> **`hello@${domain}`** en los 4 lugares (envelope `-f` + header `From`). `hello` NO esta en `PROHIBITED_DOMAIN_WORDS` ni en `SPAM_FLAG_WORDS` (verificado). Idealmente, **una sola constante compartida** (p.ej. `WARMUP_FROM_LOCALPART = "hello"`) para no volver a divergir.
2. **El SMOKE (step 13) YA usa `hello@`** (VERIFICADO: `orchestrator-smtp.ts:1159` -> `fromAddress: hello@${chosenDomain}`). **NO tocar el smoke.** El fix es SOLO el warmup (los 4 lugares) -> alinearlo con lo que el smoke ya hace bien. Confirmado: el warmup es el UNICO sender con `noreply@` en el gateway.
3. (Opcional, defensivo) que el envelope/From del warmup pase por el mismo `naming-validator` antes de enviar, para que el sistema no pueda volver a mandar un remitente que el mismo prohibe.

## Invariantes / no-regresion

1. **No romper el envio del warmup** (sigue mandando, solo cambia el local-part del From/envelope).
2. `hello@<domain>` debe pasar `naming-validator` + `send-email` (que no quede otro flag).
3. **No tocar** el provisioning SMTP, las credenciales, el canvas, ni los 8 SMTP productivos.
4. Sin emojis; ASCII en codigo; espanol formal en docs.

## DoD

- Warmup + smoke salen de `hello@<domain>` (o local-part permitido); ningun envio usa `noreply@`.
- Validadores (`naming-validator`, `send-email`) pasan para el nuevo From.
- `npm test` + `npm run test:admin` verdes (+ test que verifique que el warmup From no es prohibido).
- Deploy a local + Hostinger (rebuild system-context si el prompt menciona el From). NO merge a produ sin review.

## Anclas (verificadas 2026-06-23)

- Bug: `warmup.ts:228` (envelope), `:391` (From); `warmup-ramp.ts:350` (envelope), `:887` (From).
- Prohibidos: `naming-validator.ts:1-19` (`PROHIBITED_DOMAIN_WORDS`), `send-email.ts:80-100` (`SPAM_FLAG_WORDS`).
- Smoke/orquestador: revisar `configure_complete_smtp` / `send-email.ts` para el From del smoke (step 13).
