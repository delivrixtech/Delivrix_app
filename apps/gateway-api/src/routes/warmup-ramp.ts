import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveStateSnapshot,
  WarmupRampBatch,
  WarmupRampPauseReason,
  WarmupRampSchedule,
  WarmupRampState
} from "../../../../packages/domain/src/index.ts";
import {
  BOUNCE_RATE_AUTO_PAUSE,
  getWarmupRampPlan,
  isWarmupRampSchedule,
  materializeRampBatches
} from "../../../../packages/domain/src/warmup/ramp-plan.ts";
import {
  appendWarmupRamp,
  appendWarmupRampEvent,
  getActiveRamps,
  getRampById,
  getRampByDomain,
  updateWarmupRamp,
  type OpenClawWorkspace,
  type WarmupRampRecord
} from "../openclaw-workspace.ts";
import type {
  SmtpSshCommandResult,
  SmtpSshRunner
} from "./smtp-provisioning.ts";
import type { AutoRollbackManager } from "../auto-rollback.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

interface WebhookBroadcaster {
  broadcast(event: AuditEventInput): Promise<unknown>;
}

type Timer = ReturnType<typeof setTimeout>;
type TimerFactory = (handler: () => void, ms: number) => Timer;
type TimerCanceler = (timer: Timer) => void;

export interface RampSchedulerDependencies {
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  setTimer?: TimerFactory;
  clearTimer?: TimerCanceler;
  autoRollbackManager?: AutoRollbackManager;
  webhookBroadcaster?: WebhookBroadcaster;
}

export interface StartRampInput {
  domain: string;
  serverSlug: string | null;
  serverIp: string;
  schedule: WarmupRampSchedule;
  recipientPool: string[];
  actorId: string;
  approvalToken: string;
}

const APPROVAL_MAX_AGE_MS = 15 * 60 * 1000;
const SKILL_NAME = "warmup_ramp_scheduler";

/**
 * Scheduler in-process. Mantiene un `Map<rampId, Timer>` para poder cancelar
 * timers en pause/resume. No usa BullMQ — `setTimeout` simple + persistencia
 * en `warmup-progress.json` para resume-on-boot.
 */
export class RampScheduler {
  private readonly timers = new Map<string, Timer>();
  private readonly setTimer: TimerFactory;
  private readonly clearTimer: TimerCanceler;
  private readonly now: () => Date;
  private readonly deps: RampSchedulerDependencies;

