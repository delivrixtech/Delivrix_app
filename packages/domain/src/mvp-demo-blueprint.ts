import { createId } from "./ids.ts";
import { defaultKillSwitchState, type KillSwitchState } from "./kill-switch.ts";
import { buildOpenClawOperationalRunbook, type OpenClawOperationalRunbook } from "./openclaw-runbook.ts";
import {
  buildOpenClawProvisioningDryRun,
  type OpenClawProvisioningDryRunPlan
} from "./openclaw-provisioning-dry-run.ts";
import { runOpenClawScheduler, type OpenClawSchedulerRun } from "./openclaw-scheduler.ts";
import {
  buildOpenClawTopologyPlan,
  type OpenClawTopologyPlan
} from "./openclaw-topology-planner.ts";
import type { OpenClawOnboardingInput, OpenClawOnboardingSnapshot } from "./openclaw-onboarding.ts";
import { evaluateOpenClawOnboarding } from "./openclaw-onboarding.ts";
import type { SendRequest, SendResultStatus, SenderNode } from "./types.ts";

export type MvpDemoDecisionStatus = "ready_for_demo" | "needs_review" | "blocked";
export type MvpDemoPatternStatus = "strong" | "needs_reinforcement" | "blocked";
export type MvpDemoStepStatus = "ready" | "needs_review" | "blocked";

export interface DelivrixMvpDemoBlueprintInput {
  actorId?: string;
  onboarding?: OpenClawOnboardingInput;
  request?: SendRequest;
  senderNode?: SenderNode;
  simulatedResultStatus?: SendResultStatus;
  killSwitch?: KillSwitchState;
}

export interface MvpDemoComponentStep {
  order: number;
  component: string;
  responsibility: string;
  input: string;
  output: string;
  status: MvpDemoStepStatus;
  auditAction: string;
  sideEffects: "none" | "local-state-only";
}

export interface MvpDemoPipelineBlueprint {
  mode: "dry_run_control";
  route: "Gateway -> Policy -> Queue -> Worker -> Sender Node -> Result Tracking -> Reputation -> Admin/OpenClaw";
  sendRequest: SendRequest;
  senderNode: SenderNode;
  expectedResult: {
    status: SendResultStatus;
    smtpEnabled: false;
    reason: string;
  };
  steps: MvpDemoComponentStep[];
}

export interface MvpDemoPatternReviewItem {
  pattern: string;
  status: MvpDemoPatternStatus;
  evidence: string;
  reinforcement: string;
}

export interface MvpDemoIntelligenceLoop {
  observe: string[];
  decide: string[];
  propose: string[];
  approve: string[];
  act: string[];
  verify: string[];
  stop: string[];
}

export interface MvpDemoDecision {
  status: MvpDemoDecisionStatus;
  canRunDemo: boolean;
  canSendRealEmail: false;
  canMutateLiveInfrastructure: false;
  reason: string;
  blockers: string[];
  warnings: string[];
  nextRecommendedMilestone: "5.1_demo_runner" | "review_openclaw_inputs" | "remain_in_phase_5_0";
}

export interface DelivrixMvpDemoBlueprint {
  id: string;
  createdAt: string;
  phase: "5.0-mvp-demo-blueprint-pattern-review";
  actorId: string;
  dryRun: true;
  sideEffects: "none";
  objective: "Demonstrate Delivrix governing prepared mailing capacity without real sending.";
  openClaw: {
    onboarding: OpenClawOnboardingSnapshot;
    topology: OpenClawTopologyPlan;
    provisioning: OpenClawProvisioningDryRunPlan;
    scheduler: OpenClawSchedulerRun;
    runbook: OpenClawOperationalRunbook;
  };
  pipeline: MvpDemoPipelineBlueprint;
  patternReview: MvpDemoPatternReviewItem[];
  intelligenceLoop: MvpDemoIntelligenceLoop;
  demoScript: MvpDemoComponentStep[];
  decision: MvpDemoDecision;
  gates: string[];
  safety: {
    liveEmailSendingEnabled: false;
    liveInfrastructureWritesEnabled: false;
    liveDnsChangesEnabled: false;
    sshEnabled: false;
    nfcProductionWritesEnabled: false;
    llmAutonomousExecutionEnabled: false;
    localStateOnlyForPipelineDemo: true;
    auditRequired: true;
    killSwitchRequired: true;
  };
}

