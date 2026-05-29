# OPS Codex — Fase 0 A2 — Auto-rollback DNS + SMTP + endurecer origen audit

**Para:** Codex CLI.
**De:** Claude PM.
**Fecha:** 2026-05-29 viernes ~13:15 COT.
**Tiempo límite:** 2h (cerrar antes de 15:15 COT).
**Pre-requisito:** A1 cerrado (commit `cb93e2c` — audit chain SHA-256 verifier).
**Bloquea:** A3 smoke E2E.
**Protocolo:** sub-agentes seniors según `PROTOCOLO_CODEX_SUB_AGENTES_SENIORS.md` (Backend + QA + Security mínimo).

## Contexto

A1 dejó audit chain tamper-evident pero como vos mismo notaste: falta auto-rollback para mutaciones reversibles. Es la 3era compensación de seguridad que reemplaza la "2da firma":
- DNS rollback automático si propagación no se confirma en 5 min.
- SMTP auto-pause si bounce rate > 5% en primeros N envíos.
- Webdock VPS snapshot si cloud-init no termina en 15 min.

Adicionalmente, vos reportaste en A1 dos riesgos que cubrimos parcialmente acá:
1. **Anchor externo del head hash** — exponer endpoint que firma el head hash con HMAC del operador para que se pueda anchorear fuera (no implementamos anchor a blockchain por scope; solo HMAC firmado).
2. **Endurecer origen semántico de `/v1/agent/audit/batch`** — rejection de eventos cuyo `actorType` no coincide con el caller autenticado.

## Archivos a crear / modificar

### 1. `apps/gateway-api/src/auto-rollback.ts` (NUEVO)

Manager de rollback con interfaz `RollbackManager` que registra hooks por tipo de acción crítica.

