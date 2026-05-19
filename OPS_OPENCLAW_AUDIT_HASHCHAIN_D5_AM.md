# OPS · D+5 AM — Audit batch endpoint + hash chain SHA-256

> Cronograma: D+5 AM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Pre-requisitos: D+4 PM cerrado (`delivrix-report-ops` cargado).
> Construye sobre: `OPENCLAW_AUDIT_INTEGRATION.md` §4, §7, §10, §11, §12,
> `OPENCLAW_DELIVRIX_API_CONTRACT.md` §4.3 (audit batch), HMAC helper de D+4 AM.

## Objetivo

Fundación de **compliance** del Hito 5.11.B. Hasta D+4 PM cada componente
auditaba eventos al JSONL local de forma independiente y append, pero sin
encadenarlos. D+5 AM transforma el log en un **hash chain criptográfico
verificable**: cada evento se ata al anterior por SHA-256(prevHash +
canonical_json), de forma que cualquier edición histórica rompe la cadena
y se detecta vía `verify-chain.ts`.

Tres piezas técnicas:

1. **Helper hash chain** (`computeAuditHash` + `canonicalize`) con tests
   determinísticos.
2. **Endpoint `POST /v1/agent/audit/batch`** firmado HMAC, acepta hasta
   50 eventos por batch, validación per-event granular, respuesta `{accepted, rejected}`.
3. **Script `verify-chain.ts`** standalone para verificación nightly en CI.

