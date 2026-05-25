# OPS para Codex — Bloque 2: cerrar pendientes + desbloquear OpenClaw chat real

**Fecha:** 2026-05-24
**Ejecutor:** Codex (backend + container ops)
**Owner humano:** Juanes
**Contexto:** El Canvas v4 está demo-ready en frontend (chat WSS conectado, audit feed real, topología n8n con iconos). **Bloqueante crítico para el demo**: el chat manda mensajes (`POST /v1/openclaw/chat/send` responde 200) pero el agente OpenClaw NO responde — el ThinkingChip se queda perpetuamente en "Enviando". Hay que verificar/arreglar el container Hostinger.

Orden recomendado: T1 (urgente) → T2 → T3.

---

## Tarea 1 — VERIFICAR + DESBLOQUEAR chat real con OpenClaw container Hostinger

**Por qué es urgente:** sin esto, la demo MVP es solo un panel bonito. El operador escribe → nada vuelve.

**Pasos:**

1. **Estado del container** (sin SSH, usar canal alterno si la llave sigue faltando):
   ```bash
   # Desde fuera del container
   curl -sS -o /tmp/openclaw_root.html -w "HTTP %{http_code} - %{time_total}s\n" http://2.24.223.240:61175/
   curl -sS http://2.24.223.240:61175/health 2>&1 | head
   curl -sS -X POST http://2.24.223.240:61175/api/chat.send \
     -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"sessionKey":"agent:main:operator","msgId":"diag-001","message":{"role":"user","content":"diag ping"}}'
   ```
   Esperar JSON `{ msgId, queued: true }`. Si devuelve HTML login o 401, el token no se cargó (regenerar + push).

2. **Si SSH key está accesible** (`~/.ssh/openclaw-hostinger`):
   ```bash
   ssh -i ~/.ssh/openclaw-hostinger root@2.24.223.240 'docker ps | grep openclaw; docker logs --tail 200 openclaw 2>&1 | head -40'
   ```
   Ver últimos 200 lines del log. Filtrar errores de Bedrock, AWS auth, chat handler.

3. **Si SSH NO accesible**, alternativa via web console Hostinger hPanel → File Manager → editar `/etc/openclaw/.env` para confirmar:
   - `BEDROCK_REGION=us-east-1`
   - `BEDROCK_MODEL_ID=claude-sonnet-4-6` (correcto según memoria `delivrix_openclaw_bedrock`)
   - `AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY` no expirados
   - `OPENCLAW_GATEWAY_TOKEN` igual al de `.env.local` del host

4. **Probar end-to-end** con curl arriba. Si devuelve `{ queued: true }` pero WSS chat.stream nunca emite `ASSISTANT_DELTA`, el agente acepta el mensaje pero el handler chat→Bedrock está roto. Investigar `services/openclaw/handlers/chat.ts` (o equivalente) en el container.

5. **Reportar uno de estos 3 estados al cerrar**:
   - **VERDE**: end-to-end OK, mensaje del operador desde panel produce `ASSISTANT_DONE` y aparece en chat.
   - **AMARILLO**: chat.send acepta pero stream no emite — bug específico del handler Bedrock. Plan dry-run.
   - **ROJO**: container down o Bedrock auth expirada — restart + rotar credenciales.

**Output esperado:** commit + doc con el estado verde/amarillo/rojo + steps para reproducir.

---

## Tarea 2 — Cerrar fix detector C2 canonical substrings (#10 OPS original Tarea 7)

**Por qué:** El smoke C2 reformulado del Hito 5.11.B marcó "read_only" y "dry_run" como hallucinations porque son substrings de canonicals `allowed_read_only` y `allowed_dry_run`. Falsos positivos que rompen scoring.

**Pasos:**

1. Localizar detector — `grep -rn "hallucination\|c2_eval\|canonical" apps/gateway-api/src/openclaw/eval/` o similar path.
2. Antes de comparar token vs lista canónica, hacer matching con boundaries:
   ```ts
   const isCanonicalSubstring = canonicalList.some(c => c.includes(token));
   if (isCanonicalSubstring) return null; // no hallucination
   ```
3. Test:
   ```ts
   it("does not flag canonical substrings", () => {
     expect(detect("read_only", { canonical: ["allowed_read_only"] })).toBeNull();
     expect(detect("dry_run", { canonical: ["allowed_dry_run"] })).toBeNull();
     expect(detect("invented_action", { canonical: ["allowed_read_only"] })).toEqual(
       expect.objectContaining({ type: "hallucination" })
     );
   });
   ```
4. Commit con prefix `fix(gateway): C2 detector ignores canonical substrings`.

---

## Tarea 3 — Confirmar fix #21 webdock inventory audit pollution sigue en main

**Por qué:** En el screenshot del operador del 2026-05-24 vi audit events `oc.audit.smoke_valid` cada poll, hay sospecha de regresión.

**Pasos:**

1. `git log --oneline --grep "webdock.*audit\|CRIT-2"` debe mostrar `cf75dd5` o similar.
2. `grep -n "auditAppend\|emit_audit" apps/gateway-api/src/routes/webdock*.ts` — el handler de `GET /v1/webdock/inventory` NO debe llamar audit.
3. `tail -f .audit/audit-events.jsonl` por 5 min con panel abierto en `/canvas` (que polls cada 3s). El contador NO debe crecer por `oc.webdock.inventory_read`.
4. Si crece: refixear.

Output: confirmación + último timestamp de evento webdock en audit chain (debería ser histórico, no nuevo).

---

## Tarea 4 (opcional, low-prio) — Cleanup verificación: cargar `OPENCLAW_GATEWAY_TOKEN` en gateway corriendo

**Por qué:** Tu memoria del 2026-05-24 dice que el gateway (PID 64543) fue iniciado **antes** de crear `.env.local` con el token. Quizás está corriendo sin el token cargado.

**Pasos:**

1. `ps aux | grep "node.*gateway" | grep -v grep` — confirma PID.
2. `grep OPENCLAW_GATEWAY_TOKEN /proc/$PID/environ 2>/dev/null | tr '\0' '\n' | head` (en Mac no funciona /proc; usar `lsof` o `dtrace` alternativa).
3. Si NO está cargado: matar y rearrancar. Confirmar que `curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/openclaw/chat/send` ya acepta.

---

## Coordinación

- Claude trabaja en frontend (Hito 5.12 panel Infraestructura, Canvas cleanup).
- Codex push a `main` cada tarea cerrada con commit message claro.
- Bloqueante crítico para demo: **Tarea 1** (chat real). Si no se puede en este sprint, decidir si la demo va con audit-feed-only + chat queue persistente (que ya está implementado).
