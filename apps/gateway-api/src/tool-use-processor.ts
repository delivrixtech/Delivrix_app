import { randomUUID } from "node:crypto";
import { signOpenClawPayload } from "./security/hmac.ts";
import { canonicalSkillSlug } from "./skill-contracts.ts";
import {
  getOpenClawToolDefinition,
  isOpenClawToolEnabled,
  openClawToolMetadata
} from "./openclaw-tools-builder.ts";
import {
  noopGatewayRuntimeLogger,
  summarizeOperationalParams,
  type GatewayRuntimeLogger
} from "./gateway-runtime-log.ts";
import { stableStringify } from "../../../packages/storage/src/stable-stringify.ts";

type FetchLike = typeof fetch;

export interface ToolUseChatSession {
  id: string;
  msgId?: string;
}

export interface ProcessToolUseInput {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  chatSession: ToolUseChatSession;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  deps: ToolUseProcessorDeps;
  now?: () => Date;
  logger?: GatewayRuntimeLogger;
}

export interface ToolUseProcessorDeps {
  submitProposalFromToolUse(input: SubmitProposalFromToolUseInput): Promise<ToolUseProposalSubmission>;
  waitForProposalDecision(input: WaitForProposalDecisionInput): Promise<ToolUseProposalDecision>;
  invokeReadOnlyTool?: (input: InvokeReadOnlyToolInput) => Promise<unknown>;
  invokeMemoryTool?: (input: InvokeReadOnlyToolInput) => Promise<unknown>;
  readKillSwitch?: () => Promise<{ enabled: boolean }> | { enabled: boolean };
}

export interface SubmitProposalFromToolUseInput {
  toolUseId: string;
  toolName: string;
  params: Record<string, unknown>;
  chatSession: ToolUseChatSession;
  env: Record<string, string | undefined>;
  now: Date;
}

export interface ToolUseProposalSubmission {
  proposalId: string;
  duplicate?: boolean;
  requiresApproval?: boolean;
  requiredApprovals?: number;
}

export interface InvokeReadOnlyToolInput {
  toolUseId: string;
  toolName: string;
  params: Record<string, unknown>;
  chatSession: ToolUseChatSession;
  env: Record<string, string | undefined>;
  now: Date;
}

export interface WaitForProposalDecisionInput {
  proposalId: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}

export type ToolUseProposalDecision =
  | {
      status: "executed" | "execution_failed";
      proposalId: string;
      ok: boolean;
      signatureId?: string;
      outcome?: unknown;
      durationMs?: number;
      statusCode?: number;
    }
  | {
      status: "rejected";
      proposalId: string;
      reason?: string;
    }
  | {
      status: "approval_timeout" | "execution_timeout";
      proposalId: string;
      timeoutMs: number;
    }
  | {
      status: "kill_switch_armed";
      proposalId: string;
    };

export type ToolUseResult =
  | {
      ok: true;
      status: "executed";
      result: unknown;
      durationMs?: number;
      proposalId: string;
      signatureId?: string;
      statusCode?: number;
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
      reason?: string;
      timeoutMs?: number;
      proposalId?: string;
      statusCode?: number;
    };

export interface HttpToolUseProcessorConfig {
  delivrixBaseUrl: string;
  fetchImpl?: FetchLike;
  readBoundaryToken?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  pollIntervalMs?: number;
  logger?: GatewayRuntimeLogger;
}

const defaultApprovalTimeoutMs = 300_000;
const defaultPollIntervalMs = 1_000;
const maxToolResultJsonChars = 4096;

