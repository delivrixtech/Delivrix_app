# OPS — Chat Live OpenClaw en el admin panel

**Fecha:** 2026-05-20
**Sub-hito:** Hito 5.11.C · Chat live operador ↔ OpenClaw desde el admin panel (gap nuevo, no parche)
**Worktree:** `feature/chat-live-openclaw`
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Regla rectora:** `port 1:1 no interpretacion` para el widget visual. Backend proxy respeta el contrato `OPENCLAW_DELIVRIX_API_CONTRACT.md` §3 (Dirección A).

## 1. Contexto

Hoy la interacción operador ↔ OpenClaw vive **fuera** del admin panel (CLI / Kiro / Claude Code). El componente actual `apps/admin-panel/src/shared/ui/openclaw-prompt-panel.tsx` es **decorativo** — su comentario lo dice literal: *"El input es READ-ONLY visual; el panel NO postea nada."*

Para el demo MVP y operación real es crítico que el operador pueda hablarle al agente directamente desde el panel. El contrato existe (`OPENCLAW_DELIVRIX_API_CONTRACT.md` §3) pero nunca se implementó.

## 2. Scope

**Dentro:**

- Backend gateway: 2 endpoints proxy hacia OpenClaw container Hostinger (`2.24.223.240:61175`):
  - `POST /v1/openclaw/chat/send` → proxy a `POST /api/chat.send` del agente
  - `WSS /v1/openclaw/chat/stream` → proxy a `WSS /api/chat.stream` del agente
- Auth: gateway agrega `Bearer ${OPENCLAW_GATEWAY_TOKEN}` (env var en `.env.local`) al proxy. El frontend NO necesita conocer el token del agente.
- Frontend: nuevo componente `<ChatWidget />` en panel — drawer lateral o tab dedicada, decisión visual.
- WSS client con reconexión + buffering de mensajes.
- Sesión persistente: `sessionKey: "agent:main:operator"` (un solo canal compartido por todos los operadores que estén en el panel).
- Audit: cada mensaje del operador emite `oc.chat.operator_message`, cada respuesta del agente emite `oc.chat.agent_response`. Hash chain respetada.

**Fuera:**

- Sesiones múltiples concurrentes (operador A vs B en sesiones distintas). En MVP, 1 sesión compartida.
- Persistencia de historial > sesión actual. El historial se reconstruye desde audit log cuando se necesite (Hito 5.12+).
- Acciones supervisadas desde chat. Si el agente propone, sigue pasando por `/v1/agent/proposals` y aterriza en Canvas como hoy. El chat es para conversación; las propuestas operativas siguen el flujo existente.
- Voice / multimodal.

## 3. Backend gateway

### 3.1 `POST /v1/openclaw/chat/send`

```
Headers (operador → gateway):
  Content-Type: application/json
  (sin auth especial — el panel ya está dentro del read-boundary)

Body (operador → gateway):
{
  "message": "string natural del operador",
  "msgId": "<uuid v4>"  // opcional, gateway genera si no viene
}

Gateway hace POST a:
  http://2.24.223.240:61175/api/chat.send
  Headers: { Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}, Content-Type: application/json }
  Body: {
    "sessionKey": "agent:main:operator",
    "msgId": "<uuid>",
    "message": { "role": "user", "content": <message> },
    "context": {
      "delivrix_endpoint_token": "<bearer scope agent:read-only, TTL 15min>",
      "delivrix_base_url": "http://gateway.delivrix.local:3000"
    }
  }

Respuesta gateway → operador:
{
  "msgId": "<uuid>",
  "queued": true
}

Audit emitido por gateway: `oc.chat.operator_message` con metadata { msgId, sessionKey, length: message.length }
```

### 3.2 `WSS /v1/openclaw/chat/stream`

Gateway abre un WSS hacia `ws://2.24.223.240:61175/api/chat.stream?token=${OPENCLAW_GATEWAY_TOKEN}` y multiplexa los mensajes a todos los clientes panel conectados.

Eventos del WSS hacia panel:

```ts
type ChatStreamEvent =
  | { type: "HEARTBEAT", at: string }
  | { type: "ASSISTANT_DELTA", msgId: string, delta: string }
  | { type: "ASSISTANT_DONE", msgId: string, content: string, audit?: { skillsInvoked: string[], tokensUsed?: number, durationMs?: number }, proposals?: object[] }
  | { type: "ERROR", msgId?: string, error: string }
  | { type: "AGENT_OFFLINE" };  // si gateway pierde conexión con agente
```

Estrategia de reconexión cliente: exponential backoff (1s, 2s, 4s, 8s, max 30s). Mostrar status visual cuando reconectando.

Audit emitido por gateway al recibir `ASSISTANT_DONE`: `oc.chat.agent_response` con metadata { msgId, sessionKey, contentLength, skillsInvoked, tokensUsed }.

## 4. Frontend — `<ChatWidget />`

### 4.1 Ubicación visual

**Opción A (recomendada):** Drawer lateral derecho fixed, ancho 380px, height 100vh menos topbar. Toggle button en topbar (icono `chat_bubble` o similar). Persiste estado abierto/cerrado en localStorage.

**Opción B:** Tab dedicada en sidebar ("Chat con OpenClaw") con full panel layout.

Mi recomendación: **A** porque permite que el operador trabaje en otras secciones mientras conversa con el agente. Codex decide final si la implementación de drawer es trivial vs tab.

### 4.2 Estructura del componente

