# BRIEF CODEX — Integración MXtoolbox (read-only health/blacklist) — AUDITADO

Fecha: 2026-06-17 · Auditado por Claude + 2 subagentes (backend + wiring del agente) + verificación de la API real de MXtoolbox · Ejecuta: Codex · Rama: `produ`.

> Este brief **reemplaza** el spec original de OpenClaw. Ese spec estaba bien encaminado pero asumía una arquitectura (axios, router, carpeta `providers/`, cron-jobs, Redis) que NO existe en este repo, omitía todo el wiring para que el agente realmente invoque la tool, y **alucinó parte de la API de MXtoolbox**. Abajo está la versión corregida y build-ready.

## 0. Alcance DECIDIDO (Juanes, 2026-06-17)

- **Tool del agente + UI en el panel** (las dos capas). Se construyen: la tool de OpenClaw Y una vista de blacklist/health en el admin → hay que tocar `read-boundary.ts` Y `server.mjs` Y la matriz §3.1 Y agregar la vista (sección 4).
- **Scan diario SÍ**, vía `setInterval(...).unref()` gated por flag `MXTOOLBOX_DAILY_SCAN_ENABLE` inline en main.ts (patrón del TTL episódico, main.ts:5111-5117). **NO** un `jobs/*.job.ts` con crontab (esa infra no existe). Granularidad por intervalo, no cron-expression (ver §2b).
- **Único confirm pendiente (Codex, en el build, con la API key real):** el host exacto (`mxtoolbox.com/api/v1` vs `api.mxtoolbox.com/api/v1`) y que los comandos `blacklist`/`smtp` existen (la doc lista A/AA/BIMI/DMARC/DKIM/DNS/MTA-STS/MX/PTR/SPF/TXT; blacklist/smtp son clásicos de SuperTool pero no textuales ahí). No asumir — un smoke real lo confirma.

## 1. API real de MXtoolbox (CORREGIDA — la del spec estaba mal)

- **Request:** `GET {BASE}/api/v1/Lookup/{Command}/?argument={valor}` — el valor va como **query param `argument`**, NO en el path. (El spec puso `/lookup/{type}/{value}`: incorrecto.)
- **Auth:** header `Authorization: <UUID-API-KEY>` (UUID plano, sin "Bearer"). Nunca hardcodear ni loguear la key.
- **Commands** (el `{Command}`): blacklist, smtp, mx, spf, dkim (`dkim:{selector}`), dmarc, ptr (+ a, txt, dns, mta-sts disponibles). Confirmar blacklist/smtp en vivo.
- **Response real** (campos confirmados en la doc oficial):
  ```
  { UID, Command, CommandArgument, TimeRecorded, ReportingNameServer,
    TimeToComplete, IsEndpoint, HasSubscriptions,
    Failed: Check[], Warnings: Check[], Passed: Check[], Timeouts: Check[] }
  ```
  donde `Check = { ID: number, Name: string, Info: string, Url: string }`.
- **NO EXISTEN** (alucinados por OpenClaw, removerlos del tipado): `MxRep`, `IsTransient`, `Errors[]`, `Information[]`, `PublicDescription`, `IsExcluded`. Todo el "MxRep 0-100 / score de reputación" del spec **se descarta** (no hay tal campo). Para el error/timeout usar `Timeouts[]` y/o error de red/HTTP, no `IsTransient`.
- **Quota:** existe el método `Usage` (consumidos/máximo). Usarlo para no quemar quota, en vez de "headers de rate-limit" (que el spec inventó).

**Lógica de status (corregida):**
- `Failed.length > 0` → `"listed"`
- `Warnings.length > 0 && Failed.length === 0` → `"warning"`
- `Failed.length === 0 && Warnings.length === 0 && Timeouts.length === 0` → `"clean"`
- `Timeouts.length > 0` o error de red/HTTP → `"error"`