  constructor(deps: RampSchedulerDependencies) {
    this.deps = deps;
    this.setTimer = deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Inicia un ramp. Crea el record, enqueue batch 0 inmediatamente y agenda
   * batches 1..N con setTimeout. Devuelve el record persistido.
   */
  async startRamp(input: StartRampInput): Promise<WarmupRampRecord> {
    const startedAt = this.now();
    const plan = getWarmupRampPlan(input.schedule);
    const batches = materializeRampBatches({
      schedule: input.schedule,
      startAt: startedAt
    });
    const rampId = `ramp-${randomUUID()}`;
    const record: WarmupRampRecord = {
      rampId,
      domain: input.domain,
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      schedule: input.schedule,
      state: "running",
      recipientPool: input.recipientPool,
      totalPlanned: plan.totalEmails,
      totalSent: 0,
      totalBounced: 0,
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      nextBatchAt: batches[0]?.scheduledAt,
      batches,
      actorId: input.actorId,
      approvalToken: input.approvalToken
    };

    await appendWarmupRamp(this.deps.workspace, record);
    await appendWarmupRampEvent(this.deps.workspace, {
      rampId,
      occurredAt: startedAt.toISOString(),
      action: "oc.warmup.ramp_started",
      metadata: {
        domain: input.domain,
        schedule: input.schedule,
        totalPlanned: plan.totalEmails,
        batchesPlanned: batches.length
      }
    });
    await this.deps.auditLog.append({
      actorType: "operator",
      actorId: input.actorId,
      action: "oc.warmup.ramp_started",
      targetType: "domain",
      targetId: input.domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [input.actorId],
      metadata: {
        rampId,
        schedule: input.schedule,
        totalPlanned: plan.totalEmails,
        batchesPlanned: batches.length,
        approvalToken: input.approvalToken
      }
    });

    // Batch 0 ejecuta de inmediato en background; batches 1..N programados.
    void this.runBatch(rampId, 0);
    for (let i = 1; i < batches.length; i++) {
      this.scheduleBatch(rampId, i, batches[i].scheduledAt);
    }
    return record;
  }

  /**
   * Reagenda un ramp leído de disco (resume-on-boot). Si el próximo batch ya
   * está atrasado, lo ejecuta de inmediato.
   */
  async rehydrate(rampId: string): Promise<void> {
    const ramp = await getRampById(this.deps.workspace, rampId);
    if (!ramp || ramp.state !== "running") return;
    const nowMs = this.now().getTime();
    for (const batch of ramp.batches) {
      if (batch.status !== "pending") continue;
      const scheduledMs = Date.parse(batch.scheduledAt);
      const delay = Math.max(0, scheduledMs - nowMs);
      this.scheduleBatch(rampId, batch.batchIndex, batch.scheduledAt, delay);
    }
  }

  async pauseRamp(input: {
    rampId: string;
    reason: WarmupRampPauseReason;
    actorId: string;
  }): Promise<WarmupRampRecord | null> {
    const timer = this.timers.get(input.rampId);
    if (timer) {
      this.clearTimer(timer);
      this.timers.delete(input.rampId);
    }
    const occurredAt = this.now();
    const targetState: WarmupRampState =
      input.reason === "manual" ? "paused" : "auto_paused";
    const updated = await updateWarmupRamp(this.deps.workspace, input.rampId, {
      state: targetState,
      pauseReason: input.reason,
      updatedAt: occurredAt.toISOString()
    });
    if (!updated) return null;
    await appendWarmupRampEvent(this.deps.workspace, {
      rampId: input.rampId,
      occurredAt: occurredAt.toISOString(),
      action: "oc.warmup.ramp_paused",
      metadata: {
        reason: input.reason,
        actorId: input.actorId,
        domain: updated.domain
      }
    });
    await this.deps.auditLog.append({
      actorType: input.reason === "manual" ? "operator" : "system",
      actorId: input.actorId,
      action: "oc.warmup.ramp_paused",
      targetType: "domain",
      targetId: updated.domain,
      riskLevel: "high",
      decision: "allow",
      humanApproved: input.reason === "manual",
      metadata: { rampId: input.rampId, reason: input.reason }
    });
    return updated;
  }

  async resumeRamp(input: {
    rampId: string;
    actorId: string;
  }): Promise<WarmupRampRecord | null> {
    const ramp = await getRampById(this.deps.workspace, input.rampId);
    if (!ramp) return null;
    if (ramp.state === "running") return ramp;
    const occurredAt = this.now();
    // Recalcular scheduledAt para batches pendientes desde "ahora", respetando
    // los offsets originales del plan.
    const plan = getWarmupRampPlan(ramp.schedule);
    const remainingPending = ramp.batches.filter((b) => b.status === "pending");
    const baseOffset = remainingPending[0]
      ? plan.batches.find((p) => p.batchIndex === remainingPending[0].batchIndex)
          ?.offsetMs ?? 0
      : 0;
    const reanchorMs = occurredAt.getTime() - baseOffset;
    const updatedBatches: WarmupRampBatch[] = ramp.batches.map((batch) => {
      if (batch.status !== "pending") return batch;
      const planEntry = plan.batches.find((p) => p.batchIndex === batch.batchIndex);
      if (!planEntry) return batch;
      return {
        ...batch,
        scheduledAt: new Date(reanchorMs + planEntry.offsetMs).toISOString()
      };
    });
    const nextPending = updatedBatches.find((b) => b.status === "pending");
    const updated = await updateWarmupRamp(this.deps.workspace, input.rampId, {
      state: "running",
      pauseReason: undefined,
      batches: updatedBatches,
      nextBatchAt: nextPending?.scheduledAt,
      updatedAt: occurredAt.toISOString()
    });
    if (!updated) return null;
    await appendWarmupRampEvent(this.deps.workspace, {
      rampId: input.rampId,
      occurredAt: occurredAt.toISOString(),
      action: "oc.warmup.ramp_resumed",
      metadata: { actorId: input.actorId, domain: updated.domain }
    });
    await this.deps.auditLog.append({
      actorType: "operator",
      actorId: input.actorId,
      action: "oc.warmup.ramp_resumed",
      targetType: "domain",
      targetId: updated.domain,
      riskLevel: "high",
      decision: "allow",
      humanApproved: true,
      metadata: { rampId: input.rampId }
    });
    for (const batch of updatedBatches) {
      if (batch.status !== "pending") continue;
      const delay = Math.max(0, Date.parse(batch.scheduledAt) - occurredAt.getTime());
      this.scheduleBatch(input.rampId, batch.batchIndex, batch.scheduledAt, delay);
    }
    return updated;
  }

  async getRamp(rampId: string): Promise<WarmupRampRecord | null> {
    return getRampById(this.deps.workspace, rampId);
  }

  async getRampByDomainName(domain: string): Promise<WarmupRampRecord | null> {
    return getRampByDomain(this.deps.workspace, domain);
  }

  listActive(): string[] {
    return [...this.timers.keys()];
  }

  /**
   * Solo para tests: ejecuta el handler de un batch sincrónicamente.
   */
  async runBatchForTest(rampId: string, batchIndex: number): Promise<void> {
    await this.runBatch(rampId, batchIndex);
  }

  private scheduleBatch(
    rampId: string,
    batchIndex: number,
    scheduledAt: string,
    delayOverride?: number
  ): void {
    const delay =
      delayOverride ?? Math.max(0, Date.parse(scheduledAt) - this.now().getTime());
    const key = batchTimerKey(rampId, batchIndex);
    const timer = this.setTimer(() => {
      this.timers.delete(key);
      void this.runBatch(rampId, batchIndex);
    }, delay);
    this.timers.set(key, timer);
    // Mantener entrada principal por ramp apuntando al timer más próximo.
    if (!this.timers.has(rampId)) {
      this.timers.set(rampId, timer);
    }
  }

  /**
   * Núcleo del scheduler: corre un batch via sshRunner, parsea stdout/stderr
   * para inferir deliveryRate/bounceRate y decide auto-pause si bounce >5%.
   */
  private async runBatch(rampId: string, batchIndex: number): Promise<void> {
    const ramp = await getRampById(this.deps.workspace, rampId);
    if (!ramp) return;
    if (ramp.state !== "running") return;
    const batchSnapshot = ramp.batches[batchIndex];
    if (!batchSnapshot || batchSnapshot.status !== "pending") return;

    const startedAt = this.now();
    const recipients = pickRecipients(ramp.recipientPool, batchSnapshot.emailCount);

    let result: SmtpSshCommandResult;
    try {
      result = await this.deps.sshRunner.run({
        serverIp: ramp.serverIp,
        command: `/usr/sbin/sendmail -t -f ${shellQuote(`noreply@${ramp.domain}`)}`,
        stdin: renderBatchPayload({
          domain: ramp.domain,
          rampId,
          batchIndex,
          recipients,
          now: startedAt
        }),
        timeoutMs: 120_000
      });
    } catch (error) {
      await this.handleBatchFailure(ramp, batchIndex, errorMessage(error));
      return;
    }

    const completedAt = this.now();
    const { sentCount, bouncedCount } = parseSendmailOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      attempted: batchSnapshot.emailCount
    });
    const deliveryRate = sentCount / Math.max(1, batchSnapshot.emailCount);
    const bounceRate = bouncedCount / Math.max(1, batchSnapshot.emailCount);