```typescript
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type RollbackKind = "dns" | "smtp" | "webdock";

export interface RollbackSnapshot {
  auditId: string;
  kind: RollbackKind;
  /** payload con el estado PRE-mutación que se puede restaurar. */
  beforeState: unknown;
  /** metadatos opcionales para diagnosticar (domain, serverSlug, etc.) */
  metadata: Record<string, unknown>;
  capturedAt: string;
}

export interface RollbackResult {
  applied: boolean;
  auditId: string;
  kind: RollbackKind;
  reason: string;
  durationMs: number;
}

export interface DnsRollbackPolicy {
  /** Tiempo máximo de propagación antes de considerar fallida. Default 5min. */
  propagationTimeoutMs?: number;
  /** Intervalo de poll para verificar propagación. Default 30s. */
  pollIntervalMs?: number;
}

export interface SmtpRollbackPolicy {
  /** Máximo bounce rate aceptable. Default 0.05 (5%). */
  maxBounceRate?: number;
  /** Mínimo número de envíos antes de evaluar (evitar pause prematuro). Default 10. */
  minSendsBeforeCheck?: number;
}

export interface WebdockRollbackPolicy {
  /** Tiempo máximo cloud-init. Default 15min. Si falla → snapshot manual + audit. */
  cloudInitTimeoutMs?: number;
}

export interface AutoRollbackManagerOptions {
  snapshotDir?: string;
  now?: () => Date;
  dnsPolicy?: DnsRollbackPolicy;
  smtpPolicy?: SmtpRollbackPolicy;
  webdockPolicy?: WebdockRollbackPolicy;
}

const DEFAULT_DNS_PROPAGATION_MS = 5 * 60 * 1000;
const DEFAULT_DNS_POLL_MS = 30 * 1000;
const DEFAULT_SMTP_MAX_BOUNCE_RATE = 0.05;
const DEFAULT_SMTP_MIN_SENDS = 10;
const DEFAULT_WEBDOCK_CLOUDINIT_MS = 15 * 60 * 1000;

export class AutoRollbackManager {
  private readonly snapshotDir: string;
  private readonly now: () => Date;
  private readonly dnsPolicy: Required<DnsRollbackPolicy>;
  private readonly smtpPolicy: Required<SmtpRollbackPolicy>;
  private readonly webdockPolicy: Required<WebdockRollbackPolicy>;

  constructor(options: AutoRollbackManagerOptions = {}) {
    this.snapshotDir = resolve(
      options.snapshotDir ?? process.env.ROLLBACK_SNAPSHOT_DIR ?? "runtime/rollback-snapshots"
    );
    this.now = options.now ?? (() => new Date());
    this.dnsPolicy = {
      propagationTimeoutMs: options.dnsPolicy?.propagationTimeoutMs ?? DEFAULT_DNS_PROPAGATION_MS,
      pollIntervalMs: options.dnsPolicy?.pollIntervalMs ?? DEFAULT_DNS_POLL_MS
    };
    this.smtpPolicy = {
      maxBounceRate: options.smtpPolicy?.maxBounceRate ?? DEFAULT_SMTP_MAX_BOUNCE_RATE,
      minSendsBeforeCheck: options.smtpPolicy?.minSendsBeforeCheck ?? DEFAULT_SMTP_MIN_SENDS
    };
    this.webdockPolicy = {
      cloudInitTimeoutMs: options.webdockPolicy?.cloudInitTimeoutMs ?? DEFAULT_WEBDOCK_CLOUDINIT_MS
    };
  }

  /**
   * Guarda snapshot pre-mutación. DEBE llamarse antes de cualquier acción reversible.
   * Si la mutación posterior falla, llamar applyRollback(auditId).
   */
  async captureSnapshot(snapshot: Omit<RollbackSnapshot, "capturedAt">): Promise<void> {
    const full: RollbackSnapshot = {
      ...snapshot,
      capturedAt: this.now().toISOString()
    };
    await mkdir(this.snapshotDir, { recursive: true });
    const path = join(this.snapshotDir, `${snapshot.kind}-${snapshot.auditId}.json`);
    await writeFile(path, JSON.stringify(full, null, 2), "utf-8");
  }

  async loadSnapshot(auditId: string, kind: RollbackKind): Promise<RollbackSnapshot | null> {
    try {
      const path = join(this.snapshotDir, `${kind}-${auditId}.json`);
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as RollbackSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Verifica DNS propagation con poll. Devuelve true si propagó dentro del timeout.
   * El digFn lo inyecta el caller para evitar dependencia de un cliente DNS específico.
   */
  async waitForDnsPropagation(input: {
    auditId: string;
    domain: string;
    expectedRecords: Array<{ type: string; value: string }>;
    digFn: (domain: string, type: string) => Promise<string[]>;
  }): Promise<{ propagated: boolean; elapsedMs: number; lastChecked: string }> {
    const startedAt = this.now().getTime();
    let lastChecked = startedAt;
    while (this.now().getTime() - startedAt < this.dnsPolicy.propagationTimeoutMs) {
      let allOk = true;
      for (const rec of input.expectedRecords) {
        const observed = await input.digFn(input.domain, rec.type).catch(() => [] as string[]);
        if (!observed.some((o) => o.includes(rec.value))) {
          allOk = false;
          break;
        }
      }
      lastChecked = this.now().getTime();
      if (allOk) {
        return {
          propagated: true,
          elapsedMs: lastChecked - startedAt,
          lastChecked: new Date(lastChecked).toISOString()
        };
      }
      await new Promise((r) => setTimeout(r, this.dnsPolicy.pollIntervalMs));
    }
    return {
      propagated: false,
      elapsedMs: this.now().getTime() - startedAt,
      lastChecked: new Date(this.now().getTime()).toISOString()
    };
  }

  /**
   * Decide si auto-pause un warmup basado en bounce/sent counters.
   */
  shouldAutoPauseWarmup(input: { sent: number; bounced: number }): {
    pause: boolean;
    reason: string;
    bounceRate: number;
  } {
    if (input.sent < this.smtpPolicy.minSendsBeforeCheck) {
      return { pause: false, reason: "insufficient_sample", bounceRate: 0 };
    }
    const rate = input.bounced / input.sent;
    if (rate > this.smtpPolicy.maxBounceRate) {
      return {
        pause: true,
        reason: `bounce_rate_${(rate * 100).toFixed(1)}pct_exceeded_threshold_${(this.smtpPolicy.maxBounceRate * 100).toFixed(1)}pct`,
        bounceRate: rate
      };
    }
    return { pause: false, reason: "within_threshold", bounceRate: rate };
  }

  /**
   * Aplica rollback ejecutando el callback restoreFn con el snapshot guardado.
   * El restoreFn lo provee el caller porque conoce el cliente del proveedor real.
   */
  async applyRollback(input: {
    auditId: string;
    kind: RollbackKind;
    restoreFn: (snapshot: RollbackSnapshot) => Promise<void>;
    reason: string;
  }): Promise<RollbackResult> {
    const startedAt = this.now().getTime();
    const snapshot = await this.loadSnapshot(input.auditId, input.kind);
    if (!snapshot) {
      return {
        applied: false,
        auditId: input.auditId,
        kind: input.kind,
        reason: `snapshot_not_found:${input.reason}`,
        durationMs: this.now().getTime() - startedAt
      };
    }
    await input.restoreFn(snapshot);
    return {
      applied: true,
      auditId: input.auditId,
      kind: input.kind,
      reason: input.reason,
      durationMs: this.now().getTime() - startedAt
    };
  }

  /** Listar snapshots para diagnóstico. */
  async listSnapshots(kind?: RollbackKind): Promise<RollbackSnapshot[]> {
    try {
      const files = await readdir(this.snapshotDir);
      const matches = files.filter((f) =>
        kind ? f.startsWith(`${kind}-`) && f.endsWith(".json") : f.endsWith(".json")
      );
      const result: RollbackSnapshot[] = [];
      for (const f of matches) {
        try {
          const raw = await readFile(join(this.snapshotDir, f), "utf-8");
          result.push(JSON.parse(raw) as RollbackSnapshot);
        } catch {
          // skip corrupted
        }
      }
      return result;
    } catch {
      return [];
    }
  }
}

export function createAutoRollbackManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AutoRollbackManager {
  return new AutoRollbackManager({
    snapshotDir: env.ROLLBACK_SNAPSHOT_DIR,
    dnsPolicy: {
      propagationTimeoutMs: env.DNS_ROLLBACK_TIMEOUT_MS
        ? Number(env.DNS_ROLLBACK_TIMEOUT_MS)
        : undefined,
      pollIntervalMs: env.DNS_ROLLBACK_POLL_MS
        ? Number(env.DNS_ROLLBACK_POLL_MS)
        : undefined
    },
    smtpPolicy: {
      maxBounceRate: env.SMTP_MAX_BOUNCE_RATE ? Number(env.SMTP_MAX_BOUNCE_RATE) : undefined,
      minSendsBeforeCheck: env.SMTP_MIN_SENDS_BEFORE_CHECK
        ? Number(env.SMTP_MIN_SENDS_BEFORE_CHECK)
        : undefined
    },
    webdockPolicy: {
      cloudInitTimeoutMs: env.WEBDOCK_CLOUDINIT_TIMEOUT_MS
        ? Number(env.WEBDOCK_CLOUDINIT_TIMEOUT_MS)
        : undefined
    }
  });
}
```

