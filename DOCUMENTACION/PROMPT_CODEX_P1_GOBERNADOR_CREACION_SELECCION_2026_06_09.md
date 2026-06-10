# Codex — P1: gobernador de creación (≤N/día por cuenta) + selección como PRE-STEP byte-idéntico

> **Estado:** diseño verificado read-only (subagentes 2026-06-09) contra HEAD/produ. Es el "cerebro" que hace SEGURO crear SMTPs y, más adelante, tener más cuentas. **NO conecta cuentas nuevas** (eso es el enabler = P2) y **NO refactoriza el routing de provisión** (los 5 puntos de riesgo del enabler quedan intactos).
> **Backward-compat:** con UNA sola cuenta (hoy) el selector resuelve **al mismo `webdockOpsAdapter` de siempre** → ruta de creación **byte-idéntica**. El gobernador es un **pre-flight read-only** que solo BLOQUEA si se excede el cap (en operación normal de 1-2 builds/día es no-op). **Subagentes OBLIGATORIO** (worker + auditor). Stop-and-report si algo no aplica limpio.

## Por qué (lo que falta hoy, verificado)
- **NO existe gobernador de creación.** El único gate previo a crear es de **dólares**: `ensureBudgetForStep` (`apps/gateway-api/src/routes/orchestrator-smtp.ts:2708-2749`, USD vs USD). El límite real de reputación/anti-baneo **~4 SMTP/día por cuenta Webdock** (cada build ~20 min) **no está enforced** → crear agresivo arriesga baneo de Webdock + reputación. (El warm-up de ENVÍO — steps 12-14, día1-3 <20 correos/día… — es OTRO concern; NO tocar.)
- **No hay selección de cuenta para crear:** se usa el único `webdockOpsAdapter` hardcoded (`apps/gateway-api/src/main.ts:333`, inyectado 749/766/1322/1347/1367). Conectar más cuentas SIN un selector daría elección arbitraria. (`selectSenderNode` en `packages/domain/src/sender-node-registry.ts:138` es selección de **ENVÍO**, NO de creación — no tocar/confundir.)

## Contexto verificado (confirmá líneas al implementar)
1. Step de creación (step 4): `orchestrator-smtp.ts:585-609` (`skill:"create_webdock_server"`, params `profile/locationId/hostname/imageSlug`). El gate de budget se aplica vía `ensureBudgetForStep` dentro de `runMutatingStepWithState`. **El pre-flight del gobernador va ANTES de disparar el step 4.**
2. Patrón de gate a imitar: `ensureBudgetForStep` (`:2708-2749`) — lanza `OrchestratorFailure("failed", step, skill, "<motivo>")` cuando se excede; loggea `openclaw.orchestrator.budget_exceeded`. El gobernador hace lo mismo con `creation_rate_exceeded`.
3. **Fuente real de "creados":** la API de Webdock devuelve `creationDate` por servidor (`packages/adapters/src/webdock-real-adapter.ts:47` campo, `:872` mapeo `stringField(obj,"creationDate")`; también en `WebdockInventoryServer.creationDate`, `packages/domain/src/webdock-inventory.ts:31`). El read adapter que alimenta el inventario (`createWebdockAdaptersFromEnv` → ruta inventory `main.ts:~1657`) ya lista servers. → **Contar servers con `creationDate` dentro de la ventana** = fuente de verdad (refleja Webdock, no estado local que puede driftear).
4. Adapter ops actual = `main.ts:333` (PRIMARY=read + OPS=write). El selector, con una cuenta habilitada, **devuelve esta misma**.

