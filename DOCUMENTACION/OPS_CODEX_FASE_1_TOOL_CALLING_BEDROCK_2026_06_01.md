# OPS Codex Fase 1 — Tool calling Bedrock real

**Fecha despacho:** 2026-05-29 viernes (pre-armado por PM).
**Fecha ejecución:** lunes 2026-06-01 ~11:00 COT (post-smoke Fase 0.5).
**Owner:** Codex backend senior.
**PM:** Claude.
**Duración estimada:** 5 días laborales (lunes 06-01 a viernes 06-05).
**Doc base:** `ROADMAP_AUTONOMIA_100_AGENTES_2026_05_29.md` Fase 1.
**Brecha que cierra:** **#1 para autonomía 100%.** Sin esto, el agente OpenClaw describe skills pero NO las invoca. El operador todavía debe hacer `curl` manual.

---

## Resumen ejecutivo

Hoy OpenClaw vía Bedrock Sonnet 4.6 recibe contexto vivo (overview + kill switch + canvas + audit) y conversa correctamente — eso es lo que se demoó a Hostinger viernes. Lo que NO hace: **invocar handlers en backend mismo**. Cuando se le pide "provisiona SMTP en delivrix-test.com", responde con un plan en prosa, no con `tool_use` blocks que el dispatcher pueda ejecutar.

Esta fase añade **tool calling real**: OpenClaw recibe la lista de skills disponibles como `tools` parameter de Bedrock API, decide cuál invocar, emite `tool_use` blocks, el gateway los recibe y dispatcha al dispatcher de Fase 0.5 (`skill-dispatcher.ts`), procesa el resultado y lo retorna como `tool_result` para que OpenClaw continúe el flow.

---

## Pre-requisitos (lunes 06-01 11:00 COT)

- ✅ Fase 0.5 cerrada: `/v1/openclaw/proposals/{id}/sign` + dispatcher + smoke E2E real con $25 USD.
- ✅ Audit chain SHA-256 + anchor + verify ok=true.
- ✅ Bedrock adapter ya cableado (sesión demo viernes).
- ✅ ApprovalGate UI funcional.
- ✅ Worktree limpio (commit limpio fixes viernes + stash basura).

---

## Tarea 1 — Bedrock tools parameter

**Archivo nuevo:** `apps/gateway-api/src/openclaw-tools-builder.ts`.

Construye la lista de `tools` que Bedrock recibe en cada turno. Lee del `skill-dispatcher.ts` (Fase 0.5) la matriz canónica de 8 skills. Para cada una emite un schema Bedrock-compatible:

```typescript
export interface BedrockToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export function buildToolsForOpenClaw(env: NodeJS.ProcessEnv): BedrockToolSpec[] {
  const tools: BedrockToolSpec[] = [];

  // 1. register_domain_route53
  if (env.AWS_ROUTE53_DOMAINS_PURCHASE_ENABLED === "1") {
    tools.push({
      name: "register_domain_route53",
      description: "Registra un dominio nuevo en AWS Route53. Requiere aprobación de operador via ApprovalGate. Costo típico: $15 USD / año .com, $38 USD / año .co.",
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z]{2,})+$" },
          years: { type: "integer", minimum: 1, maximum: 10 },
          autoRenew: { type: "boolean", default: false }
        },
        required: ["domain", "years"]
      }
    });
  }

  // 2. upsert_dns_route53
  // 3. upsert_dns_ionos
  // 4. create_webdock_server
  // 5. provision_smtp_postfix
  // 6. configure_email_auth
  // 7. bind_domain_to_server
  // 8. seed_warmup_pool

  return tools;
}
```

**Importante:**
- Si una skill tiene su flag fail-closed off (ej. `WARMUP_RAMP_ENABLE=0`), **NO se incluye en tools**. El agente no puede ni proponerla.
- Cada `description` debe ser explícita sobre costo, riesgo y que requiere aprobación.
- `input_schema` debe matchear EXACTAMENTE el schema zod de Fase 0.5.

---

## Tarea 2 — Bedrock invoke con tools

**Archivo modificado:** `apps/gateway-api/src/openclaw-bedrock-adapter.ts` (ya existe del demo).

