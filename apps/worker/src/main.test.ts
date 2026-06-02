import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type {
  AuditEvent,
  SendJob,
  SendRequest,
  SenderNode,
  SuppressionEntry
} from "../../../packages/domain/src/index.ts";

const execFileAsync = promisify(execFile);

test("worker blocks suppressed recipients before sender-node assignment", async () => {
  const state = await createWorkerState({
    suppressionEntries: [{
      email: "blocked@example.com",
      reason: "unsubscribe",
      source: "test",
      createdAt: "2026-06-02T10:00:00.000Z"
    }]
  });

  const result = await runWorker(state);

  assert.match(result.stdout, /Mail policy rejected during worker enforcement/);
  const jobs = await readJson<SendJob[]>(state.queueFile, []);
  assert.equal(jobs[0].status, "blocked");
  assert.equal(jobs[0].senderNodeId, undefined);
  assert.equal(jobs[0].failureReason, "Mail policy rejected during worker enforcement.");
  assert.deepEqual(await readJson(state.resultsFile, []), []);

  const events = await readAuditEvents(state.auditFile);
  assert.equal(events.some((event) => event.action === "send_job.policy_rejected"), true);
  assert.equal(events.some((event) => event.action === "send_job.sender_node_assigned"), false);
});

test("worker fails closed when suppression state cannot be read", async () => {
  const state = await createWorkerState({ suppressionRaw: "{not-json" });

  const result = await runWorker(state);

  assert.match(result.stdout, /Mail policy check failed during worker enforcement/);
  const jobs = await readJson<SendJob[]>(state.queueFile, []);
  assert.equal(jobs[0].status, "blocked");
  assert.equal(jobs[0].senderNodeId, undefined);
  assert.deepEqual(await readJson(state.resultsFile, []), []);

  const events = await readAuditEvents(state.auditFile);
  assert.equal(events.some((event) => event.action === "send_job.policy_check_failed"), true);
  assert.equal(events.some((event) => event.action === "send_job.sender_node_assigned"), false);
});

async function createWorkerState(input: {
  suppressionEntries?: SuppressionEntry[];
  suppressionRaw?: string;
} = {}): Promise<{
  dir: string;
  auditFile: string;
  queueFile: string;
  suppressionFile: string;
  senderNodesFile: string;
  resultsFile: string;
  rateLimitsFile: string;
  killSwitchFile: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-worker-"));
  const auditFile = join(dir, "audit-events.jsonl");
  const queueFile = join(dir, "send-jobs.json");
  const suppressionFile = join(dir, "suppression-entries.json");
  const senderNodesFile = join(dir, "sender-nodes.json");
  const resultsFile = join(dir, "send-results.json");
  const rateLimitsFile = join(dir, "rate-limit-counters.json");
  const killSwitchFile = join(dir, "kill-switch.json");

  await writeFile(queueFile, `${JSON.stringify([sendJob()], null, 2)}\n`, "utf8");
  await writeFile(senderNodesFile, `${JSON.stringify([senderNode()], null, 2)}\n`, "utf8");
  await writeFile(
    suppressionFile,
    input.suppressionRaw ?? `${JSON.stringify(input.suppressionEntries ?? [], null, 2)}\n`,
    "utf8"
  );

  return {
    dir,
    auditFile,
    queueFile,
    suppressionFile,
    senderNodesFile,
    resultsFile,
    rateLimitsFile,
    killSwitchFile
  };
}

async function runWorker(state: Awaited<ReturnType<typeof createWorkerState>>): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["apps/worker/src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCAL_AUDIT_LOG_FILE: state.auditFile,
      LOCAL_SEND_QUEUE_FILE: state.queueFile,
      LOCAL_SUPPRESSION_FILE: state.suppressionFile,
      LOCAL_SENDER_NODES_FILE: state.senderNodesFile,
      LOCAL_SEND_RESULTS_FILE: state.resultsFile,
      LOCAL_RATE_LIMIT_COUNTERS_FILE: state.rateLimitsFile,
      LOCAL_KILL_SWITCH_FILE: state.killSwitchFile
    }
  });
}

function sendJob(): SendJob {
  return {
    id: "sendjob-worker-policy",
    request: sendRequest(),
    status: "queued",
    createdAt: "2026-06-02T10:00:00.000Z"
  };
}

function sendRequest(): SendRequest {
  return {
    campaignId: "campaign-worker-policy",
    recipient: {
      email: "blocked@example.com"
    },
    sender: {
      address: "ops@sender.example",
      domain: "sender.example"
    },
    subject: "Operational readiness report",
    bodyText: "Authorized operational readiness update.",
    classification: "operational"
  };
}

function senderNode(): SenderNode {
  return {
    id: "node-a",
    label: "Node A",
    provider: "webdock",
    status: "active",
    dailyLimit: 10,
    warmupDay: 10
  };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error)) {
      return fallback;
    }
    throw error;
  }
}

async function readAuditEvents(path: string): Promise<AuditEvent[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEvent);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
