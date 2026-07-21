# PROMPT CODEX — Correctivos PR #22 (account lifecycle) ANTES de merge

Auditoria de 20 subagentes sobre PR #22 (rama codex/webdock-account-lifecycle, tip 87b202a).
El FEATURE CORE esta SOLIDO y aprobado: gate de baja firmado (HMAC + approval token), soft + reversible
+ auditado; estados finos (401 -> unauthorized resuelto); exclusion de retired de inventario/create/
fan-out; NO rompe panel/create-delete/legacy/#18/#21; accountId DNS-safe (sin path traversal);
modulo secret-redaction ReDoS-safe y byte-equivalente; y RESUELVE el caso real (pep.prz001 + Host
Latam se pueden retirar y dejan de dar 401). 35/35 tests targeted verdes, byte-identico runtime/
state/.audit/config.

PERO hay 2 BLOQUEANTES + 1 NIT, porque el PR AFIRMA cerrar hallazgos que NO cerro. Cerrar en UN commit
correctivo antes de mergear.

## BLOQUEANTE 1 (SEGURIDAD) — R1 NO esta cerrado: secretos en JSON se filtran
El commit 87b202a declara cerrado el hallazgo R1 ("redaccion compartida de secretos"), pero solo
EXTRAJO el regex defectuoso a `secret-redaction.ts` SIN arreglarlo (verificado: byte-equivalente vs
base 9167aeb). Reproducido empiricamente con el codigo del head:
- `{"password":"X"}`, `{"smtp_password":"X"}`, `{"approval_token":"X"}` se FILTRAN (sin redactar) en
  AMBOS paths: redactRuntimeLogSecrets Y redactChatHistoryText.
- Causa: el regex `\b(<keys>)\b\s*[:=]` exige la key pegada al separador; en JSON la key llega como
  `password"` + `:` y la comilla de cierre rompe el match. Aplica incluso a keys always-sensitive.
- Vector material: `redactChatHistoryText` corre el regex sobre texto LIBRE de chat y lo SIRVE por el
  endpoint de historial (lectura autenticada). Un operador que pegue un blob JSON con credenciales lo
  persiste y se devuelve sin redactar.
- Segundo gap relacionado: `smtp_password=X` (bare, sin JSON) FILTRA en runtime-log porque el `_`
  antes de `password` mata el `\b`; en chat si redacta. Asimetria a cerrar de paso.
FIX: en `secret-redaction.ts`, tolerar comilla/espacio opcional entre key y separador
(p.ej. `["']?\s*[:=]`) y cubrir keys con prefijo `_` (smtp_password / sasl_password). Anclas:
`apps/gateway-api/src/secret-redaction.ts` (sensitiveAssignmentKeyPattern + chatSensitiveAssignment
KeyPattern); consumidores `gateway-runtime-log.ts:~125` y `routes/openclaw-chat-history.ts:~104`.
DoD: tests en `secret-redaction.test.ts` con `{"password":".."}`, `{"smtp_password":".."}`,
`{"approval_token":".."}` y `smtp_password=..` bare -> los 4 REDACTADOS en AMBOS paths (el `message`
de runtime-log y el texto de chat-history). Controles (IP 193.181.213.29, hostname
smtp.corpfiling-ops.com, slug server85) siguen SIN redactar.

## BLOQUEANTE 2 (ROBUSTEZ, media-alta) — lifecycle JSON corrupto vacia inventario + 503 mudo
`listWebdockInventoryAccounts` (`main.ts:~405-411`) hace `await accountLifecycleStore.list()` SIN
try/catch, aguas arriba del `Promise.allSettled`. `JsonFileStore.readUnlocked` (json-file-store.ts:
66-77) RE-LANZA ante JSON corrupto (solo traga ENOENT). Impacto:
- `/v1/infrastructure/inventory` (panel): la seccion Webdock queda SILENCIOSAMENTE vacia (los adapters
  sanos ni se consultan), sin partialReason dedicado.
- `/v1/infrastructure/account-health`: `buildInventory` lanza -> handler atrapa en allSettled ->
  **503 MUDO** (sin log, sin integrity:partial). Es justo el endpoint que diagnostica salud de cuentas.
- El test verde lo ENMASCARA (stub limpio; ningun test alimenta JSON corrupto al store).
FIX: envolver el `list()` de `main.ts:~407` (y el de `buildInventory` `main.ts:~1999`) en try/catch
que DEGRADE: servir inventario/adapters SIN overlay de lifecycle (fallo = "ninguna cuenta retirada"),
emitir partialReason `webdock_lifecycle_overlay_unavailable` + log warn, y en account-health marcar
`integrity:partial` en vez de 503 mudo. (Opcional defensa en profundidad: envolver el `JSON.parse` de
`json-file-store.ts:69` en try/catch que degrade a defaultValue ante SyntaxError.)
DoD: test que alimente JSON corrupto al lifecycle store -> `/inventory` degrada con partialReason y
Webdock NO vacio; `/account-health` responde 200 con integrity:partial (no 503) + log.

## NIT (trivial, mismo commit) — type-error introducido por el PR
`skill-dispatcher.ts:744` usa `decision:"approved"` pero `AuditDecision`
(`packages/domain/src/audit-log.ts:5`) = `"allow"|"reject"|"n/a"`. Runtime lo normaliza a "allow"
(LocalFileAuditLog.normalizeDecision) -> NO rompe ejecucion, pero es type-error real. Fix:
`decision:"allow"`. (El otro error tsc, `skill-schemas.test.ts:224`, es cosmetico de test; opcional.)
NOTA: el claim "tsc verde" de Codex NO reproduce aqui: 121 errores, 119 pre-existentes/ambientales
(`@types/pg` ausente en este entorno), 2 del PR (este + el de test). Confirmar el entorno donde dio
verde, o agregar `@types/pg` a devDependencies.

## NO TOCAR (verificado solido por la flota)
Gate de baja, estados finos, exclusion de retired, no-regresion panel/create-delete/legacy/#18/#21,
accountId DNS-safe, ReDoS-safety del modulo. El refactor de redaccion a modulo compartido es BUENO
(byte-equivalente, sin reglas perdidas); solo falta arreglar el regex que YA venia mal de #21.

## DoD GLOBAL
Re-correr los payloads de B1 (redactan), el caso corrupto de B2 (degrada, no 503), `tsc` del archivo
tocado limpio para los 2 del PR, y la suite. Scope limpio (sin .audit/config/state/runtime).
