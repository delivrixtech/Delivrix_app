# PROMPT CODEX — Anexar Contabo como 2do VPS provider (sin romper Webdock)

Fecha: 2026-06-11. Autor del brief: Claude (audit read-only con 2 subagentes). Estado: DISENO AUDITADO, sin implementar. Base: produ (main). Roles: Codex = backend/infra; Claude = QA visual/PM.

> Regla dura del repo: ASCII puro, sin emojis, en codigo/scripts/docs/outputs. Repo compartido con otro agente: trabajar en worktree aislado, NUNCA `git checkout <ref> -- .` sobre el working tree comun.

---

## 0. OBJETIVO E INVARIANTE

Agregar **Contabo** como segundo proveedor de VPS al flujo `configure_complete_smtp`, en paralelo a Webdock, para diversificar ASN tras el ban de 3 cuentas Webdock. Las credenciales Contabo YA estan en env y verificadas LIVE (token HTTP 200): `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_API_USER`, `CONTABO_API_PASSWORD` en `config/gateway.env` y `.env.local`.

**INVARIANTE DE NO-REGRESION (lo que NO se puede romper):** con `providerId` ausente o `"webdock"`, el camino de creacion Webdock debe quedar **byte-identico**: mismo `inputHash` del step 4, misma validacion de plan-signature, mismo resume/idempotencia, mismo comportamiento single-account. Cualquier cambio que altere el dict de `params` del step 4 para el caso Webdock rompe el `inputHash` y por ende firmas y resume.

**Principio de diseno:** Contabo viaja por un **canal paralelo `providerId`** (hermano de `serverAccountId`), NUNCA dentro de `params`. Se reusa el patron exacto del multicuenta Webdock 5.12.

---

## 1. ESTADO ACTUAL DEL SEAM (anclas verificadas contra codigo)

Tamanos: `orchestrator-smtp.ts`=3499, `webdock-real-adapter.ts`=1437, `skill-dispatcher.ts`=668, `creation-rate-governor.ts`=484, `webdock-servers.ts`=1187.

