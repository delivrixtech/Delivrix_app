# BRIEF CODEX — Chat de OpenClaw: conversaciones (sessionKey por chat) + adjuntos

Fecha: 2026-06-19 · Auditado por 3 subagentes senior de Claude (grounded, archivo:línea) · Ejecuta: **Codex con subagentes** · Rama base: `produ` (coordinar con el frontend que va en `feature/canvas-v5-preview`).

Dos features INDEPENDIENTES (PRs separados, en este orden): **A. Conversaciones** (desbloquea el sidebar) y **B. Adjuntos**. El frontend (sidebar, attach UI, stop) lo hace Claude contra estos contratos. NO escribir frontend.

## Invariante de regresión (la regla dura — no romper prod)
El bridge Bedrock es un **singleton de proceso** y hoy todo el chat va a **una sola conversación global** `sessionKey = "agent:main:operator"`. **Un request SIN los campos nuevos debe comportarse byte-idéntico a hoy.** Toda la feature es ADITIVA detrás de fallbacks. Los tests existentes (`openclaw-chat.test.ts`, `openclaw-ssh-bridge.test.ts`) que assertean `sessionKey === "agent:main:operator"` deben seguir pasando SIN tocarlos.

Anclar por **nombre de símbolo, no por línea** (las líneas se corren). Sin emojis en código. No exponer secretos ni loguear contenido crudo.

---

## PARTE A — Conversaciones (sessionKey por chat + persistencia + endpoints)

### Estado actual (VERIFICADO, no re-investigar)
- `sessionKey` es **global**: `defaultSessionKey = "agent:main:operator"` (`openclaw-bedrock-bridge.ts:55`), asignado en el constructor (`:227`); nadie pasa `config.sessionKey` desde `main.ts`. El proxy también lo hardcodea (`openclaw-chat.ts:20`, `:194`).
- El bridge elige la conversación **solo** por `this.sessionKey`: `this.conversations.get/set(this.sessionKey)` en `sendMessage` (`:267-268`) y `streamHistory` (`:332-333`). `conversations = new Map<string, ConversationTurn[]>()` (`:197`), 100% en RAM.
- El request del cliente NO transporta sessionKey: `ChatSendRequest` (`openclaw-chat.ts:50-56`) = `{ message?, text?, actor?, msgId?, operatorParams? }`. El handler `/v1/openclaw/chat/send` (`main.ts:1143-1190`) no toca ningún id de chat.
- **Ventaneo:** `trimConversation` (`:1031-1034`) conserva los últimos `maxConversationTurns` (default 40, `:59/:228`). Con multi-chat el cap pasa a ser **por-conversación** (mejora, no regresión).
- **NO hay persistencia a disco** del historial conversacional (confirmado: ningún `writeFile/appendFile` toca `conversations`). Reinicio del gateway = historial perdido.
- **NO hay endpoint de historial.** Solo `/chat/send` (`:1143`) y `/chat/interrupt` (`:1193`). El WS `/chat/stream` (`gateway-upgrade-router.ts:24`) ignora la URL/query (`openclaw-chat.ts:669`).
- **Patrón de persistencia a copiar:** `CanvasLiveEventService` (`services/canvas-live-events.ts`): `defaultStateDir` (`:29`), `ensureLoaded`/`loadFromDisk` con `readJsonl` (tolera líneas corruptas + archivo inexistente, `:1034-1056`), **write-queue serializado** `appendJsonl` (`:489-495`, EVITA corrupción concurrente — copiar literal).
- **Helper de título ya existe:** `summarizeCanvasTurnTitle(message)` (`openclaw-bedrock-bridge.ts:1130-1136`) colapsa whitespace y corta a 90 chars. Úsalo para el `title` derivado del primer mensaje del usuario.

### Landmine #1 (la clave): `streamHistory` solo conoce el `msgId`, no la conversación
`sendMessage(input)` recibe el request (y podría leer `conversationId`), pero el assistant turn se appendea en `streamHistory(msgId, …)` (`:292`/`:332-333`), que **NO recibe el request**. Si no se resuelve, el assistant turn cae en la conversación equivocada. **Solución:** un `Map<msgId, convKey>` que `sendMessage` setea y `streamHistory` lee; limpiarlo en el `finally` de `streamHistory` (`:347-351`) junto a los otros mapas por-msgId (`pendingResponses`, `pendingControllers`, `interruptedMsgIds`, `:198-200`).

### No-riesgos (confirmados — simplifican)
- `live-context` + system prompt se reconstruyen por turno desde cero (`fetchLiveContext` `:906`, `loadSystemPrompt` `:1013`) — **no hay cross-talk de prompt entre chats**. El único estado conversacional es el array de turns.
- Interrupt YA es por-`msgId` (`:282-290`), no por sesión → interrumpir el chat A no afecta el B. **No requiere cambios.**

