# Codex — FASE 0: cerrar contrato + permisos + rutas legacy (prerequisito de la autonomía)

> **Esta fase NO implementa la autonomía.** Abre la base para que la Fase 1 (`PROMPT_CODEX_PAQUETE_2026_06_04.md`) se construya sin chocar. **Hacé Fase 0, mergeá y verificá ANTES de Fase 1.**
> **Rama:** desde `produ`. Rama hija `codex/fase0-contrato`.
> **Subagentes senior** (Backend + AI Engineer + Full-Stack + QA + **Auditor de Errores**). Plan de subagentes antes de tocar. **Si choca con el código real → parar y reportar** (como hiciste; estuvo perfecto, por eso esta fase existe).
> Todo lo de abajo está **verificado por nosotros con anclas reales** — no son suposiciones.

## Por qué (lo que frenó la Fase 1, confirmado)
El contrato actual **prohíbe** la ejecución autónoma; bien que pararas. Anclas:
- **System prompt obliga supervisión por acción:** *"propones dry-runs y sólo ejecutas acciones supervisadas con ApprovalGate humano"* + *"Nunca ejecutas sin aprobación"* — `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md` bloques [1], [5] (paso 4), [8].
- **Permisos por acción:** las acciones SMTP son `supervised_local_state` = requieren `humanApproved=true` por acción (`apps/gateway-api/src/main.ts:740-762`). **No existe "firma de plan por runId".** Además hay IDs abstractos en `future_live_requires_new_phase` (BLOQUEADOS): `ssh_root_access`, `dns_live_change`, `postfix_apply_live_config`, `proxmox_live_create_vps` (`main.ts:763-773`).
- **Rutas legacy que ejecutan/aprueban FUERA del HMAC canónico** (solo header `X-Operator-Id`):
  - Backend: `main.ts:3391` `POST /v1/agent/proposals/{id}/approve`, `main.ts:3576` `POST /v1/agent/runbook/execute` (**¡ejecuta acción gateada sin HMAC!**), `main.ts:3765` `POST /v1/agent/runbook/revert`.
  - UI: `apps/admin-panel/src/features/canvas/index.tsx` → `approveProposal()` (:943), `executeRunbook()` (:965), `revertRunbook()` (:991).
  - Canónico (el único que debe sobrevivir): `apps/gateway-api/src/routes/proposals-sign.ts` (HMAC + nonce exactly-once + audit chain + kill-switch) vía `apps/admin-panel/src/v5/components/ApprovalGate.tsx`. El reject de `canvas-v4.tsx:1883` ya es canónico.
- **Chat-text NO ejecuta** (cosmético: `oc.chat.operator_message` decision `"n/a"`, `openclaw-chat.ts:1043-1066`) — no es un hueco.
- `read_dns_ionos` **no existe** (queda para Fase 1). **WORKTREE hardcodeado** a worktree viejo: `scripts/openclaw/build-system-context.sh:9`.

## Principio rector (no aflojar la seguridad, re-encuadrarla)
**Un solo camino canónico de autorización: HMAC + audit.** La "firma de plan" **NO** es una categoría sin gate — es una **firma HMAC real (la misma maquinaria de `proposals-sign.ts`) cuyo SCOPE es un `runId`** que cubre los pasos planificados. Cada paso conserva kill-switch fail-closed + token exactly-once + audit. Cambia la **granularidad** del consentimiento (1 firma por corrida en vez de 1 por paso), **no** el mecanismo. Y eliminamos los bypasses legacy para que ese sea el ÚNICO camino.

## Trabajo (Fase 0)

### 0.1 — Endurecer: matar/redirigir los bypasses legacy (seguridad, va sí o sí)
- Backend: `main.ts:3576` `/v1/agent/runbook/execute` ejecuta gateado autorizado SOLO por `X-Operator-Id` → **cerrarlo**: eliminar, o exigir firma canónica previa (approvalToken HMAC válido + audit). Igual `:3391 /approve` y `:3765 /revert`. Si hay consumidores, **deprecá + redirigí** al flujo canónico; eliminá solo si no rompe.
- UI: `features/canvas/index.tsx` `approveProposal`/`executeRunbook`/`revertRunbook` → quitar o redirigir a `ApprovalGate.tsx` (`/v1/openclaw/proposals/{id}/sign`).
- Resultado: la ÚNICA forma de autorizar ejecución = `proposals-sign.ts` (HMAC).

