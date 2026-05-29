# OPS Codex — Inyectar contexto LIVE en Bedrock adapter (CRÍTICO pre-demo)

**Para:** Codex.
**De:** Claude (PM).
**Fecha:** 2026-05-29 viernes, 10:35 COT. **Demo en 25 min.**
**Prioridad:** **CRÍTICA**.
**Tiempo:** **15-20 min**.

## El bug

El adapter `OpenClawBedrockBridge` carga el system prompt ESTÁTICO de `.audit/system-context.txt` y llama Bedrock con ese prompt + mensajes. NUNCA inyecta:
- `delivrix_endpoint_token` (read-boundary auth)
- `delivrix_base_url` (gateway local)
- **Estado actual del sistema** (kill switch, overview, canvas, audit recientes)

Resultado: Sonnet 4.6 responde con razonamiento perfecto del system prompt, pero dice "No tengo conexión activa al Gateway en este momento. No puedo ejecutar esas llamadas desde esta conversación directamente." Confirmado por screenshot del CTO Juanes a las 10:30 COT.

Ref evidencia: `apps/gateway-api/src/openclaw-bedrock-bridge.ts:177-194` (función `invokeBedrock`) — payload solo lleva `system` (prompt estático) + `messages`. Cero contexto live.

Comparar con HTTP/SSH bridge: `apps/gateway-api/src/openclaw-chat.ts:269-275` inyecta `delivrix_endpoint_token` + `delivrix_base_url` en cada request al container Hostinger.

## Fix pragmático (NO tool calling, demo en 25 min)

El demo NO necesita que el agente llame skills en vivo. NECESITA que el agente **razone CON datos reales del estado del sistema en este momento**, no que invente.

Solución: **antes de cada llamada a Bedrock, pre-llamar 4 endpoints read-only del gateway local y meter el resultado como `<live_context>` al final del system prompt**.

### Archivos a tocar

#### 1. `apps/gateway-api/src/openclaw-bedrock-bridge.ts`

Agregar al constructor:
```ts
private readonly delivrixBaseUrl: string;
private readonly readBoundaryToken: string;
private readonly fetchImpl: typeof fetch;
```

Inicializar en constructor con:
```ts
this.delivrixBaseUrl = config.delivrixBaseUrl ?? "http://127.0.0.1:3000";
this.readBoundaryToken = config.readBoundaryToken ?? "";
this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
```