    const updatedBatches = ramp.batches.map((b) =>
      b.batchIndex === batchIndex
        ? {
            ...b,
            status: "sent" as const,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            sentCount,
            bouncedCount,
            deliveryRate,
            bounceRate
          }
        : b
    );
    const totalSent = updatedBatches.reduce((sum, b) => sum + (b.sentCount ?? 0), 0);
    const totalBounced = updatedBatches.reduce(
      (sum, b) => sum + (b.bouncedCount ?? 0),
      0
    );
    const nextPending = updatedBatches.find((b) => b.status === "pending");
    const allDone = !nextPending;
    const newState: WarmupRampState = allDone ? "completed" : "running";
    await updateWarmupRamp(this.deps.workspace, rampId, {
      batches: updatedBatches,
      totalSent,
      totalBounced,
      nextBatchAt: nextPending?.scheduledAt,
      state: newState,
      completedAt: allDone ? completedAt.toISOString() : undefined,
      updatedAt: completedAt.toISOString()
    });
    await appendWarmupRampEvent(this.deps.workspace, {
      rampId,
      occurredAt: completedAt.toISOString(),
      action: "oc.warmup.ramp_batch_sent",
      batchIndex,
      metadata: {
        domain: ramp.domain,
        emailCount: batchSnapshot.emailCount,
        sentCount,
        bouncedCount,
        deliveryRate,
        bounceRate,
        exitCode: result.exitCode
      }
    });
    await this.deps.auditLog.append({
      actorType: "system",
      actorId: "ramp-scheduler",
      action: "oc.warmup.ramp_batch_sent",
      targetType: "domain",
      targetId: ramp.domain,
      riskLevel: "high",
      decision: "allow",
      humanApproved: false,
      metadata: {
        rampId,
        batchIndex,
        emailCount: batchSnapshot.emailCount,
        sentCount,
        bouncedCount,
        deliveryRate: Number(deliveryRate.toFixed(4)),
        bounceRate: Number(bounceRate.toFixed(4))
      }
    });
    await safeEmit(this.deps.canvasLiveEvents, {
      type: "oc.action.now",
      taskId: `ramp-${rampId}`,
      kind: "command",
      cmd: `ramp batch ${batchIndex + 1}/${ramp.batches.length} · ${batchSnapshot.emailCount} emails`,
      exitCode: result.exitCode ?? 0,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      occurredAt: completedAt.toISOString()
    });

