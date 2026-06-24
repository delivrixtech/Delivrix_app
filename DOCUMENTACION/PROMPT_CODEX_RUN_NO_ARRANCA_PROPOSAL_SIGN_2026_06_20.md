# BRIEF CODEX (OPCIONAL / POSTERIOR) — Endurecer el prompt para que el agente INVOQUE la tool en vez de escribir prosa

Fecha: 2026-06-20 · Auditado por Claude (2 subagentes + verificación en vivo en Chrome) · Ejecuta: **Codex con subagentes**.

> **IMPORTANTE — leer antes de tocar nada:**
> Esta es la ÚNICA pieza de backend que queda, y es **secundaria y opcional**. El desbloqueo real del run (la UI de firma en el preview v5) lo hace Claude en frontend, **sin cambios de backend ni de contrato** (reusa `ApprovalGate` + el endpoint `/v1/openclaw/proposals` que ya existen y están allowlisted). **NO ejecutes este brief hasta que Claude confirme que la UI de firma (Fase C, frontend) ya está desplegada y verificada, y que el agente AÚN tira prosa en vez de invocar la tool.** Si después de la Fase C el agente ya crea propuestas firmables de forma consistente, este brief **no hace falta**.
>
> **Descartado del brief original:** "Fase B" (agregar `proposalId` al contrato del artifact de canvas en `packages/domain`) — **NO se hace.** Es innecesaria y riesgosa: el `proposalId` ya sale de `GET /v1/openclaw/proposals`. No toques `packages/domain/src/canvas-live.ts` ni el contrato del stream.

## Síntoma
El agente, al pedirle configurar un SMTP con dominio+seeds, **a veces** escribe el plan en prosa (texto final) en vez de emitir el **tool_use** `configure_complete_smtp`. La prosa genera artifacts `kind:'plan'/'proposal'` SIN `proposalId` (no firmables) → ruido (337 pending observados, todos `proposalId: null`). El agente SÍ sabe invocar la tool (creó 1 propuesta real, `ad176bcd`), pero es inconsistente.

## Causa (verificada)
- Todo tool_use mutante se convierte en proposal y bloquea esperando firma: `tool-use-processor.ts:302-349` (`submitProposalFromToolUse` → `/v1/agent/proposals` → `waitForProposalDecision`, timeout 3h `:1043-1046`). El run nace solo si `decision.status === "executed"`.
- La firma dispara el run: `POST /v1/openclaw/proposals/:id/sign` → `handleProposalSign` (`proposals-sign.ts:120,393`) → `dispatcher.dispatch({ skill:"configure_complete_smtp" })` (`:447`). **Este cableado ya funciona.**
- Cuando el agente escribe prosa en vez del tool_use, el bridge emite `emitProseArtifactFromFinalResponse` → artifact `plan`/`proposal` sin `proposalId` (`openclaw-bedrock-bridge.ts:710-728`). No firmable.
- El system-context enmarca todo como "proponer" (`scripts/openclaw/build-system-context.sh:248,254,263,279`) y **no ordena explícitamente invocar `configure_complete_smtp` como tool_use** tras tener dominio+seeds+plan. Flags ON: `OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE`, `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE`, `OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL` (`config/gateway.env:87,89,67`).

## FASE A — Único cambio: instrucción explícita en el system-context
**Objetivo:** que con dominio confirmado + seeds + plan, el agente emita el **tool_use** `configure_complete_smtp` (que crea la propuesta firmable), no prosa.
- En `scripts/openclaw/build-system-context.sh`, agregar una instrucción corta y dura, p.ej.: *"Cuando ya tengas el dominio confirmado, los seed inboxes y el plan claro, INVOCÁ la tool `configure_complete_smtp` (tool_use). Proponer = invocar la tool, NO escribir el plan en prosa. La tool crea la propuesta que el operador firma desde el panel; describirla en texto no arranca nada."*
- Cuidar el budget de tokens (cap 11.800). Es una instrucción corta y de alto valor.
- NO cambiar la lógica de subtools, ni el gate de firma, ni el contrato. Solo el texto del prompt.
- DoD: con dominio+seeds, el agente emite el tool_use → aparece un proposal en `GET /v1/openclaw/proposals` con `status: pending`. No se rompe el flujo de charla/prosa (cuando NO hay intención de ejecutar, sigue conversando normal). `node --test` gateway verde. Sin exponer secretos.

## Anclas
- `apps/gateway-api/src/tool-use-processor.ts:302-349,1043-1046`
- `apps/gateway-api/src/proposals-sign.ts:120,393,447`
- `apps/gateway-api/src/openclaw-bedrock-bridge.ts:710-728`
- `scripts/openclaw/build-system-context.sh:248,254,263,279`
- `config/gateway.env:67,87,89`
