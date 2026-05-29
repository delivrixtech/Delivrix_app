# OPS Codex — Fase 0 A1 — Audit Chain SHA-256 linked

**Para:** Codex CLI.
**De:** Claude PM.
**Fecha:** 2026-05-29 viernes 12:30 COT.
**Tiempo límite:** 2h (cerrar antes de 14:30 COT).
**Bloquea:** A2 (auto-rollback), A3 (smoke E2E), B3 (ApprovalGate firma).
**Protocolo:** sub-agentes seniors según `PROTOCOLO_CODEX_SUB_AGENTES_SENIORS.md` (Backend + QA + Security mínimo).

## Contexto

Cambio de norte ya pusheado por Juanes. "Regla de 2 personas" eliminada. Reemplazo: **1 firma + audit chain SHA-256 linked + broadcast inmediato + auto-rollback**. Este OPS implementa la 1era pata: audit chain SHA-256.

Hoy el audit chain en `LocalFileAuditLog` solo append eventos sin link criptográfico. Si alguien edita `runtime/audit-events.jsonl`, no hay forma de detectarlo. Con SHA-256 chain, cada evento incluye `prevHash` calculado sobre el evento anterior canonicalizado. Una mutación rompe la cadena y es detectable.

## Archivos a crear

### 1. `apps/gateway-api/src/audit-chain.ts`

Clase `AuditChainStore` que envuelve el `LocalFileAuditLog` actual añadiendo SHA-256 linking + verificación:

```typescript
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AuditEventInput } from "../../../packages/domain/src/index.ts";

export interface AuditChainEvent {
  /** Posición monotónica en la cadena, empieza en 1. */
  seq: number;
  /** SHA-256 del evento anterior canonicalizado. "GENESIS" si seq===1. */
  prevHash: string;
  /** SHA-256 de este evento canonicalizado (incluyendo prevHash). */
  hash: string;
  /** Timestamp UTC ISO. */
  occurredAt: string;
  /** Resto de campos del audit event. */
  event: AuditEventInput;
}

export interface AuditChainVerifyResult {
  ok: boolean;
  totalEvents: number;
  brokenAt?: { seq: number; expectedHash: string; actualHash: string };
  emptyChain: boolean;
}

export interface AuditChainStoreOptions {
  filePath?: string;
  now?: () => Date;
}

const GENESIS_PREV_HASH = "GENESIS";

export class AuditChainStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private cachedLastHash: string | null = null;
  private cachedSeq: number = 0;
  private initialized: boolean = false;

  constructor(options: AuditChainStoreOptions = {}) {
    this.filePath = resolve(
      options.filePath ?? process.env.AUDIT_CHAIN_PATH ?? "runtime/audit-chain.jsonl"
    );
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Canonicaliza el evento para hashing determinístico.
   * - Sort keys alfabéticamente (recursivo).
   * - Excluir 'hash' del evento mismo (se calcula DESPUÉS).
   */
  static canonicalize(event: Omit<AuditChainEvent, "hash">): string {
    return JSON.stringify(event, Object.keys(event).sort());
  }

  static computeHash(event: Omit<AuditChainEvent, "hash">): string {
    return createHash("sha256").update(AuditChainStore.canonicalize(event)).digest("hex");
  }

  /**
   * Lee el último seq + hash del archivo si existe.
   * O(N) la primera vez, luego cacheado.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const lines = raw.trim().split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) {
        this.cachedLastHash = GENESIS_PREV_HASH;
        this.cachedSeq = 0;
      } else {
        const last = JSON.parse(lines[lines.length - 1]!) as AuditChainEvent;
        this.cachedLastHash = last.hash;
        this.cachedSeq = last.seq;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cachedLastHash = GENESIS_PREV_HASH;
        this.cachedSeq = 0;
      } else {
        throw err;
      }
    }
    this.initialized = true;
  }

  async append(event: AuditEventInput): Promise<AuditChainEvent> {
    await this.ensureInitialized();
    const seq = this.cachedSeq + 1;
    const prevHash = this.cachedLastHash ?? GENESIS_PREV_HASH;
    const occurredAt = this.now().toISOString();
    const base: Omit<AuditChainEvent, "hash"> = {
      seq,
      prevHash,
      occurredAt,
      event
    };
    const hash = AuditChainStore.computeHash(base);
    const full: AuditChainEvent = { ...base, hash };

    await mkdir(dirname(this.filePath), { recursive: true });
    const line = JSON.stringify(full) + "\n";
    // Append atómico: open con flag 'a'
    const { appendFile } = await import("node:fs/promises");
    await appendFile(this.filePath, line, "utf-8");

    this.cachedLastHash = hash;
    this.cachedSeq = seq;
    return full;
  }

  /**
   * Verifica integridad recorriendo el archivo. O(N) y determinístico.
   */
  async verify(): Promise<AuditChainVerifyResult> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, totalEvents: 0, emptyChain: true };
      }
      throw err;
    }
    const lines = raw.trim().split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return { ok: true, totalEvents: 0, emptyChain: true };

    let expectedPrev = GENESIS_PREV_HASH;
    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]!) as AuditChainEvent;
      if (parsed.prevHash !== expectedPrev) {
        return {
          ok: false,
          totalEvents: lines.length,
          brokenAt: { seq: parsed.seq, expectedHash: expectedPrev, actualHash: parsed.prevHash },
          emptyChain: false
        };
      }
      const { hash, ...base } = parsed;
      const recomputed = AuditChainStore.computeHash(base);
      if (recomputed !== hash) {
        return {
          ok: false,
          totalEvents: lines.length,
          brokenAt: { seq: parsed.seq, expectedHash: recomputed, actualHash: hash },
          emptyChain: false
        };
      }
      expectedPrev = hash;
    }
    return { ok: true, totalEvents: lines.length, emptyChain: false };
  }

  /**
   * Backfill: lee LocalFileAuditLog existente, lo reescribe como chain con prevHash linked.
   * Crea backup automático antes de mutar.
   */
  async backfillFromLocalFileAuditLog(sourcePath: string): Promise<{ backfilled: number; backupPath: string }> {
    const backupPath = `${this.filePath}.backup-${Date.now()}`;
    try {
      await rename(this.filePath, backupPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.initialized = false;
    this.cachedLastHash = null;
    this.cachedSeq = 0;

    let raw: string;
    try {
      raw = await readFile(sourcePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { backfilled: 0, backupPath };
      }
      throw err;
    }
    const lines = raw.trim().split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      await this.append(parsed);
    }
    return { backfilled: lines.length, backupPath };
  }
}

export function createAuditChainStoreFromEnv(env: NodeJS.ProcessEnv = process.env): AuditChainStore {
  return new AuditChainStore({ filePath: env.AUDIT_CHAIN_PATH });
}
```

### 2. `apps/gateway-api/src/audit-chain.test.ts`

Tests obligatorios (mínimo 10):

1. **append en cadena vacía**: seq=1, prevHash="GENESIS", hash computado correctamente.
2. **append en cadena existente**: seq incrementa, prevHash=hash del anterior.
3. **canonicalize determinístico**: mismas keys en distinto orden producen mismo string.
4. **computeHash determinístico**: dos eventos idénticos producen mismo hash.
5. **verify cadena vacía**: `ok=true, totalEvents=0, emptyChain=true`.
6. **verify cadena íntegra de 5 eventos**: `ok=true, totalEvents=5`.
7. **verify corrupción del último**: alterar `event.action` → `ok=false, brokenAt.seq=5`.
8. **verify corrupción intermedia**: alterar evento seq=3 → `ok=false, brokenAt.seq=3`.
9. **verify rotura de prevHash**: cambiar prevHash de seq=4 → `ok=false, brokenAt.seq=4`.
10. **backfill desde LocalFileAuditLog**: 10 events legacy → 10 events linked + backup creado.
11. **persistencia tras restart**: instancia nueva con mismo path → seq y lastHash cargados correctamente.
12. **append concurrente** (opcional, si tenés tiempo): 2 appends simultáneos no rompen orden.