### Plan por fases (Parte A)
**Fase A0 — Contrato (no-op funcional)**
- Añadir `conversationId?: unknown` a `ChatSendRequest` (`openclaw-chat.ts:50`).
- Helper `normalizeConversationId()` reusando el regex de `normalizeId` de canvas-live (`canvas-live-events.ts:1276`: `/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/`). Fallback `?? defaultSessionKey`.
- DoD: typecheck + tests existentes pasan sin tocar.

**Fase A1 — Keying por-conversación en RAM (sin disco)**
- En el bridge: `sendMessage` deriva `convKey = normalizeConversationId(input.conversationId) ?? this.sessionKey`; reemplazar `this.sessionKey` por `convKey` en `:267-268`. Setear `this.msgToConvKey.set(msgId, convKey)`.
- `streamHistory`: `convKey = this.msgToConvKey.get(msgId) ?? this.sessionKey` antes de `:332-333`; limpiar en el `finally`.
- DoD: test nuevo — dos `conversationId` mantienen historiales separados; sin `conversationId` usa el default (regresión byte-idéntica).

**Fase A2 — Persistencia a disco (patrón canvas-live)**
- Servicio nuevo `OpenClawChatHistoryStore` (espejo de `CanvasLiveEventService`): `stateDir = "state/openclaw-chat"` (env `OPENCLAW_CHAT_STATE_DIR`), **un archivo por conversación** `state/openclaw-chat/<convId>.jsonl` (simplifica listar + cap por-archivo), `ensureLoaded`/`loadFromDisk` con `readJsonl`, `appendTurn` con write-queue serializado, **cap-on-load** de los últimos N por conversación.
- El bridge recibe el store por config (como recibe `auditLog`/`canvasLiveEvents`, `:158-159`) e invoca `appendTurn` tras cada append in-memory; al boot, rehidrata `this.conversations`.
- DoD: test — escribir turns, instanciar store nuevo (simula restart), `loadFromDisk` recupera; líneas corruptas se saltan; cap respetado.

**Fase A3 — Endpoints de lectura (detrás del read-boundary token)**
- `GET /v1/openclaw/chat/conversations` → `{ id, title, updatedAt, preview }[]` (orden por `updatedAt` desc). `title` vía `summarizeCanvasTurnTitle` del primer user turn; `preview` = primeras N chars del último turn. Detrás de `sensitiveReadBoundaryToken` (espejo de `/v1/canvas/live/state`, `main.ts:1198`).
- `GET /v1/openclaw/chat/history?conversationId=…` → turns de esa conversación (espejo de `snapshot(taskId?)`).
- **"Nueva" = SIN endpoint:** el cliente genera un UUID y lo manda en el primer `send`; el `?? []` de `:267` ya hace lazy-create. (Opcional: `POST /conversations` para pre-crear fila vacía — no para MVP.)
- DoD: smoke E2E — crear 2 conversaciones, listar, traer historial de cada una, verificar aislamiento.

### Nit incluido en Parte A (bug pre-existente, ambos audits lo vieron)
`handleChatInterruptHttp` loguea `result.taskId` (`openclaw-chat.ts:1275`) pero `ChatInterruptResponse` (`:89-93`) **no tiene `taskId`** → bajo TS estricto es error de compilación; si compila, loguea `undefined`. Quitar/corregir.

---

## PARTE B — Adjuntos (imágenes + .md/.txt; .pdf en fase 2)

### Veredicto (VERIFICADO)
**Viable sin cambiar de API.** El SDK Bedrock (`3.1056.0`) + invocación `InvokeModelWithResponseStreamCommand` con payload Anthropic-native `anthropic_version: "bedrock-2023-05-31"` (`openclaw-bedrock-bridge.ts:801-817`) **ya soporta image blocks**. El path es text-only por construcción, no por límite del modelo.

### Estado actual (VERIFICADO)
- Text-only end-to-end. El **único** builder de `messages` (`:369-372`) emite `content: [{ type: "text", text: turn.content }]`. El union `BedrockContentBlock` (`:80-83`) solo tiene `text | tool_use | tool_result` — **no existe la variante `image`**.
- `/chat/send` parsea **JSON** (`readJson`, `main.ts:1145`), no multipart. `sanitizeOperatorMessage` (`openclaw-chat.ts:1392`) opera sobre string.
- **No hay lib de PDF** en `apps/gateway-api/package.json` (solo aws-sdk + imapflow). **No hay** sharp/libs de imagen. → .pdf NO en v1.