export function buildDelivrixMvpDemoBlueprint(
  input: DelivrixMvpDemoBlueprintInput = {},
  now = new Date()
): DelivrixMvpDemoBlueprint {
  const actorId = input.actorId?.trim() || input.onboarding?.actorId?.trim() || "operator_local";
  const onboardingInput = {
    ...defaultOnboardingInput(),
    ...input.onboarding,
    actorId
  };
  const onboarding = evaluateOpenClawOnboarding(onboardingInput, now);
  const topology = buildOpenClawTopologyPlan({
    actorId,
    clusterName: "delivrix-demo-cluster",
    strategy: "conservative",
    onboarding: onboardingInput
  }, now);
  const provisioning = buildOpenClawProvisioningDryRun({
    actorId,
    topologyPlan: topology
  }, now);
  const scheduler = runOpenClawScheduler({
    actorId,
    provisioningPlan: provisioning
  }, now);
  const runbook = buildOpenClawOperationalRunbook({
    actorId,
    schedulerRun: scheduler,
    killSwitch: input.killSwitch ?? defaultKillSwitchState(now)
  }, now);
  const pipeline = buildPipelineBlueprint(input, topology);
  const patternReview = buildPatternReview(onboarding, topology, provisioning, scheduler, runbook);
  const demoScript = buildDemoScript(pipeline);
  const decision = buildDecision(onboarding, topology, provisioning, scheduler, runbook, patternReview);

  return {
    id: createId("mvp_demo"),
    createdAt: now.toISOString(),
    phase: "5.0-mvp-demo-blueprint-pattern-review",
    actorId,
    dryRun: true,
    sideEffects: "none",
    objective: "Demonstrate Delivrix governing prepared mailing capacity without real sending.",
    openClaw: {
      onboarding,
      topology,
      provisioning,
      scheduler,
      runbook
    },
    pipeline,
    patternReview,
    intelligenceLoop: buildIntelligenceLoop(),
    demoScript,
    decision,
    gates: [
      "demo_must_be_end_to_end_but_dry_run",
      "gateway_policy_before_queue",
      "queue_before_worker",
      "worker_must_simulate_result_not_send_email",
      "sender_node_must_be_local_or_mock",
      "result_tracking_before_reputation_review",
      "openclaw_report_before_demo_claim",
      "runbook_and_kill_switch_before_any_supervised_action",
      "no_nfc_dependency_for_demo"
    ],
    safety: {
      liveEmailSendingEnabled: false,
      liveInfrastructureWritesEnabled: false,
      liveDnsChangesEnabled: false,
      sshEnabled: false,
      nfcProductionWritesEnabled: false,
      llmAutonomousExecutionEnabled: false,
      localStateOnlyForPipelineDemo: true,
      auditRequired: true,
      killSwitchRequired: true
    }
  };
}

function buildPipelineBlueprint(
  input: DelivrixMvpDemoBlueprintInput,
  topology: OpenClawTopologyPlan
): MvpDemoPipelineBlueprint {
  const senderNode = input.senderNode ?? defaultSenderNode(topology);
  const status = input.simulatedResultStatus ?? "sent";

  return {
    mode: "dry_run_control",
    route: "Gateway -> Policy -> Queue -> Worker -> Sender Node -> Result Tracking -> Reputation -> Admin/OpenClaw",
    sendRequest: input.request ?? defaultSendRequest(status),
    senderNode,
    expectedResult: {
      status,
      smtpEnabled: false,
      reason: "Worker records a simulated result. Delivrix does not send real email in the MVP demo."
    },
    steps: [
      step(1, "Gateway API", "Validate request, kill switch and mail policy.", "SendRequest", "queued job or rejection", "ready", "send_request.accepted", "local-state-only"),
      step(2, "Queue", "Persist the job in local queue for worker processing.", "policy-approved request", "queued SendJob", "ready", "send_job.queued", "local-state-only"),
      step(3, "Worker", "Claim job, select sender node and enforce rate limits.", "queued SendJob", "processing SendJob", "ready", "send_job.claimed", "local-state-only"),
      step(4, "Sender Node Registry", "Select active or warming sender node without opening SMTP.", "SendRequest", "senderNodeId", "ready", "send_job.sender_node_assigned", "local-state-only"),
      step(5, "Result Tracking", "Record simulated delivery outcome.", "processing SendJob", "SendResult", "ready", "send_result.simulated", "local-state-only"),
      step(6, "Reputation", "Evaluate bounces, complaints, deferred and blacklist signals.", "SendResult", "health/reputation decision", "ready", "sender_node_health.evaluated", "none"),
      step(7, "Admin/OpenClaw", "Summarize operation and propose next action.", "audit + jobs + results + nodes", "demo report", "ready", "demo.report_generated", "none")
    ]
  };
}

