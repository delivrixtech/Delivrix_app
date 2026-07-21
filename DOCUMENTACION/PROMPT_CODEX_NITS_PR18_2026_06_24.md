# PROMPT CODEX — Follow-up nits del PR #18 (post-merge)

PR #18 (commit 4155fba) auditado por 8 subagentes = APROBADO/MERGEADO. Estos son los 2 nits
detectados en la auditoria, a cerrar como follow-up. Ninguno bloquea el merge; el NIT-1 (seguridad)
debe cerrarse ANTES de exponer `read_conversation` a OpenClaw en produccion.

## NIT-1 (SEGURIDAD, prioridad alta) — redaccion de chat-history deja pasar secretos cortos

PROBLEMA: `read_conversation` / `list_conversations` redactan el contenido del chat antes de
devolverlo, pero la redaccion solo cubre secretos con formato reconocible (PEM, AWS, Bearer,
`clave=valor`, base64 >=80 chars). Deja pasar EN CLARO:
- contrasenas SMTP cortas de alta entropia sin keyword adyacente (ej. `... smtp: Xk9mPq2vLr7wNb3t`),
  24-32 chars.
- tokens hex/UUID de 32-64 chars sueltos (read-boundary 64hex, HMAC) sin `token=`/`token is`.
Causa: el umbral de la regla generica de "token largo" es `{80,}` (demasiado alto) y la lista de
keywords no incluye `smtp`. Como el proposito de estas tools es leerle a OpenClaw historial que el
equipo SABE que contiene credenciales SMTP, es load-bearing.

ARCHIVOS: la cadena de redaccion en `apps/gateway-api/src/routes/openclaw-chat-history.ts:86-94`
(`redactChatHistoryText`) que compone `redactRuntimeLogSecrets` (en `gateway-runtime-log.ts:~116-124`)
+ data:image + keyword "is/es" + base64-like `{80,}`.

FIX:
1. Bajar el umbral generico de alta entropia de `{80,}` a ~32-40, o (mejor) anadir un detector
   explicito de cadenas hex de 32/40/64 chars y de UUIDs.
2. Anadir `smtp` (y `sasl`, `dovecot`) a la lista de keywords de `redactRuntimeLogSecrets`, y cubrir
   el separador `:` con espacio en la regla de lenguaje natural (no solo `=`/`is`/`es`).
3. NO redactar tan agresivo que rompa contenido legitimo (IPs, slugs): apuntar a alta entropia.

DoD: test nuevo en `openclaw-chat-history.test.ts` con (a) una contrasena SMTP de 28 chars suelta
tras `smtp:`, (b) un token 64hex suelto, (c) una linea `smtp_sasl_password_maps user:pass` -> los 3
redactados; y un caso de control (IP, slug, hostname normal) que NO se redacta. Confirmar que los
tests existentes de redaccion (Bearer/PEM/password=) siguen verdes.

## NIT-2 (funcional, prioridad media) — el sub-cap de chars deja el item-limit inerte y parte el JSON

PROBLEMA: en `summarizeInventoryServers`, el bloque `inventory_servers` se serializa con
`stringifyLiveContext(value, 5000)` que hace `JSON.stringify(...).slice(0, 5000)` — corte DURO de
string. Con filas merged (webdock+infra, labels largos ~359 chars/fila) caben ~13 filas antes de los
5000 chars, asi que el `item-limit` de 20 NUNCA se alcanza y el `.slice(5000)` deja JSON INVALIDO
(sin llaves de cierre). Mitigado hoy por el round-robin (cada cuenta queda representada en las
primeras filas) y por `count` honesto (reporta el total real), por eso es media y no alta.

ARCHIVOS: `apps/gateway-api/src/openclaw-bedrock-bridge.ts` — `summarizeInventoryServers` (~1968-2014)
y `stringifyLiveContext` (~1943).

FIX (elegir uno):
- A (preferido): truncar el bloque servers POR ITEMS dentro de `summarizeInventoryServers` (respetar
  el item-limit y serializar solo esos items completos), en vez de delegar el corte de chars a
  `stringifyLiveContext`. Asi el JSON siempre cierra bien y el item-limit es efectivo.
- B (rapido): subir el sub-cap de servers a ~8500 chars y subir `liveContextMaxChars` (hoy 18000,
  ya rebasado por la suma de sub-caps ~26000) de forma acorde, vigilando que no expulse secciones de
  cola criticas. Menos limpio que A.

DoD: con un inventario de 5 cuentas + Contabo (>13 servers), el bloque `inventory_servers` del
live_context es JSON VALIDO (parsea sin error) y contiene al menos un server de cada cuenta; el
`count` sigue reportando el total. Test en `openclaw-bedrock-bridge.test.ts`.

## MENORES (opcionales, no urgentes)
- `OPENCLAW_SYSTEM_PROMPT.md`: el header de la seccion 4 dice "version 2.12" pero el changelog ya es
  v2.13 -> alinear.
- `list_conversations` / `read_conversation` estan en PERMISSIONS_MATRIX + tools-builder pero NO en
  SKILLS_CATALOG -> confirmar que el guard de sincronizacion del catalogo no las exige (o anadirlas).
- DEUDA PREEXISTENTE (no del PR #18): el bloque AGENTS.md hardcodeado en
  `scripts/openclaw/build-system-context.sh:160-308` sigue diciendo "delivrix-fleet-ops: lee ...
  Webdock inventory" (sin el viraje a infrastructure inventory) -> alinear o, mejor, hacerlo leer del
  .md como ya hace con la seccion 4.

---

## RESIDUALES DEL AUDIT DE PR #21 (P3, no bloqueantes — anotados, sin issue por decision del operador)
Auditoria de 15 subagentes, 2026-06-24. PR #21 (commit 56cfbfe) es MERGE-READY; estos son follow-ups menores:

R1 (seguridad, PRE-EXISTENTE, no del PR): un password humano dentro de JSON `{"password":"..."}` se
   escapa por el path de runtime-log, porque la regex `\b(key)\b\s*[:=]` no admite la comilla de cierre
   entre la key y el `:`. En chat lo cubren los fallbacks hex/UUID/base64 (solo passwords humanos de
   baja entropia en JSON se filtran, y solo por runtime-log). Fix opcional: permitir comilla opcional
   `\b(key)\b["']?\s*[:=]` + portar los fallbacks hex/UUID/base64 al runtime-log path + anclar
   `smtp_sasl_password_maps` saltando un `hash:/...` intermedio.
R2 (NIT-2): la representacion por cuenta se degrada SILENCIOSA con >11-12 cuentas — el budget de 5000
   chars ata el bloque a ~11 filas mostradas, asi que con mas cuentas las ultimas (Contabo va al final
   del round-robin) quedan con 0 servers mientras `count` sigue honesto. Hoy 6 cuentas => margen ~2x.
   Fix: garantizar >=1 fila por cuenta antes de rellenar el resto + test con displayed < n-cuentas.
R3 (NIT-1): `dovecot_password` no esta en el alternation (solo `smtp[_ -]?password`) -> agregarlo.
   Falta un test en la frontera 19/20 chars del umbral de entropia.
R4 (NIT-1): UUIDv6/v7 CON guiones se escapan (el regex UUID es RFC-estricto v1-5). Delivrix usa v4 ->
   marginal; ampliar a v6/v7 si empiezan a emitirse.
R5 (cosmetico): round-robin no ordena grupos/servers por slug (reproducibilidad defensiva que pidio
   QA) + validacion redundante de conversationId en el invocador HTTP (tool-use-processor.ts:807; ya
   cubierto por doble capa boundedId + normalizeConversationId, seria solo simetria).