```
<ChatWidget>
  <ChatHeader />            // título "Chat con OpenClaw", botón cerrar drawer, status pill (online/offline/reconnecting)
  <ChatMessages>            // scroll vertical, anclado al bottom
    <MessageItem role="user|assistant" content={...} timestamp={...} />
    ...
    <ChatStreaming visible={isAssistantStreaming} />  // typing indicator
  </ChatMessages>
  <ChatInput>
    <textarea placeholder="Pregúntale a OpenClaw..." />
    <SendButton disabled={sending || offline} />
    <ChatMetaRow>
      <SessionInfo>sessionKey: agent:main:operator</SessionInfo>
      <CharCount />
    </ChatMetaRow>
  </ChatInput>
</ChatWidget>
```

### 4.3 State management

```ts
interface ChatState {
  messages: ChatMessage[];  // { role, content, timestamp, msgId? }
  streaming: { msgId: string, deltaSoFar: string } | null;
  connection: "connected" | "reconnecting" | "offline";
  lastError: string | null;
}
```

Cliente WSS centralizado en `apps/admin-panel/src/shared/api/chat-client.ts` (singleton, reconexión auto, observable via React hook `useChatStream()`).

### 4.4 Cuando agente offline

- Header status pill: amber "Reconectando…" / red "Agente offline"
- Mensajes del operador se quedan en queue (con indicador "Pendiente de envío")
- Cuando reconecta, flushea queue automáticamente

## 5. Pencil component nuevo

Yo (Claude) diseño en Pencil un nuevo component `<ChatWidget />` basado en `onENN` (Tarjeta de prompt OpenClaw) existente, expandido a:

- Container drawer 380×fullHeight
- Header con avatar OpenClaw + status pill
- Messages scrollable con burbujas role-aware
- Input textarea + send button
- Reusar tokens existentes (`$accent-tertiary` para acentos, `$state-success`/`$state-warning` para status pills)

**Si el bug de Pencil layout vuelve a aparecer:** seguir el patrón `v2 self-contained` — embed JSON literal en este OPS para que Codex no dependa de Pencil MCP.

## 6. Tokens (todos ya existen)

Reusar paleta del Hito 5.10. Para status pills del chat: `$state-success` (conectado), `$state-warning` (reconectando), `$state-critical` (offline). Para burbujas: `$surface-secondary` (operador) vs `$surface-tertiary` (agente).

## 7. Verificación

1. `npm test` debe seguir verde.
2. `npm run test:admin` debe seguir verde + tests nuevos para:
   - Render del ChatWidget cerrado/abierto
   - Render mensajes (snapshot)
   - State management de streaming (delta acumulación)
   - Reconexión simulada
3. `npm run build` sin errores TS.
4. Smoke E2E manual:
   - Abrir panel, abrir drawer chat
   - Escribir "¿qué gates tiene el MVP?" (criterio §4.2 v3.0)
   - Esperar streaming response
   - Verificar que llega completo + audit muestra `oc.chat.operator_message` y `oc.chat.agent_response`
   - Apagar gateway → pill cambia a "Offline" → queue de mensajes funcional
5. `verify-chain.ts` sigue verde después de varios intercambios.

## 8. Restricciones

- **No** modificar Ola 1 Safety ni Ola 2 Learning (ya cerradas).
- **No** tocar los OPS del tokenization cleanup (worktree separado).
- **No** exponer `OPENCLAW_GATEWAY_TOKEN` al frontend.
- **No** persistir el historial de chat fuera del audit log (sin nueva DB).
- **No** implementar acciones supervisadas desde chat — esas siguen pasando por `/v1/agent/proposals` + flujo Canvas existente.
- **No** soportar sesiones múltiples — 1 sesión compartida `agent:main:operator` en MVP.

## 9. Reporte esperado al terminar

```
CHAT LIVE OPENCLAW — implementado

backend:
  - POST /v1/openclaw/chat/send (proxy + audit oc.chat.operator_message)
  - WSS /v1/openclaw/chat/stream (multiplex + audit oc.chat.agent_response)
  - reconexión gateway↔agente: exp backoff
frontend:
  - apps/admin-panel/src/features/chat/ChatWidget.tsx
  - apps/admin-panel/src/shared/api/chat-client.ts (singleton WSS)
  - Drawer lateral derecho con toggle en topbar
tests: <N>/<N> verdes (X nuevos chat)
build vite: OK
smoke E2E: pregunta operador → streaming → respuesta → audit chain OK
verify-chain: events_total=N, chain_ok=N, OK

next action: operator review
```

## 10. Commits sugeridos

1. `docs: add OpenClaw chat live spec`
2. `feat(gateway): proxy POST /v1/openclaw/chat/send to Hostinger agent`
3. `feat(gateway): WSS proxy /v1/openclaw/chat/stream with multiplex`
4. `feat(panel): add ChatWidget drawer with WSS client and message state`
5. `feat(panel): wire ChatWidget toggle in Topbar + persist open state in localStorage`
6. `test(panel): cover ChatWidget render and state transitions`
7. `test(gateway): cover chat send + stream audit emission`

## 11. Referencias

- Contrato API ya documentado: `DOCUMENTACION/OPENCLAW_DELIVRIX_API_CONTRACT.md` §3 (Dirección A)
- Audit integration: `DOCUMENTACION/OPENCLAW_AUDIT_INTEGRATION.md`
- Componente Pencil existente como base: `onENN` (Tarjeta de prompt OpenClaw)
- Componente React decorativo actual: `apps/admin-panel/src/shared/ui/openclaw-prompt-panel.tsx` (referencia, NO modificar; el nuevo widget vive en `features/chat/`)
- Audit chain (debe seguir verde): `scripts/audit/verify-chain.ts`
