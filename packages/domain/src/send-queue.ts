import { createId } from "./ids.ts";
import type { SendJob, SendRequest } from "./types.ts";

export interface SendQueue {
  add(request: SendRequest): Promise<SendJob>;
  list(): Promise<SendJob[]>;
}

export class InMemorySendQueue implements SendQueue {
  private readonly jobs: SendJob[] = [];

  async add(request: SendRequest): Promise<SendJob> {
    const job: SendJob = {
      id: createId("sendjob"),
      request,
      status: "queued",
      createdAt: new Date().toISOString()
    };

    this.jobs.push(job);
    return job;
  }

  async list(): Promise<SendJob[]> {
    return [...this.jobs];
  }
}
