# Codex — FASE 1: autonomía de SMTP (1 firma de plan) + read_dns_ionos + pendientes + DEPLOY local **y** Hostinger

> **⚠️ DEPENDE DE FASE 0.** No empieces esto hasta que `PROMPT_CODEX_FASE0_CONTRATO_PERMISOS_2026_06_04.md` esté mergeado y verificado (contrato extendido a firma-de-plan-por-runId detrás del flag `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE`, bypasses legacy cerrados, system prompt reescrito, WORKTREE fix). Fase 1 implementa la autonomía SOBRE esa base, **con el flag ON y primero en dry-run** (todo menos gasto real y envío) antes de soltarlo con plata.
> **Rama (CRÍTICO — verificá la base):** Fase 0 (`1312388`) hoy vive SOLO en `codex/fase0-contrato`; `produ` NO la tiene aún (verificado). **PRIMERO** fast-forward `produ` → `1312388` (es 1 commit adelante, FF lineal) **o** ramificá directamente desde `codex/fase0-contrato`. Recién entonces creá `codex/fase1-autonomia`. **NO arranques desde un `produ` sin Fase 0** — repetiríamos el desastre de base vieja. Confirmá con `git log --oneline -1` que tu base incluye `1312388` antes de tocar nada.
> **Orquestación OBLIGATORIA (subagentes senior):** Backend Senior + AI Engineer Senior + Full-Stack Senior + QA Senior + **Auditor de Errores** (Defect Ledger, run real, bloquea regresión). Reportá el plan de subagentes ANTES de tocar código. Resolvé con criterio profesional; si algo de acá choca con el código real, **pará y reportá** en vez de forzar.
> **Principio (Juanes):** NO adivinar — verificá el estado real (curl/API/grep) antes de actuar y antes de dar algo por hecho.
> **REGLA PERMANENTE (no negociable):** todo cambio que afecte comportamiento/contexto/tools del agente se deploya a **local Y Hostinger en la misma tanda**. Nunca dejar el agente remoto congelado. El §DEPLOY cubre ambos.
> **⚠️ NO ROMPER LA FIRMA:** el motor criptográfico (`proposals-sign.ts`: HMAC + nonce exactly-once + audit chain SHA-256 + kill-switch, token TTL 5min) NO se toca. Lo que cambia es **dónde y cuántas veces se pide el consentimiento humano** (una vez, a nivel plan), no el mecanismo. Todo cambio es **aditivo y con tests de no-regresión** (`proposals-sign.test.ts`, `proposals-reject.test.ts` deben quedar verdes sin cambio de contrato).

---

## PARTE 2 (núcleo) — Autonomía de SMTP: UNA "Aprobación de Plan" → run 100% autónomo bajo guardrails

**Decisión de Juanes (CTO):** el humano **confirma el dominio sugerido y firma el plan UNA vez**; de ahí el orquestador ejecuta el ciclo completo (DNS → VPS → SSH Postfix/DKIM → email-auth → warmup → envío de prueba) **100% autónomo**, con subagentes si aplica. Se elimina el flujo de ~9 firmas por paso. Lo que hace que esto sea seguro NO es firmar cada paso, sino **guardrails duros automáticos** (abajo).

**Estado verificado (anclas reales):**
- Orquestador determinista de **14 pasos** ya existe y está probado: `apps/gateway-api/src/routes/orchestrator-smtp.ts:234-444`; test de secuencia `orchestrator-smtp.test.ts:20`. Read-only los pasos 1/5/13; gateados 2,3,4,6,7,8,9,10,11,12,14.
- Expuesto como tool `configure_complete_smtp`: `apps/gateway-api/src/openclaw-tools-builder.ts:642-720`, detrás del flag `OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE` (`runtime-env.ts:21`).
- Ya trae **`runId` por corrida** y proposals scoped al run (`main.ts:401/431/440/443`) + rollback por run (`main.ts:507`). **Usá `runId` como ancla del "plan".**
- Ya trae **cap de presupuesto**: param `budgetUsdMax` (`skill-schemas.ts:114/125`, default 25, rango 1-10000; `openclaw-tools-builder.ts:654`) + `monthlySpendLocks` (`domains-purchase.ts:77`).
- **Causa de las ~9 firmas:** hoy TODO está aplanado a `supervised_local_state` (`main.ts:737-762`) y la tool dice *"ApprovalGate por cada acción real"* (`openclaw-tools-builder.ts:647`). El agente además **improvisa** tools sueltas (visto en vivo: `upsert_dns_route53`, `provision_smtp_postfix`) en vez de llamar al orquestador — probablemente porque el flag está apagado.

