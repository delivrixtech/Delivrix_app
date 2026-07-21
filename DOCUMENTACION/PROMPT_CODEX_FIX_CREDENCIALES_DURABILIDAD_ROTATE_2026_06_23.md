# BRIEF CODEX — Las credenciales SMTP se BORRAN del gateway (no persisten) + falta rotate/recover

Fecha: 2026-06-23 · Ejecuta: **Codex** (backend + deploy) · Coordina: Juanes (CTO) · Auditado por Claude (en vivo) · Severidad: **ALTA — el feature de credenciales es inutilizable de forma confiable hasta esto**

## Contexto (auditado EN VIVO 2026-06-23)

- `GET /v1/sender-pool/status` (gateway vivo) devuelve **17 dominios, 0 con `hasCredential`**. CERO.
- PERO: corpfiling-ops.com y controlnational.com **tuvieron credencial creada + descargada** (.md, HTTP 200) en sesiones previas — o sea existieron en `domains.json`.
- Y `smtp-provisioning.json` tiene **6 servers con `smtpAuthStatus=configured`** (corpfiling-ops, controlnational, corpfiling-infra, annualcorpfilings, controlnationalreport, infranationalreport) **sin** credencial guardada en `domains.json -> smtpCredentials[]` (que esta en 0).

**Conclusion:** las credenciales **se borraron** del inventario que el gateway usa. Los servers quedaron con SASL configurado pero sin password guardado -> no se pueden descargar (no hay registro) ni regenerar (cae en el 409 `smtp_auth_configured_but_credential_missing` y **no existe rotate/force**). Caso concreto: infranationalreport.com tiene un passdb SASL en el server con un password que **nadie guardo nunca** -> SASL inutilizable salvo rotate.

**Lo que NO es la causa (ya verificado):** `domains.json` y `smtp-provisioning.json` son **gitignored** (no fue un `git checkout`). Y los 9 writers de `domains.json` **preservan `...current`** (incl. `smtp-credentials.ts:355`). Asi que NO es un writer parcial.

**Causa probable (a confirmar por Codex):** (a) un script de deploy/boot **re-seedea/resetea** `domains.json`; (b) `updateInventoryJson("domains.json")` lee `current` vacio/null en un momento transitorio (archivo bloqueado/no leido) y escribe `{...null, campo}` = pierde `smtpCredentials[]`; (c) el gateway cambia de **workspace path** entre deploys (la `domains.json` viva pasa a ser una nueva/vacia). La asimetria a explicar: `smtp-provisioning.json` (servers) sobrevivio, `domains.json` (credenciales) no.

## Fix (2 partes)

1. **DURABILIDAD (root cause, prioritario):** las credenciales deben sobrevivir restarts/deploys. Codex: (a) encontrar QUE borra `smtpCredentials[]` (revisar scripts de deploy/boot que tocan `runtime/openclaw-workspace/inventory/domains.json`, el path de workspace efectivo del gateway, y `updateInventoryJson` ante `current` null -> NUNCA escribir si la lectura del current fallo, fallar-seguro en vez de pisar); (b) considerar mover las credenciales a un store dedicado/durable separado de `domains.json` (que mezcla domains/dnsZones/emailAuth/nameserverUpdates/bindings/smtpCredentials -> mucha superficie de escritura concurrente sobre un mismo archivo). Test: crear credencial -> restart gateway -> sigue descargable.
2. **ROTATE/RECOVER (gateado):** endpoint/skill para regenerar la credencial de un server stuck (`smtpAuthStatus=configured` sin credencial). Reinstala el passdb SASL en el server con password nuevo + persiste el registro. Recupera los 6 servers atascados (incl. infranationalreport.com). Requiere aprobacion humana (mismo gate que `enable_smtp_auth`). **Nunca regenerar en silencio**; el rotate invalida el `.md` viejo (correcto, cambia el password).

## Invariantes / no-regresion

1. Password nunca a chat/audit/log; solo en la descarga `.md` gateada.
2. Rotate gateado por aprobacion (como `enable_smtp_auth`).
3. No tocar el flujo de envio (los SMTP siguen entregando por IP-relay; esto es solo SASL/credenciales).
4. No romper los otros campos de `domains.json` (domains/dnsZones/emailAuth/etc.).
5. Sin emojis; ASCII en codigo; espanol formal en docs.

## DoD

- Crear credencial -> **restart/redeploy del gateway -> la credencial sigue presente y descargable** (test de durabilidad).
- Rotate regenera + persiste + descargable para un server `smtpAuthStatus=configured` sin credencial.
- Los 6 servers atascados quedan recuperables (o al menos infranationalreport.com como prueba).
- `/v1/sender-pool/status` deja de mostrar `hasCredential=false` en servers que SI tienen SASL.
- `npm test` + `npm run test:admin` verdes (+ test de durabilidad + rotate). Deploy local + Hostinger.

## Anclas (verificadas en vivo 2026-06-23)

- `GET /v1/sender-pool/status` = 17 dominios / 0 con credencial (live).
- `runtime/openclaw-workspace/inventory/smtp-provisioning.json`: 6 servers `smtpAuthStatus=configured`. `domains.json -> smtpCredentials[]`: vacio (ambos gitignored).
- Writers de `domains.json` (todos preservan `...current`): `dkim-keypair.ts:111`, `domains-bind.ts:435`, `route53-zone-policy.ts:234`, `domains-dns.ts:853/880`, `domains-purchase.ts:1109`, `domain-nameservers.ts:482`, `domains-email-auth.ts:468`, `smtp-credentials.ts:339`.
- Edge stuck: `smtp-provisioning.ts` `findConfiguredSmtpAuthMissingCredentialInventory` (409 `smtp_auth_configured_but_credential_missing`).
