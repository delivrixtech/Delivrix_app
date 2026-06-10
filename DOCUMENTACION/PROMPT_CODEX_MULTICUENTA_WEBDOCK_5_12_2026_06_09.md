# Codex - Cableado multi-cuenta Webdock en el write-path (5.12) SIN romper produccion

> **Autor del diseno:** Claude (auditoria con 2 subagentes + verificacion directa, 2026-06-09, commit base `7568c2b`/`e9869dd`).
> **Rol:** vos (Codex) implementas backend. Esto es el spec con invariantes. **Stop-and-report** si algo no calza con el codigo real (los file:linea son del 2026-06-09, verificalos antes de editar).
> **Regla dura:** cero emojis en codigo/output/docs (ASCII puro). No commitear `.env.local`.

## Objetivo
Hoy la CREACION de VPS (step 4 del orquestador SMTP) es single-account, fija a la cuenta `ops`. Queremos que un selector elija entre N cuentas Webdock (cadena de proveedores) para repartir carga y no interrumpir produccion si una cuenta se agota o cae. El selector y el governor PUROS **ya existen y estan testeados** (`packages/domain/src/creation-rate-governor.ts`); el trabajo es alimentarlos con el estado real de N cuentas y enrutar el create al adapter de la cuenta ganadora. **NO es un rediseno del orquestador**: el acoplamiento a `ops` esta concentrado en `main.ts` + dos lineas de `orchestrator-smtp.ts`.

## Invariante global (la mas importante): single-account byte-identical
Mientras solo este configurada la cuenta `ops` (estado de HOY), el comportamiento debe ser **byte-identico**: mismos audit events, mismo `accountId="ops"` en governor/audit/inventoryHash, mismo `hashInput(params)` del step 4, mismo adapter, mismos rollback/delete. Si un test de regresion de un run single-account cambia UN solo hash o evento, el cambio esta mal. Esta invariante se testea explicitamente (ver DoD).

## Estado actual verificado (anclas file:linea, confirmar antes de tocar)
- Call site governor: `orchestrator-smtp.ts:626-632` con `accountId: "ops"` **literal**.
- Call site create: `orchestrator-smtp.ts:634-653`, `params` SIN accountId. El `hashInput(params)` (idempotencia/resume) NO incluye accountId hoy.
- Selector self-check tautologico: `orchestrator-smtp.ts:2886-2896` llama `selectAccountForCreation` con array de **1** elemento y lanza `creation_account_selection_mismatch` si el ganador != cuenta pedida.
- Dispatcher: `skill-dispatcher.ts:112` (`webdockAdapter` escalar), `:369-385` (`webdockCreate` -> `handleWebdockServerCreateHttp({adapter: deps.webdockAdapter})`), `:578-579` (skill->handler).
- Wiring: `main.ts:333-339` (`webdockOpsAdapter`, unico con writeApiKey), `:340` (`webdockAccountAdapters` read-only, solo usado en `:1670` inventario), `:431-443` (`listWebdockCreationServers` con `if (accountId!=="ops") throw` en `:432`), `:762/:1335/:1360/:1380` (create/bind/delete -> webdockOpsAdapter).
- Adapter cuenta-agnostico: `webdock-real-adapter.ts` createServer `:340-350`, `canCreate()` `:273-275`, constructor `:241-263`.
- `SmtpRunState` (`orchestrator-smtp.ts:336-370`): tiene `serverSlug`/`serverIpv4`, **NO** tiene accountId.

## FASE 0 (BLOQUEANTE - bug latente, arreglar ANTES de cablear)
**Verificado:** `buildAccountAdapterEntry` (`webdock-real-adapter.ts:976-995`) NO inyecta `writeApiKey` y pasa `accountApiKey: env.WEBDOCK_API_KEY_ACCOUNT` (singleton). El constructor (`:249-254`) entonces cae a `env.WEBDOCK_API_KEY_OPS`/`_ACCOUNT` (tokens de la cuenta-1). Resultado: los adapters `secondary`/`tertiary` reportan `canCreate()===true` PERO **escribirian en la cuenta-1, no en la suya**. Es una trampa: cablear el selector encima de esto crearia VPS en la cuenta equivocada.

