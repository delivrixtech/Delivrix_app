# COMMIT FASE 5.11.B — Docs quirúrgicos OpenClaw Hostinger Agent

## Resumen

Aterriza el set quirúrgico v2.0 del Hito 5.11.B: 8 documentos rectores
+ 5 `SKILL.md` literales + 6 runbooks literales. **No toca código** —
solo documentación firmada por el operador antes de arrancar la
implementación. Los 19 archivos forman el contrato sobre el que Codex
codeará el cliente OpenClaw, las skills, el rules engine extendido y el
audit integration.

## Archivos (19)

### Docs principales del set (8)

- `DOCUMENTACION/HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md` — rector, cronograma 7 días, métricas cuantitativas
- `DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md` — 29 acciones literales, pipeline TypeScript, race conditions
- `DOCUMENTACION/OPENCLAW_SKILLS_CATALOG.md` — catálogo de 5 skills + formato SKILL.md + plantilla
- `DOCUMENTACION/OPENCLAW_DELIVRIX_API_CONTRACT.md` — OpenAPI 3.1, schemas formales, handshake WSS, 14 códigos de error
- `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md` — system prompt v1.0 literal + 4 ejemplos anotados + escala 1-10 confianza
- `DOCUMENTACION/OPENCLAW_KNOWLEDGE_BASE_INDEX.md` — 63 archivos literales, JSON Schema chunk, métricas RAG
- `DOCUMENTACION/OPENCLAW_RUNBOOKS_OPERATIONAL.md` — plantilla + 6 fichas resumen
- `DOCUMENTACION/OPENCLAW_AUDIT_INTEGRATION.md` — hash chain SHA-256, 3 capas, JSON Schema, 7 queries, restore procedure

### Skills literales (5)

- `DOCUMENTACION/skills/delivrix-fleet-ops/SKILL.md`
- `DOCUMENTACION/skills/delivrix-alert-ops/SKILL.md`
- `DOCUMENTACION/skills/delivrix-report-ops/SKILL.md`
- `DOCUMENTACION/skills/webdock-inventory-sync/SKILL.md`
- `DOCUMENTACION/skills/drift-monitor/SKILL.md`

### Runbooks literales (6)

- `DOCUMENTACION/runbooks/warming-step-runbook.md`
- `DOCUMENTACION/runbooks/pause-ip-runbook.md`
- `DOCUMENTACION/runbooks/register-sender-node-local-runbook.md`
- `DOCUMENTACION/runbooks/rotate-dns-record-runbook.md`
- `DOCUMENTACION/runbooks/incident-quarantine-runbook.md`
- `DOCUMENTACION/runbooks/daily-report-runbook.md`

**Total**: ~3,200 líneas de doctrina ejecutable.

## Lo que NO cambia

- Cero archivos en `apps/` modificados.
- Cero archivos en `packages/` modificados.
- Cero tests nuevos (este commit es solo documentación; los tests llegan
  con la implementación en commits posteriores).
- Norte operativo intacto.

## Pre-flight (Codex en host)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

# 1. Verificar que estamos en la rama correcta
git branch --show-current   # debe imprimir: youthful-mirzakhani-c517de
git status

# 2. Confirmar que los 19 archivos existen
for f in \
  DOCUMENTACION/HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md \
  DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md \
  DOCUMENTACION/OPENCLAW_SKILLS_CATALOG.md \
  DOCUMENTACION/OPENCLAW_DELIVRIX_API_CONTRACT.md \
  DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md \
  DOCUMENTACION/OPENCLAW_KNOWLEDGE_BASE_INDEX.md \
  DOCUMENTACION/OPENCLAW_RUNBOOKS_OPERATIONAL.md \
  DOCUMENTACION/OPENCLAW_AUDIT_INTEGRATION.md \
  DOCUMENTACION/skills/delivrix-fleet-ops/SKILL.md \
  DOCUMENTACION/skills/delivrix-alert-ops/SKILL.md \
  DOCUMENTACION/skills/delivrix-report-ops/SKILL.md \
  DOCUMENTACION/skills/webdock-inventory-sync/SKILL.md \
  DOCUMENTACION/skills/drift-monitor/SKILL.md \
  DOCUMENTACION/runbooks/warming-step-runbook.md \
  DOCUMENTACION/runbooks/pause-ip-runbook.md \
  DOCUMENTACION/runbooks/register-sender-node-local-runbook.md \
  DOCUMENTACION/runbooks/rotate-dns-record-runbook.md \
  DOCUMENTACION/runbooks/incident-quarantine-runbook.md \
  DOCUMENTACION/runbooks/daily-report-runbook.md \
  COMMIT_FASE_5_11_B_DOCS.md
