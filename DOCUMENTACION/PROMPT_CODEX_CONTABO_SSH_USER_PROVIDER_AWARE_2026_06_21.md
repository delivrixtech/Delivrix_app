# BRIEF CODEX — SSH provider-aware para Contabo (root) — desbloquea steps 8/9/12/14

Fecha: 2026-06-21 · Auditado en vivo (run v8) + 2 subagentes senior convergentes (file:línea) · Ejecuta: **Codex** · Base: **`produ`**

## Estado: el run llegó al step 8/14 (lo más lejos hasta ahora)
Tras PR #9 (reuse + poll + IP-resume), el run v8 sobre `annualcorpfilings.com` / VPS Contabo `contabo-203386827` (IP `66.94.96.220`):
- Steps 1-3 ✅ (adopción IONOS), 4 ✅ **adoptó/reusó el VPS Contabo**, 5 ✅ IP, 6 ✅ **DNS A+MX en IONOS**, 7 ✅ SPF/DKIM/DMARC.
- **Step 8 `bind_webdock_main_domain` ❌ `identity_set_failed`.**

## Causa raíz (UNA sola, confirmada por 2 subagentes)
**NO es la Webdock identity API.** El step 8 YA enruta a Contabo correctamente: `webdock-bind-domain.ts:209-228` toma el CONTABO BIND PATH (`bindNonWebdockMainDomain`, `:481-726`) que setea el hostname por SSH (`setHostnameViaSsh`, `:733-777`, `hostnamectl`). El audit log lo prueba: emite `oc.bind.contabo_hostname_set_failed` (NO `identity_set_failed` de Webdock), con `error: "SSH command failed with exit 255."`.

**El verdadero fallo: SSH exit 255 por mismatch de usuario.**
- El runner SSH del gateway entra como **`delivrixops`** (`SMTP_PROVISION_SSH_USER=delivrixops` en `config/gateway.env:41`, key `~/.ssh/delivrix-ops` `:42`; runner en `smtp-provisioning.ts:524-544`, instancia única `main.ts:439`).
- El VPS Contabo se crea con `defaultUser: "root"` (`contabo-adapter.ts:59,231`); la pubkey se instala **solo para root** (Secrets API). El `ensureServerSshAccess` de Contabo es **no-op de usuarios** (`contabo-adapter.ts:418-434`) — **NO crea `delivrixops`**.
- Webdock SÍ crea el shell user `delivrixops` (`webdock-real-adapter.ts:401-414`) → por eso Webdock funcionaba y Contabo no.
- `ssh delivrixops@66.94.96.220` contra Contabo → usuario inexistente → auth falla → **exit 255** → `identity_set_failed` (string HTTP compartido).

## El alcance: el MISMO gap pega en TODOS los steps SSH restantes
Barrido de steps 8-14 (2º subagente):

| Step | Skill | SSH? | ¿Rompe en Contabo? |
|---|---|---|---|
| 8 | bind_webdock_main_domain | SÍ | SÍ — exit 255 (este fallo) |
| 9 | provision_smtp_postfix | SÍ | SÍ — mismo runner `delivrixops` |
| 10 | configure_email_auth | NO (DNS) | No — agnóstico |
| 11 | wait_for_dns_propagation | NO | No |
| 12 | seed_warmup_pool | SÍ (`/usr/sbin/sendmail`) | SÍ — mismo runner |
| 13 | wait_warmup_initial | NO | No |
| 14 | send_real_email | SÍ (`swaks` puerto 25) | SÍ — mismo runner |

**Un solo root cause** (el SSH runner global usa `delivrixops`, que no existe en Contabo) bloquea steps 8/9/12/14. 10/11/13 ya andan.

## EL FIX (uno, provider-aware — NO env global)
Hacer el SSH **consciente del proveedor**: usuario `root` para Contabo, `delivrixops` para Webdock. **NO** cambiar `SMTP_PROVISION_SSH_USER` a `root` global (rompería Webdock, que necesita `delivrixops`).

