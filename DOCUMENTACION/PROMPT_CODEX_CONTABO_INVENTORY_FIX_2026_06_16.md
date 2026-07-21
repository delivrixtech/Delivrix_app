# BRIEF CODEX — Fix "OpenClaw no lista Contabo" (CORREGIDO tras auditoría)

Fecha: 2026-06-16 · Solicita: Juanes (CTO) · Ejecuta: Codex
Rama base verificada: `produ` HEAD `4f4a8e8`

> NOTA: este brief reemplaza una versión previa que atribuía el síntoma al inventario de infraestructura. La auditoría demostró que esa premisa era incorrecta. La causa real es el **cache del system prompt**. El cambio de inventario es secundario.

---

## 1. Causa raíz (auditada, alta confianza)

El síntoma ("OpenClaw lista 7 proveedores, Webdock 3 cuentas, sin Contabo") es **prompt viejo servido desde cache**, no el inventario.

Cadena de evidencia (verificada en código):
- La respuesta de OpenClaw fue una tabla con prosa razonada -> es **generada por el LLM** vía el bridge de Bedrock, no una respuesta canned.
- El único origen de un "roster de proveedores" para el LLM es el **system prompt `[11]`**. El `live_context` del bridge NO inyecta roster: solo `inventory_domains`, `inventory_servers`, `verified_facts`, `overview`, `kill_switch`, `canvas`, `audit` (verificado en `openclaw-bedrock-bridge.ts`, construcción del `live_context`).
- El bridge de Bedrock importa de `openclaw-chat.ts` **solo tipos** (`import type {...}`), así que el roster hardcodeado de `openclaw-chat.ts` (~L2006, "Webdock x 3 cuentas", sin Contabo) **no se ejecuta** en el path Bedrock.
- El texto que recitó OpenClaw ("Webdock (3 cuentas) -- VPS + SMTP servers", "DNS write supervisado", "Proxmox legacy") es **literal del `[11]` VIEJO**. El `[11]` nuevo (commit `4f4a8e8`) dice "5 cuentas" + Contabo.
- `openclaw-bedrock-bridge.ts::loadSystemPrompt` (línea ~863) hace `if (this.cachedSystemPrompt) return ...` -> **lee una vez y cachea, sin recarga**. El gateway no se reinició tras la regeneración del prompt, así que sigue sirviendo el `[11]` viejo.

Conclusión: el archivo en disco (`.audit/system-context.txt`) ya tiene Contabo + 5 cuentas; lo que falta es que el proceso lo recargue. **El fix es reiniciar el gateway.**

## 2. Entregables

### T1 (PRIMARIO — el fix real) — restart del gateway
```
bash scripts/gateway-restart.sh
```
Reinicia el gateway local (el que corre el bridge de Bedrock). Suelta el cache del system prompt y carga el `.audit/system-context.txt` nuevo (Contabo + 5 cuentas).

Pre-check (IMPORTANTE para no fallar): confirmar DESDE QUÉ directorio corre el gateway. `loadSystemPrompt` lee `.audit/system-context.txt` relativo al `process.cwd()` del gateway. Existe un worktree `.claude/worktrees/mc-webdock/` cuyo `.audit`/`OPENCLAW_SYSTEM_PROMPT.md` AÚN dicen "3 cuentas" sin Contabo. Si el gateway arranca desde ese worktree, el restart NO arregla nada -> hay que arrancarlo desde el checkout `produ` (cuyo `.audit/system-context.txt` ya tiene Contabo + 5 cuentas, verificado). Verificar: `grep -c "5 cuentas\|Contabo" <cwd-del-gateway>/.audit/system-context.txt` debe dar >= 2 antes de reiniciar. Si falta, regenerar con `OPENCLAW_CONTEXT_LOCAL_ONLY=true bash scripts/openclaw/build-system-context.sh` desde el cwd correcto.

### T2 (SECUNDARIO — landmines stale, consistencia) — código
Dos copias del roster siguen desactualizadas (no causaron el síntoma, pero muerden después):
- `apps/gateway-api/src/openclaw-chat.ts` (~L2006): respuesta canned "Webdock x 3 cuentas", sin Contabo. Actualizar a 5 cuentas + añadir Contabo. (La usa el path no-Bedrock; mantenerla coherente.)
- `apps/admin-panel/src/app/sections.ts`: header de UI con "3 cuentas". Actualizar el conteo y, si aplica, mencionar Contabo.

### T3 (OPCIONAL / futuro) — buildContaboProvider en el inventario
`apps/gateway-api/src/routes/infrastructure.ts` no tiene `buildContaboProvider`. Esto NO es la causa del síntoma actual (el inventario alimenta servers/domains como items, no el roster). Solo hace falta cuando Contabo tenga servers reales o si se quiere una vista de inventario con Contabo como provider de 0 instancias. Diferir hasta el E2E salvo que se quiera la consistencia ahora (template: `buildPhysicalServerProvider`; detección de creds: `createContaboAdaptersFromEnv(env).length > 0`).

## 3. Anclas verificadas (2026-06-16, `produ`)
- Cache del prompt: `apps/gateway-api/src/openclaw-bedrock-bridge.ts::loadSystemPrompt` (read-once, sin recarga).
- `live_context` sin roster: mismo archivo, construcción del bloque `<live_context>` (secciones listadas arriba).
- Import solo-tipos: `openclaw-bedrock-bridge.ts` líneas ~16-21 (`import type {...} from "./openclaw-chat.ts"`).
- Roster canned stale: `openclaw-chat.ts` ~L1996-2010.
- Roster del prompt: `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md` `[11]` (ya con Contabo + 5 cuentas) y `.audit/system-context.txt` regenerado.
- Restart: `scripts/gateway-restart.sh`.

## 4. Definition of Done
- Tras `gateway-restart.sh`, el gateway responde `/health` OK.
- **Prueba de aceptación con OpenClaw (re-preguntar):**
  - "¿Cuántos proveedores tenemos?" -> incluye Contabo y dice 5 cuentas Webdock (no 3).
  - "¿Contabo está conectado?" -> sí, proveedor canónico.
  - Sigue reportando 0 servidores Contabo vivos (correcto).
- (T2) Las dos copias stale ya no dicen "3 cuentas" ni omiten Contabo.

## 5. Fuera de alcance
- NO E2E real (compra de VPS Contabo).
- NO escribir en grounded/verified_facts a mano.
- T3 (buildContaboProvider) NO es requisito del fix; diferible.

## 6. Confianza / verificación final
Las afirmaciones de código son ciertas (cache read-once; live_context sin roster; import solo-tipos; texto recitado = [11] viejo). El único 100% empírico es **reiniciar y re-preguntar** (o curl al gateway vivo para ver el prompt servido) — eso lo cierra del todo. Es un paso barato y reversible.
