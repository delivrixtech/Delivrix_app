# BRIEF CODEX — Cables del Canvas v5: exponer el run real al artifact (backend)

Fecha: 2026-06-18 · Pide: Juanes (CTO) · Ejecuta: Codex · Coordinación: **arrancar DESPUÉS de mergear tu trabajo de IONOS** (evitar colisión). Frontend (componente `CanvasV5Preview.tsx` + renderers) ya está hecho por Claude, con datos de muestra. Esto destapa los datos vivos.

## Contexto
El nuevo Canvas (preview en `/canvas?canvasv5`) renderiza una "ficha de run" inmersiva: identidad (dominio/IP/host/DKIM/DNS/delivery) + timeline de 14 pasos con estado/duración. Hoy el frontend usa datos de muestra porque **el backend aplana el run antes de que llegue al canvas**. Hay que dejar de truncarlo. Auditado por subagente full-stack (archivo:línea abajo).

## Root cause (truncamiento)
`apps/gateway-api/src/routes/orchestrator-smtp.ts:1339` — `smtpRunStateToProgress` proyecta `SmtpRunState` a SOLO `{runId, status, lastCompletedStep, steps:[{step,skill,status}]}`. Todo lo rico (chosenDomain, smtpHost, serverIpv4, providerId, selector, **dkimPublicKey**, registros DNS, finalDeliveryStatus, budgetSpentUsd, durationMs/error por step) existe en `SmtpRunState` (definido `:391-437`, persistido en `inventory/smtp-runs/<runId>.json` `:1371`) y **se descarta acá**. Es el único cruce run→canvas.

## Cambios (mínimos; 1+2 son el 80% del valor, bajo riesgo, reusan el canal `progress[]` que ya fluye por snapshot+WSS — cero plumbing de transporte nuevo)

**1. Extender el contrato** — `packages/domain/src/canvas-live.ts:176-187` (+ mirror `apps/admin-panel/src/features/canvas/live-tool-types.ts:189-198`). Todo OPCIONAL (backward-compat):
```ts
interface CanvasLiveRunProgressStep { step; skill; status;
  label?: string; startedAt?: string; completedAt?: string; durationMs?: number; error?: string; }
interface CanvasLiveRunIdentity {           // NUEVO
  brand?; domain?; smtpHost?; serverSlug?; serverIpv4?; providerId?;
  dkimSelector?; dkimPublicKey?;            // DKIM PÚBLICO (es un TXT, no secreto)
  dnsRecords?: Array<{ name; type; value }>;
  finalDeliveryStatus?; finalEmailMessageId?; budgetSpentUsd?; }
interface CanvasLiveRunProgress { runId; status; lastCompletedStep; steps; identity?: CanvasLiveRunIdentity; }
```

**2. Poblar la proyección** — función `smtpRunStateToProgress` (`orchestrator-smtp.ts:1339`). **Fuentes EXACTAS verificadas 2026-06-18 (no asumir, ya chequeado contra el código):**
- `identity` desde campos top-level de `interface SmtpRunState` (`:391`): `domain = state.chosenDomain`, `smtpHost = state.smtpHost`, `serverSlug`, `serverIpv4`, `serverAccountId`, `providerId`, `dkimSelector = state.selector`, `finalDeliveryStatus`, `finalEmailMessageId`, `budgetSpentUsd`, `brand = state.params.brand`. Todos existen (es lectura, no recolección).
- **`dkimPublicKey` NO es campo de `SmtpRunState`** — vive en el `outcome` del step de provisioning. Leerlo con el helper EXISTENTE `stringFromOutcome(<provisionStep>.result?.outcome, ["dkimPublicKey"], "")` — patrón ya usado en `:936`. La clave **privada** queda separada (solo se expone `dkimPublicKeyHash`), `smtp-provisioning.ts:450`. Exponer SOLO la pública.
- per-step (`interface SmtpRunStepState` `:376`): `startedAt`/`completedAt` son campos directos; `durationMs` está en `result.durationMs` (`interface ConfigureCompleteSmtpStepResult` `:45`); `error` = `lastError`.
- **`dnsRecords`: NO hay array DNS persistido en el run** — DERIVARLO de los campos de identity: MX `${domain}` → `10 ${smtpHost}`, A `${smtpHost}` → `serverIpv4`, SPF `${domain}`, DKIM TXT `${selector}._domainkey.${domain}` (con la pública), DMARC `_dmarc.${domain}`. Es como ya se construyen inline en `:860`/`:952`.

