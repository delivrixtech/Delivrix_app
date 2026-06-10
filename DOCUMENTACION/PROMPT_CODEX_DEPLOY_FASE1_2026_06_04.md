# Codex — Deploy Fase 1 con AUTONOMÍA ON, a LOCAL **y** HOSTINGER (hazlo bien)

> **Decisión Juanes:** AUTONOMÍA total. Flag ON, run 100% autónomo (1 firma de plan). **NO** per-step, **NO** cambios que quiten autonomía. Deploy a **local Y Hostinger** (no solo local).
> **Por qué OpenClaw seguía pidiendo terminal/clave a mano:** `produ` está en `346e1ea` — el fix `ed61f34` **NO está desplegado** + autonomía OFF. El agente vivo corre **código viejo e improvisa** el plan per-step. **Este deploy ES el arreglo.**
> **Auditado (anclas reales):** Fase 1 (`ed61f34`) GO, base correcta (contiene Fase 0 `1312388`). Si algo choca → parar y reportar. Requiere tu firma + backup/rollback.

## Qué elimina este deploy (verificado en auditoría)
- **DKIM 100% server-side, sin terminal local:** orquestador paso 9 → `smtp-provisioning.ts:175` `ensureDkimKeyPair` → `dkim-keypair.ts:53` `generateKeyPairSync` (node:crypto). El blocker `dkim_private_key_missing` **no puede dispararse** por esta vía. El agente NO pide openssl ni clave a nadie.
- **Cero pausas mid-run:** `testEmailRecipient/Subject/Body` y `seedInboxes` son params del plan `configure_complete_smtp` (`skill-schemas.ts`), consumidos en pasos 12 (warmup) y 14 (send). Se piden UNA vez en el plan.
- **Orquestador forzado:** con ambos flags ON, las subtools sueltas se bloquean (`tool-use-processor.ts:178`) → el agente NO puede volver al plan improvisado que pedía manual.
- **Lag DNS manejado:** polling en pasos 3/8/11 (`wait_for_dns_propagation`, hasta 30/10/10 min) → el "changeId ok pero zona vacía" se resuelve solo, no es fallo silencioso.

## Por qué LOCAL **y** HOSTINGER (los dos, sí o sí)
- **Local (gateway):** ejecuta tools + DKIM server-side + orquestador + maneja el flag de autonomía. Sin esto, el agente no tiene el fix de ejecución.
- **Hostinger (system-context v2.6):** tiene el **prompt** (reglas: usar `configure_complete_smtp`, 1 firma, no pedir manual). Sin esto, el agente con tools nuevas pero **prompt viejo seguiría improvisando**.
- Deployar solo uno = comportamiento roto. Van juntos (regla de sync permanente).

## Flags (autónomo)
- `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE` = **ON**
- `OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE` = **ON**
- `SMTP_SEND_REAL_EMAIL_ENABLE` = **ON** (smoke real)
- Verificá ON (ya deberían): `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE`, `AWS_ROUTE53_DNS_ENABLE_WRITES`, `WEBDOCK_SERVERS_ENABLE_CREATE`, `SMTP_PROVISIONING_ENABLE_SSH`, `EMAIL_AUTH_ENABLE_WRITES`, `WARMUP_ENABLE_SEND`.

## Pasos
1. **FF `produ` → `ed61f34`** (trae Fase 0+1 lineal). Verificá `git log --oneline -1 produ` = `ed61f34`.
2. **Seed verified_fact:** corré el seed de los 7 dominios de producción contra la DB viva. Verificá que quedaron `verified_fact` (protege prod en modo autónomo).
3. **Deploy LOCAL:** reiniciar gateway + panel desde el **repo canónico** (`~/Documents/delivrix app` en `produ`), graceful, **Node 24**, NO desde `/tmp`. Confirmá los 3 flags ON en el `.env.local` vivo.
4. **Deploy HOSTINGER:** backup remoto del `system-context.txt` + `WORKTREE=<checkout real> bash scripts/openclaw/build-system-context.sh` (sin `OPENCLAW_CONTEXT_LOCAL_ONLY`). Verificá `promptVersion openclaw-prompt-v2.6` en el container. (El push del system-context es por SSH al container, distinto del bridge HTTP `/api/chat.send` que sigue degradado — si ese bridge bloquea algo, reportá, pero el system-context debe entrar.)
5. **Backup/rollback:** anotá PID/commit previos del gateway.

## PTR (único paso manual — límite del proveedor, no bug)
- El Webdock API **no permite setear PTR** (`webdock-real-adapter.ts:635` → `not_supported_by_api`). El run **NO se traba** por esto (lo reporta y continúa; afecta reputación/warmup, no corta).
- **Acción de Juanes:** en el panel Webdock, PTR del server → `45.136.70.47 → mail.<dominio>`. Se puede hacer antes o después del run.
- Verificá que el orquestador NO hard-blockee por PTR ausente (debe reportar `ptrSkipReason` y seguir).

## Verificación — EN AMBOS LADOS (criterio de éxito)
**Local:**
- El agente ante "configurá SMTP" **enruta a `configure_complete_smtp`** (no improvisa subtools).
- Aparece **1 tarjeta de Plan flotante** → firmás una vez → corre autónomo, **DKIM auto** (sin pedir terminal/clave), termina en smoke real al inbox de Juanes.
- 37.842Z bloqueado; scratch 200; read_dns_ionos/route53 200.

**Hostinger:**
- `system-context.txt` remoto = v2.6 (no v2.5/viejo). Confirmá que el prompt remoto **no instruye** generar clave en terminal local ni pedir openssl (esa conducta era del prompt/código viejo).
- El agente remoto, al preguntarle, refleja las reglas nuevas (orquestador + 1 firma + no manual).

**Rollback** si falla: restaurar backup remoto + revertir gateway al commit previo. Reportá SHA + verificación de cada lado por separado.

## Después del deploy — mensaje del operador a OpenClaw (run autónomo, DOMINIO NUEVO)
controldelivrix.app está a medias y la idempotencia quedó diferida → el primer run autónomo va a un **dominio nuevo** (corre limpio). controldelivrix se retoma con idempotencia.
*"Configurá SMTP completo para un dominio nuevo con `configure_complete_smtp`. Budget USD 25, envío de prueba a <tu-email>."*
→ propone dominios (`suggest_safe_domain`) → elegís → **firmás el Plan** → corre solo de punta a punta (compra, DNS, VPS, Postfix+DKIM auto, email-auth, warmup, smoke). Vos mirando el Live (que ahora SÍ muestra todo lo que el gateway ejecuta) con el kill-switch a mano. PTR lo seteás en Webdock cuando quieras.

## Hecho cuando
`produ=ed61f34` + seed corrido + **deploy verificado en LOCAL Y HOSTINGER (cada lado por separado)** + un SMTP completo configurado **100% autónomo en dominio nuevo con 1 sola firma**, smoke entregado, **sin un solo pedido de terminal manual**. Reportá SHA + verificación de ambos lados. (Pendiente para escalar: idempotencia + dry-run + PTR vía API si Webdock lo habilita.)
