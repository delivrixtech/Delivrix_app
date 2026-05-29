import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  handleDomainBindHttp,
  type DomainBindDnsAdapter
} from "./domains-bind.ts";
import {
  handleEmailAuthConfigureHttp,
  type EmailAuthDnsAdapter
} from "./domains-email-auth.ts";
import {
  handleRoute53DnsUpsertHttp,
  type Route53DnsAdapter
} from "./domains-dns.ts";
import {
  handleRoute53DomainRegisterHttp,
  type Route53DomainPurchaseAdapter
} from "./domains-purchase.ts";
import {
  handleSmtpProvisionHttp,
  type SmtpSshRunner
} from "./smtp-provisioning.ts";
import {
  handleWebdockServerCreateHttp,
  type WebdockServerCreateAdapter
} from "./webdock-servers.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface OnboardDomainFlowInput {
  domain: string;
  profile: OnboardProfile;
  actorId: string;
  approvalToken: string;
  taskId: string;
  parentTaskId?: string;
  years: number;
  autoRenew: boolean;
  locationId: string;
  imageSlug: "ubuntu-2404" | "debian-12";
  publicKey?: string;
  seedInboxes: string[];
}

export interface OnboardDomainFlowResult {
  domain: string;
  taskId: string;
  status: "completed";
  operationId?: string;
  costUsd?: number | null;
  zoneId?: string;
  serverSlug?: string;
  serverIp?: string | null;
  dkimPrivateKeyPath?: string;
  seedCount: number;
}

export interface OnboardDomainFlowRunner {
  run(input: OnboardDomainFlowInput): Promise<OnboardDomainFlowResult>;
}

export interface OnboardFlowDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  workspace: OpenClawWorkspace;
  canvasLiveEvents: CanvasEmitter;
  runner: OnboardDomainFlowRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  schedule?: (job: () => Promise<void>) => void;
}