export async function processToolUse(input: ProcessToolUseInput): Promise<ToolUseResult> {
  const env = input.env ?? {};
  const now = input.now?.() ?? new Date();
  const canonicalToolName = canonicalSkillSlug(input.toolName);
  const definition = getOpenClawToolDefinition(canonicalToolName);
  const logger = input.logger ?? noopGatewayRuntimeLogger;

  if (!definition) {
    void logger.warn("openclaw.tool_use.unknown_tool", "Bedrock requested an unknown Delivrix tool.", {
      toolUseId: input.toolUseId,
      toolName: input.toolName
    });
    return {
      ok: false,
      error: "unknown_tool",
      details: { tool: input.toolName }
    };
  }

  if (!isOpenClawToolEnabled(canonicalToolName, env)) {
    void logger.warn("openclaw.tool_use.disabled", "Bedrock requested a disabled Delivrix tool.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName
    });
    return {
      ok: false,
      error: "tool_disabled",
      details: { tool: canonicalToolName }
    };
  }

  const validation = definition.paramSchema.safeParse(input.toolInput);
  if (!validation.success) {
    void logger.warn("openclaw.tool_use.invalid_params", "Tool-use params failed schema validation.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      details: validation.error.format()
    });
    return {
      ok: false,
      error: "invalid_params",
      details: validation.error.format()
    };
  }

  if (shouldRouteThroughConfigureCompleteSmtp(canonicalToolName, input.toolInput, env)) {
    void logger.warn("openclaw.tool_use.use_configure_complete_smtp", "Blocked direct SMTP subtool; configure_complete_smtp is required for end-to-end SMTP autonomy.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName
    });
    return {
      ok: false,
      error: "use_configure_complete_smtp",
      details: {
        tool: canonicalToolName,
        requiredTool: "configure_complete_smtp",
        repairEscapeHatch: "Set repairReason and explicitRepairScope for a punctual repair."
      }
    };
  }

  const killSwitch = await readKillSwitchFailClosed(input.deps);
  if (!killSwitch.ok) {
    void logger.error("openclaw.tool_use.kill_switch_read_failed", "Tool-use failed closed because kill switch could not be read.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      details: killSwitch.details
    });
    return {
      ok: false,
      error: killSwitch.error,
      details: killSwitch.details
    };
  }
  if (killSwitch.enabled) {
    void logger.warn("openclaw.tool_use.kill_switch_armed", "Tool-use blocked because kill switch is armed.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName
    });
    return {
      ok: false,
      error: "kill_switch_armed"
    };
  }

  if (isReadOnlyToolUse(canonicalToolName)) {
    if (!input.deps.invokeReadOnlyTool) {
      return {
        ok: false,
        error: "read_only_tool_invoker_missing",
        details: { tool: canonicalToolName }
      };
    }
    try {
      void logger.info("openclaw.tool_use.read_only_started", "Running read-only Delivrix tool for Bedrock.", {
        toolUseId: input.toolUseId,
        toolName: canonicalToolName,
        params: summarizeOperationalParams(validation.data)
      });
      return {
        ok: true,
        status: "executed",
        result: truncateToolResult(await input.deps.invokeReadOnlyTool({
          toolUseId: input.toolUseId,
          toolName: canonicalToolName,
          params: validation.data,
          chatSession: input.chatSession,
          env,
          now
        })),
        proposalId: `read_only:${input.toolUseId}`
      };
    } catch (error) {
      void logger.warn("openclaw.tool_use.read_only_failed", "Read-only Delivrix tool failed.", {
        toolUseId: input.toolUseId,
        toolName: canonicalToolName,
        details: errorMessage(error)
      });
      return {
        ok: false,
        error: "read_only_tool_failed",
        details: errorMessage(error)
      };
    }
  }

  if (isMemoryToolUse(canonicalToolName)) {
    if (!input.deps.invokeMemoryTool) {
      return {
        ok: false,
        error: "memory_tool_invoker_missing",
        details: { tool: canonicalToolName }
      };
    }
    try {
      void logger.info("openclaw.tool_use.memory_started", "Running audited OpenClaw memory tool for Bedrock.", {
        toolUseId: input.toolUseId,
        toolName: canonicalToolName,
        params: summarizeOperationalParams(validation.data)
      });
      return {
        ok: true,
        status: "executed",
        result: truncateToolResult(await input.deps.invokeMemoryTool({
          toolUseId: input.toolUseId,
          toolName: canonicalToolName,
          params: validation.data,
          chatSession: input.chatSession,
          env,
          now
        })),
        proposalId: `memory:${input.toolUseId}`
      };
    } catch (error) {
      void logger.warn("openclaw.tool_use.memory_failed", "OpenClaw memory tool failed.", {
        toolUseId: input.toolUseId,
        toolName: canonicalToolName,
        details: errorMessage(error)
      });
      return {
        ok: false,
        error: "memory_tool_failed",
        details: errorMessage(error)
      };
    }
  }

  let proposal: ToolUseProposalSubmission;
  try {
    void logger.info("openclaw.tool_use.proposal_submit_started", "Submitting ApprovalGate proposal for Bedrock tool-use.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      params: summarizeOperationalParams(validation.data)
    });
    proposal = await input.deps.submitProposalFromToolUse({
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      params: validation.data,
      chatSession: input.chatSession,
      env,
      now
    });
    void logger.info("openclaw.tool_use.proposal_submitted", "ApprovalGate proposal submitted; waiting for operator decision.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      proposalId: proposal.proposalId,
      duplicate: proposal.duplicate === true,
      requiredApprovals: proposal.requiredApprovals,
      requiresApproval: proposal.requiresApproval
    });
  } catch (error) {
    void logger.error("openclaw.tool_use.proposal_submit_failed", "ApprovalGate proposal submission failed.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      details: errorMessage(error)
    });
    return {
      ok: false,
      error: "proposal_submit_failed",
      details: errorMessage(error)
    };
  }

  const timeoutMs = input.timeoutMs ?? approvalTimeoutForTool(canonicalToolName, env, validation.data);
  void logger.info("openclaw.tool_use.awaiting_approval", "Waiting for ApprovalGate decision.", {
    toolUseId: input.toolUseId,
    toolName: canonicalToolName,
    proposalId: proposal.proposalId,
    timeoutMs
  });
  const decision = await input.deps.waitForProposalDecision({
    proposalId: proposal.proposalId,
    timeoutMs,
    env
  });

  if (decision.status === "executed" || decision.status === "execution_failed") {
    void (decision.ok
      ? logger.info("openclaw.tool_use.executed", "ApprovalGate execution completed successfully.", {
        toolUseId: input.toolUseId,
        toolName: canonicalToolName,
        proposalId: decision.proposalId,
        signatureId: decision.signatureId,
        statusCode: decision.statusCode,
        durationMs: decision.durationMs
      })
      : logger.error("openclaw.tool_use.execution_failed", "ApprovalGate execution failed.", {
        toolUseId: input.toolUseId,
        toolName: canonicalToolName,
        proposalId: decision.proposalId,
        signatureId: decision.signatureId,
        statusCode: decision.statusCode,
        outcome: decision.outcome
      }));
    return decision.ok
      ? {
          ok: true,
          status: "executed",
          result: truncateToolResult(decision.outcome ?? { status: decision.status }),
          ...(decision.durationMs === undefined ? {} : { durationMs: decision.durationMs }),
          proposalId: decision.proposalId,
          ...(decision.signatureId ? { signatureId: decision.signatureId } : {}),
          ...(decision.statusCode === undefined ? {} : { statusCode: decision.statusCode })
        }
      : {
          ok: false,
          error: "execution_failed",
          details: truncateToolResult(decision.outcome ?? { status: decision.status }),
          proposalId: decision.proposalId,
          ...(decision.signatureId ? { reason: `signatureId=${decision.signatureId}` } : {}),
          ...(decision.statusCode === undefined ? {} : { statusCode: decision.statusCode })
        };
  }

  if (decision.status === "rejected") {
    void logger.warn("openclaw.tool_use.rejected", "Operator rejected ApprovalGate proposal.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      proposalId: decision.proposalId,
      reason: decision.reason
    });
    return {
      ok: false,
      error: "rejected_by_operator",
      reason: decision.reason,
      proposalId: decision.proposalId
    };
  }

  if (decision.status === "kill_switch_armed") {
    void logger.warn("openclaw.tool_use.kill_switch_armed", "Tool-use stopped while waiting because kill switch is armed.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      proposalId: decision.proposalId
    });
    return {
      ok: false,
      error: "kill_switch_armed",
      proposalId: decision.proposalId
    };
  }

  if (decision.status === "approval_timeout" || decision.status === "execution_timeout") {
    void logger.warn(`openclaw.tool_use.${decision.status}`, "ApprovalGate wait timed out.", {
      toolUseId: input.toolUseId,
      toolName: canonicalToolName,
      proposalId: decision.proposalId,
      timeoutMs: decision.timeoutMs
    });
    return {
      ok: false,
      error: decision.status,
      timeoutMs: decision.timeoutMs,
      proposalId: decision.proposalId
    };
  }

  return {
    ok: false,
    error: "unexpected_decision",
    details: decision
  };
}

