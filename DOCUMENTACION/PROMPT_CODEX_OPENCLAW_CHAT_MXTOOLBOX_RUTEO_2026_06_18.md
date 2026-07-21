# BRIEF CODEX — OpenClaw rutea "dominio blacklist" a IONOS en vez de MXtoolbox (causa probada + fix)

Fecha: 2026-06-18 · Auditado en código por Claude (2 pasadas, adversarial) · Ejecuta: Codex con subagentes · Rama: `produ`.

## Problema
En el chat, ante "revisá si `<dominio>` está en blacklist", OpenClaw llama una tool de **IONOS** (`read_dns_ionos`, que devuelve mock) y NO usa `read_mxtoolbox_health`. El panel "Salud · Blacklist" sí funciona (verificado: annualrenewalnational.com = clean).

## CAUSA RAÍZ — PROBADA (no es topología, no es que falte la tool)
Auditoría descartó las hipótesis fáciles y dejó UNA causa, con evidencia:

1. **La superficie es el panel admin** (confirmado por Juanes) → el chat va al gateway LOCAL (`127.0.0.1:3000`) → bridge Bedrock. NO es Hostinger. (`chat-client.ts:125` relativo → `server.mjs:11/127` proxy a `127.0.0.1:3000`; `main.ts:406` `openClawChatBridge = openClawBedrockBridge ?? ...`.) **Redeploy de Hostinger DESCARTADO.**
2. **La tool SÍ le llega al modelo.** El bridge manda al modelo TODAS las tools con `enabled(env)===true`, sin filtro de permisos (`openclaw-bedrock-bridge.ts:359` `buildToolsForOpenClaw(this.env)` → `:384` payload). `read_mxtoolbox_health.enabled() = hmacConfigured(env) && MXTOOLBOX_API_KEY` (`openclaw-tools-builder.ts:434` + `:956`). Como **el panel de blacklist funciona** (mismo proceso, misma `process.env`, misma key), `enabled()` es true → la tool está en el catálogo que recibe Bedrock. **No es "no la tiene".**
3. **La tool ya está bien descrita** (`openclaw-tools-builder.ts:405-409`): "diagnosticar **blacklist** ... de una IP o **dominio** ... Usar antes de asumir reputación". → **NO tocar la descripción** (sería no-op).
4. **El sesgo está en el system prompt.** En `OPENCLAW_SYSTEM_PROMPT.md`:
   - `:242` lista `read_mxtoolbox_health -> blacklist/smtp/dns` (solo listada, sin ruteo).
   - `:241` y `:264` instruyen `read_dns_ionos` "sobre domain o zoneId" / "Invoca read_dns_ionos sobre domain" (procedimental, refuerza "dominio→IONOS").
   - **No existe regla de ruteo por intención** "blacklist/reputación → mxtoolbox". → Ante "**dominio** blacklist", el modelo sigue el sesgo "dominio→`read_dns_ionos`".

→ **Es tool-selection inducida por el prompt.** El lever correcto = **agregar una regla de ruteo explícita en el prompt.** No es código de tools, no es env, no es topología.

## CAMINO DEL FIX — gotcha operativo (importante)
El bridge lee como system prompt **`.audit/system-context.txt`** (primario, `openclaw-bedrock-bridge.ts:214/871`), NO el `.md` (solo fallback `:215/873`). Ese `.txt` lo **genera** `build-system-context.sh` leyendo `OPENCLAW_SYSTEM_PROMPT.md` (`:83 read_doc`). Por lo tanto:
- Editar el `.md` **no basta**: hay que **regenerar** `system-context.txt` con `build-system-context.sh`.
- Ese script **impone el cap** `TOKEN_EST ≤ 11800` (`:326`) y `AGENTS_CHARS ≤ 11500` (`:330`). Hoy estamos en **11787/11800** (~13 tokens de aire). Una regla de ruteo (~50-100 tokens) **excede el cap → el build FALLA** salvo que se **trimee** ~50-90 tokens en otra parte del prompt.
- El script por defecto también pushea a Hostinger; se puede correr **local-only** (`OPENCLAW_CONTEXT_LOCAL_ONLY=true`, `:336`) para actualizar solo el panel, o pushear a Hostinger también (consistencia del agente legacy).
- Tras regenerar, el bridge auto-recarga por mtime-cache (commit 3013fff); igual conviene **restart** del gateway para asegurar.