**Tipos corregidos (reemplazan los del spec):**
```ts
interface MxtoolboxCheck { id: number; name: string; info: string; url: string }
interface MxtoolboxLookupRaw {
  UID: string; Command: string; CommandArgument: string; TimeRecorded: string;
  ReportingNameServer?: string; TimeToComplete?: string;
  Failed: MxtoolboxCheck[]; Warnings: MxtoolboxCheck[];
  Passed: MxtoolboxCheck[]; Timeouts: MxtoolboxCheck[];
}
interface MxtoolboxHealthSummary {
  target: string; command: string; checkedAt: string;       // ISO-8601
  status: "clean" | "warning" | "listed" | "error";
  failedChecks: string[]; warningChecks: string[];
  passedCount: number; timeoutCount: number;
  rawRef: string;   // sha256 del raw para audit (no exponer el raw al front)
}
```

## 2. Backend — patrones REALES del repo (no los del spec)

- **Cliente/adapter:** `packages/adapters/src/mxtoolbox-adapter.ts` (NO `apps/gateway-api/src/providers/`, que no existe). Patrón canónico = `contabo-adapter.ts`/`aws-route53-domains-adapter.ts`: `export class MxtoolboxAdapter` + `interface MxtoolboxAdapterConfig` + `export function createMxtoolboxAdapterFromEnv(env = process.env)` que devuelve el adapter o `null` si falta `MXTOOLBOX_API_KEY` (nunca lanza al boot). Añadir `export * from "./mxtoolbox-adapter.ts";` en `packages/adapters/src/index.ts`. Es read-only puro: NO implementa `VpsProvider`; define su propio resultado con bloque `source: { kind:"live"|"mock", apiBase, fetchedAt, responseOk, errorMessage }` (estilo `webdock-real-adapter.ts:68-77`).
- **HTTP:** native `fetch` vía `fetchImpl?: typeof fetch` (default `fetch`); axios NO es dependencia (no agregar). Timeout 10s (AbortController), retry 2 en 5xx + 1 en 429. Tests **inyectan un `fetchImpl` fake**, no mockean axios (patrón `aws-route53-domains-adapter.test.ts`).
- **Cache:** in-memory por instancia del adapter (`private cache` + `expiresAt`), TTL configurable `MXTOOLBOX_CACHE_TTL_MS` (default explícito; el repo usa 60s-5min, no 1h Redis — si se quiere 1h justificarlo como constante). **Redis NO aplica** (está down; el repo no lo usa para caches de adapter).
- **Ruta:** `apps/gateway-api/src/routes/mxtoolbox-read.ts` exportando `handleReadMxtoolbox(request: IncomingMessage, response: ServerResponse, deps)` (firma req/res/deps como `route53-domain-detail.ts:53`). Registrarla en `main.ts` con matching manual `if (request.method === "GET" && requestUrl(request).pathname === "/v1/mxtoolbox/health") {...}` (patrón main.ts:1863). **No hay router**; no usar `app.get()`/`Router`. Endpoint: `GET /v1/mxtoolbox/health?target=<ip|dominio>&type=<command>` (default type `blacklist`). Response `{ source:"live"|"cached", cachedAt?, result: MxtoolboxHealthSummary }`.
- **Audit:** reusar el patrón `appendRoute53ReadAudit` → `auditLog.append({ actorType:"openclaw", actorId:"openclaw-mxtoolbox-read", action:"oc.mxtoolbox.lookup", targetType:"ip"|"domain", targetId:<target>, riskLevel:"low", decision:"allow", humanApproved:false, metadata:{ provider:"mxtoolbox", command, status, ...sin la key } })`. El nombre del evento va en **`action`** (string), NO en `type`. **Todas las lecturas son `riskLevel:"low"`** (el repo no marca reads como "critical"; el "critical" del spec no aplica). No hay enum de actions que tocar.
- **Env/pre-flight:** leer con `normalizeEnvValue(env.MXTOOLBOX_API_KEY)`. Agregar un `EnvVarSpec` a `ENV_PREFLIGHT_CATALOG` (`apps/gateway-api/src/env-preflight.ts`): `{ name:"MXTOOLBOX_API_KEY", group:"providers", severity:"warn", kind:"secret", breaks:"lecturas MXtoolbox fallan" }`. `delivrix-env-doctor.sh` lo toma solo (no tocar el script). `severity:"warn"` (read-only opcional).