export function createHttpToolUseProcessor(config: HttpToolUseProcessorConfig): (input: Omit<ProcessToolUseInput, "deps" | "env" | "now">) => Promise<ToolUseResult> {
  const env = config.env ?? (typeof process !== "undefined" ? process.env : {});
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const baseUrl = normalizeBaseUrl(config.delivrixBaseUrl);
  const nowFn = config.now ?? (() => new Date());
  const pollIntervalMs = config.pollIntervalMs ?? defaultPollIntervalMs;
  const logger = config.logger ?? noopGatewayRuntimeLogger;
  const readKillSwitch = async () => readKillSwitchOverHttp({
    baseUrl,
    fetchImpl,
    readBoundaryToken: config.readBoundaryToken ?? ""
  });

  const deps: ToolUseProcessorDeps = {
    submitProposalFromToolUse: async (input) => submitProposalOverHttp({
      input,
      baseUrl,
      fetchImpl,
      env,
      now: nowFn
    }),
    waitForProposalDecision: async (input) => waitForProposalDecisionOverHttp({
      input,
      baseUrl,
      fetchImpl,
      readBoundaryToken: config.readBoundaryToken ?? "",
      pollIntervalMs,
      readKillSwitch
    }),
    invokeReadOnlyTool: async (input) => invokeReadOnlyToolOverHttp({
      input,
      baseUrl,
      fetchImpl,
      readBoundaryToken: config.readBoundaryToken ?? ""
    }),
    invokeMemoryTool: async (input) => invokeMemoryToolOverHttp({
      input,
      baseUrl,
      fetchImpl,
      env,
      now: nowFn
    }),
    readKillSwitch
  };

  return (input) => processToolUse({
    ...input,
    env,
    deps,
    now: nowFn,
    logger
  });
}