    const autoPauseDecision = this.deps.autoRollbackManager?.shouldAutoPauseWarmup({
      sent: totalSent,
      bounced: totalBounced
    }) ?? {
      pause: bounceRate > BOUNCE_RATE_AUTO_PAUSE,
      reason: "batch_bounce_rate_exceeded",
      bounceRate
    };

    if (autoPauseDecision.pause) {
      await this.pauseRamp({
        rampId,
        reason: "auto_bounce_rate",
        actorId: "ramp-scheduler"
      });
      await appendWarmupRampEvent(this.deps.workspace, {
        rampId,
        occurredAt: completedAt.toISOString(),
        action: "oc.warmup.ramp_auto_paused",
        batchIndex,
        metadata: {
          domain: ramp.domain,
          totalSent,
          totalBounced,
          reason: autoPauseDecision.reason,
          bounceRate: Number(autoPauseDecision.bounceRate.toFixed(4))
        }
      });
      const autoPauseAudit: AuditEventInput = {
        actorType: "system",
        actorId: "auto-rollback",
        action: "oc.warmup.ramp_auto_paused",
        targetType: "domain",
        targetId: ramp.domain,
        riskLevel: "critical",
        decision: "allow",
        humanApproved: false,
        metadata: {
          rampId,
          batchIndex,
          totalSent,
          totalBounced,
          reason: autoPauseDecision.reason,
          bounceRate: Number(autoPauseDecision.bounceRate.toFixed(4))
        }
      };
      await this.deps.auditLog.append(autoPauseAudit);
      void this.deps.webhookBroadcaster?.broadcast(autoPauseAudit).catch(() => undefined);
      return;
    }
    if (allDone) {
      await appendWarmupRampEvent(this.deps.workspace, {
        rampId,
        occurredAt: completedAt.toISOString(),
        action: "oc.warmup.ramp_completed",
        metadata: { domain: ramp.domain, totalSent, totalBounced }
      });
      await this.deps.auditLog.append({
        actorType: "system",
        actorId: "ramp-scheduler",
        action: "oc.warmup.ramp_completed",
        targetType: "domain",
        targetId: ramp.domain,
        riskLevel: "high",
        decision: "allow",
        humanApproved: false,
        metadata: { rampId, totalSent, totalBounced }
      });
      // Garbage-collect cualquier timer residual
      for (const key of [...this.timers.keys()]) {
        if (key === rampId || key.startsWith(`${rampId}::`)) {
          const t = this.timers.get(key);
          if (t) this.clearTimer(t);
          this.timers.delete(key);
        }
      }
    }
  }

  private async handleBatchFailure(
    ramp: WarmupRampRecord,
    batchIndex: number,
    message: string
  ): Promise<void> {
    const occurredAt = this.now();
    const updatedBatches = ramp.batches.map((b) =>
      b.batchIndex === batchIndex
        ? { ...b, status: "failed" as const, error: message, completedAt: occurredAt.toISOString() }
        : b
    );
    await updateWarmupRamp(this.deps.workspace, ramp.rampId, {
      batches: updatedBatches,
      state: "auto_paused",
      pauseReason: "send_failed",
      updatedAt: occurredAt.toISOString()
    });
    await appendWarmupRampEvent(this.deps.workspace, {
      rampId: ramp.rampId,
      occurredAt: occurredAt.toISOString(),
      action: "oc.warmup.ramp_failed",
      batchIndex,
      metadata: { domain: ramp.domain, error: message }
    });
    await this.deps.auditLog.append({
      actorType: "system",
      actorId: "ramp-scheduler",
      action: "oc.warmup.ramp_failed",
      targetType: "domain",
      targetId: ramp.domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: { rampId: ramp.rampId, batchIndex, errorMessage: message }
    });
    for (const key of [...this.timers.keys()]) {
      if (key === ramp.rampId || key.startsWith(`${ramp.rampId}::`)) {
        const t = this.timers.get(key);
        if (t) this.clearTimer(t);
        this.timers.delete(key);
      }
    }
  }
}