export interface GatewayOnboardFlowRunnerDependencies {
  auditLog: AuditSink;
  workspace: OpenClawWorkspace;
  canvasLiveEvents: CanvasEmitter;
  domainPurchaseAdapter: Route53DomainPurchaseAdapter;
  dnsAdapter: Route53DnsAdapter & EmailAuthDnsAdapter & DomainBindDnsAdapter;
  webdockAdapter: WebdockServerCreateAdapter;
  sshRunner: SmtpSshRunner;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface OnboardBatchBody {
  domains?: unknown;
  domain?: unknown;
  profile?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  parentTaskId?: unknown;
  taskId?: unknown;
  years?: unknown;
  autoRenew?: unknown;
  locationId?: unknown;
  imageSlug?: unknown;
  publicKey?: unknown;
  seedInboxes?: unknown;
  maxRetries?: unknown;
}

type OnboardProfile = "bit" | "nibble" | "byte" | "kilobyte";

const skillName = "supervisor_onboard_batch";
const defaultActor = "operator/unknown";

export async function handleOnboardBatchHttp(deps: OnboardFlowDependencies): Promise<void> {
  const body = await readJson<OnboardBatchBody>(deps.request);
  const now = deps.now?.() ?? new Date();
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const domains = parseDomains(body.domains);
  const profile = parseProfile(body.profile);
  const parentTaskId = normalizeTaskId(body.parentTaskId) ?? `batch-${randomUUID()}`;
  const maxRetries = parseRetries(body.maxRetries);
  const seedInboxes = parseSeedInboxes(body.seedInboxes, deps.env);
  const common = parseCommonOptions(body, deps.env);

  await deps.canvasLiveEvents.emit({
    type: "oc.task.declare",
    taskId: parentTaskId,
    title: `Onboarding batch · ${domains.length} domains`,
    status: "running",
    createdAt: now.toISOString(),
    actorId
  });

  const subTaskIds = domains.map((domain) => `onboard-${safeId(domain)}-${randomUUID().slice(0, 8)}`);
  await Promise.all(domains.map((domain, index) => deps.canvasLiveEvents.emit({
    type: "oc.task.declare",
    taskId: subTaskIds[index],
    parentTaskId,
    title: `Onboarding · ${domain}`,
    status: "running",
    createdAt: now.toISOString(),
    actorId
  })));

  await deps.workspace.writeExecutionRecord({
    skill: skillName,
    params: { domains, profile, actorId, parentTaskId },
    outcome: "success",
    durationMs: 0,
    evidence: {
      status: "accepted",
      subTaskIds,
      seedCount: seedInboxes.length
    }
  });

  scheduleJob(deps, () => runBatch({
    ...deps,
    actorId,
    approvalToken,
    domains,
    profile,
    parentTaskId,
    subTaskIds,
    maxRetries,
    seedInboxes,
    common
  }));

  json(deps.response, 202, {
    ok: true,
    status: "accepted",
    parentTaskId,
    subTaskIds,
    domains,
    profile
  });
}

export async function handleOnboardSenderDomainHttp(deps: OnboardFlowDependencies): Promise<void> {
  const body = await readJson<OnboardBatchBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const now = deps.now?.() ?? new Date();
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `onboard-${safeId(domain)}-${randomUUID().slice(0, 8)}`;
  const seedInboxes = parseSeedInboxes(body.seedInboxes, deps.env);
  const common = parseCommonOptions(body, deps.env);
  const profile = parseProfile(body.profile);

  await deps.canvasLiveEvents.emit({
    type: "oc.task.declare",
    taskId,
    title: `Onboarding · ${domain}`,
    status: "running",
    createdAt: now.toISOString(),
    actorId
  });

  scheduleJob(deps, () => runSingle({
    deps,
    input: {
      domain,
      profile,
      actorId,
      approvalToken,
      taskId,
      seedInboxes,
      ...common
    }
  }));

  json(deps.response, 202, {
    ok: true,
    status: "accepted",
    taskId,
    domain,
    profile
  });
}

export function createGatewayOnboardDomainFlowRunner(
  deps: GatewayOnboardFlowRunnerDependencies
): OnboardDomainFlowRunner {
  return {
    async run(input) {
      const canvas = actionOnlyCanvas(deps.canvasLiveEvents);
      const register = await invokePhase({
        service: deps.canvasLiveEvents,
        taskId: input.taskId,
        method: "POST",
        url: "/v1/domains/route53/register",
        body: {
          domain: input.domain,
          years: input.years,
          autoRenew: input.autoRenew,
          actorId: input.actorId,
          approvalToken: input.approvalToken
        },
        handler: (request, response) => handleRoute53DomainRegisterHttp({
          request,
          response,
          auditLog: deps.auditLog,
          adapter: deps.domainPurchaseAdapter,
          workspace: deps.workspace,
          readCanvasState: deps.readCanvasState,
          env: deps.env,
          now: deps.now
        }),
        now: deps.now
      });

      const dns = await invokePhase({
        service: deps.canvasLiveEvents,
        taskId: input.taskId,
        method: "POST",
        url: "/v1/domains/route53/dns/upsert",
        body: {
          domain: input.domain,
          records: [{
            name: "_delivrix-onboarding",
            type: "TXT",
            ttl: 300,
            values: [`task=${input.taskId}`]
          }],
          actorId: input.actorId,
          approvalToken: input.approvalToken,
          taskId: input.taskId
        },
        handler: (request, response) => handleRoute53DnsUpsertHttp({
          request,
          response,
          auditLog: deps.auditLog,
          adapter: deps.dnsAdapter,
          workspace: deps.workspace,
          canvasLiveEvents: canvas,
          readCanvasState: deps.readCanvasState,
          now: deps.now
        }),
        now: deps.now
      });

      const server = await invokePhase({
        service: deps.canvasLiveEvents,
        taskId: input.taskId,
        method: "POST",
        url: "/v1/webdock/servers/create",
        body: {
          profile: input.profile,
          locationId: input.locationId,
          hostname: `mail.${input.domain}`,
          imageSlug: input.imageSlug,
          publicKey: input.publicKey,
          actorId: input.actorId,
          approvalToken: input.approvalToken,
          taskId: input.taskId
        },
        handler: (request, response) => handleWebdockServerCreateHttp({
          request,
          response,
          auditLog: deps.auditLog,
          adapter: deps.webdockAdapter,
          workspace: deps.workspace,
          canvasLiveEvents: canvas,
          readCanvasState: deps.readCanvasState,
          env: deps.env,
          now: deps.now
        }),
        now: deps.now
      });

      const serverSlug = stringFrom(server, "serverSlug");
      const serverIp = stringFrom(server, "ipv4");
      if (!serverSlug || !serverIp) {
        throw new OnboardFlowPhaseError("webdock_server_ip_missing", 502, server);
      }

      const auth = await invokePhase({
        service: deps.canvasLiveEvents,
        taskId: input.taskId,
        method: "POST",
        url: "/v1/domains/auth/configure",
        body: {
          domain: input.domain,
          mxServerIp: serverIp,
          zoneId: stringFrom(dns, "zoneId"),
          actorId: input.actorId,
          approvalToken: input.approvalToken,
          taskId: input.taskId
        },
        handler: (request, response) => handleEmailAuthConfigureHttp({
          request,
          response,
          auditLog: deps.auditLog,
          dnsAdapter: deps.dnsAdapter,
          workspace: deps.workspace,
          canvasLiveEvents: canvas,
          readCanvasState: deps.readCanvasState,
          env: deps.env,
          now: deps.now
        }),
        now: deps.now
      });

      await invokePhase({
        service: deps.canvasLiveEvents,
        taskId: input.taskId,
        method: "POST",
        url: `/v1/servers/${serverSlug}/provision-smtp`,
        body: {
          domain: input.domain,
          serverIp,
          dkimPrivateKeyPath: stringFrom(auth, "dkimPrivateKeyPath"),
          actorId: input.actorId,
          approvalToken: input.approvalToken,
          taskId: input.taskId
        },
        handler: (request, response) => handleSmtpProvisionHttp({
          request,
          response,
          serverSlug,
          auditLog: deps.auditLog,
          sshRunner: deps.sshRunner,
          workspace: deps.workspace,
          canvasLiveEvents: canvas,
          readCanvasState: deps.readCanvasState,
          env: deps.env,
          now: deps.now
        }),
        now: deps.now
      });

      await invokePhase({
        service: deps.canvasLiveEvents,
        taskId: input.taskId,
        method: "POST",
        url: "/v1/domains/bind",
        body: {
          domain: input.domain,
          serverSlug,
          serverIp,
          zoneId: stringFrom(dns, "zoneId"),
          actorId: input.actorId,
          approvalToken: input.approvalToken,
          taskId: input.taskId
        },
        handler: (request, response) => handleDomainBindHttp({
          request,
          response,
          auditLog: deps.auditLog,
          dnsAdapter: deps.dnsAdapter,
          workspace: deps.workspace,
          canvasLiveEvents: canvas,
          readCanvasState: deps.readCanvasState,
          env: deps.env,
          now: deps.now
        }),
        now: deps.now
      });

      return {
        domain: input.domain,
        taskId: input.taskId,
        status: "completed",
        operationId: stringFrom(register, "operationId"),
        costUsd: numberFrom(register, "costUsd"),
        zoneId: stringFrom(dns, "zoneId"),
        serverSlug,
        serverIp,
        dkimPrivateKeyPath: stringFrom(auth, "dkimPrivateKeyPath"),
        seedCount: input.seedInboxes.length
      };
    }
  };
}

export class OnboardFlowInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "OnboardFlowInputError";
  }
}

