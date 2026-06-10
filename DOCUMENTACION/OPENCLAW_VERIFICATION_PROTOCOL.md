# OpenClaw — Protocolo de Verificación Externa y Auto-Reparación

Versión: v1.0 · 2026-06-10
Origen: incidente `smtp-controlnational-20260610` (diagnóstico cruzado operador + Claude).
Capa 1 carga las secciones 1–5 (núcleo). El apéndice §6 vive en Capa 2 RAG.

Objetivo: nunca declarar éxito ni catástrofe sin evidencia externa. Si falta algo:
analizar, reparar dentro del scope autorizado, re-verificar y aprender.

## 1. Jerarquía de fuentes de verdad

1. `run-state` + audit hash-chained: evidencia primaria, se lee primero siempre.
2. Verificación externa en vivo: DNS público vía read-tools, logs del MTA, buzón destino.
3. Inventario/caché propio: solo indicativo. Prohibido diagnosticar catástrofes desde caché.

Un error de parser/serialización del orquestador NO implica que la infraestructura
no exista. Ante una contradicción entre fuentes, re-leer 1 y 2 antes de declarar
cualquier cosa. Regla complementaria al Protocolo Antidelirio de Entidades.

## 2. Checklist externa post-build

Obligatoria al cerrar los pasos DNS de un run y antes de todo smoke. Resolver
siempre contra DNS público (read-tools del Gateway), nunca contra caché propio
ni inventario:

- zoneId↔dominio validado contra los NS reales antes de leer o escribir registros.
- SPF: TXT raíz contiene `ip4:<IP del server del run>` y termina en `-all`.
- DKIM: `<selector>._domainkey.<dominio>` resuelve `v=DKIM1` con `p=` no vacío.
- DMARC: `_dmarc.<dominio>` con `p=quarantine` o `reject` (con `rua=`, no quitarlo).
- FCrDNS par completo: PTR(IP) → hostname Y A(hostname) → la misma IP.
  Un PTR sin su A forward es FAIL aunque el PTR esté correcto (Gmail lo exige).
- MX del dominio remitente existe: los bounces a `hello@` deben tener destino.
- Blacklists `<ip-invertida>.zen.spamhaus.org` y `.bl.spamcop.net`:
  NXDOMAIN = limpio · `127.0.0.2-11` = listado (escalar, no auto-reparable) ·
  `127.255.255.x` = query bloqueada (repetir con resolver directo, no concluir).

## 3. Estados del correo

`queued` ≠ `sent` ≠ `inbox`. Cada estado exige su propia evidencia:

- `queued`: Postfix local lo aceptó. NO ES ÉXITO.
- `sent`: línea `status=sent (250 ...)` en el mail.log del server para ese
  messageId, y la cola (`postqueue -p`) ya sin ese mensaje.
- `inbox`: el correo visible en el buzón destino, carpeta INBOX (no SPAM), con
  `Authentication-Results: spf=pass dkim=pass dmarc=pass`.

Un smoke se reporta exitoso solo con los tres niveles confirmados. Si queda en
`deferred`: leer el motivo exacto en el log del MTA y volver a §2 — diagnosticar,
no adivinar.

## 4. Auto-reparación y escalada

Permitido bajo la PlanApproval vigente del run (mismo runId, domain, provider,
budget — cero gasto nuevo, idempotente, reversible):

- Re-upsert de registros DNS de la zona del run (A, MX, TXT/SPF/DKIM/DMARC).
- Flush de cola y reload de postfix/opendkim del server del run.
- Reintento del smoke tras un fix, con backoff (máximo 3 intentos).

Fuera de un run activo o sin PlanApproval que lo cubra: proponer la reparación
como proposal supervisada y esperar firma. Prohibido siempre sin firma nueva:
crear/destruir/recrear VPS o dominios, cualquier acción con gasto.

Bucle obligatorio: detectar → causa raíz con evidencia citada (eventId, log,
registro DNS) → fix mínimo → RE-VERIFICAR con §2/§3 → dejar rastro en audit.
Un fix sin re-verificación no cuenta como fix.

Si un check requerido no se puede ejecutar por falta de herramienta o acceso:
no improvisar ni declarar éxito parcial. Reportar en formato fijo:
`capability faltante: <nombre>` + qué intento lograr + qué acceso necesito +
workaround manual mientras tanto. Cada límite así reportado se convierte en una
actualización concreta que el operador puede generar.

## 5. Aprendizaje permanente

Tras cada incidente, gap o fix:

1. Escribir la lección en memoria episódica (TTL >= 60 días) con formato:
   síntoma → causa raíz → fix aplicado → check nuevo que lo previene.
2. Proponer el diff de este protocolo (nuevo check o regla) y pedir firma para
   incorporarlo a la versión siguiente.

Meta-regla: cada error solo puede ocurrir una vez. La segunda vez es un bug del
protocolo, no del run.

## 6. Apéndice — incidente 2026-06-10 (caso de estudio, Capa 2)

Run `smtp-controlnational-20260610` (controlnational.com, server88, 193.181.213.40)
y run previo de corpfiling-ops.com (server85). Cadena real de fallas:

1. El paso 14 (`send_real_email`) falló con `email_auth_incomplete` (DKIM aún sin
   propagar) pero quedó marcado `done`, y el parser final explotó con un confuso
   `missing messageId` en "step 0" → el run entero se reportó failed.
   Fix: guarda en `orchestrator-smtp.ts` (commit 2fbf2ab) — el paso queda
   reintenable y se reporta la causa real.
2. OpenClaw diagnosticó desde inventario cacheado que "el VPS no existe", siendo
   falso (server88 corría con FCrDNS verificado a las 05:10Z). Lección: §1.
3. El watchdog de auto-rollback DNS nunca matcheaba los MX (Node resolveMx entrega
   `exchange priority`; el matcher solo entendía `priority exchange`), expiraba a
   los 5 minutos exactos y "revertía": borraba el A y el MX recién creados, luego
   intentaba re-upsertear NS/SOA del snapshot, explotaba
   (`Unsupported Route53 DNS record type: NS`) y reportaba `rollbackApplied: false`
   — negando un borrado que sí ocurrió. Dos dominios mutilados el mismo día
   (controlnational.com 05:14Z, corpfiling-ops.com 03:19Z y 03:40Z), con PTR
   apuntando a hostnames sin A: FCrDNS roto enviando justo a Gmail.
   Fixes: matcher MX canónico ambos lados + ventana de propagación del watchdog
   alineada al paso 7 (30 min) en `auto-rollback.ts`; restore que filtra NS/SOA,
   no silencia errores y reporta fallas parciales en `domains-dns.ts`; tests de
   regresión con el snapshot real del incidente.
4. El smoke posterior se reportó exitoso con `deliveryStatus: queued` y
   pre-validaciones que no incluían FCrDNS ni MX. Lección: §2 y §3.

Evidencia: audit `oc.dns.records_updated` 05:09:13Z, `oc.webdock.identity_aligned`
05:10:10Z (fcrdns verified), `oc.dns.auto_rollback_failed` 05:14:15Z, snapshot
`runtime/rollback-snapshots/dns-route53-dns-route53-dns-be59f820-*.json`, y DNS
público del 2026-06-10 13:00Z: SPF/DKIM/DMARC presentes, A y MX ausentes.
