import { promises as dnsPromises } from "node:dns";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type RollbackKind = "dns" | "smtp" | "webdock";

export interface RollbackSnapshot {
  auditId: string;
  kind: RollbackKind;
  /** Payload con el estado PRE-mutacion que se puede restaurar. */
  beforeState: unknown;
  /** Metadatos opcionales para diagnosticar: domain, serverSlug, provider, etc. */
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
  /** Tiempo maximo de propagacion antes de considerar fallida. Default 5 min. */
  propagationTimeoutMs?: number;
  /** Intervalo de poll para verificar propagacion. Default 30s. */
  pollIntervalMs?: number;
}

export interface SmtpRollbackPolicy {
  /** Maximo bounce rate aceptable. Default 0.05 (5%). */
  maxBounceRate?: number;
  /** Minimo numero de envios antes de evaluar. Default 10. */
  minSendsBeforeCheck?: number;
}

export interface WebdockRollbackPolicy {
  /** Tiempo maximo cloud-init. Default 15 min. */
  cloudInitTimeoutMs?: number;
}

export interface AutoRollbackManagerOptions {
  snapshotDir?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  dnsPolicy?: DnsRollbackPolicy;
  smtpPolicy?: SmtpRollbackPolicy;
  webdockPolicy?: WebdockRollbackPolicy;
}

export interface DnsExpectedRecord {
  domain?: string;
  type: string;
  value: string;
}

export type DnsDigFn = (domain: string, type: string) => Promise<string[]>;

export interface AutoRollbackPoliciesSnapshot {
  dns: Required<DnsRollbackPolicy>;
  smtp: Required<SmtpRollbackPolicy>;
  webdock: Required<WebdockRollbackPolicy>;
}

// Debe ser >= la ventana del paso wait_for_dns_propagation del orquestador (30 min).
// Con 5 min el watchdog borraba registros legitimos mientras el run seguia esperando
// propagacion (el negative cache del SOA es de 900s = 15 min). Incidente 2026-06-10:
// A+MX de controlnational.com y corpfiling-ops.com revertidos a los 5:02 del upsert.
const DEFAULT_DNS_PROPAGATION_MS = 30 * 60 * 1000;
const DEFAULT_DNS_POLL_MS = 30 * 1000;
const DEFAULT_SMTP_MAX_BOUNCE_RATE = 0.05;
const DEFAULT_SMTP_MIN_SENDS = 10;
const DEFAULT_WEBDOCK_CLOUDINIT_MS = 15 * 60 * 1000;

export class AutoRollbackManager {
  private readonly snapshotDir: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly dnsPolicy: Required<DnsRollbackPolicy>;
  private readonly smtpPolicy: Required<SmtpRollbackPolicy>;
  private readonly webdockPolicy: Required<WebdockRollbackPolicy>;

  constructor(options: AutoRollbackManagerOptions = {}) {
    this.snapshotDir = resolve(
      options.snapshotDir ?? process.env.ROLLBACK_SNAPSHOT_DIR ?? "runtime/rollback-snapshots"
    );
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.dnsPolicy = {
      propagationTimeoutMs: positiveNumber(
        options.dnsPolicy?.propagationTimeoutMs,
        DEFAULT_DNS_PROPAGATION_MS
      ),
      pollIntervalMs: positiveNumber(options.dnsPolicy?.pollIntervalMs, DEFAULT_DNS_POLL_MS)
    };
    this.smtpPolicy = {
      maxBounceRate: positiveNumber(options.smtpPolicy?.maxBounceRate, DEFAULT_SMTP_MAX_BOUNCE_RATE),
      minSendsBeforeCheck: positiveInteger(
        options.smtpPolicy?.minSendsBeforeCheck,
        DEFAULT_SMTP_MIN_SENDS
      )
    };
    this.webdockPolicy = {
      cloudInitTimeoutMs: positiveNumber(
        options.webdockPolicy?.cloudInitTimeoutMs,
        DEFAULT_WEBDOCK_CLOUDINIT_MS
      )
    };
  }

