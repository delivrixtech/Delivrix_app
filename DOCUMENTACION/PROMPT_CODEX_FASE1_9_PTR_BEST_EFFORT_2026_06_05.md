# Codex — FASE 1.9: el PTR es BEST-EFFORT (nunca aborta ni rollbackea el bind del main domain)

> **Problema (run real controlcorpfiling.com, 2026-06-05):** `configure_complete_smtp` compró el dominio (✅ USD 15), creó el VPS (✅), bindeó el main domain (✅) y **abortó en el step 6 con `ptr_failed_rollback_failed`**. El PTR es un paso **best-effort** (afecta reputación de envío, NO la configuración del SMTP) y sin embargo una **excepción** del PTR **rollbackea un bind exitoso** y **aborta toda la corrida**. Esto contradice el diseño ya acordado: *"PTR no automatizable por Webdock API → manual, NO bloquea"*. **Regla CTO:** el PTR jamás puede tumbar una corrida ni revertir trabajo bueno.
> **Base:** `produ`/`main` `af1fe88` (working tree limpio salvo `.audit/*` + prompts). Rama `codex/fase1.9-ptr-best-effort`. **Usá subagentes + un Auditor adversarial.** Stop-and-report si algo choca con esto.

## Causa raíz (anclas verificadas, af1fe88)
1. `apps/gateway-api/src/routes/orchestrator-smtp.ts:~402` — el step 6 invoca `bind_webdock_main_domain` con `params: { serverSlug, domain: chosenDomain }` **sin** `setPtr`.
2. `apps/gateway-api/src/routes/webdock-bind-domain.ts:421` — el schema hace **default `setPtr = true`** (`input.setPtr === undefined ? true : …`) → el PTR **siempre se intenta**.
3. `apps/gateway-api/src/routes/webdock-bind-domain.ts:236-259` — al intentar `webdockAdapter.setServerPtr(...)`:
   - `ptr.supported && ptr.ok` → `ptrSet = true`. ✓
   - `!ptr.supported` → `ptrSkipReason = "not_supported_by_api"` (**skip suave, continúa**). ✓
   - **`supported && !ptr.ok`** (intentó, falló sin throw) → **NO setea skip reason, cae con `ptrSet=false` y sin marca**. ✗ (silencioso)
   - **`catch (error)`** (`:247`) → llama **`rollbackMainDomain(...)`** (`:339`) y devuelve **`json(502, ptr_failed_rolled_back | ptr_failed_rollback_failed)`** + `return` → **aborta el step y toda la corrida**. ✗✗ ← esto fue lo que pasó (el `setServerPtr` lanzó y el rollback además falló).

El bind del main domain **YA fue exitoso** (esa es la operación crítica). El PTR es un extra de reputación. Rollbackear el bind y matar el run por el PTR es backwards.

## Fix — PTR estrictamente best-effort (nunca aborta, nunca rollbackea)
En `webdock-bind-domain.ts`, dentro del bloque PTR (`else { try { … } catch { … } }`):

1. **`catch (error)` del PTR:** **eliminar** la llamada a `rollbackMainDomain` y el `json(502, …)` + `return`. En su lugar:
   - `ptrSet = false; ptrSkipReason = "set_failed";`
   - log **no-bloqueante**: `logger.warn("openclaw.webdock.ptr_set_failed_nonblocking", …, { serverSlug, domain, error: errorMessage(error) })`.
   - **NO** return: dejar que el flujo continúe al `json(...)` de éxito del bind al final.
2. **Caso `supported && !ptr.ok`** (hoy silencioso): setear explícito `ptrSkipReason = "set_failed";` (mismo trato que el throw).
3. **Tipo:** agregar `"set_failed"` al union `ptrSkipReason` (`webdock-bind-domain.ts:45`: `"not_supported_by_api" | "ipv4_missing" | "operator_opt_out" | "set_failed"`).
4. **Surface accionable (no blocker):** la respuesta de éxito del bind debe incluir, cuando `ptrSet === false`, un campo legible para que OpenClaw lo muestre como **follow-up informativo, NO como falla**, p.ej. `ptrManualHint: "PTR pendiente — setear reverse DNS de <ip> a smtp.<dominio> en el panel Webdock antes del warmup pesado."` (solo cuando `ptrSkipReason` es `set_failed` o `not_supported_by_api`).
5. **`rollbackMainDomain`** queda **solo** para fallos del **bind del main domain en sí** (lo crítico). El PTR nunca lo dispara.

> **Anti-cargo-cult:** no toques el adapter `setServerPtr` (que siga intentando — es señal gratis cuando funciona), ni la rama de éxito del bind, ni DNS/Postfix/DKIM, ni idempotencia, ni guardrails de plan. **Scope fence:** SOLO el manejo de fallo del PTR pasa a no-bloqueante.

## Tests (node:test, run real — no mocks de fachada)
- **PTR lanza excepción** → el bind **devuelve éxito** (`200`), `ptrSet:false`, `ptrSkipReason:"set_failed"`, **sin** `rollbackMainDomain`, **sin** 502; la corrida **avanza al step 7**. ← caso exacto que hoy falla.
- **PTR `supported && !ok`** → `ptrSet:false`, `ptrSkipReason:"set_failed"`, continúa (no más caída silenciosa).
- **PTR no soportado** (`!supported`) → `not_supported_by_api`, continúa. (no-regresión)
- **PTR ok** → `ptrSet:true`. (no-regresión)
- **`setPtr:false`** → `operator_opt_out`, continúa. (no-regresión)
- **Bind del main domain falla** (lo crítico) → **sí** sigue devolviendo `bind_failed` (no tragarse ESE error).
- **Idempotencia / resume:** re-correr `configure_complete_smtp` para `controlcorpfiling.com` (dominio owned + VPS existente + bound) **saltea 1-5**, en el step 6 hace **PTR soft-skip**, y **continúa 7-9**. Verificar que no recompra ni recrea (costo 0 en 1-5).
- proposals-sign / guardrails / Fase 1.5/1.6/1.7/1.8 intactos.

## Deploy
Código → **local** (restart gateway, Node 24) **Y** merge a **produ** + FF (regla CTO: nunca dejar el remoto congelado). **Sin cambio de system-prompt** → el system-context de Hostinger no se toca. Reportá SHA + los tests en verde.

## Hecho cuando
El PTR **jamás** aborta ni rollbackea: si falla (throw / supported-pero-falló / no soportado) la corrida **sigue** con `ptrSet:false` + skip reason claro + hint de PTR manual, y el SMTP se configura completo. Re-correr `controlcorpfiling.com` **retoma desde el step 6 y llega hasta el smoke** sin recomprar nada. Reportá SHA, los 7 tests, y un run real (el resume de controlcorpfiling.com o un dry equivalente) que pase el step 6 sin abortar.

---
### Nota fuera de scope (NO en Fase 1.9 — anotar para después)
El warmup (step ~12) idealmente debería **avisar/pausar si el PTR está sin setear** (Gmail/Outlook penalizan PTR↔A inconsistente). Eso es una mejora separada de reputación; **no** mezclar acá. Dejar registrado en bitácora/memoria.