### Aclaración crítica del BUDGET (corrige un mito)
El cap de **11.800 tokens** (`scripts/openclaw/build-system-context.sh:324`) es **build-time del system prompt fijo**. Un adjunto va en el array `messages` (runtime, ventana ~200k de Sonnet), **NO en el system prompt**. Un `.md` grande **NO rompe el cap 11.800.** PERO compite con `max_tokens` de salida (4096), el `liveContext` (hasta 18k chars/turno, `:63`) y los 40 turnos. → **cap del texto adjunto ~20-50k chars**, no por el 11.800 (no trimear el prompt por esto).

### Plan por fases (Parte B)
**Fase B1 — Imágenes + texto plano (IMPRESCINDIBLE v1)**
1. `ChatSendRequest` (`openclaw-chat.ts:50`) += `attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>`.
2. Union `BedrockContentBlock` (`:80-83`) += variante `image` (`{ type:"image"; source:{ type:"base64"; media_type; data } }`). NOTA: existe también `MutableBedrockContentBlock` (`:1097`) usado en el parse de la **respuesta/output**; la imagen va en el **input** (`BedrockContentBlock`, el builder de `:371`), así que en principio no hace falta tocar el mutable — pero verificalo si el builder lo referencia.
3. Propagar adjuntos por `ChatProxy.sendMessage` (`:216-244`) y `Bridge.sendMessage` (`:255-280`) SIN pasarlos por `sanitizeOperatorMessage` crudo; el `ConversationTurn` (`:67-70`) lleva un campo paralelo `attachments`.
4. Builder `:369-372`: texto (.md/.txt) → prepend al text block **envuelto en delimitadores** (`<attached_file name="…">…</attached_file>`, defensa anti prompt-injection) con cap ~20-50k chars; imágenes → push de image block(s).
5. **Seguridad (todo nuevo):** allowlist de MIME por **magic bytes** (no confiar en extensión ni en el mimeType del cliente) — imágenes `image/png|jpeg|webp|gif`, texto `text/plain|text/markdown`; **rechazar HEIC y SVG**; caps (img ≤5 MB pre-base64, ≤3 imgs/turno, texto ≤50k chars); sanitizar `name` (reusar el patrón `replace(/[^a-zA-Z0-9_.:-]/g,"-").slice(0,96)` de `:1126`); **nunca loguear `data`** (loguear count/bytes/mime, como `main.ts:1152` que ya solo loguea `messageChars`).
6. DoD: turno con imagen → el modelo la cita; turno con `.md` → la usa como contexto; archivo no permitido → 400 limpio sin tumbar el chat (patrón degradado de `main.ts:1160-1177`); logs sin contenido; **el build de system-context NO se toca**.

**Fase B2 — .pdf (NICE-TO-HAVE)**: agregar dep de extracción (`pdf-parse`/`pdfjs-dist`), extraer texto, mismo pipeline de texto. Documentar la dep.

### Coordinación con el frontend (Claude)
- Transporte = **base64 en el body JSON** (sin multipart, sin endpoint nuevo). El frontend manda `attachments[]`.
- **HEIC:** las capturas del operador son `.heic` (no soportado por Claude) — el frontend convierte a PNG/JPEG antes de subir, o el backend rechaza por allowlist. Acordar.
- El frontend respeta los caps de tamaño del lado cliente.

---

## DoD global + cómo (profesional)
- **Subagentes Codex:** (1) Parte A RAM+contrato, (2) Parte A persistencia+endpoints, (3) Parte B adjuntos, (4) tests/QA.
- `node --test` de gateway-api verde + `node --check src/main.ts`. Tests existentes intactos.
- Backward-compat: sin `conversationId` y sin `attachments`, comportamiento byte-idéntico a hoy.
- PRs separados: **A primero** (desbloquea el sidebar), B después.
- Coordinación: avisá cuando cada contrato esté mergeado para que Claude cablee el frontend (sidebar, attach UI) contra lo real.

### Archivos clave (absolutos)
- `/Users/juanescanar/Documents/delivrix app/apps/gateway-api/src/openclaw-bedrock-bridge.ts` — Map conversaciones, sendMessage/streamHistory, trim, builder de messages, union de content blocks, title helper.
- `/Users/juanescanar/Documents/delivrix app/apps/gateway-api/src/openclaw-chat.ts` — `ChatSendRequest`, proxy, handlers HTTP, `OPENCLAW_CHAT_SESSION_KEY`, nit `taskId:1275`.
- `/Users/juanescanar/Documents/delivrix app/apps/gateway-api/src/main.ts` — rutas send/interrupt (1143/1193), wiring del bridge (399), read-boundary (1198).
- `/Users/juanescanar/Documents/delivrix app/apps/gateway-api/src/services/canvas-live-events.ts` — patrón de persistencia a copiar (ensureLoaded/loadFromDisk/appendJsonl/readJsonl/write-queue).