Añadir:

```typescript
import { buildToolsForOpenClaw } from "./openclaw-tools-builder.ts";

async function invokeBedrockWithTools(input: {
  messages: BedrockMessage[];
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
}): Promise<BedrockResponse> {
  const tools = buildToolsForOpenClaw(input.env);

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: "anthropic.claude-sonnet-4-6-20250929-v1:0",  // verificar ID exacto del modelo
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      system: input.systemPrompt,
      messages: input.messages,
      tools,  // nueva clave
      tool_choice: { type: "auto" }  // OpenClaw decide cuándo usar herramienta
    })
  }));

  return parseBedrockResponse(response);
}
```

**Notar:**
- `tool_choice: "auto"` permite a OpenClaw decidir entre conversar o invocar.
- `max_tokens: 4096` (típico).
- Mantener compat con flow conversacional cuando no hay tools relevantes.

---

## Tarea 3 — Handler de `tool_use` blocks

**Archivo modificado:** `apps/gateway-api/src/openclaw-chat.ts`.

Cuando la respuesta de Bedrock contiene `content` con `type: "tool_use"`, NO retornar texto al frontend todavía. En su lugar:

1. **Crear propuesta `oc.proposal.submitted` automáticamente** con los params del tool_use.
2. **Inyectar en Canvas Live** como propuesta pendiente (ya hay endpoint para esto).
3. **Esperar firma via ApprovalGate** (timeout configurable, default 5min).
4. **Si firmada:** dispatcher ejecuta + recibe `outcome`.
5. **Si rechazada o timeout:** capturar reason.
6. **Crear `tool_result` block** con outcome JSON.
7. **Re-invocar Bedrock** con el `tool_result` añadido al historial.
8. **Repetir el ciclo** hasta que la respuesta del modelo sea solo texto (stop sequence).

```typescript
async function handleChatTurnWithTools(input: {
  chatSession: ChatSession;
  userMessage: string;
}): Promise<ChatResponse> {
  let messages = [...input.chatSession.history, { role: "user", content: input.userMessage }];
  const maxIterations = 10;  // safety: no más de 10 tool_use por turno

  for (let i = 0; i < maxIterations; i++) {
    const response = await invokeBedrockWithTools({ messages, systemPrompt, env });

    const toolUses = response.content.filter(c => c.type === "tool_use");

    if (toolUses.length === 0) {
      // Respuesta final, solo texto
      messages.push({ role: "assistant", content: response.content });
      return { reply: extractText(response.content), messages };
    }

    // Hay tool_use blocks. Procesar cada uno.
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const toolUse of toolUses) {
      const result = await processToolUse({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        toolInput: toolUse.input,
        chatSession: input.chatSession,
        env
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result)
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error("Max tool iterations exceeded");
}
```

---

## Tarea 4 — `processToolUse` con ApprovalGate flow

**Archivo nuevo:** `apps/gateway-api/src/tool-use-processor.ts`.

```typescript
export async function processToolUse(input: {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  chatSession: ChatSession;
  env: NodeJS.ProcessEnv;
}): Promise<ToolUseResult> {
  // 1. Validar tool name está en SKILL_HANDLER_MAP
  const entry = SKILL_HANDLER_MAP[input.toolName];
  if (!entry) {
    return { ok: false, error: "unknown_tool", details: { tool: input.toolName } };
  }

  // 2. Validar params contra schema zod
  const validation = entry.paramSchema.safeParse(input.toolInput);
  if (!validation.success) {
    return { ok: false, error: "invalid_params", details: validation.error.format() };
  }

  // 3. Auto-submit proposal
  const proposal = await submitProposalFromToolUse({
    skill: input.toolName,
    params: validation.data,
    sessionId: input.chatSession.id,
    actorOrigin: "openclaw-bedrock-tool-use"
  });

  // 4. Inyectar en Canvas Live (PendingApprovalsPanel lo va a polear automáticamente)
  // El panel sticky-bottom lo muestra al operador.

  // 5. Esperar firma con timeout configurable
  const approvalTimeoutMs = parseInt(input.env.OPENCLAW_TOOL_APPROVAL_TIMEOUT_MS ?? "300000");  // 5min default
  const approval = await waitForProposalDecision(proposal.id, approvalTimeoutMs);

  // 6. Procesar outcome
  if (approval.status === "signed") {
    // Dispatcher YA ejecutó (lógica de Fase 0.5).
    return {
      ok: approval.outcome.ok,
      result: approval.outcome.summary,
      durationMs: approval.outcome.durationMs,
      proposalId: proposal.id,
      signatureId: approval.signatureId
    };
  } else if (approval.status === "rejected") {
    return {
      ok: false,
      error: "rejected_by_operator",
      reason: approval.rejectionReason,
      proposalId: proposal.id
    };
  } else {
    // Timeout
    return {
      ok: false,
      error: "approval_timeout",
      timeoutMs: approvalTimeoutMs,
      proposalId: proposal.id
    };
  }
}
```