Fix Fase 0:
1. Modelar cuentas reales, no roles. `primary`/`ops`/`account` son 3 ROLES de la MISMA cuenta (cuenta-1); `secondary`/`tertiary` son cuentas distintas. Introducir un concepto explicito de "cuenta" con sus 3 keys: por cada cuenta real, `read` + `write` + `account` keys. Propuesta de env (retro-compatible):
   - Cuenta-1 (la de hoy, NO cambiar nombres): `WEBDOCK_API_KEY_PRIMARY` (read), `WEBDOCK_API_KEY_OPS` (write), `WEBDOCK_API_KEY_ACCOUNT` (account).
   - Cuenta-2: `WEBDOCK_API_KEY_SECONDARY` (read), `WEBDOCK_API_KEY_SECONDARY_WRITE`, `WEBDOCK_API_KEY_SECONDARY_ACCOUNT`.
   - Cuenta-3: `WEBDOCK_API_KEY_TERTIARY` (read), `WEBDOCK_API_KEY_TERTIARY_WRITE`, `WEBDOCK_API_KEY_TERTIARY_ACCOUNT`.
   - Para una 4a/5a cuenta: extender el patron (`QUATERNARY`, `QUINARY`) en el MISMO loop, no hardcodear.
2. `buildAccountAdapterEntry` debe inyectar EXPLICITAMENTE `writeApiKey` y `accountApiKey` per-account (romper el fallback a singletons). Una cuenta sin write/account key propia => adapter read-only => `canCreate()===false` real (no enganoso).
3. De-duplicar roles->cuenta: el inventario/governor multi-cuenta NUNCA debe contar `primary`+`ops`+`account` como 3 cuentas (inflaria el conteo x3 y romperia el budget). Iterar sobre CUENTAS reales, no sobre los 5 specs actuales.

## FASE 1 - registry id->adapter accesible para crear
Hoy el dispatcher recibe UN adapter escalar (`main.ts:762`). Construir un registry `Map<accountId, WebdockServerCreateAdapter>` con los adapters write-capable per-account, accesible desde el orquestador/dispatcher. Resolver del dispatcher: `accountId -> adapter`; **sin accountId o "ops" => exactamente el `webdockOpsAdapter` de hoy** (mismo objeto/keys).

## FASE 2 - seleccion real en el orquestador
Reemplazar el `accountId:"ops"` literal (`orchestrator-smtp.ts:626-632`) por seleccion real, con este shape (ya validado contra el selector puro):
```
// 1 iteracion por CUENTA real write-capable:
const inv = await listWebdockCreationServers({ accountId });      // {sourceKind, responseOk, accountId, servers[]}
const live = inv.sourceKind === "live" && inv.responseOk === true;
const budget = live ? evaluateCreationBudget({servers: inv.servers, now, cap, accountId, window, enabled}) : null;
accounts.push({ accountId, healthy: live, enabled: adapter.canCreate() });   // canCreate() REAL (post Fase 0)
if (live) governorState.push({ accountId, allowed: budget.allowed, createdInWindow: budget.createdInWindow, cap: budget.cap });
// tras el bucle:
const decision = evaluateAccountSelection({ accounts, governorState });   // usar la version NO-throw
```
Reglas de correctitud (de la auditoria):
- Cuentas no-live entran a `accounts` con `healthy:false` (se excluyen sin matar el run) y se OMITEN de `governorState` (no afirmar budget falso).
- `enabled: adapter.canCreate()` es la salvaguarda: el selector NUNCA elige una cuenta que no puede escribir de verdad (depende de Fase 0).
- Usar `evaluateAccountSelection` (no-throw) para distinguir en audit `creation_rate_exceeded_all_accounts` vs `no_eligible_accounts`.
- Preservar el camino `handleCreationRateReadError` (fail-open/closed por env) para cuando TODAS las cuentas fallan la lectura - no convertirlo en `no_eligible_accounts` silencioso.
- Revisar `creation_account_selection_mismatch` (`:2886-2896`): con seleccion real el ganador puede diferir legitimamente; esa verificacion debe cambiar de semantica (ya no es "==cuenta pedida"), NO abortar runs validos.