  policies(): AutoRollbackPoliciesSnapshot {
    return {
      dns: { ...this.dnsPolicy },
      smtp: { ...this.smtpPolicy },
      webdock: { ...this.webdockPolicy }
    };
  }

  async captureSnapshot(snapshot: Omit<RollbackSnapshot, "capturedAt">): Promise<void> {
    const full: RollbackSnapshot = {
      ...snapshot,
      capturedAt: this.now().toISOString()
    };
    await mkdir(this.snapshotDir, { recursive: true });
    await writeFile(this.snapshotPath(snapshot.auditId, snapshot.kind), JSON.stringify(full, null, 2), "utf-8");
  }

  async loadSnapshot(auditId: string, kind: RollbackKind): Promise<RollbackSnapshot | null> {
    try {
      const raw = await readFile(this.snapshotPath(auditId, kind), "utf-8");
      return JSON.parse(raw) as RollbackSnapshot;
    } catch {
      return null;
    }
  }

  async waitForDnsPropagation(input: {
    auditId: string;
    domain: string;
    expectedRecords: DnsExpectedRecord[];
    digFn: DnsDigFn;
  }): Promise<{ propagated: boolean; elapsedMs: number; lastChecked: string }> {
    const startedAt = this.now().getTime();
    let lastChecked = startedAt;

    do {
      let allOk = input.expectedRecords.length > 0;
      for (const record of input.expectedRecords) {
        const observed = await input.digFn(record.domain ?? input.domain, record.type).catch(() => []);
        if (!observed.some((value) => dnsValueMatches(value, record.value, record.type))) {
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

      if (lastChecked - startedAt >= this.dnsPolicy.propagationTimeoutMs) {
        break;
      }
      await this.sleep(this.dnsPolicy.pollIntervalMs);
    } while (this.now().getTime() - startedAt <= this.dnsPolicy.propagationTimeoutMs);

    const endedAt = this.now().getTime();
    return {
      propagated: false,
      elapsedMs: endedAt - startedAt,
      lastChecked: new Date(endedAt).toISOString()
    };
  }

  shouldAutoPauseWarmup(input: { sent: number; bounced: number }): {
    pause: boolean;
    reason: string;
    bounceRate: number;
  } {
    if (input.sent < this.smtpPolicy.minSendsBeforeCheck) {
      return { pause: false, reason: "insufficient_sample", bounceRate: 0 };
    }
    const bounceRate = input.bounced / Math.max(1, input.sent);
    if (bounceRate > this.smtpPolicy.maxBounceRate) {
      return {
        pause: true,
        reason: `bounce_rate_${(bounceRate * 100).toFixed(1)}pct_exceeded_threshold_${(this.smtpPolicy.maxBounceRate * 100).toFixed(1)}pct`,
        bounceRate
      };
    }
    return { pause: false, reason: "within_threshold", bounceRate };
  }

  shouldSnapshotWebdockCloudInit(input: { startedAt: string; completedAt?: string | null }): {
    snapshot: boolean;
    reason: string;
    elapsedMs: number;
  } {
    const startedAt = Date.parse(input.startedAt);
    if (!Number.isFinite(startedAt)) {
      return { snapshot: false, reason: "invalid_started_at", elapsedMs: 0 };
    }
    if (input.completedAt) {
      return { snapshot: false, reason: "cloud_init_completed", elapsedMs: 0 };
    }
    const elapsedMs = this.now().getTime() - startedAt;
    if (elapsedMs > this.webdockPolicy.cloudInitTimeoutMs) {
      return { snapshot: true, reason: "cloud_init_timeout", elapsedMs };
    }
    return { snapshot: false, reason: "within_threshold", elapsedMs };
  }

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

  async listSnapshots(kind?: RollbackKind): Promise<RollbackSnapshot[]> {
    try {
      const files = await readdir(this.snapshotDir);
      const matches = files.filter((file) =>
        kind ? file.startsWith(`${kind}-`) && file.endsWith(".json") : file.endsWith(".json")
      );
      const snapshots: RollbackSnapshot[] = [];
      for (const file of matches) {
        try {
          snapshots.push(JSON.parse(await readFile(join(this.snapshotDir, file), "utf-8")) as RollbackSnapshot);
        } catch {
          // Corrupted local diagnostic files must not break rollback inspection.
        }
      }
      return snapshots;
    } catch {
      return [];
    }
  }

  private snapshotPath(auditId: string, kind: RollbackKind): string {
    return join(this.snapshotDir, `${kind}-${safeSnapshotId(auditId)}.json`);
  }
}

export function createSafeDigFn(options: {
  timeoutMs?: number;
  resolveFn?: (domain: string, rrtype: string) => Promise<unknown>;
} = {}): DnsDigFn {
  const timeoutMs = positiveNumber(options.timeoutMs, 5_000);
  const resolveFn = options.resolveFn ?? ((domain, rrtype) => dnsPromises.resolve(domain, rrtype));
  return async (domain, type) => {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("dns_lookup_timeout")), timeoutMs);
    });
    const records = await Promise.race([resolveFn(domain, type), timeout]);
    return flattenDnsRecords(records);
  };
}

