import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  CanvasLiveEvent,
  CanvasLiveStateSnapshot,
  WarmupRampSchedule
} from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import type {
  SmtpSshCommandInput,
  SmtpSshCommandResult,
  SmtpSshRunner
} from "./smtp-provisioning.ts";
import {
  handleRampStartHttp,
  handleWarmupRampError,
  RampScheduler
} from "./warmup-ramp.ts";
import { warmupFromAddress } from "./warmup-sender.ts";

const fixedNow = new Date("2026-05-28T11:00:00.000Z");

interface FakeTimer {
  id: number;
  delay: number;
  scheduledAt: number;
  fire: () => void;
  cancelled: boolean;
}

class FakeClock {
  private currentMs: number;
  private nextId = 1;
  private readonly active = new Map<number, FakeTimer>();

  constructor(start: Date) {
    this.currentMs = start.getTime();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  setTimer = (handler: () => void, ms: number): FakeTimer => {
    const timer: FakeTimer = {
      id: this.nextId++,
      delay: ms,
      scheduledAt: this.currentMs + ms,
      fire: handler,
      cancelled: false
    };
    this.active.set(timer.id, timer);
    return timer;
  };

  clearTimer = (timer: FakeTimer): void => {
    timer.cancelled = true;
    this.active.delete(timer.id);
  };

  async advanceBy(ms: number): Promise<void> {
    const target = this.currentMs + ms;
    await drain();
    while (true) {
      const due = [...this.active.values()]
        .filter((t) => !t.cancelled && t.scheduledAt <= target)
        .sort((a, b) => a.scheduledAt - b.scheduledAt);
      if (due.length === 0) break;
      const next = due[0];
      this.currentMs = next.scheduledAt;
      this.active.delete(next.id);
      next.fire();
      await drain();
    }
    this.currentMs = target;
    await drain();
  }
}

/**
 * Drena la cola de microtasks + macrotasks reales (incluido el thread pool
 * de libuv que sirve fs.promises) para que toda la cadena de awaits del
 * scheduler se complete antes de leer estado.
 *
 * NOTA: usamos `setTimeout(resolve, 0)` real porque `fs.promises.writeFile`
 * usa el thread pool, no la microtask queue.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

test("RampScheduler · demo-fast ejecuta 5 batches a 0/2/4/6/8 min con fake timers", async () => {
  const clock = new FakeClock(fixedNow);
  const harness = await schedulerHarness({ clock });
  const ramp = await harness.scheduler.startRamp({
    domain: "delivrix-ramp.com",
    serverSlug: "mail-delivrix-ramp",
    serverIp: "192.0.2.55",
    schedule: "demo-fast",
    recipientPool: [
      "jectcode+seed1@gmail.com",
      "jectcode+seed2@gmail.com",
      "jectcode+seed3@gmail.com"
    ],
    actorId: "operator/juanes",
    approvalToken: "exec-ramp-1"
  });

  // batch 0 ya corrió en background; esperamos microtasks.
  await drain();

  const after0 = await harness.scheduler.getRamp(ramp.rampId);
  assert.equal(after0?.batches[0].status, "sent");
  assert.equal(after0?.batches[1].status, "pending");

  await clock.advanceBy(2 * 60_000);
  const after2 = await harness.scheduler.getRamp(ramp.rampId);
  assert.equal(after2?.batches[1].status, "sent");

  await clock.advanceBy(2 * 60_000);
  await clock.advanceBy(2 * 60_000);
  await clock.advanceBy(2 * 60_000);
  const final = await harness.scheduler.getRamp(ramp.rampId);
  assert.equal(final?.state, "completed");
  assert.equal(final?.batches.filter((b) => b.status === "sent").length, 5);
  assert.equal(harness.commands.length, 5);
  assert.equal(harness.commands.every((command) => command.serverSlug === "mail-delivrix-ramp"), true);
  assert.equal(
    harness.commands[0].command,
    `/usr/sbin/sendmail -t -f '${warmupFromAddress("delivrix-ramp.com")}'`
  );
  assert.equal(
    harness.commands[0].stdin?.includes(`From: Delivrix Ramp <${warmupFromAddress("delivrix-ramp.com")}>`),
    true
  );
  assert.equal(
    harness.commands.some((command) => command.command.includes("noreply@") || command.stdin?.includes("noreply@")),
    false
  );
  // Email counts crecen 3,9,27,81,150
  assert.deepEqual(
    final?.batches.map((b) => b.emailCount),
    [3, 9, 27, 81, 150]
  );
});

test("RampScheduler · pause cancela timers pendientes", async () => {
  const clock = new FakeClock(fixedNow);
  const harness = await schedulerHarness({ clock });
  const ramp = await harness.scheduler.startRamp({
    domain: "delivrix-ramp.com",
    serverSlug: null,
    serverIp: "192.0.2.55",
    schedule: "demo-fast",
    recipientPool: ["a@x.com", "b@x.com", "c@x.com"],
    actorId: "operator/juanes",
    approvalToken: "exec-ramp-pause"
  });

  await drain();

  await harness.scheduler.pauseRamp({
    rampId: ramp.rampId,
    reason: "manual",
    actorId: "operator/juanes"
  });

  // Avanzamos 10 min: no debería ejecutarse ningún batch nuevo.
  await clock.advanceBy(10 * 60_000);
  const after = await harness.scheduler.getRamp(ramp.rampId);
  assert.equal(after?.state, "paused");
  assert.equal(after?.batches[0].status, "sent");
  assert.equal(after?.batches[1].status, "pending");
  // batch 0 sí corrió antes del pause; batches 1..4 no
  assert.equal(harness.commands.length, 1);
});

test("RampScheduler · auto-pausa cuando bounce >5%", async () => {
  const clock = new FakeClock(fixedNow);
  // sendmail devuelve 1 línea "bounced" cuando se envían >5% del batch.
  // Para batch 1 (9 emails), 1 bounced = 11% > 5% → auto pause.
  const harness = await schedulerHarness({
    clock,
    run: async (input) => {
      // primer batch (3 emails) no bouncea. segundo batch (9) sí.
      if (input.stdin?.includes("batch 2")) {
        return { stdout: "queued; 1 bounced", stderr: "", exitCode: 0 };
      }
      return { stdout: "queued", stderr: "", exitCode: 0 };
    }
  });

  const ramp = await harness.scheduler.startRamp({
    domain: "delivrix-ramp.com",
    serverSlug: null,
    serverIp: "192.0.2.55",
    schedule: "demo-fast",
    recipientPool: ["a@x.com", "b@x.com", "c@x.com"],
    actorId: "operator/juanes",
    approvalToken: "exec-ramp-auto"
  });

  await drain();

  // Avanzamos para que corra batch 1 (t=2min).
  await clock.advanceBy(2 * 60_000);
  const after = await harness.scheduler.getRamp(ramp.rampId);
  assert.equal(after?.state, "auto_paused");
  assert.equal(after?.pauseReason, "auto_bounce_rate");
  assert.equal(after?.batches[1].bouncedCount, 1);
  assert.ok((after?.batches[1].bounceRate ?? 0) > 0.05);

  // Avanzamos otros 4 min: NO debe correr batches 2..4
  await clock.advanceBy(4 * 60_000);
  const stillPaused = await harness.scheduler.getRamp(ramp.rampId);
  assert.equal(stillPaused?.state, "auto_paused");
  assert.equal(harness.commands.length, 2);
});

test("RampScheduler · auto-pausa por placement (cae en Spam), no solo bounce (W4)", async () => {
  const clock = new FakeClock(fixedNow);
  const harness = await schedulerHarness({
    clock,
    run: async () => ({ stdout: "queued", stderr: "", exitCode: 0 }), // sin bounces
    getWarmupSignals: () => ({ seedInbox: 4, seedSpam: 6 }) // 40% inbox < piso 80%
  });

  const ramp = await harness.scheduler.startRamp({
    domain: "placement-ramp.com",
    serverSlug: null,
    serverIp: "192.0.2.77",
    schedule: "demo-fast",
    recipientPool: ["a@x.com", "b@x.com", "c@x.com"],
    actorId: "operator/juanes",
    approvalToken: "exec-ramp-placement"
  });

  await drain();

  const after = await harness.scheduler.getRamp(ramp.rampId);
  assert.equal(after?.state, "auto_paused");
  assert.equal(after?.pauseReason, "auto_placement");
});

test("RampScheduler · auto-pausa por quejas-spam, sin bounces (W4)", async () => {
  const clock = new FakeClock(fixedNow);
  const harness = await schedulerHarness({
    clock,
    run: async () => ({ stdout: "queued", stderr: "", exitCode: 0 }), // sin bounces
    getWarmupSignals: () => ({ complaints: 1 }) // 1/3 del batch 0 = 33% > 0.30%
  });

  const ramp = await harness.scheduler.startRamp({
    domain: "spam-ramp.com",
    serverSlug: null,
    serverIp: "192.0.2.88",
    schedule: "demo-fast",
    recipientPool: ["a@x.com", "b@x.com", "c@x.com"],
    actorId: "operator/juanes",
    approvalToken: "exec-ramp-spam"
  });

  await drain();

  const after = await harness.scheduler.getRamp(ramp.rampId);
  assert.equal(after?.state, "auto_paused");
  assert.equal(after?.pauseReason, "auto_spam_rate");
});

test("POST /v1/warmup/ramp/start · happy path responde 202 con rampId", async () => {
  const clock = new FakeClock(fixedNow);
  const harness = await schedulerHarness({ clock });
  await appendApproval(harness.auditLog, "artifact-ramp", "exec-ramp-http");
  await harness.workspace.updateInventoryJson("domains.json", () => ({
    bindings: [
      {
        domain: "delivrix-ramp.com",
        serverSlug: "mail-delivrix-ramp",
        serverIp: "192.0.2.55"
      }
    ]
  }));

  const response = captureResponse();
  await handleRampStartHttp({
    request: requestWithJson({
      domain: "delivrix-ramp.com",
      serverSlug: "mail-delivrix-ramp",
      schedule: "demo-fast" satisfies WarmupRampSchedule,
      recipientPool: [
        "jectcode+seed1@gmail.com",
        "jectcode+seed2@gmail.com",
        "jectcode+seed3@gmail.com"
      ],
      actorId: "operator/juanes",
      approvalToken: "exec-ramp-http"
    }),
    response: response as unknown as ServerResponse,
    scheduler: harness.scheduler,
    auditLog: harness.auditLog,
    sshRunner: harness.sshRunner,
    workspace: harness.workspace,
    readCanvasState: () =>
      canvasStateWithApproval("artifact-ramp", "exec-ramp-http"),
    env: { WARMUP_ENABLE_SEND: "true", WARMUP_RAMP_ENABLE: "true" },
    now: () => clock.now()
  });

  assert.equal(response.statusCode, 202);
  const body = JSON.parse(response.body) as {
    ok: boolean;
    rampId: string;
    batchesPlanned: number;
    totalPlanned: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.batchesPlanned, 5);
  assert.equal(body.totalPlanned, 270);
  assert.ok(body.rampId.startsWith("ramp-"));

  const stored = await harness.scheduler.getRamp(body.rampId);
  assert.equal(stored?.state === "running" || stored?.state === "completed", true);
});

test("POST /v1/warmup/ramp/start · bloquea sin gates", async () => {
  const clock = new FakeClock(fixedNow);
  const harness = await schedulerHarness({
    clock,
    sshRunner: { isConfigured: () => false, run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }
  });

  const response = captureResponse();
  try {
    await handleRampStartHttp({
      request: requestWithJson({
        domain: "delivrix-ramp.com",
        schedule: "demo-fast",
        recipientPool: ["a@x.com", "b@x.com"],
        actorId: "operator/juanes",
        approvalToken: "exec-missing"
      }),
      response: response as unknown as ServerResponse,
      scheduler: harness.scheduler,
      auditLog: harness.auditLog,
      sshRunner: harness.sshRunner,
      workspace: harness.workspace,
      readCanvasState: () => canvasStateWithApproval("", ""),
      env: { WARMUP_ENABLE_SEND: "false", WARMUP_RAMP_ENABLE: "false" },
      now: () => clock.now()
    });
  } catch (error) {
    if (!handleWarmupRampError(error, response as unknown as ServerResponse)) {
      throw error;
    }
  }

  assert.equal(response.statusCode, 409);
  const body = JSON.parse(response.body) as { blockers: string[] };
  assert.ok(body.blockers.includes("warmup_send_flag_disabled"));
  assert.ok(body.blockers.includes("warmup_ramp_flag_disabled"));
  assert.ok(body.blockers.includes("warmup_ssh_runner_missing"));
  assert.ok(body.blockers.includes("approval_not_found_or_expired"));
});

/* ────────────────── helpers ────────────────── */

async function schedulerHarness(input: {
  clock: FakeClock;
  run?: (input: SmtpSshCommandInput) => Promise<SmtpSshCommandResult>;
  sshRunner?: SmtpSshRunner;
  getWarmupSignals?: (input: {
    domain: string;
    serverSlug: string | null;
    serverIp: string;
  }) => { complaints?: number; seedInbox?: number; seedSpam?: number };
}) {
  const dir = await mkdtemp(join(tmpdir(), "warmup-ramp-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => input.clock.now()
  });
  const canvasEvents: CanvasLiveEvent[] = [];
  const commands: SmtpSshCommandInput[] = [];
  const defaultRun = async (cmd: SmtpSshCommandInput): Promise<SmtpSshCommandResult> => {
    commands.push(cmd);
    if (input.run) {
      const result = await input.run(cmd);
      return result;
    }
    return { stdout: "queued", stderr: "", exitCode: 0 };
  };
  const sshRunner: SmtpSshRunner = input.sshRunner ?? {
    isConfigured: () => true,
    run: async (cmd) => {
      commands.push(cmd);
      if (input.run) return input.run(cmd);
      return { stdout: "queued", stderr: "", exitCode: 0 };
    }
  };
  // If a custom sshRunner provided, we still want to log commands.
  if (input.sshRunner) {
    const orig = sshRunner.run.bind(sshRunner);
    sshRunner.run = async (cmd) => {
      commands.push(cmd);
      return orig(cmd);
    };
  }
  void defaultRun;

  const scheduler = new RampScheduler({
    auditLog,
    sshRunner,
    workspace,
    canvasLiveEvents: {
      emit: async (event) => {
        canvasEvents.push(event);
        return event;
      }
    },
    readCanvasState: () => canvasStateWithApproval("", ""),
    env: { WARMUP_ENABLE_SEND: "true" },
    now: () => input.clock.now(),
    setTimer: input.clock.setTimer as never,
    clearTimer: input.clock.clearTimer as never,
    getWarmupSignals: input.getWarmupSignals
  });

  return { scheduler, auditLog, workspace, canvasEvents, commands, sshRunner };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: fixedNow.toISOString(),
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: {
      executionId,
      approvalTokenHash: approvalTokenHash(executionId),
      blockCount: 1
    }
  });
}

function canvasStateWithApproval(
  artifactId: string,
  executionId: string
): CanvasLiveStateSnapshot {
  return {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: executionId
      ? [
          {
            artifactId,
            taskId: "task-ramp",
            kind: "proposal",
            title: "Ramp plan",
            editable: true,
            createdAt: fixedNow.toISOString(),
            updatedAt: fixedNow.toISOString(),
            approvalStatus: "approved",
            approvedBy: "operator/juanes",
            approvedAt: fixedNow.toISOString(),
            executionId,
            blocks: []
          }
        ]
      : []
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/warmup/ramp/start",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}
