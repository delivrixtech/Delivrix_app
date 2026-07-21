# BRIEF CODEX — Accion gateada "Generar credencial SMTP" (retrofit como skill aprobable) + deploy

Fecha: 2026-06-23 · Ejecuta: **Codex** (backend + frontend + deploy) · Coordina: Juanes (CTO) · Auditado por Claude (pipeline + anclas verificadas) · Despues: **deploy local + Hostinger con commits, para review; NO merge sin OK**

## Contexto (auditado 2026-06-23)

PR#17 ya esta integrado (HEAD `4cb59ce`). El boton de descarga en Sender Pool **existe y esta bien**, pero esta deshabilitado en los 16 dominios (`title="Credencial SMTP pendiente"`, `hasCredential===false`) porque **no hay ninguna credencial creada**: los SMTP son IP-relay y el unico modo de crear una credencial (el retrofit SASL) hoy **solo se invoca por una llamada manual a la API** (`POST /v1/smtp/retrofit-sasl-batch`) con read-boundary token + un approvalToken de 15 min. **No hay forma in-product de dispararlo** (verificado: no hay tool de OpenClaw ni boton en el panel que lo llame).

**Falta la pieza que CREA la credencial desde el panel**, reusando el pipeline propose->approve->execute que ya usa `configure_complete_smtp`. Objetivo: que "tener credencial" sea **clic -> aprobar en Canvas -> descargar**.

## Objetivo

Accion **"Generar credencial SMTP"** para **1 dominio**, gateada por aprobacion humana, que al aprobarse corre el retrofit single-target y deja la credencial `configured` (descargable en Sender Pool). **NUNCA imprime la credencial** en chat/tool-output.

## Pipeline a REUSAR (verificado — NO inventar uno nuevo)

1. **Registro de skill:** `skill-dispatcher.ts` (entries `SkillHandlerEntry`: `paramSchema` + `timeoutMs` + `canRollback` + `invoke`). Ej. `emailAuth` (~`:532`), map `configure_complete_smtp` (`:701`).
2. **Propuesta:** OpenClaw crea una propuesta en `/v1/openclaw/proposals` con `requiresApproval: true` + `delivrix_actions_required[]` (`proposals-sign.ts:81-82`).
3. **Aprobacion:** el operador aprueba en Canvas -> `POST /v1/openclaw/proposals/:id/sign` -> valida `requiresApproval` (`:223`) + `validateSkillActionBinding` (`:251`, mapea `actionIds` -> `canonicalSkill` `:272`) -> `issueApprovalToken` + audita `oc.artifact.approved` -> `dispatcher.dispatch({ skill, params, approvalToken })` (`:448`).
4. **Dispatch:** `skill-dispatcher.ts` inyecta `approvalToken.tokenId` en el body (`:291`) y corre el `invoke` del skill via adapter HTTP interno.
5. El skill corre **DESPUES** de aprobacion (gateado). No re-chequea aprobacion adentro (igual que `configure_complete_smtp`).

## Lo que se cablea (minimo y consistente)

### Backend
1. **paramSchema** `enableSmtpAuthParamSchema` en `skill-schemas.ts`: `{ domain: string }` (validar dominio).
2. **Handler nuevo** `apps/gateway-api/src/routes/enable-smtp-auth.ts` -> `handleEnableSmtpAuthHttp` que:
   - parsea `domain`,
   - llama **directo** a `runSmtpSaslRetrofitBatch({ workspace, auditLog, sshRunner: deps.smtpSshRunner, env, actorId, target: { domain }, now })` (firma verificada `smtp-sasl-retrofit.ts:250`; single-target via `target:{domain}`; `listSmtpSaslRetrofitCandidates(workspace, target)` ya filtra),
   - audita `oc.smtp_auth.enabled` con `status` + `credentialFingerprint` (**SIN password**),
   - **responde SOLO estado** `{ ok, domain, status, hasCredential }`. **NUNCA** el password ni el `.md`. (CORRECCION: NO usar `renderSmtpCredentialMarkdown` aca; eso vive solo en el endpoint de descarga.)
3. **Registrar el skill** en `skill-dispatcher.ts` (`enableSmtpAuth: SkillHandlerEntry` + en el map `enable_smtp_auth: enableSmtpAuth`).
4. **Permission** en `main.ts` (`permission("enable_smtp_auth", ...)`, nivel supervisado como `configure_complete_smtp`).
5. **Action binding:** registrar el/los `actionId` en el mapeo que usa `validateSkillActionBinding` / `canonicalSkillSlug`, para que una propuesta con ese action sea aprobable y despache a `enable_smtp_auth`.

### OpenClaw
6. Agregar `enable_smtp_auth` a las tools/catalogo (`openclaw-tools-builder.ts` / catalogo de skills) y al **system prompt** (que OpenClaw sepa proponerlo: 1 dominio, requiere aprobacion humana; la credencial se descarga por Sender Pool, **nunca se imprime** — v2.11 ya lo dice). Rebuild del system-context en el deploy.