function buildPatternReview(
  onboarding: OpenClawOnboardingSnapshot,
  topology: OpenClawTopologyPlan,
  provisioning: OpenClawProvisioningDryRunPlan,
  scheduler: OpenClawSchedulerRun,
  runbook: OpenClawOperationalRunbook
): MvpDemoPatternReviewItem[] {
  return [
    {
      pattern: "domain-first orchestration",
      status: topology.decision.status === "blocked" ? "blocked" : "strong",
      evidence: "Onboarding, topology, provisioning, scheduler and runbook are generated in domain modules before Gateway exposure.",
      reinforcement: "Keep orchestration rules in packages/domain and let Gateway only parse, audit and return responses."
    },
    {
      pattern: "dry-run before side effects",
      status: provisioning.dryRun && scheduler.dryRun && runbook.dryRun ? "strong" : "blocked",
      evidence: "OpenClaw artifacts report dryRun=true and sideEffects=none.",
      reinforcement: "Any future adapter must preserve dry-run contracts before enabling live mutations."
    },
    {
      pattern: "explicit gates and kill switch",
      status: runbook.killSwitchProof.blocksQueueProcessing ? "strong" : "blocked",
      evidence: "Runbook proves kill switch blocks queue processing and OpenClaw actions.",
      reinforcement: "Keep kill switch evaluation at Gateway, Worker and OpenClaw action boundaries."
    },
    {
      pattern: "human-in-the-loop autonomy",
      status: runbook.decision.status === "ready_for_phase_5_demo" ? "strong" : "needs_reinforcement",
      evidence: `Runbook decision is ${runbook.decision.status}; live execution remains disabled.`,
      reinforcement: "OpenClaw may propose. Operators approve supervised local state changes."
    },
    {
      pattern: "observability and auditability",
      status: "strong",
      evidence: "Demo route includes audit actions for policy, queue, worker, result tracking and OpenClaw reporting.",
      reinforcement: "Phase 5.1 should store a single demo report that links all generated ids."
    },
    {
      pattern: "external bridge isolation",
      status: "strong",
      evidence: "NFC remains future optional, disabled or mock, and outside the demo critical path.",
      reinforcement: "Do not add NFC write dependencies to the MVP demo."
    },
    {
      pattern: "input completeness over guessing",
      status: onboarding.decision.status === "no_go" ? "blocked" : "strong",
      evidence: `Onboarding decision is ${onboarding.decision.status}.`,
      reinforcement: "If required server/IP/DNS/compliance data is missing, the demo must show a blocked explanation instead of inventing capacity."
    }
  ];
}

function buildDemoScript(pipeline: MvpDemoPipelineBlueprint): MvpDemoComponentStep[] {
  return pipeline.steps.map((item) => ({ ...item }));
}

function buildIntelligenceLoop(): MvpDemoIntelligenceLoop {
  return {
    observe: [
      "Read onboarding, topology, provisioning, scheduler, runbook and local operational summary.",
      "Inspect queue, sender node state, simulated results, bounces, complaints and kill switch."
    ],
    decide: [
      "Classify the demo state as ready, needs_review or blocked.",
      "Keep capacity estimates conditional on warming and reputation gates."
    ],
    propose: [
      "Recommend local supervised actions only when gates pass.",
      "Recommend review or stop when risk is high, critical or data is missing."
    ],
    approve: [
      "Require operator approval for supervised local state changes.",
      "Require a future phase for live infrastructure, DNS, SSH, SMTP or NFC writes."
    ],
    act: [
      "In Phase 5.0, act only by producing a blueprint.",
      "In Phase 5.1, execute only local-state demo actions."
    ],
    verify: [
      "Verify audit events, queue status, simulated results, reputation and admin summary.",
      "Verify OpenClaw report and runbook decision."
    ],
    stop: [
      "Kill switch blocks queue processing and supervised/live actions.",
      "Reputation gates block volume increases and IP rotation."
    ]
  };
}

function buildDecision(
  onboarding: OpenClawOnboardingSnapshot,
  topology: OpenClawTopologyPlan,
  provisioning: OpenClawProvisioningDryRunPlan,
  scheduler: OpenClawSchedulerRun,
  runbook: OpenClawOperationalRunbook,
  patternReview: MvpDemoPatternReviewItem[]
): MvpDemoDecision {
  const blockers = [
    onboarding.decision.status === "no_go" ? "onboarding_no_go" : null,
    topology.decision.status === "blocked" ? "topology_blocked" : null,
    provisioning.decision.status === "blocked" ? "provisioning_blocked" : null,
    scheduler.decision.status === "blocked" ? "scheduler_blocked" : null,
    runbook.decision.status === "blocked" ? "runbook_blocked" : null,
    patternReview.some((item) => item.status === "blocked") ? "pattern_review_blocked" : null
  ].filter((item): item is string => item !== null);
  const warnings = [
    onboarding.decision.status === "needs_review" ? "onboarding_needs_review" : null,
    topology.decision.status === "needs_review" ? "topology_needs_review" : null,
    provisioning.decision.status === "needs_review" ? "provisioning_needs_review" : null,
    scheduler.decision.status === "needs_review" ? "scheduler_needs_review" : null,
    runbook.decision.status === "needs_review" ? "runbook_needs_review" : null,
    patternReview.some((item) => item.status === "needs_reinforcement") ? "pattern_review_needs_reinforcement" : null
  ].filter((item): item is string => item !== null);

  if (blockers.length > 0) {
    return {
      status: "blocked",
      canRunDemo: false,
      canSendRealEmail: false,
      canMutateLiveInfrastructure: false,
      reason: "MVP demo blueprint is blocked until prerequisite gates pass.",
      blockers,
      warnings,
      nextRecommendedMilestone: "remain_in_phase_5_0"
    };
  }

  if (warnings.length > 0) {
    return {
      status: "needs_review",
      canRunDemo: false,
      canSendRealEmail: false,
      canMutateLiveInfrastructure: false,
      reason: "MVP demo blueprint is coherent, but human review is required before running the demo.",
      blockers,
      warnings,
      nextRecommendedMilestone: "review_openclaw_inputs"
    };
  }

  return {
    status: "ready_for_demo",
    canRunDemo: true,
    canSendRealEmail: false,
    canMutateLiveInfrastructure: false,
    reason: "MVP demo blueprint is ready. The next milestone can execute the local-state demo runner.",
    blockers,
    warnings,
    nextRecommendedMilestone: "5.1_demo_runner"
  };
}