**Opción recomendada (mínima, provider-aware POR SLUG):**
- El runner NO tiene canal de usuario por-llamada hoy (`SmtpSshCommandInput` = `{serverIp, command}`, `smtp-provisioning.ts:41-46`). Hacer que `run()` reciba el `serverSlug` y **derive `{user, useSudo}` por-llamada**: slug `contabo-*` → `user="root"`, `useSudo=false`; resto → `delivrixops` + `useSudo=true` (fórmula actual `:541` intacta).
- Reusá el discriminador YA existente `isContaboLikeServer` (`webdock-servers.ts:999`: `accountId==="contabo" || slug.startsWith("contabo-")`). Así **cubre steps 9/12/14 SIN threadear `providerId`** — el `serverSlug` ya está en los 3 handlers (`smtp-provisioning.ts:134`, `warmup.ts:96-100`, `send-email.ts:262,855-859`). El step 8 ya recibe el runner.
- **Webdock byte-idéntico:** anclar el discriminador en POSITIVO a Contabo; Webdock queda como fallback (`delivrixops`+sudo) → sin cambio.
- **La llave YA COINCIDE (verificado — NO hay 2º mismatch):** el create sube `WEBDOCK_OPERATOR_SSH_PUBLIC_KEY` (`gateway.env:61` = pública de `delivrix-ops`, fingerprint `f62bb8f5fbd46125` / publicKeyId 397034) e instala SOLO en `root`; es la pública de `~/.ssh/delivrix-ops` (`:42`) que usa el runner. `user=root` + misma llave = conecta. **NO hace falta cambiar la llave.** (Higiene: las vars `:42` privada / `:61` pública deben rotarse juntas; hoy no hay guard que lo asegure.)
- **`sudo` hardcodeado en step 8 (hay que tocarlo):** `setHostnameViaSsh` (`webdock-bind-domain.ts:760,762,764`) usa `sudo hostnamectl` / `sudo sed` / `sudo tee` literal. Corriendo como `root` con `useSudo=false`, ese `sudo` inline pasa tal cual → OK SOLO si la imagen Contabo trae `sudo` (si no, **exit 127**). Hacer el prefijo `sudo` **condicional al usuario** (`user==="root" ? "" : "sudo "`) → robusto en Contabo y byte-idéntico en Webdock. Es el ÚNICO `sudo` hardcodeado en la ruta SSH (steps 9/14 no lo tienen).

**Alternativa de mayor paridad (opcional, más trabajo):** que `ContaboAdapter.createServer` use cloud-init/`userData` para CREAR `delivrixops` con la llave + sudo NOPASSWD (`contabo-adapter.ts:213-280`). Así TODO el pipeline usa `delivrixops` sin ramificar por proveedor. Elimina el branch en cada step SSH.

## Menores (no bloqueantes, atender de paso)
- El CONTABO BIND PATH llama `setHostnameViaSsh` SIN el wrapper de reintento `runSmtpStepWithCloudInitRetry` (`smtp-provisioning.ts:894-941`) que sí usa step 9 — exit 255 también es transitorio mientras el puerto 22/cloud-init de la caja recién creada no está listo. Envolverlo.
- `alreadyBound` para Contabo: `mainDomain=displayName` (`smtp-annualcorpfilings-com`, sin puntos) → `currentIdentityDomainFromServer` (`webdock-bind-domain.ts:935-946`) lo descarta → nunca corto-circuita (idempotente igual, no bloquea). Mejorable.

## DoD
- Un run Contabo completa steps 8-14: bind (hostname por SSH como root) → postfix → email-auth → warmup → `send_real_email` (que prueba el puerto 25 real). Reusa `contabo-203386827`.
- Webdock byte-idéntico (sigue `delivrixops`). `npm test` verde. Sin exponer secretos/llaves.

## Anclas
- `apps/gateway-api/src/routes/smtp-provisioning.ts:524-544` (runner global), `:829-892` (SSH exec), `:894-941` (retry cloud-init).
- `apps/gateway-api/src/routes/webdock-bind-domain.ts:209-228` (branch provider), `:481-726` (CONTABO BIND PATH), `:733-777` (setHostnameViaSsh), `:575,591` (identity_set_failed/contabo_hostname_set_failed), `:935-946` (alreadyBound).
- `packages/adapters/src/contabo-adapter.ts:59,231` (defaultUser root), `:418-434` (ensureServerSshAccess no-op user).
- `apps/gateway-api/src/routes/warmup.ts:216-229` (SSH sendmail), `send-email.ts:666-681` (SSH swaks p25).
- `config/gateway.env:41-42` (SMTP_PROVISION_SSH_USER=delivrixops + key).
- `apps/gateway-api/src/main.ts:439` (instancia runner).