export function buildProposalPayloadFromToolUse(input: SubmitProposalFromToolUseInput): {
  schemaVersion: "2026-05-18.v1";
  proposal: {
    id: string;
    category: string;
    severity: "high" | "critical";
    headline: string;
    body: string;
    evidenceRefs: string[];
    runbookRef: string;
    targetRef: string;
    targetType: string;
    skillSlug: string;
    params: Record<string, unknown>;
    delivrix_actions_required: string[];
  };
  audit: {
    skillSlug: string;
    modelVersion: string;
    promptVersion: string;
    tokensUsed: number;
  };
} {
  const metadata = openClawToolMetadata(input.toolName) ?? {
    targetType: "proposal_target",
    severity: "high" as const
  };
  const target = toolTarget(input.toolName, input.params, metadata.targetType);
  const proposalId = randomUUID();
  const paramsJson = stableStringify(input.params);
  return {
    schemaVersion: "2026-05-18.v1",
    proposal: {
      id: proposalId,
      category: input.toolName,
      severity: metadata.severity,
      headline: `OpenClaw solicita ejecutar ${input.toolName}`,
      body: [
        `Tool use Bedrock ${input.toolUseId} solicita ${input.toolName}.`,
        "No se ejecuta ningún side effect hasta que ApprovalGate reciba firma humana válida.",
        `Parámetros validados: ${paramsJson.slice(0, 1800)}`
      ].join("\n\n"),
      evidenceRefs: [
        `bedrock_tool_use:${input.toolUseId}`,
        `chat_session:${input.chatSession.id}`,
        ...(input.chatSession.msgId ? [`chat_msg:${input.chatSession.msgId}`] : [])
      ],
      runbookRef: input.toolName,
      targetRef: target.id,
      targetType: target.type,
      skillSlug: input.toolName,
      params: input.params,
      delivrix_actions_required: [input.toolName]
    },
    audit: {
      skillSlug: input.toolName,
      modelVersion: "bedrock-tool-use",
      promptVersion: "openclaw-tool-calling-v1",
      tokensUsed: 0
    }
  };
}

