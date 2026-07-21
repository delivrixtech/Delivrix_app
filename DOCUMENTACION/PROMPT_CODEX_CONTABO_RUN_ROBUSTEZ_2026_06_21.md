# BRIEF CODEX — Robustez del run SMTP en Contabo (reuse-match + IP-poll + IP-resume)

Fecha: 2026-06-21 · Auditado en vivo por Claude (E2E real, 6 runs) + subagentes (anclas file:línea) · Ejecuta: **Codex con subagentes** · Base: **`produ`**

## Estado: el create de Contabo YA FUNCIONA
Tras los fixes (displayName sanitizado, `CONTABO_PRODUCT_ID=V92`, `CONTABO_IMAGE_ID=afecbb85...` ubuntu-22.04 plana, region `US-east`), Contabo **aceptó y creó un VPS real**: `contabo-203386827` (run v5, evidence `executions/2026-06-21/023541-...success.md`). El payload del create es válido. Lo que falta es la **robustez del post-create** para Contabo.

> NOTA: hay fixes en el **working tree** (no en produ) que deben preservarse/portarse: el sanitizado de `displayName` (`contabo-adapter.ts` createServer), el log diagnóstico `[contabo] createServer failed`, y el `vpsProviderId` expuesto en la tool (`openclaw-tools-builder.ts`). Y `CONTABO_PRODUCT_ID`/`CONTABO_IMAGE_ID` están seteados en `config/gateway.env` (no commitear el .env; documentar los valores).

## Los 3 problemas entrelazados (todos confirmados en runtime)

### Problema 1 — el reuse-match NUNCA matchea un VPS Contabo (el bloqueante ACTUAL)
- Síntoma (run v6): Contabo 400 `"There is already an instance with the same display name"`. El run intentó **crear otro** VPS en vez de reusar `contabo-203386827`.
- Causa PRECISA (verificada en código): `resolveExistingServerForCreate` (`webdock-servers.ts:887`) usa `webdockServerMatchesHostname`, que compara **`server.hostname` y `server.mainDomain`** (vía `normalizeDomainLoose`) contra el hostname buscado (`smtp.annualcorpfilings.com`). PERO el `toWebdockServer` de Contabo (`contabo-adapter.ts:649-661`) setea **`server.hostname = instance.name`** (`:658` — el "name" interno de la instancia Contabo, p.ej. `vmiXXXX`, NO el hostname SMTP) y **NO setea `mainDomain`**; el displayName sanitizado va a `server.name` (`:651`), que el match **NO mira**. Resultado: el match da SIEMPRE 0 para Contabo → `status:"create"` → crea → en el 2do run con mismo dominio choca el displayName duplicado (400). NB: NO es "por el sanitizado en sí" — el match ni siquiera mira el displayName; es por el **campo mapeado** (`server.hostname` = instance.name).
- Fix:
  1. **Cross-run (nuevo runId reusando un VPS existente):** que el VPS Contabo sea matcheable por hostname. En `toWebdockServer`, exponer un campo matcheable contra el hostname SMTP (p.ej. setear `server.mainDomain`/`server.hostname` al displayName sanitizado), y hacer `webdockServerMatchesHostname` **sanitize-aware** (comparar `sanitize(hostname)` contra ese campo). Así `sanitize("smtp.annualcorpfilings.com")` == displayName del VPS → reuse.
  2. **Same-runId (resume):** complementar reusando por el **binding persistido `runId -> instanceId`** (`webdock-servers.json` runBindings, `webdock-servers.ts:446-454`).
- Resultado: el create DETECTA el VPS existente y lo reusa (`idempotent_already_exists`, costo 0) en vez de duplicar.

### Problema 2 — el poll de IP es muy corto para Contabo
- Síntoma (run v5): VPS creado pero `ipv4:null`, `status:provisioning`, `pollCount:24` → el run falló con `missing ipv4/serverIp`.
- Causa: poll fijo `defaultMaxPolls=24 × defaultPollIntervalMs=5000` = **2 min** (`webdock-servers.ts:166-167`, loop `:853-885`), **compartido** Webdock/Contabo. Contabo asigna IP más lento. El orquestador NO manda overrides (`orchestrator-smtp.ts:844-850`).
- Fix: poll **provider-aware** en `handleWebdockServerCreateHttp`. Para Contabo (providerId no-webdock) usar `CONTABO_PROVISION_MAX_POLLS` / `CONTABO_PROVISION_POLL_INTERVAL_MS` (default ~60×10s = 10 min); subir el tope de `normalizeMaxPolls` (`:1167`) si hace falta. Webdock byte-idéntico (24×5s).

### Problema 3 — el step 4 exige IP y se cae; el step 5 es no-op
- Causa: `orchestrator-smtp.ts:937` `stringFromOutcome(vps.outcome, ["ipv4","serverIp"])` SIN fallback → throw `missing ipv4/serverIp` (def `:3303-3312`) cuando ipv4 es null. El step 5 `wait_server_running` es stub (`main.ts:483-490`), no poll-ea.
- Fix (seam): el step 4 debe exigir SOLO el `serverSlug` (no la ipv4); resolver la IP en el **step 5** con un poll real `getServer(slug)` provider-aware (hoy stub). Separar "VPS creado" (slug) de "IP lista". Así un resume del mismo runId no relee `ipv4:null` cacheado (bug de resume confirmado por el subagente).

## DoD
- Un run Contabo sobre un dominio IONOS-owned: **crea O reusa** el VPS sin duplicar (Problema 1), **espera la IP** lo necesario (Problema 2), **no se cae** por IP tardía y la resuelve en step 5 (Problema 3), y continúa a DNS (IONOS) → Postfix → DKIM → warmup → smoke.
- El VPS existente `contabo-203386827` se **reusa** (no se duplica) en el próximo run con el mismo hostname.
- Webdock byte-idéntico (default sin overrides). `npm test` verde; sin tocar hashInput/scope firmado. Sin exponer secretos.

## port 25 (operativo, NO código)
Contabo bloquea el puerto 25 SMTP por anti-spam; el desbloqueo es **manual** en el panel Contabo. El flag `port25UnlockRequired:true` hoy es decorativo (no se lee en ningún lado). Mejora opcional: que el run lo SURFACE como `operatorAction` (no como blocker) para recordar el desbloqueo manual antes del smoke `send_real_email` (que envía por puerto 25 vía SSH al VPS).

## Anclas
- `webdock-servers.ts:166-167` (poll defaults), `:853-885` (loop), `:887-919` (resolveExistingServerForCreate), `:921-926` (match hostname), `:914-917` (block ipv4_missing), `:446-454` (runBindings).
- `orchestrator-smtp.ts:844-850` (params step 4 Contabo), `:937` (throw missing ipv4), `:3303-3312` (stringFromOutcome), `:1387-1397` (resume load), `:2223-2238` (skipDoneStep).
- `main.ts:483-490` (step 5 no-op `wait_server_running`).
- `contabo-adapter.ts:213-234` (createServer payload + displayName), `:288-305` (getServer), `:797-801` (ipv4FromInstance).