function batchTimerKey(rampId: string, batchIndex: number): string {
  return `${rampId}::${batchIndex}`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* HTTP handlers                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export interface WarmupRampStartHttpDeps {
  request: IncomingMessage;
  response: ServerResponse;
  scheduler: RampScheduler;
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  workspace: OpenClawWorkspace;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface RampStartBody {
  domain?: unknown;
  serverSlug?: unknown;
  serverIp?: unknown;
  schedule?: unknown;
  recipientPool?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
}

interface DomainsInventory {
  bindings?: Array<{ domain: string; serverSlug: string | null; serverIp: string }>;
}

interface WebdockServersInventory {
  servers?: Array<{ slug: string; ipv4: string | null }>;
}

export async function handleRampStartHttp(deps: WarmupRampStartHttpDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<RampStartBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const schedule = body.schedule;
  if (!isWarmupRampSchedule(schedule)) {
    throw new WarmupRampInputError(
      "schedule must be 'demo-fast' or 'production-14d'."
    );
  }
  const recipientPool = parseRecipientPool(body.recipientPool);
  const serverSlug =
    typeof body.serverSlug === "string" && body.serverSlug.trim()
      ? normalizeSlug(body.serverSlug)
      : await findBoundServerSlug(deps.workspace, domain);
  const serverIp =
    typeof body.serverIp === "string" && body.serverIp.trim()
      ? normalizeIpv4(body.serverIp)
      : await findServerIp(deps.workspace, domain, serverSlug);

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: APPROVAL_MAX_AGE_MS
  });

  const plan = getWarmupRampPlan(schedule);
  const blockers: string[] = [];
  if (env.WARMUP_RAMP_ENABLE !== "true") blockers.push("warmup_ramp_flag_disabled");
  if (env.WARMUP_ENABLE_SEND !== "true") blockers.push("warmup_send_flag_disabled");
  if (!deps.sshRunner.isConfigured()) blockers.push("warmup_ssh_runner_missing");
  if (!approval) blockers.push("approval_not_found_or_expired");
  if (!serverIp) blockers.push("server_ip_missing");
  if (recipientPool.length < plan.recipientPoolMin) {
    blockers.push(`recipient_pool_too_small_min_${plan.recipientPoolMin}`);
  }

  if (blockers.length > 0) {
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.warmup.ramp_start_blocked",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: { blockers, schedule, serverSlug }
    });
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      domain,
      schedule,
      blockers
    });
    return;
  }

  const record = await deps.scheduler.startRamp({
    domain,
    serverSlug,
    serverIp: serverIp!,
    schedule,
    recipientPool,
    actorId,
    approvalToken
  });

  json(deps.response, 202, {
    ok: true,
    status: "started",
    rampId: record.rampId,
    domain,
    schedule,
    batchesPlanned: record.batches.length,
    totalPlanned: record.totalPlanned,
    nextBatchAt: record.nextBatchAt
  });
}

