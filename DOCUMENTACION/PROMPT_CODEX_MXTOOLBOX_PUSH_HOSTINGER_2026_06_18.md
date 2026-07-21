# BRIEF CODEX — Push del system-context a Hostinger + restart (MXtoolbox no llegó al agente)

Fecha: 2026-06-18 · Ejecuta: Codex (en el host) · NO es cambio de código — es deploy.

## Qué pasa (diagnosticado con evidencia)

La integración MXtoolbox está commiteada (`363a79b`) y el `read_mxtoolbox_health` está en el código (tools-builder, handler, permission) y en el system-context **local** (`.audit/system-context.txt:213` + skill `mxtoolbox-health-check`). **PERO no llegó al agente:** al pedirle a OpenClaw el blacklist de un dominio, se fue a IONOS (no tiene la tool).

Causa: **el system-context nunca se pusheó a Hostinger desde el cambio de MXtoolbox.** Evidencia en `.audit/openclaw-kb.jsonl`: el último `oc.kb.capa1_built` (push a Hostinger) fue **2026-06-16, sourceCommit `4f4a8e8`** (el fix de Contabo). No hay push posterior. Por eso OpenClaw conoce Contabo (pusheado el 16) pero NO MXtoolbox. El build de MXtoolbox regeneró el archivo local pero corrió en local-only (o sin push).

## Tareas

1. **Push del system-context a Hostinger:**
   ```bash
   cd "/Users/juanescanar/Documents/delivrix app"
   bash scripts/openclaw/build-system-context.sh    # SIN OPENCLAW_CONTEXT_LOCAL_ONLY=true
   ```
   Esto regenera `system-context.txt` + `AGENTS.md` desde los docs (que ya tienen MXtoolbox) y los pushea al container Hostinger por SSH/docker cp.
   - **OJO BUDGET:** el script falla si `TOKEN_EST > 11800` o `AGENTS_CHARS > 11500`. Hoy estamos en **11787/11800** (13 de headroom). Si el build FALLA por el cap, **trimear** la sección nueva del prompt (compactar la entrada de MXtoolbox en `[12]`/tools y la skill) antes de pushear — y commitear ese ajuste de doc.

2. **Restart del gateway local:**
   ```bash
   bash scripts/delivrix-gateway-start.sh   # o restart; el canónico que ya usás
   ```
   Para asegurar que la tool nueva (`read_mxtoolbox_health`) esté en el set que el bridge Bedrock le pasa al LLM (la tool viene de `openclaw-tools-builder.ts`, que es código → entra con el restart). Deploy local **Y** Hostinger juntos.

## Verificación (DoD)

- Nueva línea `oc.kb.capa1_built` en `.audit/openclaw-kb.jsonl` con `sourceCommit` = `363a79b` (o el HEAD actual) y `occurredAt` de hoy → confirma que el push a Hostinger ocurrió.
- `/health` 200 tras el restart.
- **Prueba real:** pedirle a OpenClaw "revisá si `<dominio>` está en blacklist" → debe usar `read_mxtoolbox_health` y devolver el status MXtoolbox (clean/listed), **NO** irse a IONOS. (El panel local ya funciona — verificado: `annualrenewalnational.com` = clean, 8 passed.)

## Si después del push + restart OpenClaw SIGUE sin usar la tool

Entonces el problema es más profundo: hay que confirmar **qué gateway/tools usa el OpenClaw de Hostinger** — si el container relaya al gateway local (que ya tiene la tool) o corre su propio gateway/inferencia stale (que necesitaría el código deployado allá, no solo el prompt). Avisar y se investiga la topología antes de seguir.

## Notas
- No requiere commit nuevo salvo que haya que trimear el prompt por el budget.
- No tocar secretos/artefactos (`.audit/*`, `config/*.bak-*`).
