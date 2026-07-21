# BRIEF CODEX — Fix: recover/enable dan `no_candidate` por flag `hasCredential` desincronizado (cruzar el store real + reconciliar)

Fecha: 2026-06-24 · Ejecuta: **Codex** (backend + deploy) · Coordina: Juanes (CTO) · Auditado por Claude (en vivo) · Severidad: media-alta (bloquea recuperar credenciales de servers ya wipeados; el operador tuvo que usar `rotate` a mano en cada uno)

## Contexto (auditado EN VIVO 2026-06-23/24)

Tras el fix de durabilidad (`c0c6d58`), generar/recuperar credenciales SMTP daba **`409 no_candidate`** en `enable` y `recover` para servers que SI estaban configurados pero sin credencial (corpfiling-ops.com, controlnationalreport.com, etc.). Causa raiz confirmada:

- El wipe viejo borro el **material** de la credencial del store, pero dejo `smtpCredential.hasCredential = true` **stale** en `smtp-provisioning.json` (flag denormalizado).
- `shouldRetrofitServer` (en `smtp-sasl-retrofit.ts`) confia en ese flag: `const hasCredential = server.smtpCredential?.hasCredential === true;`
  - `enable` = `!hasConfiguredAuth || !hasCredential` -> con flag stale `true` da `false` -> excluido.
  - `recover` = `hasConfiguredAuth && !hasCredential` -> con flag stale `true` da `false` -> excluido.
  - `rotate` = `hasConfiguredAuth` -> unico que dispara (ignora el flag).

Resultado: el operador tuvo que usar `rotate` manualmente en cada server. `rotate` funciona (3 credenciales regeneradas + persistidas + .md descargado el 2026-06-24), pero NO deberia ser necesario adivinar el modo: `recover`/`enable` (y el boton "Generar credencial" del panel) deberian funcionar solos cuando el material realmente falta.

**El store REAL de credenciales** (post c0c6d58) es `smtp-credentials.json` (durable) con espejo legacy a `domains.json`. La verdad sobre "este dominio tiene credencial usable" la da `findSmtpCredentialRecord(workspace, domain)` + un record con `status === "configured"` (ver `publicSmtpCredentialMetadata`: `hasCredential = record.status === "configured"`).

## Fix (2 partes)

1. **Cross-check del store real (prioritario).** En el matching de candidatos (`shouldRetrofitServer` / `listSmtpSaslRetrofitCandidates` en `smtp-sasl-retrofit.ts`), NO confiar en `server.smtpCredential?.hasCredential`. En su lugar, determinar `hasCredential` consultando el store real: `findSmtpCredentialRecord(workspace, server.domain)` y considerar "tiene credencial" solo si existe un record con `status === "configured"`. Cuando el flag de provisioning dice `true` pero el store NO tiene record configurado -> tratar como **missing** -> `recover`/`enable` disparan. Cuando ambos coinciden (los dos true, o los dos false) -> comportamiento identico al actual.
2. **Reconciliacion de flags stale (recomendado, defensivo).** Un paso idempotente que **baje** `server.smtpCredential.hasCredential` a `false` (o limpie el sub-objeto) cuando el store no tiene record configurado para ese dominio. SOLO downgrade-cuando-falta; NUNCA upgrade silencioso (no inventar `true`). Asi `smtp-provisioning.json` deja de mentir y el panel/sender-pool quedan consistentes. Correrlo al boot o on-demand (no en caliente sobre cada request).

## Invariantes / no-regresion (CRITICO — el operador va a crear 2 SMTPs nuevos)

1. **NO tocar `configure_complete_smtp` (orquestador) ni el flujo de creacion de SMTP fresco.** Un dominio nuevo (server nuevo, flag `false`) debe seguir funcionando EXACTAMENTE igual con `enable` / boton "Generar credencial". Este fix es SOLO el matching de recuperacion.
2. **NO regenerar credenciales que SI existen.** El cross-check debe disparar `recover`/`enable` solo cuando el store genuinamente NO tiene record `configured`. Si hay credencial valida en el store, `enable` la sigue excluyendo (no pisar un `.md` que funciona).
3. **`rotate` sin cambios** (sigue ignorando el flag, fuerza nuevo siempre).
4. Password/secretos nunca a chat/audit/log; el cross-check lee metadata (`status`), NO desencripta.
5. Las 42 pruebas focales de credenciales actuales (smtp-credentials 6, openclaw-workspace 3, domains-purchase 17, enable-smtp-auth 5, smtp-sasl-retrofit 11) deben seguir verdes.
6. Sin emojis; ASCII en codigo; espanol formal en docs.

## DoD

- Server con flag stale `hasCredential=true` pero store sin record `configured` -> `recover` Y `enable` (boton "Generar credencial") **disparan** (ya no `no_candidate`). Probar con uno de los 3 que siguen stuck: **controlnational.com, corpfiling-infra.com, annualcorpfilings.com**.
- Server con credencial REAL en el store -> `enable` sigue dando `already_configured`/excluido (NO regenera).
- Reconciliacion idempotente: correrla 2 veces no cambia nada la 2da; nunca sube un flag a `true`.
- SMTP fresco (run completo) -> "Generar credencial"/`enable` funciona igual que hoy (test de no-regresion explicito).
- `npm test` (1175+) + `npm run test:admin` (70) verdes, + tests nuevos del cross-check y la reconciliacion. Deploy local + Hostinger. NO merge a produ sin review + auditoria en vivo de Claude.

## Anclas (verificadas 2026-06-24)

- Matching: `smtp-sasl-retrofit.ts` -> `shouldRetrofitServer(server, mode)` (lee `server.smtpCredential?.hasCredential`), `listSmtpSaslRetrofitCandidates(workspace, target, mode)` (ya recibe `workspace`, puede consultar el store).
- Store real: `smtp-credentials.ts` -> `findSmtpCredentialRecord` (:167), `readSmtpCredentialRecords` (:397), `publicSmtpCredentialMetadata` (`hasCredential = status==="configured"`, :320). Archivos: `smtp-credentials.json` (durable) + `domains.json` (legacy mirror).
- Dato stale de ejemplo (pre-fix): `smtp-provisioning.json` server85 / corpfiling-ops.com tenia `smtpCredential.hasCredential=true` con store vacio -> `enable`/`recover` no_candidate, `rotate` disparaba. Resuelto via rotate manual; este brief lo cierra para los que faltan.
- NO es la causa: el lock `withInventoryLock` (libera en finally, no re-entrante) ni el fail-closed de `readInventoryJson` (solo JSON corrupto; ENOENT->null) — ambos sanos, verificados.