export interface WarmupRampReadHttpDeps {
  request: IncomingMessage;
  response: ServerResponse;
  scheduler: RampScheduler;
  rampId: string;
}

export async function handleRampGetHttp(deps: WarmupRampReadHttpDeps): Promise<void> {
  const record = await deps.scheduler.getRamp(deps.rampId);
  if (!record) {
    json(deps.response, 404, { error: "ramp_not_found", rampId: deps.rampId });
    return;
  }
  json(deps.response, 200, rampSnapshot(record));
}

export interface WarmupRampPauseHttpDeps {
  request: IncomingMessage;
  response: ServerResponse;
  scheduler: RampScheduler;
  rampId: string;
  now?: () => Date;
}

interface PauseBody {
  actorId?: unknown;
}

export async function handleRampPauseHttp(deps: WarmupRampPauseHttpDeps): Promise<void> {
  const body = await readJson<PauseBody>(deps.request).catch(() => ({} as PauseBody));
  const actorId = typeof body.actorId === "string" && body.actorId.trim() ? body.actorId.trim() : "operator/unknown";
  const record = await deps.scheduler.pauseRamp({
    rampId: deps.rampId,
    reason: "manual",
    actorId
  });
  if (!record) {
    json(deps.response, 404, { error: "ramp_not_found", rampId: deps.rampId });
    return;
  }
  json(deps.response, 200, { ok: true, status: record.state, rampId: record.rampId });
}

export async function handleRampResumeHttp(deps: WarmupRampPauseHttpDeps): Promise<void> {
  const body = await readJson<PauseBody>(deps.request).catch(() => ({} as PauseBody));
  const actorId = typeof body.actorId === "string" && body.actorId.trim() ? body.actorId.trim() : "operator/unknown";
  const record = await deps.scheduler.resumeRamp({
    rampId: deps.rampId,
    actorId
  });
  if (!record) {
    json(deps.response, 404, { error: "ramp_not_found", rampId: deps.rampId });
    return;
  }
  json(deps.response, 200, { ok: true, status: record.state, rampId: record.rampId });
}

export interface WarmupRampByDomainHttpDeps {
  request: IncomingMessage;
  response: ServerResponse;
  scheduler: RampScheduler;
  domain: string;
}

