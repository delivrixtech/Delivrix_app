# BRIEF CODEX — Commit correctivo de PR #17 + deploy para review (destrabar QA, sin romper nada)

Fecha: 2026-06-23 · Ejecuta: **Codex** · Branch: **`codex/smtp-auth-sasl`** (sobre PR #17) · Después: **deploy para review, NO merge todavía**

## Contexto
PR #17 (SASL + entrega de credenciales) fue auditado: **seguridad/no-fuga y relay-no-roto = SÓLIDOS** (verificado: AES-256-GCM, campo `smtpCredentialEncrypted` redactado, descarga gateada/auditada, puerto 25 con `permit_mynetworks` intacto, SASL additive en 587/465). Faltan **3 blockers operativos + hardenings**. Cerralos en **UN commit** sobre la misma branch y deployá para que el operador revise antes de merge.

## INVARIANTES — no romper nada (las 2 críticas + heredadas)

1. **`CREDENTIAL_ENCRYPTION_KEY` en `env-preflight.ts` va como `severity: "warn"`, NUNCA `fatal`.** El gateway DEBE bootear sin la key — igual que TODAS las vars de feature (`env-preflight.ts:118` dice literal *"para no romper un arranque que hoy funciona"*). Si se pone `fatal`, **rompe el boot del gateway actual**. La feature ya falla-seguro en uso (`credential_encryption_key_missing`).
2. **El guard `409` SOLO al borde:** `status=configured` **y** `smtpAuthStatus=configured` **y** SIN credencial (`smtpCredential.hasCredential !== true`). El happy-path ya corta antes en `findConfiguredSmtpInventory` (`smtp-provisioning.ts:799-801`) — **NO tocarlo, NO tirar 409 en re-provisions válidos.**
3. **Heredadas:** puerto 25 = relay por IP intacto (`permit_mynetworks`, `main.cf:952`); los **8 SMTPs no se tocan**; el password **nunca** a chat/audit/log; **tests existentes verdes** (1119 + 57).

## Los 4 fixes

1. **env-preflight valida `CREDENTIAL_ENCRYPTION_KEY`** como **`warn`** (presente + 32 bytes válidos en base64/hex). + runbook corto: generación (`openssl rand -base64 32`), instalación en `gateway.env`, y rotación.
2. **Cablear el retrofit batch:** endpoint gateado/auditado (patrón `sensitive-read-auth`) que invoca `runSmtpSaslRetrofitBatch` (`smtp-sasl-retrofit.ts:80`) sobre los SMTPs existentes. Degrada por-servidor (un fallo no aborta el batch). + opcional script CLI.
3. **Guard `409` `smtp_auth_configured_but_credential_missing`** (scopeado al borde del invariante #2), o exigir `force/rotate` explícito. **Nunca regenerar credencial en silencio** (invalidaría la de un cliente).
4. **Hardenings:** quitar el botón `Export masivo` deshabilitado del panel (`SenderPool.tsx`); runbook de rollback SMTP-AUTH; estado `install_failed` (o registrar step fallido + comandos completados al fallar provisioning); warning en el `.md` ("no expira; rotar ante exposición"); en Dovecot, explícito `auth_debug = no`, `auth_debug_passwords = no`, `disable_plaintext_auth = yes` (el TLS ya lo fuerza el `submission` service, esto es defense-in-depth).

## DoD
- `npm test` + `npm run test:admin` verdes.
- **Boot del gateway SIN la key = arranca con warning (no fatal).** Con la key = la feature anda.
- El password sigue **sin aparecer** en run-state/audit/chat (el test de no-fuga sigue verde).
- Relay de los 8 (puerto 25) **sin cambios**.

## Deploy para review (NO ejecutar acción destructiva)
- **Codex:** commit a `codex/smtp-auth-sasl`, y **deploy del código a la gateway local** (restart + rebuild del system-context de OpenClaw para el prompt v2.11), **preservando lo ya integrado** (canvas-v5, etc.). Para que el operador revise: el **botón de descarga en Sender Pool**, el **flujo de OpenClaw (apunta-no-imprime)**, y que **los 8 sigan en pie** en puerto 25.
- **Operador (Juanes):** generar y setear `CREDENTIAL_ENCRYPTION_KEY` en `gateway.env` (Codex da el comando; **el secreto lo setea el operador, no Codex**).
- **NO correr el retrofit live sobre los 8 todavía** — es acción gateada, se hace después de revisar. Para probar la feature: SMTP nuevo/de prueba, o solo verificar UI + endpoint.
- **NO merge a produ** hasta que operador + Claude revisen el deploy.

## Anclas
- `env-preflight.ts:12-21` (severidad fatal/warn), `:118` (patrón warn = no romper boot), `:95-111` (los únicos `fatal`).
- `smtp-provisioning.ts:799-801` (findConfiguredSmtpInventory), `:952` (relay 25), `:339` (409 existente del download).
- `smtp-sasl-retrofit.ts:80` (runSmtpSaslRetrofitBatch).
- `apps/admin-panel/src/v5/views/SenderPool.tsx` (botón Export masivo a quitar).
- `OPENCLAW_SYSTEM_PROMPT.md` (v2.11) + `scripts/openclaw/build-system-context.sh` (rebuild).