export function createAutoRollbackManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AutoRollbackManager {
  return new AutoRollbackManager({
    snapshotDir: env.ROLLBACK_SNAPSHOT_DIR,
    dnsPolicy: {
      propagationTimeoutMs: numberFromEnv(env.DNS_ROLLBACK_TIMEOUT_MS),
      pollIntervalMs: numberFromEnv(env.DNS_ROLLBACK_POLL_MS)
    },
    smtpPolicy: {
      maxBounceRate: numberFromEnv(env.SMTP_MAX_BOUNCE_RATE),
      minSendsBeforeCheck: numberFromEnv(env.SMTP_MIN_SENDS_BEFORE_CHECK)
    },
    webdockPolicy: {
      cloudInitTimeoutMs: numberFromEnv(env.WEBDOCK_CLOUDINIT_TIMEOUT_MS)
    }
  });
}

function flattenDnsRecords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenDnsRecords(item));
  }
  if (value && typeof value === "object") {
    return [Object.values(value as Record<string, unknown>).map((part) => String(part)).join(" ")];
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [String(value)];
}

function dnsValueMatches(observed: string, expected: string, type: string): boolean {
  const observedNormalized = normalizeDnsValue(observed);
  const expectedNormalized = normalizeDnsValue(expected);
  if (type.toUpperCase() === "MX") {
    const observedMx = parseMxValue(observedNormalized);
    const expectedMx = parseMxValue(expectedNormalized);
    if (!observedMx.exchange || observedMx.exchange !== expectedMx.exchange) {
      return false;
    }
    if (observedMx.priority !== undefined && expectedMx.priority !== undefined) {
      return observedMx.priority === expectedMx.priority;
    }
    return true;
  }
  return observedNormalized === expectedNormalized;
}

// Node resolveMx entrega objetos {exchange, priority} que flattenDnsRecords une en
// orden de insercion ("smtp.x.com 10"), mientras Route53 expresa el MX como
// "10 smtp.x.com.". El matcher anterior solo entendia prioridad-adelante, asi que
// el MX nunca matcheaba, el watchdog expiraba y el rollback borraba A+MX recien
// creados (incidente 2026-06-10). Canonicalizamos ambos lados a {priority?, exchange}.
function parseMxValue(value: string): { priority?: number; exchange: string } {
  const parts = value
    .split(/\s+/)
    .map((part) => part.replace(/\.$/, ""))
    .filter(Boolean);
  if (parts.length === 2) {
    const numericIndex = parts.findIndex((part) => /^\d+$/.test(part));
    if (numericIndex >= 0) {
      return { priority: Number(parts[numericIndex]), exchange: parts[1 - numericIndex] };
    }
  }
  return { exchange: parts.join(" ") };
}

function normalizeDnsValue(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/\.$/, "").toLowerCase();
}

function safeSnapshotId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return Number(value);
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
