# Episodic Memory Implemented — OpenClaw

Fecha: 2026-06-01
Branch: `feat/episodic-memory`
Commit SHA: pendiente hasta push de branch
Merge SHA: pendiente de PR/review

## Qué quedó implementado

- Tabla Postgres `openclaw_episodic_scratch` con `intentId`, `step`, `tool`, `inputHash`, `outcome`, `source`, `trustScore`, TTL e índices.
- Paquete `@delivrix/storage` con helpers de insert/query/TTL y validación de proveniencia.
- Endpoint read-only `GET /v1/openclaw/scratch`.
- Endpoint auditado `POST /v1/openclaw/compact-intent`.
- Tools Bedrock: `read_episodic_scratch` y `compact_intent`.
- `configure_complete_smtp` compacta memoria al completar o fallar, incluyendo el step fallido.
- TTL job opcional vía `OPENCLAW_EPISODIC_SCRATCH_TTL_JOB_ENABLE=true`.
- System prompt v2.4 con reglas de memoria episódica.

## Gates

- `read_episodic_scratch`: read-only, sin ApprovalGate.
- `compact_intent`: escritura interna auditada, sin side effects externos ni ApprovalGate.
- Acciones reales del orquestador siguen detrás de ApprovalGate y kill switch.

## QA

Tests cubren:

- Inserción, query por `intentId`, `inputHash`, tool/outcome y trust weighting.
- TTL expiration.
- Bloqueo de memoria `operator` sin firma verificada.
- Bloqueo de memoria `tool_output` sin proveniencia.
- Endpoints HTTP de lectura y compaction.
- Tool-use Bedrock read/memory sin ApprovalGate.
- Compactación automática de `configure_complete_smtp` en éxito y fallo.

Resultados ejecutados:

- `npm test`: 660/660 pass.
- `npm --workspace @delivrix/gateway-api run build`: pass.
- `npm --workspace @delivrix/admin-panel run check`: pass.
- `npm run db:migrate`: aplicó `005_create_episodic_scratch.sql` en Postgres dev.
- `curl http://127.0.0.1:3000/health`: `status=ok`, `postgres=ok`, `redis=down` con queue local-file.
- `curl /v1/openclaw/scratch?intentId=nonexistent-intent`: `{"entries":[]}`.

## Bundle OpenClaw

`scripts/openclaw/build-system-context.sh` ejecutado y sincronizado al container Hostinger.

- Context SHA-256: `b0054ba5f114895db69e0faf9a0512c7c3eccd6214de17ca4537ce3e2de285d8`.
- Capa 1 instalada en `/data/.openclaw/workspace/system-context.txt`.
- `AGENTS.md` bootstrap actualizado por el script.

## Notas de riesgo

- `npx tsc -p apps/gateway-api/tsconfig.json --noEmit` sigue fallando por deuda existente en gateway/domain/canvas/runbooks y tipos `pg`; no bloquea los scripts actuales de CI local usados por el repo (`node --test`, `node --check`, admin check).
- Redis local sigue down; gateway opera con `queue=local-file`.
