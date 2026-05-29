# OPS Codex — OpenClaw Bedrock Direct Bridge (bypass Hostinger)

**Para:** Codex.
**De:** Claude (PM + arquitectura).
**Fecha:** 2026-05-29 viernes, 00:55 COT.
**Prioridad:** **CRÍTICA** — Juanes pidió explícitamente que el chat funcione para el demo viernes 11am.
**Tiempo estimado:** **2-3h** trabajo limpio + 5 min setup Juanes.
**Ventana:** arrancar ya, smoke listo antes de las 5am COT.

## Contexto

OPS anterior (`OPS_CODEX_OPENCLAW_BRIDGE_FIX_2026_05_28_RESULT.md`) confirmó Escenario C: container Hostinger `openclaw-dtsf-openclaw-1` corre imagen vieja del 24-may, bundle HTTP devuelve HTML/login en vez de JSON, SSH key del `.env.local` no autorizada en `authorized_keys` del host. Requiere ventana de mantenimiento Webdock que no tenemos antes del demo.

**Nuevo camino:** sacar al container Hostinger del path crítico. Conectar el gateway local **directamente a Bedrock us-east-1**, usar el system prompt que ya tenemos compilado (`scripts/openclaw/build-system-context.sh`), y servir las respuestas del modelo Claude Sonnet 4.6 desde el mismo proceso del gateway.

Beneficios:
- Independencia total del container Hostinger.
- Latencia menor (un hop AWS vs. dos hops SSH→container→AWS).
- Auditabilidad propia (cada InvokeModel queda en audit chain).
- Si demo viernes funciona con Bedrock direct, podemos mantenerlo como default y dejar el container Hostinger como fallback/staging.

Costo Bedrock: Sonnet 4.6 ~$3/M input tokens, ~$15/M output. Demo + practice runs = ~50K tokens = <$1 USD. Cubierto por wallet del operador.

---

## Pre-requisito Juanes (5 min en consola AWS, antes de Codex)

1. **IAM user nuevo**:
   - Console → IAM → Users → Create user → name `delivrix-bedrock-runtime`.
   - Permisos: attach policy `AmazonBedrockFullAccess` (default AWS) o policy custom mínima:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": "arn:aws:bedrock:us-east-1::foundation-model/*"
       }]
     }
     ```
   - Generar Access Key + Secret → pegar en `.env.local`:
     ```
     AWS_BEDROCK_ACCESS_KEY_ID=AKIA...
     AWS_BEDROCK_SECRET_ACCESS_KEY=<40 chars>
     AWS_BEDROCK_REGION=us-east-1
     AWS_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0
     OPENCLAW_BRIDGE_KIND=bedrock
     ```
     (Si el alias `claude-sonnet-4-5` no está disponible, usar el modelId exacto que aparezca en Bedrock console → Model access → Claude.)

2. **Habilitar modelo en Bedrock**:
   - Console → Bedrock (us-east-1) → Model access → Request access → marcar "Claude Sonnet 4.x" → Submit (aprobación inmediata para cuentas activas).
   - Si la cuenta tiene Bedrock activado y modelos Claude approved, salta este paso.

3. Confirmar con Codex que las env vars están seteadas + reiniciar gateway local.

---

## Tarea 1 — Adapter Bedrock direct (~1h)

### Archivo 1: `apps/gateway-api/src/openclaw-bedrock-bridge.ts`

Crear adapter que implementa la misma interfaz pública que `OpenClawSshBridge` (`sendOperatorMessage`, `streamHistory`) para que `OpenClawChatProxy` lo pueda usar transparentemente.

```typescript
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  type InvokeModelWithResponseStreamCommandInput
} from "@aws-sdk/client-bedrock-runtime";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  OpenClawSshBridge,
  OpenClawSshChatSendInput,
  OpenClawSshChatSendOutput,
  OpenClawSshHistoryCallbacks
} from "./openclaw-ssh-bridge.ts";

export interface OpenClawBedrockBridgeConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  modelId: string;
  systemPromptPath?: string;
  maxTokens?: number;
  temperature?: number;
  sessionKey?: string;
  now?: () => Date;
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * OpenClaw Bedrock direct bridge — invoca Claude Sonnet 4.x via Bedrock
 * sin pasar por el container Hostinger. System prompt cargado de
 * scripts/openclaw/build-system-context.sh output (.audit/system-context.txt)
 * o fallback a OPENCLAW_SYSTEM_PROMPT.md.
 *
 * Memoria de conversación in-process por sessionKey. Streaming chunks
 * emitidos via streamHistory callbacks (compatible con WSS frontend).
 */