export async function handleRampGetByDomainHttp(
  deps: WarmupRampByDomainHttpDeps
): Promise<void> {
  const domain = normalizeDomainName(deps.domain);
  const record = await deps.scheduler.getRampByDomainName(domain);
  if (!record) {
    json(deps.response, 404, { error: "ramp_not_found", domain });
    return;
  }
  json(deps.response, 200, rampSnapshot(record));
}

export async function resumeRampsOnBoot(deps: {
  scheduler: RampScheduler;
  workspace: OpenClawWorkspace;
}): Promise<string[]> {
  const ramps = await getActiveRamps(deps.workspace);
  const resumed: string[] = [];
  for (const ramp of ramps) {
    if (ramp.state !== "running") continue;
    await deps.scheduler.rehydrate(ramp.rampId);
    resumed.push(ramp.rampId);
  }
  return resumed;
}

export class WarmupRampInputError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "WarmupRampInputError";
  }
}

export function handleWarmupRampError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof WarmupRampInputError) {
    json(response, error.statusCode, {
      error: "invalid_warmup_ramp_request",
      message: error.message
    });
    return true;
  }
  if (error instanceof SyntaxError) {
    json(response, 400, {
      error: "invalid_json",
      message: "Request body must be valid JSON."
    });
    return true;
  }
  return false;
}

function rampSnapshot(record: WarmupRampRecord): Record<string, unknown> {
  const deliveryRate = record.totalSent / Math.max(1, sumPlanned(record.batches));
  const bounceRate = record.totalBounced / Math.max(1, sumPlanned(record.batches));
  const sentBatches = record.batches.filter((b) => b.status === "sent");
  return {
    rampId: record.rampId,
    domain: record.domain,
    schedule: record.schedule,
    state: record.state,
    pauseReason: record.pauseReason,
    serverSlug: record.serverSlug,
    serverIp: record.serverIp,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    nextBatchAt: record.nextBatchAt,
    totals: {
      planned: record.totalPlanned,
      sent: record.totalSent,
      bounced: record.totalBounced,
      deliveryRate: Number(deliveryRate.toFixed(4)),
      bounceRate: Number(bounceRate.toFixed(4))
    },
    batches: record.batches.map((batch) => ({
      batchIndex: batch.batchIndex,
      scheduledAt: batch.scheduledAt,
      emailCount: batch.emailCount,
      status: batch.status,
      sentCount: batch.sentCount,
      bouncedCount: batch.bouncedCount,
      deliveryRate: batch.deliveryRate,
      bounceRate: batch.bounceRate,
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
      error: batch.error
    })),
    sparkline: sentBatches.map((b) => ({
      batchIndex: b.batchIndex,
      emailCount: b.emailCount,
      sentCount: b.sentCount ?? 0
    }))
  };
}

function sumPlanned(batches: WarmupRampBatch[]): number {
  return batches.reduce((sum, b) => sum + b.emailCount, 0);
}

function pickRecipients(pool: string[], count: number): string[] {
  if (pool.length === 0) return [];
  if (count <= pool.length) return pool.slice(0, count);
  // Round-robin: si el batch pide más emails que recipientes únicos, ciclamos.
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(pool[i % pool.length]);
  }
  return out;
}