### Frontend (vista VIVA = `apps/admin-panel/src/v5/views/SenderPool.tsx`)
7. En `DomainRow`, cuando `d.hasCredential === false`, agregar boton **"Generar credencial"** que dispare:
   ```
   useOpenClawIntent().sendIntent(
     `Genera la credencial SMTP AUTH para el dominio ${d.domain} (un solo dominio). Propone la accion para mi aprobacion; no la ejecutes sin mi visto bueno.`,
     `sender-pool:enable-smtp-auth:${d.domain}`
   )
   ```
   - **Gotcha verificado:** la v5 SenderPool **hoy NO usa intents** (los botones "Onboard dominio"/"Onboard con OpenClaw" son **stubs sin onClick**, `:154`/`:186`). El hook existe en `shared/ui/v2/OpenClawIntent.tsx` (`sendIntent(prompt, source?)` `:37`, `useOpenClawIntent` `:125`). Codex debe **(a)** confirmar que `OpenClawIntentProvider` envuelve el arbol del panel v5 — si no, montarlo — porque si no `useOpenClawIntent` lanza; **(b)** importar/usar el hook en v5.
   - El boton de descarga existente (`:271`, disabled por `!hasCredential`) NO se toca: se habilita solo cuando la credencial queda `configured`.

## Invariantes (no romper nada)

1. **El password/credencial NUNCA** sale por chat / tool-output / audit / log. El skill devuelve solo estado; la unica salida del secreto es el `.md` gateado de descarga en Sender Pool.
2. **Gate de aprobacion humana intacto:** el skill SOLO corre tras aprobacion (`requiresApproval` + dispatcher). **Single-domain** (1 SMTP por accion).
3. **Puerto 25 y los SMTP que ya funcionan:** el retrofit es **aditivo** (SASL 587/465, `permit_mynetworks` intacto) y **single-target** -> toca solo el dominio elegido. No tocar el resto.
4. **`CREDENTIAL_ENCRYPTION_KEY`:** si falta, el retrofit/credencial **falla cerrado**; el skill reporta el fallo claro (no a medias). La key la setea el operador, no Codex.
5. **No romper canvas-v5 / chat-history.** Sin emojis; ASCII en codigo/scripts; espanol formal con tildes en docs.
6. **El endpoint HTTP del retrofit** (`handleSmtpSaslRetrofitBatchHttp`) **queda como esta** (para CLI/manual). El skill es el camino in-product; coexisten.

## DoD

- Desde Sender Pool, en un dominio sin credencial: "Generar credencial" abre el chat con el intent; al enviarlo, OpenClaw **propone** `enable_smtp_auth`; **aprobando en Canvas** se corre el retrofit single-target; la credencial queda `configured`; el boton "Credencial" de **ese** dominio se **habilita** y baja el `.md`.
- El password **no aparece** en chat/tool-output/audit (test de no-fuga).
- Sin la key: la accion **reporta fallo claro** (no rompe nada, no deja server a medias).
- Los demas SMTP **intactos** (single-target verificado).
- `npm test` + `npm run test:admin` verdes (+ tests del skill nuevo: gateado por aprobacion, single-target, no-leak del password).
- **Deploy:** commits en `feature/canvas-v5-preview` + `produ`, **deploy a local Y Hostinger**, **rebuild del system-context** (prompt con el skill nuevo). **NO merge a produ sin review** de operador + Claude.

## Anclas (verificadas 2026-06-23)

- `runSmtpSaslRetrofitBatch`: `apps/gateway-api/src/routes/smtp-sasl-retrofit.ts:250` (`input.target` single-target; `listSmtpSaslRetrofitCandidates(workspace, target)`). Endpoint HTTP existente: `handleSmtpSaslRetrofitBatchHttp` (dejar igual).
- Pipeline: `proposals-sign.ts:81-82` (`requiresApproval` + `delivrix_actions_required`), `:223` (gate), `:251-272` (`validateSkillActionBinding` -> `canonicalSkill`), `:448` (dispatch). `skill-dispatcher.ts:291` (inyecta `approvalToken.tokenId`), entries `~:532` (`emailAuth`) / map `:701` (`configure_complete_smtp`).
- Permission: `main.ts` (patron `permission("configure_complete_smtp", ...)`).
- Frontend: `apps/admin-panel/src/v5/views/SenderPool.tsx` (`DomainRow`; download disabled `:271`; "Onboard" stubs `:154`/`:186`). Hook: `apps/admin-panel/src/shared/ui/v2/OpenClawIntent.tsx:37` (`sendIntent`) / `:125` (`useOpenClawIntent`) / `OpenClawIntentProvider` `:56`.
- Credencial: `smtp-credentials.ts` (`renderSmtpCredentialMarkdown` -> SOLO en descarga, NO en el skill; `decryptSmtpCredentialForDownload` exige `status==="configured"`).
- Prompt OpenClaw: `OPENCLAW_SYSTEM_PROMPT.md` v2.11 (`:132-134` apunta-no-imprime) + `scripts/openclaw/build-system-context.sh` (rebuild).