- **No existe abstraccion `VpsProvider` hoy.** El create esta hardcodeado a Webdock end-to-end. El seam es greenfield.
- **El param `provider` de `configure_complete_smtp` es el DNS/registrar (siempre `"route53"`), NO el VPS.** Declarado `skill-schemas.ts:147,162`, parseado `:396` (`providerId()` regex). Usado SOLO en validacion de plan-scope (`orchestrator-smtp.ts:2593-2597`, `:1343`) y dominio (`:2533`). **NO overloadear este campo para el VPS** (comparado en plan-scope `:2597` -> tiraria `plan_scope_mismatch: provider`).
- **Step 4 = unica creacion.** Call mutante en `orchestrator-smtp.ts:711-733`, dentro de un loop de payment-failover `:689-755`. `params` (lineas 724-730) es vocabulario Webdock: `{ runId, profile:"bit", locationId:"dk", hostname, imageSlug:"ubuntu-2404" }`. `serverAccountId` va aparte (`:731`), NO en params.
- **Adapter invocado:** `adapter.createServer(WebdockCreateServerInput) -> WebdockCreateServerResult` (`webdock-real-adapter.ts:87-104`): in `{profile,locationId,hostname,imageSlug,publicKey,sshUsername?,callbackUrl?}`, out `{serverSlug,eventId,ipv4:string|null,status,publicKeyId?,source}`.
- **Resultado -> runState** `:760-764`: `serverSlug = stringFromOutcome(vps.outcome,["slug","serverSlug"])`, `serverIpv4 = stringFromOutcome(vps.outcome,["ipv4","serverIp"])`. (Lectura por key-list, ya tolerante a nombres variados.)
- **Registry/env:** `createWebdockAdaptersFromEnv()` (`:927-974`) -> `WebdockAccountAdapterEntry[]`; `buildWebdockCreateRegistry()` (`:990-1001`) -> `Map<string, WebdockRealAdapter>` por accountId; `buildDistinctAccountSpec(id,role,label,env)` (`:1024-1038`) lee triplete `WEBDOCK_API_KEY_${role}` / `_WRITE` / `_ACCOUNT` + `isolated:true` (`:1045-1059`). Cableado en `main.ts:341-361`.
- **Dispatch:** `resolveWebdockCreateAdapter(deps, accountId)` (`skill-dispatcher.ts:631-640`): si `accountId` vacio/`"ops"` o sin registry -> `deps.webdockAdapter` (cuenta-1, byte-identico); si no, `registry.get(accountId) ?? webdockAdapter`. `accountId` es campo top-level de `DispatchSkillHandlerInput` (`:149`), NO en params.
- **Canal paralelo `serverAccountId`:** campo hermano de `params` en `ApprovalStepInput` (`:86`), `PlanApprovedStepInput` (`:179`), `RollbackProposalInput` (`:246`), runState (`:407`). Se esparce condicional y SEPARADO de params en `runGatedStep` (`:1964-1965`) y `runPlanApprovedStep` (`:2174-2175`). `hashInput` se computa SOLO de `input.params` (`:1926,:2138,:1701,:1871`; def `:3455`) -> el canal es inaccesible al hash. Persistido ANTES del create (`:708-709`). Forward a dispatcher como `accountId` fuera de params en `main.ts:670-672`.
- **Guard del gated-path:** el camino humano-gated RECHAZA cuenta != ops (`gated_multiaccount_unsupported`, `:2107-2114`). Decidir lo analogo para providers != webdock bajo gated.
- **Governor** (`creation-rate-governor.ts`): matematica provider-agnostica pero con constantes Webdock (`CREATION_RATE_SKILL="create_webdock_server"` `:4`, `STEP=4` `:3`, `DEFAULT_CREATION_ACCOUNT_ID="ops"` `:5`). Cuenta por `creationDate` (`countCreatedInRolling24h:147`). **Decision: tratar cada proyecto Contabo como otra "account" en la seleccion existente -> el governor NO cambia en el primer corte.**
- **Rollback/delete:** orquestador pide rollback solo si `serverSlug && failure.step>=6 && deps.submitRollbackProposal` (`:1033-1052`), con `skill:"delete_webdock_server"` + `serverAccountId`. `submitRollbackProposal` (`main.ts:735-761`) hoy SOLO audita (no borra directo). Delete real: `handleWebdockServerDeleteHttp` (`webdock-servers.ts:565-730`) -> `adapter.deleteServer(slug)`; routing por `resolveWebdockDeleteAdapter` (`:754-762`).

---

## 2. CLASIFICACION DE LOS 14 STEPS (que tocar)

Tabla step->skill en `orchestrator-smtp.ts:341-356`. **Solo steps 4 y 8 son Webdock-API-specific.** Steps 5 y 13 son no-ops (`main.ts:442-449`). El resto (2,3,6,7,9,10,11,12,14) ya corre sobre `serverSlug`/`serverIpv4` por Route53 o SSH y sirve IGUAL para Contabo, siempre que el step 4 entregue `serverSlug` (= `instanceId` Contabo como string) + `serverIpv4` real + acceso SSH cableado.

- **Step 4 `create_webdock_server`** (handler `webdock-servers.ts:158-563`): hace (a) registrar SSH pubkey en la cuenta, (b) POST server, (c) **poll `GET /servers/{slug}` hasta `running`+IPv4** (el POST devuelve `ipv4:null`), (d) crear shell user. El adapter Contabo debe reimplementar TODO esto contra endpoints Contabo. Tambien respeta `resolveExistingServerForCreate` (idempotencia por hostname, `:857-889`) y `port25UnlockRequired:true`.
- **Step 8 `bind_webdock_main_domain`** (handler `webdock-bind-domain.ts:179-439`): setea Server Identity via Webdock (`setServerIdentity` PATCH `/servers/{slug}/identity`) y verifica FCrDNS con retry 15min (`:300-365`). El PTR NO se setea por API (`setServerPtr` -> `supported:false`); Webdock auto-PTR + solo verifica. **Para Contabo: reemplazar** -> setear hostname por SSH (Webdock ya tiene fallback `setServerHostnameViaSsh` `webdock-real-adapter.ts:541-627` como referencia) + **PTR manual en el panel Contabo** (no hay API) + MANTENER el loop de verificacion FCrDNS tal cual.

