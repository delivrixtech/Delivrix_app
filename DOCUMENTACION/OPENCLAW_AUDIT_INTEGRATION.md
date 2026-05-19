# OpenClaw — Audit Integration

Fecha: 2026-05-18 (v2.0 expansión 2026-05-18).
Hito rector: `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md`.
Cierra el set quirúrgico. Cita: Doc 2 (matrix), Doc 4 (API contract), Doc 7 (runbooks).

## Changelog

- **v1.0** — 3 capas, hash chain conceptual, retención.
- **v2.0** — JSON Schema formal del evento canónico, queries comunes con ejemplos, procedimiento de restore de Capa 1 desde Capa 2, script de verificación de integridad detallado.

## 1. Propósito

Definir cómo cada decisión del agente OpenClaw queda registrada de forma
inmutable y trazable. Toda acción que pase por el pipeline de la matriz
(allow o reject), toda invocación de skill, toda propuesta, toda firma humana,
y todo side-effect debe terminar en un evento auditado.

Sin audit completo, el agente es una caja negra que el operador no puede
defender ante el sponsor, compliance, o sí mismo en 6 meses.

## 2. Modelo de audit (3 capas)

```
┌──────────────────────────────────────────────────────┐
│ Capa 1 — OpenClaw container (audit local del agente) │
│   Cada decisión LLM, skill invoke, error             │
│   Storage: SQLite o JSONL en /openclaw/audit/        │
└──────────────────┬───────────────────────────────────┘
                   │  push HTTP (Doc 4 §4.2)
                   ▼
┌──────────────────────────────────────────────────────┐
│ Capa 2 — Delivrix Gateway (audit canónico)           │
│   Append-only con hash chain SHA-256                 │
│   Storage: LocalFileAuditLog (hoy) → Postgres futuro │
└──────────────────┬───────────────────────────────────┘
                   │  selección de eventos
                   ▼
┌──────────────────────────────────────────────────────┐
│ Capa 3 — Notion (UI humana de auditoría)             │
│   Bugs & Blockers (issues) · Daily Standup (resumen) │
└──────────────────────────────────────────────────────┘
```

La fuente de verdad para compliance es **Capa 2**. Capa 1 puede perderse si
muere el container; se reconstruye desde Capa 2. Capa 3 es UI, no archivo
legal.

## 3. Schema canónico del evento

Todos los eventos en Capa 2 siguen este shape exacto:

```json
{
  "id": "<uuid v4>",
  "occurredAt": "<ISO 8601 UTC>",
  "actorType": "openclaw | operator | system | collector",
  "actorId": "<id estable del actor>",
  "action": "<dot-namespaced, ej: oc.skill.fleet_ops.invoke>",
  "targetType": "<entidad afectada>",
  "targetId": "<id concreto>",
  "decision": "allow | reject | n/a",
  "rejectReason": "<código si reject; null si allow>",
  "humanApproved": <boolean>,
  "approverIds": ["<id>", "..."],
  "killSwitchState": "armed | active | unknown",
  "rollbackToken": "<uuid o null>",
  "schemaVersion": "2026-05-18.v1",
  "promptVersion": "<si actorType=openclaw>",
  "modelVersion": "<si actorType=openclaw>",
  "evidenceRefs": ["<hashes de datos consultados>"],
  "metadata": {
    "skillSlug": "<si aplica>",
    "tokensUsed": <int o null>,
    "durationMs": <int>,
    "errorMessage": "<si reject por error>"
  },
  "prevHash": "<SHA-256 del evento anterior en la chain>",
  "hash": "<SHA-256 de este evento sin el campo hash>"
}
```

Campos obligatorios: `id`, `occurredAt`, `actorType`, `actorId`, `action`,
`targetType`, `targetId`, `decision`, `schemaVersion`, `prevHash`, `hash`.

## 4. Hash chain append-only

Cada evento incluye `prevHash` (hash del evento anterior) y `hash` (hash de este).
Esto crea una cadena: si alguien edita un evento del medio, todos los hashes
posteriores quedan inválidos.

Algoritmo del hash:

```
prevHash = lastEvent.hash || "GENESIS"
canonical = JSON.stringify(event sin campo "hash", keys ordenadas alfabéticamente)
hash = sha256(prevHash + canonical)
```

