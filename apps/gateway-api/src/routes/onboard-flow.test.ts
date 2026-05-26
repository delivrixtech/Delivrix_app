import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { CanvasLiveEventService } from "../services/canvas-live-events.ts";
import {
  handleOnboardBatchHttp,
  handleOnboardFlowError,
  type OnboardDomainFlowInput,
  type OnboardDomainFlowRunner
} from "./onboard-flow.ts";

const fixedNow = new Date("2026-05-28T14:00:00.000Z");

test("POST /v1/flows/onboard-batch declares parent and sub-tasks then runs domains in parallel", async () => {
  const scheduled: Array<() => Promise<void>> = [];
  let active = 0;
  let maxActive = 0;
  const release = deferred<void>();
  const route = await routeHarness({
    schedule: (job) => scheduled.push(job),
    runner: {
      async run(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await release.promise;
        active -= 1;
        return completed(input);
      }
    }
  });

  const response = await route({
    domains: ["delivrix-send.com", "delivrix-relay.com", "delivrix-mta.com"],
    profile: "bit",
    actorId: "operator/juanes",
    approvalToken: "exec-batch",
    seedInboxes: ["seed.one@gmail.com", "seed.two@outlook.com", "seed.three@delivrix.com"]
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.subTaskIds.length, 3);
  assert.equal(scheduled.length, 1);

  const running = scheduled[0]();
  await Promise.resolve();
  assert.equal(maxActive, 3);
  release.resolve();
  await running;

  const snapshot = await route.canvas.snapshot();
  const children = snapshot.tasks.filter((task) => task.parentTaskId === response.body.parentTaskId);
  assert.equal(children.length, 3);
  assert.equal(children.every((task) => task.status === "completed"), true);
  assert.equal(snapshot.tasks.find((task) => task.taskId === response.body.parentTaskId)?.status, "completed");
  assert.equal(snapshot.artifacts.some((artifact) => artifact.taskId === response.body.parentTaskId && artifact.kind === "report"), true);

  const auditEvents = await route.auditLog.list();
  assert.equal(auditEvents.at(-1)?.action, "oc.flow.onboard_batch_completed");
});

test("POST /v1/flows/onboard-batch retries one sub-task and isolates permanent failures", async () => {
  const attempts = new Map<string, number>();
  const scheduled: Array<() => Promise<void>> = [];
  const route = await routeHarness({
    schedule: (job) => scheduled.push(job),
    runner: {
      async run(input) {
        const count = (attempts.get(input.domain) ?? 0) + 1;
        attempts.set(input.domain, count);
        if (input.domain === "retry.delivrix.com" && count === 1) {
          throw new Error("temporary_route53_timeout");
        }
        if (input.domain === "blocked.delivrix.com") {
          throw new Error("webdock_scope_missing");
        }
        return completed(input);
      }
    }
  });

  const response = await route({
    domains: ["ok.delivrix.com", "retry.delivrix.com", "blocked.delivrix.com"],
    profile: "bit",
    actorId: "operator/juanes",
    approvalToken: "exec-batch",
    maxRetries: 1,
    seedInboxes: ["seed.one@gmail.com", "seed.two@outlook.com", "seed.three@delivrix.com"]
  });

  await scheduled[0]();

  assert.equal(response.statusCode, 202);
  assert.equal(attempts.get("retry.delivrix.com"), 2);
  assert.equal(attempts.get("blocked.delivrix.com"), 2);

  const snapshot = await route.canvas.snapshot();
  const blockedTask = snapshot.tasks.find((task) => task.title === "Onboarding · blocked.delivrix.com");
  assert.equal(blockedTask?.status, "failed");
  assert.equal(snapshot.tasks.find((task) => task.taskId === response.body.parentTaskId)?.status, "completed");
  assert.ok(snapshot.artifacts[0].blocks.some((block) => block.content.includes("blocked.delivrix.com")));

  const workspace = await route.workspace.snapshot();
  assert.ok(workspace.files.some((file) => file.includes("supervisor_onboard_batch")));
  assert.ok(workspace.files.some((file) => file.startsWith("learnings/") && file.includes("blocked.delivrix.com")));
});

async function routeHarness(input: {
  runner: OnboardDomainFlowRunner;
  schedule: (job: () => Promise<void>) => void;
}) {
  const dir = await mkdtemp(join(tmpdir(), "onboard-flow-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvas = new CanvasLiveEventService({
    stateDir: join(dir, "canvas-live"),
    now: () => fixedNow
  });

  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleOnboardBatchHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        workspace,
        canvasLiveEvents: canvas,
        runner: input.runner,
        schedule: input.schedule,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleOnboardFlowError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return Object.assign(route, { auditLog, workspace, canvas });
}

function completed(input: OnboardDomainFlowInput) {
  return {
    domain: input.domain,
    taskId: input.taskId,
    status: "completed" as const,
    operationId: `op-${input.domain}`,
    zoneId: `Z${input.domain.length}`,
    serverSlug: `mail-${input.domain}`,
    serverIp: "192.0.2.44",
    dkimPrivateKeyPath: `inventory/dkim-keys/${input.domain}/default.private`,
    seedCount: input.seedInboxes.length
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/flows/onboard-batch",
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
