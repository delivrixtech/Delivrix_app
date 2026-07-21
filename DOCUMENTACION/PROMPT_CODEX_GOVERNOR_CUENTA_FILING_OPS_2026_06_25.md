# PROMPT CODEX — Fixes del caso filing-ops (governor + targetear cuenta + prompt + blacklist)

Contexto: auditoria de 9 subagentes (ver memoria/informe). `configure_complete_smtp` creo server139
(filing-ops.com, IP 92.113.146.181) en la cuenta Webdock 'ops' cuando el operador pidio 'quaternary'
(emael). Causa raiz: el governor excluyo quaternary por un read LIVE TRANSITORIO fallido (VERIFICADO
LIVE: emael esta sana ahora) + no se puede targetear cuenta + el fallo es invisible. Ademas la IP
cayo en Spamhaus (SBL CSS). 4 fixes; ninguno es bloqueante de produccion pero todos son reales.

## FIX 1 (governor, P1) — no excluir una cuenta sana por un read transitorio + observabilidad
HOY: `resolveCreationAccount` (apps/gateway-api/src/routes/orchestrator-smtp.ts:3864-3880) hace UN
read live por cuenta SIN retry; si falla (429/red/timeout o cache stale) -> `healthy:false` -> la
cuenta queda excluida para TODO el run (creation-rate-governor.ts:353). La exclusion es INVISIBLE: el
evento `oc.orchestrator.creation_rate_read_failed` (orchestrator-smtp.ts:4053-4102) SOLO se emite si
NINGUNA cuenta leyo live (gate `evaluations.length===0`, :3902-3909). Cache ASIMETRICA: `ops`
`cacheTtlMs:0` (main.ts:398, siempre fresco) vs secundarias TTL 60s (webdock-real-adapter.ts:182) ->
las secundarias son mas susceptibles a quedar congeladas con un fallo transitorio.
FIX: (a) reintentar el read 1 vez (backoff corto, p.ej. 300-800ms) antes de marcar `healthy:false`;
(b) EMITIR un evento de exclusion por-cuenta (`oc.orchestrator.creation_account_skipped` con
accountId + failureKind + httpStatus) AUNQUE haya cuentas sanas -> observabilidad; (c) igualar el TTL
de cache entre cuentas (todas 0, o invalidar la cache de la cuenta antes del read del governor).
DoD: test que simule read transitorio de una cuenta -> reintenta y la incluye; el skip se audita.

## FIX 2 (targetear cuenta, P2) — `webdockAccountId` opcional en el scope firmado
HOY: `configure_complete_smtp` NO acepta cuenta (input_schema openclaw-tools-builder.ts:923-970, 13
props, ninguna de cuenta); el accountId va por canal paralelo (`serverAccountId`) que produce el
governor, FUERA de params/hashInput (orchestrator-smtp.ts:883-896). El plumbing de `serverAccountId`
YA existe end-to-end (main.ts:644-657; runState :896; dispatch :919) -> NO es hito desde cero.
FIX: exponer `webdockAccountId?` OPCIONAL en el scope FIRMADO del plan (NO en el hashInput de params;
viaja por el mismo canal paralelo que `serverAccountId`). Si esta presente y la cuenta es elegible
(canCreate + read live OK), el governor la respeta como OVERRIDE (sin caer al tie-break); si NO es
elegible, FALLA CLARO ("cuenta X no disponible: <razon>"), nunca cae silenciosamente a 'ops'.
DoD: el operador puede firmar un plan con `webdockAccountId:"quaternary"` y el create va ahi, o falla
explicando por que. Respetar la invariante: el accountId NO entra al hashInput (no rompe idempotencia/
resume).

## FIX 3 (prompt, P2) — documentar la limitacion + gate de satisfacibilidad
HOY: el system-prompt describe `configure_complete_smtp` como "wrapper E2E 14 pasos" sin params
(DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md:216), no nombra cuentas, y presenta el governor solo como
LIMITE (rate), nunca como SELECTOR automatico. OpenClaw no tenia forma de saber que "para emael" no
era satisfacible, ni de advertir ANTES de firmar/gastar USD 15.14.
FIX: (a) documentar que `configure_complete_smtp` NO targetea cuenta hoy (el governor elige; con
FIX2, via `webdockAccountId`); (b) gate de satisfacibilidad en flow [14]: si el operador nombra una
cuenta/entidad no parametrizable, ADVERTIR y escalar ANTES de firmar. OJO BUDGET: el prompt esta en
11786/11800 tokens; compactar otra seccion redundante si esto no entra.

## FIX 4 (blacklist en el flujo, P1 — seguridad de entrega) — chequear reputacion de la IP
HOY: el flujo crea el SMTP y lo declara 'completado' SIN chequear la reputacion de la IP. La IP de
filing-ops (92.113.146.181, rango Webdock estreno) esta en Spamhaus ZEN (SBL CSS, reason 127.0.0.3)
-> el correo NO entregaria bien. La skill `read_mxtoolbox_health` YA existe.
FIX: anadir un paso (o warning post-create, antes del smoke/warmup) que chequee la IP del VPS nuevo
en Spamhaus/DNSBL; si esta LISTADA, marcar el run con WARNING claro (no declarar 'completado limpio')
y proponer remediar (delisting / descartar / recrear en otro rango). DoD: un SMTP en IP blacklisteada
se reporta con warning explicito, no como exito silencioso.

## NOTA DE FONDO (no es fix de codigo)
El rango Webdock 92.113.146.x salio quemado igual que el 193.181.x (ivmSIP24, 20-jun). Es el problema
estructural de reputacion de rango compartido de Webdock -> refuerza la tesis de diversificacion
(Contabo + infra propia con IPs propias). Ningun fix de codigo elimina esto; el FIX 4 solo evita
GASTAR en un SMTP que no entregara.
