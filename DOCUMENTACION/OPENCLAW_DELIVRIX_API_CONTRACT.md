# OpenClaw ↔ Delivrix — API Contract

Fecha: 2026-05-18 (v2.0 expansión 2026-05-18).
Hito rector: `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md`.
Permisos: `OPENCLAW_PERMISSIONS_MATRIX.md`. Skills: `OPENCLAW_SKILLS_CATALOG.md`.

## Changelog

- **v1.0** — 3 direcciones de tráfico, secrets, schemas descriptivos.
- **v2.0** — JSON Schemas formales (OpenAPI 3.1 fragmento), enumeración exhaustiva de códigos de error, handshake WebSocket paso a paso con secuencia, retry/backoff cuantificado.

## 1. Propósito

Definir literalmente cómo se hablan los dos sistemas:

- **Delivrix Gateway** corre en el servidor físico Popayán (eventualmente; hoy local).
- **OpenClaw agent** corre en VPS Hostinger `2.24.223.240:61175`.

Toda comunicación es HTTP/HTTPS o WebSocket. El bundle frontend del admin panel sigue
GET-only contra el read-boundary — este contrato describe el plano **entre servicios**,
no el plano panel↔gateway.

## 2. Topología y direcciones de tráfico

```
                    ┌─────────────────────────────────────┐
                    │    Admin panel (Vite, GET-only)     │
                    │  apps/admin-panel  →  read-boundary │
                    └────────────────┬────────────────────┘
                                     │ GET only
                                     ▼
   ┌───────────────────────────────────────────────────┐
   │       Delivrix Gateway (Popayán / local)          │
   │   apps/gateway-api  ·  Bearer auth interno        │
   └──────┬───────────────────────────────────┬────────┘
          │  Dirección B                       │  Dirección A
          │  (agent lee + propone)             │  (gateway pregunta)
          │  HTTP GET read-boundary            │  HTTP POST + WSS
          │  + POST /v1/openclaw/proposal      │  /api/chat.send
          ▼                                    ▼
   ┌───────────────────────────────────────────────────┐
   │   OpenClaw Agent (Hostinger 2.24.223.240:61175)   │
   │   container ghcr.io/hostinger/hvps-openclaw       │
   │   gateway interno 127.0.0.1:18789                 │
   └───────────────────────────────────────────────────┘
                                     │
                                     ▼  Dirección C
                              Notion Task Board /
                              Daily Standup DB
                              (Agent Integration
                              Guide, Doc 8)
```

## 3. Dirección A — Delivrix Gateway → OpenClaw

**Usado cuando:** un operador hace una consulta natural ("¿cómo va warming?") desde
el admin panel, o cuando un cron del Gateway pide al agente generar reporte diario.

| Acción | Método | Path OpenClaw | Auth | Cuerpo |
| --- | --- | --- | --- | --- |
| Enviar chat | `POST` | `http://2.24.223.240:61175/api/chat.send` | `Bearer ${OPENCLAW_GATEWAY_TOKEN}` | `{ sessionKey, message, msgId }` |
| Suscribirse a eventos | `WSS` | `ws://2.24.223.240:61175/api/chat.stream` | Bearer en query `?token=` o header inicial | Mensajes `HEARTBEAT_OK`, `ASSISTANT_DELTA`, `ASSISTANT_DONE`, `ERROR` |
| Estado de sesión | `GET` | `http://2.24.223.240:61175/api/sessions/<key>` | Bearer | — |

`OPENCLAW_GATEWAY_TOKEN` vive en `.env.local` del Gateway. **Nunca en repo, nunca en chat.**

Schema del request `chat.send`:

```json
{
  "sessionKey": "agent:main:main",
  "msgId": "<uuid v4>",
  "message": {
    "role": "user",
    "content": "string natural del operador"
  },
  "context": {
    "delivrix_endpoint_token": "<bearer que OpenClaw usará para llamar de regreso>",
    "delivrix_base_url": "http://gateway.delivrix.local:3000"
  }
}
```

Schema de respuesta esperada (`ASSISTANT_DONE` por WSS):

