# Codex — P0 FIX: identidad SMTP / FCrDNS automatizada (Webdock Server Identity vía API) — sin romper lo que funciona

> **Estado:** verificado read-only (subagentes + doc/CLI **oficial** de Webdock) el 2026-06-09 contra HEAD/produ. Es un defecto de **entregabilidad EN VIVO**: los SMTP construidos quedan con identidad incorrecta y el build lo declara "listo" igual.
> **Subagentes OBLIGATORIO** (worker + auditor independiente). NO romper el flujo de provisioning actual. Stop-and-report si algo no aplica limpio o si no podés confirmar el endpoint del API.

## El defecto (verificado)
- En Webdock, el campo **Server Identity / Main domain** de los SMTP queda en el default `serverXX.vps.webdock.cloud`. La **doc oficial** de Webdock dice que el *Server Identity tool* hace 3 cosas: setea a qué dominios responde el webserver, **setea el hostname del sistema**, y **configura el PTR (rDNS) usando el dominio primario** ("enabling proper reverse IP resolution for services such as email delivery"). ⇒ El **PTR cuelga del Server Identity**. Si queda en `serverXX`, el **PTR queda en `serverXX` → FCrDNS roto** (HELO=`smtp.<dominio>` ✓ pero PTR≠HELO).
- **VERIFICADO que es automatizable** (corrige la creencia previa "PTR manual"): la CLI/API oficial expone `servers identity update <slug> --maindomain smtp.<dominio> --removeDefaultAlias true` (evento `set-hostnames`). Eso setea hostname + PTR + **quita el alias `serverXX.vps.webdock.cloud`** (exactamente el slug que no debe aparecer). Requiere que el **A/AAAA** (`smtp.<dominio>→IP`) ya exista (el tool no maneja DNS).
- Hoy el código: setea bien el HELO **dentro** del VPS pero **nunca** toca el Server Identity de Webdock, e **ignora el PTR en silencio** y declara el SMTP listo.

## Contexto verificado (anclajes — confirmá al implementar)
1. `apps/gateway-api/src/routes/webdock-bind-domain.ts:206-234` — step 6 `bind_webdock_main_domain` llama `webdockAdapter.setServerMainDomain(...)` que es **SSH `hostnamectl`** (hostname interno; NO toca el Server Identity de Webdock). `:236-277` — intenta `setServerPtr(...)`, el stub devuelve `supported:false` → `ptrSkipReason:"not_supported_by_api"` → **best-effort skip, el build sigue y marca `main_domain_bound`**. `:165-203` — early-path "alreadyBound" también con `ptrSet:false`.
2. `packages/adapters/src/webdock-real-adapter.ts:518-620` — `setServerMainDomain`/`setServerHostnameViaSsh` = SSH `hostnamectl set-hostname` + `/etc/hosts` (OS interno). `:622-635` — `setServerPtr` = **stub** `{ ok:false, supported:false, raw:{reason:"not_supported_by_api"} }` (buscaba un endpoint PTR-directo, que no existe; se perdió el path indirecto vía main-domain).
3. El adapter YA tiene cliente HTTP autenticado al **Webdock API** (`https://api.webdock.io/v1`) — `create/get/delete server` lo usan, con las 3 keys por rol (PRIMARY=read, **OPS=write**, ACCOUNT=account). `set-hostnames`/identity es **escritura** → key OPS (confirmá el scope; si requiere otra, reportá, NO adivines).
   - **OJO (verificado 2026-06-09):** los SDK oficiales **php-sdk y python-sdk están DESACTUALIZADOS** y NO listan el endpoint de identity/hostnames (solo `PATCH /servers/{slug}` para metadata name/description/notes — eso **NO** es la identidad). La **CLI oficial actual SÍ** lo tiene: `webdock servers identity update <slug> --maindomain <smtp.dominio> --removeDefaultAlias true` (event `set-hostnames`). El endpoint **es asíncrono**: como create/delete devuelve `x_callback_id` (header) → hay que **poll del evento** hasta completar. **NO te bases en los SDK para el path; confirmalo contra `api.webdock.io/v1` (spec vivo) + la CLI.**
4. `apps/gateway-api/src/routes/smtp-provisioning.ts` `renderPostfixMainCf` — `myhostname`/`smtp_helo_name`/`smtpd_banner = smtp.<dominio>` ya **CORRECTO**. **NO TOCAR** (el HELO interno está bien; el problema es solo el Server Identity de Webdock + PTR).
5. El A record `smtp.<dominio>→IP` se publica en el **step de DNS forward (Route53)** del orquestador. La doc Webdock exige A/AAAA creados **antes** del identity update; y el FCrDNS forward también lo necesita. Confirmá el orden real de steps (el bind hoy corre antes del DNS forward).

