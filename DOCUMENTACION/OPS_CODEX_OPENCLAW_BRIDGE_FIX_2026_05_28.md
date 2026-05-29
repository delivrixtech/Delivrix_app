# OPS Codex — Bridge OpenClaw ack mismatch (URGENTE pre-demo viernes)

**Para:** Codex.
**De:** Claude (PM + frontend).
**Fecha:** 2026-05-28 jueves, 19:35 COT.
**Prioridad:** **ALTA** — demo viernes 11am COT depende de esto.
**Tiempo estimado:** **5 min diagnóstico + 5-30 min fix** según escenario.

## Contexto

Juanes corrió el diagnóstico de la noche. Resultado:

1. Gateway local arriba en `http://localhost:3000/health` → status OK, postgres OK, redis OK. ✓
2. `POST /v1/openclaw/chat/send` → **`openclaw_chat_send_invalid_response`**.
   - Body completo: `{"error":"openclaw_chat_send_invalid_response","message":"OpenClaw chat.send returned an invalid acknowledgement."}`

Esto NO es `openclaw_ssh_bridge_failed` (que indicaría container down). Es **contract mismatch**: el container responde, pero su ack NO tiene `status:"started"`.

Ref: `apps/gateway-api/src/openclaw-ssh-bridge.ts` línea 126-131:
```ts
if (!isRecord(parsed) || parsed.status !== "started") {
  throw new OpenClawSshBridgeError(
    "invalid_chat_send_ack",
    "OpenClaw SSH chat.send did not return status=started."
  );
}
```

Juanes intentó correr el SSH manual pero le pidió password porque no usó la key. Vos tenés `OPENCLAW_SSH_KEY_PATH` cargado en `.env.local` — corré desde ahí.

---

## Tarea 1 — Capturar el ack crudo del container (2 min)

```bash
cd "/Users/juanescanar/Documents/delivrix app"
source .env.local
ssh -i "${OPENCLAW_SSH_KEY_PATH/#\~/$HOME}" \
    "${OPENCLAW_SSH_USER:-root}@${OPENCLAW_SSH_HOST:-2.24.223.240}" \
    'docker exec '"${OPENCLAW_CONTAINER_ID:-openclaw-dtsf-openclaw-1}"' openclaw gateway call chat.send --json --timeout 20 --params "{\"sessionKey\":\"agent:main:operator\",\"message\":\"diag codex\",\"idempotencyKey\":\"codex-diag-001\"}"' \
    2>&1 | tee /tmp/openclaw-ack-raw.txt
```

**Pegame el contenido de `/tmp/openclaw-ack-raw.txt` completo** en el reporte. Sin redactar (no debería haber secrets en el ack, pero si los hay, los redactás).

---

## Tarea 2 — Clasificar el escenario y aplicar fix

### Escenario A — ack tiene `status` pero con otro valor (ej. `"sent"`, `"queued"`, `"ok"`)

Ejemplo de output:
```json
{"status":"sent","msgId":"codex-diag-001","queuedAt":"2026-05-29T00:00:00Z"}
```

**Fix (5 min):** ajustar `openclaw-ssh-bridge.ts` línea 126 para aceptar el valor real:

```ts
const ackStatusValid =
  parsed.status === "started" ||
  parsed.status === "sent" ||
  parsed.status === "queued" ||
  parsed.status === "accepted";
if (!isRecord(parsed) || !ackStatusValid) {
  throw new OpenClawSshBridgeError(
    "invalid_chat_send_ack",
    `OpenClaw SSH chat.send returned unexpected status: ${String(parsed.status)}.`
  );
}
```

Update test en `openclaw-ssh-bridge.test.ts` (si existe) para cubrir el nuevo valor.

**Verificar fix:**
```bash
cd apps/gateway-api && node --test src/openclaw-ssh-bridge.test.ts
# y curl al gateway local:
curl -m 15 -X POST -H "Content-Type: application/json" \
  -d '{"msgId":"verify-'"$(date +%s)"'","message":"ping post-fix","actorId":"codex"}' \
  http://localhost:3000/v1/openclaw/chat/send
# debe responder 200 con { msgId, queued: true }
```

Commit + push: `fix(gateway): accept <status_value> as valid chat.send ack from container`.

### Escenario B — ack es un error JSON, ej. `{"error":"...","message":"..."}`

Ejemplo:
```json
{"error":"chat_session_not_found","message":"session 'agent:main:operator' has no active runtime"}
```

**Diagnóstico:** el container reconoce el comando pero rechaza con error específico. Probables causas:
- Session key default `agent:main:operator` no está registrada en el runtime del container.
- Bedrock credentials no cargadas en el container (`AWS_*` env vars).
- Modelo target (`claude-sonnet-4-6`) no expuesto via Bedrock en la cuenta.

**Acción:** reportar el `error` literal + `message` del ack. Yo decido si es fix de gateway o requiere config en el container Hostinger.

### Escenario C — ack NO es JSON, o es HTML/login, o stack trace

Ejemplo: HTML `<html><body>Login required...</body>` o `Error: Cannot find module '/openclaw/bin/gateway.js'`.

**Veredicto:** el container corre imagen vieja del 24-may sin contrato Delivrix. Requiere redeploy de imagen nueva.

**Acción:** reportar el output crudo + confirmar que **el demo va con skills directas vía panel** (plan B narrativo ya armado en `PREFLIGHT_DEMO_VIERNES_10H_2026_05_29.md`). NO intentar redeploy del container sin ventana de mantenimiento — el demo es en <12h.

---

## Tarea 3 — Reportar

Crea `DOCUMENTACION/OPS_CODEX_OPENCLAW_BRIDGE_FIX_2026_05_28_RESULT.md` con:

1. **Escenario identificado**: A / B / C.
2. **ACK crudo completo** del container (de `/tmp/openclaw-ack-raw.txt`).
3. **Fix aplicado** (si Escenario A): SHA del commit + diff resumido + output del curl post-fix.
4. **Diagnóstico** (si Escenario B): error literal del ack + hipótesis de causa + qué propones.
5. **Veredicto demo** (si Escenario C): confirmación de que vamos con plan B.

---

## Reglas duras

1. **NO redeployar el container Hostinger** sin coordinar con Juanes — el demo es en <12h.
2. **NO tocar el frontend** — Juanes ya validó las vistas v5.
3. **Si Escenario A**, hacer commit + push. Si B o C, NO commitear cambios al gateway.
4. **Reportar cualquier secret accidentalmente visible** en el ack (no debería haber, pero por si las moscas).

— Claude
