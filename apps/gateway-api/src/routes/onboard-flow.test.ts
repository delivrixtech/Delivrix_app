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
  createGatewayOnboardDomainFlowRunner,
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

test("gateway onboard runner executes T1, T2, T4, T3, T5, T6 without warmup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "onboard-runner-order-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvas = new CanvasLiveEventService({
    stateDir: join(dir, "canvas-live"),
    now: () => fixedNow
  });
  const approvalToken = await seedApproval(canvas, auditLog, "artifact-flow-order");
  const emitted: any[] = [];
  const canvasEmitter = {
    async emit(event: any) {
      emitted.push(event);
      return canvas.emit(event);
    }
  };

  const runner = createGatewayOnboardDomainFlowRunner({
    auditLog,
    workspace,
    canvasLiveEvents: canvasEmitter,
    domainPurchaseAdapter: {
      isLive: () => true,
      isPurchaseEnabled: () => true,
      currentSource: () => ({
        kind: "live",
        region: "us-east-1",
        apiBase: "https://route53domains.us-east-1.amazonaws.com",
        fetchedAt: fixedNow.toISOString(),
        responseOk: true
      }),
      listPrices: async () => [{ tld: "com", registration: { amount: 12, currency: "USD" } }],
      registerDomain: async () => ({
        operationId: "op-register-order",
        expectedExpiry: "2027-05-28T14:00:00.000Z"
      })
    },
    dnsAdapter: {
      isLive: () => true,
      isWriteEnabled: () => true,
      currentSource: () => ({
        kind: "live",
        region: "us-east-1",
        apiBase: "https://route53.amazonaws.com",
        fetchedAt: fixedNow.toISOString(),
        responseOk: true,
        writeEnabled: true
      }),
      createHostedZone: async () => ({
        zoneId: "ZORDER",
        nameServers: ["ns-1.awsdns.com"]
      }),
      upsertRecord: async (_zoneId, record) => ({
        changeId: `C-${record.type}-${record.name}`
      })
    },
    webdockAdapter: {
      isLive: () => true,
      canCreate: () => true,
      createServer: async () => ({
        serverSlug: "server-order",
        eventId: "cb-order",
        ipv4: null,
        status: "provisioning",
        publicKeyId: 42,
        source: {
          kind: "live",
          apiBase: "https://api.webdock.test/v1",
          fetchedAt: fixedNow.toISOString(),
          responseOk: true
        }
      }),
      getServer: async () => ({
        slug: "server-order",
        name: "mail.order-delivrix-test.com",
        status: "running",
        ipv4: "192.0.2.44"
      })
    },
    sshRunner: {
      isConfigured: () => true,
      run: async () => ({ stdout: "", stderr: "", exitCode: 0 })
    },
    readCanvasState: () => canvas.snapshot(),
    env: {
      AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD: "50",
      DELIVRIX_ADMIN_CONTACT_JSON: JSON.stringify(route53Contact()),
      WEBDOCK_SERVERS_ENABLE_CREATE: "true",
      SMTP_PROVISIONING_ENABLE_SSH: "true"
    },
    now: () => fixedNow
  });

  const result = await runner.run({
    domain: "order-delivrix-test.com",
    profile: "bit",
    actorId: "operator/juanes",
    approvalToken,
    taskId: "task-flow-order",
    years: 1,
    autoRenew: false,
    locationId: "dk",
    imageSlug: "ubuntu-2404",
    publicKey: "ssh-ed25519 AAAA test",
    seedInboxes: []
  });

  const highLevelUrls = emitted
    .filter((event) => event.type === "oc.action.now" && event.kind === "api")
    .map((event) => event.url)
    .filter((url) =>
      typeof url === "string" &&
      url.startsWith("/v1/") &&
      url !== "/v1/servers" &&
      url !== "/v1/servers/server-order"
    );

  assert.deepEqual(highLevelUrls, [
    "/v1/domains/route53/register",
    "/v1/domains/route53/dns/upsert",
    "/v1/webdock/servers/create",
    "/v1/domains/auth/configure",
    "/v1/servers/server-order/provision-smtp",
    "/v1/domains/bind"
  ]);
  assert.equal(result.serverIp, "192.0.2.44");
  assert.equal(highLevelUrls.includes("/v1/warmup/start"), false);
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

async function seedApproval(
  canvas: CanvasLiveEventService,
  auditLog: LocalFileAuditLog,
  artifactId: string
): Promise<string> {
  await canvas.emit({
    type: "oc.task.declare",
    taskId: "task-approval",
    title: "Approval",
    status: "running",
    createdAt: fixedNow.toISOString(),
    actorId: "operator/juanes"
  });
  await canvas.emit({
    type: "oc.artifact.declare",
    taskId: "task-approval",
    artifactId,
    kind: "proposal",
    title: "Approve flow",
    editable: true,
    createdAt: fixedNow.toISOString()
  });
  await canvas.emit({
    type: "oc.artifact.block",
    artifactId,
    blockId: "scope",
    order: 1,
    kind: "paragraph",
    content: "approve",
    editable: true,
    status: "complete",
    occurredAt: fixedNow.toISOString()
  });
  const approval = await canvas.approveArtifact({
    artifactId,
    actorId: "operator/juanes",
    blocks: [{ blockId: "scope", content: "approve" }]
  });
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
      executionId: approval.executionId,
      blockCount: 1
    }
  });
  return approval.executionId;
}

function route53Contact() {
  return {
    FirstName: "Delivrix",
    LastName: "Ops",
    ContactType: "COMPANY",
    OrganizationName: "Delivrix",
    AddressLine1: "123 Demo Street",
    City: "Miami",
    State: "FL",
    CountryCode: "US",
    ZipCode: "33101",
    PhoneNumber: "+1.3055550100",
    Email: "ops@example.com"
  };
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
