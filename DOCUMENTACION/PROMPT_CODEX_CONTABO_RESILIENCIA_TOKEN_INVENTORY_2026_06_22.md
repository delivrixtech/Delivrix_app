# BRIEF CODEX — Resiliencia Contabo: token OAuth + inventario + reuse (anti rate-limit)

Fecha: 2026-06-22 · Diagnosticado en vivo + AUDITADO adversarialmente (subagente) · Ejecuta: **Codex** · Base: **`produ` LIMPIO** (ojo: `webdock-servers.ts` tiene cambios locales sin commitear que pueden colisionar con Fix 5) · Despues: **merge a `produ`**

## CORRECCIONES OBLIGATORIAS (auditoría adversarial) — leer ANTES de implementar
1. **Causa raíz real:** el fallo de hoy fue `401 invalid_grant: Invalid user credentials` (password de cuenta Contabo reseteada, `gateway.env` viejo), **NO rate-limit**. Con creds inválidas ningún fix de código salva el run — hay que corregir la password. Estos 5 fixes son HIGIENE + RESILIENCIA + DIAGNÓSTICO, no la cura del incidente de hoy. Ignorar la narrativa "anti rate-limit" del cuerpo de abajo.
2. **Método inexistente:** donde dice `resetToken` (`:469`), el método real es **`invalidateToken()`** (`contabo-adapter.ts:494`, reverificado vs produ tras el PR#14). Usar ese nombre.
3. **Fix 2 — NUNCA reintentar sobre `invalid_grant`:** en el GRANT, distinguir el `error` de Keycloak: `invalid_grant` → **0 reintentos, fail-fast**, `errorReason:"401_invalid_grant"` + mensaje accionable ("revisar CONTABO_API_PASSWORD en gateway.env"). Reintentar SOLO en 429 (con `Retry-After`), 5xx, red. (Reintentar sobre creds malas es lo que AGRAVA y probablemente disparó el reset de hoy.) El `errorReason` granular es lo MÁS valioso de Fix 2 — hoy el genérico `contabo_token_request_failed` ocultó que era creds.
4. **Fix 5 (LA pieza clave) — blindar contra reuse incorrecto:** `resolveExistingServerForCreate` es **COMPARTIDA Webdock+Contabo** (único call-site `webdock-servers.ts:273`). El binding-fallback debe: (a) ser **provider+account-scoped** — agregar `providerId`/`serverAccountId` al schema `runBindings` (`:158-163`) y resolver SOLO si coincide con el adapter del run (evita reuse cross-provider/cross-account); (b) reusar el campo **`domain`** que el binding YA guarda (`:344`), NO inventar `displayName`; (c) dejar el path "sin binding" **BYTE-IDÉNTICO** — los tests `degraded→blocked, createCalled=false` (`webdock-servers.test.ts:317` y `:371`, reverificado vs produ) DEBEN quedar verdes; (d) honestidad: Fix 5 NO salva runs ante invalid_grant (`getServer` comparte el mismo grant), solo ante list degradado **transitorio/parcial** y re-runs (runId nuevo cada vez, `orchestrator-smtp.ts:566`). Bonus: el binding vive en `webdock-servers.json` (filesystem) → resiste Postgres/Redis caídos.
5. **Fix 4 = panel-only / P3:** el run reusa vía `resolveExistingServerForCreate`, NO vía `/v1/infrastructure/inventory`. Ese cache solo ayuda al polling del panel. No es bloqueante para destrabar runs.

## Contexto: el reuse Contabo se auto-rate-limita y tumba runs firmados
Montando un 2do SMTP (`nationalbizrenewal.com`, VPS nuevo `contabo-203389909`), 3 runs (v2/v3) fallaron en **step 4 con `webdock_inventory_degraded`**. La verdad de campo (endpoint `/v1/infrastructure/inventory`, live 13:15): el proveedor Contabo está `status:"error"`, **`errorReason:"contabo_token_request_failed"`** — persistente ~15 min (no transitorio). El create del MISMO VPS funcionó 25 min antes (12:40), así que las credenciales son válidas: **es la solicitud del TOKEN OAuth (password grant a `auth.contabo.com`) la que está siendo rechazada de forma sostenida — patrón de rate-limit / lockout temporal de Keycloak por volumen de requests.**

Causa estructural (no incidental): el `ContaboAdapter` pide el token demasiado seguido, sin single-flight, sin backoff, y el `listServers` no cachea — y el endpoint de infra-inventory (que el panel pollea) dispara una llamada Contabo viva en cada poll. Resultado: nos auto-rate-limitamos, y un solo fallo de token → `responseOk:false` → `webdock_inventory_degraded` → run firmado caído. **Esto recurre cada vez que el token falle justo antes de un reuse, y empeora cuanto más se reintenta o se pollea.**

> NOTA: el status HTTP exacto del token (429 vs 401 "temporarily disabled") se confirma con `node --env-file=config/gateway.env scripts/contabo-probe.mjs`. Los fixes de abajo aplican igual sea 429 o lockout — reducen el volumen de requests y degradan con gracia.

## Fixes (todos en `packages/adapters/src/contabo-adapter.ts` salvo el 4 y 5)

### Fix 1 — Token: single-flight + cache por `expires_in` completo
`ensureToken` (`:522-575`) hoy reusa `this.token` si no expiró, pero NO tiene single-flight: llamadas concurrentes (varios runs / polls) pueden disparar múltiples grants en paralelo → ráfaga que gatilla el rate-limit.
- Agregar un **single-flight**: si ya hay un grant en vuelo (`this.tokenPromise`), las llamadas concurrentes esperan ESA promesa en vez de pedir otro token.
- Cachear por el `expires_in` real menos skew (mantener `:572`, `TOKEN_REFRESH_SKEW_MS`), pero **no re-pedir token por capricho**: solo cuando `expiresAt <= now`.

### Fix 2 — Backoff + respeto de `Retry-After` en 429 (token Y compute)
`computeFetch` (`:557-567`) y el grant de `ensureToken` usan `fetch` pelado, sin retry. Un único 429/401/ECONNRESET → `responseOk:false`.
- En el **token grant**: ante 429, leer `Retry-After` y esperar ese tiempo (cap ~60s); ante 401/invalid_grant, NO reintentar en loop (es creds/lockout — fallar claro con el motivo).
- En `computeFetch` (instances): 1-2 reintentos con backoff exponencial corto ante 429/5xx/red; ante **401**, invalidar token (`invalidateToken()` ya existe `:494`) y reintentar UNA vez con token fresco (cubre token expirado server-side).
- Propagar el motivo real (`429_rate_limited` / `401_unauthorized` / `network`) al `errorReason`, no el genérico `contabo_token_request_failed`, para diagnóstico.

### Fix 3 — Cachear el inventario Contabo (`listServers`)
`listServers` (`:311-358`) NO cachea (a diferencia de Webdock `webdock-real-adapter.ts:284-288`, TTL `DEFAULT_TTL_MS=60_000` en `:176` — copiar ese patrón). Cada reuse + cada poll de infra-inventory golpea `/v1/compute/instances` en vivo → más token requests.
- Cachear el resultado de `listServers` con TTL corto (p.ej. 30-60s). Devolver el cache dentro del TTL. Invalidar tras un create/delete exitoso del adapter (para que el reuse vea el VPS recién creado).

### Fix 4 — `/v1/infrastructure/inventory` no debe re-fetchear Contabo en cada poll
`apps/gateway-api/src/main.ts:1781` (`handleInfrastructureInventoryHttp`) + el loop `vpsProviderListServers` (`~:1793`) llaman `listServers()` por proveedor en CADA request del panel. Si el panel pollea cada pocos segundos, es el mayor contribuyente al rate-limit.
- Con el Fix 3 (cache en el adapter) esto se mitiga solo. Adicional: cachear la respuesta del endpoint infra-inventory server-side (TTL ~30s) para no recalcular por cada poll. El loop ya degrada por-proveedor (`infrastructure.vps_provider_inventory_failed`, "degrading this provider only") — mantener eso.

### Fix 5 — Reuse resiliente: fallback por binding hostname->instanceId
`resolveExistingServerForCreate` (`apps/gateway-api/src/routes/webdock-servers.ts:906-946`) bloquea con `webdock_inventory_degraded` (`:931-932`) si el list no es live+ok. Hoy `resolveExistingServerByRunBinding` (`:917-920`, `:948-974`) solo matchea por `runId` — y en un re-run el runId es nuevo, así que no aplica → depende 100% del list vivo.
- **Persistir el binding también por hostname/displayName** (no solo runId) en `webdock-servers.json` tras un create exitoso. En el reuse, consultar ese binding ANTES de `listServers()`: si hay `instanceId` conocido para el hostname, resolver con un **`getServer(instanceId)` (1 sola llamada barata)** en vez del list completo. Así un list degradado NO bloquea el reuse de un VPS ya conocido.
- Mantener byte-idéntico el path Webdock (el binding extra es additivo).

## DoD
- Con el token Contabo rate-limited momentáneamente, el adapter **reintenta con backoff/Retry-After** y NO multiplica requests (single-flight) — deja de auto-rate-limitarse.
- Un reuse de un VPS Contabo **ya conocido** (binding por hostname) procede con `getServer` aunque el `listServers` esté degradado — no más `webdock_inventory_degraded` falso.
- El panel polleando infra-inventory NO dispara un token+list Contabo por cada poll (cache).
- `errorReason` refleja el motivo real (429/401/network), no el genérico.
- Webdock byte-idéntico. `npm test` verde. Sin exponer secretos/tokens. Merge a `produ`.

## Anclas (file:linea)
- Token: `contabo-adapter.ts:522-575` (ensureToken), `:572` (skew `TOKEN_REFRESH_SKEW_MS`), `:494` (invalidateToken), `:581` (computeFetch sin retry). [reverificado vs produ tras PR#14]
- listServers (sin cache): `contabo-adapter.ts:311-358`; `sourceMetadata` `:666-680` (kind siempre "live"; el block viene de responseOk:false).
- Webdock cachea (referencia): `packages/adapters/src/webdock-real-adapter.ts:284-288` (TTL `DEFAULT_TTL_MS` `:176`).
- Gate degraded + reuse + binding: `apps/gateway-api/src/routes/webdock-servers.ts:906-946`, `:917-920`, `:931-932`, `:948-974`.
- Dispatch que elige ContaboAdapter directo: `apps/gateway-api/src/skill-dispatcher.ts:444-454`, `:700-712`.
- Infra-inventory endpoint + loop por-proveedor: `apps/gateway-api/src/main.ts:1781`, `~:1793`.
- Instancia única del adapter al boot: `apps/gateway-api/src/main.ts:382-384`.
