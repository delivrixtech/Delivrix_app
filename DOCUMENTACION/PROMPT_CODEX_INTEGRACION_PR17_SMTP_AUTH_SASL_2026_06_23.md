# BRIEF CODEX — Integrar PR #17 (SMTP AUTH SASL + descarga de credenciales) al gateway que corre + 2 mejoras

Fecha: 2026-06-23 · Ejecuta: **Codex** (dueño del git + deploy) · Coordina: Juanes (CTO) · Auditado por Claude (placement + crypto + flujo) · Después: **deploy local + Hostinger para review; el cierre lo valida el operador con 1 descarga real**

## Contexto (auditado 2026-06-23)

PR #17 (`codex/smtp-auth-sasl`, tip **`ae80093`** = `c6dc15d` feat + `ae80093` fix, 25 archivos, +2867) está **construido y auditado a profundidad**. Veredicto: **el placement en Sender Pool es CORRECTO** (la credencial es por-dominio, vive en `domains.json -> smtpCredentials[]`, y el backend namespacea la descarga bajo `/v1/sender-pool/credentials/...`; Infraestructura es por-VPS = ancla equivocada, NO mover). Crypto sólido (AES-256-GCM, AAD, fail-closed sin key). El prompt OpenClaw v2.11 ya trae el directive "apunta-no-imprime, descarga por Sender Pool".