export class OpenClawBedrockBridge implements OpenClawSshBridge {
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;
  private readonly systemPromptPath: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly sessionKey: string;
  private readonly now: () => Date;
  private cachedSystemPrompt: string | null = null;
  private readonly conversations = new Map<string, ConversationTurn[]>();
  private readonly pendingResponses = new Map<string, Promise<string>>();

  constructor(config: OpenClawBedrockBridgeConfig) {
    this.client = new BedrockRuntimeClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
    this.modelId = config.modelId;
    this.systemPromptPath =
      config.systemPromptPath ??
      join(process.cwd(), ".audit", "system-context.txt");
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.3;
    this.sessionKey = config.sessionKey ?? "agent:main:operator";
    this.now = config.now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return Boolean(this.modelId && this.client);
  }

  async sendOperatorMessage(
    input: OpenClawSshChatSendInput
  ): Promise<OpenClawSshChatSendOutput> {
    const { msgId, message } = input;
    const turns = this.conversations.get(this.sessionKey) ?? [];
    turns.push({ role: "user", content: message });
    this.conversations.set(this.sessionKey, turns);
    // Disparamos la inferencia pero NO esperamos — el streamHistory la consume.
    const promise = this.invokeBedrock(turns);
    this.pendingResponses.set(msgId, promise);
    return { msgId, queued: true };
  }

  async streamHistory(
    msgId: string,
    callbacks: OpenClawSshHistoryCallbacks
  ): Promise<void> {
    const promise = this.pendingResponses.get(msgId);
    if (!promise) {
      return;
    }
    callbacks.onTyping?.({
      type: "ASSISTANT_TYPING",
      msgId,
      ts: this.now().toISOString()
    });
    const fullText = await promise;
    callbacks.onContent?.({
      type: "ASSISTANT_CHUNK",
      msgId,
      text: fullText,
      ts: this.now().toISOString()
    });
    callbacks.onDone?.({
      type: "ASSISTANT_DONE",
      msgId,
      text: fullText,
      ts: this.now().toISOString()
    });
    const turns = this.conversations.get(this.sessionKey) ?? [];
    turns.push({ role: "assistant", content: fullText });
    this.conversations.set(this.sessionKey, turns);
    this.pendingResponses.delete(msgId);
  }

  private async loadSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt) return this.cachedSystemPrompt;
    try {
      const buf = await readFile(this.systemPromptPath, "utf-8");
      this.cachedSystemPrompt = buf;
      return buf;
    } catch {
      // Fallback: usar el doc original sin bundle.
      const fallback = await readFile(
        join(process.cwd(), "DOCUMENTACION", "OPENCLAW_SYSTEM_PROMPT.md"),
        "utf-8"
      );
      this.cachedSystemPrompt = fallback;
      return fallback;
    }
  }

  private async invokeBedrock(turns: ConversationTurn[]): Promise<string> {
    const systemPrompt = await this.loadSystemPrompt();
    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: systemPrompt,
      messages: turns.map((t) => ({
        role: t.role,
        content: t.content
      }))
    };
    const command = new InvokeModelWithResponseStreamCommand({
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    } satisfies InvokeModelWithResponseStreamCommandInput);
    const result = await this.client.send(command);
    let fullText = "";
    for await (const event of result.body ?? []) {
      if (event.chunk?.bytes) {
        const decoded = new TextDecoder().decode(event.chunk.bytes);
        const parsed = JSON.parse(decoded);
        if (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "text_delta"
        ) {
          fullText += parsed.delta.text ?? "";
        }
      }
    }
    return fullText;
  }
}

export function createOpenClawBedrockBridgeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): OpenClawBedrockBridge | null {
  if (env.OPENCLAW_BRIDGE_KIND !== "bedrock") return null;
  const accessKeyId = env.AWS_BEDROCK_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_BEDROCK_SECRET_ACCESS_KEY;
  const region = env.AWS_BEDROCK_REGION ?? "us-east-1";
  const modelId = env.AWS_BEDROCK_MODEL_ID;
  if (!accessKeyId || !secretAccessKey || !modelId) return null;
  return new OpenClawBedrockBridge({
    accessKeyId,
    secretAccessKey,
    region,
    modelId
  });
}
```

### Archivo 2: `apps/gateway-api/src/openclaw-bedrock-bridge.test.ts`

Tests con mock del `BedrockRuntimeClient`:
- `sendOperatorMessage` retorna `{msgId, queued: true}` y registra promesa pendiente.
- `streamHistory` consume la promesa, emite typing + chunk + done.
- Conversación in-memory mantiene historial entre turns.
- `loadSystemPrompt` cae a `OPENCLAW_SYSTEM_PROMPT.md` si bundle no existe.
- `createOpenClawBedrockBridgeFromEnv` retorna `null` si falta cualquier env var crítica.

Patrón: ya hay tests con node:test + assert en el repo (`warmup-ramp.test.ts` es un ejemplo). Reusar shape.

### Modificación: `apps/gateway-api/src/main.ts`

Reemplazar el wiring del bridge:

```typescript
import { createOpenClawSshBridgeFromEnv } from "./openclaw-ssh-bridge.ts";
import { createOpenClawBedrockBridgeFromEnv } from "./openclaw-bedrock-bridge.ts";

// ...

const openClawBedrockBridge = createOpenClawBedrockBridgeFromEnv(process.env);
const openClawSshBridge = openClawBedrockBridge
  ? null
  : createOpenClawSshBridgeFromEnv();
const activeBridge = openClawBedrockBridge ?? openClawSshBridge;

const openClawChatProxy = new OpenClawChatProxy(auditLog, {
  bridgeKind: openClawBedrockBridge
    ? "bedrock"
    : openClawSshBridge
    ? "ssh"
    : "http",
  sshBridge: activeBridge,
  canvasLiveEvents
});
```

**Importante:** verificar que `OpenClawChatProxy` acepta `sshBridge` con la interfaz pública que el nuevo adapter implementa (`sendOperatorMessage`, `streamHistory`). Si la interfaz es estricta (sin nombre `ssh`), renombrar la prop a `chatBridge` o similar — pero NO sobre-diseñar, mantener cambio mínimo.

---

## Tarea 2 — Instalación dependencia (~2 min)

```bash
cd "/Users/juanescanar/Documents/delivrix app"
pnpm add @aws-sdk/client-bedrock-runtime
# o si el repo usa workspaces: pnpm --filter @delivrix/gateway-api add @aws-sdk/client-bedrock-runtime
```

Confirmar que `package.json` declara la versión instalada. Sin sub-deps innecesarias — `client-bedrock-runtime` es independiente.

---

## Tarea 3 — Pre-cargar system context bundle (~5 min)

Antes del smoke, asegurar que el bundle de Capa 1 está en disco:

```bash
cd "/Users/juanescanar/Documents/delivrix app"
bash scripts/openclaw/build-system-context.sh
# Si falla por SSH al container Hostinger (esperable):
# editar el script o ejecutarlo en modo local-only.
```

Si el script falla porque intenta hacer SSH al Hostinger, está OK para esta tarea — el adapter Bedrock cae al `OPENCLAW_SYSTEM_PROMPT.md` raw. Lo que importa es que el archivo esté disponible.

Verificar:
```bash
ls -la "/Users/juanescanar/Documents/delivrix app/.audit/system-context.txt" 2>/dev/null
# si no existe, el adapter usa DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md (también OK)
```

---

## Tarea 4 — Tests + tsc + smoke (~30 min)

### Tests

```bash
cd apps/gateway-api
node --test src/openclaw-bedrock-bridge.test.ts
# debe pasar todos
```

### tsc

```bash
npx --no-install tsc --noEmit
# 0 errores nuevos (los pre-existentes de main.ts/audit/schema/pg siguen — no regresión)
```

### Smoke E2E

```bash
# 1. Reiniciar gateway con nuevo .env.local (Juanes setteó env vars Bedrock):
kill <PID-gateway-anterior>
cd apps/gateway-api && pnpm dev