---

## 3. DISENO (lo que Codex implementa)

### 3.1 Interface `VpsProvider` (nueva, estructural)
Crear una interface que el `WebdockRealAdapter` ya satisface (cero cambios a la clase Webdock):
```ts
interface VpsProvider {
  createServer(input): Promise<{ serverSlug: string; eventId?: string; ipv4: string|null; status: string; publicKeyId?: string; source?: string }>;
  getServer(id: string): Promise<{ status: string; ipv4: string|null; ... }>;
  deleteServer(id: string): Promise<{ serverSlug: string; eventId?: string; status: string }>;
  isLive(): boolean; canCreate?(): boolean; canWrite?(): boolean;
  listServers?(): Promise<...>;               // idempotencia resolveExistingServerForCreate
  ensureServerSshAccess?(opts): Promise<...>; // Contabo: cloud-init en vez de shellUsers
}
```
Es byte-compatible con `WebdockServerCreateAdapter`/`WebdockServerDeleteAdapter` (`webdock-servers.ts:37-61`).

### 3.2 Canal `providerId` (espejo de `serverAccountId`)
- Agregar `providerId?: string` a los 4 input types + runState, en los MISMOS sitios que `serverAccountId` (`:86,:179,:246,:407`).
- Persistir junto a `serverAccountId` ANTES del create (`:708-709`).
- Esparcir condicional en `runGatedStep` (`:1964`) y `runPlanApprovedStep` (`:2174`) — hermano de params.
- Forward a dispatcher en `main.ts:672` (junto al `accountId`).
- **NUNCA** meter `providerId` en el dict de params (`:724-730`). Si entra a params -> cambia `hashInput` -> `resume_scope_drift` (`:1708-1709`) y mismatch de plan-scope (`:2622`).

### 3.3 Dispatch
Extender `resolveWebdockCreateAdapter` (renombrar conceptualmente a `resolveCreateAdapter`, manteniendo back-compat) en `skill-dispatcher.ts:631`:
```ts
function resolveCreateAdapter(deps, providerId, accountId) {
  if (providerId && providerId !== "webdock" && deps.vpsProviderAdapters?.has(providerId)) {
    return deps.vpsProviderAdapters.get(providerId)!;   // Contabo
  }
  // ...logica accountId existente, lineas 635-639 SIN TOCAR (Webdock byte-identico)...
}
```
Misma extension de una linea en `resolveWebdockDeleteAdapter` (`webdock-servers.ts:754`) para rollback. El handler de create (`skill-dispatcher.ts:387-403`) pasa `providerId` al resolver.

### 3.4 Params del step 4 para Contabo
Preferido (mantiene `inputHash` Webdock estable): **el adapter Contabo traduce** el vocabulario. El orquestador sigue mandando params Webdock-shaped o un params-builder condicional por providerId que para Webdock produce EXACTAMENTE el dict actual (`:724-730`). Si se elige builder condicional, testear que el branch Webdock es byte-identico (snapshot del `inputHash`).

### 3.5 Env reader Contabo
`createContaboAdaptersFromEnv()` espejando `createWebdockAdaptersFromEnv`/`buildDistinctAccountSpec`: leer `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_API_USER`, `CONTABO_API_PASSWORD` (+ slots `_2`,`_3`... por proyecto si se agregan), con `normalizeEnvValue` y aislamiento estilo `isolated` para no leer keys Webdock. Construir `vpsProviderAdapters: Map<string, VpsProvider>` en `main.ts` justo despues de `:353`.

---

## 4. ADAPTER CONTABO — spec de API (fuentes oficiales)

