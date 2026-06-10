# Codex — FASE 1 (columna vertebral, seam): campos `accountId` + `serverSlug` en SenderNode/servidor

> **Estado:** diseño verificado read-only contra HEAD/produ (anclajes file:line abajo, confirmados leyendo el código real + 2 auditores independientes el 2026-06-09).
> **ALCANCE REDUCIDO A PROPÓSITO (Parte A — el riel):** este prompt **solo agrega los campos opcionales y los acepta/persiste a través del registro**. **NO** los puebla automáticamente. La auditoría confirmó que **hoy NO existe un call-site que registre un sender node con contexto de servidor+cuenta** (ver "Por qué la población se difiere"). Por eso la población es una decisión/fase aparte y NO entra acá.
> **Independiente del enabler:** como NO hay población, este cambio NO depende del enabler y puede aterrizar antes o después de él, en cualquier orden.
> **Backward-compat CRÍTICO:** los campos son **OPCIONALES**. Ausentes (todos los datos actuales) ⇒ comportamiento **byte-idéntico** (drift, clusters, `selectSenderNode`, JSON persistido, respuestas HTTP). **Subagentes OBLIGATORIO** (worker + auditor independiente). Stop-and-report si algo no aplica limpio.

## Por qué (el seam que falta) y por qué la población se difiere
Hoy un `SenderNode` no sabe de qué cuenta de proveedor es ni a qué slug de servidor corresponde; el drift engine lo disimula tratando `node.id === server.slug` (anclaje #5). Esta tarea instala el **riel**: que el modelo y el registro **acepten** `accountId` + `serverSlug`. Las fases siguientes (selección, drift cross-account, prune, clusters por cuenta) consumen estos campos.

**La población se difiere porque (verificado por 2 auditores):**
- `configure_complete_smtp` **crea** el servidor Webdock (slug + ipv4 disponibles en `orchestrator-smtp.ts:~605-609`) pero **nunca registra un sender node** (no llama `executeRegisterSenderNodeRunbook` ni `senderNodeRegistry.register`).
- `POST /v1/sender-nodes` (`main.ts:4458-4479`) es **manual**: el body llega crudo, sin contexto de servidor ni cuenta.
- El endpoint `/v1/webdock/bridge-nodes/seed` es **demo/test** y queda apagado por kill-switch.
- ⇒ Poblar `accountId`/`serverSlug` requiere PRIMERO crear un **call-site nuevo** ("registrar el servidor recién creado como sender node tras el paso 4"), que es **comportamiento autónomo nuevo** (decisión de producto) + depende del enabler para el `accountId`. Eso NO se hace en este prompt.

## Contexto verificado (confirmá las líneas exactas; 6/9 anclajes ya confirmados por auditoría)
1. `packages/domain/src/types.ts:64-73` — `interface SenderNode { id; label; provider:"webdock"|"proxmox"|"racknerd"|"manual"; status; ipAddress?; hostname?; dailyLimit; warmupDay }`. Sin `accountId`/`serverSlug`.
2. `packages/domain/src/sender-node-registry.ts:18-27` — `interface RegisterSenderNodeInput`. `:191-214` — `normalizeSenderNode(input)` (patrón `input.x?.trim() || undefined` para strings opcionales).
3. `apps/admin-panel/src/shared/api/client.ts:642-651` — `interface SenderNodeContract` (espejo en el panel).
4. `packages/domain/src/webdock-inventory.ts:23-36` — `interface WebdockInventoryServer`. Sin `accountId`. **OJO:** puede existir OTRO tipo de servidor con `accountId` en `packages/adapters` (multi-cuenta del enabler) — **alinéate, no dupliques semántica**; acá solo agregás el campo opcional al contrato de inventario.
5. `packages/domain/src/openclaw-rules.ts:59-70` y `:147` — `evaluateWebdockDrift` con el comentario explícito de usar `node.id` como slug. **NO TOCAR** (Fase 3).
6. `packages/domain/src/admin-cluster-overview.ts:354` `groupSenderNodes` (por `provider`) + `:203` cluster id. **NO TOCAR** (Fase 2).
7. `apps/gateway-api/src/main.ts:3887-3891` `GET /v1/sender-nodes` → `{ nodes: list() }` (nodo **entero**); `:4458-4479` `POST` → `{ node }` entero. **Agregar campos al dominio fluye solo; NO hay serializador que recortar.** (Las refs `provider: node.provider` en `:4363/:4445/:4470` son metadata de audit log — dejarlas.)
8. Persistencia: `packages/local-store/src/local-file-sender-node-store.ts` → `runtime/sender-nodes.json`; `SenderNodeRegistryStore { list(); upsert() }` (`sender-node-registry.ts:8-11`). Campos opcionales ⇒ registros viejos deserializan igual. **Sin migración.**
9. `packages/domain/src/runbooks/types.ts:~64` — `RegisterSenderNodeRunbookInput` (lo importa `register-sender-node.ts:5` desde `./types.ts`). Agregar los dos opcionales (passthrough a `repository.register`).
   - Backward-compat confirmada por auditoría: no hay switch exhaustivo sobre llaves de SenderNode, ni `Object.keys/entries` sobre nodos, ni validación strict/zod del body del POST (rechazaría extras), ni redactor que enumere campos. Agregar opcionales es seguro.

## Alcance de ESTE prompt (Parte A — seam de tipos, Webdock-only)
Agregar `accountId?: string;` + `serverSlug?: string;` (opcionales) y threadearlos SOLO a través del registro:
- `SenderNode` (#1).
- `RegisterSenderNodeInput` + `normalizeSenderNode` (#2) — patrón `input.x?.trim() || undefined`.
- `RegisterSenderNodeRunbookInput` (#9) — passthrough.
- `SenderNodeContract` (#3) — espejo en el panel.
- `WebdockInventoryServer` (#4) — solo el campo opcional en el contrato (sin poblarlo).
Resultado: `register({..., accountId, serverSlug})` → `list()/get()` los devuelven; sin esos campos, objeto byte-idéntico al de hoy.

## Lo que NO se hace en Fase 1 (diferido, con razón)
- **NO** poblar `accountId`/`serverSlug` en ningún flujo (no hay call-site; requiere el paso "register-after-provision" + el enabler) → **decisión + fase aparte**.
- **NO** crear el paso de registro-tras-provisión en el orquestador (comportamiento autónomo nuevo).
- **NO** reescribir `evaluateWebdockDrift` (#5) → **Fase 3**.
- **NO** cambiar `groupSenderNodes`/cluster-id (#6) → **Fase 2**.
- **NO** agregar prune/delete del registry → **Fase 3**.
- **NO** motor de selección/capacidad → **Fase 2**. **NO** tocar pasos 9-14 ni agregar Contabo/RackNerd/SMTPVPS.

## PROHIBIDO
- Hacer `accountId`/`serverSlug` required, o darles default no-`undefined` (NADA de `""`; ausente = `undefined`).
- Poblar los campos en cualquier flujo (es la fase diferida).
- Tocar `evaluateWebdockDrift`, `groupSenderNodes`, agregar prune, o el paso register-after-provision.
- Imprimir secretos / tocar `.env.local` / agregar proveedores nuevos.

## DoD (Codex)
1. Implementar la Parte A con subagentes (worker + auditor independiente).
2. **Tests nuevos** (`sender-node-registry.test.ts` y/o el test del runbook): (a) register con `accountId`+`serverSlug` → `list()`/`get()` los devuelven; (b) register **sin** esos campos → objeto byte-idéntico (snapshot de campos); (c) `WebdockInventoryServer` con `accountId` opcional no rompe `buildWebdockInventoryContract`/`summarize`; (d) **regression guard:** `evaluateWebdockDrift` y `groupSenderNodes` con nodos sin los campos → salida idéntica a baseline (prueba de que NO los tocaste).
3. **Suite verde:** `npm test`, `npm --workspace @delivrix/admin-panel run check`, `orchestrator-smtp.test.ts`, `sender-node-registry.test.ts`, `admin-cluster-overview.test.ts`, `openclaw-rules*.test.ts`. `tsc` 0. (`approval-token.test.ts` `/private/tmp` EACCES = artefacto sandbox, no regresión.)
4. **Backward-compat PROBADO:** cargar un `runtime/sender-nodes.json` existente (sin los campos) y verificar list/contract/drift/clusters idénticos.
5. Commit atómico: "Add optional accountId/serverSlug to SenderNode model + Webdock inventory contract (Fase 1 seam, no population)". Deploy: gateway restart + push `origin produ` (+ Hostinger si aplica).

## Reportá
SHA + EXIT de tests (suite + nuevos) + `tsc` + confirmación de: (a) campos OPCIONALES, sin población, backward-compat byte-idéntico con datos viejos; (b) que NO tocaste drift/clusters ni agregaste prune o register-after-provision; (c) que no se filtran/commitean secretos. Nota: la **población** queda explícitamente diferida (no había call-site).