async function submitProposalOverHttp(input: {
  input: SubmitProposalFromToolUseInput;
  baseUrl: string;
  fetchImpl: FetchLike;
  env: Record<string, string | undefined>;
  now: () => Date;
}): Promise<ToolUseProposalSubmission> {
  const secret = input.env.OPENCLAW_HMAC_SECRET?.trim();
  if (!secret) {
    throw new Error("OPENCLAW_HMAC_SECRET is required for tool proposal submission.");
  }

  const payload = buildProposalPayloadFromToolUse(input.input);
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(input.now().getTime() / 1000);
  const signature = signOpenClawPayload(raw, timestamp, secret);
  const response = await input.fetchImpl(`${input.baseUrl}/v1/agent/proposals`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-openclaw-timestamp": String(timestamp),
      "x-openclaw-signature": signature
    },
    body: raw
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body || typeof body.proposalId !== "string") {
    throw new Error(`proposal submit failed with HTTP ${response.status}`);
  }

  return {
    proposalId: body.proposalId,
    duplicate: body.duplicate === true,
    requiresApproval: body.requiresApproval === true,
    requiredApprovals: typeof body.requiredApprovals === "number" ? body.requiredApprovals : undefined
  };
}

async function invokeReadOnlyToolOverHttp(input: {
  input: InvokeReadOnlyToolInput;
  baseUrl: string;
  fetchImpl: FetchLike;
  readBoundaryToken?: string;
}): Promise<unknown> {
  if (input.input.toolName === "suggest_safe_domain") {
    const response = await input.fetchImpl(`${input.baseUrl}/v1/skills/suggest-safe-domain`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...input.input.params,
        actorId: input.input.chatSession.id
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`read-only tool failed with HTTP ${response.status}`);
    }
    return body;
  }

  if (input.input.toolName === "wait_for_dns_propagation") {
    const response = await input.fetchImpl(`${input.baseUrl}/v1/skills/wait-for-dns-propagation/read-only`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...input.input.params,
        actorId: input.input.chatSession.id
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`read-only tool failed with HTTP ${response.status}`);
    }
    return body;
  }

  if (input.input.toolName === "read_episodic_scratch") {
    const url = new URL(`${input.baseUrl}/v1/openclaw/scratch`);
    for (const [key, value] of Object.entries(input.input.params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await input.fetchImpl(url, {
      headers: {
        accept: "application/json",
        ...(input.readBoundaryToken ? { "x-delivrix-token": input.readBoundaryToken } : {})
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`read-only tool failed with HTTP ${response.status}`);
    }
    return body;
  }

  if (input.input.toolName === "read_route53_domain_detail") {
    const url = new URL(`${input.baseUrl}/v1/route53/domain-detail`);
    url.searchParams.set("domain", String(input.input.params.domain));
    const response = await input.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(input.readBoundaryToken ? { "x-delivrix-token": input.readBoundaryToken } : {})
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`read-only tool failed with HTTP ${response.status}`);
    }
    return body;
  }

  if (input.input.toolName === "read_route53_zone_records") {
    const url = new URL(`${input.baseUrl}/v1/route53/zone-records`);
    url.searchParams.set("zoneId", String(input.input.params.zoneId));
    if (typeof input.input.params.recordType === "string") {
      url.searchParams.set("recordType", input.input.params.recordType);
    }
    if (typeof input.input.params.recordName === "string") {
      url.searchParams.set("recordName", input.input.params.recordName);
    }
    const response = await input.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(input.readBoundaryToken ? { "x-delivrix-token": input.readBoundaryToken } : {})
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`read-only tool failed with HTTP ${response.status}`);
    }
    return body;
  }

  if (input.input.toolName === "read_dns_ionos") {
    const url = new URL(`${input.baseUrl}/v1/dns/ionos/records`);
    if (typeof input.input.params.domain === "string") {
      url.searchParams.set("domain", input.input.params.domain);
    }
    if (typeof input.input.params.zoneId === "string") {
      url.searchParams.set("zoneId", input.input.params.zoneId);
    }
    if (typeof input.input.params.recordType === "string") {
      url.searchParams.set("recordType", input.input.params.recordType);
    }
    if (typeof input.input.params.recordName === "string") {
      url.searchParams.set("recordName", input.input.params.recordName);
    }
    const response = await input.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(input.readBoundaryToken ? { "x-delivrix-token": input.readBoundaryToken } : {})
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`read-only tool failed with HTTP ${response.status}`);
    }
    return body;
  }

  if (input.input.toolName === "read_webdock_servers") {
    const response = await input.fetchImpl(`${input.baseUrl}/v1/webdock/inventory`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-openclaw-skill-invocation": "delivrix-fleet-ops"
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`read-only tool failed with HTTP ${response.status}`);
    }
    return filterWebdockInventoryResult(body, input.input.params);
  }

  throw new Error(`unsupported_read_only_tool:${input.input.toolName}`);
}