## Alcance de ESTE prompt (P1, single-account-safe)
**A) Gobernador de creación (pre-flight read-only ANTES del step 4).**
- Nueva función `ensureCreationBudgetForAccount({ readAdapter, accountId?, now })` (módulo nuevo, p.ej. `packages/domain/src/creation-rate-governor.ts` + wiring en el orquestador): lista los servers de la cuenta (read adapter), cuenta los que tienen `creationDate` dentro de una **ventana móvil de 24h** (default; configurable a día-calendario TZ America/Bogota), y si `count >= CAP` lanza `OrchestratorFailure("failed", 4, "create_webdock_server", "creation_rate_exceeded: created_24h=<n> cap=<m> account=<id|ops>")` + audit `oc.orchestrator.creation_rate_exceeded` (NO silencioso; visible en Canvas).
- Config: flag `CREATION_RATE_GOVERNOR_ENABLE` (default **ON** — es la salvaguarda que el CTO pide) + `CREATION_MAX_PER_DAY` (default **4**) + `CREATION_RATE_WINDOW` (default `rolling_24h`). Override explícito: solo con aprobación humana (audit `oc.orchestrator.creation_rate_override`), nunca automático.
- **Fail mode ante error de lectura del inventario:** **fail-open con warning audit ruidoso** por default (no romper un build legítimo por un hipo transitorio del API; un build extra no causa baneo), configurable a fail-closed. Documentar la decisión.
- Opcional (config, default off): spacing mínimo entre creaciones (`CREATION_MIN_GAP_MIN`) usando el `creationDate` más reciente.
- Pura y testeable: la lógica de conteo/decisión recibe la lista de servers + now, sin I/O.

**B) Selector de cuenta como PRE-STEP (sin refactor de routing).**
- `selectAccountForCreation({ accounts, governorState }) → accountId` (módulo nuevo). Política mínima determinista: filtrar cuentas con budget disponible (gobernador) y healthy; tie-break estable. **Con UNA cuenta habilitada → devuelve la cuenta ops actual** (resuelve al `webdockOpsAdapter` de hoy) → **byte-idéntico**.
- El selector corre ANTES del step 4 y su salida alimenta la MISMA resolución de adapter que existe hoy (no cambia el dispatcher ni las inyecciones `main.ts:749/766/1322/1347/1347`). Es el **seam** donde P2 (enabler) enchufará más cuentas — pero P1 NO agrega cuentas ni toca esos puntos de inyección.
- Si todas las cuentas elegibles están sin budget → falla limpio `creation_rate_exceeded_all_accounts` (con 1 cuenta = el caso single).

## PROHIBIDO
- Tocar el routing/inyección de adapters (`main.ts:333/749/766/1322/1347/1367`), el dispatcher, idempotencia de create, rollback, o `createWebdockAdaptersFromEnv`. **El flujo de provisión single-account debe quedar byte-idéntico** cuando el cap no se excede.
- Agregar cuentas nuevas / registry / CLI (eso es **P2 enabler**, prompt aparte).
- Confundir con `selectSenderNode` (envío) ni tocar el warm-up de envío (steps 12-14).
- Hacer el gobernador silencioso: un bloqueo debe emitir audit + Canvas claros, nunca un skip mudo.
- Romper un build legítimo: con <CAP creados, el build procede idéntico; ante error de lectura, fail-open con warning (default).

## DoD (Codex)
1. Subagentes (worker + auditor).
2. **Tests** (lógica pura + wiring): conteo desde `creationDate` (dentro/fuera de ventana; rolling-24h); bloqueo en `>=CAP` con `OrchestratorFailure` correcto; **no-op cuando <CAP** (build idéntico); flag OFF → gobernador desactivado (byte-idéntico); fail-open ante error de lectura (+ variante fail-closed); selector con 1 cuenta → ops adapter; selector con N (mock) → respeta budget/tie-break; override humano permite exceder con audit.
3. **Suite verde:** `npm test`, `npm --workspace @delivrix/admin-panel run check`, `orchestrator-smtp.test.ts`. `tsc` 0. (`approval-token.test.ts` `/private/tmp` EACCES = artefacto sandbox.)
4. **Backward-compat PROBADO:** con flag default y <CAP creados hoy, un build crea el server exactamente como hoy (mismo adapter ops, mismos params). Test que lo asegure.
5. Commit atómico: "Add VPS creation-rate governor (≤N/day per account) + account pre-selector (single-account byte-identical)". Deploy: gateway restart + push `origin produ` (+ Hostinger).

## Reportá
SHA + EXIT tests + `tsc` + confirmación de: (a) ruta de creación byte-idéntica con <CAP y/o flag off; (b) NO tocaste routing/inyección/dispatcher/idempotencia/rollback; (c) la fuente de conteo es `creationDate` del API (no estado local); (d) el bloqueo es visible (audit+Canvas), no silencioso; (e) fail-mode elegido ante error de lectura. Pendiente **QA-Juanes**: forzar 4 creaciones simuladas y ver el bloqueo + el override humano; confirmar que un build normal (<4) no cambia.