Verificación: recorrer la chain y recalcular. Si algún hash no coincide,
emitir alerta `oc.audit.chain_broken` y bloquear writes.

## 5. Acciones que MUST audit

| Origen | Cuándo se audita |
| --- | --- |
| Pipeline de matrix (Doc 2 §4) | Siempre, allow o reject |
| Skill invoke (Doc 3) | Una entrada por invocación, con `durationMs` y `tokensUsed` |
| Proposal submitted (Doc 4 §4.2) | `oc.proposal.submitted` |
| Proposal accepted/rejected por humano | `oc.proposal.resolved` con `approverIds` |
| Runbook step iniciado / completado / failed_partial | `oc.runbook.<step_id>.<status>` |
| Auth refresh / failure | `oc.auth.refreshed` / `oc.auth.refresh_failed` |
| KB reindex completed (Doc 6) | `oc.kb.reindex_completed` |
| System prompt cargado al boot | `oc.prompt.loaded` con `promptVersion` |
| Intento de bypass del prompt | `oc.prompt.bypass_attempted` (severidad critical) |
| Kill switch toggled | `safety.kill_switch.<armed|active>` (ya existente) |

## 6. Retención

| Capa | Retención mínima | Cuándo se borra |
| --- | --- | --- |
| Capa 1 (container) | 7 días o 100K eventos (el menor) | Rotación log automática |
| Capa 2 (Gateway, fuente de verdad) | 18 meses | Nunca antes; export a S3 antes de borrar |
| Capa 3 (Notion) | Indefinida según política Notion | Operador limpia tarjetas resueltas mayores a 6 meses si lo decide |

Cambio de retención de Capa 2 requiere actualizar
`DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md` y commit firmado.

## 7. Replicación OpenClaw → Gateway (Capa 1 → Capa 2)

OpenClaw mantiene un buffer local de eventos no replicados. Cada 10s o cuando
el buffer pasa 50 eventos, hace:

```
POST /v1/agent/audit/batch
Authorization: Bearer ${DELIVRIX_OPENCLAW_TOKEN}
Body: { events: [<eventos del schema §3>], batchId: <uuid> }
```

Gateway:

1. Valida schema de cada evento.
2. Recalcula `prevHash` con su último evento canónico (no confía en el del
   agente para `prevHash`; el del agente es referencial).
3. Persiste en `LocalFileAuditLog`.
4. Responde `{ accepted: [...ids], rejected: [{id, reason}] }`.
5. Si Gateway rechaza algún evento, OpenClaw audita
   `oc.audit.replication_rejected` y reintenta el resto.

Si Gateway está caído, el buffer crece hasta 7 días. Si pasa de 7 días sin
flush, OpenClaw emite alerta crítica y se pone en modo solo-lectura (no acepta
chat.send).

## 8. Routing a Notion (Capa 2 → Capa 3)

Sólo un subconjunto de eventos de Capa 2 va a Notion. Reglas explícitas:

| Evento (action) | Notion DB | Por qué |
| --- | --- | --- |
| `oc.local.ip_paused` | Bugs & Blockers (`severity: High`) | Operación defensiva, operador debe saber |
| `oc.local.quarantine_applied` | Bugs & Blockers (`severity: Critical`) | Incidente serio |
| `oc.prompt.bypass_attempted` | Bugs & Blockers (`severity: Critical`) | Posible compromiso |
| `oc.audit.chain_broken` | Bugs & Blockers (`severity: Critical`) | Integridad rota |
| `oc.skill.report_ops.invoke` (con reporte) | Daily Standup | Reporte diario de fin de día |
| `oc.proposal.submitted` | (sólo si severity=high) Bugs & Blockers | Propuestas críticas necesitan ojos |

Cada llamada a Notion audita a su vez `oc.notion.posted` con la URL del page
creado, para mantener trazabilidad bidireccional.