Usar `tmpdir()` para paths de test, NO ensuciar `runtime/`.

### 3. Wiring en `apps/gateway-api/src/main.ts`

Agregar handler para verify:

```typescript
import { createAuditChainStoreFromEnv } from "./audit-chain.ts";

// En la sección de bootstrap (donde están los otros stores):
const auditChainStore = createAuditChainStoreFromEnv();

// En la sección de routes:
if (request.method === "GET" && request.url === "/v1/audit-chain/verify") {
  const result = await auditChainStore.verify();
  return json(response, result.ok ? 200 : 422, result);
}
```

**IMPORTANTE:** NO sustituir el `LocalFileAuditLog` actual todavía. El `AuditChainStore` corre **en paralelo** durante esta fase. Cuando A2 + A3 cierren y validemos smoke, hacemos el switch atómico (ese es Fase 1 lunes).

### 4. Backfill manual (corre 1 vez Codex)

Después de tests verdes, correr backfill desde el log existente:

```bash
cd /Users/juanescanar/Documents/delivrix\ app
node -e "
import('./apps/gateway-api/src/audit-chain.ts').then(async (m) => {
  const store = m.createAuditChainStoreFromEnv();
  const result = await store.backfillFromLocalFileAuditLog('.audit/audit-events.jsonl');
  console.log('Backfilled:', result);
  const verify = await store.verify();
  console.log('Verify:', verify);
});
"
```

Resultado esperado: backup creado, audit chain íntegra, `verify.ok=true`.

## Reglas duras

1. **NO toques el `LocalFileAuditLog` actual**. Corren en paralelo durante esta fase.
2. **NO commitees el archivo `runtime/audit-chain.jsonl`** (debería estar en `.gitignore`).
3. **Sub-agentes seniors obligatorios**: Backend implementa, QA valida 12 tests, Security revisa que `canonicalize` sea determinístico y `prevHash` no se pueda spoofear.
4. **Tests verdes antes de commit**. tsc clean para los 2 archivos nuevos.
5. **Backup automático en backfill** verificado por QA.

## Criterio de aceptación

```bash
cd /Users/juanescanar/Documents/delivrix\ app/apps/gateway-api
node --test src/audit-chain.test.ts
# debe ser 12/12 verde

curl -s http://localhost:3000/v1/audit-chain/verify | jq
# debe devolver { ok: true, totalEvents: N, emptyChain: false }
```

## Commit + push

```
fix(gateway): add SHA-256 linked audit chain store

- AuditChainStore wraps LocalFileAuditLog adding SHA-256 prevHash linking
- canonicalize() deterministic (sorted keys)
- verify() walks chain, detects mutations at any seq
- backfillFromLocalFileAuditLog() migrates legacy events with backup
- GET /v1/audit-chain/verify returns chain integrity status
- 12/12 tests green, tsc clean for new files
- Backfill executed: N events linked, backup at runtime/audit-chain.jsonl.backup-<ts>

Ref: CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md (compensación de seguridad #1)
Fase 0 sprint: SPRINT_FASE_0_VIERNES_12_19H_2026_05_29.md track A1
```

## Reporte a PM

Pegale en chat a Claude (PM) un mensaje con:

1. SHA del commit.
2. Tests N/N verde.
3. Output del `curl /v1/audit-chain/verify`.
4. Backup path del backfill.
5. Cualquier riesgo encontrado.

PM va a verificar y despacharte el siguiente OPS (A2 — Auto-rollback DNS + SMTP).

— Claude PM
