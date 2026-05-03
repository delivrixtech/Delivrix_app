import { createId } from "./ids.ts";
import {
  buildOpenClawProvisioningDryRun,
  type OpenClawProvisioningDryRunInput,
  type OpenClawProvisioningDryRunPlan,
  type OpenClawProvisioningRisk,
  type OpenClawProvisioningRiskSeverity
} from "./openclaw-provisioning-dry-run.ts";

export type OpenClawLlmRouterMode = "disabled" | "mock";
export type OpenClawSchedulerDecisionStatus = "report_ready" | "needs_review" | "blocked";
export type OpenClawSchedulerTaskName =
  | "health-check"
  | "fleet-analysis"
  | "ip-reputation-check"
  | "daily-report";
export type OpenClawSkillName = "fleet-ops" | "alert-ops" | "report-ops";
export type OpenClawSkillStatus = "ok" | "needs_review" | "blocked";
export type OpenClawProposedActionPriority = "low" | "medium" | "high" | "critical";

export interface OpenClawSchedulerInput {
  actorId?: string;
  provisioningPlan?: OpenClawProvisioningDryRunPlan;
  provisioningInput?: OpenClawProvisioningDryRunInput;
  llmMode?: OpenClawLlmRouterMode;
}

export interface OpenClawLlmRouterDecision {
  mode: OpenClawLlmRouterMode;
  provider: "none" | "mock";
  model: "none" | "mock-openclaw-rules";
  degradedMode: boolean;
  promptBudgetUsedUsd: 0;
  reason: string;
  fallback: "deterministic_rule_based_skills";
}

export interface OpenClawSchedulerTask {
  name: OpenClawSchedulerTaskName;
  skill: OpenClawSkillName;
  cadence: "PT5M" | "PT15M" | "PT6H" | "P1D";
  due: true;
  dryRun: true;
  sideEffects: "none";
  nextRunAt: string;
  objective: string;
  reads: string[];
  writes: "audit_log_only";
  liveActionsEnabled: false;
}

export interface OpenClawProposedAction {
  code: string;
  label: string;
  priority: OpenClawProposedActionPriority;
  mode: "read_only" | "dry_run" | "supervised_required";
  requiresHumanApproval: boolean;
  targetType: "fleet" | "sender_node" | "risk" | "report" | "scheduler";
  targetId: string;
  reason: string;
}

export interface OpenClawSkillRun {
  name: OpenClawSkillName;
  status: OpenClawSkillStatus;
  summary: string;
  observations: string[];
  proposedActions: OpenClawProposedAction[];
  blockedActions: string[];
  requiredApprovals: string[];
}

export interface OpenClawDailyReport {
  title: "OpenClaw daily infrastructure report";
  generatedAt: string;
  mode: "observer";
  sourceProvisioningId: string | null;
  executiveSummary: string[];
  fleet: {
    clusterName: string | null;
    plannedSenderNodes: number;
    estimatedInitialDailyCapacity: number;
    provisioningDecision: OpenClawProvisioningDryRunPlan["decision"]["status"] | "missing";
  };
  alerts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    items: OpenClawProvisioningRisk[];
  };
  nextSteps: string[];
  humanReviewRequired: boolean;
}

export interface OpenClawSchedulerDecision {
  status: OpenClawSchedulerDecisionStatus;
  canExecuteLiveActions: false;
  riskLevel: OpenClawProvisioningRiskSeverity;
  reason: string;
  nextRecommendedMilestone: "complete_provisioning_dry_run" | "human_review" | "4.5_runbook_permissions_kill_switch";
}

export interface OpenClawSchedulerRun {
  id: string;
  createdAt: string;
  phase: "4.4-openclaw-scheduler-and-skills";
  actorId: string;
  dryRun: true;
  sideEffects: "none";
  sourceProvisioningId: string | null;
  llmRouter: OpenClawLlmRouterDecision;
  tasks: OpenClawSchedulerTask[];
  skills: OpenClawSkillRun[];
  dailyReport: OpenClawDailyReport;
  proposedActions: OpenClawProposedAction[];
  decision: OpenClawSchedulerDecision;
  gates: string[];
  requiredApprovals: string[];
  blockedActions: string[];
  safety: {
    schedulerEnabled: true;
    llmLiveCallsEnabled: false;
    actionExecutorLiveEnabled: false;
    liveInfrastructureWritesEnabled: false;
    proxmoxApiEnabled: false;
    sshEnabled: false;
    postfixLiveApplyEnabled: false;
    dnsLiveChangesEnabled: false;
    smtpEnabled: false;
    nfcWritesEnabled: false;
  };
}