Decisión de migración: por `Doc 8 §11` ("Ningún evento se borra ni se edita.
Sólo append."), **no se backfilla** la JSONL existente. El log actual se
mueve a `audit-events.legacy.jsonl` (read-only para forensics), y el log
encadenado arranca fresco con un evento genesis
`oc.audit.chain_started` en `audit-events.jsonl`.

## Entregables verificables

- [ ] `apps/gateway-api/src/audit/hash-chain.ts` con `canonicalize()` y
      `computeAuditHash(event, prevHash)` puros
- [ ] `apps/gateway-api/src/audit/hash-chain.test.ts` (8+ tests):
      determinismo, key ordering, genesis, mutación de campo cambia hash,
      mutación de prevHash cambia hash, schema validation, etc.
- [ ] `LocalFileAuditLog.append` modificado: recibe el evento sin
      `prevHash`/`hash`, los enriquece desde el último evento persistido,
      valida schema (Ajv contra Doc 8 §12), persiste atómico
- [ ] Migration one-shot: `scripts/audit/migrate-to-chain.ts` mueve
      `audit-events.jsonl` → `audit-events.legacy.jsonl`, crea nuevo
      `audit-events.jsonl` con genesis event
- [ ] Endpoint `POST /v1/agent/audit/batch` en Gateway con HMAC del D+4 AM
- [ ] Plugin TS shared: `submitAuditBatch` con buffer SQLite Capa 1
      (flush cada 10s o cuando count >= 50), reintento exponencial en 5xx,
      drop en 4xx con audit local `oc.audit.replication_rejected`
- [ ] Script `scripts/audit/verify-chain.ts` standalone que retorna exit
      code 0 si chain OK, 1 si broken
- [ ] Audit eventos nuevos:
  - `oc.audit.chain_started` (genesis del nuevo log)
  - `oc.audit.batch_received` (por batch entrante)
  - `oc.audit.batch_persisted` (por batch OK)
  - `oc.audit.replication_rejected` (por evento rechazado, con motivo)
  - `oc.audit.chain_continuity_drift` (si agente trae prevHash != Gateway)
  - `oc.audit.chain_broken` (si verify-chain detecta tamper)

## Paso 1 — Helper hash chain

Crear `apps/gateway-api/src/audit/hash-chain.ts`:

```typescript
import { createHash } from 'node:crypto';

/**
 * Canonicaliza un evento de audit para hashing.
 * - Excluye el campo `hash` (es el output).
 * - Ordena keys alfabéticamente (recursivo en objetos anidados).
 * - JSON.stringify con esa key order.
 *
 * Determinístico: dos eventos con mismo contenido → mismo string canónico.
 */
export function canonicalize(event: Record<string, unknown>): string {
  function sortRec(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortRec);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      if (key === 'hash') continue; // excluido del canonical
      sorted[key] = sortRec((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return JSON.stringify(sortRec(event));
}

/**
 * Calcula el hash SHA-256 del evento dado un prevHash.
 * Algoritmo: sha256(prevHash + canonical_json(event sin field "hash"))
 * prevHash = "GENESIS" para el primer evento.
 */
export function computeAuditHash(
  event: Record<string, unknown>,
  prevHash: string
): string {
  const canonical = canonicalize(event);
  return createHash('sha256').update(prevHash + canonical).digest('hex');
}

export const GENESIS_PREV_HASH = 'GENESIS';
```

Tests obligatorios en `hash-chain.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { canonicalize, computeAuditHash, GENESIS_PREV_HASH } from './hash-chain.js';

describe('canonicalize', () => {
  it('produces same output regardless of key order in input', () => {
    const a = { c: 1, a: 2, b: 3 };
    const b = { a: 2, b: 3, c: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('excludes the "hash" field from canonical', () => {
    const e = { id: 'x', hash: 'should-not-appear' };
    expect(canonicalize(e)).not.toContain('should-not-appear');
  });

  it('sorts nested object keys', () => {
    const e = { meta: { z: 1, a: 2 } };
    expect(canonicalize(e)).toBe('{"meta":{"a":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalize({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
  });
});

describe('computeAuditHash', () => {
  it('is deterministic', () => {
    const e = { id: 'a', action: 'test.foo' };
    expect(computeAuditHash(e, GENESIS_PREV_HASH)).toBe(computeAuditHash(e, GENESIS_PREV_HASH));
  });

  it('changes when any field changes', () => {
    const a = { id: 'a', action: 'test.foo' };
    const b = { id: 'a', action: 'test.bar' };
    expect(computeAuditHash(a, GENESIS_PREV_HASH)).not.toBe(computeAuditHash(b, GENESIS_PREV_HASH));
  });

  it('changes when prevHash changes (chain property)', () => {
    const e = { id: 'a' };
    expect(computeAuditHash(e, 'GENESIS')).not.toBe(computeAuditHash(e, 'abc123'));
  });

  it('returns 64 hex chars (SHA-256)', () => {
    const h = computeAuditHash({ id: 'a' }, GENESIS_PREV_HASH);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

## Paso 2 — Migration one-shot

Crear `scripts/audit/migrate-to-chain.ts`:

```typescript
#!/usr/bin/env node
/**
 * One-shot migration: mover audit-events.jsonl legacy a audit-events.legacy.jsonl,
 * crear nuevo audit-events.jsonl con genesis event encadenado.
 *
 * Doc 8 §11 prohíbe editar eventos pasados → no se backfillean hashes.
 * El log legacy queda como referencia histórica read-only.
 *
 * Idempotente: si ya existe legacy.jsonl, no hace nada.
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalize, computeAuditHash, GENESIS_PREV_HASH } from '../../apps/gateway-api/src/audit/hash-chain.js';

const AUDIT_DIR = process.env.AUDIT_DIR ?? '.audit';
const CURRENT = resolve(AUDIT_DIR, 'audit-events.jsonl');
const LEGACY = resolve(AUDIT_DIR, 'audit-events.legacy.jsonl');

if (existsSync(LEGACY)) {
  console.error('audit-events.legacy.jsonl ya existe — migration ya corrió. Abortando.');
  process.exit(0);
}

if (existsSync(CURRENT)) {
  renameSync(CURRENT, LEGACY);
  console.log(`Movido ${CURRENT} → ${LEGACY}`);
}

// Genesis event
const genesis = {
  id: randomUUID(),
  occurredAt: new Date().toISOString(),
  actorType: 'system',
  actorId: 'gateway-api',
  action: 'oc.audit.chain_started',
  targetType: 'audit_log',
  targetId: 'audit-events.jsonl',
  decision: 'n/a',
  rejectReason: null,
  humanApproved: false,
  approverIds: [],
  killSwitchState: 'armed',
  rollbackToken: null,
  schemaVersion: '2026-05-18.v1',
  promptVersion: null,
  modelVersion: null,
  evidenceRefs: [],
  metadata: {
    reason: 'Hito 5.11.B D+5 AM — start hash chain. Eventos legacy preservados en audit-events.legacy.jsonl.',
    legacyEventsPreserved: true
  },
  prevHash: GENESIS_PREV_HASH
};
const genesisWithHash = { ...genesis, hash: computeAuditHash(genesis, GENESIS_PREV_HASH) };

writeFileSync(CURRENT, JSON.stringify(genesisWithHash) + '\n', 'utf8');
console.log(`Genesis event creado en ${CURRENT}: ${genesisWithHash.hash}`);
```

Correr una vez:

```bash
node --import tsx scripts/audit/migrate-to-chain.ts
```

## Paso 3 — Modificar `LocalFileAuditLog.append`

Localizar el módulo (probablemente `apps/gateway-api/src/audit/log.ts` o
similar). Cambiar `append` para:

```typescript
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalize, computeAuditHash } from './hash-chain.js';
import auditEventSchema from './schema.json' assert { type: 'json' };

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validate = ajv.compile(auditEventSchema);

class LocalFileAuditLog {
  private lastHash: string | null = null;  // cache en memoria del último hash
  private writeMutex = new AsyncMutex();   // serializar appends concurrentes

  async append(input: AuditEventInput): Promise<AuditEvent> {
    return this.writeMutex.runExclusive(async () => {
      // 1. Resolver prevHash desde el último evento persistido (cache en memoria)
      const prevHash = this.lastHash ?? (await this.readLastHashFromDisk());

      // 2. Construir evento completo con defaults
      const event = this.fillDefaults(input, prevHash);

      // 3. Calcular hash
      event.hash = computeAuditHash(event, prevHash);

      // 4. Validar contra Ajv schema
      if (!validate(event)) {
        throw new InvalidAuditEventError(JSON.stringify(validate.errors));
      }

      // 5. Append atómico al JSONL
      await this.appendLine(JSON.stringify(event));
      this.lastHash = event.hash;
      return event;
    });
  }
}
```

Detalle: `readLastHashFromDisk` lee solo la última línea del JSONL (no carga
todo en memoria). Si el archivo está vacío después de la migration, lanza
error (la migration siempre escribe genesis primero).

## Paso 4 — Endpoint `POST /v1/agent/audit/batch`

Replicar el patrón de HMAC del D+4 AM:

```typescript
if (request.method === 'POST' && request.url === '/v1/agent/audit/batch') {
  // 1. HMAC inbound (mismo helper D+4 AM)
  const { raw, body } = await readRawBodyAndJson<AuditBatchRequest>(request);
  const hmac = validateOpenClawHmac(request.headers, raw);
  if (!hmac.ok) {
    return json(response, 401, { rejectReason: hmac.rejectReason });
  }

  // 2. Schema del batch
  if (!body || !Array.isArray(body.events) || body.events.length === 0) {
    return json(response, 400, { rejectReason: 'schema_mismatch' });
  }
  if (body.events.length > 50) {
    return json(response, 400, { rejectReason: 'batch_too_large', max: 50 });
  }

  const batchId = body.batchId ?? randomUUID();
  const accepted: string[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  // 3. Audit oc.audit.batch_received
  await auditLog.append({
    actorType: 'gateway',
    actorId: 'gateway-api',
    action: 'oc.audit.batch_received',
    targetType: 'audit_batch',
    targetId: batchId,
    decision: 'n/a',
    metadata: {
      eventCount: body.events.length,
      sourceActor: 'openclaw-hostinger-prod'
    }
  });

  // 4. Persistir cada evento (sequential, hash chain depende del orden)
  for (const incoming of body.events) {
    try {
      // Continuity check (informativo, no rechaza)
      const expectedPrev = auditLog.getLastHashSync();
      if (incoming.prevHash && incoming.prevHash !== expectedPrev) {
        await auditLog.append({
          actorType: 'gateway',
          actorId: 'gateway-api',
          action: 'oc.audit.chain_continuity_drift',
          targetType: 'audit_event',
          targetId: incoming.id,
          decision: 'n/a',
          metadata: {
            expectedPrev,
            agentClaimedPrev: incoming.prevHash,
            note: 'Gateway recalcula prevHash; el del agente es referencial.'
          }
        });
      }

      // Agente NO controla prevHash/hash finales — Gateway los recomputa
      const { prevHash: _ph, hash: _h, ...eventWithoutChain } = incoming;
      const persisted = await auditLog.append(eventWithoutChain);
      accepted.push(persisted.id);
    } catch (err) {
      const reason = err instanceof InvalidAuditEventError ? 'schema_mismatch' : 'gateway_internal_error';
      rejected.push({ id: incoming.id ?? 'unknown', reason });
      // No-op audit; el oc.audit.batch_persisted al final tiene el detalle
    }
  }

  // 5. Audit oc.audit.batch_persisted
  await auditLog.append({
    actorType: 'gateway',
    actorId: 'gateway-api',
    action: 'oc.audit.batch_persisted',
    targetType: 'audit_batch',
    targetId: batchId,
    decision: 'n/a',
    metadata: {
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      rejectedDetails: rejected
    }
  });

  return json(response, 200, { batchId, accepted, rejected });
}
```

## Paso 5 — Plugin TS shared: buffer Capa 1 + flush

Crear `services/openclaw-skills/src/lib/audit-buffer.ts`:

```typescript
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';

const HMAC_SECRET = process.env.OPENCLAW_HMAC_SECRET ?? '';
const GATEWAY_BASE = process.env.DELIVRIX_GATEWAY_URL ?? 'http://host.docker.internal:3000';
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_THRESHOLD = 50;
const RETENTION_DAYS = 7;

const db = new Database('/var/openclaw/audit-buffer.sqlite');
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_audit (
    id TEXT PRIMARY KEY,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    retries INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_pending_audit_created ON pending_audit(created_at);
`);

export function enqueueAuditEvent(event: AuditEventInput): void {
  db.prepare(
    `INSERT OR IGNORE INTO pending_audit (id, event_json, created_at) VALUES (?, ?, ?)`
  ).run(event.id, JSON.stringify(event), new Date().toISOString());
}

async function flush(): Promise<void> {
  const rows = db.prepare(
    `SELECT id, event_json, retries FROM pending_audit ORDER BY created_at ASC LIMIT 50`
  ).all() as Array<{ id: string; event_json: string; retries: number }>;
  if (rows.length === 0) return;

  const events = rows.map((r) => JSON.parse(r.event_json));
  const batchId = crypto.randomUUID();
  const rawBody = JSON.stringify({ events, batchId });
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', HMAC_SECRET).update(`${ts}.${rawBody}`).digest('hex');

  try {
    const res = await fetch(`${GATEWAY_BASE}/v1/agent/audit/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenClaw-Signature': signature,
        'X-OpenClaw-Timestamp': ts
      },
      body: rawBody
    });

    if (res.status === 200) {
      const { accepted, rejected } = await res.json() as { accepted: string[]; rejected: Array<{id:string;reason:string}> };
      // Borrar aceptados
      const delStmt = db.prepare(`DELETE FROM pending_audit WHERE id = ?`);
      for (const id of accepted) delStmt.run(id);
      // Rejected: dropear (no retry — son schema errors) y audit local
      for (const r of rejected) {
        delStmt.run(r.id);
        // emitir audit oc.audit.replication_rejected (que se reencolará en pending)
      }
    } else if (res.status >= 500) {
      // Retry con backoff
      const upd = db.prepare(`UPDATE pending_audit SET retries = retries + 1 WHERE id = ?`);
      for (const r of rows) upd.run(r.id);
    } else {
      // 4xx — algo está mal del lado del agente, audit y dropear
      const delStmt = db.prepare(`DELETE FROM pending_audit WHERE id = ?`);
      for (const r of rows) delStmt.run(r.id);
    }
  } catch (err) {
    // Network error → retry next cycle
    const upd = db.prepare(`UPDATE pending_audit SET retries = retries + 1 WHERE id = ?`);
    for (const r of rows) upd.run(r.id);
  }
}

// Cron interno cada 10s
setInterval(flush, FLUSH_INTERVAL_MS);

// Watchdog: si buffer > 7d sin flush → modo read-only (placeholder log por ahora)
setInterval(() => {
  const oldest = db.prepare(
    `SELECT created_at FROM pending_audit ORDER BY created_at ASC LIMIT 1`
  ).get() as { created_at: string } | undefined;
  if (oldest) {
    const ageDays = (Date.now() - new Date(oldest.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > RETENTION_DAYS) {
      console.error('[CRITICAL] Audit buffer > 7d sin flush. Entrar modo read-only.');
      // TODO: emitir señal al runtime para deshabilitar chat.send
    }
  }
}, 60_000);
```

Cabear este buffer en los 5 plugins existentes: en lugar de llamar a un
helper que envía el evento directamente al Gateway, llamar a
`enqueueAuditEvent(event)`. El flush ocurre en background.

## Paso 6 — Script `verify-chain.ts`

Crear `scripts/audit/verify-chain.ts`:

```typescript
#!/usr/bin/env node
/**
 * Verifica la integridad del hash chain en audit-events.jsonl.
 * Exit code 0 si chain OK, 1 si broken.
 *
 * Uso:
 *   node --import tsx scripts/audit/verify-chain.ts
 *   node --import tsx scripts/audit/verify-chain.ts --from 2026-05-18T00:00:00Z --to 2026-05-19T00:00:00Z
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalize, computeAuditHash, GENESIS_PREV_HASH } from '../../apps/gateway-api/src/audit/hash-chain.js';

const AUDIT_FILE = resolve(process.env.AUDIT_DIR ?? '.audit', 'audit-events.jsonl');
const args = process.argv.slice(2);
const fromArg = args.indexOf('--from') >= 0 ? args[args.indexOf('--from') + 1] : null;
const toArg = args.indexOf('--to') >= 0 ? args[args.indexOf('--to') + 1] : null;

const lines = readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
let total = 0;
let chainOk = 0;
let chainBroken = 0;
let missingPrevHash = 0;
let prevHash = GENESIS_PREV_HASH;
const brokenLines: number[] = [];

for (let i = 0; i < lines.length; i++) {
  const event = JSON.parse(lines[i]!);
  if (fromArg && event.occurredAt < fromArg) continue;
  if (toArg && event.occurredAt > toArg) continue;
  total++;

  if (!event.prevHash) {
    missingPrevHash++;
    brokenLines.push(i + 1);
    continue;
  }
  if (event.prevHash !== prevHash) {
    chainBroken++;
    brokenLines.push(i + 1);
    continue;
  }
  const expectedHash = computeAuditHash(event, prevHash);
  if (event.hash !== expectedHash) {
    chainBroken++;
    brokenLines.push(i + 1);
    continue;
  }
  chainOk++;
  prevHash = event.hash;
}

console.log(`events_total=${total}`);
console.log(`chain_ok=${chainOk}`);
console.log(`chain_broken=${chainBroken}`);
console.log(`missing_prev_hash=${missingPrevHash}`);
if (chainBroken === 0 && missingPrevHash === 0) {
  console.log('OK');
  process.exit(0);
} else {
  console.error(`BROKEN at lines: ${brokenLines.slice(0, 10).join(', ')}${brokenLines.length > 10 ? '...' : ''}`);
  process.exit(1);
}
```

## Paso 7 — Compile + build + smoke

```bash
WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
cd "${WORKTREE}"

# 7.1 — Migration one-shot (mover legacy + genesis event)
node --import tsx scripts/audit/migrate-to-chain.ts

# 7.2 — Build Gateway + tests del helper
npm --workspace @delivrix/gateway-api run build
npm test -- --filter=hash-chain
# Esperado: 8+ tests OK

# 7.3 — Reiniciar Gateway
bash restart-gateway.sh

# 7.4 — Smoke 1: batch de 50 eventos válidos
node --import tsx scripts/audit/smoke-batch-50.ts
# (script generador de 50 eventos válidos con HMAC firmado)
# Esperado: HTTP 200 con accepted.length === 50 y rejected.length === 0

# 7.5 — Smoke 2: batch con 1 inválido (action ID malformado)
node --import tsx scripts/audit/smoke-batch-50-with-1-bad.ts
# Esperado: HTTP 200 con accepted.length === 49 y rejected[0].reason === 'schema_mismatch'

# 7.6 — Smoke 3: verify-chain.ts después de los smokes
node --import tsx scripts/audit/verify-chain.ts
# Esperado:
#   events_total=N
#   chain_ok=N
#   chain_broken=0
#   missing_prev_hash=0
#   OK
# Exit code 0

# 7.7 — Smoke 4: tamper test (editar 1 evento del medio)
cp .audit/audit-events.jsonl .audit/audit-events.jsonl.bak
# Modificar manualmente 1 línea cambiando metadata
node --import tsx scripts/audit/verify-chain.ts
# Esperado: chain_broken >= 1, exit code 1
# Restaurar:
mv .audit/audit-events.jsonl.bak .audit/audit-events.jsonl

# 7.8 — Smoke 5: HMAC missing
curl -i -X POST http://127.0.0.1:3000/v1/agent/audit/batch \
  -H "Content-Type: application/json" \
  -d '{"events":[],"batchId":"x"}'
# Esperado: HTTP 401 {"rejectReason":"hmac_missing"}
```

## Paso 8 — Plugin OpenClaw: deploy del buffer

```bash
cd services/openclaw-skills
npm run build
ssh root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 mkdir -p /var/openclaw'
docker cp dist/ openclaw-dtsf-openclaw-1:/opt/openclaw/skills/
ssh root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 kill -HUP 1'

# Verificar que el buffer está corriendo
ssh root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 sqlite3 /var/openclaw/audit-buffer.sqlite ".tables"'
# Esperado: pending_audit
```

## Paso 9 — Validación final

- [ ] `npm test` total: 148 + nuevos tests hash chain (esperado 156+)
- [ ] `npm --workspace @delivrix/admin-panel run check`: 15/15 pass
- [ ] Build Gateway OK
- [ ] `audit-events.legacy.jsonl` existe con todos los eventos pre-D+5 AM
- [ ] `audit-events.jsonl` arranca con 1 genesis event + N eventos nuevos
- [ ] `verify-chain.ts` retorna exit 0 contra el log actual
- [ ] Tras 10s de runtime, el buffer SQLite del container está vacío o
      con pocas filas (flush funcionando)
- [ ] Audit del Gateway muestra `oc.audit.batch_received` y
      `oc.audit.batch_persisted` por cada batch del container

## Cuándo cerrar D+5 AM

Verde cuando:

1. **Smoke 7.4** (50 eventos válidos) → 200 con `accepted.length === 50`
2. **Smoke 7.5** (50 con 1 inválido) → 200 con `accepted.length === 49`,
   `rejected.length === 1`
3. **Smoke 7.6** (verify-chain post-smoke) → exit 0
4. **Smoke 7.7** (tamper) → exit 1 con `chain_broken >= 1`
5. **Buffer plugin** flushea automáticamente en 10s o al pasar 50 events

Si los 5 salen verdes, queda listo para **D+5 PM** (Runbooks 1-3 cabled
consumiendo el ApprovalToken de D+4 AM).

## Lo que NO entra en D+5 AM

- **Routing automático a Notion Capa 3** — diferido a Hito 5.12 (decisión
  audited 2026-05-18). Las reglas de Doc 8 §8 quedan documentadas pero
  inactivas. Si en algún momento se inyecta `NOTION_API_KEY`, el router
  Capa 2→3 se reactiva con cero redeploy.
- **Cron mensual de exportación a S3** — diferido a post-MVP. Hito 5.11.B
  cierra con audit local + verificación nightly. La exportación es
  política de retención (18 meses) que se cabea cuando el operador conecte
  S3.
- **CI nightly de verify-chain** — el script queda pronto y se puede correr
  manualmente. Cron en GitHub Actions o local cron se cabea cuando el repo
  esté en main (post-Hito 5.11.B).
- **Read-only mode automático tras 7d sin flush** — placeholder log
  presente; cabeado real al runtime de OpenClaw es Hito 5.12.
- **Backfill de hashes en `audit-events.legacy.jsonl`** — explícitamente
  prohibido por Doc 8 §11. El log legacy es read-only para forensics.
