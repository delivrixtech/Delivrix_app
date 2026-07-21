# Nits del PR #4 (canvas run artifact) — verificados 100% contra el código

Fecha: 2026-06-18 · Auditado por Claude leyendo `07edfcd` + el código actual. Ninguno bloquea el merge; el Nit 2 es un bug funcional (no de seguridad).

## Nit 1 — número mágico `state.steps["9"]` para el DKIM (advisory)
En `smtpRunStateToIdentity` (orchestrator-smtp.ts) el DKIM se lee de `state.steps["9"]?.result?.outcome`.
**Verificado correcto HOY:** `smtpRunProgressSteps` (`:357`) tiene `{ step: 9, skill: "provision_smtp_postfix" }`, y es exactamente el step del que el código existente saca el DKIM (`const smtp = await runMutatingStepWithState({ step: 9, skill: "provision_smtp_postfix" })` en `:908`, leído en `:936` con `stringFromOutcome(smtp.outcome, ["dkimPublicKey"], "")`).
**Riesgo:** el literal `"9"` es frágil — si cambia el orden de pasos, el DKIM queda vacío en silencio (sin error).
**Fix sugerido:** derivar el índice del step cuyo `skill === "provision_smtp_postfix"`, o una constante con nombre (p.ej. `const PROVISION_SMTP_STEP = 9`) reusada por ambos lados. No el literal suelto.

## Nit 2 — `safeEmailMessageId` descarta SIEMPRE el messageId real (BUG funcional, confirmado)
`safeEmailMessageId` valida con `^msg-[a-z0-9][a-z0-9-]{0,62}$`.
**Pero el messageId real** generado por `send_real_email` es (send-email.ts:652-654):
```
const messageId = input.idempotencyKey
  ? `<delivrix-${shortHash(input.idempotencyKey)}@${domainFromEmail(input.from)}>`
  : `<delivrix-${randomUUID()}@${domainFromEmail(input.from)}>`;
```
Tras quitar `<>` queda `delivrix-<uuid|hash>@<dominio>`:
- empieza con `delivrix-`, NO con `msg-` → falla.
- contiene `@` y `.` → falla (el regex solo permite `[a-z0-9-]`).

→ **El regex NUNCA matchea el formato real ⇒ `finalEmailMessageId` se descarta el 100% de las veces y nunca aparece en la ficha.** Es fail-safe (no filtra nada), pero el campo está muerto.
**Fix:** aceptar el formato real, manteniendo el guard de length y de keywords (token/secret/password/credential/authorization/private/bearer/api_key) que ya tiene. P.ej., tras strip de `<>`:
```
/^delivrix-[a-z0-9-]{1,80}@[a-z0-9.-]{1,120}$/i
```
(o, si se quiere genérico para cualquier Message-ID estándar: `^[a-z0-9][a-z0-9._+-]{0,80}@[a-z0-9.-]{1,120}$` con los mismos guards).

## Nota
Verificación: leído directo del código el 2026-06-18 (`smtpRunProgressSteps:357`, provision step `:908/:936`, messageId `send-email.ts:652`). El frontend (Claude) ya está cableando `progress.identity` con fallback; si se aplica el Nit 2, el `finalEmailMessageId` empezará a mostrarse sin tocar nada más.