do
  [ -f "$f" ] && echo "ok   $f" || { echo "FAIL $f"; exit 1; }
done

# 3. Tests no se rompen (no debería pasar nada — son docs, pero por hábito)
npm test
npm --workspace @delivrix/admin-panel run check
```

## Commit (Codex en host)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

git add \
  DOCUMENTACION/HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md \
  DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md \
  DOCUMENTACION/OPENCLAW_SKILLS_CATALOG.md \
  DOCUMENTACION/OPENCLAW_DELIVRIX_API_CONTRACT.md \
  DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md \
  DOCUMENTACION/OPENCLAW_KNOWLEDGE_BASE_INDEX.md \
  DOCUMENTACION/OPENCLAW_RUNBOOKS_OPERATIONAL.md \
  DOCUMENTACION/OPENCLAW_AUDIT_INTEGRATION.md \
  DOCUMENTACION/skills/delivrix-fleet-ops/SKILL.md \
  DOCUMENTACION/skills/delivrix-alert-ops/SKILL.md \
  DOCUMENTACION/skills/delivrix-report-ops/SKILL.md \
  DOCUMENTACION/skills/webdock-inventory-sync/SKILL.md \
  DOCUMENTACION/skills/drift-monitor/SKILL.md \
  DOCUMENTACION/runbooks/warming-step-runbook.md \
  DOCUMENTACION/runbooks/pause-ip-runbook.md \
  DOCUMENTACION/runbooks/register-sender-node-local-runbook.md \
  DOCUMENTACION/runbooks/rotate-dns-record-runbook.md \
  DOCUMENTACION/runbooks/incident-quarantine-runbook.md \
  DOCUMENTACION/runbooks/daily-report-runbook.md \
  COMMIT_FASE_5_11_B_DOCS.md

git commit -m "docs(openclaw): set quirurgico v2.0 Hito 5.11.B agent Hostinger

Aterriza la doctrina completa del agente OpenClaw real corriendo en VPS
Hostinger (2.24.223.240, imagen ghcr.io/hostinger/hvps-openclaw). 19
archivos, ~3200 lineas de documentacion ejecutable previa al codigo.

Set quirurgico (8 docs principales):
- HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md: rector, cronograma 7 dias,
  metricas cuantitativas (latencia, calidad, costo, confiabilidad).
- OPENCLAW_PERMISSIONS_MATRIX.md: 5 categorias canonicas + 29 acciones
  de lectura literales (todo el read-boundary) + pseudocodigo TS del
  pipeline + race conditions con locks + 10 reject reasons tipadas.
- OPENCLAW_SKILLS_CATALOG.md: catalogo + formato SKILL.md/plugin TS +
  plantilla canonica + reglas de validacion.
- OPENCLAW_DELIVRIX_API_CONTRACT.md: 3 direcciones de trafico (Gateway
  -> OpenClaw chat WSS, OpenClaw -> Gateway read+propose, OpenClaw ->
  Notion) + OpenAPI 3.1 fragmento formal + JSON Schemas + handshake
  WebSocket paso a paso + 14 codigos de error catalogados.
- OPENCLAW_SYSTEM_PROMPT.md: 9 bloques fijos + texto literal v1.0 +
  auto-defensa contra prompt injection + 4 ejemplos buena/mala
  respuesta anotados + escala 1-10 cuantitativa de confianza.
- OPENCLAW_KNOWLEDGE_BASE_INDEX.md: 3 capas (nucleo fijo ~7K tokens,
  RAG ChromaDB embebido, live via skills) + 63 archivos literales con
  prioridad y tags + JSON Schema chunk metadata + 6 metricas RAG con
  umbrales + test set 30 queries.
- OPENCLAW_RUNBOOKS_OPERATIONAL.md: plantilla rigida + 6 fichas
  (warming-step, pause-ip, register, rotate-dns bloqueado, quarantine,
  daily-report).
- OPENCLAW_AUDIT_INTEGRATION.md: 3 capas (container/gateway/Notion) +
  hash chain SHA-256 append-only + JSON Schema formal del evento + 7
  queries SQL comunes + procedimiento restore Capa1<-Capa2 + script
  verify-chain.ts implementable.

Skills literales (5, listas para que Codex implemente como plugin TS o
SKILL.md puro en el container OpenClaw):
- skills/delivrix-fleet-ops/SKILL.md
- skills/delivrix-alert-ops/SKILL.md  (con side-effect Notion auditado)
- skills/delivrix-report-ops/SKILL.md (cron diario 23:00 UTC)
- skills/webdock-inventory-sync/SKILL.md
- skills/drift-monitor/SKILL.md (cron cada 5min, inyecta propuestas
  al canvas.prompt via POST /v1/agent/proposals)

Runbooks literales (6, archivos individuales en runbooks/):
- warming-step-runbook.md (supervised_local_state, 2 firmas)
- pause-ip-runbook.md (supervised_local_state, 1 firma)
- register-sender-node-local-runbook.md (supervised_local_state, 1)
- rotate-dns-record-runbook.md (bloqueado por gate, documentado para
  hito futuro)
- incident-quarantine-runbook.md (critico, 1/2 firmas segun horario)
- daily-report-runbook.md (dry-run, sin firmas)

Norte operativo intacto:
- Panel admin Delivrix sigue GET-only (28 endpoints en read-boundary).
- Bundle frontend nunca llama POST /v1/agent/proposals (es endpoint
  privado agent <-> gateway, fuera del read-boundary).
- Aprobaciones humanas con tokens HMAC short-lived (15 min) + regla
  de 2 personas para acciones supervised_local_state.
- Kill switch como gate ultimo, sin bypass.

Validacion local: 148/148 tests dominio + 15/15 admin-panel + tsc clean
(este commit es solo docs, los tests siguen verdes del commit anterior).

Refs:
- Notion master: https://www.notion.so/3647932c3b42817f8c95f084ea8ba1e4
- 8 tarjetas Notion hijas en Task Board workstream 'AI Agent Dev'.
- Norte: DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md
- Conceptual: DOCUMENTACION/FASE_4_OPENCLAW_INFRAESTRUCTURA.md (hito
  4.x conceptual aterrizado aqui sobre el servicio real).

Proximo paso (NO en este commit): implementacion. Codex sigue cronograma
del rector (10.) en orden estricto. Cada milestone tiene entregable
verificable. Ruta critica: AI provider activo en el container OpenClaw
(ver OPS_OPENCLAW_DIAGNOSE_AGENT_FAILED.md).
"
```