### 2. `apps/gateway-api/src/auto-rollback.test.ts` (NUEVO)

Tests mínimo 12, usando `tmpdir()`:

1. `captureSnapshot` crea archivo `{kind}-{auditId}.json` con `capturedAt`.
2. `loadSnapshot` devuelve null si no existe.
3. `loadSnapshot` devuelve snapshot completo si existe.
4. `waitForDnsPropagation` returns `propagated:true` cuando todos los records matchean.
5. `waitForDnsPropagation` returns `propagated:false` tras timeout (con fake timers o timeout corto en test).
6. `shouldAutoPauseWarmup` retorna `pause:false` con sent<minSendsBeforeCheck.
7. `shouldAutoPauseWarmup` retorna `pause:true` con bounceRate>maxBounceRate.
8. `shouldAutoPauseWarmup` retorna `pause:false` con bounceRate dentro de threshold.
9. `applyRollback` ejecuta restoreFn con snapshot cargado, returns `applied:true`.
10. `applyRollback` con snapshot no encontrado returns `applied:false, reason:"snapshot_not_found:..."`.
11. `listSnapshots` filtra por kind.
12. `createAutoRollbackManagerFromEnv` respeta env vars (parseando números).

### 3. Wire en handlers existentes

**Para DNS (route53 + IONOS):**