## 2b. Scan diario + daily-report (EN SCOPE — decidido)

- **Endpoint** `GET /v1/mxtoolbox/daily-report?targets=<csv ip|dominio, máx 50>&types=<csv comandos>` → `{ generatedAt, totalTargets, summary:{clean,warning,listed,error}, results: MxtoolboxHealthSummary[], criticalAlerts:<solo los listed> }`. Mismo handler-suelto + registro manual en main.ts.
- **Targets automáticos:** leer del store de sender_nodes los serverIp activos + dominios activos (reusar el reader existente del gateway, no inventar).
- **Job:** `setInterval(async () => {...}, intervalMs).unref()` inline en main.ts, **gated** por `flagEnabled(env.MXTOOLBOX_DAILY_SCAN_ENABLE)` (patrón main.ts:5111-5117). NO crontab, NO `jobs/`. Intervalo configurable (default 24h en ms); si se quiere anclar a las 08:00 UTC, calcular el primer delay y luego 24h — sin cron-expression.
- **Alertas:** si algún resultado es `listed` → (a) `auditLog.append({action:"oc.mxtoolbox.blacklist_detected", riskLevel:"high", targetType, targetId, decision:"allow", humanApproved:false, metadata:{failedChecks}})`; (b) proposal al canvas vía el servicio existente `canvas-live-events` con `severity:"high"` (escalar a `"critical"` si >5 targets listed). Si todo limpio → `auditLog.append({action:"oc.mxtoolbox.daily_scan_clean", riskLevel:"low"})`. Persistir el resultado en episodic scratch (TTL 7d) SOLO si el store está disponible (Postgres hoy down → gatear, no romper si falta).
- **Quota:** el scan hace N×tipos requests — respetar el método `Usage` de MXtoolbox + el cache para no quemar quota.

## 3. Wiring del agente (lo que el spec OMITIÓ — sin esto la tool es invisible al LLM)

Una read-tool toca ~8 lugares, no 4:
1. **`openclaw-tools-builder.ts`:** (a) agregar `| "read_mxtoolbox_health"` al union `OpenClawToolName` (~:36-56); (b) entrada en `toolDefinitions` con `spec` (BedrockToolSpec: name/description/input_schema), `paramSchema` (Zod), `enabled:(env)=>hmacConfigured(env)&&hasMxToolboxCredentials(env)`, `targetType`, `severity` (patrón read_route53_domain_detail :267-289); (c) helper `hasMxToolboxCredentials(env)` junto a los `hasAwsRoute53*` (~:877-912); (d) agregar el nombre a `openClawToolNames()` (~:824-847).
2. **`tool-use-processor.ts` (~:659):** branch `if (toolName === "read_mxtoolbox_health")` que arma `new URL(\`${baseUrl}/v1/mxtoolbox/health?...\`)`, fetch con `readBoundaryToken`, devuelve el body. Sin esto la tool se ofrece pero falla al invocarse.
3. **`permission()` en `main.ts` (~:982):** `permission("read_mxtoolbox_health", "allowed_read_only")`. Sin esto queda fuera de policy y rompe el load de cualquier SKILL.md que la declare.
4. **System prompt — sección `[12] TOOLS DISPONIBLES`** de `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md` (~:220, lista de LECTURA), **NO `[11]`** (MXtoolbox no es proveedor de infra, es diagnóstico). Y **tocar TAMBIÉN la copia embebida en `scripts/openclaw/build-system-context.sh`** (~:289 y la sección de tools del heredoc), o el agente en Hostinger lee stale. (NORTE_OPERATIVO §11 **no existe** — el spec se equivocó; NORTE es prosa sin secciones numeradas.)
5. **`OPENCLAW_SKILLS_CATALOG.md`:** skill `mxtoolbox-health-check` en el formato real (frontmatter slug/version/trigger/`delivrix_actions:[read_mxtoolbox_health]`/returns/audit_id_prefix/fallback + tabla `| Campo | Valor |`). `delivrix_actions` se valida contra el `permission()` al cargar.
6. **Matriz de permisos:** una read-tool del agente cuyo endpoint NO está en el read-boundary del panel **no necesita fila** en `OPENCLAW_PERMISSIONS_MATRIX.md` (la tabla §3.1 es solo endpoints del panel). El spec invierte esto. Solo agregar fila si se decide exponerlo al panel (decisión 0.1).