## Validación post-commit (Codex en host)

```bash
# 1. Confirmar que el commit existe y tiene los 19 archivos
git log -1 --stat | head -30

# 2. Verificar que los hashes están bien
git log --oneline -5

# 3. Smoke de la rama: todos los tests anteriores siguen pasando
npm test
npm --workspace @delivrix/admin-panel run check
```

## Próximo paso (NO en este commit)

Después de que este commit landeé en el worktree, el operador:

1. **Firma cada uno de los 8 docs** en su tarjeta Notion correspondiente
   marcando los checklists.
2. **Si pide ajustes** a algún doc, Claude (este chat) edita el `.md` y
   se hace un segundo commit `docs(openclaw): ajustes v2.x — <lista>`.
3. **Una vez los 8 docs estén firmados** en Notion, arranca la **Fase 1
   del cronograma** (`HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`):
   diagnóstico del agente que no responde + activación AI provider
   siguiendo `OPS_OPENCLAW_DIAGNOSE_AGENT_FAILED.md`.

## Reparto del despliegue (recordatorio)

| Quién | Responsabilidad |
| --- | --- |
| **Claude** (este chat) | Frontend del admin panel cuando aplique + ajustes a los docs si hay correcciones. |
| **Codex** (host) | Backend Gateway (cliente OpenClaw, endpoint privado `/v1/agent/proposals`, audit batch), skills TypeScript en el container OpenClaw, operaciones SSH supervisadas, RAG ChromaDB. |
| **Operador** (Juanes) | Aprobaciones, generar credentials, configuración hPanel, firmar regla de 2 personas, decidir cuándo se levanta cada gate. |