## FASE 1 — CONFIRMAR EN RUNTIME (subagente, read-only; cierra el 100%)
Antes de tocar nada, probar (no asumir):
1. `bridgeKind` de los mensajes reales del usuario en `runtime/logs/gateway-*.log` (`main.ts:1152/1186`) = `bedrock`. (Esperado, dado que es el panel.)
2. Que `read_mxtoolbox_health` está en el catálogo que el bridge manda a Bedrock. El bridge solo loguea `tools: tools.length` (`:368`), no los nombres → **loguear temporalmente los NOMBRES** (o evaluar `buildToolsForOpenClaw(<env runtime>).map(t=>t.name)`) y confirmar que incluye `read_mxtoolbox_health`. (Esperado true; el panel lo prueba.)
3. Capturar el `tool_use` del turno que se fue a IONOS → confirmar que la tool elegida fue `read_dns_ionos` (o cuál). Esto valida la causa antes del fix.

Si (2) diera que la tool NO está en el catálogo → la causa sería env (`MXTOOLBOX_API_KEY` ausente en el env del gateway) y el fix sería ese, no el prompt. (Improbable por el panel, pero hay que descartarlo, no asumirlo.)

## FASE 2 — FIX (prompt routing; todo local)
1. En `OPENCLAW_SYSTEM_PROMPT.md`, agregar una **regla de ruteo por intención** explícita y corta, en la sección de tools/flow (cerca de `:242`/`:264`):
   > Blacklist / reputación / "¿está listado?" / "¿se quemó?" / "revisá el dominio/IP" → SIEMPRE `read_mxtoolbox_health` (cubre IP **y dominio**). NUNCA uses `read_dns_ionos` ni `read_route53_*` para reputación: esos son DNS, no blacklist.
2. **Trimear ~50-90 tokens** en otra parte del prompt para no romper el cap 11800 (estamos 11787). Elegir algo redundante (no tocar gates de [10]/[13] ni naming).
3. **NO** editar descripciones de tools (mxtoolbox ya cubre dominio; `read_dns_ionos` es load-bearing del flujo DNS — re-scopearla es riesgoso).
4. Si la regla cae dentro del §4 embebido del AGENTS bootstrap (`build-system-context.sh:133-135`), sincronizar esa copia también (dual-source). Si no, solo el `.md`.
5. Regenerar: `bash scripts/openclaw/build-system-context.sh` (local-only para el panel, o con push a Hostinger). Verificar que el build pasa el cap.
6. **Restart** del gateway.

## FASE 3 — VERIFICACIÓN (DoD; sin adivinar)
- El build de `system-context.txt` pasa (TOKEN_EST ≤ 11800) y el bridge lo recarga.
- **Prueba real en el PANEL**, 3+ dominios y frases variadas ("¿está en blacklist X?", "¿este dominio está quemado?", "chequeá reputación de la IP Y") → invoca `read_mxtoolbox_health`, devuelve status MXtoolbox, **NUNCA** `read_dns_ionos`. Repetir para confirmar robustez, no suerte.
- `bridgeKind=bedrock` en el log de esos turnos.

## CAVEAT HONESTO (para alinear expectativas)
La selección de tool de un LLM es **probabilística**: una regla de ruteo explícita la vuelve **confiable** (y acá el lever es directo, porque el sesgo es literalmente una instrucción del prompt), pero **no garantiza 100% determinista** que jamás vuelva a elegir IONOS. Por eso la verificación es multi-frase. Si el CTO quiere **garantía dura**, se agrega un **guard de código** (p.ej. que `read_dns_ionos` rechace/redirija intención de reputación, o que el gateway prefiera mxtoolbox ante intención "blacklist") — es más trabajo y cambia un poco el modelo agéntico. Decisión de Juanes.

## Subagentes (como pidió el CTO)
(1) Diagnóstico runtime (logs `bridgeKind` + nombres de tools en el catálogo + `tool_use` del turno IONOS) — read-only. (2) Edición del prompt (regla de ruteo + trim del cap) + rebuild + restart. (3) Verificación multi-frase en el panel. Cambios mínimos, sin tocar secretos/artefactos (`.audit/*`, `config/*.bak-*`). **No redeploy de Hostinger.**