# 2. Health check:
curl -s http://localhost:3000/health | jq '.status'
# debe ser "ok"

# 3. Chat send:
curl -m 30 -X POST -H "Content-Type: application/json" \
  -d '{"msgId":"bedrock-smoke-'$(date +%s)'","message":"Hola OpenClaw, qué proveedores DNS tenemos hoy?","actorId":"codex-smoke"}' \
  http://localhost:3000/v1/openclaw/chat/send
# debe responder 200 con {"msgId":"...","queued":true}

# 4. Stream history (cli o WSS):
# Si el handler de history es WSS, abrir wscat:
wscat -c "ws://localhost:3000/v1/openclaw/chat/stream?msgId=<msgId del paso 3>"
# debe emitir ASSISTANT_TYPING + ASSISTANT_CHUNK + ASSISTANT_DONE con texto coherente sobre Route53/IONOS/Webdock.

# Si el handler es HTTP polling, usar:
curl http://localhost:3000/v1/openclaw/chat/history?msgId=<msgId>
```

**Criterio de aceptación:**
- Status 200 en `/chat/send`.
- Stream emite al menos `ASSISTANT_DONE` con texto >50 chars.
- La respuesta menciona contenido coherente del system prompt (gates, skills, proveedores DNS Route53/IONOS).
- Audit chain: `oc.chat.bedrock_invoked` o similar (agregar evento en handler).

---

## Tarea 5 — Reportar (~5 min)

Crear `DOCUMENTACION/OPS_CODEX_OPENCLAW_BEDROCK_DIRECT_2026_05_29_RESULT.md` con:

1. SHA del commit.
2. Archivos creados/modificados.
3. Output del smoke (status code + primeras 200 chars del ASSISTANT_DONE).
4. Costo aproximado de las pruebas (tokens × precio).
5. Si algo no levantó: error literal + propuesta.

Commit + push con mensaje:
```
feat(gateway): OpenClaw Bedrock direct bridge bypassing Hostinger

- @aws-sdk/client-bedrock-runtime added
- OpenClawBedrockBridge implements OpenClawSshBridge interface
- OPENCLAW_BRIDGE_KIND=bedrock activates direct AWS call
- System prompt loaded from .audit/system-context.txt with fallback
- Conversation memory in-process per sessionKey
- Smoke E2E green against Claude Sonnet 4.x in us-east-1
- Pre-existente bridge SSH queda como fallback si BRIDGE_KIND no es bedrock

Ref: REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md (gates respetados desde system prompt)
```

---

## Reglas duras

1. **NO toques `openclaw-ssh-bridge.ts`** — queda como fallback intacto.
2. **NO redeployes container Hostinger** — sigue out-of-scope.
3. **NO loguees el system prompt completo ni respuestas del modelo** en stdout — la audit chain debe registrar `tokens_in`, `tokens_out`, `model_id`, `latency_ms`, NO el contenido literal por privacidad operativa.
4. **NO toques el frontend** — el handler `/v1/openclaw/chat/send` ya está cableado y los eventos WSS ya se consumen en Canvas Live (el screenshot de Juanes con "Error del agente" confirma que el frontend solo necesita que el ACK sea válido).
5. **Si Bedrock devuelve 403** (modelo no habilitado): para el smoke + reporta. Juanes habilita el modelo en consola y vos reintentás.
6. **Si Juanes no pasó las env vars antes de las 3am COT**: NO arranques. Reportá y dormí.

---

## Fallback realista

Si por cualquier razón el smoke no queda verde antes de las 5am COT, **NO bloquear el push del trabajo de la noche** (carriles B/C/D, sender-pool wiring, UI input runtime, SMTP audit a KB). Esos van a main en `push_v5_backend_carriles_bcd.sh` y son demo-viables solos via skills directas. El Bedrock direct queda como mejora deseable, no condición.

Juanes despierta con 2 paths:
- A: Bedrock funciona → demo va con chat conversacional + skills directas (full experience).
- B: Bedrock no llegó → demo va solo con skills directas (plan B ya armado en PREFLIGHT_DEMO_VIERNES_10H).

— Claude
