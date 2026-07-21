# BRIEF CODEX — SMTP-AUTH (SASL) + entrega segura de credenciales + OpenClaw aprende a entregarlas

Fecha: 2026-06-22 · Ejecuta: **Codex** · Base: **`produ`** (o la branch viva tras integración) · Después: PR + merge

> **Objetivo:** que cada SMTP tenga credenciales reales (usuario + password SASL) **entregables a un cliente**, que se **descarguen como `.md` desde el panel** (no por chat), y que **OpenClaw aprenda a dirigir al operador a esa descarga** sin imprimir secretos. Incluye **retrofit de los SMTPs ya creados** (hoy son relay por IP, les falta la credencial). El ejemplo del `.md` objetivo está en `outputs/SMTP_credenciales_EJEMPLO.md`.

---

## 0. INVARIANTES — NO ROMPER NADA (leer antes de tocar una línea)

1. **El relay por IP que ya funciona se CONSERVA.** En `renderPostfixMainCf` (`smtp-provisioning.ts:821-841`) hoy hay `smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination` (`:838`). **Se AGREGA `permit_sasl_authenticated`, no se reemplaza nada:** queda `permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination`. Así el smoke/warmup que envía por SSH/`swaks` en `localhost:25` (`send-email.ts`) sigue idéntico.
2. **El submission (587/465) y Dovecot son ADITIVOS.** Se agregan servicios nuevos en `master.cf` + Dovecot como backend SASL. **El puerto 25 y el flujo de 14 pasos no se tocan.** Los 8 SMTPs que ya entregan deben seguir entregando byte-idéntico.
3. **EL secreto NUNCA debe llegar al chat/audit/live-context.** La credencial se guarda **cifrada** y se descifra **solo server-side al descargar**. El campo donde se guarda DEBE matchear el redactor existente `sanitizeJsonValue` (`orchestrator-smtp.ts:2176`, regex `/private|secret|password|credential|authorization/i`) — nombrarlo p.ej. `smtpCredentialEncrypted` / `smtpPassword...` para que se redacte solo del run-state, audit (`:3575`) y live-context (`openclaw-bedrock-bridge.ts` redactSensitiveLiveContext). El blob cifrado es inútil sin la key; el plaintext solo existe en la descarga.
4. **La encryption key vive en env** (`CREDENTIAL_ENCRYPTION_KEY`, 32 bytes), la setea el operador en `gateway.env`. **Nunca en código, chat, logs ni audit.**
5. **El retrofit de los 8 existentes es additive + idempotente + reversible.** Instala Dovecot + crea el user SASL; no reescribe la config de relay más allá de agregar `permit_sasl_authenticated`. Re-correrlo no rompe nada.
6. **OpenClaw mantiene TODAS sus reglas de no-secretos** (`OPENCLAW_SYSTEM_PROMPT.md:128-129, 159, 301, 344`). Solo se AGREGA la conducta de "apuntar a la descarga + dar la guía". No se borra ninguna prohibición.
7. **Tests existentes verdes** (`smtp-provisioning.test`, `send-email.test`, `orchestrator-smtp.test`, `webdock-*.test`). `npm test` verde. Webdock byte-idéntico. Sin exponer secretos.

---

## 1. Fase 1 — SASL en el provisioning (SMTPs NUEVOS)

En `buildSmtpProvisionPlan` (`smtp-provisioning.ts:577-668`), que hoy instala `postfix opendkim opendkim-tools certbot` (`:600`):

- Agregar `dovecot-core` al install.
- Configurar **Dovecot como auth backend SASL** para Postfix (socket `/var/spool/postfix/private/auth`, `auth_mechanisms = plain login`, passdb con el user `mailer@<domain>`).
- En `master.cf`: habilitar **`submission` (587, STARTTLS)** y **`smtps` (465, SSL/TLS)** con `smtpd_sasl_auth_enable=yes`, `smtpd_tls_security_level=encrypt`, `smtpd_recipient_restrictions=permit_sasl_authenticated,reject`.
- En `main.cf` (`renderPostfixMainCf`): agregar `smtpd_sasl_type=dovecot`, `smtpd_sasl_path=private/auth`, y el `permit_sasl_authenticated` del invariante #1. TLS ya viene por `certbot` (`:600`).
- El verify de puertos (`:664`) ya chequea `25|587`; extenderlo a `25|587|465`.