```json
{
  "msgId": "<uuid>",
  "sessionKey": "agent:main:main",
  "assistant": {
    "content": "markdown estructurado",
    "skillsInvoked": ["delivrix-fleet-ops"],
    "proposals": [{ "category": "node_pause_proposed", "...": "..." }],
    "audit": { "evidenceRefs": ["..."], "duration_ms": 1234 }
  }
}
```

## 4. Dirección B — OpenClaw → Delivrix Gateway

**Usado cuando:** una skill del agente lee del read-boundary o inyecta una propuesta
nueva al `prompt` del Canvas.

### 4.1 Lectura (GET-only del read-boundary)

Los 28 endpoints actuales del read-boundary (ver `apps/admin-panel/src/shared/api/read-boundary.ts`)
son los **únicos** que el agente puede llamar.

| Acción | Método | Path Delivrix | Auth | Notas |
| --- | --- | --- | --- | --- |
| Cualquier read action de la matriz | `GET` | `/v1/<resource>` | `Bearer ${DELIVRIX_OPENCLAW_TOKEN}` | Token con scope `agent:read-only` |

`DELIVRIX_OPENCLAW_TOKEN` se genera en el Gateway Delivrix y se inyecta al `context`
del request en Dirección A (campo `delivrix_endpoint_token`). Vida útil: 15 min.

### 4.2 Inyección de propuestas (POST privado, NO en read-boundary)

El agente envía propuestas al Gateway por un endpoint **privado** que el bundle
frontend nunca llama. Esto preserva GET-only del panel.

| Acción | Método | Path Delivrix | Auth | Cuerpo |
| --- | --- | --- | --- | --- |
| Submit proposal | `POST` | `/v1/agent/proposals` (privado, no expuesto al panel) | HMAC `X-OpenClaw-Signature` + `X-OpenClaw-Timestamp` | ver schema abajo |

```json
{
  "proposal": {
    "id": "<uuid>",
    "category": "node_pause_proposed | node_resume_proposed | warming_step_proposed | ...",
    "severity": "low | medium | high",
    "headline": "string corto",
    "body": "string explicativo",
    "evidenceRefs": ["<hashes audit>"],
    "runbookRef": "warming-step-runbook.md",
    "targetRef": "<nodeId|slug|domain>",
    "delivrix_actions_required": ["propose_warming_step"]
  },
  "audit": {
    "skillSlug": "delivrix-publish-proposal",
    "modelVersion": "us.anthropic.claude-sonnet-4-6",
    "promptVersion": "v1",
    "tokensUsed": 1234
  },
  "schemaVersion": "2026-05-18.v1"
}
```

El Gateway:

1. Valida `delivrix_actions_required` contra `OPENCLAW_PERMISSIONS_MATRIX.md`.
2. Si OK → persiste la propuesta y la inyecta en el siguiente `GET /v1/openclaw/live-canvas`
   como `canvas.prompt`.
3. Audita con `oc.proposal.submitted`.
4. Si falla la validación → devuelve `403` con código de rechazo (`prohibited_action`,
   `unknown_action`, `live_blocked_hito_5_11_b`).

**El agente nunca llama POST a otros endpoints del Gateway.** Solo `/v1/agent/proposals`.
Las aprobaciones humanas usan únicamente `POST /v1/openclaw/proposals/{id}/sign`.
Las rutas legacy `/v1/agent/proposals/{id}/approve`, `/v1/agent/runbook/execute`
y `/v1/agent/runbook/revert` están deprecadas y devuelven
`410 canonical_hmac_signature_required`.

### 4.3 Firma HMAC para POST privados del agente

Todo `POST` privado del agente (`/v1/agent/proposals`, `/v1/agent/audit/batch`
si está habilitado) se firma con HMAC-SHA256. La firma de aprobación humana vive
en `POST /v1/openclaw/proposals/{id}/sign` y usa la misma disciplina HMAC salvo
modo panel local explícito.
La lectura `GET` sigue usando `Bearer ${DELIVRIX_OPENCLAW_TOKEN}`.

Headers obligatorios:

| Header | Valor |
| --- | --- |
| `X-OpenClaw-Timestamp` | Epoch seconds (`date +%s`), no ISO-8601 |
| `X-OpenClaw-Signature` | Hex HMAC-SHA256 bare, sin prefijo `sha256=` |

Canonical string:

```text
${timestamp}.${rawBody}
```

Donde `rawBody` es exactamente el JSON compacto enviado por HTTP. El Gateway
rechaza con `401 hmac_missing`, `401 hmac_invalid`, `401 hmac_timestamp_invalid`
o `401 hmac_timestamp_expired` antes de tocar el store.

Ejemplo de generación:

```bash
ts="$(date +%s)"
raw='{"proposal":{...},"audit":{...},"schemaVersion":"2026-05-18.v1"}'
sig="$(printf '%s' "${ts}.${raw}" \
  | openssl dgst -sha256 -hmac "$OPENCLAW_HMAC_SECRET" -binary \
  | od -An -tx1 | tr -d ' \n')"

curl -X POST "$DELIVRIX_GATEWAY_URL/v1/agent/proposals" \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Timestamp: $ts" \
  -H "X-OpenClaw-Signature: $sig" \
  --data-binary "$raw"
```

No usar el token Bearer de lectura para `/v1/agent/proposals`. Ese token queda
reservado para reads del read-boundary.

## 5. Dirección C — OpenClaw → Notion