Agregar método nuevo:
```ts
private async fetchLiveContext(): Promise<string> {
  const headers: Record<string, string> = {
    accept: "application/json"
  };
  if (this.readBoundaryToken) {
    headers["x-delivrix-token"] = this.readBoundaryToken;
  }
  const safeGet = async (path: string): Promise<unknown> => {
    try {
      const res = await this.fetchImpl(`${this.delivrixBaseUrl}${path}`, { headers });
      if (!res.ok) return { _error: `HTTP ${res.status}` };
      return await res.json();
    } catch (err) {
      return { _error: err instanceof Error ? err.message : "unknown" };
    }
  };
  const [overview, killSwitch, canvas, audit] = await Promise.all([
    safeGet("/v1/admin/overview"),
    safeGet("/v1/kill-switch"),
    safeGet("/v1/canvas/state"),
    safeGet("/v1/audit-events?limit=10")
  ]);
  const now = this.now().toISOString();
  return [
    "",
    "<live_context generatedAt=\"" + now + "\">",
    "Estos son datos REALES del Gateway Delivrix justo antes de tu turno actual.",
    "Cita explícitamente este contexto cuando el operador te pregunte por estado del sistema.",
    "Si un campo falta o tiene _error, dilo honesto. NO inventes valores.",
    "",
    "## overview (GET /v1/admin/overview)",
    "```json",
    JSON.stringify(overview, null, 2).slice(0, 4000),
    "```",
    "",
    "## kill_switch (GET /v1/kill-switch)",
    "```json",
    JSON.stringify(killSwitch, null, 2).slice(0, 1500),
    "```",
    "",
    "## canvas (GET /v1/canvas/state)",
    "```json",
    JSON.stringify(canvas, null, 2).slice(0, 4000),
    "```",
    "",
    "## audit_recent (GET /v1/audit-events?limit=10)",
    "```json",
    JSON.stringify(audit, null, 2).slice(0, 4000),
    "```",
    "</live_context>"
  ].join("\n");
}
```

Modificar `invokeBedrock` para anexar el live context al system prompt:
```ts
private async invokeBedrock(turns: ConversationTurn[]): Promise<BedrockInvocationResult> {
  const startedAt = this.now().getTime();
  const systemBase = await this.loadSystemPrompt();
  const liveContext = await this.fetchLiveContext();
  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: this.maxTokens,
    temperature: this.temperature,
    system: systemBase + "\n\n" + liveContext,
    messages: turns.map((turn) => ({
      role: turn.role,
      content: [{ type: "text", text: turn.content }]
    }))
  };
  // ... resto igual
}
```

Extender `OpenClawBedrockBridgeConfig` con los 3 campos:
```ts
delivrixBaseUrl?: string;
readBoundaryToken?: string;
fetchImpl?: typeof fetch;
```

#### 2. `apps/gateway-api/src/main.ts`

Donde se instancia el bridge Bedrock, pasarle el read-boundary token + base URL. Buscar la línea que crea `OpenClawBedrockBridge` o el factory `createOpenClawBedrockBridgeFromEnv` y agregar:
```ts
delivrixBaseUrl: process.env.DELIVRIX_BASE_URL ?? "http://127.0.0.1:3000",
readBoundaryToken: process.env.DELIVRIX_OPENCLAW_TOKEN ?? ""
```

#### 3. Tests

Agregar **1 test** en `openclaw-bedrock-bridge.test.ts` que verifique:
- Bridge llama a los 4 endpoints antes de invocar Bedrock
- El system payload contiene `<live_context>`
- Si fetch falla, el contexto incluye `_error` y NO crashea

Mock simple del `fetchImpl`.

## Validación

```bash
cd "/Users/juanescanar/Documents/delivrix app/apps/gateway-api"
node --test src/openclaw-bedrock-bridge.test.ts
# debe ser N+1 verde (1 nuevo test)
npx --no-install tsc --noEmit 2>&1 | grep openclaw-bedrock-bridge
# 0 errores

# Smoke real:
curl -m 30 -X POST -H "Content-Type: application/json" \
  -d '{"msgId":"smoke-live-'$(date +%s)'","message":"qué está en mi kill switch ahora?","actorId":"juanes"}' \
  http://localhost:3000/v1/openclaw/chat/send
```

**Criterio de aceptación**: la respuesta menciona el campo `enabled` del kill switch con el valor REAL del `/v1/kill-switch` actual (ej. "Tu kill switch está en `enabled: false`, armado, listo para activar — actualizado por operator_local en 2026-05-02"). NO debe decir "no tengo conexión activa al Gateway".

## Reglas duras

1. **NO toques el SSH bridge ni el fallback** — siguen como backup.
2. **NO commitees `.env.local`**.
3. **Reinicia gateway después del fix** (kill PID 27963, `pnpm dev` o el comando que uses).
4. **Si fetch de un endpoint falla, NO bloquees**: meté `_error` en el JSON y seguí. El agente está instruido para reportarlo honesto.
5. **Tiempo límite: 15 min**. Si en 15 no llegás a smoke verde, reportá estado y dejá rollback fácil.

## Mensaje commit sugerido

```
fix(gateway): inject live system snapshot into Bedrock chat context

Bedrock adapter previously called Sonnet 4.6 with static system prompt only,
so the model honestly responded "no live connection" when asked about
kill switch / canvas / audit state.

Fix: bridge now pre-fetches 4 read-boundary endpoints (overview, kill-switch,
canvas, audit-events) before each Bedrock invocation and appends them as
<live_context> inside the system prompt. The model can now cite real values
without inventing.

- New fields: delivrixBaseUrl, readBoundaryToken, fetchImpl in
  OpenClawBedrockBridgeConfig
- fetchLiveContext() with 4 safe GETs (errors surfaced as _error)
- Wired from main.ts via DELIVRIX_BASE_URL + DELIVRIX_OPENCLAW_TOKEN env
- Tests: +1 (mock fetch, verify live_context in payload)
- Smoke: kill switch question returns real enabled value
```

— Claude
