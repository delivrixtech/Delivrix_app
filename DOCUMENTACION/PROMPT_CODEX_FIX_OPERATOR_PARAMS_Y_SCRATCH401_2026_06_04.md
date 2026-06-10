# Codex — 2 fixes de chat/grounding + deploy local

> Rama: partí de `produ` (`f1a8daf`, el deployado vivo). Trabajá en rama hija `codex/fix-chat-params-scratch401`.
> Orquestación: **Full-Stack Senior (frontend+chat) + Backend Senior (token+parse) + DevOps Senior (deploy) + Auditor de Errores** (ledger, run real, bloquea regresión). Reportá plan de subagentes antes de tocar código.
> Deploy de esto es **local** (gateway + panel), **NO toca Hostinger** (no cambia el system prompt). Igual: backup/rollback + 1 firma del operador antes de reiniciar.

## FIX 1 — El bloque `<openclaw_operator_params>` se filtra como texto crudo
**Síntoma:** cada mensaje del operador aparece en la burbuja del chat con el wrapper literal `<openclaw_operator_params> mode: chat skill_hint: auto execution_scope: read_only ... </openclaw_operator_params> <mensaje real>`, y ese texto **también le llega al agente** como parte del prompt (ruido de contexto).
**Causa verificada:** el **frontend** lo arma inline — `apps/admin-panel/src/features/canvas/canvas-v4.tsx:1609-1615` concatena el wrapper al cuerpo del mensaje. Nadie lo parsea/quita después (grep: solo aparece donde se crea).

**Antes de tocar — verificá:** ¿los params (`mode`, `execution_scope`, `time_budget_minutes`, `approval_contract`) se **consumen** en algún lado del gateway (afectan comportamiento), o son **cosméticos**? Eso decide si hay que preservarlos como metadata estructurada o solo limpiarlos.

**Fix:**
1. **Frontend:** dejar de embeber el wrapper en el **cuerpo visible/enviado**. Enviar el mensaje **limpio** + los params como **campo estructurado** (metadata del request), no como texto. En la burbuja, renderizar solo el mensaje real (los params ya se muestran como chip abajo: "consulta · skill auto · read-only · 30m").
2. **Backend (defensivo, client-agnostic):** en la ingestión del mensaje del operador (localizá el handler de `oc.chat.operator_message` / chat send), **parsear y quitar** cualquier bloque `<openclaw_operator_params>…</openclaw_operator_params>` del cuerpo ANTES de mostrarlo/auditarlo/mandarlo al agente; extraer los params como metadata. Así, aunque un cliente viejo lo mande inline, el agente y la UI ven solo el texto limpio.
3. Si los params son funcionales, cablear el campo estructurado a donde se consumen (no perder la función).

**Test:** un mensaje con el wrapper (inline y estructurado) → el cuerpo que llega al agente y a la UI NO contiene `<openclaw_operator_params>`; los params quedan como metadata.

## FIX 2 — `read_episodic_scratch` devuelve 401
**Causa verificada:** el `fetchLiveContext` del bridge SÍ manda el token al leer scratch (`openclaw-bedrock-bridge.ts:612-613`, header `x-delivrix-token`), por eso el grounding del contexto funciona. Pero cuando el agente invoca la **tool** `read_episodic_scratch`, la llamada sale por `tool-use-processor.ts` **sin** ese header → `/v1/openclaw/scratch` (fail-closed, I3) responde **401**.

**Fix:** en `apps/gateway-api/src/tool-use-processor.ts`, al despachar `read_episodic_scratch` (y cualquier read tool contra el read-boundary), **incluir el header `x-delivrix-token: <readBoundaryToken>`** (ya existe `readBoundaryToken` en el processor, línea 122; usar el mismo fallback `DELIVRIX_READ_BOUNDARY_TOKEN ?? DELIVRIX_OPENCLAW_TOKEN`). Espejar exactamente lo que hace el bridge en :612-613.

**Test:** `read_episodic_scratch` invocada por el agente devuelve **200 con datos** (no 401); sin token configurado sigue fail-closed (no aflojar I3).

## FIX 3 — Route53 read tools devuelven HTTP 503
**Síntoma (visto en vivo):** `read_route53_domain_detail` y `read_route53_zone_records` → **HTTP 503**. El agente correctamente reportó "no pude leer el DNS" en vez de inventar — pero hay que destrabarlo.
**Causa verificada:** `apps/gateway-api/src/routes/sensitive-read-auth.ts:23` devuelve `503 read_boundary_token_unconfigured` cuando el **gateway vivo no tiene configurado** el read-boundary token; además `route53-domain-detail.ts` requiere credenciales AWS (`AWS_ROUTE53_DOMAINS_ACCESS_KEY_ID`/`SECRET`/`REGION`) del env.
**Fix (diagnóstico → acción):**
1. Determinar cuál es: ¿falta `DELIVRIX_READ_BOUNDARY_TOKEN`/`DELIVRIX_OPENCLAW_TOKEN` en el `.env.local` del gateway vivo (→ 503 unconfigured), o faltan las credenciales AWS Route53?
2. Si es **env/config** (lo más probable): agregar las vars faltantes al `.env.local` del gateway y reiniciar (acción de operador, documentar exactamente cuáles). NO hardcodear secretos en código ni en el repo.
3. Si hay un **bug** (token configurado pero igual 503): corregir el wiring.
**Test/smoke:** tras el fix, `read_route53_domain_detail(controldelivrix.app)` y `read_route53_zone_records` devuelven 200 (o un error real de Route53, no 503 de auth).

## DEPLOY (local, disciplinado)
1. Tras tests verdes (run real, Node ≥24): **fast-forward `produ`** a la nueva punta (avance lineal).
2. **Backup**: anotá el PID/commit del gateway vivo actual (69082 / f1a8daf) para rollback.
3. **Reiniciar el gateway** desde el **repo canónico** (`~/Documents/delivrix app` en `produ`), shutdown graceful (patrón `delivrix-gateway-start.sh`, NO `kill -9`), Node 24. **NO desde `/tmp`.**
4. **Rebuild/restart del admin panel** desde el repo canónico (el fix 1 es frontend).
5. **Smoke (criterio de éxito):**
   - Enviar un mensaje en el chat → la burbuja y el prompt del agente **NO** muestran el wrapper `<openclaw_operator_params>`; solo el mensaje limpio.
   - El agente invoca `read_episodic_scratch` → **200 con datos**, no 401.
   - Sin regresión: el grounding sigue (37.842Z bloqueado, abstención correcta).
6. Si falla → rollback (gateway al PID/commit previo). Reportá SHA, resultado del smoke, y si los params resultaron funcionales o cosméticos.

## Reglas
- No tocar Hostinger (no hay cambio de system prompt). No push a origin sin confirmar. Audit de cada paso. Pausá y reportá ante lo inesperado.