En `apps/gateway-api/src/routes/route53-dns-upsert.ts` (o el handler que existe) y `apps/gateway-api/src/routes/dns-ionos-upsert.ts`:

ANTES de hacer el upsert real:
```typescript
// 1. Pre-snapshot
const beforeRecords = await adapter.listRecords(zoneId);
await rollbackManager.captureSnapshot({
  auditId: input.auditId,
  kind: "dns",
  beforeState: { zoneId, records: beforeRecords },
  metadata: { domain: input.domain, provider: "route53" }
});
// 2. Mutación
await adapter.upsertRecords(zoneId, input.records);
// 3. Audit oc.dns.upserted
// 4. Spawn background verify (fire-and-forget):
queueMicrotask(async () => {
  const result = await rollbackManager.waitForDnsPropagation({
    auditId: input.auditId,
    domain: input.domain,
    expectedRecords: input.records.map(r => ({ type: r.type, value: r.value })),
    digFn: createSafeDigFn() // helper que uses node:dns/promises
  });
  if (!result.propagated) {
    await rollbackManager.applyRollback({
      auditId: input.auditId,
      kind: "dns",
      restoreFn: async (snap) => {
        const state = snap.beforeState as { zoneId: string; records: any[] };
        await adapter.upsertRecords(state.zoneId, state.records);
      },
      reason: `propagation_timeout_after_${result.elapsedMs}ms`
    });
    await auditLog.append({
      actorType: "system",
      actorId: "auto-rollback",
      action: "oc.dns.auto_rolled_back",
      // ...
    });
    // Webhook broadcast también
  }
});
```

**Para SMTP/warmup:**

En `apps/gateway-api/src/routes/warmup-ramp.ts` después de cada batch enviado, llamar:
```typescript
const decision = rollbackManager.shouldAutoPauseWarmup({
  sent: ramp.totalSent,
  bounced: ramp.totalBounced
});
if (decision.pause) {
  await rampScheduler.pauseRamp({
    rampId: ramp.rampId,
    reason: "auto_paused",
    actorId: "system/auto-rollback"
  });
  await auditLog.append({
    actorType: "system",
    actorId: "auto-rollback",
    action: "oc.warmup.ramp_auto_paused",
    metadata: { rampId: ramp.rampId, reason: decision.reason, bounceRate: decision.bounceRate }
  });
  // Webhook broadcast
}
```

**Helper `createSafeDigFn`:** usar `dnsPromises.resolve(domain, type)` con timeout, parsear records a strings comparables.

### 4. Endurecer `/v1/agent/audit/batch` origen semántico

En el handler de `/v1/agent/audit/batch`:

```typescript
// El caller autenticado (via gateway token) NO puede pretender ser otro actorType.
// El gateway sobreescribe actorType y actorId con la identidad real del caller.
for (const event of events) {
  // Forzar el actorType al rol del token autenticado
  event.actorType = callerRole; // "agent" | "operator" | "system"
  // El actorId solo se respeta si matchea el token. Si no, se sobreescribe.
  if (event.actorId !== callerAuthenticatedId) {
    event.actorId = callerAuthenticatedId;
    // Marcar como impersonation attempt en metadata
    event.metadata = { ...event.metadata, _impersonation_attempt: true };
  }
  // humanApproved solo se respeta si hay signatureId vigente
  if (event.humanApproved === true && !event.metadata?.signatureId) {
    event.humanApproved = false;
  }
}
```