---

## Tarea 5 — Streaming de tool_use en frontend

**Archivo modificado:** `apps/admin-panel/src/v5/views/CanvasLive.tsx` + relacionados.

Hoy el chat streamea respuestas de Bedrock token-por-token. Cuando llegue un `tool_use` block, hay que:

1. Detectar parsing del SSE para tool_use.
2. Mostrar en chat: "🛠 Quiere invocar `register_domain_route53` con `{domain: 'delivrix-test.com', years: 1}`".
3. El PendingApprovalsPanel ya va a mostrar el ApprovalGate (porque la propuesta se auto-submit en backend).
4. Mientras esperamos firma: pintar "Esperando firma operador..." en el chat.
5. Cuando firma: pintar outcome.
6. Continuar streaming siguiente turno.

**Componente nuevo:** `apps/admin-panel/src/v5/components/ToolUseInlineCard.tsx`.

---

## Tarea 6 — Tests

**Suites nuevas:**

1. `apps/gateway-api/src/openclaw-tools-builder.test.ts` (~15 tests):
   - Build con todos los flags ON → 8 tools.
   - Build con WARMUP_RAMP_ENABLE=0 → 7 tools (sin seed_warmup_pool).
   - Build con AWS keys missing → tools de Route53 ausentes.
   - Schemas matchean zod schemas Fase 0.5.

2. `apps/gateway-api/src/tool-use-processor.test.ts` (~20 tests):
   - Happy path: tool_use → submit → sign → dispatch → tool_result.
   - tool_input invalid → tool_result con error.
   - Rejected → tool_result con rejected reason.
   - Timeout → tool_result con timeout.
   - Tool name unknown → tool_result con unknown_tool.
   - Kill switch armed mid-flow → abort.

3. `apps/gateway-api/src/openclaw-chat.test.ts` (~12 tests nuevos):
   - Chat sin tool_use → texto normal.
   - Chat con 1 tool_use → loop completo.
   - Chat con N tool_use encadenados → loop N veces.
   - Max iterations exceeded → error claro.

4. `apps/admin-panel/src/v5/components/ToolUseInlineCard.test.tsx` (~8 tests).

**Total esperado:** ~55 tests nuevos.

---

## Tarea 7 — E2E con LocalStack mock

Antes del smoke real, validar el flow completo SIN gastar:

1. LocalStack levantado (`docker-compose up localstack`).
2. Bedrock mock con respuestas hardcodeadas que incluyan tool_use blocks.
3. Endpoints AWS Route53 mockeados.
4. Webdock mock.
5. Test E2E corre 1 turno completo: usuario pide → tool_use → proposal → firma simulada → dispatch → tool_result → respuesta final.
6. Verificar audit chain íntegra post-test.
7. Verificar canvas state actualizado.

---

## Tarea 8 — Smoke E2E real con $25 USD

Una vez E2E con LocalStack verde:

```bash
export GATEWAY_BASE=http://127.0.0.1:3000

# 1. Mensaje al chat: "Provisiona SMTP en delivrix-tool-call-smoke-2026-06-05.com"
curl -X POST "$GATEWAY_BASE/v1/openclaw/chat/send" \
  -d '{"sessionId":"smoke-fase-1","message":"Provisiona SMTP completo en delivrix-tool-call-smoke-2026-06-05.com"}'

# 2. OpenClaw debe emitir tool_use de register_domain_route53.
# 3. Operador (Juanes) ve propuesta en panel, firma.
# 4. Dispatcher ejecuta. AWS registra dominio. Costo: $15.
# 5. OpenClaw recibe tool_result, emite tool_use de upsert_dns_route53.
# 6. Operador firma. Ejecuta.
# 7. ... continúa hasta SMTP provisionado.

# Verificación post-smoke:
curl "$GATEWAY_BASE/v1/audit-chain/verify" | jq
curl "$GATEWAY_BASE/v1/audit-chain/anchor" | jq > runtime/audit-anchor-fase-1-smoke.json
```

**HARD STOP:** $25 USD acumulado.

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Bedrock no soporta el modelo Sonnet 4.6 con tools | Verificar feature disponible para us-east-1 Bedrock. Si no, fallback Sonnet 4.5. |
| Tool_use loop infinito | maxIterations = 10. Audit `oc.chat.tool_loop_exceeded` si llega al límite. |
| OpenClaw alucina tool name | Validación contra SKILL_HANDLER_MAP. Devuelve `unknown_tool` error como tool_result. El agente debe corregir. |
| Frontend no detecta tool_use en stream | Tests E2E con Playwright capturan flow visual completo. |
| ApprovalGate timeout configurado mal | Default 5min, override via env. Documentar en NORTE_OPERATIVO. |
| Tool_result demasiado grande para context | Truncar `summary` a 4KB max. Detalles completos en audit + workspace file. |

---

## Sign-off requerido

- [ ] Codex confirma SHA final + tests verdes (~55 nuevos).
- [ ] `tsc --noEmit` clean.
- [ ] E2E LocalStack pasa.
- [ ] Smoke real con $25 USD documenta provisioning E2E completo desde 1 mensaje del operador.
- [ ] PM Claude revisa diff antes de merge.
- [ ] Anchor HMAC post-smoke guardado.
- [ ] Actualizar `OPENCLAW_PERMISSIONS_MATRIX.md` si algún skill cambió categoría.

---

## Entregables

1. **Código:**
   - `apps/gateway-api/src/openclaw-tools-builder.ts`
   - `apps/gateway-api/src/tool-use-processor.ts`
   - `apps/gateway-api/src/openclaw-bedrock-adapter.ts` (modificado)
   - `apps/gateway-api/src/openclaw-chat.ts` (modificado)
   - `apps/admin-panel/src/v5/components/ToolUseInlineCard.tsx`
   - Wire en streaming SSE/WSS handlers.

2. **Tests:** ~55 nuevos verdes.

3. **Docs:**
   - `DOCUMENTACION/FASE_1_RESULT_2026_06_05.md` con SHA + smoke outcome.
   - Actualizar `OPENCLAW_SYSTEM_PROMPT.md` bloque [tool use protocol] explicando cómo OpenClaw usa tool_use.
   - Actualizar `ARQUITECTURA_MULTI_AGENT_RUNTIME.md` con detalles del loop tool_use ↔ ApprovalGate.

4. **Smoke E2E:** evidencia en `runtime/smoke-fase-1-{timestamp}.jsonl` + anchor firmado + transcript del chat.

---

## Notas finales del PM

- **NO toques main.ts si es deuda preexistente.** Wire mínimo de las nuevas rutas/handlers.
- **Tool_use flow es el que va a usar Fase 2 multi-agente.** Si encuentras algo que no escala (ej. ApprovalGate solo soporta 1 propuesta visible), levantar en review.
- **Reportar 9:30am y 5pm cada día** durante los 5 días de la fase.
- **Si Bedrock falla con tools (region/model availability)**, parar y escalar a PM antes de cambiar de modelo. El sistem prompt está afinado para Sonnet 4.6.
- **Kill switch sigue siendo el último gate.** Tool_use en flow debe respetar HTTP 423.
- **El smoke real cuesta hasta $25.** No reintentar más de 1 vez si falla. Capturar logs + audit para post-mortem.

— Claude PM
