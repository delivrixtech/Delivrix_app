# Fase 1 OpenClaw Tool Calling — estado operativo 2026-06-01

## TL;DR

Fase A/B está integrada en `main` y el runtime local ya expone el set completo de tools Bedrock para el flujo SMTP E2E. Fase C quedó lista para disparo coordinado con PM/Juanes, pero no debe ejecutarse hasta recibir destinatario humano autorizado y texto final del correo real.

## SHAs relevantes

- `4711f14` — `feat(openclaw): send real email skill`
- `dc97928` — `Add configure complete SMTP orchestrator`
- `90e50ac` — `feat(openclaw): system prompt v2 + tool calling orchestration polish`
- `be84c89` — `fix(openclaw): accept gateway kill switch payload in tool loop`
- `509e344` — `fix(openclaw): sync orchestrator canvas and DNS waits`
- `6585743` — `fix(admin-panel): restore v5 shared helpers`
- `4da590f` — `ops(openclaw): add phase1 C master smoke launcher`

## Runtime actual

- Gateway: `http://127.0.0.1:3000`
- Admin Panel: `http://127.0.0.1:5173/canvas?t=phase1-c-approval-live`
- Queue/audit backend: local-file
- Kill switch: desarmado en `/health`
- Postgres/Redis: down, no bloquea este smoke porque el gateway está operando en modo local-file.

## Tools Bedrock visibles

Preflight `runtime/phase1-c-preflight-20260601024002.json` confirmó `12` tools:

1. `register_domain_route53`
2. `suggest_safe_domain`
3. `wait_for_dns_propagation`
4. `upsert_dns_route53`
5. `create_webdock_server`
6. `bind_webdock_main_domain`
7. `provision_smtp_postfix`
8. `configure_email_auth`
9. `bind_domain_to_server`
10. `seed_warmup_pool`
11. `send_real_email`
12. `configure_complete_smtp`

## Smoke sin gasto ya ejecutado

Se ejecutó un smoke conversacional read-only contra Bedrock:

- `msgId`: `codex-tool-readonly-20260601-0157`
- Prompt: pedir a OpenClaw usar exclusivamente `suggest_safe_domain`.
- Resultado: Bedrock invocó `suggest_safe_domain` y devolvió `tool_result`.
- Audit: `oc.chat.bedrock_invoked` con `skillsInvoked: ["openclaw-bedrock-direct", "suggest_safe_domain"]`.
- Canvas: artifact `artifact-chat-codex-to-20260601015732`.
- Costo externo de infraestructura: USD 0.
- No hubo compras, DNS writes, VPS ni email real.

## Audit chain

Último preflight:

- `verify.ok`: `true`
- `totalEvents`: `405`
- `headSeq`: `405`
- `headHash`: `fb60e699a0c15d561f9527c2d138b347763f73c558535d717daf5258bc11fb04`
- Anchor evidence: `runtime/phase1-c-preflight-20260601024002.json`

## Gate pendiente para ejecutar Fase C real

Falta input humano autorizado para el último correo real del flujo:

- `PHASE1_TEST_EMAIL_RECIPIENT`
- `PHASE1_TEST_EMAIL_SUBJECT`
- `PHASE1_TEST_EMAIL_BODY`

El subject/body no pueden contener:

`test`, `demo`, `prueba`, `lorem`, `smoke`, `ipsum`, `notify`, `noreply`, `no-reply`, `bulk`, `blast`, `spam`, `campaign`, `broadcast`.

El preflight técnico ahora también reporta `launchReadiness.readyForSend`; puede estar `false` aunque runtime/tools/audit estén OK. Eso significa que falta completar el input humano anterior, no que el gateway esté roto.

Para usarlo como gate automatizable antes del disparo, correr:

```bash
node --env-file=.env.local scripts/openclaw/phase1-c-master-smoke.mjs \
  --preflight --require-launch-ready
```

Ese modo devuelve exit code `1` si faltan destinatario/asunto/cuerpo autorizados, aunque el runtime esté sano.

Para validar un paquete de datos sin escribirlo en `.env.local`, el launcher también acepta overrides de una sola corrida:

```bash
node --env-file=.env.local scripts/openclaw/phase1-c-master-smoke.mjs \
  --preflight --require-launch-ready \
  --recipient "persona@dominio.com" \
  --subject "Operational readiness handoff" \
  --body "Texto legítimo del correo real autorizado, sin palabras bloqueadas."
```

Para generar una revisión final sin enviar el mensaje a OpenClaw:

```bash
node --env-file=.env.local scripts/openclaw/phase1-c-master-smoke.mjs \
  --dry-run --require-launch-ready \
  --recipient "persona@dominio.com" \
  --subject "Operational readiness handoff" \
  --body "Texto legítimo del correo real autorizado, sin palabras bloqueadas."
```

El dry-run persiste `runtime/phase1-c-dry-run-*.json`; no hace POST al chat y redacta el body en la evidencia, dejando longitud + SHA-256 para verificación.

## Comando de disparo coordinado

Ejecutar solo cuando Juanes/PM confirmen destinatario y contenido legítimo:

```bash
cd "/Users/juanescanar/Documents/delivrix app"

PHASE1_TEST_EMAIL_RECIPIENT="persona@dominio.com" \
PHASE1_TEST_EMAIL_SUBJECT="Operational readiness handoff" \
PHASE1_TEST_EMAIL_BODY="Texto legítimo del correo real autorizado, sin palabras bloqueadas." \
node --env-file=.env.local scripts/openclaw/phase1-c-master-smoke.mjs --send
```

El launcher valida runtime + audit + tools antes de mandar el chat. Si pasa, envía un único mensaje a OpenClaw pidiendo `configure_complete_smtp`; OpenClaw debe crear la propuesta master y esperar firmas del operador en ApprovalGate. El script no firma nada automáticamente.

## Verificación post-disparo

Después de enviar el master prompt:

```bash
curl -s http://127.0.0.1:3000/v1/audit-chain/verify
curl -s http://127.0.0.1:3000/v1/audit-chain/anchor
curl -s "http://127.0.0.1:3000/v1/audit-events?limit=30"
```

También queda disponible un watcher read-only que captura health, canvas-live, proposals, audit verify/anchor y eventos relevantes sin firmar ni ejecutar acciones:

```bash
node --env-file=.env.local scripts/openclaw/phase1-c-watch.mjs \
  --msg-id phase1-c-master-YYYYMMDDHHMMSS
```

Si ya existe proposalId, usar:

```bash
PHASE1_PROPOSAL_ID="uuid-de-la-propuesta" \
node --env-file=.env.local scripts/openclaw/phase1-c-watch.mjs --watch
```

Cada corrida guarda evidencia en `runtime/phase1-c-watch-*.json`.

El cierre completo de Fase C requiere evidencia de:

- propuesta `configure_complete_smtp` creada por tool calling Bedrock;
- firmas operador en ApprovalGate;
- dominio registrado o idempotente;
- DNS propagation sin timeout falso;
- VPS Webdock creado o reutilizado según outcome;
- Main domain/PTR, DNS, Postfix/OpenDKIM, SPF/DKIM/DMARC;
- warmup seed;
- `send_real_email` ejecutado con correo legítimo autorizado;
- anchor HMAC post-smoke guardado.
