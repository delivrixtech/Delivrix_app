# Codex — FEATURE (enabler): multi-cuenta de proveedores VPS USABLE (Webdock primero, sin adapter nuevo)

> **Estado:** diseño basado en análisis read-only de 7 subagentes (2026-06-09) — doc `DOCUMENTACION/ANALISIS_MULTI_PROVIDER_CONEXIONES_2026_06_09.md`. Esta es la BASE del multi-provider (milestone 5.12): hace que "agregar una cuenta y de verdad USARLA" sea real, **SIN** agregar un proveedor nuevo todavía (Contabo/RackNerd vienen después como adapters).
> **Backward-compat es CRÍTICO:** con la config ausente / sin `accountId`, el comportamiento de provisión debe ser **BYTE-IDÉNTICO al actual** (single ops account). El flujo SMTP de producción NO se puede romper. **Subagentes OBLIGATORIO** (worker + auditor independiente antes del commit). Stop-and-report si algo no aplica limpio.

## Contexto (verificado por el análisis — confirmá las líneas exactas al implementar)
- La provisión está hardcodeada a Webdock + UNA cuenta. `provider` (param de `configure_complete_smtp`, `skill-schemas.ts`) es **decorativo** (no selecciona adapter/cuenta; solo entra al scope de aprobación + drift).
- `main.ts:~333` construye un único `webdockOpsAdapter` (PRIMARY=read + OPS=write) inyectado al dispatcher (`~749`), onboard (`~766`) y bind (`~1347`). Es el único usado para CREAR.
- `createWebdockAdaptersFromEnv()` (`packages/adapters/src/webdock-real-adapter.ts:~781-828`) enumera slots PRIMARY/OPS/ACCOUNT/SECONDARY/TERTIARY pero arma adapters **read-only** y solo alimenta `/v1/infrastructure/inventory` (`main.ts:~1657`).
- **Modelo correcto a respetar:** los slots actuales son ROLES de UNA cuenta (PRIMARY=read, OPS=write, ACCOUNT=account-level), NO 5 cuentas. Una **cuenta Webdock distinta** necesita SUS PROPIOS 3 keys (read+ops+account). El registry debe modelar `account → {readKey, opsKey, accountKey}`.
- Las capability flags (`isLive/canWrite/canCreate`, `webdock-real-adapter.ts:~258-268`) solo chequean PRESENCIA de key, no validez. NO existe `validateAccount`. `port25UnlockRequired:true` está hardcodeado (`webdock-servers.ts`), nunca se prueba.
- Pasos 9-14 del orquestador (Postfix/DKIM/warmup/envío) ya son **agnósticos** (SSH) — NO tocarlos.

## Alcance de ESTE prompt (enabler, Webdock-only)
A) Registry de cuentas (config + secretos por ref). B) Interfaz `VpsProvider` + adapter Webdock #1 (idéntico). C) Enrutamiento por cuenta. D) `validateAccount` (incl. puerto 25). E) CLI `provider add/list/test/rm`. **NO** agregar Contabo/RackNerd. **NO** tocar pasos 9-14.

### A) Registry de cuentas
- `config/provider-accounts.json` (committable, **METADATA SIN SECRETOS**): `{ version:1, accounts:[{ accountId, provider:"webdock", label, region, defaultPlan, credsRef:{ readKey, opsKey, accountKey }, capabilities, enabled, writeEnabledFlag? }] }`. `credsRef` = **NOMBRES de env vars**, nunca valores.
- `config/provider-accounts.example.json` de ejemplo (committable).
- Loader que resuelve `credsRef`→`process.env[name]` y construye un adapter por cuenta. Reusar el patrón `OpenClawWorkspace.readInventoryJson<T>()`.
- **Backward-compat:** si el archivo NO existe → fallback EXACTO al `webdockOpsAdapter`/`createWebdockAdaptersFromEnv()` actual. Poné todo detrás de un flag `PROVIDER_REGISTRY_ENABLE` (default OFF) para que producción no cambie hasta activarlo explícitamente.

### B) `VpsProvider` interfaz + Webdock adapter #1
- `packages/adapters/src/vps-provider.ts`: interfaz NEUTRAL `createServer/getServer/deleteServer` + opcionales `ensureSshAccess/setMainDomain/setPtr/unlockPort25` + `supports(capability)`. Tipo `ProviderAccount { accountId, provider, label, provider: VpsProvider, defaults:{ regionId, planId, imageId } }`.
- `WebdockVpsProvider` envuelve el `WebdockRealAdapter` existente — **comportamiento byte-idéntico** (mapea `id`↔`slug`, etc.). `supports`: `create/delete/ssh-provision/set-main-domain` = true; `set-ptr-api/unlock-port25-api` = false (manual, como hoy). Reusar el patrón envelope+skip-reason que YA existe en bind (PTR best-effort, `webdock-bind-domain.ts`).