const schedulerBlockedActions = [
  "openclaw-live-action-execute",
  "llm-autonomous-live-decision",
  "proxmox-live-create",
  "ssh-connect",
  "dns-live-change",
  "postfix-apply-live",
  "smtp-send",
  "increase-volume",
  "nfc-production-write"
];

const schedulerApprovals = [
  "operator_approval_before_any_live_action",
  "daily_report_review_before_execution",
  "risk_review_before_capacity_change",
  "kill_switch_review_before_phase_4_5"
];

export function runOpenClawScheduler(
  input: OpenClawSchedulerInput = {},
  now = new Date()
): OpenClawSchedulerRun {
  const provisioning = resolveProvisioningPlan(input, now);
  const actorId = input.actorId?.trim() || provisioning?.actorId || "operator_local";
  const llmRouter = buildLlmRouter(input.llmMode ?? "disabled");
  const tasks = buildSchedulerTasks(now);
  const fleetOps = runFleetOps(provisioning);
  const alertOps = runAlertOps(provisioning);
  const reportOps = runReportOps(provisioning);
  const skills = [fleetOps, alertOps, reportOps];
  const dailyReport = buildDailyReport(provisioning, now);
  const proposedActions = skills.flatMap((skill) => skill.proposedActions);
  const decision = buildDecision(provisioning, skills);
  const blockedActions = unique([
    ...schedulerBlockedActions,
    ...(provisioning?.blockedActions ?? [])
  ]);
  const requiredApprovals = unique([
    ...schedulerApprovals,
    ...(provisioning?.requiredApprovals ?? [])
  ]);

  return {
    id: createId("openclaw_scheduler"),
    createdAt: now.toISOString(),
    phase: "4.4-openclaw-scheduler-and-skills",
    actorId,
    dryRun: true,
    sideEffects: "none",
    sourceProvisioningId: provisioning?.id ?? null,
    llmRouter,
    tasks,
    skills,
    dailyReport,
    proposedActions,
    decision,
    gates: [
      "scheduler_runs_as_observer_first",
      "skills_may_only_read_report_and_propose",
      "llm_router_must_have_no_llm_fallback",
      "daily_report_before_live_execution",
      "human_approval_before_any_live_action",
      "kill_switch_required_before_limited_execution",
      "no_external_bridge_dependency"
    ],
    requiredApprovals,
    blockedActions,
    safety: {
      schedulerEnabled: true,
      llmLiveCallsEnabled: false,
      actionExecutorLiveEnabled: false,
      liveInfrastructureWritesEnabled: false,
      proxmoxApiEnabled: false,
      sshEnabled: false,
      postfixLiveApplyEnabled: false,
      dnsLiveChangesEnabled: false,
      smtpEnabled: false,
      nfcWritesEnabled: false
    }
  };
}

function resolveProvisioningPlan(
  input: OpenClawSchedulerInput,
  now: Date
): OpenClawProvisioningDryRunPlan | null {
  if (input.provisioningPlan) {
    return input.provisioningPlan;
  }

  if (input.provisioningInput) {
    return buildOpenClawProvisioningDryRun({
      ...input.provisioningInput,
      actorId: input.actorId ?? input.provisioningInput.actorId
    }, now);
  }

  return null;
}