## FASE 3 - propagar accountId a estado, create, rollback, delete (sin romper hash)
1. **CRITICO - hash:** el `accountId` ganador NO debe entrar dentro del objeto que va a `hashInput(params)` del step 4 (`:1663` aprox). Pasarlo por un canal paralelo (campo fuera del params hasheado, o arg separado del runner). Con 1 cuenta el `inputHash` del step 4 debe quedar identico al de hoy. Test obligatorio.
2. `SmtpRunState`: agregar `serverAccountId?: string` (OPCIONAL, backward-compat: runStates viejos sin el campo defaultean a "ops"). Persistir junto a serverSlug/serverIpv4 (`:656-658`).
3. Rollback (`:884-901`) y delete (`main.ts:1380`): leer `runState.serverAccountId ?? "ops"` y enrutar el delete al adapter de ESA cuenta. Sin esto = server huerfano (delete va a cuenta equivocada). Bind-main-domain (`:1360`) idem: misma cuenta del server creado.

## PROHIBIDO
- Tocar el selector/governor puros (`creation-rate-governor.ts`) - ya estan completos y testeados. Solo dejar de llamarlos en modo 1-elemento.
- Cambiar nombres de env de la cuenta-1 (`WEBDOCK_API_KEY_PRIMARY/OPS/ACCOUNT`).
- Meter accountId dentro del `hashInput` del step 4.
- Cablear Fase 1/2 sin Fase 0 (crearia en cuenta equivocada).
- Tocar idempotencia/rollback de forma que cambie el comportamiento single-account.

## DoD (tests)
1. **Regresion single-account (la mas importante):** un run completo con SOLO la cuenta ops configurada produce EXACTAMENTE los mismos audit events, `accountId="ops"`, `inputHash` del step 4, y rollback/delete que antes del cambio. Si hay golden/snapshot del run, debe quedar intacto.
2. Multi-cuenta selecciona: con 2 cuentas write-capable, una en cap y otra con budget, el selector elige la de budget; el create va al adapter correcto (mock por cuenta verifica que el POST fue a la cuenta ganadora).
3. Fase 0: adapter `secondary` SIN `_WRITE`/`_ACCOUNT` propias => `canCreate()===false` (no cae a singletons). Con sus keys propias => `canCreate()===true` y el create escribe contra SU token.
4. De-dup: con las 3 keys de cuenta-1, el governor cuenta la cuenta UNA vez (no 3).
5. runState backward-compat: un runState viejo sin `serverAccountId` hace rollback/delete contra ops sin error.
6. Todas las cuentas no-live => preserva fail-open/closed actual (no `no_eligible_accounts`).
7. Suite verde: `npm test`, panel `check`, `node --test` focal governor/orchestrator/adapter, gateway build. (tsc global rojo por deuda previa = no bloqueante.)

## Reporta
SHA + EXIT de tests. Confirma explicitamente: (a) run single-account byte-identico (que hash/eventos verificaste); (b) Fase 0 aplicada (secondary sin keys propias = canCreate false); (c) accountId NO entra al hashInput; (d) rollback/delete usan serverAccountId; (e) que NO tocaste el modulo puro. Pendiente QA-Juanes: conectar cuenta-2 real (token 4-scopes-R/W incl Billing, ver [[feedback-webdock-token-necesita-billing]]) + su SSH key registrada en esa cuenta, y forzar un build que seleccione la cuenta-2.

> Relacionado: governor P1 `7568c2b`, fix resume `PROMPT_CODEX_P1_1_GOVERNOR_SKIP_ON_RESUME_2026_06_09.md` (hacelo ANTES o junto, comparten el call site :626). Analisis multi-provider previo: `DOCUMENTACION/ANALISIS_MULTI_PROVIDER_CONEXIONES_2026_06_09.md`.