function step(
  order: number,
  component: string,
  responsibility: string,
  input: string,
  output: string,
  status: MvpDemoStepStatus,
  auditAction: string,
  sideEffects: MvpDemoComponentStep["sideEffects"]
): MvpDemoComponentStep {
  return {
    order,
    component,
    responsibility,
    input,
    output,
    status,
    auditAction,
    sideEffects
  };
}

function defaultSenderNode(topology: OpenClawTopologyPlan): SenderNode {
  const node = topology.clusters[0]?.nodes[0];

  return {
    id: "sender_demo_001",
    label: "Delivrix Demo Sender 001",
    provider: "manual",
    status: "warming",
    ipAddress: "203.0.113.10",
    hostname: node?.network.hostname ?? "mx001.delivrix.example",
    dailyLimit: node?.limits.dailyLimit ?? 50,
    warmupDay: 1
  };
}

function defaultSendRequest(status: SendResultStatus): SendRequest {
  return {
    id: "demo_send_request_001",
    campaignId: "demo-authorized-mailing",
    recipient: {
      email: status === "sent" ? "demo.recipient@example.com" : `demo.${status}@example.com`,
      consentProofId: "consent-demo-001"
    },
    sender: {
      address: "ops@delivrix.example",
      domain: "delivrix.example",
      dkimDomain: "delivrix.example"
    },
    subject: "Delivrix authorized demo",
    bodyText: "This is a simulated Delivrix MVP demo message. No real email is sent.",
    classification: "commercial",
    unsubscribeUrl: "https://delivrix.example/unsubscribe/demo",
    physicalAddress: "Delivrix LLC - demo physical address",
    metadata: {
      demo: true,
      simulatedResult: status,
      smtpEnabled: false
    }
  };
}

function defaultOnboardingInput(): OpenClawOnboardingInput {
  return {
    actorId: "operator_local",
    server: {
      model: "IBM System x3630 M4",
      location: "Popayan",
      cpuCores: 24,
      ramGb: 128,
      storage: {
        type: "ssd",
        usableGb: 2000,
        redundant: true
      },
      network: {
        provider: "business-isp",
        uplinkMbps: 500,
        staticIp: true
      },
      upsReady: true,
      coolingMonitored: true
    },
    proxmox: {
      status: "installed",
      version: "8.x",
      apiReachable: true
    },
    ipPool: {
      totalIps: 32,
      type: "leased",
      cidrs: ["203.0.113.0/27"],
      providerApproval: true,
      reputationChecked: true,
      ptrDelegation: true
    },
    domains: [
      {
        domain: "delivrix.example",
        dnsProvider: "route53",
        ownershipVerified: true,
        spfReady: true,
        dkimReady: true,
        dmarcReady: true,
        ptrPlanReady: true
      }
    ],
    dns: {
      provider: "route53",
      apiAccess: true,
      canManageSpfDkimDmarc: true,
      canManagePtr: true
    },
    compliance: {
      physicalAddressReady: true,
      optOutReady: true,
      suppressionListReady: true,
      consentProofAvailable: true,
      trafficAuthorizedByProvider: true
    },
    limits: {
      targetDailyVolume: 150,
      initialSenderNodes: 3,
      maxSenderNodes: 30,
      dailyLimitPerNode: 50,
      warmupDays: 21
    },
    security: {
      secretsManagerReady: true,
      sshKeyPolicyReady: true,
      auditLogRequired: true,
      killSwitchRequired: true
    },
    autonomy: {
      mode: "supervised",
      humanApprovalRequired: true
    }
  };
}
