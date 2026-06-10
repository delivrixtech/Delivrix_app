# Codex — FASE 2.4 (CORREGIDA tras re-auditoría): dominio FRESCO completa 1→14 en una pasada — fix MÍNIMO y SEGURO

> **Objetivo:** comprar un dominio nuevo y completar `configure_complete_smtp` 1→14 de UNA pasada, autenticando en Gmail (SPF/DKIM/DMARC PASS). El spam por reputación es esperado (warmup, fuera de scope).
> **IMPORTANTE — alcance recortado por re-auditoría (3 subagentes):** un draft previo proponía cablear `UpdateDomainNameservers`, forzar `reuse-only`, y editar el prompt + push Hostinger. **TODO ESO SE DESCARTÓ** por sobre-ingeniería/riesgo/regresión (detalle abajo). El fix real son **3 cambios quirúrgicos** que NO tocan lo que hoy funciona (controlcorpfiling.com entregó a Gmail; 4 dominios owned; resume; adopción).
> **Base:** `produ`/`main` ~`2bce12f`. Rama `codex/fase2.4-fresh-single-pass`. **Subagentes + Auditor.** Scope-fence estricto. Stop-and-report.
> **Por qué CI no lo atrapó:** los tests stubean el outcome del step 2 → nunca ejercen el `pending` real de AWS. Hay que modelar `RegisterDomain IN_PROGRESS→SUCCESSFUL`.

## Causa raíz (anclas 2bce12f)
- **P0-A:** el forward NO espera a que `RegisterDomain` complete. `domains-purchase.ts:489-552` responde `status:"pending"` HTTP 200 sin poll; el adapter no espera (`aws-route53-domains-adapter.ts:297-334`). El dispatcher marca step 2 `done` (2xx) y avanza a step 3 (`orchestrator-smtp.ts:487-519`). El poll `GetOperationDetail` (`reconcileRoute53DomainPurchase`, `domains-purchase.ts:735-815`) SOLO corre en la 2ª invocación (resume). Evidencia: controlcorpfiling.com y delivrix-notify.com siguen `pending` en `inventory/domains.json` pese a runs terminados.
- **P0-B (la zona) es 100% downstream de P0-A:** AWS `RegisterDomain` (sin pasar `Nameservers`, `adapter:311-321`) **auto-crea la hosted zone y delega los NS a ESA zona**. Si esperamos a SUCCESSFUL, para cuando corre step 7, esa zona ya existe en `listHostedZones` y está delegada → `resolveRoute53HostedZone({reuse-or-create})` (`route53-zone-policy.ts:138-150`) entra por **REUSE** (domainZones.length===1). La rama CREATE (length===0) solo se alcanza si corremos DNS antes de tiempo — exactamente lo que P0-A causa. **Arreglado P0-A, no hay 2ª zona.**

## FIX 1 (P0) — el forward espera RegisterDomain SUCCESSFUL (GATED) + reconcilia a owned
- Entre step 2 y step 3 (o como gate dentro del flujo), pollear `GetOperationDetail` del operationId hasta `SUCCESSFUL`, reusando `reconcileRoute53DomainPurchase` (`domains-purchase.ts:735-815`, hoy solo en resume). Al completar, **reconciliar inventory a `status:"owned"`** (hoy queda `pending` para siempre — bug colateral que esto arregla). Timeout amplio → blocker `domain_registration_failed` (no avanzar a comprar VPS).
- **GUARD obligatorio (no regresar owned/resume):** correr el wait **solo si step 2 devolvió `status:"pending"` con un operationId REAL**. Excluir los sintéticos (`idempotent_already_owned`, `workspace_owned`) y los `route53-reservation-*` (espejar el guard de `domains-purchase.ts:743`). Para dominios ya owned (resume/adopción/idempotente, costUsd 0) el wait **NO debe correr** — ni latencia ni `GetOperationDetail` con ID inválido.
- Esto resuelve P0-A **y** P0-B (la zona se reusa sola).
**DoD:** fresco → no toca DNS/zona hasta `SUCCESSFUL`+`owned`; una sola hosted zone (la delegada), reusada por step 7. Owned/resume → wait salteado, comportamiento idéntico a hoy.

