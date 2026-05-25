# Draft del issue público para openclaw/openclaw

Listo para copiar/pegar en `https://github.com/openclaw/openclaw/issues/new` si decides ir por la vía pública. Si prefieres soporte Hostinger comercial, el cuerpo sirve igual (solo elimina la sección "Related issues" del final).

Codex verificó (sesión 2026-05-24) que ese repo SÍ es donde se reportan issues de la imagen `hvps-openclaw` — referencias en issues #29933 y #37711.

---

## Título

```
hvps-openclaw image: expose stable /health, /api/chat.send, WSS /api/chat.stream for downstream integrations
```

## Body

```markdown
## Summary

We're integrating with the OpenClaw container that ships in the Hostinger hVPS image (`ghcr.io/hostinger/hvps-openclaw`). The OpenClaw RPC layer works end-to-end against Amazon Bedrock, but the **HTTP/WSS bridge that the container should expose for downstream integrations is missing**: external probes return the hVPS login HTML, and internal probes return `404 Not Found`.

We'd like the image to expose a stable, documented contract so downstream tools (in our case, an admin panel + gateway that gates every action through human approval) can connect without depending on undocumented internals.

## Environment

- Image / package: `ghcr.io/hostinger/hvps-openclaw`
- Deployment: Hostinger VPS Docker template
- Downstream integration: external gateway + admin panel (read-only on top of OpenClaw RPC)
- Internal OpenClaw RPC: working (confirmed via `openclaw gateway call chat.send/chat.history`, provider `amazon-bedrock`)
- Public HTTP/WSS integration bridge: missing / invalid

## What we observe

| Probe                                                  | Actual result                  | Expected                                        |
|--------------------------------------------------------|--------------------------------|-------------------------------------------------|
| `GET <host>:<port>/`                                   | HTTP 200 + hVPS login HTML     | (irrelevant)                                    |
| `GET <host>:<port>/health`                             | HTTP 200 + hVPS login HTML     | HTTP 200 JSON `{ "status": "ok", ... }`         |
| `POST <host>:<port>/api/chat.send` (external + Bearer) | HTTP 200 + login HTML          | HTTP 200 JSON `{ "msgId": "...", "queued": true }` |
| `POST .../api/chat.send` (internal, container)         | HTTP 404 `Not Found`           | HTTP 200 JSON `{ "msgId": "...", "queued": true }` |
| `WSS .../api/chat.stream?token=...`                    | endpoint does not exist        | WS handshake + emits `ASSISTANT_DONE` on finish |

The OpenClaw RPC behind these endpoints already works. The gap is the HTTP/WSS exposure layer.

## What we'd like

Three stable, documented endpoints exposed on the container port:

### 1. `GET /health`

Public, no auth. JSON body, no HTML.

```json
HTTP/1.1 200 OK
Content-Type: application/json

{ "status": "ok", "service": "openclaw", "version": "<image-tag-or-sha>", "uptimeSec": 12345 }
```

### 2. `POST /api/chat.send`

Authenticated with `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN` (the var already exists inside the container).

Request:
```json
{
  "msgId": "<client-generated id>",
  "actor": "<operator id>",
  "text": "<message>",
  "context": { "originatedFrom": "<integration name>", "ts": "<iso8601>" }
}
```

Response:
```json
{ "msgId": "<same id as request>", "queued": true }
```

Reject with HTTP 401 if the Bearer doesn't match. Reject with HTTP 429 if the queue is saturated. Reject with HTTP 503 during restart. Do NOT return HTML when the request can't be served — that breaks downstream integrations that have to parse a JSON ACK.

### 3. `WSS /api/chat.stream?token=<OPENCLAW_GATEWAY_TOKEN>`

WebSocket. Token via query param (browser WebSocket API can't set headers in the handshake).

Server emits, one line per event:

```json
{ "type": "ASSISTANT_TYPING", "msgId": "...", "ts": "..." }
{ "type": "ASSISTANT_DELTA",  "msgId": "...", "delta": "...", "ts": "..." }
{ "type": "ASSISTANT_DONE",   "msgId": "...", "ts": "..." }
```

`ASSISTANT_DONE` is mandatory — without it, UIs hang on "thinking…". If a rule blocks the response, emit `{ "type": "ASSISTANT_BLOCKED", "msgId": "...", "reason": "<rule-id>", "ts": "..." }`.

## Persistence

We'd ask that the bridge live in the image source / package build for `ghcr.io/hostinger/hvps-openclaw` or be exposed via a documented sidecar/reverse-proxy path, rather than as an ad-hoc patch to `/hostinger/server.mjs` inside a running container — patches there get wiped on any redeploy.

## What we already did on our side

We won't push for parity; this is just so you know nothing on our end is blocking:

- Our gateway already validates the ACK strictly and returns HTTP 502 `openclaw_chat_send_invalid_response` when upstream returns HTML or invalid JSON, so we don't carry false-positive "queued" state.
- We don't store any sensitive data in URL params.
- The integration is read-only + dry-run; no writes happen without a human-approved gate.

## Related issues

#29933, #37711 — both deal with the same image.

Thanks!
```

---

## Decisión rápida

| Opción | Pros | Cons |
|---|---|---|
| Abrir el issue público en openclaw/openclaw | Tracking visible, Hostinger lo trata como bug oficial, otros usuarios afectados pueden +1 | Filtra que Delivrix opera sobre hvps-openclaw |
| Soporte Hostinger comercial | Privado, va directo a tu account manager o ticket queue | Sin tracking público; depende de cómo Hostinger priorice tickets internos |

Si dudas, **abrir el issue público** suele tener mejor outcome para issues de imagen: los maintainers del repo público son los mismos que mantienen el bundle del container, y un issue público crea presión sana en la roadmap.
