# OPS para Codex — Backend paralelo mientras Claude construye Canvas ReactFlow

**Fecha:** 2026-05-24
**Ejecutor:** Codex (backend)
**Owner humano:** Juanes
**Contexto:** Claude arrancó **Frente A** (Canvas ReactFlow real, branch `feature/canvas-reactflow`). Para no bloquear el frontend ni perder tiempo en serie, Codex ataca estas 7 tareas backend/ops en paralelo. Orden recomendado por prioridad.

---

## Tarea 1 — VERIFICAR contrato `GET /v1/openclaw/live-canvas` expone edges + suficiente metadata

**Por qué:** Claude va a usar `canvas.edges` (que ya está en el shape TS `client.ts:345-351`). Verificar que el backend gateway efectivamente devuelve edges con valores reales y no array vacío.

**Pasos:**

1. `curl -s http://localhost:3000/v1/openclaw/live-canvas | jq .canvas.edges`
2. Confirmar que array tiene al menos 4-5 edges con shape `{ id, from, to, status, label }`.
3. Si está vacío o falta status/label, agregar lógica en el provider que genere edges entre nodos consecutivos por lane (onboarding[0] → onboarding[1] → ... → hardware[0] → ...) + edges de dependencia cross-lane (ej: `provisioning.postfix-install → warming.day-1`).
4. Status del edge debe reflejar estado de origen: si nodo `from` es `ready` → edge `ready`. Si `from` es `blocked` o `error` → edge `blocked`.

**Output esperado:** `canvas.edges.length >= 8` con distribución `ready/in_progress/blocked` sensata. Commit message: `feat(gateway): canvas-live exposes real edges for ReactFlow rendering`.

---

## Tarea 2 — VERIFICAR endpoints chat live existen en gateway

**Por qué:** El `ChatWidget.tsx` ya está montado en `App.tsx:129` y abre WSS. Si los endpoints no existen, queda colgado en reconnecting.

**Pasos:**

1. Grep en `services/gateway/src`:
   ```bash
   grep -rn "openclaw/chat/send\|openclaw/chat/stream" services/gateway/src
   ```
2. Si NO existen, implementar siguiendo `DOCUMENTACION/OPS_OPENCLAW_CHAT_LIVE.md` §3 (especificación completa, ya escrita).
3. `POST /v1/openclaw/chat/send`: proxy a `http://2.24.223.240:61175/api/chat.send` con `Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}`. Audit `oc.chat.operator_message`.
4. `WSS /v1/openclaw/chat/stream`: proxy WSS a `ws://2.24.223.240:61175/api/chat.stream?token=${OPENCLAW_GATEWAY_TOKEN}` + multiplex a clientes panel. Audit `oc.chat.agent_response` al recibir `ASSISTANT_DONE`.

**Output esperado:** ambos endpoints responden 200/101. Test manual: `curl POST /v1/openclaw/chat/send -d '{"message":"hola"}'` devuelve `{msgId, queued: true}`.

---

## Tarea 3 — VERIFICAR OpenClaw container Hostinger expone `/api/chat.send` + `/api/chat.stream`

**Por qué:** El gateway hace proxy hacia el container. Si el container no implementó chat, todo falla.

**Pasos:**

1. SSH al servidor Hostinger: `ssh -i ~/.ssh/openclaw-hostinger root@2.24.223.240` (credenciales en `.env.local`).
2. `docker ps | grep openclaw` → verificar container corriendo.
3. `docker exec openclaw curl -s http://localhost:61175/api/chat.send -d '{"sessionKey":"agent:main:operator","msgId":"test","message":{"role":"user","content":"ping"}}'`.
4. Si devuelve 404, el container no tiene chat implementado → bloqueante. Documentar como issue y avisar Juanes.
5. Si responde 200, probar `wscat -c ws://localhost:61175/api/chat.stream?token=$OPENCLAW_GATEWAY_TOKEN` desde dentro del container.

**Output esperado:** confirmación o bloqueante claro. Si bloqueante, escribir OPS_OPENCLAW_CONTAINER_CHAT_IMPL.md.

---

## Tarea 4 — `.env.local` tiene `OPENCLAW_GATEWAY_TOKEN`?

**Pasos:**

1. `grep OPENCLAW_GATEWAY_TOKEN .env.local`
2. Si no existe, generar: `openssl rand -hex 32`
3. Agregar a `.env.local` Y al `.env` del container Hostinger (ssh + edit + restart container).
4. Documentar en `DOCUMENTACION/INDICE_DOCUMENTACION.md` que existe.

---

## Tarea 5 (fix pending #21) — `GET /v1/webdock/inventory` poll cada 30s NO debe escribir audit

**Por qué:** Codex ya identificó esto en CRIT-2 + fixeó. Verificar que el fix sigue en main.

**Pasos:**

1. `grep -n "auditAppend\|emit_audit" services/gateway/src/routes/webdock*.ts`
2. Confirmar que el handler de GET inventory NO emite audit event en lecturas — sólo en invocaciones reales del agente.
3. `tail -f .audit/audit-events.jsonl` mientras el panel está abierto (poll cada 30s) — el contador debe quedarse igual durante 5min consecutivos.

**Output esperado:** chain hash NO crece por lecturas. Si crece, revertir/refixear.

---

## Tarea 6 (fix pending #9) — Limpiar referencias a "31 gates" en `OPENCLAW_SYSTEM_PROMPT.md`

**Por qué:** El criterio C2 v3.0 reformuló "31 gates" → "9 norte + 5 categorías matrix". El system prompt debe alinearse.

**Pasos:**

1. `grep -n "31 gates\|31_gates\|thirty.one" DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md`
2. Reemplazar por "9 gates del norte operativo + las 5 categorías de la matriz de permisos".
3. Reescribir cualquier párrafo que asuma una lista cerrada de 31 elementos.
4. Re-push del system prompt al container Hostinger via skill `update_system_prompt`.

---

## Tarea 7 (fix pending #10) — Normalizar canonical substrings en detector C2

**Por qué:** El smoke C2 marcó "read_only" + "dry_run" como hallucinations cuando son substrings de los canónicos `allowed_read_only` + `allowed_dry_run`. Falsos positivos.

**Pasos:**

1. Localizar el detector en `services/gateway/src/openclaw/eval/c2-detector.ts` (o similar).
2. Antes de comparar token vs lista canónica, hacer `canonical.startsWith(token)` o usar regex con boundaries.
3. Agregar test: `expect(detect("read_only")).not.toMarkAsHallucination()`.

---

## Tarea 8 (opcional, baja prio) — Contrato `live-canvas` con `nodes[].x/y` opcionales

**Por qué:** Frontend ReactFlow va a auto-layout por defecto, pero si el backend conoce posiciones óptimas (ej. orden cronológico de provisioning), incluirlas evita re-layouts en cada poll.

**Pasos:**

1. Agregar a shape: `nodes[].x?: number; nodes[].y?: number;`
2. Provider: calcular x = índice dentro de la lane × 240; y = índice de la lane × 160.
3. Si backend devuelve undefined, frontend usa dagre fallback.

Codex puede saltarse esta si Tarea 1-7 toman tiempo. Frontend funciona sin esto.

---

## Coordinación

- Claude trabaja en `feature/canvas-reactflow` worktree, no toca backend.
- Codex push a `main` cada tarea cerrada con commit message claro.
- Sync diario: Juanes pregunta a ambos al final del día qué cerró cada uno.
- Bloqueante crítico para Frente A: solo Tarea 1 (edges del contrato). Sin edges reales el Canvas no se ve "conectado". Si Tarea 1 va a tardar > 30min, Codex avisa inmediato.