### Qué construir
1. **El agente NO improvisa pasos.** Para SMTP de punta a punta invoca **`configure_complete_smtp`** (un solo tool, determinista), no tools sueltas una por una.
   - Verificá/encendé `OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE` en el gateway vivo.
   - System prompt (bundle): regla dura — *"para aprovisionar SMTP completo, invocá `configure_complete_smtp`; NO ejecutes `upsert_dns_*`/`provision_smtp_postfix`/`create_webdock_server` sueltos salvo reparación puntual explícita."*

2. **Punto único de consentimiento = confirmación de dominio + Aprobación de Plan.**
   - `suggest_safe_domain` (read-only) propone candidatos → el operador **elige uno y firma el Plan** en la tarjeta flotante. Esa firma (vía `proposals-sign.ts`, HMAC real) autoriza la corrida con un **scope explícito**: `{ domain elegido, provider, budgetUsdMax, recipient del test, runId }`.
   - Persistí esa Aprobación de Plan como **autorización de la corrida** anclada al `runId` (reusá el runId existente). Es la capa de consentimiento humano para los pasos cubiertos.

3. **De ahí, autónomo bajo GUARDRAILS (esto es lo que reemplaza la firma por paso):** el orquestador corre los 14 pasos sin pedir más firmas, pero cada paso real:
   - se **audita** en la cadena (prevHash) — `audit-chain.ts`;
   - chequea el **kill-switch fail-closed ANTES de ejecutar** (patrón `proposals-sign.ts:327-365`) — el operador puede **abortar la corrida** en cualquier momento;
   - mintea su **token de ejecución exactly-once** (nonce/TTL) bajo la autorización del plan — sin firma humana, pero conservando replay-guard;
   - **respeta `budgetUsdMax` server-side**: si el costo acumulado/proyectado lo excede → **ABORTA** y vuelve al humano (nunca gasta de más);
   - **scope-bound**: sólo actúa sobre el `{domain, server, run}` aprobado. Cualquier desvío (otro dominio, otro recipient, otra zona) → **STOP fail-closed** + re-pide firma. Acá aplica el **entity-guard/grounding ya desplegado** (no inventar entidades).
   - **abort-on-anomaly**: gate roto (audit chain), error irrecuperable o resultado inesperado → corta y reporta, no sigue a ciegas.

4. **Tarjeta flotante (UX):** la Aprobación de Plan se surfacea como **ventana flotante prominente** (estilo Claude/Codex), reusando `apps/admin-panel/src/v5/components/ApprovalGate.tsx` + `POST /v1/openclaw/proposals/{id}/sign`. Muestra el **plan completo** (dominio, costo estimado ~USD15 dominio + ~USD4.30/mes VPS, recipient del test, lista de pasos, budget cap). El agente **deja de pedir "Aprobado paso N" por texto** (no es firma) — remite a la tarjeta. Durante la corrida, mostrar **progreso por paso** (feed Live ya existe) + botón **Abortar** (kill-switch).

5. **Re-firma sólo en excepción:** cambio de scope, presupuesto excedido, o anomalía → nueva tarjeta de firma. En el camino feliz: **1 firma por SMTP completo.**

