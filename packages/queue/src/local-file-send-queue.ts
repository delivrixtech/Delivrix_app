import {
  createId,
  findStuckProcessingJobs,
  type SendJob,
  type SendRequest,
  type StuckJobRecoveryAction,
  type StuckProcessingJob
} from "../../domain/src/index.ts";
import { JsonFileStore } from "../../local-store/src/index.ts";

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
  claim(jobId: string): Promise<SendJob | null>;
  assignSenderNode(jobId: string, senderNodeId: string): Promise<void>;
  markBlocked(jobId: string, reason: string): Promise<void>;
  markCompleted(jobId: string): Promise<void>;
  markFailed(jobId: string, reason: string): Promise<void>;
  listStuckProcessingJobs(staleAfterMs: number, now?: Date): Promise<StuckProcessingJob[]>;
  recoverStuckProcessingJobs(input: RecoverStuckProcessingJobsInput): Promise<StuckJobRecoveryReport>;
}

export class LocalFileSendQueue implements SendJobQueue {
  private readonly store: JsonFileStore<SendJob[]>;

  constructor(filePath = process.env.LOCAL_SEND_QUEUE_FILE ?? "runtime/send-jobs.json") {
    this.store = new JsonFileStore<SendJob[]>(filePath);
  }

  async add(request: SendRequest): Promise<SendJob> {
    const job: SendJob = {
      id: createId("sendjob"),
      request,
      status: "queued",
      createdAt: new Date().toISOString()
    };

    await this.store.update([], (jobs) => {
      jobs.push(job);
      return jobs;
    });
    return job;
  }

  async list(): Promise<SendJob[]> {
    return this.store.read([]);
  }

  async claimNext(): Promise<SendJob | null> {
    return this.store.transaction([], (jobs) => claimFirstQueued(jobs));
  }

  async claim(jobId: string): Promise<SendJob | null> {
    return this.store.transaction([], (jobs) => claimById(jobs, jobId));
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
      jobs: await this.store.read([]),
      staleAfterMs,
      now
    });
  }

  async recoverStuckProcessingJobs(input: RecoverStuckProcessingJobsInput): Promise<StuckJobRecoveryReport> {
    const now = input.now ?? new Date();
    const recoveredAt = now.toISOString();
    return this.store.transaction([], (jobs) => {
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

      return {
        value: jobs,
        result: {
          action: input.action,
          staleAfterMs: input.staleAfterMs,
          recoveredAt,
          detected,
          recovered
        }
      };
    });
  }

  private async updateJob(jobId: string, update: (job: SendJob) => void): Promise<void> {
    await this.store.transaction([], (jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);

      if (!job) {
        throw new Error(`Send job not found: ${jobId}`);
      }

      update(job);
      return { value: jobs, result: undefined };
    });
  }
}

function claimFirstQueued(jobs: SendJob[]): { value: SendJob[]; result: SendJob | null } {
  const job = jobs.find((candidate) => candidate.status === "queued");
  if (!job) {
    return { value: jobs, result: null };
  }

  job.status = "processing";
  job.processingStartedAt = new Date().toISOString();
  return { value: jobs, result: { ...job } };
}

function claimById(jobs: SendJob[], jobId: string): { value: SendJob[]; result: SendJob | null } {
  const job = jobs.find((candidate) => candidate.id === jobId && candidate.status === "queued");
  if (!job) {
    return { value: jobs, result: null };
  }

  job.status = "processing";
  job.processingStartedAt = new Date().toISOString();
  return { value: jobs, result: { ...job } };
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