Detalle de los payloads Python listos en
[🤖 Agent Integration Guide](https://www.notion.so/34b7932c3b42810ab084e11f0e5e5e85)
(página existente, no se duplica aquí).

## 9. Exportación para auditoría externa

| Trigger | Output |
| --- | --- |
| Cron mensual `0 4 1 * *` UTC | Dump de Capa 2 últimas 31 días a JSONL gzip → S3 con SSE-KMS |
| Pedido manual del operador (`POST /v1/audit/export` — futuro, no en 5.11.B) | Mismo formato, ventana custom |
| Auditor externo solicita | Dump firmado con GPG del operador |

El dump incluye chain verification al final: si el hash del último evento
no coincide con el almacenado, el dump se marca `INVALID` y se notifica.

## 10. Cómo se verifica integridad (smoke test)

Script `scripts/audit/verify-chain.ts` (Codex implementa):

```bash
node scripts/audit/verify-chain.ts --from <ISO> --to <ISO>
# Salida esperada:
# events_total=12345
# chain_ok=12345
# chain_broken=0
# missing_prev_hash=0
# OK
```

Se corre en CI nightly. Si falla, alerta inmediata + bloqueo de nuevos writes.

## 11. Gates duros

- Ningún evento se borra ni se edita. Sólo append.
- Cualquier cambio al schema bumpa `schemaVersion` y migra eventos viejos
  con script idempotente (no muta los originales; agrega campo
  `migratedFrom`).
- El hash chain se verifica antes de cada export y en CI nightly.
- Eventos con `decision: reject` se auditan **igual** que los allow. No hay
  silencio por rechazo.
- Capa 3 (Notion) nunca es fuente de verdad. Si Notion y Gateway divergen,
  manda Gateway.
- Capa 1 (container OpenClaw) se trata como caché. Puede perderse y se
  reconstruye desde Capa 2 si hace falta.

## 12. JSON Schema formal del evento canónico (v2.0)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://delivrix.io/schemas/audit-event/2026-05-18.v1.json",
  "title": "Delivrix Audit Event",
  "type": "object",
  "required": [
    "id", "occurredAt", "actorType", "actorId", "action",
    "targetType", "targetId", "decision",
    "schemaVersion", "prevHash", "hash"
  ],
  "additionalProperties": false,
  "properties": {
    "id":           { "type": "string", "format": "uuid" },
    "occurredAt":   { "type": "string", "format": "date-time" },
    "actorType":    { "type": "string", "enum": ["openclaw", "operator", "system", "collector"] },
    "actorId":      { "type": "string", "minLength": 1, "maxLength": 128 },
    "action":       { "type": "string", "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" },
    "targetType":   { "type": "string", "minLength": 1, "maxLength": 64 },
    "targetId":     { "type": "string", "minLength": 1, "maxLength": 256 },
    "decision":     { "type": "string", "enum": ["allow", "reject", "n/a"] },
    "rejectReason": {
      "type": ["string", "null"],
      "enum": [
        "unknown_action", "prohibited_action", "live_blocked_hito_5_11_b",
        "human_approval_missing", "kill_switch_armed",
        "approval_token_expired", "approval_replay_detected",
        "race_condition_detected", "schema_mismatch", "rate_limit_exceeded",
        "duplicate_proposal", "gateway_internal_error", "gateway_timeout",
        null
      ]
    },
    "humanApproved":   { "type": "boolean" },
    "approverIds":     { "type": "array", "items": { "type": "string" }, "default": [] },
    "killSwitchState": { "type": "string", "enum": ["armed", "active", "unknown"] },
    "rollbackToken":   { "type": ["string", "null"], "format": "uuid" },
    "schemaVersion":   { "type": "string", "const": "2026-05-18.v1" },
    "promptVersion":   { "type": ["string", "null"] },
    "modelVersion":    { "type": ["string", "null"] },
    "evidenceRefs":    { "type": "array", "items": { "type": "string" }, "default": [] },
    "metadata": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "skillSlug":     { "type": "string" },
        "tokensUsed":    { "type": ["integer", "null"], "minimum": 0 },
        "durationMs":    { "type": "integer", "minimum": 0 },
        "errorMessage":  { "type": "string" }
      }
    },
    "prevHash": { "type": "string", "pattern": "^([a-f0-9]{64}|GENESIS)$" },
    "hash":     { "type": "string", "pattern": "^[a-f0-9]{64}$" }
  }
}
```

Validación en código (Codex implementa):

```typescript
import Ajv from "ajv";
import addFormats from "ajv-formats";
const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validate = ajv.compile(auditEventSchema);