function buildLlmRouter(mode: OpenClawLlmRouterMode): OpenClawLlmRouterDecision {
  if (mode === "mock") {
    return {
      mode,
      provider: "mock",
      model: "mock-openclaw-rules",
      degradedMode: true,
      promptBudgetUsedUsd: 0,
      reason: "Mock LLM mode is enabled only for local contract testing. No external model is called.",
      fallback: "deterministic_rule_based_skills"
    };
  }

  return {
    mode: "disabled",
    provider: "none",
    model: "none",
    degradedMode: true,
    promptBudgetUsedUsd: 0,
    reason: "LLM calls are disabled for Hito 4.4. OpenClaw uses deterministic rule-based skills.",
    fallback: "deterministic_rule_based_skills"
  };
}

function buildSchedulerTasks(now: Date): OpenClawSchedulerTask[] {
  return [
    task("health-check", "alert-ops", "PT5M", addMs(now, 5 * 60 * 1000), "Watch kill switch, queue health, node states and blocked live actions.", [
      "kill_switch",
      "sender_node_registry",
      "audit_log"
    ]),
    task("fleet-analysis", "fleet-ops", "PT15M", addMs(now, 15 * 60 * 1000), "Analyze provisioning dry-run, planned sender nodes and fleet capacity.", [
      "provisioning_dry_run",
      "topology_summary",
      "sender_node_registry"
    ]),
    task("ip-reputation-check", "alert-ops", "PT6H", addMs(now, 6 * 60 * 60 * 1000), "Review IP reputation readiness, PTR gates, warming and blacklist risk signals.", [
      "ip_reputation_reports",
      "provisioning_risks",
      "warming_plan"
    ]),
    task("daily-report", "report-ops", "P1D", addMs(now, 24 * 60 * 60 * 1000), "Generate the daily infrastructure report for human review.", [
      "fleet_ops",
      "alert_ops",
      "audit_log"
    ])
  ];
}

function task(
  name: OpenClawSchedulerTaskName,
  skill: OpenClawSkillName,
  cadence: OpenClawSchedulerTask["cadence"],
  nextRunAt: Date,
  objective: string,
  reads: string[]
): OpenClawSchedulerTask {
  return {
    name,
    skill,
    cadence,
    due: true,
    dryRun: true,
    sideEffects: "none",
    nextRunAt: nextRunAt.toISOString(),
    objective,
    reads,
    writes: "audit_log_only",
    liveActionsEnabled: false
  };
}

function runFleetOps(provisioning: OpenClawProvisioningDryRunPlan | null): OpenClawSkillRun {
  if (!provisioning) {
    return {
      name: "fleet-ops",
      status: "blocked",
      summary: "Fleet analysis is blocked because no provisioning dry-run was provided.",
      observations: [
        "OpenClaw needs onboarding, topology planning and provisioning dry-run before fleet scheduling can be trusted.",
        "No live fleet action was attempted."
      ],
      proposedActions: [
        proposedAction("complete-provisioning-dry-run", "Complete provisioning dry-run before scheduler operations.", "high", "dry_run", false, "scheduler", "openclaw", "Fleet ops needs a dry-run source of truth.")
      ],
      blockedActions: schedulerBlockedActions,
      requiredApprovals: schedulerApprovals
    };
  }

  const status: OpenClawSkillStatus = provisioning.decision.status === "blocked"
    ? "blocked"
    : provisioning.decision.status === "needs_review" ? "needs_review" : "ok";

  return {
    name: "fleet-ops",
    status,
    summary: `Fleet dry-run has ${provisioning.summary.nodesPlanned} planned sender nodes and ${provisioning.summary.dnsRecordsPlanned} DNS records.`,
    observations: [
      `Cluster ${provisioning.topology.clusterName} remains in dry-run mode.`,
      `Estimated initial daily capacity is ${provisioning.topology.estimatedInitialDailyCapacity}, conditional on warming and reputation gates.`,
      "SMTP delivery, SSH and Proxmox API mutations remain disabled."
    ],
    proposedActions: [
      proposedAction("review-fleet-dry-run", "Review planned sender nodes before inventory registration.", "medium", "read_only", false, "fleet", provisioning.id, "Fleet topology should be reviewed before any supervised execution."),
      proposedAction("prepare-inventory-registration-dry-run", "Prepare local sender-node registry payloads in dry-run.", "low", "dry_run", false, "fleet", provisioning.id, "Inventory payloads can be prepared without touching infrastructure.")
    ],
    blockedActions: provisioning.blockedActions,
    requiredApprovals: provisioning.requiredApprovals
  };
}