6. **(Multi-agente runtime, no bloqueante):** el orquestador puede apoyarse en subagentes para pasos paralelizables, manteniendo la misma autorización de plan + audit por subpaso (alineado con el ADR Track A).

### Tests (node:test, run real)
- Firmar el Plan una vez ejecuta los 14 pasos **sin más firmas** (mock de adapters); cada paso deja audit + token exactly-once.
- `budgetUsdMax` excedido → **aborta antes de gastar**.
- **Scope deviation** (dominio ≠ aprobado) → fail-closed, re-pide firma.
- **Kill-switch** armado a mitad de corrida → corta (fail-closed).
- No-regresión: `proposals-sign.test.ts` + `proposals-reject.test.ts` verdes sin cambio de contrato; entity-guard/grounding intactos.

---

## PARTE 2.B — Generación DKIM autónoma (cierra el blocker `dkim_private_key_missing`, visto en vivo)

**Visto en vivo (2026-06-04):** la corrida se trabó en `provision_smtp_postfix` con `blocked — dkim_private_key_missing`. La salida que ofreció el agente (que el operador genere la clave en su terminal y pegue la pública en el chat) **rompe la autonomía** — esto es exactamente lo que NO queremos.

**Causa raíz (bug de ORDEN, confirmado en código):**
- El gateway YA sabe generar el par solo: `apps/gateway-api/src/routes/domains-email-auth.ts:166` (`generateKeyPairSync` rsa:2048) y lo escribe en `inventory/dkim-keys/<domain>/<selector>.private` (:176-177).
- Pero `provision_smtp_postfix` **exige la privada pre-existente** y NO la genera: `routes/smtp-provisioning.ts:158` (`findDkimPrivateKeyPath`), `:177` (`blockers.push("dkim_private_key_missing")`), `:233` (la lee).
- En el orquestador el orden es **paso 9 `provision_smtp_postfix`** (necesita la privada) → **paso 10 `configure_email_auth`** (genera el par): `orchestrator-smtp.ts:358-371`. Provision corre ANTES de que exista la clave. Encima el paso 10 espera `dkimPublicKey` del outcome del paso 9 (`:380`), que el provisioner hoy no produce. **El orquestador hereda el mismo bug** → enrutar a él no basta.

**Fix (autonomía, "Opción B" bien hecha):** generar el par DKIM **UNA sola vez, ANTES de `provision_smtp_postfix`**, y que provision (instala OpenDKIM con la privada) y email-auth (publica la pública como TXT) consuman **el mismo** par.
1. **Keygen antes de provision:** preferido — `provision_smtp_postfix` hace **generate-if-missing**: si `findDkimPrivateKeyPath` devuelve null, genera el par (reusá la lógica de `domains-email-auth.ts:166-177`), lo guarda con permisos **0600**, y devuelve `dkimPublicKey`. (Alternativa: paso/capacidad de keygen explícito antes del paso 9 en el orquestador.)
2. **Mismo keypair en ambos pasos (CRÍTICO):** la privada que instala OpenDKIM (paso 9) y la pública del TXT DNS (paso 10) **deben ser el mismo par**. Si email-auth regenera otro → DKIM falla silenciosamente (la firma no verifica). Email-auth debe **reusar** el par ya generado (leer la pública del outcome del paso 9 / del inventory), nunca crear uno nuevo.
3. **Selector único:** unificar el selector (en vivo se usó `s1-2026`; el orquestador default ronda `s2026a`). Una sola fuente de verdad, tomada del plan, consistente en keygen + provision + DNS TXT.
4. **Seguridad (no aflojar):** la **clave privada NUNCA** al chat / audit / contexto del modelo — sólo a disco con 0600. El audit guarda el **fingerprint/hash** de la pública (ya existe: `dkimPublicKeyHash`, `orchestrator-smtp.ts:972`), jamás la privada. La pública (base64) sí puede ir al TXT.
5. **PTR (reverse DNS):** verificá si el **Webdock API permite setear el PTR** (`45.136.70.47` → `mail.<dominio>`). Si sí → automatizalo en el run. Si no → el plan lo declara como **acción única del operador ANTES de la corrida**, no un bloqueo a mitad de camino. El run autónomo NO debe trabarse esperando PTR manual.