async function invokeMemoryToolOverHttp(input: {
  input: InvokeReadOnlyToolInput;
  baseUrl: string;
  fetchImpl: FetchLike;
  env: Record<string, string | undefined>;
  now: () => Date;
}): Promise<unknown> {
  if (input.input.toolName !== "compact_intent") {
    throw new Error(`unsupported_memory_tool:${input.input.toolName}`);
  }

  const secret = input.env.OPENCLAW_HMAC_SECRET?.trim();
  if (!secret) {
    throw new Error("OPENCLAW_HMAC_SECRET is required for memory tool submission.");
  }

  const raw = JSON.stringify({
    ...input.input.params,
    actorId: input.input.chatSession.id
  });
  const timestamp = Math.floor(input.now().getTime() / 1000);
  const signature = signOpenClawPayload(raw, timestamp, secret);
  const response = await input.fetchImpl(`${input.baseUrl}/v1/openclaw/compact-intent`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-openclaw-timestamp": String(timestamp),
      "x-openclaw-signature": signature
    },
    body: raw
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`memory tool failed with HTTP ${response.status}`);
  }
  return body;
}

function filterWebdockInventoryResult(body: unknown, params: Record<string, unknown>): unknown {
  const serverSlug = typeof params.serverSlug === "string" ? params.serverSlug : null;
  const ipv4 = typeof params.ipv4 === "string" ? params.ipv4 : null;
  if (!serverSlug && !ipv4) {
    return body;
  }

  const payload = isRecord(body) ? body : {};
  const inventory = isRecord(payload.inventory) ? payload.inventory : {};
  const servers = Array.isArray(inventory.servers) ? inventory.servers : [];
  const matchedServers = servers.filter((server) => {
    if (!isRecord(server)) return false;
    const slugMatches = !serverSlug || server.slug === serverSlug;
    const ipv4Matches = !ipv4 || server.ipv4 === ipv4;
    return slugMatches && ipv4Matches;
  });

  return {
    ...payload,
    filters: {
      ...(serverSlug ? { serverSlug } : {}),
      ...(ipv4 ? { ipv4 } : {})
    },
    matchedServers
  };
}

