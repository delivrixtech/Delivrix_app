import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  createId,
  findStuckProcessingJobs,
  type SendJob,
  type SendRequest,
  type StuckJobRecoveryAction,
  type StuckProcessingJob
} from "../../domain/src/index.ts";

export interface RecoverStuckProcessingJobsInput {
  staleAfterMs: number;
  action: StuckJobRecoveryAction;
  now?: Date;
  reason?: string;
}

export interface StuckJobRecoveryReport {
  action: StuckJobRecoveryAction;
  staleAfterMs: number;
  recoveredAt: string;
  detected: StuckProcessingJob[];
  recovered: SendJob[];
}

export interface SendJobQueue {
  add(request: SendRequest): Promise<SendJob>;
  list(): Promise<SendJob[]>;
  claimNext(): Promise<SendJob | null>;
  assignSenderNode(jobId: string, senderNodeId: string): Promise<void>;
  markBlocked(jobId: string, reason: string): Promise<void>;
  markCompleted(jobId: string): Promise<void>;
  markFailed(jobId: string, reason: string): Promise<void>;
  listStuckProcessingJobs(staleAfterMs: number, now?: Date): Promise<StuckProcessingJob[]>;
  recoverStuckProcessingJobs(input: RecoverStuckProcessingJobsInput): Promise<StuckJobRecoveryReport>;
}

export class LocalFileSendQueue implements SendJobQueue {
  private readonly filePath: string;

  constructor(filePath = process.env.LOCAL_SEND_QUEUE_FILE ?? "runtime/send-jobs.json") {
    this.filePath = resolve(filePath);
  }

  async add(request: SendRequest): Promise<SendJob> {
    const job: SendJob = {
      id: createId("sendjob"),
      request,
      status: "queued",
      createdAt: new Date().toISOString()
    };

    const jobs = await this.readJobs();
    jobs.push(job);
    await this.writeJobs(jobs);
    return job;
  }

  async list(): Promise<SendJob[]> {
    return this.readJobs();
  }

  async claimNext(): Promise<SendJob | null> {
    const jobs = await this.readJobs();
    const job = jobs.find((candidate) => candidate.status === "queued");

    if (!job) {
      return null;
    }

    job.status = "processing";
    job.processingStartedAt = new Date().toISOString();
    await this.writeJobs(jobs);
    return job;
  }

  async markCompleted(jobId: string): Promise<void> {
    await this.updateJob(jobId, (job) => {
      job.status = "completed";
      job.completedAt = new Date().toISOString();
    });
  }

  async assignSenderNode(jobId: string, senderNodeId: string): Promise<void> {
    await this.updateJob(jobId, (job) => {
      job.senderNodeId = senderNodeId;
    });
  }

  async markFailed(jobId: string, reason: string): Promise<void> {
    await this.updateJob(jobId, (job) => {
      job.status = "failed";
      job.failureReason = reason;
      job.completedAt = new Date().toISOString();
    });
  }

  async markBlocked(jobId: string, reason: string): Promise<void> {
    await this.updateJob(jobId, (job) => {
      job.status = "blocked";
      job.failureReason = reason;
      job.completedAt = new Date().toISOString();
    });
  }

  async listStuckProcessingJobs(staleAfterMs: number, now = new Date()): Promise<StuckProcessingJob[]> {
    return findStuckProcessingJobs({
      jobs: await this.readJobs(),
      staleAfterMs,
      now
    });
  }

  async recoverStuckProcessingJobs(input: RecoverStuckProcessingJobsInput): Promise<StuckJobRecoveryReport> {
    const now = input.now ?? new Date();
    const recoveredAt = now.toISOString();
    const jobs = await this.readJobs();
    const detected = findStuckProcessingJobs({
      jobs,
      staleAfterMs: input.staleAfterMs,
      now
    });
    const detectedIds = new Set(detected.map((job) => job.jobId));
    const recovered: SendJob[] = [];

    for (const job of jobs) {
      if (!detectedIds.has(job.id)) {
        continue;
      }

      recoverJob(job, input.action, recoveredAt, input.staleAfterMs, input.reason);
      recovered.push({ ...job });
    }

    if (recovered.length > 0) {
      await this.writeJobs(jobs);
    }

    return {
      action: input.action,
      staleAfterMs: input.staleAfterMs,
      recoveredAt,
      detected,
      recovered
    };
  }

  private async updateJob(jobId: string, update: (job: SendJob) => void): Promise<void> {
    const jobs = await this.readJobs();
    const job = jobs.find((candidate) => candidate.id === jobId);

    if (!job) {
      throw new Error(`Send job not found: ${jobId}`);
    }

    update(job);
    await this.writeJobs(jobs);
  }

  private async readJobs(): Promise<SendJob[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as SendJob[];
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }

      throw error;
    }
  }

  private async writeJobs(jobs: SendJob[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function recoverJob(
  job: SendJob,
  action: StuckJobRecoveryAction,
  recoveredAt: string,
  staleAfterMs: number,
  reason?: string
): void {
  const recoveryReason = reason ?? `Recovered stuck processing job after ${staleAfterMs}ms.`;

  job.recoveredAt = recoveredAt;
  job.recoveryReason = recoveryReason;

  if (action === "fail") {
    job.status = "failed";
    job.failureReason = recoveryReason;
    job.completedAt = recoveredAt;
    return;
  }

  if (action === "requeue") {
    job.status = "queued";
    job.processingStartedAt = undefined;
    job.completedAt = undefined;
    job.senderNodeId = undefined;
    job.failureReason = undefined;
    return;
  }

  throw new Error(`Unsupported stuck job recovery action: ${action}`);
}