### 0.2 — Extender el contrato canónico a "autorización de plan por runId"
- Persistí una **autorización de plan** anclada al `runId` (reusar el `runId` del orquestador, `main.ts:401`), emitida por una **firma HMAC** vía la maquinaria de `proposals-sign.ts`. Scope explícito: `{ runId, domain, provider, budgetUsdMax, recipient }`.
- En el evaluador (`packages/domain/src/openclaw-runbook.ts` + matriz `main.ts`): una acción SMTP del lifecycle se autoriza si (a) hay firma de plan válida (HMAC, no expirada, scope coincide con la acción/run) **o** (b) firma por acción (compat). **Kill-switch SIEMPRE se chequea.** No crear categoría "sin gate humano"; el gate humano es la firma de plan.
- Gateá todo detrás de un flag nuevo `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE` **default OFF** (sin flag → flujo por-paso de hoy, intacto).
- **Reconciliar `future_live_requires_new_phase`:** verificá si la ejecución real de `provision_smtp_postfix`/DNS pisa los IDs abstractos bloqueados (`postfix_apply_live_config`, `dns_live_change`, `ssh_root_access`). Si sí → contradicción (la "nueva fase" ahora existe): resolvela explícitamente (reconciliar esos IDs con el nuevo contrato o documentar que son distintos de los tools reales). No dejar el conflicto silencioso.

### 0.3 — System prompt / AGENTS: nuevo contrato (esto es lo que te frenó)
- Reescribí el encuadre SRE *"propone dry-runs y sólo ejecuta supervisado / nunca ejecuta sin aprobación"* (`OPENCLAW_SYSTEM_PROMPT.md` [1]/[5]/[8]) por: **"propone el plan → solicita UNA firma de plan del operador → ejecuta la corrida planificada de forma autónoma mientras el kill-switch esté inactivo; aborta ante anomalía/budget/scope; audita cada paso."** Mantené las prohibiciones de credenciales y de bypass de kill-switch.
- **Clave:** este cambio sólo altera conducta cuando el flag 0.2 esté ON. Con flag OFF, el agente sigue como hoy → no rompés la conducta viva antes de que Fase 1 esté lista.

### 0.4 — WORKTREE fix
- `scripts/openclaw/build-system-context.sh:9`: reemplazá el default hardcodeado por resolución relativa al script (p.ej. `WORKTREE="${WORKTREE:-$(cd "$(dirname "$0")/../.." && pwd)}"`) o exigí `WORKTREE` explícito y fallá si falta. Que nunca deploye un worktree viejo por default.

### Tests (node:test, run real)
- Rutas legacy: ejecutan sólo con firma canónica (o devuelven deprecated); se elimina la ejecución por `X-Operator-Id` solo.
- Firma de plan (flag ON): autoriza N pasos del mismo `runId`; expira; scope mismatch rechaza; kill-switch armado corta.
- Flag OFF: comportamiento por-paso intacto (no-regresión).
- `proposals-sign.test.ts` + `proposals-reject.test.ts` verdes sin cambio de contrato; tests de matriz de permisos verdes.

## Deploy de Fase 0
- Mergeá y deployá **el endurecimiento** (rutas legacy cerradas + WORKTREE fix) — es seguridad pura.
- El cambio de system prompt se deploya a **local Y Hostinger** (regla de sync), PERO con `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE=OFF` → el agente vivo **no cambia de conducta** todavía (ni congelado ni prematuramente autónomo).
- Backup remoto + rollback + 1 firma del operador. Si el bridge Hostinger sigue HTML/login y bloquea el push → **parar y reportar**.

## Hecho cuando
Bypasses legacy cerrados (único camino = HMAC canónico) + contrato extendido a **firma-de-plan-por-runId detrás de flag OFF** + system prompt reescrito (sin cambiar conducta viva con flag OFF) + WORKTREE fix + tests verdes (incl. no-regresión flag OFF) + deploy del endurecimiento a local Y Hostinger + Defect Ledger. Reportá SHA. **Recién entonces** arrancamos Fase 1 (`PROMPT_CODEX_PAQUETE_2026_06_04.md`: enrutar a `configure_complete_smtp`, DKIM antes de provision, `read_dns_ionos`, tarjeta flotante) con el flag ON y **primero en dry-run**.