## 2. Fase 2 — Generar + cifrar + guardar la credencial

- **Usuario:** `mailer@<domain>` (convención del ejemplo viejo).
- **Password:** aleatorio fuerte. Reusar el patrón de `randomShellPassword` (`webdock-real-adapter.ts:~1346`, `randomBytes` de `node:crypto`) — NO derivar del dominio.
- **Cifrado en reposo:** AES-256-GCM con `CREDENTIAL_ENCRYPTION_KEY` (env). Guardar `{iv, authTag, ciphertext}` + metadata **no-secreta** (host, puertos 587/465, user, createdAt) en el inventario, siguiendo el patrón `updateInventoryJson("domains.json", ...)` de `dkim-keypair.ts:106-113` (un campo nuevo, p.ej. `smtpCredential`, additive — no toca `emailAuth`).
- El plaintext del password existe solo: (a) en el momento de generarlo para setear el passdb por SSH, (b) al descifrar para la descarga. **Nunca se persiste en claro, nunca entra a run-state/audit/chat** (invariante #3).

## 3. Fase 3 — Retrofit de los SMTPs ya creados (completar lo que falta)

Job idempotente que, por cada SMTP existente en inventario (los 8: Webdock server85/88/91 + Contabo vmi338../339..), vía el SSH runner (`createSmtpSshRunnerFromEnv:529`):
1. Instala `dovecot-core` + habilita submission/smtps + agrega `permit_sasl_authenticated` (additive).
2. Crea el user `mailer@<domain>` con password generado.
3. Cifra + guarda la credencial (Fase 2).
4. **Verifica que el relay viejo siga vivo** (smoke `localhost:25`) y que 587/465 respondan.
- Re-correrlo es seguro (si ya existe el user, no duplica). Si un server no responde SSH, lo marca pendiente y sigue con el resto (no aborta el batch).

## 4. Fase 4 — Descarga en el panel (3 acciones) · UBICACIÓN VERIFICADA EN VIVO

**Va en Sender Pool, NO en Infraestructura.** Revisado en el panel en vivo (2026-06-22): Infraestructura (`/infrastructure`) es **"Solo lectura"** (inventario/observabilidad — agregarle acciones rompería su contrato). Sender Pool (`/sender-pool`) es el hogar semántico ("cada dominio que envía vive acá con deliverability/health") y su componente **ya está construido para listar dominios por tarjeta** (`apps/admin-panel/src/features/sender-pool/index.tsx:232` `domains.map(...)`), pero hoy muestra **empty state** porque `/v1/sender-pool/status` no trae datos (`:11`, `:209-210`, `:405` "endpoint pendiente"). Por eso agregar acá es **additive y de bajo riesgo: no hay datos existentes en pantalla que romper.**

- **Endpoint `sender-pool-status.ts`** (ya lee `domains.json` y arma summary por dominio, `:129-148`): agregar a cada summary el flag **`hasCredential`** + metadata SMTP **no-secreta** (host, puertos 587/465, user). **Nunca el password.** Y asegurar que devuelva los SMTPs productivos (hoy el pool sale vacío → por eso OpenClaw "no ve" credenciales).
- **Componente `sender-pool/index.tsx`**: en la tarjeta por dominio (`:232`) agregar el botón **`Descargar credencial`**; en el header, **`Exportar inventario`** (sin secretos) y **`Export masivo`** (gateado).
- **El download real** = endpoint nuevo gateado (patrón `sensitive-read-auth.ts`, **auditado: quién descargó qué y cuándo**) que descifra server-side y sirve el `.md`.

Las 3 acciones:

1. **`Descargar credencial` (por SMTP) — default.** Descifra server-side → arma el `.md` (formato de `outputs/SMTP_credenciales_EJEMPLO.md`: bloque SMTP + guía de integración, **sin** DKIM private key ni SSH). Es lo que se entrega al cliente.
2. **`Exportar inventario` (grupal, SIN secretos) — libre.** Lista dominio/host/puertos/user/estado/reputación, **sin passwords**. Para el operador.
3. **`Export masivo` (grupal, CON secretos) — gateado.** Confirmación extra + link que **expira / un-solo-uso** + auditado. Solo casos puntuales (migración/backup). No es el flujo cotidiano.

## 5. Fase 5 — OpenClaw aprende a entregarlas (según la pregunta)

En `OPENCLAW_SYSTEM_PROMPT.md` agregar una sección (y re-ensamblar con `scripts/openclaw/build-system-context.sh`). **Mantener** las prohibiciones `:128-129/:159/:301/:344`. Agregar la conducta:

- **"dame/entregame las credenciales de `<dominio>`"** → "Listas. Descargalas en el panel → SMTP `<dominio>` → *Descargar credencial*." + ofrecer la guía de integración (no-secreta). **No imprime el password.**
- **"cómo integro / cómo se usa el SMTP `<dominio>`"** → da la **guía de integración** (host/puerto 587/465/usuario + pasos del `.md`). Es info no-secreta, sí la puede dar.
- **"cuál es el password de `<dominio>`"** → "Por seguridad no lo muestro en el chat; está en la descarga del panel." (regla existente + redirect constructivo).
- **"descargá todas / dame el inventario"** → apunta a *Exportar inventario* (sin secretos); si pide secretos en masa, advierte y apunta a *Export masivo* gateado.
- **Importante:** tras el retrofit, OpenClaw debe **saber que los SMTPs YA tienen credencial** (vía un flag no-secreto `hasCredential: true` en el inventario) — así deja de decir "no tengo credenciales" y dirige a la descarga.

## 6. DoD / Verificación

- Un SMTP nuevo termina con `mailer@<domain>` autenticando en **587 STARTTLS y 465 SSL** (probar con `swaks --auth`), **y el relay `localhost:25` sigue funcionando** (smoke).
- Los **8 existentes** quedan con credencial tras el retrofit, **sin perder su relay** (smoke a los 8).
- `Descargar credencial` produce el `.md` con el formato del ejemplo, **sin** private key ni SSH.
- **El password NO aparece** en run-state, audit-chain, live-context ni chat (test que lo asegure: generar credencial, leer run-state/audit, assert que no está en claro).
- OpenClaw, ante las 5 preguntas de Fase 5, **dirige al panel / da la guía y nunca imprime el secreto** (probar en vivo).
- `npm test` + `npm run test:admin` verdes. Webdock byte-idéntico. Sin secretos expuestos. Merge a `produ`.

## 7. Anclas (file:linea)

- Provisioning: `smtp-provisioning.ts:577-668` (buildSmtpProvisionPlan), `:600` (install), `:821-841` (renderPostfixMainCf), `:838` (recipient_restrictions), `:659` (restart), `:664` (verify puertos), `:529` (SSH runner).
- Storage inventario: `dkim-keypair.ts:106-113` (updateInventoryJson domains.json), `:20` (emailAuth shape).
- Redacción (la credencial DEBE caer acá): `orchestrator-smtp.ts:2171-2183` (sanitizeJsonValue), `:1806`, `:3575`; live-context `openclaw-bedrock-bridge.ts` (redactSensitiveLiveContext).
- Password aleatorio (patrón): `webdock-real-adapter.ts:~1346` (randomShellPassword / randomBytes).
- OpenClaw prompt: `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md:128-129, 159, 301, 344` + `scripts/openclaw/build-system-context.sh`.
- Routes/gating: `apps/gateway-api/src/routes/sensitive-read-auth.ts` (patrón de gate).
- **UI (verificado en vivo):** `apps/admin-panel/src/features/sender-pool/index.tsx:232` (tarjeta por dominio — YA construida, hoy empty), `:75` (consume `/v1/sender-pool/status`), `:209-210`/`:355` (EmptyPoolState). Endpoint `apps/gateway-api/src/routes/sender-pool-status.ts:129-148` (summary por dominio desde `domains.json` — agregarle `hasCredential` + metadata SMTP no-secreta). **NO `infrastructure` (es read-only).**
- Ejemplo objetivo del `.md`: `outputs/SMTP_credenciales_EJEMPLO.md`.

## 8. CORRECCIONES / pitfalls a evitar

- **NO** reemplazar `permit_mynetworks` (rompería el relay/smoke). Solo agregar `permit_sasl_authenticated`.
- **NO** guardar el password en claro en ningún `.json`/run-state/audit. Solo cifrado + metadata.
- **NO** meter la `CREDENTIAL_ENCRYPTION_KEY` en código/chat/logs (va en env).
- **NO** incluir DKIM private key ni SSH en el `.md` del cliente.
- El retrofit **NO** debe abortar todo el batch si un server falla — degradar ese y seguir.
- OpenClaw **NO** debe imprimir el secreto bajo ninguna frase; solo apuntar + guía.
