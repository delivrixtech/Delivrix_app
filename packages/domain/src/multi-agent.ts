/**
 * Fase 2 — Multi-agente seniors orquestados.
 * Contratos compartidos entre gateway y panel para el runtime multi-agente:
 * roles, eventos agent.*, input de invocación y matriz rol → tools.
 *
 * Spec: DOCUMENTACION/ARQUITECTURA_MULTI_AGENT_RUNTIME_2026_05_29.md
 */

export type AgentRole = "orchestrator" | "dns" | "smtp" | "warmup" | "qa-security";

export const AGENT_ROLES: readonly AgentRole[] = [
  "orchestrator",
  "dns",
  "smtp",
  "warmup",
  "qa-security"
];

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}

export type AgentSessionStatus =
  | "idle"
  | "starting"
  | "thinking"
  | "tool_use"
  | "awaiting_signature"
  | "paused"
  | "completed"
  | "failed";

// ---------------------------------------------------------------------------
// Tool lists por rol (16 + 9 + 10 + 8 + 12 = 55)
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_TOOL_NAMES = [
  "delegate_to_dns",
  "delegate_to_smtp",
  "delegate_to_warmup",
  "delegate_to_qa_security",
  "request_signature",
  "read_admin_overview",
  "read_kill_switch",
  "read_canvas_state",
  "read_audit_events",
  "read_workspace_executions",
  "summarize_for_operator",
  "ask_operator_clarification",
  "register_task",
  "update_task_status",
  "pause_all_agents",
  "escalate_to_operator"
] as const;

export const DNS_SENIOR_TOOL_NAMES = [
  "register_domain_route53",
  "register_domain_porkbun",
  "dns_zone_create",
  "dns_records_upsert",
  "dns_records_delete",
  "dns_propagation_verify",
  "dns_rollback",
  "ptr_request_provider",
  "read_dns_inventory"
] as const;

export const SMTP_SENIOR_TOOL_NAMES = [
  "install_smtp_stack",
  "verify_smtp_stack",
  "configure_postfix",
  "configure_opendkim",
  "configure_dovecot",
  "obtain_tls_cert",
  "bind_domain_to_server",
  "read_postfix_queue",
  "read_mail_logs",
  "restart_postfix"
] as const;

export const WARMUP_SENIOR_TOOL_NAMES = [
  "start_warmup_seed",
  "start_warmup_ramp",
  "pause_warmup_ramp",
  "resume_warmup_ramp",
  "placement_check_gmail",
  "read_warmup_progress",
  "read_bounce_complaint_rates",
  "auto_pause_if_threshold"
] as const;

export const QA_SECURITY_TOOL_NAMES = [
  "audit_dry_run_proposal",
  "verify_audit_chain_integrity",
  "scan_for_secrets",
  "detect_hallucination",
  "verify_gates_coverage",
  "read_permissions_matrix",
  "read_norte_operativo",
  "compare_action_to_runbook",
  "read_security_alerts",
  "read_rate_limit_state",
  "flag_for_human_review",
  "produce_qa_report"
] as const;

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];
export type DnsSeniorToolName = (typeof DNS_SENIOR_TOOL_NAMES)[number];
export type SmtpSeniorToolName = (typeof SMTP_SENIOR_TOOL_NAMES)[number];
export type WarmupSeniorToolName = (typeof WARMUP_SENIOR_TOOL_NAMES)[number];
export type QaSecurityToolName = (typeof QA_SECURITY_TOOL_NAMES)[number];

export type AgentToolName =
  | OrchestratorToolName
  | DnsSeniorToolName
  | SmtpSeniorToolName
  | WarmupSeniorToolName
  | QaSecurityToolName;

const toolNamesByRole: Record<AgentRole, readonly string[]> = {
  orchestrator: ORCHESTRATOR_TOOL_NAMES,
  dns: DNS_SENIOR_TOOL_NAMES,
  smtp: SMTP_SENIOR_TOOL_NAMES,
  warmup: WARMUP_SENIOR_TOOL_NAMES,
  "qa-security": QA_SECURITY_TOOL_NAMES
};

export function toolNamesForRole(role: AgentRole): readonly string[] {
  return toolNamesByRole[role];
}

/** Matriz de permisos rol → tool. El gateway rechaza tools fuera del scope del rol. */
export function isToolAllowedForRole(role: AgentRole, toolName: string): boolean {
  return toolNamesByRole[role].includes(toolName);
}

export const TOTAL_AGENT_TOOL_COUNT = 55;

// ---------------------------------------------------------------------------
// Invocación de agentes (POST /v1/openclaw/agents/{role}/invoke)
// ---------------------------------------------------------------------------

export interface AgentInvokeContext {
  approvalToken?: string;
  parentTaskId?: string;
  deadline?: string;
}

export interface AgentInvokeInput {
  taskId: string;
  delegatedBy: string;
  instructions: string;
  context?: AgentInvokeContext;
}

// ---------------------------------------------------------------------------
// Eventos agent.* (observabilidad de la spec, sección "Observabilidad")
// ---------------------------------------------------------------------------

interface AgentEventBase {
  agentRole: AgentRole;
  taskId: string;
  sessionId: string;
  occurredAt: string;
}

export interface AgentStartedEvent extends AgentEventBase {
  type: "agent.started";
  modelId: string;
}

export interface AgentThinkingEvent extends AgentEventBase {
  type: "agent.thinking";
  progressNote: string;
}

export interface AgentToolUseEvent extends AgentEventBase {
  type: "agent.tool_use";
  toolName: string;
  toolInput: unknown;
}

export interface AgentToolResultEvent extends AgentEventBase {
  type: "agent.tool_result";
  toolName: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface AgentProposingEvent extends AgentEventBase {
  type: "agent.proposing";
  auditId: string;
  summary: string;
}

export interface AgentAwaitingSignatureEvent extends AgentEventBase {
  type: "agent.awaiting_signature";
  auditId: string;
  expiresAt: string;
}

export interface AgentSignatureReceivedEvent extends AgentEventBase {
  type: "agent.signature_received";
  auditId: string;
  signedBy: string;
}

export interface AgentCompletedEvent extends AgentEventBase {
  type: "agent.completed";
  resultSummary: string;
  auditChainHashes: string[];
}

export interface AgentFailedEvent extends AgentEventBase {
  type: "agent.failed";
  reason: string;
  evidenceRefs: string[];
}

export interface AgentHeartbeatEvent extends AgentEventBase {
  type: "agent.heartbeat";
  tokensUsedSoFar: number;
  estimatedCostSoFar: number;
}

export type AgentEvent =
  | AgentStartedEvent
  | AgentThinkingEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentProposingEvent
  | AgentAwaitingSignatureEvent
  | AgentSignatureReceivedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentHeartbeatEvent;

export type AgentEventType = AgentEvent["type"];

// ---------------------------------------------------------------------------
// Sesiones (snapshot para GET /v1/openclaw/agents/state y panel AgentSwarmPanel)
// ---------------------------------------------------------------------------

export interface AgentSessionSnapshot {
  sessionId: string;
  agentRole: AgentRole;
  taskId: string;
  parentTaskId?: string;
  status: AgentSessionStatus;
  modelId: string;
  startedAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  lastEventType?: AgentEventType;
  failureReason?: string;
}