**3. Redacción** — pasar `identity` por el sanitizador existente (`canvas-live-events.ts` allowlist `:820`). Validar que la clave **privada** DKIM nunca se exponga (solo la pública). No meter `inventory/` en allowlist de lectura web salvo necesidad.

**4. (Opcional, 2ª iteración) artifact `smtp_run` dedicado + extractor de chat huérfano:**
- Emitir `oc.artifact.declare`/`run_patch` desde el orquestador en `emitRunTask`/`emitStep` (`:566/:2412`, hoy hace `void metadata` en `:2430`) reusando `safeEmit` + `upsertArtifactSnapshot` (`canvas-live-events.ts:277`, ya cableado).
- Cablear `extractOpenClawArtifact` (construido, testeado, huérfano — `openclaw-chat.ts:958` solo en el bridge SSH muerto) al **bridge Bedrock de producción** en la rama de respuesta final (`openclaw-bedrock-bridge.ts:397-421`), ~30 líneas. Da artifacts de chat (no-SMTP) en producción.

## Frontend (lo hace Claude tras estos cambios)
`CanvasV5Preview.tsx` reemplaza los datos de muestra por el hook live (`useLiveCanvasStream` / `canvas-live-client.ts`), leyendo `progress.identity` + steps enriquecidos. El componente Files se cablea al API real `/v1/openclaw/workspace/tree|file` (ya existe, read-only, `openclaw-workspace.ts:102/165`).

## DoD
- `CanvasLiveRunProgress` lleva identity + step.durationMs/error; snapshots viejos siguen parseando (opcionales).
- En `/canvas?canvasv5`, un run real muestra dominio/IP/host/DKIM/DNS/delivery reales (no muestra).
- `npm --workspace @delivrix/gateway-api run build` + tests verdes. Sin exponer clave privada DKIM.

## Anclas y concurrencia (LEER)
- Todas las anclas fueron VERIFICADAS contra el código el 2026-06-18 (símbolos + líneas). Confirmado exacto: `smtpRunStateToProgress:1339` trunca a `{step,skill,status}`; `CanvasLiveRunProgress`/`...Step` `:182/:176` solo {runId,status,lastCompletedStep,steps}; `SmtpRunState:391`; `SmtpRunStepState:376`; `ConfigureCompleteSmtpStepResult:45` (tiene `outcome` y `durationMs`); `stringFromOutcome` usado en `:832/:833/:936/:1053`; `emitStep:2412` (`void metadata:2430`); `upsertArtifactSnapshot:277`; `extractOpenClawArtifact` orphan `openclaw-chat.ts:958` (bridge SSH); workspace `openclaw-workspace.ts:102/165`.
- **Ancla por NOMBRE de símbolo, no por línea.** Codex está editando estos MISMOS archivos (`orchestrator-smtp.ts`, `canvas-live.ts`) para IONOS en paralelo → los números de línea se van a correr. Buscá la función/interface por nombre.

## Coordinación (importante)
Claude tocó SOLO frontend: `apps/admin-panel/src/features/canvas/CanvasV5Preview.tsx` (nuevo) + 2 líneas en `apps/admin-panel/src/app/App.tsx` (lazy import + guard `?canvasv5`). NADA commiteado aún. Codex toca backend (`packages/domain`, `gateway-api`). No se pisan. Commitear por separado; **mergear tu IONOS primero**, después aplicar estos cambios sobre esa base.