async function waitForProposalDecisionOverHttp(input: {
  input: WaitForProposalDecisionInput;
  baseUrl: string;
  fetchImpl: FetchLike;
  readBoundaryToken: string;
  pollIntervalMs: number;
  readKillSwitch?: () => Promise<{ enabled: boolean }> | { enabled: boolean };
}): Promise<ToolUseProposalDecision> {
  const startedAt = Date.now();
  let lastStatus: string | null = null;

  while (Date.now() - startedAt < input.input.timeoutMs) {
    const killSwitch = await readKillSwitchFailClosed({ readKillSwitch: input.readKillSwitch } as ToolUseProcessorDeps);
    if (!killSwitch.ok || killSwitch.enabled) {
      return { status: "kill_switch_armed", proposalId: input.input.proposalId };
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (input.readBoundaryToken) {
      headers["x-delivrix-token"] = input.readBoundaryToken;
    }
    const response = await input.fetchImpl(
      `${input.baseUrl}/v1/openclaw/proposals/${encodeURIComponent(input.input.proposalId)}/status`,
      { headers }
    );
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok && body && typeof body.status === "string") {
      lastStatus = body.status;
      if (body.status === "executed" || body.status === "execution_failed") {
        return {
          status: body.status,
          proposalId: input.input.proposalId,
          ok: body.status === "executed" && body.executionOk !== false,
          signatureId: typeof body.signatureId === "string" ? body.signatureId : undefined,
          outcome: "outcome" in body ? body.outcome : undefined,
          durationMs: typeof body.executionDurationMs === "number" ? body.executionDurationMs : undefined,
          statusCode: typeof body.executionStatusCode === "number" ? body.executionStatusCode : undefined
        };
      }
      if (body.status === "rejected") {
        return {
          status: "rejected",
          proposalId: input.input.proposalId,
          reason: typeof body.rejectionReason === "string" ? body.rejectionReason : undefined
        };
      }
    }

    await sleep(Math.max(10, input.pollIntervalMs));
  }

  return {
    status: lastStatus === "executing" || lastStatus === "signed" ? "execution_timeout" : "approval_timeout",
    proposalId: input.input.proposalId,
    timeoutMs: input.input.timeoutMs
  };
}

async function readKillSwitchOverHttp(input: {
  baseUrl: string;
  fetchImpl: FetchLike;
  readBoundaryToken: string;
}): Promise<{ enabled: boolean }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.readBoundaryToken) {
    headers["x-delivrix-token"] = input.readBoundaryToken;
  }
  const response = await input.fetchImpl(`${input.baseUrl}/v1/kill-switch`, { headers });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const nested = isRecord(body?.killSwitch) ? body.killSwitch : null;
  const enabled = typeof body?.enabled === "boolean"
    ? body.enabled
    : typeof nested?.enabled === "boolean"
      ? nested.enabled
      : null;
  if (!response.ok || enabled === null) {
    throw new Error(`kill switch read failed with HTTP ${response.status}`);
  }
  return { enabled };
}

async function readKillSwitchFailClosed(deps: ToolUseProcessorDeps): Promise<
  | { ok: true; enabled: boolean }
  | { ok: false; error: "kill_switch_read_failed"; details: string }
> {
  if (!deps.readKillSwitch) {
    return { ok: true, enabled: false };
  }
  try {
    const state = await deps.readKillSwitch();
    if (typeof state.enabled !== "boolean") {
      return { ok: false, error: "kill_switch_read_failed", details: "invalid kill switch payload" };
    }
    return { ok: true, enabled: state.enabled };
  } catch (error) {
    return { ok: false, error: "kill_switch_read_failed", details: errorMessage(error) };
  }
}

