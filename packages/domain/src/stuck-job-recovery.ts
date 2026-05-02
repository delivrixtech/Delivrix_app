import type { SendJob } from "./types.ts";

export type StuckJobRecoveryAction = "fail" | "requeue";

export interface StuckProcessingJob {
  jobId: string;
  createdAt: string;
  processingStartedAt?: string;
  lastProcessingTransitionAt: string;
  senderNodeId?: string;
  ageMs: number;
  staleAfterMs: number;
}

export interface FindStuckProcessingJobsInput {
  jobs: SendJob[];
  staleAfterMs: number;
  now?: Date;
}

export function findStuckProcessingJobs(input: FindStuckProcessingJobsInput): StuckProcessingJob[] {
  assertPositiveThreshold(input.staleAfterMs);
  const now = input.now ?? new Date();

  return input.jobs
    .filter((job) => job.status === "processing")
    .map((job) => toStuckProcessingJob(job, now, input.staleAfterMs))
    .filter((job): job is StuckProcessingJob => job !== null)
    .filter((job) => job.ageMs >= input.staleAfterMs)
    .sort((left, right) => right.ageMs - left.ageMs || left.jobId.localeCompare(right.jobId));
}

function toStuckProcessingJob(job: SendJob, now: Date, staleAfterMs: number): StuckProcessingJob | null {
  const lastProcessingTransitionAt = job.processingStartedAt ?? job.createdAt;
  const transitionMs = Date.parse(lastProcessingTransitionAt);

  if (!Number.isFinite(transitionMs)) {
    return null;
  }

  return {
    jobId: job.id,
    createdAt: job.createdAt,
    processingStartedAt: job.processingStartedAt,
    lastProcessingTransitionAt,
    senderNodeId: job.senderNodeId,
    ageMs: Math.max(0, now.getTime() - transitionMs),
    staleAfterMs
  };
}

function assertPositiveThreshold(staleAfterMs: number): void {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1) {
    throw new Error("staleAfterMs must be a positive number.");
  }
}