Base `https://api.contabo.com`. Auth JWT Bearer.

- **Token:** `POST https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token`, grant `password`, body form-urlencoded `client_id,client_secret,username,password,grant_type=password`. Devuelve `access_token`+`refresh_token`+`expires_in`. **TTL corto (~5min Keycloak) -> re-pedir token o `refresh_token` antes de cada fase larga** (el poll de provisioning dura minutos). Verificar `expires_in` real contra la cuenta.
- **Headers (toda call compute):** `Authorization: Bearer <tok>`, `x-request-id: <uuid4>` (REQUERIDO), `Content-Type: application/json`, `Accept: application/json`.
- **Crear:** `POST /v1/compute/instances`, body `CreateInstanceRequest`: `imageId`(UUID), `productId`(str), `region`(str), `sshKeys`(int[] de secretId), `rootPassword`(secretId opt), `userData`(cloud-init opt), `period`(REQUERIDO int meses 1/3/6/12), `displayName`, `defaultUser`(admin/root). Responde **201** con `instanceId` y SIN ipConfig -> hay que pollear.
- **Productos:** `GET /v1/compute/products` para `productId` + specs reales (vCPU/RAM NO estan en la tabla de docs; NO hardcodear). Para ~4 vCPU/8GB apuntar a tier VPS 1/VPS 2 SSD (`V45`/`V48`) y confirmar specs en runtime.
- **Imagenes:** `GET /v1/compute/images?standardImage=true&name=Ubuntu` -> `imageId` UUID de Ubuntu 22.04. **Hacer lookup, NO hardcodear** (el `afecbb85-...` del SDK puede rotar).
- **Regiones confirmadas:** `EU`, `US-central`, `US-east`, `US-west`, `SIN`. Para IP US usar `US-east`/`US-central`/`US-west`. Resolver otras desde products.
- **SSH keys:** `POST /v1/secrets` `{name,type:"ssh",value:"<openssh pubkey>"}` -> `secretId`. Referenciar por `sshKeys:[secretId]` (NO se puede pasar pubkey inline). Dedupe: `GET /v1/secrets?type=ssh&name=<label>`.
- **Status poll:** `GET /v1/compute/instances/{instanceId}` -> `status` enum (`provisioning|installing|running|stopped|error|...`); esperar `running`. IPv4 en `ipConfig.v4.ip`.
- **rDNS/PTR:** **panel-only, NO API** (terraform issue #41). PTR manual a `smtp.<dominio>` en el panel; el FCrDNS verify del step 8 gatea hasta propagar.
- **Cancel:** `POST /v1/compute/instances/{instanceId}/cancel` = **fin-de-termino, NO destruye al instante.** GAP de rollback: la instancia Contabo queda facturable hasta fin de termino; el rollback step>=6 (`:1033-1053`) espera un delete que destruye. Manejar: aceptar cancel end-of-term documentado, o no auto-cancelar y alertar.
- **Idempotencia:** `GET /v1/compute/instances?search=<hostname>` para espejar `resolveExistingServerForCreate`.

---

## 5. FASES

- **F0:** worktree nuevo sobre produ (main). Branch `feature/contabo-provider`.
- **F1 (core, no-regresion):** interface `VpsProvider`; canal `providerId` (4 inputs+runState+spreads+forward); dispatch branch en create y delete; `createContaboAdaptersFromEnv` + `vpsProviderAdapters` en main.ts. Tests de no-regresion (Webdock byte-identico con providerId ausente) PRIMERO.
- **F2 (adapter Contabo):** `ContaboAdapter` implementando `VpsProvider`: token+refresh, ensure SSH secret, lookup image/product, createInstance, poll status->ipv4, map a `{serverSlug=instanceId, ipv4, status}`, deleteServer (cancel), listServers (idempotencia). Clasificacion de fallos recuperables (quota/payment) para el failover. Step 8 Contabo: hostname por SSH + PTR manual (instruccion al operador via audit/Canvas) + FCrDNS verify reusado.
- **F3 (E2E):** crear 1 VPS Contabo real US-east via el flujo, dominio fresco, hasta smoke. Validar PTR manual + entrega.

Mapea a tasks PM: F1+F2 = #30 (adapter+abstraccion) y #31 (cableado+no-regresion); F3 = #32 (E2E).

---

## 6. DEFINITION OF DONE / TESTS

Suite actual relevante: `orchestrator-smtp.test.ts` (DoD#1-5, `:479-684`), `skill-dispatcher.test.ts` (`:204-274`), `webdock-real-adapter.test.ts`, `creation-rate-governor.test.ts`, `webdock-servers.test.ts`. Todos deben seguir verdes.

Tests NUEVOS (obligatorios):
1. **Webdock-unchanged (load-bearing):** con `providerId` ausente o `"webdock"`, `step4.params` e `inputHash` byte-identicos (snapshot del string exacto del inputHash) y create rutea al adapter Webdock.
2. **Dispatcher providerId:** `providerId="contabo"` rutea al adapter Contabo; ausente/`"webdock"` al `webdockAdapter` y NUNCA toca el Contabo (spy).
3. **providerId fuera de params/hash:** `step4.params` NO tiene `providerId` ni `provider` (mismo assert que `orchestrator-smtp.test.ts:514`).
4. **Plan-signature intacta:** run plan-approved con `providerId="contabo"` NO cambia el scope hash firmado.
5. **Env reader Contabo:** `createContaboAdaptersFromEnv` construye adapter con las 4 creds OAuth2 y `canCreate()===true`, aislado de keys Webdock.
6. **Adapter Contabo unit** (`contabo-adapter.test.ts`): createServer -> `{serverSlug,ipv4,status}`; deleteServer -> shape de delete; token refresh; fallos quota/payment clasificados recuperables.
7. **Rollback routing:** delete handler rutea a Contabo con `providerId="contabo"`, a Webdock si no.

---

## 7. GOTCHAS / DECISIONES ABIERTAS PARA JUANES

1. **`normalizeServerSlug`** (`webdock-servers.ts:1079-1085`, regex `^[a-z0-9][a-z0-9-]{0,95}$`): el `serverSlug` Contabo es `instanceId` NUMERICO -> o prefijar (`contabo-<id>`) o relajar el regex para el path Contabo. Recomendado: prefijo estable `contabo-<id>` (y de-prefijar al llamar la API).
2. **Cancel end-of-term:** decidir politica de rollback Contabo (aceptar facturable-hasta-termino vs no-cancelar+alertar). Webdock destruye; Contabo no.
3. **PTR manual:** el step 8 Contabo NO puede setear PTR por API. El flujo 100%-autonomo se rompe parcialmente aca (igual que el PTR Webdock que ya era manual). Definir: instruccion clara al operador (audit + Canvas) y gate por FCrDNS.
4. **Gated-path:** replicar la decision de `gated_multiaccount_unsupported` para providers != webdock (threadear providerId al gated o abortar limpio).
5. **Governor labels:** dejar las constantes `create_webdock_server`/`STEP 4` como estan (cosmetico); tratar cada proyecto Contabo como "account". Generalizar labels es opcional, no bloquea.
6. **Token TTL:** confirmar `expires_in` real y meter refresh en el adapter antes del poll largo.

---

## 8. ENV (ya configurado, no tocar salvo agregar proyectos)

`config/gateway.env` y `.env.local` ya tienen (verificado token 200):
```
CONTABO_CLIENT_ID=INT-15071666
CONTABO_API_USER=hostlatam@proton.me
CONTABO_CLIENT_SECRET=...           (32 chars)
CONTABO_API_PASSWORD='...'          (single-quoted por el $)
```
Cuenta: Host Latam / Customer ID 15071666. Para multi-proyecto Contabo a futuro, agregar slots con sufijo (`CONTABO_*_2`, etc.) y leerlos en `createContaboAdaptersFromEnv`.