function persistAuditEvent(event: AuditEvent): void {
  if (!validate(event)) {
    throw new Error(`Invalid audit event: ${JSON.stringify(validate.errors)}`);
  }
  // Verificar hash chain antes de persistir
  const expectedPrev = lastEvent?.hash ?? "GENESIS";
  if (event.prevHash !== expectedPrev) {
    throw new Error(`prevHash mismatch: expected ${expectedPrev}, got ${event.prevHash}`);
  }
  if (computeHash(event) !== event.hash) {
    throw new Error("hash does not match canonical content");
  }
  auditLog.append(event);
}
```

## 13. Queries comunes (catálogo de consultas)

Codex implementa estos queries como helpers en `packages/domain/src/audit-queries.ts`.
SQL ejemplos para Postgres (Capa 2 cuando migre desde LocalFile).

### 13.1 Eventos de un actor en ventana

```sql
SELECT id, occurredAt, action, targetType, targetId, decision, rejectReason
FROM audit_events
WHERE actorId = $1
  AND occurredAt BETWEEN $2 AND $3
ORDER BY occurredAt DESC
LIMIT 100;
```

### 13.2 Rejects por reason en últimas 24h

```sql
SELECT rejectReason, COUNT(*) as count
FROM audit_events
WHERE decision = 'reject'
  AND occurredAt > NOW() - INTERVAL '24 hours'
GROUP BY rejectReason
ORDER BY count DESC;
```

### 13.3 Histórico de un target específico

```sql
SELECT *
FROM audit_events
WHERE targetType = $1 AND targetId = $2
ORDER BY occurredAt DESC;
```

### 13.4 Cadena de hash verificable de un rango

```sql
SELECT id, prevHash, hash, occurredAt
FROM audit_events
WHERE occurredAt BETWEEN $1 AND $2
ORDER BY occurredAt ASC;
-- Cliente recorre y verifica que event[i].prevHash == event[i-1].hash
```

### 13.5 Propuestas resueltas con resolución

```sql
SELECT p.id, p.headline, p.severity,
       r.decision, r.approverIds, r.occurredAt as resolvedAt
FROM audit_events p
LEFT JOIN audit_events r ON r.targetType = 'proposal'
                        AND r.targetId = p.targetId
                        AND r.action = 'oc.proposal.resolved'
WHERE p.action = 'oc.proposal.submitted'
ORDER BY p.occurredAt DESC;
```

### 13.6 Bypass attempts

```sql
SELECT id, occurredAt, actorId, metadata->>'errorMessage' as detail
FROM audit_events
WHERE action = 'oc.prompt.bypass_attempted'
ORDER BY occurredAt DESC;
-- Si esta query devuelve > 0 filas, hay incidente de seguridad
```

### 13.7 Chain integrity check (CI nightly)

```sql
WITH ordered AS (
  SELECT id, prevHash, hash, occurredAt,
         LAG(hash) OVER (ORDER BY occurredAt) as expectedPrev
  FROM audit_events
  WHERE occurredAt > $1
)
SELECT id, prevHash, expectedPrev
FROM ordered
WHERE prevHash != COALESCE(expectedPrev, 'GENESIS');
-- Filas devueltas = puntos donde la chain se rompió. Debe ser cero.
```

## 14. Procedimiento de restore Capa 1 ← Capa 2

Cuando el container OpenClaw se reinicia o se reemplaza, su audit log local
(Capa 1) se pierde. Procedimiento de restore:

```bash
# 1. Container OpenClaw nuevo arranca, audit local vacío
docker exec openclaw-new sh -c "ls /openclaw/audit/local.jsonl"
# (vacío o no existe)

# 2. Container pide ventana de eventos al Gateway
curl -H "Authorization: Bearer ${DELIVRIX_OPENCLAW_TOKEN}" \
  "http://gateway.delivrix.local:3000/v1/agent/audit/restore?since=24h&actorId=openclaw-hostinger-prod" \
  > /openclaw/audit/restore.jsonl

# 3. Container valida hash chain del restore
node /openclaw/scripts/verify-restore.js /openclaw/audit/restore.jsonl
# Output esperado: "chain_ok=N, chain_broken=0, restored=N"