function runAlertOps(provisioning: OpenClawProvisioningDryRunPlan | null): OpenClawSkillRun {
  if (!provisioning) {
    return {
      name: "alert-ops",
      status: "blocked",
      summary: "Alert analysis is blocked until a provisioning dry-run exists.",
      observations: [
        "Missing provisioning dry-run is the current highest operational alert.",
        "OpenClaw cannot infer server, IP, DNS or warming readiness without the prior gates."
      ],
      proposedActions: [
        proposedAction("raise-prerequisite-alert", "Raise prerequisite alert for missing provisioning dry-run.", "high", "read_only", false, "risk", "missing-provisioning-dry-run", "The scheduler must not operate from guesses.")
      ],
      blockedActions: schedulerBlockedActions,
      requiredApprovals: schedulerApprovals
    };
  }

  const highestRisk = highestRiskLevel(provisioning.risks);
  const status: OpenClawSkillStatus = provisioning.decision.status === "blocked"
    ? "blocked"
    : highestRisk === "critical" || highestRisk === "high" || provisioning.decision.status === "needs_review"
      ? "needs_review"
      : "ok";

  const urgentRisks = provisioning.risks.filter((risk) => risk.severity === "critical" || risk.severity === "high");

  return {
    name: "alert-ops",
    status,
    summary: `Alert scan found ${provisioning.risks.length} provisioning risks; highest level is ${highestRisk}.`,
    observations: provisioning.risks.length > 0
      ? provisioning.risks.slice(0, 5).map((risk) => `${risk.severity}: ${risk.code} - ${risk.message}`)
      : ["No provisioning risks were reported by the dry-run."],
    proposedActions: urgentRisks.length > 0
      ? urgentRisks.map((risk) => proposedAction(`review-risk-${risk.code}`, `Review risk ${risk.code}.`, risk.severity, "supervised_required", true, "risk", risk.code, risk.recommendation))
      : [
        proposedAction("continue-observer-mode", "Continue observer mode and keep SMTP disabled.", "low", "read_only", false, "scheduler", provisioning.id, "No urgent risk requires escalation, but Hito 4.4 is still observer-first.")
      ],
    blockedActions: provisioning.blockedActions,
    requiredApprovals: provisioning.requiredApprovals
  };
}

function runReportOps(provisioning: OpenClawProvisioningDryRunPlan | null): OpenClawSkillRun {
  const status: OpenClawSkillStatus = !provisioning
    ? "blocked"
    : provisioning.decision.status === "dry_run_ready" ? "ok" : "needs_review";

  return {
    name: "report-ops",
    status,
    summary: provisioning
      ? "Daily infrastructure report is ready for operator review."
      : "Daily report is generated with missing provisioning prerequisites.",
    observations: provisioning
      ? [
        `Provisioning decision is ${provisioning.decision.status}.`,
        `Report includes ${provisioning.summary.nodesPlanned} planned nodes and ${provisioning.risks.length} risks.`
      ]
      : [
        "Report marks the scheduler as blocked until provisioning dry-run exists."
      ],
    proposedActions: [
      proposedAction("send-daily-report-to-operator", "Present daily report to the operator.", "low", "read_only", false, "report", provisioning?.id ?? "missing-provisioning-dry-run", "Hito 4.4 requires report-first operations.")
    ],
    blockedActions: provisioning?.blockedActions ?? schedulerBlockedActions,
    requiredApprovals: provisioning?.requiredApprovals ?? schedulerApprovals
  };
}