**El único faltante es integración + deploy** (PR #17 NO está en el árbol que corre) **+ 2 mejoras menores**. Esto NO toca telemetría (es otro track).

## Topología verificada (no adivinar)

- **Árbol que corre = `feature/canvas-v5-preview`** (HEAD). Limpio salvo docs sin trackear (no estorban).
- **`produ` tip == `0b460f7` == merge-base de PR #17** -> produ NO avanzó desde la base -> **merge PR #17 -> produ es limpio** (fast-forward/sin conflicto).
- **Superficie de conflicto con el árbol que corre = SOLO 5 archivos** (ambos lados los tocaron): `apps/admin-panel/server.mjs`, `apps/admin-panel/vite.config.ts`, `apps/gateway-api/src/main.ts`, `apps/gateway-api/src/openclaw-bedrock-bridge.ts` (+ su test). **Todo lo SMTP entra LIMPIO** (`smtp-credentials.ts`, `smtp-sasl-retrofit.ts`, `smtp-sasl-config.ts`, `smtp-provisioning.ts`, `sender-pool-status.ts`, `SenderPool.tsx`, `env-preflight.ts`).
- **Resolución de los 5:** son adiciones en regiones cercanas (rutas/imports/proxy), no reescrituras. **Conservar AMBOS lados:** el wiring canvas-v5 + chat-history + bedrock-bridge del árbol, Y las rutas/proxy/imports de PR #17.

## Invariantes (de PR #17 + heredadas) — no romper nada

1. **`CREDENTIAL_ENCRYPTION_KEY` = `warn`, NUNCA `fatal`** (ya correcto en `env-preflight.ts`; mantener). El gateway BOOTEA sin la key. Sin key: generación y descarga **fail-closed** (`credential_encryption_key_missing`).
2. **Puerto 25 `permit_mynetworks` intacto**; SMTP AUTH es **aditivo** en 587/465 (Dovecot SASL). Los 8 SMTP relay no se degradan.
3. **El password nunca** a chat / audit / Canvas / live-context / logs. Solo viaja en el archivo de descarga (`.md`) servido por el endpoint gateado.
4. **El retrofit no corre en boot ni en deploy.** Solo por `POST` explícito con read-boundary token + `approvalToken` vigente (artifact aprobado en Canvas).
5. **NO romper canvas-v5 + chat-history** al resolver los 5 archivos de conflicto.
6. **NO romper los 8 SMTPs ni produ.** En el deploy los 8 NO se tocan. El retrofit MUTA los servers por SSH (SASL aditivo) -> ver Mejora #1 (single-target primero).
7. **Idempotencia legacy preservada (CRÍTICO, ver Riesgo #2):** un SMTP `status==="configured"` SIN `smtpAuthStatus` (los 8 actuales, pre-SASL) DEBE seguir cortando como `idempotent_already_configured` en un re-provision/resume — NO re-provisionarse con SASL en silencio. El upgrade a SASL de los existentes entra SOLO por el retrofit gateado.
8. **Sin emojis; ASCII en código/scripts; español formal con tildes en docs.**

## Riesgos de regresión auditados (2026-06-23, contra el código de la rama)

La integración es **aditiva y NO toca los 8 SMTPs en el deploy** (verificado: puerto 25 con `permit_mynetworks` primero + `smtpd_sasl_auth_enable=no` en el 25, SASL solo en 587/465; DKIM reusado, no regenerado; `apt` solo SUMA `dovecot-core`; rutas + bridge aditivos; redacción de secretos mejorada; fallo de credencial fail-closed sin dejar server a medias). PERO hay **2 cambios de comportamiento reales** que hay que manejar:

- **Riesgo #1 — provisionar un SMTP NUEVO ahora exige `CREDENTIAL_ENCRYPTION_KEY`.** `buildSmtpProvisionPlan` exige `smtpCredential` y el plan siempre incluye Dovecot SASL; `prepareSmtpCredential` lanza `credential_encryption_key_missing` sin la key -> el provision devuelve **`blocked`** (fail-closed, sin SSH, sin server a medias). **Trampa:** el preflight de la key es `warn`, así que el gateway arranca verde pero el primer provision nuevo falla. **Mitigación:** setear la key es **prerequisito bloqueante de go-live**, antes de cualquier provision nuevo.
- **Riesgo #2 — la idempotencia cambió para los 8 pre-SASL.** `findConfiguredSmtpInventory` ahora exige `smtpAuthStatus==="configured" && hasCredential===true`. Los 8 (IP-relay, sin SASL) ya NO matchean -> un re-provision/resume sobre uno dejaría de ser no-op y lo **re-provisionaría con SASL por SSH**. En el deploy no pasa; solo en un re-provision/resume explícito. **Mitigación (hardening obligatorio):** restaurar el corto-circuito idempotente para el estado legacy (`configured` sin `smtpAuthStatus`), devolviendo `idempotent_already_configured` SIN forzar SASL; el upgrade a SASL de los existentes va SOLO por el retrofit.

## Pasos de integración

A. **Respaldo antes de tocar** (igual que en la integración de PR #16): `git tag pre-pr17-2026-06-23` + rama de rescate del estado actual. Rollback = 1 comando.
B. **Merge PR #17 -> produ** (limpio, produ == base). produ queda canónico con la feature.
C. **Integrar al árbol que corre** (`feature/canvas-v5-preview`): traer los 2 commits SMTP; resolver SOLO los 5 archivos conservando ambos lados. El resto entra limpio.
D. **Verificar (gates abajo) + deploy a gateway local Y Hostinger** (regla: nunca dejar el remoto congelado) **+ rebuild del system-context** (`scripts/openclaw/build-system-context.sh`) para que OpenClaw cargue el prompt **v2.11** (descarga por Sender Pool, nunca imprime credenciales).

## Mejora #1 — Retrofit single-target (seguridad operativa)

Hoy `listSmtpSaslRetrofitCandidates` (`smtp-sasl-retrofit.ts`) lee `smtp-provisioning.json -> servers[]` y el batch itera **todos** los servers sin credencial. Agregar param **opcional** `domain` (o `serverSlug`) al `POST /v1/smtp/retrofit-sasl-batch`:

- Si viene `domain`: filtrar candidates a **ese único server**.
- Si no viene: comportamiento actual (todos los candidatos).
- Gating idéntico (read-boundary token + `approvalToken`). Degradación por-servidor intacta.

**Razón:** probar en 1 SMTP y validar entrega + descarga del `.md` **antes** de mutar los 8. **DoD:** `{domain}` retrofitea 1; sin él, batch completo.

## Mejora #2 — Guía de integración más completa en el `.md`

Extender `renderSmtpCredentialMarkdown` (`smtp-credentials.ts`) para que, además de host / 587 STARTTLS / 465 SSL / `mailer@dominio` / password, incluya:

- **Cliente de correo** (Thunderbird/Outlook/Apple Mail): servidor de salida, puerto, seguridad, método de autenticación.
- **Código** (ejemplo Nodemailer 587 y 465; `secure:false` STARTTLS vs `secure:true` TLS).
- **Prueba rápida** (`swaks --auth LOGIN`).
- **Buenas prácticas** anti-quema: calentamiento gradual, quejas/rebotes < 5 %, solo opt-in; rotar si se filtra.

**SIN** agregar secretos nuevos (solo el password ya presente). Mantener exclusiones explícitas: **sin clave DKIM privada, sin acceso SSH**. Referencia de formato: `outputs/SMTP_credenciales_EJEMPLO.md` (plantilla que armó Claude).

## DoD

- Integrado a produ + árbol que corre. **Gateway bootea SIN la key (warn, no fatal);** con la key, la feature anda.
- `npm test` + `npm run test:admin` verdes (incluye los nuevos: `smtp-credentials`, `smtp-sasl-retrofit`, `sender-pool-status`, `env-preflight`).
- **Sender Pool** lista los SMTP provisionados con estado de credencial; **descarga por-dominio** entrega el `.md` (con guía) tras el retrofit; **"Exportar"** entrega inventario **solo-metadata** (sin secretos).
- **Single-target retrofit** (`{domain}`) anda; el batch sigue andando.
- El password sigue **sin aparecer** en run-state/audit/chat/logs.
- **Relay de los 8 (puerto 25) sin cambios.**
- **Canvas v5 + chat-history intactos** (smoke en `/canvas`).
- OpenClaw, al pedirle credenciales, **apunta a la descarga en Sender Pool** y no imprime (system-context reconstruido con v2.11).
- **Riesgo #2 cerrado:** re-provisionar un SMTP legacy (`configured` sin SASL) = **no-op idempotente** (`idempotent_already_configured`), NO un re-provision con SASL. Test que lo cubra.
- **Riesgo #1 documentado:** boot sin la key = `warn` (no fatal), pero provisionar NUEVOS queda bloqueado hasta setear la key.

## Operador (Juanes), tras el deploy

1. **(BLOQUEANTE de go-live)** Generar + setear `CREDENTIAL_ENCRYPTION_KEY` en `config/gateway.env` (`openssl rand -base64 32`) + restart. **El secreto lo setea el operador, no Codex.** Sin esta key, provisionar SMTPs **NUEVOS queda bloqueado** (Riesgo #1); el preflight solo avisa con `warn`, no frena el boot — NO te confíes del "arranca verde".
2. Aprobar un artifact de retrofit en Canvas -> obtener `approvalToken`.
3. **Retrofit single-target en 1 SMTP:** `POST /v1/smtp/retrofit-sasl-batch` con `{actorId, approvalToken, domain:"<uno>"}` + `x-delivrix-token`. Validar entrega y **descargar el `.md`** de ese dominio desde Sender Pool.
4. Si OK -> retrofit del resto (batch sin `domain`).

**NO se da por cerrado hasta que el operador descargue 1 `.md` real y Claude valide en vivo.** No merge final forzado a produ sin ese review.

## Anclas (verificadas 2026-06-23)

- Rama `codex/smtp-auth-sasl` tip `ae80093` (`c6dc15d` feat + `ae80093` fix). Base = produ tip `0b460f7`.
- Conflicto (5): `apps/admin-panel/server.mjs`, `apps/admin-panel/vite.config.ts`, `apps/gateway-api/src/main.ts`, `apps/gateway-api/src/openclaw-bedrock-bridge.ts` (+ `.test.ts`).
- Endpoints: `GET /v1/sender-pool/credentials/{domain}/download` (`handleSmtpCredentialDownloadHttp`, `main.ts:4102-4104`), `GET /v1/sender-pool/credentials/export` (`handleSmtpCredentialInventoryExportHttp`, `:4114`), `POST /v1/smtp/retrofit-sasl-batch` (`handleSmtpSaslRetrofitBatchHttp`, `:1538`).
- Credencial: `smtp-credentials.ts` (`SmtpCredentialRecord` por `domain` en `domains.json -> smtpCredentials[]`; AES-256-GCM AAD `{domain,host,username}`; `renderSmtpCredentialMarkdown`; `decryptSmtpCredentialForDownload` exige `status==="configured"`).
- Lista SMTP autoritativa: `smtp-sasl-retrofit.ts` `listSmtpSaslRetrofitCandidates` lee `smtp-provisioning.json -> servers[]` (`:220-227`); batch `:244-247`; persiste `:438`.
- Sender Pool: `sender-pool-status.ts` une `listSmtpCredentialPublicMetadata` + sintetiza filas con credencial (`:194-245`); `SenderPool.tsx` `downloadSmtpCredential(domain)` (`:321-331`), botón por-fila `disabled={!d.hasCredential}` (`:271`).
- `env-preflight.ts`: `CREDENTIAL_ENCRYPTION_KEY` severidad `warn`.
- Prompt OpenClaw: `OPENCLAW_SYSTEM_PROMPT.md` v2.11 (`:14`, `:132-134`) — descarga por Sender Pool, nunca imprime.
- Runbook de la rama: `DOCUMENTACION/SMTP_AUTH_SASL_RUNBOOK_2026_06_23.md`.