## Alcance del fix
**A) Adapter — método REAL `setServerIdentity` vía Webdock API (evento `set-hostnames`).**
Implementar una llamada HTTP al endpoint de identity/hostnames reutilizando el **cliente HTTP + auth (key OPS)** que ya usan create/get/delete, con params equivalentes a la CLI oficial: `mainDomain = smtp.<dominio>`, `removeDefaultAlias = true` (quita el alias `serverXX.vps.webdock.cloud`), `aliasDomains` vacío salvo que aplique.
- **PASO 0 (obligatorio, antes de codear la llamada):** fijá **path/método/payload exactos** contra **`https://api.webdock.io/v1`** (spec vivo) + el comportamiento de la **CLI oficial** (`webdock servers identity update`). **php-sdk/python-sdk están desactualizados y NO listan este endpoint — NO te bases en ellos.** Si no podés confirmar el path → **stop-and-report** (NO adivines).
- **ES ASÍNCRONO:** devuelve `x_callback_id` (header). **Poll del evento `set-hostnames`** (vía `GET /events` o hook) hasta completar **ANTES** de verificar FCrDNS — reutilizá el patrón de espera de eventos que ya usa create. Devolvé `{ ok, callbackId, raw }`; errores como `WebdockAdapterError`.
- `setServerPtr`: conservá la firma si hay tests que la referencian (stop-and-report si la hay) — puede delegar en la nueva ruta o quedar deprecated. NO rompas tests existentes.

**B) Bind step — usar el identity API en vez del skip silencioso.**
En `webdock-bind-domain.ts`, asegurar el A record y luego llamar `setServerIdentity({ serverSlug, mainDomain: smtp.<dominio>, removeDefaultAlias:true })`. El `hostnamectl` SSH puede quedar como complemento del hostname OS o quitarse si el identity API ya lo cubre — **decidí con cuidado y reportá**; lo crítico: que el **Server Identity de Webdock quede en `smtp.<dominio>`** y se quite el alias `serverXX`.

**C) Verificación FCrDNS como GATE (no silencioso).**
Tras setear identity + A record propagado, verificar: `dig +short smtp.<dominio> A` == `IP_VPS` **Y** `dig +short -x IP_VPS` == `smtp.<dominio>.`. 
- FCrDNS OK → marcar `ptrSet:true` + audit `oc.webdock.identity_aligned`.
- FCrDNS aún no (propagación) → **estado PENDIENTE explícito** (NO "listo"), con espera/reintento acotado (reutilizá el patrón de waits de DNS del orquestador). **Nunca** declarar el SMTP sano con FCrDNS sin verificar (ese es el bug actual).

**D) Orden.** El identity update (y sí o sí la verificación FCrDNS) debe correr **después** del A record (step DNS forward). Si el bind (step 6) hoy corre antes, mové la verificación (y si hace falta el propio identity update) a después del DNS forward, con el cambio mínimo, sin romper la cadena. Reportá el orden elegido.

## PROHIBIDO
- Romper el provisioning actual ni el HELO interno (`smtp-provisioning.ts`) que ya está bien.
- **Inventar** el endpoint del Webdock API. Confirmalo contra `api.webdock.io/v1` + el cliente existente; si no se puede confirmar → **stop-and-report**.
- Volver a declarar un SMTP "listo" con FCrDNS sin verificar.
- Tocar selección de cuenta / multi-cuenta / gobernador de creación (eso es **P1**, prompt aparte). Esto es SOLO identidad/FCrDNS de la cuenta actual, single-account.
- Mandar secretos al chat/panel/logs.

## DoD (Codex)
1. Subagentes (worker + auditor). Endpoint Webdock **confirmado** contra `api.webdock.io/v1`.
2. Tests: `setServerIdentity` (éxito + error, fake del cliente HTTP); el bind usa la nueva ruta y **no** hace skip silencioso; verificación FCrDNS OK vs pendiente; backward-compat (el flujo no se rompe, HELO intacto). `npm test` + `npm --workspace @delivrix/admin-panel run check` + `tsc` 0. (`approval-token.test.ts` `/private/tmp` EACCES = artefacto sandbox.)
3. **NO** disparar un `configure_complete_smtp` real en CI (QA real lo hace Juanes en un dominio nuevo).
4. Commit atómico: "Set Webdock Server Identity to smtp.<domain> via API + verify FCrDNS gate (P0 deliverability)". Deploy: gateway restart + push `origin produ` (+ Hostinger).
5. **Remediación de los 6 SMTP vivos** (server60/68/69/81/83/84, hoy con identity `serverXX`): NO automatizar masivo acá. Dejar documentado/comando seguro (un identity update + `dig -x` por server) para que **Juanes** decida correrlo (puede gatillar evento/reboot Webdock).

## Reportá
SHA + **endpoint Webdock confirmado** (path/método/payload + qué key-rol) + EXIT de tests + `tsc` + confirmación de que: (a) el HELO interno quedó intacto; (b) FCrDNS ahora es **gate verificado**, no skip; (c) NO tocaste selección/multi-cuenta; (d) el orden vs el A record. Pendiente **QA-Juanes**: build nuevo → confirmar en Webdock que Server Identity = `smtp.<dominio>`, sin alias `serverXX`, y `dig -x IP` = `smtp.<dominio>`.
