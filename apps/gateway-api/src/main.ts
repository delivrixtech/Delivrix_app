import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebdockAdapter, type WebdockBridgeNodeConfig } from "../../../packages/adapters/src/index.ts";
import {
  MailPolicyEngine,
  RateLimitService,
  SenderNodeRegistry,
  buildAdminOverview,
  buildOperationalSummary,
  evaluateSenderNodeHealth,
  requestRateLimitRules,
  type RegisterSenderNodeInput,
  type SuppressionReason,
  type SendRequest,
  type StuckJobRecoveryAction
} from "../../../packages/domain/src/index.ts";
import {
  LocalFileAuditLog,
  LocalFileRateLimitStore,
  LocalFileSendResultStore,
  LocalFileSenderNodeStore,
  LocalFileSuppressionList
} from "../../../packages/local-store/src/index.ts";
import { LocalFileSendQueue } from "../../../packages/queue/src/index.ts";

const port = Number(process.env.GATEWAY_PORT ?? 3000);
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";

const auditLog = new LocalFileAuditLog();
const sendResultStore = new LocalFileSendResultStore();
const suppressionList = new LocalFileSuppressionList();
const sendQueue = new LocalFileSendQueue();
const policyEngine = new MailPolicyEngine(suppressionList);
const senderNodeRegistry = new SenderNodeRegistry(new LocalFileSenderNodeStore());
const rateLimitStore = new LocalFileRateLimitStore();
const rateLimitService = new RateLimitService(rateLimitStore);
const webdockAdapter = new WebdockAdapter();
const defaultStuckJobThresholdMs = Number(process.env.STUCK_JOB_THRESHOLD_MS ?? 5 * 60 * 1000);
const requestRateLimitProfile = {
  campaignDailyLimit: Number(process.env.RATE_LIMIT_CAMPAIGN_DAILY ?? 100),
  senderDomainDailyLimit: Number(process.env.RATE_LIMIT_SENDER_DOMAIN_DAILY ?? 300),
  recipientDomainDailyLimit: Number(process.env.RATE_LIMIT_RECIPIENT_DOMAIN_DAILY ?? 100)
};

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, {
        status: "ok",
        service: "gateway-api",
        queue: "local-file",
        auditLog: "local-file",
        suppressionList: "local-file",
        senderNodes: "local-file",
        rateLimits: "local-file",
        phase: "base-1"
      });
    }

    if (request.method === "GET" && request.url === "/v1/audit-events") {
      return json(response, 200, {
        events: await auditLog.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/send-jobs") {
      return json(response, 200, {
        jobs: await sendQueue.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/send-results") {
      return json(response, 200, {
        results: await sendResultStore.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/suppression-entries") {
      return json(response, 200, {
        entries: await suppressionList.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/sender-nodes") {
      return json(response, 200, {
        nodes: await senderNodeRegistry.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/rate-limit-counters") {
      return json(response, 200, {
        counters: await rateLimitStore.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/operational-summary") {
      const summary = buildOperationalSummary({
        jobs: await sendQueue.list(),
        sendResults: await sendResultStore.list(),
        auditEvents: await auditLog.list(),
        senderNodes: await senderNodeRegistry.list(),
        rateLimitCounters: await rateLimitStore.list()
      });

      return json(response, 200, {
        summary
      });
    }

    if (request.method === "GET" && request.url === "/v1/admin/overview") {
      const jobs = await sendQueue.list();
      const sendResults = await sendResultStore.list();
      const auditEvents = await auditLog.list();
      const senderNodes = await senderNodeRegistry.list();
      const rateLimitCounters = await rateLimitStore.list();
      const summary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters
      });
      const health = evaluateSenderNodeHealth(senderNodes, sendResults);
      const overview = buildAdminOverview({
        summary,
        health,
        auditEvents
      });

      return json(response, 200, {
        overview
      });
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/stuck-jobs") {
      const staleAfterMs = parseStaleAfterMs(
        requestUrl(request).searchParams.get("staleAfterMs"),
        defaultStuckJobThresholdMs
      );

      if (staleAfterMs === null) {
        return json(response, 422, {
          error: "invalid_stale_after_ms",
          message: "staleAfterMs must be a positive number."
        });
      }

      const generatedAt = new Date();
      const stuckJobs = await sendQueue.listStuckProcessingJobs(staleAfterMs, generatedAt);

      return json(response, 200, {
        generatedAt: generatedAt.toISOString(),
        staleAfterMs,
        count: stuckJobs.length,
        stuckJobs
      });
    }

    if (request.method === "POST" && requestUrl(request).pathname === "/v1/stuck-jobs/recover") {
      const body = await readOptionalJson<{
        action?: StuckJobRecoveryAction;
        staleAfterMs?: number;
        reason?: string;
      }>(request);
      const action = body?.action ?? "fail";

      if (!isStuckJobRecoveryAction(action)) {
        return json(response, 422, {
          error: "invalid_recovery_action",
          message: "action must be fail or requeue."
        });
      }

      const staleAfterMs = parseStaleAfterMs(body?.staleAfterMs, defaultStuckJobThresholdMs);

      if (staleAfterMs === null) {
        return json(response, 422, {
          error: "invalid_stale_after_ms",
          message: "staleAfterMs must be a positive number."
        });
      }

      const report = await sendQueue.recoverStuckProcessingJobs({
        action,
        staleAfterMs,
        reason: body?.reason
      });

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "send_jobs.stuck_recovered",
        targetType: "send_job",
        targetId: "stuck-processing",
        riskLevel: report.recovered.length > 0 ? "medium" : "low",
        metadata: {
          action,
          staleAfterMs,
          detectedCount: report.detected.length,
          recoveredCount: report.recovered.length,
          recoveredJobIds: report.recovered.map((job) => job.id),
          smtpEnabled: false
        }
      });

      return json(response, 200, {
        report
      });
    }

    if (request.method === "GET" && request.url === "/v1/sender-node-health") {
      const decisions = evaluateSenderNodeHealth(
        await senderNodeRegistry.list(),
        await sendResultStore.list()
      );

      return json(response, 200, {
        decisions
      });
    }

    if (request.method === "POST" && request.url === "/v1/sender-node-health/reconcile") {
      const decisions = evaluateSenderNodeHealth(
        await senderNodeRegistry.list(),
        await sendResultStore.list()
      );
      const applied = [];

      for (const decision of decisions) {
        if (decision.currentStatus === decision.recommendedStatus) {
          continue;
        }

        const node = await senderNodeRegistry.updateStatus(decision.senderNodeId, decision.recommendedStatus);
        applied.push({
          senderNodeId: node.id,
          previousStatus: decision.currentStatus,
          currentStatus: node.status,
          severity: decision.severity,
          reasons: decision.reasons
        });
      }

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "sender_node_health.reconciled",
        targetType: "sender_node",
        targetId: "all",
        riskLevel: applied.length > 0 ? "medium" : "low",
        metadata: {
          appliedCount: applied.length,
          applied
        }
      });

      return json(response, 200, {
        applied,
        decisions
      });
    }

    if (request.method === "POST" && request.url === "/v1/sender-nodes") {
      const body = await readJson<RegisterSenderNodeInput>(request);
      const node = await senderNodeRegistry.register(body);

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "sender_node.registered",
        targetType: "sender_node",
        targetId: node.id,
        riskLevel: "medium",
        metadata: {
          provider: node.provider,
          status: node.status,
          dailyLimit: node.dailyLimit
        }
      });

      return json(response, 201, {
        node
      });
    }

    if (request.method === "POST" && request.url === "/v1/webdock/bridge-nodes/seed") {
      const body = await readJson<{ nodes: WebdockBridgeNodeConfig[] } | WebdockBridgeNodeConfig[]>(request);
      const configs = Array.isArray(body) ? body : body.nodes;

      if (!Array.isArray(configs)) {
        return json(response, 422, {
          error: "invalid_webdock_seed_payload",
          message: "Expected an array or an object with a nodes array."
        });
      }

      const nodes = [];
      for (const config of configs) {
        const node = await senderNodeRegistry.register(webdockAdapter.toSenderNodeInput(config));
        nodes.push({
          ...node,
          capabilities: webdockAdapter.describeCapabilities(node)
        });
      }

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "webdock_bridge_nodes.seeded",
        targetType: "sender_node",
        targetId: "webdock",
        riskLevel: "medium",
        metadata: {
          count: nodes.length,
          sideEffects: "none",
          smtpEnabledByPlatform: false
        }
      });

      return json(response, 201, {
        nodes
      });
    }

    if (request.method === "POST" && request.url === "/v1/suppression-entries") {
      const body = await readJson<{
        email: string;
        reason: SuppressionReason;
        source: string;
      }>(request);

      const entry = await suppressionList.add({
        email: body.email,
        reason: body.reason,
        source: body.source
      });

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "suppression_entry.created",
        targetType: "suppression_entry",
        targetId: entry.email,
        riskLevel: "medium",
        metadata: {
          reason: entry.reason,
          source: entry.source
        }
      });

      return json(response, 201, {
        entry
      });
    }

    if (request.method === "POST" && request.url === "/v1/send-requests") {
      const body = await readJson<SendRequest>(request);
      const decision = await policyEngine.evaluate(body);

      if (!decision.allowed) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "send_request.rejected",
          targetType: "campaign",
          targetId: body.campaignId ?? "unknown",
          riskLevel: "medium",
          metadata: {
            violations: decision.violations,
            recipient: body.recipient?.email
          }
        });

        return json(response, 422, {
          allowed: false,
          violations: decision.violations,
          warnings: decision.warnings
        });
      }

      const rateLimitRules = requestRateLimitRules(body, requestRateLimitProfile);
      const rateLimitDecision = await rateLimitService.check(rateLimitRules);

      if (!rateLimitDecision.allowed) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "send_request.rate_limited",
          targetType: "campaign",
          targetId: body.campaignId,
          riskLevel: "medium",
          metadata: {
            violations: rateLimitDecision.violations,
            recipient: body.recipient.email
          }
        });

        return json(response, 429, {
          allowed: false,
          reason: "rate_limited",
          violations: rateLimitDecision.violations
        });
      }

      const job = await sendQueue.add(body);
      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "send_request.accepted",
        targetType: "send_job",
        targetId: job.id,
        riskLevel: "low",
        metadata: {
          campaignId: body.campaignId,
          recipient: body.recipient.email,
          classification: body.classification
        }
      });

      return json(response, 202, {
        allowed: true,
        job,
        warnings: decision.warnings
      });
    }

    return json(response, 404, {
      error: "not_found"
    });
  } catch (error) {
    return json(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

server.listen(port, host, () => {
  console.log(`gateway-api listening on http://${host}:${port}`);
});

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readBody(request);

  if (!raw) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(raw) as T;
}

async function readOptionalJson<T>(request: IncomingMessage): Promise<T | undefined> {
  const raw = await readBody(request);

  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw) as T;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
}

function parseStaleAfterMs(value: string | number | null | undefined, fallback: number): number | null {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isStuckJobRecoveryAction(value: unknown): value is StuckJobRecoveryAction {
  return value === "fail" || value === "requeue";
}