**Tests:** correr el orquestador **sin clave pre-existente** → genera el par, provision NO se bloquea, la pública del TXT coincide con la privada de OpenDKIM (mismo keypair), smoke E2E (paso 14) entrega; la privada nunca aparece en audit/chat; selector consistente punta a punta.

---

## PARTE 1 — `read_dns_ionos` (no escribir DNS a ciegas, también en modo autónomo)
Con el run autónomo, esto es **crítico**: antes de cualquier `upsert_dns_ionos` el orquestador DEBE leer la zona. El adapter **ya lee** (`packages/adapters/src/ionos-dns-actuator.ts`: `listRecords` :189, `findZoneByName` :337); falta exponerlo como tool.
1. Ruta `apps/gateway-api/src/routes/read-dns-ionos.ts` espejando `routes/route53-zone-records.ts`: input `domain` (resuelve zoneId) o `zoneId`; read-only; gateada por `authorizeSensitiveRead` (503 fail-closed); sin ApprovalGate.
2. Registrar tool `read_dns_ionos` en `openclaw-tools-builder.ts` (espejar `read_route53_zone_records`); read-only; agregarla al allowlist read-only de `tool-use-processor.ts` (~:945) y mandar `x-delivrix-token` (~:631).
3. System prompt + orquestador: **antes de `upsert_dns_ionos`, leer con `read_dns_ionos`**.
4. Tests: resuelve por domain; por zoneId; sin token → 503; sin regresión.

## PARTE 3 — Pendientes anteriores (diagnosticar primero, cerrar si siguen abiertos)
Detalle en `DOCUMENTACION/PROMPT_CODEX_FIX_OPERATOR_PARAMS_Y_SCRATCH401_2026_06_04.md`. **Diagnosticá el estado vivo antes de tocar:**
- **Route53 503:** en vivo ya lee (el agente leyó NS reales de `controldelivrix.app`). Sólo verificar; no re-hacer.
- **`read_episodic_scratch` 401:** si sigue 401, cablear `x-delivrix-token` en `tool-use-processor.ts` (mismo `readBoundaryToken`, fallback `DELIVRIX_READ_BOUNDARY_TOKEN ?? DELIVRIX_OPENCLAW_TOKEN`). Sin token → sigue fail-closed (I3). Test: 200 con datos.
- **Wrapper `<openclaw_operator_params>`:** si todavía se filtra al cuerpo, limpiarlo (frontend manda params como metadata estructurada; backend strip-and-extract defensivo). Test: el cuerpo que ve agente/UI no contiene el wrapper.

## PARTE 4 — Proteger los 7 dominios de producción (recomendado, refuerza el scope-guard)
Sembrar como `verified_fact` que los 7 dominios de producción (`fileyourcorp.app`, `filecorppro.net`, `nationalcorphub.app`, `swiftcorpdocs.app`, `annualcorpfilings.com`, `nfcorpreport.com`, `nfcorpreport.online`) son **sender stacks de producción activos**. En modo autónomo, el scope-guard + estos verified_facts impiden que una corrida pise un dominio de prod sin firma explícita.

---

## §DEPLOY — local **Y** Hostinger
Tras tests verdes (run real, **Node 24**) y **firma del operador**:

**A. Local**
1. Fast-forward `produ` a la nueva punta (lineal).
2. Reiniciar **gateway + panel** desde el **repo canónico** (`~/Documents/delivrix app` en `produ`), graceful (SIGTERM, no kill-9), **Node 24**, NO desde `/tmp`. Confirmá `OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE=true` en el `.env.local` del gateway vivo.