Tests: agente envía event con `actorType:"operator"` y `humanApproved:true` sin signatureId → gateway lo rejecta o sobreescribe + marca impersonation.

### 5. Anchor del head hash (compensación para "tamper-evident → tamper-proof")

Agregar endpoint nuevo en `main.ts`:

```typescript
if (request.method === "GET" && request.url === "/v1/audit-chain/anchor") {
  // Devuelve { headHash, headSeq, signedAt, signature: HMAC(headHash, ANCHOR_KEY) }
  // El operador puede pegar este anchor en un canal externo (Slack, email, blockchain)
  // para tener prueba off-chain.
  const verify = await auditChainStore.verify();
  if (!verify.ok) return json(response, 422, verify);
  const headHash = verify.lastHash;
  const signedAt = new Date().toISOString();
  const message = `${headHash}|${verify.totalEvents}|${signedAt}`;
  const signature = createHmac("sha256", process.env.AUDIT_ANCHOR_KEY ?? "default-anchor-key").update(message).digest("hex");
  return json(response, 200, {
    headHash,
    headSeq: verify.totalEvents,
    signedAt,
    signature,
    instructions: "Save this output externally (Slack pinned message, email to team) as anchor proof."
  });
}
```

Env nueva: `AUDIT_ANCHOR_KEY` (32+ chars random; defaults a fallback con warning).

## Wiring en main.ts

```typescript
import { createAutoRollbackManagerFromEnv } from "./auto-rollback.ts";

const autoRollbackManager = createAutoRollbackManagerFromEnv();

// Pasarlo a los handlers que lo necesiten via deps inyectado.
```

## Reglas duras

1. **NO toques A1 audit chain** (commit `cb93e2c`). Trabajamos sobre A1 cerrado.
2. **NO ejecutes rollback de skills destructivas** (delete_domain, wipe_server) — solo reversibles.
3. **Sub-agentes seniors obligatorios**: Backend implementa, QA valida (12+ tests), Security audita el endurecimiento de `/v1/agent/audit/batch`.
4. **NO commitees `runtime/rollback-snapshots/`** (gitignored).
5. **tsc clean** para los nuevos archivos.
6. **Compatible con webhook broadcast** (b1 commit `91d020b`): cada rollback aplicado debe disparar webhook si el evento de audit es categoría crítica.

## Criterio de aceptación

```bash
cd /Users/juanescanar/Documents/delivrix\ app/apps/gateway-api
node --test src/auto-rollback.test.ts
# 12/12 verde

# Test E2E (mock):
# - Pre-snapshot DNS guardado en runtime/rollback-snapshots/
# - Mutación simulada falla propagación
# - Rollback aplicado
# - Audit event oc.dns.auto_rolled_back emitido
# - Audit chain íntegra:
curl -s http://localhost:3000/v1/audit-chain/verify | jq '.ok'
# true

# Anchor:
curl -s http://localhost:3000/v1/audit-chain/anchor | jq
# { "headHash":"...", "headSeq":N, "signedAt":"...", "signature":"..." }
```

## Commit + push

```
fix(gateway): auto-rollback DNS+SMTP + endurecer audit batch origin + anchor endpoint

- AutoRollbackManager: snapshots pre-mutación + waitForDnsPropagation + shouldAutoPauseWarmup
- Wired DNS route53/ionos upsert con captura + verify async + rollback
- Wired warmup-ramp con auto-pause si bounce > 5%
- /v1/agent/audit/batch rechaza impersonation actorType + humanApproved sin signatureId
- /v1/audit-chain/anchor expone HMAC-signed head hash para proof externo
- 12+ tests verdes, tsc clean

Ref: CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md compensaciones #1 (anchor) y #3 (auto-rollback)
Sprint Fase 0: SPRINT_FASE_0_VIERNES_12_19H_2026_05_29.md track A2
```

## Reporte a PM

Reportar SHA + tests + curl outputs + cualquier riesgo. PM despachará A3 (smoke E2E) cuando A2 cierre y B3 (ApprovalGate) tenga su wiring en `/canvas` o `/sender-pool`.

— Claude PM