# 4. Container copia el restore al log local con flag de "restored from gateway"
mv /openclaw/audit/restore.jsonl /openclaw/audit/local.jsonl
echo "$(date -u +%FT%TZ) restored_from_gateway N events" \
  >> /openclaw/audit/restore.log

# 5. Container audita la operación
curl -X POST -H "Authorization: Bearer ${DELIVRIX_OPENCLAW_TOKEN}" \
  -H "Content-Type: application/json" \
  http://gateway.delivrix.local:3000/v1/agent/audit/batch \
  -d '{
    "batchId": "<uuid>",
    "events": [{
      "id": "<uuid>",
      "occurredAt": "<ISO>",
      "actorType": "openclaw",
      "actorId": "openclaw-hostinger-prod",
      "action": "oc.audit.local_restored_from_gateway",
      "targetType": "audit_log_local",
      "targetId": "/openclaw/audit/local.jsonl",
      "decision": "n/a",
      ...
      "metadata": { "eventsRestored": <N>, "windowHours": 24 }
    }]
  }'
```

**Garantías post-restore:**

- Capa 1 contiene los últimos 24h de eventos como mínimo.
- La nueva chain extiende la del Gateway desde el último evento restaurado.
- Si entre el crash y el restore ocurrieron eventos en otra parte (operator
  desde panel), no se pierden porque Capa 2 es fuente de verdad.

## 15. Script de verificación de integridad (CI nightly)

`scripts/audit/verify-chain.ts`:

```typescript
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

interface AuditEvent { /* schema §3 */ }

function canonicalJSON(event: Omit<AuditEvent, "hash">): string {
  return JSON.stringify(event, Object.keys(event).sort());
}

function computeHash(event: Omit<AuditEvent, "hash">, prevHash: string): string {
  return createHash("sha256").update(prevHash + canonicalJSON(event)).digest("hex");
}

function verifyChain(events: AuditEvent[]): {
  total: number;
  ok: number;
  broken: number;
  brokenAt: string[];
} {
  let prev = "GENESIS";
  let ok = 0;
  const brokenAt: string[] = [];
  for (const e of events) {
    if (e.prevHash !== prev) brokenAt.push(`${e.id} prev mismatch`);
    const expectedHash = computeHash(stripHash(e), e.prevHash);
    if (e.hash !== expectedHash) brokenAt.push(`${e.id} hash mismatch`);
    if (e.prevHash === prev && e.hash === expectedHash) ok++;
    prev = e.hash;
  }
  return { total: events.length, ok, broken: brokenAt.length, brokenAt };
}

// Uso:
//   node scripts/audit/verify-chain.ts \
//     --since 2026-05-17T00:00:00Z --until 2026-05-18T00:00:00Z
// Salida esperada en CI: "OK 12345 events verified, 0 broken"
// Si broken > 0: exit 1 + alerta a Notion Bugs & Blockers.
```

Cron CI nightly `0 4 * * *` corre este script + emite audit
`oc.audit.chain_verified` con resultado. Si broken > 0:

1. Bloquea nuevos writes al audit log.
2. Crea bug Notion severity Critical: "Audit chain broken at {ids}".
3. Notifica operador on-call.
4. Genera forensic dump del rango afectado a S3.

## 16. Referencias

- `OPENCLAW_PERMISSIONS_MATRIX.md` (Doc 2 — qué acciones auditar)
- `OPENCLAW_DELIVRIX_API_CONTRACT.md` (Doc 4 — endpoints `/v1/agent/audit/batch`)
- `OPENCLAW_SKILLS_CATALOG.md` (Doc 3 — cada skill emite eventos)
- `OPENCLAW_RUNBOOKS_OPERATIONAL.md` (Doc 7 — eventos `oc.runbook.*`)
- `OPENCLAW_KNOWLEDGE_BASE_INDEX.md` (Doc 6 — eventos `oc.kb.*`)
- `packages/domain/src/audit-log.ts` (esquema canónico en código)
- `packages/local-store/src/local-file-audit-log.ts` (storage actual)
- Notion [🤖 Agent Integration Guide](https://www.notion.so/34b7932c3b42810ab084e11f0e5e5e85)
- `DOCUMENTACION/ESTANDARES_INGENIERIA.md` (estándar append-only general)