## 4. Front / panel (EN SCOPE — decidido)

- Agregar **AMBOS** endpoints (`/v1/mxtoolbox/health` y `/v1/mxtoolbox/daily-report`) a `apps/admin-panel/src/shared/api/read-boundary.ts` **Y** a `apps/admin-panel/server.mjs` (`allowedProxyPaths`). El segundo enforcea en prod (404 `unknown_read_endpoint` si falta), igual que `/v1/infrastructure/inventory` — tocar los DOS o el panel da 404.
- Agregar las filas correspondientes a `OPENCLAW_PERMISSIONS_MATRIX.md` §3.1 (la regla de sync ata read-boundary.ts ↔ §3.1 para endpoints del panel).
- **Vista en el panel:** sección/card "Salud · Blacklist" siguiendo los patrones de `apps/admin-panel/src/v5/` (como la sección Infraestructura): tabla de targets con status (clean/warning/listed/error), alertas críticas (`listed`) destacadas arriba, frescura/origen (live/cached) por fila. Read-only, sin escritura. Reusar primitivas existentes (Pill, Card, SectionHead) + el cliente del read-boundary.

## 5. Deploy para quedar VIVO (el spec lo omitió entero)

1. Endpoint + adapter + tools-builder + permission + skill + system-prompt(×2 fuentes) en disco.
2. `MXTOOLBOX_API_KEY` en `config/gateway.env` + `.env.local` (cargada al boot; sin ella `enabled()` = false y la tool no se emite).
3. **Rebuild system-context:** `bash scripts/openclaw/build-system-context.sh`. **OJO:** falla si el bootstrap AGENTS supera ~11500 chars (`:328`, cap 10700 hoy) — texto nuevo en `[12]` puede romperlo; compactar si hace falta.
4. **Push a Hostinger** (el mismo script) + **restart del gateway local** (deploy local Y Hostinger juntos).
5. **Verificación:** tests guard (`openclaw-tools-builder.test.ts`, `openclaw-bedrock-bridge.test.ts`) en verde; smoke real contra `/v1/mxtoolbox/health?target=8.8.8.8&type=blacklist` con la key; y preguntarle a OpenClaw "¿está la IP X en blacklist?" para confirmar que ya tiene la tool. Claude revalida.

## 6. Tests

- Adapter: inyectar `fetchImpl` fake → verificar retry en 5xx, espera+retry en 429, parseo del response real (`Failed/Warnings/Passed/Timeouts`, `{ID,Name,Info,Url}`), y la lógica de status (Failed→listed, Warnings→warning, vacío→clean, Timeouts→error).
- Endpoint: `handleReadMxtoolbox` con adapter mock → status correcto + audit emitido + cache hit ("source":"cached").
- tools-builder/bedrock-bridge: la tool aparece en el set esperado (los tests enumeran toolNames; agregar el nuevo o el CI falla).

## 7. Lo que se DESCARTA del spec original (la FORMA, no la función)
- `apps/gateway-api/src/providers/mxtoolbox/` (dir inexistente) · axios · `*.routes.ts`/router · el ARCHIVO `jobs/*.job.ts` con crontab `0 8 * * *` (el scan diario SÍ va, pero como `setInterval` gated — §2b) · Redis · campos `MxRep`/`IsTransient`/`Errors`/`Information` (no existen) · request `/lookup/{type}/{value}` (es `?argument=`) · `NORTE §11` (no existe; va en `[12]`). Las filas de la matriz §3.1 SÍ van (hay UI en el panel).

## 8. Commit
Standalone, paths explícitos (adapter, index.ts, route, main.ts, tools-builder, tool-use-processor, env-preflight, system-prompt.md, build-system-context.sh, skills-catalog.md, tests; + read-boundary/server.mjs solo si panel). Nunca `git add -A` (`.audit/*`, `config/*.bak-*`, secretos afuera). Push a `origin/produ`.
