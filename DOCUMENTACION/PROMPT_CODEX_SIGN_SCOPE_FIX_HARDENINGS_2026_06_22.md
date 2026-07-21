# BRIEF CODEX — Fix de scope de firma (provider ?? vpsProviderId) + 2 hardenings

Fecha: 2026-06-22 · Diagnosticado en vivo (run v10/v11 fallaba el sign 422; v12 completó E2E con el fix) + 3 subagentes · Ejecuta: **Codex** · Base: **`produ`** · Despues: **merge a `produ`**

## Contexto: el run v12 completó el primer SMTP Contabo+IONOS E2E (correo a inbox)
El último blocker fue el **sign 422 `plan_scope_missing`**. El validador de scope de la firma exige el campo legacy `params.provider`, pero el agente Bedrock manda `vpsProviderId` (canal multi-provider). Es no-determinista: v9 incluyó `provider` y firmó; v10/v11 mandaron solo `vpsProviderId` → 422 en cada firma. El fix YA está aplicado en el working tree local y desbloqueó v12, pero **falta formalizarlo en `produ`** (si se reinicia desde produ limpio, vuelve el 422).

## Fix 1 (EL bloqueante) — scope de firma acepta `vpsProviderId`
`apps/gateway-api/src/routes/proposals-sign.ts:672`, dentro de `extractConfigureCompleteSmtpPlanScope`:
```ts
// ANTES
const provider = normalizedScopeString(params.provider)?.toLowerCase();
// DESPUES
const provider = normalizedScopeString(params.provider ?? params.vpsProviderId)?.toLowerCase();
```
Y el mensaje de error (`:681`): `"params.provider or params.vpsProviderId is required."`

**Hash-invariante (verificado por subagente):** el `scopeHash` es `sha256(stableStringify(scope))` y `scope.provider` es una clave fija (`:699` `provider: provider!`). Cuando `provider` viene explícito (Webdock/v9), el `??` lo prioriza → mismo valor → **mismo hash byte-idéntico**. Cuando solo viene `vpsProviderId` (v10+/Contabo), antes fallaba 422 (no había hash previo que romper). Cero regresión. Ambos pasan por el mismo `normalizedScopeString(...).toLowerCase()`.

Tests: agregar caso en `proposals-sign.test.ts` — propuesta con `vpsProviderId:"contabo"` sin `provider` debe firmar OK (no 422); propuesta con `provider:"webdock"` explícito sigue igual.

## Fix 2 (hardening) — ErrorBoundary propio para el panel de firma
Hoy `<PendingOpenClawApprovalPanel>` (el botón "Firmar y ejecutar") se renderiza INLINE dentro de `CanvasV5Preview` (`apps/admin-panel/src/features/canvas/CanvasV5Preview.tsx:~646`), que está bajo `<PanelErrorBoundary>` (`apps/admin-panel/src/app/App.tsx:~249`). Si `CanvasV5Preview` tira cualquier `ReferenceError` en render (p.ej. un icono lucide sin importar), el ErrorBoundary reemplaza TODO el subtree → **el operador pierde el botón de firma**. (Pasó en vivo con un `Layers is not defined` de un bundle viejo.)

Fix: envolver `<PendingOpenClawApprovalPanel>` en su PROPIO `ErrorBoundary` (o moverlo fuera del subtree de `CanvasV5Preview`), para que un crash del Canvas NO se lleve la capacidad de firmar. La firma es la acción crítica del operador; no puede depender del render del preview.

## Fix 3 (hardening) — `/scratch` degrada 503 -> 200-vacío con Postgres caído
`apps/gateway-api/src/routes/episodic-scratch.ts:~101-104`: con Postgres down, `retrieveGroundedDecisionMemory` lanza ECONNREFUSED y el catch devuelve `503 {error:"episodic_scratch_unavailable"}`. El agente lo reporta como "Memoria episódica en 503" en cada turno.

Fix: en ese catch, detectar error de CONEXIÓN (ECONNREFUSED / ENOTFOUND / pool no disponible) y degradar a `200 {entries:[], grounded:[]}` (vacío), en vez de 503. Distinguir de un error de DATOS (query mal formada, tabla faltante), que sí debe seguir siendo error. La señal de "infra de memoria caída" no se pierde: `/health` ya reporta `postgres: down`.

## DoD
- El sign de `configure_complete_smtp` acepta una propuesta con `vpsProviderId` y sin `provider` (no 422). Webdock byte-idéntico (provider explícito gana).
- Un crash de `CanvasV5Preview` NO elimina el botón de firma (ErrorBoundary propio).
- `/v1/openclaw/scratch` con Postgres caído devuelve 200-vacío, no 503.
- `npm test` verde. Sin tocar hashInput/scope firmado de runs existentes. Sin exponer secretos.
- Merge a `produ`.

## Anclas
- `apps/gateway-api/src/routes/proposals-sign.ts:672` (fix), `:681` (mensaje), `:699` (scope.provider), `:720-721` (hash).
- `apps/gateway-api/src/openclaw-tools-builder.ts:810,823` (provider opcional, "no rutea VPS"); `skill-schemas.ts:430,436` (provider/vpsProviderId condicionales).
- `apps/admin-panel/src/app/App.tsx:~249` (PanelErrorBoundary), `apps/admin-panel/src/features/canvas/CanvasV5Preview.tsx:~646` (panel inline), `apps/admin-panel/src/v5/components/ApprovalGate.tsx:~370` (botón).
- `apps/gateway-api/src/routes/episodic-scratch.ts:~101-104` (catch 503).