function toolTarget(toolName: string, params: Record<string, unknown>, fallbackType: string): { id: string; type: string } {
  if (toolName === "upsert_dns_ionos" && typeof params.zone === "string") {
    return { id: params.zone, type: "ionos_dns_zone" };
  }
  if (toolName === "create_webdock_server" && typeof params.hostname === "string") {
    return { id: params.hostname, type: "webdock_server" };
  }
  if (toolName === "bind_webdock_main_domain" && typeof params.serverSlug === "string") {
    return { id: params.serverSlug, type: "webdock_server" };
  }
  if (toolName === "provision_smtp_postfix" && typeof params.serverSlug === "string") {
    return { id: params.serverSlug, type: "webdock_server" };
  }
  if (toolName === "send_real_email" && typeof params.serverSlug === "string") {
    return { id: params.serverSlug, type: "webdock_server" };
  }
  if (toolName === "configure_complete_smtp" && typeof params.brand === "string") {
    return { id: params.brand, type: "openclaw_orchestrator" };
  }
  if (typeof params.domain === "string") {
    return { id: params.domain, type: "domain" };
  }
  if (typeof params.serverIp === "string") {
    return { id: params.serverIp, type: fallbackType };
  }
  return { id: `${toolName}-${randomUUID()}`, type: fallbackType };
}

function truncateToolResult(value: unknown): unknown {
  const raw = stableStringify(value);
  if (raw.length <= maxToolResultJsonChars) {
    return value;
  }
  return {
    truncated: true,
    maxChars: maxToolResultJsonChars,
    preview: raw.slice(0, maxToolResultJsonChars)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function approvalTimeoutForTool(
  toolName: string,
  env: Record<string, string | undefined>,
  params: Record<string, unknown>
): number {
  if (toolName === "configure_complete_smtp") {
    return parsePositiveInt(env.OPENCLAW_CONFIGURE_SMTP_TOOL_TIMEOUT_MS) ??
      parsePositiveInt(env.OPENCLAW_TOOL_APPROVAL_TIMEOUT_MS) ??
      3 * 60 * 60 * 1000;
  }
  if (toolName === "wait_for_dns_propagation") {
    const maxWaitMs = positiveIntFromUnknown(params.maxWaitMs);
    const pollIntervalMs = positiveIntFromUnknown(params.pollIntervalMs) ?? 0;
    if (maxWaitMs !== undefined) {
      return Math.max(
        parsePositiveInt(env.OPENCLAW_TOOL_APPROVAL_TIMEOUT_MS) ?? defaultApprovalTimeoutMs,
        maxWaitMs + pollIntervalMs + 2 * 60 * 1000
      );
    }
  }
  return parsePositiveInt(env.OPENCLAW_TOOL_APPROVAL_TIMEOUT_MS) ?? defaultApprovalTimeoutMs;
}

function positiveIntFromUnknown(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function isReadOnlyToolUse(toolName: string): boolean {
  return toolName === "suggest_safe_domain" ||
    toolName === "wait_for_dns_propagation" ||
    toolName === "read_episodic_scratch" ||
    toolName === "read_route53_domain_detail" ||
    toolName === "read_route53_zone_records" ||
    toolName === "read_dns_ionos" ||
    toolName === "read_webdock_servers";
}

function shouldRouteThroughConfigureCompleteSmtp(
  toolName: string,
  rawInput: unknown,
  env: Record<string, string | undefined>
): boolean {
  if (!envFlagEnabled(env.OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE)) return false;
  if (!envFlagEnabled(env.OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE)) return false;
  if (!smtpPlanSubtools.has(toolName)) return false;
  if (!isRecord(rawInput)) return true;
  const repairReason = typeof rawInput.repairReason === "string" ? rawInput.repairReason.trim() : "";
  const repairScope = typeof rawInput.explicitRepairScope === "string" ? rawInput.explicitRepairScope.trim() : "";
  return repairReason.length < 10 || repairScope.length < 3;
}

const smtpPlanSubtools = new Set([
  "register_domain_route53",
  "upsert_dns_route53",
  "upsert_dns_ionos",
  "create_webdock_server",
  "bind_webdock_main_domain",
  "provision_smtp_postfix",
  "configure_email_auth",
  "seed_warmup_pool",
  "send_real_email"
]);

function envFlagEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function isMemoryToolUse(toolName: string): boolean {
  return toolName === "compact_intent";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown tool-use error";
}