## FIX 2 (P0 — guardas de concurrencia, REQUERIDAS por las esperas largas)
La re-auditoría halló 2 bugs latentes que las esperas largas exponen:
1. **Lease del run-lock < espera → robo de lock.** `smtpRunStateLockLeaseMs` (`orchestrator-smtp.ts:216`) = **15 min**, pero step 3 ya espera 30 min (`:515`) y 2.4 agrega más waits de 30 min. El lock se adquiere 1 vez (`:422`), `lease.json` se escribe 1 vez (`:877-882`) y **nunca se renueva**; la detección de stale usa `mtimeMs` del lockDir (`:905`). → durante un wait >15min, una 2ª invocación del mismo runId ve el lock "expirado", lo borra y entra. **Fix:** subir `smtpRunStateLockLeaseMs` a **≥ 2_400_000 (40 min)** (> el wait más largo + padding), y **mantener `smtpRunStepLeaseMs` (`:217`) > run-lock-lease** para que el step-lease sea la última barrera. (Cierra también el bug pre-existente de step 3.)
2. **Timeout del step no extendido para skill nuevo.** `approvalTimeoutForStep` (`:1867-1873`) extiende el timeout SOLO para `skill === "wait_for_dns_propagation"`. Si el forward registration-wait se implementa como skill nuevo, queda capado al `baseTimeoutMs` (~10 min) y abortará antes de tiempo. **Fix:** implementarlo reusando la rama de `wait_for_dns_propagation`, o agregar su skill name a `approvalTimeoutForStep`.

## FIX 3 (P1) — waits de propagación a 30 min
Subir `maxWaitMs` de steps 8 y 11 a `1_800_000` (`orchestrator-smtp.ts:604, 657`). Son `wait_for_dns_propagation` → ya reciben el timeout extendido. Barato y seguro.

## EXPLÍCITAMENTE FUERA DE SCOPE (la re-auditoría confirmó que meten riesgo/regresión)
- **NO** cablear `UpdateDomainNameservers` como step. Innecesario con FIX 1; `canRollback:false`, muta NS en el registry, mayor blast radius. Queda como skill de repair manual bajo doble aprobación.
- **NO** forzar `reuse-only` en step 7 (`domains-dns.ts:230`). Regresa la adopción de un dominio owned sin zona (rama CREATE legítima) y es más frágil (fail-closed en la ventana donde la zona aún no aparece). `reuse-or-create` es correcto: reusa cuando existe, crea cuando de verdad falta.
- **NO** editar el system-prompt ni hacer push a Hostinger. El código ya fuerza compra-fresca (`requiresExistingDomainForRun`, `orchestrator-smtp.ts:1966-1971`; default omitido = fresh) y el scope-drift atrapa reuso de runId (`:1058-1071`). PTR ya es best-effort y no es gate en ningún step (`webdock-bind-domain.ts:255-277`; controlcorpfiling completó con `set_failed`). Además el OpenClaw que usamos lee el system-context **LOCAL** (`openclaw-bedrock-bridge.ts:196`, gateway local `main.ts:351`); el bridge Hostinger está roto. Si en el futuro se quieren aclaraciones de prompt: editar `.audit/system-context.txt` LOCAL + restart, sin tocar Hostinger.

## Tests (node:test, run real — NO stub del step 2)
- **RegisterDomain IN_PROGRESS→SUCCESSFUL:** adapter mock devuelve `pending` y luego `SUCCESSFUL` tras N polls → el forward ESPERA, reconcilia a owned, recién entonces zona/DNS. Caso falla de registro → blocker `domain_registration_failed`.
- **Owned/resume → wait SALTEADO:** dominio owned (operationId sintético / sin op) → NO se llama `GetOperationDetail`, sin latencia, comportamiento idéntico. Resume de controlcorpfiling v2 intacto (step 2 `done` → skipDoneStep).
- **Zona única:** fresco → UNA sola hosted zone, reusada (reuse-or-create), NS delegados, records resuelven. Regresión: dominio owned sin zona sigue creando vía reuse-or-create (adopción no se rompe).
- **Concurrencia/lock:** 2ª invocación del mismo runId durante un wait de 30 min **NO** roba el lock (run-lock-lease 40min > wait). Step-lease > run-lock-lease.
- **Timeout:** el forward-wait NO aborta a los 10 min (recibe timeout extendido).
- No-regresión: Fase 2.1/2.2/2.3 verdes (PTR best-effort, selector, underscore, resume, write-ahead, scope-drift, budget). Suite completa.

## Deploy
Código → **local** (restart gateway Node 24) **Y** produ + FF. **Hostinger NO se toca** (sin cambio de system-prompt). Reportá SHA + tests (incluido el de RegisterDomain pending→successful y el de lock durante wait largo).

## Hecho cuando
Comprar un dominio FRESCO y correr `configure_complete_smtp` una sola vez completa **1→14 en una pasada**: espera la registración real, usa una zona única bien delegada, propaga, provisiona, y **envía un correo que autentica (SPF/DKIM/DMARC PASS) en Gmail** — sin 2ª invocación de resume, sin 2ª zona, sin robo de lock, y **sin alterar owned/resume/adopción**. Reportá SHA, tests, y (si se corre) el run fresco real.

---
### Pre-checks del operador antes de quemar el dominio
Cap mensual Route53 con headroom (ya cuenta 2 dominios pending del mes); PTR manual en panel Webdock tras crear el VPS (best-effort, mejora reputación, no bloquea); el nombre lo propone `suggest_safe_domain`.