### C) Enrutamiento por cuenta
- `ProviderRegistry { resolve(accountId|provider) → ProviderAccount; list() }` construido en `main.ts` desde la config (o el fallback). Reemplaza la inyección del `webdockOpsAdapter` único por el registry/resolver.
- `skill-dispatcher.ts`: los handlers `webdockCreate/bind/delete` resuelven `registry.resolve(params.accountId ?? params.provider)` en vez del adapter fijo.
- `orchestrator-smtp.ts`: nuevo param OPCIONAL `accountId` (más específico que `provider`); el paso de create usa `region/defaultPlan` de la cuenta resuelta (NO el `"dk"`/`"bit"` hardcodeado). **El SCOPE de plan-approval debe ligar a `accountId`** (no solo `provider`) para que el drift-check sea preciso. Mantener `delete_webdock_server` como alias del rollback.
- **Default (sin accountId/provider, o flag OFF) → resuelve a la cuenta ops actual → IDÉNTICO.**

### D) `validateAccount`
- `validateAccount(account) → { ok, status:"live"|"degraded"|"blocked", reasons[] }`, read-only, NUNCA un create:
  1. probe de creds (Webdock `listServers()` live + auth check de account key vía `GET /account/publicKeys`);
  2. assert `canCreate()`;
  3. **estado puerto 25** por cuenta (`port25Status: "unlocked"|"blocked"|"ticket_pending"|"unknown"`, Webdock arranca `ticket_pending`) → si ≠ unlocked → `blocked: port25_not_unlocked` (NO arrancar build contra esa cuenta);
  4. sanity región/plan contra el catálogo del proveedor.
  Emitir el veredicto a audit + Canvas (mismo patrón `oc.action.now`). Gate: el orquestador corre `validateAccount` sobre la cuenta elegida ANTES de firmar/arrancar (empezá por el gate de creds+puerto25).

### E) CLI
- `scripts/providers/cli.ts` + npm script `"provider": "node scripts/providers/cli.ts"` (Node ≥24 corre .ts directo, como `db:migrate`).
- `provider add --provider webdock --label "Acct2"`: **prompt OCULTO** de los 3 keys (read/ops/account; nunca por flag/argv), deriva `accountId` + nombres `credsRef`, **append a `.env.local` (chmod 600)** + upsert en `config/provider-accounts.json`. Asserta que `.env.local` está gitignored (rechazar si está trackeado).
- `provider list`: tabla `accountId/provider/label/cred(present)/health`; secretos enmascarados (`****last4`).
- `provider test <id>` (o `--all`): corre `validateAccount` → live/auth-failed/blocked-port25 + latencia. Exit ≠0 en fallo.
- `provider rm <id>`: quita del registry, **comenta** (no borra) la línea en `.env.local` con marca de fecha.
- Standalone (no toca el gateway corriendo); imprimir que el pickup es **al reiniciar el gateway** (`scripts/gateway-restart.sh`). `test` no necesita restart (arma su propio adapter efímero).

## PROHIBIDO
- Romper el flujo Webdock actual: sin config/accountId (o flag OFF), comportamiento **byte-idéntico** (mismo adapter ops, misma región/plan). 
- Secretos en el registry JSON o en git: el JSON solo lleva NOMBRES de env (`credsRef`). Secretos SOLO en `.env.local` (gitignored, chmod 600).
- NO imprimir valores de secretos (CLI enmascara; prompts ocultos; nada de `set -x`).
- NO tocar pasos 9-14, `emitStep`/`emitRunAction`, el normalizer, `evictLiveState`, ni agregar Contabo/RackNerd/SMTPVPS.
- NO meter el secreto por ningún flujo del agente/OpenClaw (eso es fase futura: solo metadata + ref).

## DoD (Codex)
1. Implementar A–E con subagentes (worker + auditor independiente).
2. **Backward-compat PROBADO:** con `provider-accounts.json` ausente (o flag OFF) y sin `accountId`, el create es idéntico (mismo adapter ops, misma región/plan) — test que lo asegure + la suite actual verde (`npm test` ~909, panel `check`, `orchestrator-smtp.test.ts`; nota: `approval-token.test.ts` `/private/tmp` EACCES = artefacto sandbox, no regresión).
3. Tests nuevos: loader del registry (resuelve credsRef, fallback sin archivo), resolución por accountId/provider/default, `validateAccount` (creds ok/fail, port25 blocked), CLI add/list/test/rm (NO filtra secretos).
4. **Smoke seguro:** un `provider test` (validate, sin provisionar) muestra live/blocked correctamente. NO disparar un `configure_complete_smtp` real en CI.
5. Commit atómico + deploy (gateway restart + push `origin produ`; Hostinger si aplica). 
6. NO secretos en logs/commits; `.env.local` y cualquier registry-con-secreto fuera del commit.

## Reportá
SHA + EXIT de tests (suite actual + nuevos) + confirmación de backward-compat (flujo actual byte-idéntico, flag default-off) + que ningún secreto se imprime/commitea + que NO agregaste proveedores nuevos ni tocaste lo prohibido. Dejá marcado **pendiente QA de Juanes**: agregar una 2ª cuenta Webdock real con el CLI + correr un build contra ella (con `validateAccount` confirmando puerto 25).