function renderBatchPayload(input: {
  domain: string;
  rampId: string;
  batchIndex: number;
  recipients: string[];
  now: Date;
}): string {
  const msgIdBase = `<ramp-${input.rampId}-${input.batchIndex}@${input.domain}>`;
  // Para sendmail múltiples destinatarios, el header To: es informativo;
  // sendmail usa los addresses parseados del campo To/Cc/Bcc.
  const toLine = input.recipients.slice(0, 20).join(", ");
  return [
    `From: Delivrix Ramp <noreply@${input.domain}>`,
    `To: ${toLine}`,
    `Subject: Delivrix warmup ramp · ${input.domain} · batch ${input.batchIndex + 1}`,
    `Message-ID: ${msgIdBase}`,
    `Date: ${input.now.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    `Warmup ramp batch ${input.batchIndex + 1} for ${input.domain}.`,
    `Recipients in batch: ${input.recipients.length}.`,
    ""
  ].join("\n");
}

/**
 * Heurística simple para inferir delivery/bounce de la salida de sendmail.
 * sendmail con exit 0 y stderr vacío ⇒ asumimos delivered = attempted.
 * Líneas tipo `... bounced` o `... 5xx` cuentan como bounce.
 */
function parseSendmailOutput(input: {
  stdout: string;
  stderr: string;
  attempted: number;
}): { sentCount: number; bouncedCount: number } {
  const combined = `${input.stdout}\n${input.stderr}`;
  const bounceMatches = combined.match(/\b(bounced|5\d{2})\b/gi) ?? [];
  const bouncedCount = Math.min(input.attempted, bounceMatches.length);
  const sentCount = Math.max(0, input.attempted - bouncedCount);
  return { sentCount, bouncedCount };
}

async function findBoundServerSlug(
  workspace: OpenClawWorkspace,
  domain: string
): Promise<string | null> {
  const inventory = await workspace
    .readInventoryJson<DomainsInventory>("domains.json")
    .catch(() => null);
  return inventory?.bindings?.find((entry) => entry.domain === domain)?.serverSlug ?? null;
}

async function findServerIp(
  workspace: OpenClawWorkspace,
  domain: string,
  serverSlug: string | null
): Promise<string | null> {
  const domainInventory = await workspace
    .readInventoryJson<DomainsInventory>("domains.json")
    .catch(() => null);
  const binding = domainInventory?.bindings?.find((entry) => entry.domain === domain);
  if (binding?.serverIp) return normalizeIpv4(binding.serverIp);
  if (!serverSlug) return null;
  const serverInventory = await workspace
    .readInventoryJson<WebdockServersInventory>("webdock-servers.json")
    .catch(() => null);
  const server = serverInventory?.servers?.find((entry) => entry.slug === serverSlug);
  return server?.ipv4 ? normalizeIpv4(server.ipv4) : null;
}

async function findRecentApproval(input: {
  auditLog: AuditSink;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  approvalToken: string;
  now: Date;
  maxAgeMs: number;
}) {
  if (!input.auditLog.list) return null;
  const events = await input.auditLog.list();
  const auditEvent = events.toReversed().find((event) => {
    if (event.action !== "oc.artifact.approved" || event.metadata.executionId !== input.approvalToken) {
      return false;
    }
    const approvedAt = Date.parse(event.occurredAt);
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
  });
  if (!auditEvent) return null;

  const state = await input.readCanvasState();
  return state.artifacts.find((artifact) => {
    if (artifact.approvalStatus !== "approved" || artifact.executionId !== input.approvalToken || !artifact.approvedAt) {
      return false;
    }
    const approvedAt = Date.parse(artifact.approvedAt);
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
  }) ?? null;
}

async function safeEmit(service: CanvasEmitter | undefined, event: CanvasLiveEvent): Promise<void> {
  if (!service) return;
  try {
    await service.emit(event);
  } catch {
    return;
  }
}

function parseRecipientPool(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new WarmupRampInputError("recipientPool must be an array of email strings.");
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new WarmupRampInputError("recipientPool must contain only strings.");
    }
    const normalized = item.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new WarmupRampInputError(`Invalid recipient: ${item}`);
    }
    return normalized;
  });
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new WarmupRampInputError(`Invalid domain name: ${value}`);
  }
  return normalized;
}

function normalizeSlug(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    throw new WarmupRampInputError("serverSlug is invalid.");
  }
  return normalized;
}

function normalizeIpv4(value: string): string {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)) {
    throw new WarmupRampInputError(`Invalid IPv4 address: ${value}`);
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WarmupRampInputError(`${field} is required.`);
  }
  return value.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncate(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}...<truncated>`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown ramp scheduler error";
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new WarmupRampInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