Cuando una skill emite reporte diario o flag de incidente, el agente escribe a Notion
usando las DBs documentadas en el **Agent Integration Guide** (página Notion existente
[34b7932c-3b42-810a-b084-e11f0e5e5e85](https://www.notion.so/34b7932c3b42810ab084e11f0e5e5e85)).

| Skill | Notion DB | Endpoint |
| --- | --- | --- |
| `delivrix-report-ops` | `📝 Daily Standup` (`2ce92c3910bd4b8a8f2b1e031a36a749`) | `POST https://api.notion.com/v1/pages` |
| `delivrix-alert-ops` (issue detectado) | `🐛 Bugs & Blockers` (`75c53a45c1d94376910904ca03e5268e`) | `POST https://api.notion.com/v1/pages` |

Auth: `NOTION_API_KEY` env del container OpenClaw, scope read+write+insert sobre las
DBs declaradas. La key no rota desde el agente — solo el operador la rota desde
[notion.so/my-integrations](https://www.notion.so/my-integrations).

Detalle de payloads en Doc 8 (`OPENCLAW_AUDIT_INTEGRATION.md`).

## 6. Auth y secret management

| Secret | Vive en | Lo usa | Quién lo rota |
| --- | --- | --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | `.env.local` del Gateway Delivrix | Gateway llama a OpenClaw | Operador (regenera desde la UI de OpenClaw) |
| `DELIVRIX_OPENCLAW_TOKEN` | Env del container OpenClaw | OpenClaw llama al Gateway | Operador (regenera en `apps/gateway-api/src/auth.ts`) |
| `OPENCLAW_HMAC_SECRET` | `.env.local` del Gateway + `/etc/openclaw/skills.env` | Firma POST privados del agente | Operador (rota coordinando Gateway y container) |
| `NOTION_API_KEY` | Env del container OpenClaw | OpenClaw escribe a Notion DBs | Operador (regenera en notion.so/my-integrations) |
| `ANTHROPIC_API_KEY` / Hostinger AI credits | hPanel Hostinger / env del container | OpenClaw para LLM | Operador (rota desde provider) |

**Reglas:**

- Ningún secret en repo (`.env.local` está en `.gitignore`).
- Ningún secret en chat ni en logs.
- Rotación trimestral mínima. Inmediata si hay leak sospechado.

## 7. Rate limits y backoff

| Dirección | Límite | Política |
| --- | --- | --- |
| Gateway → OpenClaw | 1 chat.send / 2s por sessionKey | Backoff exponencial (2s, 4s, 8s, max 30s) |
| OpenClaw → Gateway (read) | 60 req / minuto por skill | Cache local en el container, TTL 30s |
| OpenClaw → Gateway (proposals) | 10 proposals / minuto | Si excede → drop + audit `oc.proposal.rate_limited` |
| OpenClaw → Notion | 3 req/seg (límite Notion) | `time.sleep(0.4)` entre batch |

## 8. Manejo de errores

| Escenario | Acción |
| --- | --- |
| Gateway no responde (timeout 5s) | OpenClaw skill cae a fallback declarado (Doc 3) y audita `oc.skill.gateway_timeout` |
| OpenClaw no responde (no `HEARTBEAT_OK` en 30s) | Gateway marca sesión como `failed`, retorna error 503 al panel, agent UI muestra "agent offline, datos del rules engine local" |
| Bearer de lectura expirado | Refresh automático vía `POST /v1/auth/refresh` en Gateway. Si falla 3 veces → audit `oc.auth.refresh_failed` + alerta operador |
| HMAC ausente o inválido | Gateway devuelve `401` con `hmac_missing`, `hmac_invalid`, `hmac_timestamp_invalid` o `hmac_timestamp_expired`; la skill no reintenta mutando headers |
| Proposal rechazada | Gateway devuelve `403` con código. OpenClaw reintenta solo si código es `transient` (rare). Otros códigos → no reintenta, audita |
| Kill switch armado | Gateway rechaza todo POST (proposals, supervised actions) con `423 Locked`. Solo permite reads |

## 9. Versionado del contrato

- Schema version actual: `2026-05-18.v1`.
- Cambios menores (campos nuevos opcionales): bump patch.
- Cambios mayores (campos obligatorios nuevos, breaks): bump major + sección de
  migración en este doc.
- El campo `schemaVersion` viaja en cada payload de proposal y chat. Cliente y server
  validan compatibilidad.

## 10. Gates duros

- El bundle frontend nunca llama `POST /v1/agent/proposals`. Solo el agente.
- El agente nunca llama `POST` a endpoints fuera de `/v1/agent/proposals`.
- La ejecución supervisada no se autoriza por `/v1/agent/runbook/execute`;
  primero debe existir firma canónica `oc.proposal.signed`.
- Con `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE` ausente/OFF, la aprobación es por
  propuesta/paso. Con el flag ON, una PlanApproval firmada queda atada a
  `runId/domain/provider/budgetUsdMax/testEmailRecipient` y no desbloquea acciones
  `future_live_requires_new_phase`.
- `delivrix_actions_required` en cada proposal se valida contra la matriz **antes**
  de persistir. Sin excepciones.
- El token `DELIVRIX_OPENCLAW_TOKEN` es short-lived y solo autoriza reads.
- Los POST privados del agente usan HMAC con tolerancia de 60s.
- WebSocket cae → Gateway no asume estado; pide al agente el último estado vía
  `GET /api/sessions/<key>` al reconectar.

## 11. OpenAPI 3.1 — fragmento formal (v2.0)

```yaml
openapi: 3.1.0
info:
  title: Delivrix Gateway ↔ OpenClaw Contract
  version: 2026-05-18.v1

paths:
  /v1/agent/proposals:
    post:
      summary: Submit proposal from OpenClaw agent
      operationId: submitAgentProposal
      security:
        - openClawHmac: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AgentProposalRequest'
      responses:
        '200':
          description: Proposal accepted and injected into canvas.prompt
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AgentProposalAccepted'
        '403':
          description: Proposal rejected by permissions matrix
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AgentProposalRejected'
        '401':
          description: Missing or invalid HMAC signature
        '423':
          description: Kill switch armed, only reads permitted
        '429':
          description: Rate limit exceeded

  /v1/openclaw/proposals/{proposalId}/sign:
    post:
      summary: Canonical human ApprovalGate signature
      operationId: signOpenClawProposal
      security:
        - openClawHmac: []
      parameters:
        - name: proposalId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Proposal signed and executed synchronously
        '202':
          description: Proposal signed and execution still running
        '401':
          description: Missing or invalid HMAC signature
        '409':
          description: Proposal not pending or binding mismatch
        '422':
          description: PlanApproval scope missing when autonomy flag is enabled
        '423':
          description: Kill switch armed

  /v1/agent/runbook/execute:
    post:
      deprecated: true
      summary: Deprecated legacy runbook execute route
      operationId: executeRunbookDeprecated
      responses:
        '410':
          description: canonical_hmac_signature_required

  /v1/agent/runbook/revert:
    post:
      deprecated: true
      summary: Deprecated legacy runbook revert route
      operationId: revertRunbookDeprecated
      responses:
        '410':
          description: canonical_hmac_signature_required

  /v1/agent/audit/batch:
    post:
      summary: Push audit events from OpenClaw to Delivrix
      operationId: pushAuditBatch
      security:
        - bearerToken: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AuditBatchRequest'
      responses:
        '200':
          description: Events processed (per-event accept/reject in body)
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AuditBatchResult'

components:
  securitySchemes:
    bearerToken:
      type: http
      scheme: bearer
      bearerFormat: JWT-like or opaque token
    openClawHmac:
      type: apiKey
      in: header
      name: X-OpenClaw-Signature
      description: HMAC-SHA256 hex over `${X-OpenClaw-Timestamp}.${rawBody}`.

  schemas:
    AgentProposalRequest:
      type: object
      required: [proposal, audit]
      properties:
        proposal:
          $ref: '#/components/schemas/Proposal'
        audit:
          $ref: '#/components/schemas/ProposalAuditMeta'
        schemaVersion:
          type: string
          const: '2026-05-18.v1'

    Proposal:
      type: object
      required:
        - id
        - category
        - severity
        - headline
        - body
        - evidenceRefs
        - runbookRef
        - targetRef
        - delivrix_actions_required
      properties:
        id:
          type: string
          format: uuid
        category:
          type: string
          enum:
            - node_pause_proposed
            - node_resume_proposed
            - node_register_proposed
            - node_orphan_warning
            - node_quarantine_proposed
            - warming_step_proposed
            - dns_rotation_proposed
        severity:
          type: string
          enum: [low, medium, high, critical]
        headline:
          type: string
          maxLength: 120
        body:
          type: string
          maxLength: 2000
        evidenceRefs:
          type: array
          items: { type: string }
          maxItems: 20
        runbookRef:
          type: string
          pattern: '^[a-z0-9-]+-runbook\.md$'
        targetRef:
          type: string
        delivrix_actions_required:
          type: array
          items: { type: string }
          minItems: 1

    ProposalAuditMeta:
      type: object
      required: [skillSlug, modelVersion, promptVersion]
      properties:
        skillSlug: { type: string }
        modelVersion: { type: string }
        promptVersion: { type: string }
        tokensUsed: { type: integer, minimum: 0 }

    AgentProposalAccepted:
      type: object
      properties:
        proposalId: { type: string, format: uuid }
        injectedIntoCanvas: { type: boolean }
        notionTicketUrl: { type: string, format: uri }

    AgentProposalRejected:
      type: object
      properties:
        rejectReason:
          type: string
          enum:
            - unknown_action
            - prohibited_action
            - live_blocked_hito_5_11_b
            - schema_mismatch
            - rate_limit_exceeded
            - duplicate_proposal
        details: { type: string }

    RunbookExecuteRequest:
      type: object
      required: [runbookId, targetType, targetId, approvalTokens]
      properties:
        runbookId: { type: string }
        targetType: { type: string }
        targetId: { type: string }
        approvalTokens:
          type: array
          items: { $ref: '#/components/schemas/ApprovalToken' }
          minItems: 1
          maxItems: 4
        metadata: { type: object, additionalProperties: true }

    ApprovalToken:
      type: object
      required:
        - tokenId
        - actionId
        - targetType
        - targetId
        - approverId
        - issuedAt
        - expiresAt
        - nonce
        - signature
      properties:
        tokenId: { type: string, format: uuid }
        actionId: { type: string }
        targetType: { type: string }
        targetId: { type: string }
        approverId: { type: string }
        issuedAt: { type: string, format: date-time }
        expiresAt: { type: string, format: date-time }
        nonce: { type: string, pattern: '^[a-f0-9]{64}$' }
        signature: { type: string, pattern: '^[a-f0-9]{64}$' }

    RunbookExecuteResult:
      type: object
      properties:
        runbookId: { type: string }
        executionId: { type: string, format: uuid }
        rollbackToken: { type: string, format: uuid }
        postconditionsVerified: { type: boolean }
        auditEventId: { type: string, format: uuid }

    RunbookRevertRequest:
      type: object
      required: [rollbackToken, approverIds, reason]
      properties:
        rollbackToken: { type: string, format: uuid }
        approverIds:
          type: array
          items: { type: string }
          minItems: 1
        reason: { type: string }

    AuditBatchRequest:
      type: object
      required: [batchId, events]
      properties:
        batchId: { type: string, format: uuid }
        events:
          type: array
          items: { $ref: '#/components/schemas/AuditEvent' }
          maxItems: 100

    AuditEvent:
      type: object
      required:
        - id
        - occurredAt
        - actorType
        - actorId
        - action
        - targetType
        - targetId
        - decision
        - schemaVersion
        - prevHash
        - hash
      properties:
        id: { type: string, format: uuid }
        occurredAt: { type: string, format: date-time }
        actorType: { type: string, enum: [openclaw, operator, system, collector] }
        actorId: { type: string }
        action: { type: string }
        targetType: { type: string }
        targetId: { type: string }
        decision: { type: string, enum: [allow, reject, n/a] }
        rejectReason: { type: string, nullable: true }
        humanApproved: { type: boolean }
        approverIds: { type: array, items: { type: string } }
        killSwitchState: { type: string, enum: [armed, active, unknown] }
        rollbackToken: { type: string, nullable: true, format: uuid }
        schemaVersion: { type: string }
        promptVersion: { type: string, nullable: true }
        modelVersion: { type: string, nullable: true }
        evidenceRefs: { type: array, items: { type: string } }
        metadata: { type: object, additionalProperties: true }
        prevHash: { type: string, pattern: '^([a-f0-9]{64}|GENESIS)$' }
        hash: { type: string, pattern: '^[a-f0-9]{64}$' }

    AuditBatchResult:
      type: object
      properties:
        accepted: { type: array, items: { type: string, format: uuid } }
        rejected:
          type: array
          items:
            type: object
            properties:
              id: { type: string, format: uuid }
              reason: { type: string }
```

## 12. Handshake WebSocket (paso a paso)

Direction A (Gateway → OpenClaw chat) usa WebSocket sobre `ws://2.24.223.240:61175/api/chat.stream`.

Secuencia exacta del handshake:

```
[Gateway → OpenClaw]
GET /api/chat.stream?token=<OPENCLAW_GATEWAY_TOKEN> HTTP/1.1
Host: 2.24.223.240:61175
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <base64>
Sec-WebSocket-Version: 13

[OpenClaw → Gateway]
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: <base64>

# Conexión establecida. OpenClaw envía inmediatamente:
[OpenClaw → Gateway]
{ "type": "HELLO", "agentId": "openclaw-hostinger-prod",
  "modelVersion": "claude-sonnet-4-6", "promptVersion": "v1.0",
  "serverTimeIso": "2026-05-18T03:00:00.000Z" }

# Gateway responde:
[Gateway → OpenClaw]
{ "type": "HELLO_ACK", "gatewayId": "delivrix-gateway-popayan",
  "sessionTokenForReads": "<DELIVRIX_OPENCLAW_TOKEN short-lived>",
  "readBoundaryBase": "http://gateway.delivrix.local:3000" }

# Heartbeats cada 15s mientras la sesión esté abierta:
[Gateway → OpenClaw]
{ "type": "HEARTBEAT", "ts": "2026-05-18T03:00:15.000Z" }

[OpenClaw → Gateway]
{ "type": "HEARTBEAT_OK", "ts": "2026-05-18T03:00:15.020Z" }

# Chat send (Doc 4 §3) viaja por la misma conexión:
[Gateway → OpenClaw]
{ "type": "CHAT_SEND", "sessionKey": "agent:main:main",
  "msgId": "<uuid>", "message": { "role": "user", "content": "..." } }

# Streaming response:
[OpenClaw → Gateway]
{ "type": "ASSISTANT_DELTA", "msgId": "<uuid>", "delta": "## Flota..." }
{ "type": "ASSISTANT_DELTA", "msgId": "<uuid>", "delta": " — snapshot..." }
{ "type": "ASSISTANT_DONE",  "msgId": "<uuid>",
  "assistant": { "content": "...", "skillsInvoked": [...],
                 "proposals": [...], "audit": {...} } }

# Errores:
[OpenClaw → Gateway]
{ "type": "ERROR", "msgId": "<uuid>", "code": "model_unavailable",
  "message": "AI provider quota exceeded" }
```

### Estados de la conexión

| Estado | Cómo se entra | Cómo se sale |
| --- | --- | --- |
| `CONNECTING` | TCP + Upgrade en curso | `OPEN` (101 received) o `CLOSED` (handshake failed) |
| `OPEN` | 101 received, HELLO/ACK intercambiados | `CLOSING` (close frame) o `CLOSED` (transport drop) |
| `CLOSING` | Close frame enviado/recibido | `CLOSED` |
| `CLOSED` | Transport cerrado | reconnect_loop intenta `CONNECTING` con backoff |

### Reconnect loop

Si la conexión cae:

```
attempt 1: delay 1s
attempt 2: delay 2s
attempt 3: delay 4s
attempt 4: delay 8s
attempt 5+: delay 30s con jitter ±5s
max attempts antes de "agent offline": ilimitado, pero después de 5 fails
  consecutivos en < 1 min → audit `oc.transport.degraded` + UI marca
  "agent reconnecting"
```

Al reconectar:
1. Enviar `HELLO` con `agentId` y `lastKnownSessionId`.
2. Gateway responde `HELLO_ACK` con nuevo `sessionTokenForReads`.
3. Gateway hace `GET /api/sessions/agent:main:main` para reconciliar mensajes
   en vuelo (msgIds enviados sin `ASSISTANT_DONE`).
4. Agent continúa donde quedó o aborta los inflight según política
   (default: aborta y notifica al panel "respuesta interrumpida, reintenta").

## 13. Códigos de error completos (catálogo)

| HTTP | `rejectReason` o code | Cuándo | Reintentar? |
| --- | --- | --- | --- |
| 400 | `schema_mismatch` | Payload no cumple JSON Schema | No, corregir cliente |
| 400 | `unknown_action` | Acción no en matriz | No, corregir agente |
| 401 | `human_approval_missing` | Sin firmas suficientes | Sí, después de firmar |
| 401 | `approval_token_expired` | Token > 15min | Sí, re-firmar |
| 401 | `auth_token_invalid` | Bearer inválido | Sí, refresh |
| 403 | `prohibited_action` | Acción `prohibited` en matriz | Nunca |
| 403 | `live_blocked_hito_5_11_b` | Acción `future_live` | No hasta nuevo hito |
| 409 | `approval_replay_detected` | Mismo token usado 2× | No |
| 409 | `race_condition_detected` | Otro proceso modificando target | Sí, después de 1-5s |
| 409 | `duplicate_proposal` | Hash idéntico ya en canvas.prompt | No |
| 423 | `kill_switch_armed` | Kill switch active | No hasta operador deshace |
| 429 | `rate_limit_exceeded` | > 60 reads/min o > 10 proposals/min | Sí, con backoff |
| 503 | `gateway_internal_error` | Bug del Gateway | Sí, exponential backoff |
| 504 | `gateway_timeout` | Skill o read tardó > 8s | Sí, con backoff |

## 14. Referencias

- `OPENCLAW_PERMISSIONS_MATRIX.md` (Doc 2 — validador de cada acción)
- `OPENCLAW_SKILLS_CATALOG.md` (Doc 3 — fichas que llaman estos endpoints)
- `OPENCLAW_AUDIT_INTEGRATION.md` (Doc 8 — formato exacto del audit por cada call)
- `apps/admin-panel/src/shared/api/read-boundary.ts` (28 endpoints GET permitidos)
- `apps/gateway-api/src/main.ts` (handlers — Codex extiende con `/v1/agent/proposals`)
- Notion [Agent Integration Guide](https://www.notion.so/34b7932c3b42810ab084e11f0e5e5e85)
  (Dirección C, plantillas Python listas)