**B. Hostinger (para que el agente NO quede congelado)**
3. **Backup remoto** de `system-context.txt` + `AGENTS.md` (rollback).
4. Regenerar bundle y push: `WORKTREE=<checkout real> bash scripts/openclaw/build-system-context.sh` (SIN `OPENCLAW_CONTEXT_LOCAL_ONLY`). ⚠️ **Trampa conocida:** el `WORKTREE` por defecto apunta a un worktree viejo → si no lo seteás, deployás el prompt viejo. Verificá que el `system-context.txt` remoto contenga las reglas nuevas (invocar `configure_complete_smtp`, no improvisar; 1 firma de plan; leer IONOS antes de upsert; no pedir "Aprobado" por texto) + `promptVersion` actualizado.
5. Si el bridge remoto (`/api/chat.send` HTML/login) sigue degradado y bloquea el push/contrato → **PARÁ y reportá** (acción mayor, puede requerir rebuild de imagen; firma aparte).

**C. Verificación (criterio de éxito, ambos lados)**
- Local: el agente, ante "configurá SMTP en X", llama `configure_complete_smtp` (no improvisa); aparece **1 tarjeta flotante de Plan** con dominio/costo/recipient; al firmarla corre autónomo y termina en envío de prueba real; abortar funciona; budget/scope guards disparan en los tests; `read_dns_ionos(nationalcorphub.app)` devuelve records reales; sin regresión (grounding/37.842Z bloqueado, scratch 200, route53 200, proposals tests verdes).
- Hostinger: `system-context.txt` remoto = bundle nuevo; el agente remoto refleja las reglas nuevas.

**D. Rollback:** si falla la verificación → restaurar backup remoto + revertir gateway al commit previo. Reportá SHAs, qué se deployó **en cada lado** y el resultado de la verificación.

## PARTE 5 — Idempotencia / reanudar corridas a medio camino (caso controldelivrix.app)
La corrida viva de `controldelivrix.app` quedó a medias en el flujo viejo: hechos = **registro A + autoRenew** y **bind del dominio**; **bloqueada** en Postfix por `dkim_private_key_missing`. Tras el fix, una re-corrida del orquestador **NO debe re-comprar el dominio ni re-crear el VPS**.
- **Requisito — `configure_complete_smtp` idempotente/reanudable:** antes de cada paso, detectar si ya está hecho (dominio ya registrado en Route53, VPS ya running, dominio ya bindeado, records DNS ya presentes vía `read_route53_zone_records`/`read_dns_ionos`) y **saltarlo** (no-op auditado), continuando desde el primer paso pendiente. **Verificá el comportamiento actual; si no es idempotente, hacelo** (es lo que evita el doble gasto al reanudar).
- **Dry-run primero:** la primera corrida tras el deploy es **dry-run** (valida los 14 pasos, detecta lo ya hecho, NO gasta ni envía). Con dry-run verde → corrida real.
- **PTR:** si el Webdock API lo permite, dentro del run; si no, queda declarado como **acción pre-run única** del operador, nunca un bloqueo a mitad.
- **Mensaje del operador para reanudar** (lo que Juanes le dice a OpenClaw tras el deploy de Fase 1): *"Configurá SMTP completo de controldelivrix.app con `configure_complete_smtp` en dry-run"* → revisar la tarjeta de Plan → firmar → corrida autónoma (genera el DKIM sola, sin pedir openssl manual).

## Hecho cuando
Agente enruta a `configure_complete_smtp` (no improvisa) + **1 Aprobación de Plan** (tarjeta flotante, HMAC real intacta) cubre la corrida autónoma + guardrails (budget/kill-switch/scope/audit/exactly-once) con tests verdes + **DKIM autónomo** (sin `dkim_private_key_missing`, mismo keypair provision↔TXT, privada 0600) + `read_dns_ionos` viva + pendientes anteriores cerrados/verificados + dominios de prod protegidos + no-regresión de proposals + **deploy confirmado en local Y Hostinger**. Reportá SHA y verificación de ambos lados + Defect Ledger.