export function handleOnboardFlowError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof OnboardFlowInputError) {
    json(response, error.statusCode, {
      error: "invalid_onboard_flow_request",
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

async function runBatch(input: OnboardFlowDependencies & {
  actorId: string;
  approvalToken: string;
  domains: string[];
  profile: OnboardProfile;
  parentTaskId: string;
  subTaskIds: string[];
  maxRetries: number;
  seedInboxes: string[];
  common: CommonFlowOptions;
}): Promise<void> {
  const startedAt = Date.now();
  const results = await Promise.all(input.domains.map((domain, index) => runWithRetry({
    deps: input,
    domain,
    taskId: input.subTaskIds[index],
    parentTaskId: input.parentTaskId,
    maxRetries: input.maxRetries,
    flowInput: {
      domain,
      profile: input.profile,
      actorId: input.actorId,
      approvalToken: input.approvalToken,
      taskId: input.subTaskIds[index],
      parentTaskId: input.parentTaskId,
      seedInboxes: input.seedInboxes,
      ...input.common
    }
  })));

  const successful = results.filter((result): result is BatchDomainResult & { ok: true } => result.ok);
  const failed = results.filter((result): result is BatchDomainResult & { ok: false } => !result.ok);
  const now = input.now?.() ?? new Date();
  const artifactId = `batch-report-${randomUUID().slice(0, 12)}`;
  await input.canvasLiveEvents.emit({
    type: "oc.artifact.declare",
    taskId: input.parentTaskId,
    artifactId,
    kind: "report",
    title: `Batch result: ${successful.length} ok · ${failed.length} failed`,
    editable: false,
    createdAt: now.toISOString()
  });
  await input.canvasLiveEvents.emit({
    type: "oc.artifact.block",
    artifactId,
    blockId: "summary",
    order: 1,
    kind: "paragraph",
    content: renderBatchSummary(successful, failed),
    editable: false,
    status: "complete",
    occurredAt: now.toISOString()
  });
  await input.canvasLiveEvents.emit({
    type: "oc.artifact.block",
    artifactId,
    blockId: "domains",
    order: 2,
    kind: "table_row",
    content: renderBatchRows(results),
    editable: false,
    status: "complete",
    occurredAt: now.toISOString()
  });

  const workspace = await input.workspace.writeExecutionRecord({
    skill: skillName,
    params: {
      domains: input.domains,
      profile: input.profile,
      parentTaskId: input.parentTaskId
    },
    outcome: failed.length === input.domains.length ? "failed" : "success",
    durationMs: Date.now() - startedAt,
    evidence: {
      successful: successful.map((entry) => ({ domain: entry.domain, taskId: entry.taskId })),
      failed: failed.map((entry) => ({ domain: entry.domain, taskId: entry.taskId, error: entry.error })),
      artifactId
    }
  });
  await input.workspace.updateInventoryJson<{
    batches?: Array<{
      parentTaskId: string;
      domains: string[];
      successful: number;
      failed: number;
      updatedAt: string;
    }>;
  }>("onboard-batches.json", (current) => ({
    batches: [
      ...(current?.batches ?? []),
      {
        parentTaskId: input.parentTaskId,
        domains: input.domains,
        successful: successful.length,
        failed: failed.length,
        updatedAt: now.toISOString()
      }
    ]
  }));
  await input.auditLog.append({
    actorType: "operator",
    actorId: input.actorId,
    action: "oc.flow.onboard_batch_completed",
    targetType: "onboard_batch",
    targetId: input.parentTaskId,
    riskLevel: "critical",
    decision: failed.length === input.domains.length ? "reject" : "allow",
    humanApproved: true,
    approverIds: [input.actorId],
    metadata: {
      domains: input.domains,
      successful: successful.length,
      failed: failed.length,
      artifactId,
      workspacePath: workspace.path
    }
  });
  await input.canvasLiveEvents.emit({
    type: "oc.action.now",
    taskId: input.parentTaskId,
    kind: "audit",
    action: "oc.flow.onboard_batch_completed",
    targetType: "onboard_batch",
    targetId: input.parentTaskId,
    riskLevel: "critical",
    occurredAt: now.toISOString()
  });
  await input.canvasLiveEvents.emit({
    type: "oc.task.update",
    taskId: input.parentTaskId,
    status: failed.length === input.domains.length ? "failed" : "completed",
    updatedAt: now.toISOString()
  });
}

async function runSingle(input: {
  deps: OnboardFlowDependencies;
  input: OnboardDomainFlowInput;
}): Promise<void> {
  const result = await runWithRetry({
    deps: input.deps,
    domain: input.input.domain,
    taskId: input.input.taskId,
    parentTaskId: input.input.parentTaskId,
    maxRetries: 0,
    flowInput: input.input
  });
  if (!result.ok) {
    await input.deps.canvasLiveEvents.emit({
      type: "oc.task.update",
      taskId: input.input.taskId,
      status: "failed",
      updatedAt: (input.deps.now?.() ?? new Date()).toISOString()
    });
  }
}

type BatchDomainResult =
  | ({ ok: true; attempts: number } & OnboardDomainFlowResult)
  | { ok: false; domain: string; taskId: string; attempts: number; error: string };

async function runWithRetry(input: {
  deps: Pick<OnboardFlowDependencies, "runner" | "canvasLiveEvents" | "workspace" | "now">;
  domain: string;
  taskId: string;
  parentTaskId?: string;
  maxRetries: number;
  flowInput: OnboardDomainFlowInput;
}): Promise<BatchDomainResult> {
  let attempt = 0;
  let lastError: unknown = null;
  while (attempt <= input.maxRetries) {
    attempt += 1;
    try {
      if (attempt > 1) {
        await input.deps.canvasLiveEvents.emit({
          type: "oc.action.now",
          taskId: input.taskId,
          kind: "audit",
          action: "oc.flow.onboard_retry",
          targetType: "domain",
          targetId: input.domain,
          riskLevel: "high",
          occurredAt: (input.deps.now?.() ?? new Date()).toISOString()
        });
      }
      const result = await input.deps.runner.run(input.flowInput);
      await input.deps.canvasLiveEvents.emit({
        type: "oc.task.update",
        taskId: input.taskId,
        status: "completed",
        updatedAt: (input.deps.now?.() ?? new Date()).toISOString()
      });
      return { ...result, ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      await input.deps.workspace.writeLearning({
        skill: skillName,
        title: `${input.domain}-attempt-${attempt}`,
        content: [
          `# ${skillName} failure`,
          "",
          `- domain: ${input.domain}`,
          `- taskId: ${input.taskId}`,
          `- attempt: ${attempt}`,
          `- error: ${errorMessage(error)}`,
          "",
          "## Suggested fix",
          "",
          "Re-read workspace learnings before retrying this domain. If the blocker is external credentials, keep the sub-task blocked and let the parent batch continue.",
          ""
        ].join("\n")
      });
      if (attempt <= input.maxRetries) {
        continue;
      }
    }
  }

  await input.deps.canvasLiveEvents.emit({
    type: "oc.task.update",
    taskId: input.taskId,
    status: "failed",
    updatedAt: (input.deps.now?.() ?? new Date()).toISOString()
  });
  return {
    ok: false,
    domain: input.domain,
    taskId: input.taskId,
    attempts: attempt,
    error: errorMessage(lastError)
  };
}

interface CommonFlowOptions {
  years: number;
  autoRenew: boolean;
  locationId: string;
  imageSlug: "ubuntu-2404" | "debian-12";
  publicKey?: string;
}

function parseCommonOptions(body: OnboardBatchBody, env?: Record<string, string | undefined>): CommonFlowOptions {
  const publicKey = typeof body.publicKey === "string" && body.publicKey.trim()
    ? body.publicKey.trim()
    : env?.WEBDOCK_OPERATOR_SSH_PUBLIC_KEY;
  return {
    years: parseYears(body.years),
    autoRenew: typeof body.autoRenew === "boolean" ? body.autoRenew : false,
    locationId: typeof body.locationId === "string" && body.locationId.trim() ? body.locationId.trim() : env?.WEBDOCK_DEFAULT_LOCATION_ID ?? "dk",
    imageSlug: parseImageSlug(body.imageSlug),
    ...(publicKey ? { publicKey } : {})
  };
}

async function invokePhase(input: {
  service: CanvasEmitter;
  taskId: string;
  method: string;
  url: string;
  body: Record<string, unknown>;
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  now?: () => Date;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const response = captureResponse();
  await input.handler(
    requestWithJson(input.method, input.url, input.body),
    response as unknown as ServerResponse
  );
  const parsed = parseResponseBody(response.body);
  await input.service.emit({
    type: "oc.action.now",
    taskId: input.taskId,
    kind: "api",
    method: input.method,
    url: input.url,
    status: response.statusCode || 500,
    durationMs: Date.now() - startedAt,
    responseBytes: Buffer.byteLength(response.body),
    responseBody: parsed,
    occurredAt: (input.now?.() ?? new Date()).toISOString()
  });
  if ((response.statusCode || 500) >= 400) {
    throw new OnboardFlowPhaseError(input.url, response.statusCode || 500, parsed);
  }
  return isRecord(parsed) ? parsed : {};
}

class OnboardFlowPhaseError extends Error {
  readonly phase: string;
  readonly statusCode: number;
  readonly body: unknown;

  constructor(phase: string, statusCode: number, body: unknown) {
    super(`${phase} failed with HTTP ${statusCode}`);
    this.name = "OnboardFlowPhaseError";
    this.phase = phase;
    this.statusCode = statusCode;
    this.body = body;
  }
}

function actionOnlyCanvas(service: CanvasEmitter): CanvasEmitter {
  return {
    async emit(event) {
      if (event.type === "oc.task.declare" || event.type === "oc.task.update") {
        return event;
      }
      return service.emit(event);
    }
  };
}

function requestWithJson(method: string, url: string, body: Record<string, unknown>): IncomingMessage {
  const stream = Readable.from([JSON.stringify(stripUndefined(body))]);
  return Object.assign(stream, {
    method,
    url,
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload?: string | Buffer) => void;
} {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload?: string | Buffer): void {
      this.body = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload ?? "";
    }
  };
}

function parseResponseBody(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

function parseDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OnboardFlowInputError("domains must be a non-empty array.");
  }
  if (value.length > 6) {
    throw new OnboardFlowInputError("domains cannot exceed 6 items for the demo flow.");
  }
  const domains = value.map((entry) => normalizeDomainName(requiredString(entry, "domain")));
  if (new Set(domains).size !== domains.length) {
    throw new OnboardFlowInputError("domains must be unique.");
  }
  return domains;
}

function parseProfile(value: unknown): OnboardProfile {
  if (value === undefined || value === null || value === "") return "bit";
  if (value === "bit" || value === "nibble" || value === "byte" || value === "kilobyte") return value;
  throw new OnboardFlowInputError("profile must be bit, nibble, byte, or kilobyte.");
}

function parseYears(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new OnboardFlowInputError("years must be an integer between 1 and 10.");
  }
  return parsed;
}

function parseImageSlug(value: unknown): "ubuntu-2404" | "debian-12" {
  if (value === undefined || value === null || value === "") return "ubuntu-2404";
  if (value === "ubuntu-2404" || value === "debian-12") return value;
  throw new OnboardFlowInputError("imageSlug must be ubuntu-2404 or debian-12.");
}

function parseRetries(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2) {
    throw new OnboardFlowInputError("maxRetries must be between 0 and 2.");
  }
  return parsed;
}

function parseSeedInboxes(value: unknown, env?: Record<string, string | undefined>): string[] {
  const source = Array.isArray(value)
    ? value
    : (env?.DELIVRIX_DEMO_SEED_INBOXES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (source.length !== 3) {
    throw new OnboardFlowInputError("seedInboxes must include exactly 3 inboxes or DELIVRIX_DEMO_SEED_INBOXES must define 3 values.");
  }
  return source.map((entry) => normalizeEmail(requiredString(entry, "seedInboxes[]")));
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new OnboardFlowInputError(`Invalid seed inbox: ${value}`);
  }
  return normalized;
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new OnboardFlowInputError(`Invalid domain name: ${value}`);
  }
  return normalized;
}

function normalizeTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(trimmed) ? trimmed : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OnboardFlowInputError(`${field} is required.`);
  }
  return value.trim();
}

function stringFrom(value: unknown, field: string): string | undefined {
  const entry = isRecord(value) ? value[field] : undefined;
  return typeof entry === "string" && entry.trim()
    ? entry.trim()
    : undefined;
}

function numberFrom(value: unknown, field: string): number | null {
  const entry = isRecord(value) ? value[field] : undefined;
  return typeof entry === "number" ? entry : null;
}

function scheduleJob(
  deps: Pick<OnboardFlowDependencies, "schedule">,
  job: () => Promise<void>
): void {
  if (deps.schedule) {
    deps.schedule(job);
    return;
  }
  setImmediate(() => {
    void job();
  });
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function renderBatchSummary(
  successful: Array<BatchDomainResult & { ok: true }>,
  failed: Array<BatchDomainResult & { ok: false }>
): string {
  return `Supervisor completed batch: ${successful.length} succeeded, ${failed.length} failed. Failed domains remain isolated; the parent flow did not collapse.`;
}

function renderBatchRows(results: BatchDomainResult[]): string {
  return [
    "| domain | status | attempts | detail |",
    "|---|---:|---:|---|",
    ...results.map((result) => result.ok
      ? `| ${result.domain} | ok | ${result.attempts} | ${result.serverSlug ?? "server pending"} |`
      : `| ${result.domain} | failed | ${result.attempts} | ${result.error.replace(/\|/g, "/")} |`)
  ].join("\n");
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 72) || "domain";
}

function errorMessage(error: unknown): string {
  if (error instanceof OnboardFlowPhaseError) {
    return `${error.message}: ${JSON.stringify(error.body).slice(0, 500)}`;
  }
  return error instanceof Error ? error.message : "Unknown onboard flow error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new OnboardFlowInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