function buildDailyReport(
  provisioning: OpenClawProvisioningDryRunPlan | null,
  now: Date
): OpenClawDailyReport {
  const riskCounts = countRisks(provisioning?.risks ?? []);
  const humanReviewRequired = !provisioning
    || provisioning.decision.status !== "dry_run_ready"
    || riskCounts.critical > 0
    || riskCounts.high > 0;

  return {
    title: "OpenClaw daily infrastructure report",
    generatedAt: now.toISOString(),
    mode: "observer",
    sourceProvisioningId: provisioning?.id ?? null,
    executiveSummary: provisioning
      ? [
        `Provisioning dry-run status: ${provisioning.decision.status}.`,
        `Planned sender nodes: ${provisioning.summary.nodesPlanned}.`,
        "No live infrastructure, DNS, SMTP, SSH or NFC action was executed."
      ]
      : [
        "Scheduler run is blocked because no provisioning dry-run source was provided.",
        "No live infrastructure, DNS, SMTP, SSH or NFC action was executed."
      ],
    fleet: {
      clusterName: provisioning?.topology.clusterName ?? null,
      plannedSenderNodes: provisioning?.summary.nodesPlanned ?? 0,
      estimatedInitialDailyCapacity: provisioning?.topology.estimatedInitialDailyCapacity ?? 0,
      provisioningDecision: provisioning?.decision.status ?? "missing"
    },
    alerts: {
      ...riskCounts,
      items: provisioning?.risks ?? []
    },
    nextSteps: humanReviewRequired
      ? [
        "Review missing prerequisites or high-risk findings with a human operator.",
        "Keep OpenClaw in observer mode.",
        "Do not execute live infrastructure actions."
      ]
      : [
        "Review the daily report.",
        "Prepare Hito 4.5 runbook, permissions matrix and kill switch proof.",
        "Keep all live actions disabled until explicit approval gates exist."
      ],
    humanReviewRequired
  };
}

function buildDecision(
  provisioning: OpenClawProvisioningDryRunPlan | null,
  skills: OpenClawSkillRun[]
): OpenClawSchedulerDecision {
  const highestRisk = provisioning ? highestRiskLevel(provisioning.risks) : "high";

  if (!provisioning || skills.some((skill) => skill.status === "blocked")) {
    return {
      status: "blocked",
      canExecuteLiveActions: false,
      riskLevel: highestRisk,
      reason: "Scheduler generated an observer report, but it is blocked until provisioning dry-run prerequisites exist.",
      nextRecommendedMilestone: "complete_provisioning_dry_run"
    };
  }

  if (
    provisioning.decision.status !== "dry_run_ready"
    || highestRisk === "critical"
    || highestRisk === "high"
    || skills.some((skill) => skill.status === "needs_review")
  ) {
    return {
      status: "needs_review",
      canExecuteLiveActions: false,
      riskLevel: highestRisk,
      reason: "Scheduler completed the observer cycle, but human review is required before moving forward.",
      nextRecommendedMilestone: "human_review"
    };
  }

  return {
    status: "report_ready",
    canExecuteLiveActions: false,
    riskLevel: highestRisk,
    reason: "Scheduler completed the observer cycle and produced a daily report. Live execution remains disabled.",
    nextRecommendedMilestone: "4.5_runbook_permissions_kill_switch"
  };
}

function proposedAction(
  code: string,
  label: string,
  priority: OpenClawProposedActionPriority,
  mode: OpenClawProposedAction["mode"],
  requiresHumanApproval: boolean,
  targetType: OpenClawProposedAction["targetType"],
  targetId: string,
  reason: string
): OpenClawProposedAction {
  return {
    code,
    label,
    priority,
    mode,
    requiresHumanApproval,
    targetType,
    targetId,
    reason
  };
}

function countRisks(risks: OpenClawProvisioningRisk[]): OpenClawDailyReport["alerts"] {
  return {
    critical: risks.filter((risk) => risk.severity === "critical").length,
    high: risks.filter((risk) => risk.severity === "high").length,
    medium: risks.filter((risk) => risk.severity === "medium").length,
    low: risks.filter((risk) => risk.severity === "low").length,
    items: risks
  };
}

function highestRiskLevel(risks: OpenClawProvisioningRisk[]): OpenClawProvisioningRiskSeverity {
  if (risks.some((item) => item.severity === "critical")) {
    return "critical";
  }

  if (risks.some((item) => item.severity === "high")) {
    return "high";
  }

  if (risks.some((item) => item.severity === "medium")) {
    return "medium";
  }

  return "low";
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
