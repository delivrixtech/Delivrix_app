import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ProxmoxAdapter,
  WebdockAdapter,
  type ProxmoxMockNodeConfig,
  type WebdockBridgeNodeConfig
} from "../../../packages/adapters/src/index.ts";
import {
  MailPolicyEngine,
  RateLimitService,
  SenderNodeRegistry,
  buildAdminOverview,
  buildAdminClusterOverview,
  buildAdminPanelWorkflow,
  buildBackupPlan,
  buildOperationalSummary,
  buildDelivrixMvpDemoRunReport,
  createId,
  buildOpenClawIncidentDemoReport,
  buildOpenClawLearningPlan,
  buildMvpFinalDemoReport,
  evaluateSenderNodeHealth,
  evaluateIpReputation,
  evaluateKillSwitch,
  evaluateSenderNodeManualControl,
  evaluateSenderNodeRetirementApproval,
  evaluateSendResultIngestion,
  evaluateOpenClawOnboarding,
  isSenderNodeManualAction,
  buildDelivrixMvpDemoBlueprint,
  buildNfcBridgeCapacityPlan,
  buildOpenClawOperationalRunbook,
  buildOpenClawProvisioningDryRun,
  runOpenClawScheduler,
  buildOpenClawTopologyPlan,
  getOpenClawOnboardingQuestionnaire,
  getOperatingNorthSnapshot,
  requestRateLimitRules,
  senderNodeRateLimitRule,
  simulateBackup,
  simulateSendResult,
  type BackupPlanInput,
  type BackupResource,
  type BackupResourceSnapshot,
  type IpReputationExternalSignal,
  type DelivrixMvpDemoBlueprintInput,
  type OpenClawOnboardingInput,
  type OpenClawProvisioningDryRunInput,
  type OpenClawRunbookInput,
  type OpenClawSchedulerInput,
  type OpenClawTopologyPlannerInput,
  type RegisterSenderNodeInput,
  type SuppressionReason,
  type SendRequest,
  type SenderNodeManualAction,
  type SendResultStatus,
  type StuckJobRecoveryAction
} from "../../../packages/domain/src/index.ts";
import {
  LocalFileAuditLog,
  LocalFileBackupSimulationStore,
  LocalFileIpReputationReportStore,
  LocalFileKillSwitchStore,
  LocalFileProvisioningRunStore,
  LocalFileRateLimitStore,
  LocalFileSendResultStore,
  LocalFileSenderNodeStore,
  LocalFileSuppressionList
} from "../../../packages/local-store/src/index.ts";
import { LocalFileSendQueue } from "../../../packages/queue/src/index.ts";

const port = Number(process.env.GATEWAY_PORT ?? 3000);
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";

const auditLog = new LocalFileAuditLog();
const killSwitchStore = new LocalFileKillSwitchStore();
const sendResultStore = new LocalFileSendResultStore();
const suppressionList = new LocalFileSuppressionList();
const sendQueue = new LocalFileSendQueue();
const policyEngine = new MailPolicyEngine(suppressionList);
const senderNodeRegistry = new SenderNodeRegistry(new LocalFileSenderNodeStore());
const rateLimitStore = new LocalFileRateLimitStore();
const rateLimitService = new RateLimitService(rateLimitStore);
const webdockAdapter = new WebdockAdapter();
const proxmoxAdapter = new ProxmoxAdapter();
const provisioningRunStore = new LocalFileProvisioningRunStore();
const ipReputationReportStore = new LocalFileIpReputationReportStore();
const backupSimulationStore = new LocalFileBackupSimulationStore();
const defaultStuckJobThresholdMs = Number(process.env.STUCK_JOB_THRESHOLD_MS ?? 5 * 60 * 1000);
const requestRateLimitProfile = {
  campaignDailyLimit: Number(process.env.RATE_LIMIT_CAMPAIGN_DAILY ?? 100),
  senderDomainDailyLimit: Number(process.env.RATE_LIMIT_SENDER_DOMAIN_DAILY ?? 300),
  recipientDomainDailyLimit: Number(process.env.RATE_LIMIT_RECIPIENT_DOMAIN_DAILY ?? 100)
};

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      const killSwitch = await killSwitchStore.get();
      const operatingNorth = getOperatingNorthSnapshot();

      return json(response, 200, {
        status: "ok",
        service: "gateway-api",
        role: "delivrix-control-plane",
        queue: "local-file",
        auditLog: "local-file",
        suppressionList: "local-file",
        senderNodes: "local-file",
        rateLimits: "local-file",
        provisioningRuns: "local-file",
        ipReputationReports: "local-file",
        backupSimulations: "local-file",
        killSwitch: {
          enabled: killSwitch.enabled,
          updatedAt: killSwitch.updatedAt,
          updatedBy: killSwitch.updatedBy
        },
        operatingNorth: {
          sourceOfTruth: operatingNorth.sourceOfTruth,
          delivrixSendsRealEmail: operatingNorth.delivrixSendsRealEmail,
          nfcSendsRealEmail: operatingNorth.nfcSendsRealEmail,
          nfcProductionWritesEnabled: operatingNorth.nfcProductionWritesEnabled,
          liveInfrastructureWritesEnabled: operatingNorth.liveInfrastructureWritesEnabled
        },
        openClaw: {
          currentMilestone: "5.4C-admin-cluster-learning-contracts",
          adminClusterOverviewEnabled: true,
          learningPlanEnabled: true,
          onboardingEnabled: true,
          topologyPlannerEnabled: true,
          provisioningDryRunEnabled: true,
          schedulerEnabled: true,
          runbookEnabled: true,
          demoBlueprintEnabled: true,
          demoRunnerEnabled: true,
          incidentDemoEnabled: true,
          finalDemoReportEnabled: true,
          killSwitchProofEnabled: true,
          llmLiveCallsEnabled: false,
          liveActionsEnabled: false
        },
        nfcBridge: {
          mode: "mock",
          liveWritesEnabled: false,
          providersActivatedByDefault: false
        },
        phase: operatingNorth.phase
      });
    }

    if (request.method === "GET" && request.url === "/v1/operating-north") {
      return json(response, 200, getOperatingNorthSnapshot());
    }

    if (request.method === "POST" && request.url === "/v1/demo/mvp/blueprint") {
      const body = await readOptionalJson<DelivrixMvpDemoBlueprintInput>(request);
      const killSwitch = await killSwitchStore.get();
      const blueprint = buildDelivrixMvpDemoBlueprint({
        ...body,
        killSwitch: body?.killSwitch ?? killSwitch
      });

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId: blueprint.actorId,
        action: "demo.mvp_blueprint_created",
        targetType: "mvp_demo",
        targetId: blueprint.id,
        riskLevel: blueprint.decision.status === "blocked" ? "high" : blueprint.decision.status === "needs_review" ? "medium" : "low",
        metadata: {
          phase: blueprint.phase,
          decision: blueprint.decision,
          route: blueprint.pipeline.route,
          patternReview: blueprint.patternReview.map((item) => ({
            pattern: item.pattern,
            status: item.status
          })),
          openClaw: {
            onboardingDecision: blueprint.openClaw.onboarding.decision.status,
            topologyDecision: blueprint.openClaw.topology.decision.status,
            provisioningDecision: blueprint.openClaw.provisioning.decision.status,
            schedulerDecision: blueprint.openClaw.scheduler.decision.status,
            runbookDecision: blueprint.openClaw.runbook.decision.status
          },
          dryRun: blueprint.dryRun,
          sideEffects: blueprint.sideEffects,
          liveEmailSendingEnabled: false,
          liveInfrastructureWritesEnabled: false,
          nfcProductionWritesEnabled: false,
          localStateOnlyForPipelineDemo: blueprint.safety.localStateOnlyForPipelineDemo
        }
      });

      return json(response, 200, {
        blueprint
      });
    }

    if (request.method === "POST" && request.url === "/v1/demo/mvp/run") {
      const body = await readOptionalJson<DelivrixMvpDemoBlueprintInput & { demoRunId?: string }>(request);
      const killSwitch = await killSwitchStore.get();
      const actorId = body?.actorId?.trim() || "operator_local";
      const demoRunId = body?.demoRunId?.trim() || createId("demo_run");
      const blueprint = buildDelivrixMvpDemoBlueprint({
        ...body,
        actorId,
        killSwitch: body?.killSwitch ?? killSwitch
      });
      const auditEventIds: string[] = [];
      const appendDemoAudit = async (event: Parameters<typeof auditLog.append>[0]) => {
        const auditEvent = await auditLog.append({
          ...event,
          metadata: {
            ...event.metadata,
            demoRunId,
            blueprintId: blueprint.id,
            smtpEnabled: false,
            liveInfrastructureWritesEnabled: false,
            nfcProductionWritesEnabled: false
          }
        });
        auditEventIds.push(auditEvent.id);
        return auditEvent;
      };
      let senderNode = undefined;
      let job = undefined;
      let result = undefined;
      let blockedReason = undefined;

      if (blueprint.decision.status !== "ready_for_demo") {
        blockedReason = `Blueprint is ${blueprint.decision.status}: ${blueprint.decision.reason}`;
        await appendDemoAudit({
          actorType: body?.actorId ? "operator" : "system",
          actorId,
          action: "demo.mvp_run.blocked_by_blueprint",
          targetType: "mvp_demo",
          targetId: demoRunId,
          riskLevel: "high",
          metadata: {
            decision: blueprint.decision
          }
        });
      } else {
        const killSwitchDecision = evaluateKillSwitch(killSwitch, "apply_supervised_local_action");

        if (!killSwitchDecision.allowed) {
          blockedReason = killSwitchDecision.message;
          await appendDemoAudit({
            actorType: body?.actorId ? "operator" : "system",
            actorId,
            action: "demo.mvp_run.blocked_by_kill_switch",
            targetType: "mvp_demo",
            targetId: demoRunId,
            riskLevel: "critical",
            metadata: {
              decision: killSwitchDecision
            }
          });
        } else {
          senderNode = await senderNodeRegistry.register(blueprint.pipeline.senderNode);
          await appendDemoAudit({
            actorType: body?.actorId ? "operator" : "system",
            actorId,
            action: "demo.sender_node.seeded",
            targetType: "sender_node",
            targetId: senderNode.id,
            riskLevel: "medium",
            metadata: {
              provider: senderNode.provider,
              status: senderNode.status,
              dailyLimit: senderNode.dailyLimit,
              sideEffects: "local-state-only"
            }
          });

          const policyDecision = await policyEngine.evaluate(blueprint.pipeline.sendRequest);

          if (!policyDecision.allowed) {
            blockedReason = "Policy rejected the demo request.";
            await appendDemoAudit({
              actorType: "system",
              actorId: "gateway-api",
              action: "demo.send_request.rejected",
              targetType: "campaign",
              targetId: blueprint.pipeline.sendRequest.campaignId,
              riskLevel: "medium",
              metadata: {
                violations: policyDecision.violations,
                warnings: policyDecision.warnings
              }
            });
          } else {
            const gatewayRateLimitDecision = await rateLimitService.check(
              requestRateLimitRules(blueprint.pipeline.sendRequest, requestRateLimitProfile)
            );

            if (!gatewayRateLimitDecision.allowed) {
              blockedReason = "Rate limit rejected the demo request at Gateway.";
              await appendDemoAudit({
                actorType: "system",
                actorId: "gateway-api",
                action: "demo.send_request.rate_limited",
                targetType: "campaign",
                targetId: blueprint.pipeline.sendRequest.campaignId,
                riskLevel: "medium",
                metadata: {
                  violations: gatewayRateLimitDecision.violations
                }
              });
            } else {
              job = await sendQueue.add(blueprint.pipeline.sendRequest);
              await appendDemoAudit({
                actorType: "system",
                actorId: "gateway-api",
                action: "demo.send_request.accepted",
                targetType: "send_job",
                targetId: job.id,
                riskLevel: "low",
                metadata: {
                  campaignId: job.request.campaignId,
                  recipient: job.request.recipient.email,
                  classification: job.request.classification
                }
              });

              const claimedJob = await sendQueue.claim(job.id);

              if (!claimedJob) {
                blockedReason = "Demo job could not be claimed from the local queue.";
                await appendDemoAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.send_job.claim_failed",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "high",
                  metadata: {
                    reason: blockedReason
                  }
                });
              } else {
                job = claimedJob;
                await appendDemoAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.send_job.claimed",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "low",
                  metadata: {
                    recipient: job.request.recipient.email,
                    campaignId: job.request.campaignId
                  }
                });

                await sendQueue.assignSenderNode(job.id, senderNode.id);
                job = {
                  ...job,
                  senderNodeId: senderNode.id
                };
                await appendDemoAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.send_job.sender_node_assigned",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "low",
                  metadata: {
                    senderNodeId: senderNode.id,
                    provider: senderNode.provider,
                    status: senderNode.status
                  }
                });

                const workerRateLimitDecision = await rateLimitService.consume([
                  ...requestRateLimitRules(job.request, requestRateLimitProfile),
                  senderNodeRateLimitRule(senderNode)
                ]);

                if (!workerRateLimitDecision.allowed) {
                  blockedReason = "Rate limit exceeded during demo worker enforcement.";
                  await sendQueue.markBlocked(job.id, blockedReason);
                  job = {
                    ...job,
                    status: "blocked",
                    failureReason: blockedReason,
                    completedAt: new Date().toISOString()
                  };
                  await appendDemoAudit({
                    actorType: "system",
                    actorId: "demo-runner",
                    action: "demo.send_job.rate_limited",
                    targetType: "send_job",
                    targetId: job.id,
                    riskLevel: "medium",
                    metadata: {
                      violations: workerRateLimitDecision.violations,
                      senderNodeId: senderNode.id
                    }
                  });
                } else {
                  const simulatedResult = simulateSendResult(job);
                  result = await sendResultStore.create({
                    sendJobId: job.id,
                    senderNodeId: senderNode.id,
                    ...simulatedResult,
                    metadata: {
                      ...simulatedResult.metadata,
                      demoRunId,
                      blueprintId: blueprint.id,
                      smtpEnabled: false
                    }
                  });

                  if (result.status === "failed") {
                    await sendQueue.markFailed(job.id, "Simulated demo result failed.");
                    job = {
                      ...job,
                      status: "failed",
                      failureReason: "Simulated demo result failed.",
                      completedAt: new Date().toISOString()
                    };
                  } else {
                    await sendQueue.markCompleted(job.id);
                    job = {
                      ...job,
                      status: "completed",
                      completedAt: new Date().toISOString()
                    };
                  }

                  await appendDemoAudit({
                    actorType: "system",
                    actorId: "demo-runner",
                    action: "demo.send_result.simulated",
                    targetType: "send_result",
                    targetId: result.id,
                    riskLevel: result.status === "complaint" || result.status === "bounce" ? "medium" : "low",
                    metadata: {
                      sendJobId: job.id,
                      senderNodeId: senderNode.id,
                      status: result.status,
                      sideEffects: "local-state-only"
                    }
                  });
                }
              }
            }
          }
        }
      }

      const jobs = await sendQueue.list();
      const senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();
      let auditEvents = await auditLog.list();
      const healthDecisions = evaluateSenderNodeHealth(senderNodes, sendResults);
      let operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      job = job ? jobs.find((candidate) => candidate.id === job?.id) ?? job : undefined;
      const draftReport = buildDelivrixMvpDemoRunReport({
        id: demoRunId,
        actorId,
        blueprint,
        senderNode,
        job,
        result,
        healthDecisions,
        operationalSummary,
        auditEventIds,
        blockedReason
      });

      await appendDemoAudit({
        actorType: body?.actorId ? "operator" : "system",
        actorId,
        action: draftReport.decision.status === "blocked" ? "demo.mvp_run.blocked" : "demo.mvp_run.completed",
        targetType: "mvp_demo",
        targetId: demoRunId,
        riskLevel: draftReport.decision.status === "blocked" ? "high" : draftReport.decision.status === "needs_review" ? "medium" : "low",
        metadata: {
          decision: draftReport.decision,
          artifacts: draftReport.artifacts,
          route: draftReport.route
        }
      });

      auditEvents = await auditLog.list();
      operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });

      const report = buildDelivrixMvpDemoRunReport({
        id: demoRunId,
        actorId,
        blueprint,
        senderNode,
        job,
        result,
        healthDecisions,
        operationalSummary,
        auditEventIds,
        blockedReason
      });

      return json(response, 200, {
        report
      });
    }

    if (request.method === "POST" && request.url === "/v1/demo/openclaw/incident") {
      const body = await readOptionalJson<DelivrixMvpDemoBlueprintInput & {
        incidentDemoId?: string;
        demoRunId?: string;
        incidentStatus?: SendResultStatus;
        humanApproved?: boolean;
        applyLocalAction?: boolean;
      }>(request);
      const requestedStatus = body?.incidentStatus ?? body?.simulatedResultStatus ?? "complaint";

      if (
        requestedStatus !== "bounce"
        && requestedStatus !== "complaint"
        && requestedStatus !== "deferred"
        && requestedStatus !== "failed"
      ) {
        return json(response, 422, {
          error: "invalid_openclaw_incident_status",
          message: "incidentStatus must be bounce, complaint, deferred, or failed."
        });
      }

      const killSwitch = await killSwitchStore.get();
      const actorId = body?.actorId?.trim() || "operator_local";
      const incidentDemoId = body?.incidentDemoId?.trim() || createId("openclaw_incident_demo");
      const demoRunId = body?.demoRunId?.trim() || createId("demo_run");
      const humanApproved = body?.humanApproved ?? true;
      const shouldApplyLocalAction = body?.applyLocalAction !== false;
      const blueprint = buildDelivrixMvpDemoBlueprint({
        ...body,
        actorId,
        simulatedResultStatus: requestedStatus,
        killSwitch: body?.killSwitch ?? killSwitch
      });
      const auditEventIds: string[] = [];
      const appendIncidentAudit = async (event: Parameters<typeof auditLog.append>[0]) => {
        const auditEvent = await auditLog.append({
          ...event,
          metadata: {
            ...event.metadata,
            incidentDemoId,
            demoRunId,
            blueprintId: blueprint.id,
            smtpEnabled: false,
            liveInfrastructureWritesEnabled: false,
            nfcProductionWritesEnabled: false
          }
        });
        auditEventIds.push(auditEvent.id);
        return auditEvent;
      };
      let senderNode = undefined;
      let appliedSenderNode = undefined;
      let job = undefined;
      let result = undefined;
      let blockedReason = undefined;

      if (blueprint.decision.status !== "ready_for_demo") {
        blockedReason = `Blueprint is ${blueprint.decision.status}: ${blueprint.decision.reason}`;
        await appendIncidentAudit({
          actorType: body?.actorId ? "operator" : "system",
          actorId,
          action: "demo.openclaw_incident.blocked_by_blueprint",
          targetType: "mvp_demo",
          targetId: incidentDemoId,
          riskLevel: "high",
          metadata: {
            decision: blueprint.decision
          }
        });
      } else {
        const killSwitchDecision = evaluateKillSwitch(killSwitch, "apply_supervised_local_action");

        if (!killSwitchDecision.allowed) {
          blockedReason = killSwitchDecision.message;
          await appendIncidentAudit({
            actorType: body?.actorId ? "operator" : "system",
            actorId,
            action: "demo.openclaw_incident.blocked_by_kill_switch",
            targetType: "mvp_demo",
            targetId: incidentDemoId,
            riskLevel: "critical",
            metadata: {
              decision: killSwitchDecision
            }
          });
        } else {
          senderNode = await senderNodeRegistry.register(blueprint.pipeline.senderNode);
          await appendIncidentAudit({
            actorType: body?.actorId ? "operator" : "system",
            actorId,
            action: "demo.openclaw_incident.sender_node_seeded",
            targetType: "sender_node",
            targetId: senderNode.id,
            riskLevel: "medium",
            metadata: {
              provider: senderNode.provider,
              status: senderNode.status,
              dailyLimit: senderNode.dailyLimit,
              sideEffects: "local-state-only"
            }
          });

          const policyDecision = await policyEngine.evaluate(blueprint.pipeline.sendRequest);

          if (!policyDecision.allowed) {
            blockedReason = "Policy rejected the OpenClaw incident demo request.";
            await appendIncidentAudit({
              actorType: "system",
              actorId: "gateway-api",
              action: "demo.openclaw_incident.send_request_rejected",
              targetType: "campaign",
              targetId: blueprint.pipeline.sendRequest.campaignId,
              riskLevel: "medium",
              metadata: {
                violations: policyDecision.violations,
                warnings: policyDecision.warnings
              }
            });
          } else {
            const gatewayRateLimitDecision = await rateLimitService.check(
              requestRateLimitRules(blueprint.pipeline.sendRequest, requestRateLimitProfile)
            );

            if (!gatewayRateLimitDecision.allowed) {
              blockedReason = "Rate limit rejected the OpenClaw incident demo request at Gateway.";
              await appendIncidentAudit({
                actorType: "system",
                actorId: "gateway-api",
                action: "demo.openclaw_incident.send_request_rate_limited",
                targetType: "campaign",
                targetId: blueprint.pipeline.sendRequest.campaignId,
                riskLevel: "medium",
                metadata: {
                  violations: gatewayRateLimitDecision.violations
                }
              });
            } else {
              job = await sendQueue.add(blueprint.pipeline.sendRequest);
              await appendIncidentAudit({
                actorType: "system",
                actorId: "gateway-api",
                action: "demo.openclaw_incident.send_request_accepted",
                targetType: "send_job",
                targetId: job.id,
                riskLevel: "low",
                metadata: {
                  campaignId: job.request.campaignId,
                  recipient: job.request.recipient.email,
                  classification: job.request.classification,
                  expectedIncidentStatus: requestedStatus
                }
              });

              const claimedJob = await sendQueue.claim(job.id);

              if (!claimedJob) {
                blockedReason = "OpenClaw incident demo job could not be claimed from the local queue.";
                await appendIncidentAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.openclaw_incident.send_job_claim_failed",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "high",
                  metadata: {
                    reason: blockedReason
                  }
                });
              } else {
                job = claimedJob;
                await appendIncidentAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.openclaw_incident.send_job_claimed",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "low",
                  metadata: {
                    recipient: job.request.recipient.email,
                    campaignId: job.request.campaignId
                  }
                });

                await sendQueue.assignSenderNode(job.id, senderNode.id);
                job = {
                  ...job,
                  senderNodeId: senderNode.id
                };
                await appendIncidentAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.openclaw_incident.sender_node_assigned",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "low",
                  metadata: {
                    senderNodeId: senderNode.id,
                    provider: senderNode.provider,
                    status: senderNode.status
                  }
                });

                const workerRateLimitDecision = await rateLimitService.consume([
                  ...requestRateLimitRules(job.request, requestRateLimitProfile),
                  senderNodeRateLimitRule(senderNode)
                ]);

                if (!workerRateLimitDecision.allowed) {
                  blockedReason = "Rate limit exceeded during OpenClaw incident demo worker enforcement.";
                  await sendQueue.markBlocked(job.id, blockedReason);
                  job = {
                    ...job,
                    status: "blocked",
                    failureReason: blockedReason,
                    completedAt: new Date().toISOString()
                  };
                  await appendIncidentAudit({
                    actorType: "system",
                    actorId: "demo-runner",
                    action: "demo.openclaw_incident.send_job_rate_limited",
                    targetType: "send_job",
                    targetId: job.id,
                    riskLevel: "medium",
                    metadata: {
                      violations: workerRateLimitDecision.violations,
                      senderNodeId: senderNode.id
                    }
                  });
                } else {
                  const simulatedResult = simulateSendResult(job);
                  result = await sendResultStore.create({
                    sendJobId: job.id,
                    senderNodeId: senderNode.id,
                    ...simulatedResult,
                    metadata: {
                      ...simulatedResult.metadata,
                      incidentDemoId,
                      demoRunId,
                      blueprintId: blueprint.id,
                      smtpEnabled: false
                    }
                  });

                  if (result.status === "failed") {
                    await sendQueue.markFailed(job.id, "Simulated OpenClaw incident result failed.");
                    job = {
                      ...job,
                      status: "failed",
                      failureReason: "Simulated OpenClaw incident result failed.",
                      completedAt: new Date().toISOString()
                    };
                  } else {
                    await sendQueue.markCompleted(job.id);
                    job = {
                      ...job,
                      status: "completed",
                      completedAt: new Date().toISOString()
                    };
                  }

                  await appendIncidentAudit({
                    actorType: "system",
                    actorId: "demo-runner",
                    action: "demo.openclaw_incident.result_simulated",
                    targetType: "send_result",
                    targetId: result.id,
                    riskLevel: result.status === "complaint" ? "critical" : "medium",
                    metadata: {
                      sendJobId: job.id,
                      senderNodeId: senderNode.id,
                      status: result.status,
                      sideEffects: "local-state-only"
                    }
                  });
                }
              }
            }
          }
        }
      }

      let jobs = await sendQueue.list();
      let senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();
      let auditEvents = await auditLog.list();
      const healthDecisions = evaluateSenderNodeHealth(senderNodes, sendResults);
      let operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      job = job ? jobs.find((candidate) => candidate.id === job?.id) ?? job : undefined;
      const demoRun = buildDelivrixMvpDemoRunReport({
        id: demoRunId,
        actorId,
        blueprint,
        senderNode,
        job,
        result,
        healthDecisions,
        operationalSummary,
        auditEventIds,
        blockedReason
      });
      const draftIncidentReport = buildOpenClawIncidentDemoReport({
        id: incidentDemoId,
        actorId,
        demoRun,
        killSwitch,
        humanApproved,
        auditEventIds
      });

      await appendIncidentAudit({
        actorType: "openclaw",
        actorId: "alert-ops",
        action: draftIncidentReport.detection.detected
          ? "demo.openclaw_incident.detected"
          : "demo.openclaw_incident.not_detected",
        targetType: "send_result",
        targetId: draftIncidentReport.detection.sendResultId ?? "missing",
        riskLevel: draftIncidentReport.detection.severity === "critical" ? "critical" : draftIncidentReport.detection.detected ? "medium" : "low",
        metadata: {
          detection: draftIncidentReport.detection
        }
      });

      await appendIncidentAudit({
        actorType: "openclaw",
        actorId: "alert-ops",
        action: draftIncidentReport.proposal.action
          ? "demo.openclaw_incident.action_proposed"
          : "demo.openclaw_incident.no_action_required",
        targetType: "sender_node",
        targetId: draftIncidentReport.proposal.targetSenderNodeId ?? "none",
        riskLevel: draftIncidentReport.proposal.manualAction === "quarantine" ? "critical" : draftIncidentReport.proposal.manualAction ? "high" : "low",
        metadata: {
          proposal: draftIncidentReport.proposal
        }
      });

      await appendIncidentAudit({
        actorType: "system",
        actorId: "openclaw-runbook",
        action: "demo.openclaw_incident.permission_evaluated",
        targetType: "sender_node",
        targetId: draftIncidentReport.proposal.targetSenderNodeId ?? "none",
        riskLevel: draftIncidentReport.permissionChecks.withHumanApproval?.riskLevel ?? "low",
        metadata: {
          humanApproved,
          permissionChecks: draftIncidentReport.permissionChecks
        }
      });

      if (
        shouldApplyLocalAction
        && humanApproved
        && senderNode
        && draftIncidentReport.permissionChecks.withHumanApproval?.allowed
        && draftIncidentReport.localAction.decision?.allowed
        && draftIncidentReport.localAction.decision.nextStatus
      ) {
        appliedSenderNode = await senderNodeRegistry.updateStatus(
          senderNode.id,
          draftIncidentReport.localAction.decision.nextStatus
        );
        await appendIncidentAudit({
          actorType: "operator",
          actorId,
          action: "demo.openclaw_incident.local_action_applied",
          targetType: "sender_node",
          targetId: senderNode.id,
          riskLevel: draftIncidentReport.localAction.decision.riskLevel,
          metadata: {
            humanApproved,
            action: draftIncidentReport.localAction.decision.action,
            previousStatus: senderNode.status,
            currentStatus: appliedSenderNode.status,
            reason: draftIncidentReport.localAction.decision.reason,
            sideEffects: "local-state-only"
          }
        });
      } else {
        await appendIncidentAudit({
          actorType: humanApproved ? "system" : "operator",
          actorId: humanApproved ? "openclaw-runbook" : actorId,
          action: "demo.openclaw_incident.local_action_not_applied",
          targetType: "sender_node",
          targetId: senderNode?.id ?? "none",
          riskLevel: draftIncidentReport.permissionChecks.withHumanApproval?.allowed === false ? "critical" : "medium",
          metadata: {
            humanApproved,
            shouldApplyLocalAction,
            permission: draftIncidentReport.permissionChecks.withHumanApproval,
            localAction: draftIncidentReport.localAction
          }
        });
      }

      jobs = await sendQueue.list();
      senderNodes = await senderNodeRegistry.list();
      auditEvents = await auditLog.list();
      operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      const finalDemoRun = buildDelivrixMvpDemoRunReport({
        id: demoRunId,
        actorId,
        blueprint,
        senderNode,
        job,
        result,
        healthDecisions,
        operationalSummary,
        auditEventIds,
        blockedReason
      });
      const finalDraftReport = buildOpenClawIncidentDemoReport({
        id: incidentDemoId,
        actorId,
        demoRun: finalDemoRun,
        killSwitch,
        humanApproved,
        appliedSenderNode,
        auditEventIds
      });

      await appendIncidentAudit({
        actorType: body?.actorId ? "operator" : "system",
        actorId,
        action: finalDraftReport.decision.status === "blocked"
          ? "demo.openclaw_incident.blocked"
          : finalDraftReport.decision.status === "needs_review"
            ? "demo.openclaw_incident.needs_review"
            : "demo.openclaw_incident.completed",
        targetType: "mvp_demo",
        targetId: incidentDemoId,
        riskLevel: finalDraftReport.decision.status === "blocked" ? "high" : finalDraftReport.decision.status === "needs_review" ? "medium" : "low",
        metadata: {
          decision: finalDraftReport.decision,
          detection: finalDraftReport.detection,
          proposal: finalDraftReport.proposal,
          localAction: finalDraftReport.localAction
        }
      });

      const report = buildOpenClawIncidentDemoReport({
        id: incidentDemoId,
        actorId,
        demoRun: finalDemoRun,
        killSwitch,
        humanApproved,
        appliedSenderNode,
        auditEventIds
      });

      return json(response, 200, {
        report
      });
    }

    if (request.method === "POST" && request.url === "/v1/demo/mvp/final-report") {
      const body = await readOptionalJson<{
        actorId?: string;
        reportId?: string;
      }>(request);
      const actorId = body?.actorId?.trim() || "operator_local";
      const reportId = body?.reportId?.trim() || createId("mvp_final_demo_report");
      const killSwitch = await killSwitchStore.get();
      const jobs = await sendQueue.list();
      const senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();
      let auditEvents = await auditLog.list();
      const healthDecisions = evaluateSenderNodeHealth(senderNodes, sendResults);
      let operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      let adminOverview = buildAdminOverview({
        summary: operationalSummary,
        health: healthDecisions,
        auditEvents,
        killSwitch
      });
      const draftReport = buildMvpFinalDemoReport({
        id: reportId,
        actorId,
        auditEvents,
        operationalSummary,
        adminOverview,
        operatingNorth: getOperatingNorthSnapshot()
      });

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId,
        action: "demo.mvp_final_report_generated",
        targetType: "mvp_demo",
        targetId: reportId,
        riskLevel: draftReport.decision.status === "blocked" ? "high" : draftReport.decision.status === "needs_review" ? "medium" : "low",
        metadata: {
          phase: draftReport.phase,
          decision: draftReport.decision,
          evidence: draftReport.evidence,
          limitedProductionGates: draftReport.limitedProductionGates,
          residualRisks: draftReport.residualRisks,
          safety: draftReport.safety,
          smtpEnabled: false,
          liveInfrastructureWritesEnabled: false,
          nfcProductionWritesEnabled: false
        }
      });

      auditEvents = await auditLog.list();
      operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      adminOverview = buildAdminOverview({
        summary: operationalSummary,
        health: healthDecisions,
        auditEvents,
        killSwitch
      });

      const report = buildMvpFinalDemoReport({
        id: reportId,
        actorId,
        auditEvents,
        operationalSummary,
        adminOverview,
        operatingNorth: getOperatingNorthSnapshot()
      });

      return json(response, 200, {
        report
      });
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/onboarding/questionnaire") {
      return json(response, 200, getOpenClawOnboardingQuestionnaire());
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/onboarding/evaluate") {
      const body = await readOptionalJson<OpenClawOnboardingInput>(request);
      const snapshot = evaluateOpenClawOnboarding(body ?? {});

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId: snapshot.actorId,
        action: "openclaw_onboarding.evaluated",
        targetType: "openclaw_onboarding",
        targetId: snapshot.id,
        riskLevel: snapshot.decision.riskLevel,
        metadata: {
          phase: snapshot.phase,
          decision: snapshot.decision,
          readiness: snapshot.readiness,
          blockers: snapshot.blockers,
          warnings: snapshot.warnings,
          missingCriticalFields: snapshot.missingCriticalFields,
          dryRun: snapshot.dryRun,
          sideEffects: snapshot.sideEffects,
          liveInfrastructureWritesEnabled: false,
          sshEnabled: false,
          smtpEnabled: false,
          dnsLiveChangesEnabled: false,
          nfcWritesEnabled: false
        }
      });

      return json(response, 200, {
        snapshot
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/topology/plan") {
      const body = await readJson<OpenClawTopologyPlannerInput>(request);
      const plan = buildOpenClawTopologyPlan(body);

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId: plan.actorId,
        action: "openclaw_topology.plan_created",
        targetType: "openclaw_topology",
        targetId: plan.id,
        riskLevel: plan.decision.riskLevel,
        metadata: {
          phase: plan.phase,
          strategy: plan.strategy,
          decision: plan.decision,
          summary: plan.summary,
          risks: plan.risks,
          dryRun: plan.dryRun,
          sideEffects: plan.sideEffects,
          liveInfrastructureWritesEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false,
          smtpEnabled: false,
          dnsLiveChangesEnabled: false,
          nfcWritesEnabled: false
        }
      });

      return json(response, 200, {
        plan
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/provisioning/dry-run") {
      const body = await readJson<OpenClawProvisioningDryRunInput>(request);
      const plan = buildOpenClawProvisioningDryRun(body);

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId: plan.actorId,
        action: "openclaw_provisioning.dry_run_created",
        targetType: "openclaw_provisioning",
        targetId: plan.id,
        riskLevel: plan.decision.riskLevel,
        metadata: {
          phase: plan.phase,
          decision: plan.decision,
          summary: plan.summary,
          risks: plan.risks,
          dryRun: plan.dryRun,
          sideEffects: plan.sideEffects,
          liveInfrastructureWritesEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false,
          postfixLiveApplyEnabled: false,
          openDkimLiveKeyGenerationEnabled: false,
          tlsLiveCertificateRequestEnabled: false,
          dnsLiveChangesEnabled: false,
          smtpEnabled: false,
          nfcWritesEnabled: false
        }
      });

      return json(response, 200, {
        plan
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/scheduler/run") {
      const body = await readOptionalJson<OpenClawSchedulerInput>(request);
      const run = runOpenClawScheduler(body ?? {});

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId: run.actorId,
        action: "openclaw_scheduler.run_simulated",
        targetType: "openclaw_scheduler",
        targetId: run.id,
        riskLevel: run.decision.riskLevel,
        metadata: {
          phase: run.phase,
          decision: run.decision,
          sourceProvisioningId: run.sourceProvisioningId,
          llmRouter: run.llmRouter,
          tasks: run.tasks.map((task) => ({
            name: task.name,
            skill: task.skill,
            cadence: task.cadence,
            due: task.due,
            sideEffects: task.sideEffects,
            liveActionsEnabled: task.liveActionsEnabled
          })),
          skills: run.skills.map((skill) => ({
            name: skill.name,
            status: skill.status,
            proposedActions: skill.proposedActions.length
          })),
          dailyReport: {
            humanReviewRequired: run.dailyReport.humanReviewRequired,
            plannedSenderNodes: run.dailyReport.fleet.plannedSenderNodes,
            provisioningDecision: run.dailyReport.fleet.provisioningDecision,
            alerts: {
              critical: run.dailyReport.alerts.critical,
              high: run.dailyReport.alerts.high,
              medium: run.dailyReport.alerts.medium,
              low: run.dailyReport.alerts.low
            }
          },
          dryRun: run.dryRun,
          sideEffects: run.sideEffects,
          liveInfrastructureWritesEnabled: false,
          llmLiveCallsEnabled: false,
          actionExecutorLiveEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false,
          smtpEnabled: false,
          dnsLiveChangesEnabled: false,
          nfcWritesEnabled: false
        }
      });

      return json(response, 200, {
        run
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/runbook/evaluate") {
      const body = await readOptionalJson<OpenClawRunbookInput>(request);
      const currentKillSwitch = await killSwitchStore.get();
      const runbook = buildOpenClawOperationalRunbook({
        ...body,
        killSwitch: body?.killSwitch ?? currentKillSwitch
      });

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId: runbook.actorId,
        action: "openclaw_runbook.evaluated",
        targetType: "openclaw_runbook",
        targetId: runbook.id,
        riskLevel: runbook.decision.riskLevel,
        metadata: {
          phase: runbook.phase,
          decision: runbook.decision,
          permissionMatrixItems: runbook.permissionMatrix.length,
          checklist: runbook.checklist,
          killSwitchProof: {
            currentState: runbook.killSwitchProof.currentState,
            blocksOpenClawProposedActions: runbook.killSwitchProof.blocksOpenClawProposedActions,
            blocksSupervisedLocalActions: runbook.killSwitchProof.blocksSupervisedLocalActions,
            blocksLiveInfrastructureActions: runbook.killSwitchProof.blocksLiveInfrastructureActions,
            blocksQueueProcessing: runbook.killSwitchProof.blocksQueueProcessing
          },
          dryRun: runbook.dryRun,
          sideEffects: runbook.sideEffects,
          liveInfrastructureWritesEnabled: false,
          liveEmailSendingEnabled: false,
          nfcProductionWritesEnabled: false,
          sshEnabled: false,
          dnsLiveChangesEnabled: false,
          proxmoxApiEnabled: false,
          llmAutonomousExecutionEnabled: false
        }
      });

      return json(response, 200, {
        runbook
      });
    }

    if (request.method === "POST" && request.url === "/v1/nfc/bridge/capacity-plan") {
      const body = await readOptionalJson<{
        senderNodeIds?: string[];
        actorId?: string;
        providerNamePrefix?: string;
        emailFromName?: string;
        emailsPerMinute?: number;
      }>(request);
      const nodes = await senderNodeRegistry.list();
      const selectedNodeIds = body?.senderNodeIds?.filter(Boolean) ?? [];
      const selectedNodes = selectedNodeIds.length > 0
        ? nodes.filter((node) => selectedNodeIds.includes(node.id))
        : nodes;
      const missingNodeIds = selectedNodeIds.filter((id) => !nodes.some((node) => node.id === id));

      if (missingNodeIds.length > 0) {
        return json(response, 422, {
          error: "unknown_sender_nodes",
          missingNodeIds
        });
      }

      const plan = buildNfcBridgeCapacityPlan({
        senderNodes: selectedNodes,
        actorId: body?.actorId,
        providerNamePrefix: body?.providerNamePrefix,
        emailFromName: body?.emailFromName,
        emailsPerMinute: body?.emailsPerMinute
      });

      await auditLog.append({
        actorType: "operator",
        actorId: plan.actorId,
        action: "nfc_bridge.capacity_plan_generated",
        targetType: "nfc_bridge_plan",
        targetId: plan.id,
        riskLevel: plan.summary.blocked > 0 || plan.summary.needsReview > 0 ? "medium" : "low",
        metadata: {
          dryRun: true,
          nfcProductionWritesEnabled: false,
          providersToCreate: plan.summary.providersToCreate,
          smtpServersToCreate: plan.summary.smtpServersToCreate,
          blockedOperations: plan.blockedOperations
        }
      });

      return json(response, 200, plan);
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

    if (request.method === "POST" && request.url === "/v1/send-results/ingest") {
      const body = await readJson<{
        sendJobId?: string;
        senderNodeId?: string;
        status?: SendResultStatus;
        smtpResponse?: string;
        bounceCode?: string;
        complaintSource?: string;
        source?: string;
        actorId?: string;
        metadata?: Record<string, unknown>;
      }>(request);

      if (!body.sendJobId?.trim() || !body.status) {
        return json(response, 422, {
          error: "invalid_send_result_ingestion_payload",
          message: "sendJobId and status are required."
        });
      }

      const jobs = await sendQueue.list();
      const senderNodes = await senderNodeRegistry.list();
      const job = jobs.find((candidate) => candidate.id === body.sendJobId);
      const resolvedSenderNodeId = body.senderNodeId ?? job?.senderNodeId;
      const senderNode = resolvedSenderNodeId
        ? senderNodes.find((candidate) => candidate.id === resolvedSenderNodeId)
        : undefined;
      const decision = evaluateSendResultIngestion({
        sendJobId: body.sendJobId,
        senderNodeId: body.senderNodeId,
        status: body.status,
        smtpResponse: body.smtpResponse,
        bounceCode: body.bounceCode,
        complaintSource: body.complaintSource,
        source: body.source,
        metadata: body.metadata
      }, {
        job,
        senderNode
      });
      const actorId = body.actorId?.trim() || "mock-ingestion";

      if (!decision.allowed || !decision.normalizedStatus || !decision.senderNodeId) {
        await auditLog.append({
          actorType: body.actorId ? "operator" : "system",
          actorId,
          action: "send_result.ingestion_rejected",
          targetType: "send_job",
          targetId: body.sendJobId,
          riskLevel: decision.riskLevel,
          metadata: {
            decision,
            payloadStatus: body.status,
            smtpEnabled: false
          }
        });

        return json(response, 422, {
          allowed: false,
          decision
        });
      }

      const result = await sendResultStore.create({
        sendJobId: decision.sendJobId,
        senderNodeId: decision.senderNodeId,
        status: decision.normalizedStatus,
        smtpResponse: body.smtpResponse,
        bounceCode: body.bounceCode,
        complaintSource: body.complaintSource,
        metadata: {
          ...(body.metadata ?? {}),
          ingested: true,
          source: body.source ?? "mock-ingestion"
        }
      });
      const suppressionEntry = decision.suppression
        ? await suppressionList.add(decision.suppression)
        : undefined;

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId,
        action: "send_result.ingested",
        targetType: "send_result",
        targetId: result.id,
        riskLevel: decision.riskLevel,
        metadata: {
          decision,
          sendJobId: result.sendJobId,
          senderNodeId: result.senderNodeId,
          status: result.status,
          suppressionEntry,
          smtpEnabled: false,
          sideEffects: "local-state-only"
        }
      });

      return json(response, 201, {
        allowed: true,
        result,
        suppressionEntry,
        decision
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

    if (request.method === "GET" && request.url === "/v1/provisioning-runs") {
      return json(response, 200, {
        runs: await provisioningRunStore.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/ip-reputation/reports") {
      return json(response, 200, {
        reports: evaluateIpReputation(
          await senderNodeRegistry.list(),
          await sendResultStore.list()
        )
      });
    }

    if (request.method === "GET" && request.url === "/v1/ip-reputation/history") {
      return json(response, 200, {
        reports: await ipReputationReportStore.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/backups/simulations") {
      return json(response, 200, {
        simulations: await backupSimulationStore.list()
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
      const killSwitch = await killSwitchStore.get();
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
        auditEvents,
        killSwitch
      });

      return json(response, 200, {
        overview
      });
    }

    if (request.method === "GET" && request.url === "/v1/admin/workflow") {
      const jobs = await sendQueue.list();
      const sendResults = await sendResultStore.list();
      const auditEvents = await auditLog.list();
      const senderNodes = await senderNodeRegistry.list();
      const rateLimitCounters = await rateLimitStore.list();
      const killSwitch = await killSwitchStore.get();
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
        auditEvents,
        killSwitch
      });
      const workflow = buildAdminPanelWorkflow({
        overview,
        operatingNorth: getOperatingNorthSnapshot(),
        killSwitch
      });

      return json(response, 200, {
        workflow
      });
    }

    if (request.method === "GET" && request.url === "/v1/admin/clusters") {
      const senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();
      const health = evaluateSenderNodeHealth(senderNodes, sendResults);
      const clusterOverview = buildAdminClusterOverview({
        senderNodes,
        health,
        provisioningRuns: await provisioningRunStore.list(),
        killSwitch: await killSwitchStore.get()
      });

      return json(response, 200, {
        clusterOverview
      });
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/learning-plan") {
      const learningPlan = buildOpenClawLearningPlan({
        auditEvents: await auditLog.list(),
        provisioningRuns: await provisioningRunStore.list(),
        sendResults: await sendResultStore.list()
      });

      return json(response, 200, {
        learningPlan
      });
    }

    if (request.method === "GET" && request.url === "/v1/admin/phase-3-overview") {
      const senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();

      return json(response, 200, {
        overview: {
          generatedAt: new Date().toISOString(),
          phase: "infraestructura-propia-piloto",
          proxmox: proxmoxAdapter.describeCapabilities(),
          provisioningRuns: await provisioningRunStore.list(),
          currentIpReputation: evaluateIpReputation(senderNodes, sendResults),
          ipReputationHistory: await ipReputationReportStore.list(),
          backupSimulations: await backupSimulationStore.list(),
          humanActions: [
            "pause",
            "reactivate",
            "degrade",
            "quarantine",
            "approve-retirement",
            "activate-kill-switch"
          ],
          safety: {
            smtpEnabled: false,
            proxmoxApiEnabled: false,
            sshEnabled: false,
            sideEffects: "local-state-only"
          }
        }
      });
    }

    if (request.method === "GET" && request.url === "/v1/kill-switch") {
      return json(response, 200, {
        killSwitch: await killSwitchStore.get()
      });
    }

    if (request.method === "POST" && request.url === "/v1/kill-switch") {
      const body = await readJson<{
        enabled?: unknown;
        reason?: string;
        actorId?: string;
      }>(request);

      if (typeof body.enabled !== "boolean") {
        return json(response, 422, {
          error: "invalid_kill_switch_payload",
          message: "enabled must be a boolean."
        });
      }

      if (body.enabled && !body.reason?.trim()) {
        return json(response, 422, {
          error: "kill_switch_reason_required",
          message: "reason is required when enabling kill switch."
        });
      }

      const previous = await killSwitchStore.get();
      const killSwitch = await killSwitchStore.update({
        enabled: body.enabled,
        reason: body.reason,
        updatedBy: body.actorId ?? "gateway-api"
      });

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId: body.actorId ?? "gateway-api",
        action: killSwitch.enabled ? "kill_switch.activated" : "kill_switch.deactivated",
        targetType: "operation",
        targetId: "global_send_pipeline",
        riskLevel: killSwitch.enabled ? "critical" : "high",
        metadata: {
          previous,
          current: killSwitch,
          smtpEnabled: false
        }
      });

      return json(response, 200, {
        killSwitch
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

    if (request.method === "POST" && request.url === "/v1/ip-reputation/reconcile") {
      const body = await readOptionalJson<{
        actorId?: string;
        signals?: IpReputationExternalSignal[];
        apply?: boolean;
      }>(request);
      const actorId = body?.actorId?.trim() || "gateway-api";
      const reports = evaluateIpReputation(
        await senderNodeRegistry.list(),
        await sendResultStore.list(),
        Array.isArray(body?.signals) ? body.signals : []
      );
      await ipReputationReportStore.appendMany(reports);

      const applied = [];
      const shouldApply = body?.apply !== false;

      if (shouldApply) {
        for (const report of reports) {
          if (report.currentStatus === report.recommendedStatus) {
            continue;
          }

          const node = await senderNodeRegistry.updateStatus(report.senderNodeId, report.recommendedStatus);
          applied.push({
            senderNodeId: node.id,
            previousStatus: report.currentStatus,
            currentStatus: node.status,
            state: report.state,
            recommendedAction: report.recommendedAction,
            signals: report.signals
          });
        }
      }

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId,
        action: "ip_reputation.reconciled",
        targetType: "sender_node",
        targetId: "all",
        riskLevel: applied.some((item) => item.currentStatus === "quarantined") ? "critical" : applied.length > 0 ? "high" : "low",
        metadata: {
          reportsGenerated: reports.length,
          appliedCount: applied.length,
          applied,
          apply: shouldApply,
          sideEffects: "local-state-only",
          smtpEnabled: false
        }
      });

      return json(response, 200, {
        applied,
        reports
      });
    }

    const retirementApprovalRoute = parseSenderNodeRetirementApprovalRoute(request);

    if (request.method === "POST" && retirementApprovalRoute) {
      const body = await readJson<{
        reason?: string;
        actorId?: string;
      }>(request);
      const nodes = await senderNodeRegistry.list();
      const node = nodes.find((candidate) => candidate.id === retirementApprovalRoute.senderNodeId);

      if (!node) {
        return json(response, 404, {
          error: "sender_node_not_found",
          message: `Sender node not found: ${retirementApprovalRoute.senderNodeId}`
        });
      }

      const decision = evaluateSenderNodeRetirementApproval({
        node,
        reason: body.reason
      });
      const actorId = body.actorId?.trim() || "local-operator";

      if (!decision.allowed || !decision.nextStatus) {
        await auditLog.append({
          actorType: "operator",
          actorId,
          action: decision.auditAction,
          targetType: "sender_node",
          targetId: node.id,
          riskLevel: decision.riskLevel,
          metadata: {
            reason: decision.reason ?? body.reason,
            currentStatus: decision.currentStatus,
            code: decision.code,
            message: decision.message,
            smtpEnabled: false
          }
        });

        return json(response, 422, {
          allowed: false,
          decision
        });
      }

      const updatedNode = await senderNodeRegistry.updateStatus(node.id, decision.nextStatus);

      await auditLog.append({
        actorType: "operator",
        actorId,
        action: decision.auditAction,
        targetType: "sender_node",
        targetId: node.id,
        riskLevel: decision.riskLevel,
        metadata: {
          reason: decision.reason,
          previousStatus: node.status,
          currentStatus: updatedNode.status,
          provider: node.provider,
          smtpEnabled: false,
          sideEffects: "local-state-only"
        }
      });

      return json(response, 200, {
        allowed: true,
        node: updatedNode,
        decision
      });
    }

    const senderNodeControlRoute = parseSenderNodeControlRoute(request);

    if (request.method === "POST" && senderNodeControlRoute) {
      if (!isSenderNodeManualAction(senderNodeControlRoute.action)) {
        return json(response, 422, {
          error: "invalid_sender_node_manual_action",
          message: "action must be pause, reactivate, degrade, or quarantine."
        });
      }

      const body = await readJson<{
        reason?: string;
        actorId?: string;
      }>(request);
      const nodes = await senderNodeRegistry.list();
      const node = nodes.find((candidate) => candidate.id === senderNodeControlRoute.senderNodeId);

      if (!node) {
        return json(response, 404, {
          error: "sender_node_not_found",
          message: `Sender node not found: ${senderNodeControlRoute.senderNodeId}`
        });
      }

      const decision = evaluateSenderNodeManualControl({
        node,
        action: senderNodeControlRoute.action,
        reason: body.reason
      });
      const actorId = body.actorId?.trim() || "local-operator";

      if (!decision.allowed || !decision.nextStatus) {
        await auditLog.append({
          actorType: "operator",
          actorId,
          action: decision.auditAction,
          targetType: "sender_node",
          targetId: node.id,
          riskLevel: decision.riskLevel,
          metadata: {
            action: decision.action,
            reason: decision.reason ?? body.reason,
            currentStatus: decision.currentStatus,
            code: decision.code,
            message: decision.message,
            smtpEnabled: false
          }
        });

        return json(response, 422, {
          allowed: false,
          decision
        });
      }

      const updatedNode = await senderNodeRegistry.updateStatus(node.id, decision.nextStatus);

      await auditLog.append({
        actorType: "operator",
        actorId,
        action: decision.auditAction,
        targetType: "sender_node",
        targetId: node.id,
        riskLevel: decision.riskLevel,
        metadata: {
          action: decision.action,
          reason: decision.reason,
          previousStatus: node.status,
          currentStatus: updatedNode.status,
          provider: node.provider,
          smtpEnabled: false,
          sideEffects: "local-state-only"
        }
      });

      return json(response, 200, {
        allowed: true,
        node: updatedNode,
        decision
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

    if (request.method === "POST" && request.url === "/v1/proxmox/provisioning-plan") {
      const body = await readJson<ProxmoxMockNodeConfig & { actorId?: string }>(request);
      const actorId = body.actorId?.trim() || "gateway-api";
      const plan = tryBuild(response, () => proxmoxAdapter.planProvisioning(body));

      if (!plan) {
        return;
      }

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId,
        action: "proxmox.provisioning_plan_created",
        targetType: "sender_node",
        targetId: plan.targetSenderNode.id,
        riskLevel: "medium",
        metadata: {
          planId: plan.id,
          provider: "proxmox",
          dryRun: plan.dryRun,
          sideEffects: plan.sideEffects,
          blockedOperations: plan.blockedOperations,
          smtpEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false
        }
      });

      return json(response, 201, {
        plan,
        capabilities: proxmoxAdapter.describeCapabilities()
      });
    }

    if (request.method === "POST" && request.url === "/v1/proxmox/provisioning-runs/simulate") {
      const body = await readJson<{
        node?: ProxmoxMockNodeConfig;
        registerSenderNode?: boolean;
        actorId?: string;
      } & ProxmoxMockNodeConfig>(request);
      const config = body.node ?? body;
      const actorId = body.actorId?.trim() || "gateway-api";
      const plan = tryBuild(response, () => proxmoxAdapter.planProvisioning(config));

      if (!plan) {
        return;
      }

      const shouldRegisterSenderNode = body.registerSenderNode !== false;
      const node = shouldRegisterSenderNode
        ? await senderNodeRegistry.register(plan.targetSenderNode)
        : undefined;
      const run = await provisioningRunStore.append(
        proxmoxAdapter.simulateProvisioning(plan, node?.id)
      );

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId,
        action: "proxmox.provisioning_run_simulated",
        targetType: "sender_node",
        targetId: plan.targetSenderNode.id,
        riskLevel: "medium",
        metadata: {
          runId: run.id,
          planId: plan.id,
          registeredSenderNodeId: node?.id,
          completedSteps: run.summary.completedSteps,
          sideEffects: run.sideEffects,
          smtpEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false
        }
      });

      return json(response, 201, {
        run,
        node: node
          ? {
            ...node,
            capabilities: proxmoxAdapter.describeCapabilities(node)
          }
          : undefined
      });
    }

    if (request.method === "POST" && request.url === "/v1/proxmox/mock-nodes/seed") {
      const body = await readJson<{
        nodes?: ProxmoxMockNodeConfig[];
        actorId?: string;
      } | ProxmoxMockNodeConfig[]>(request);
      const configs = Array.isArray(body) ? body : body.nodes;
      const actorId = Array.isArray(body) ? "gateway-api" : body.actorId?.trim() || "gateway-api";

      if (!Array.isArray(configs)) {
        return json(response, 422, {
          error: "invalid_proxmox_seed_payload",
          message: "Expected an array or an object with a nodes array."
        });
      }

      const nodes = [];
      const runs = [];

      for (const config of configs) {
        const plan = tryBuild(response, () => proxmoxAdapter.planProvisioning(config));

        if (!plan) {
          return;
        }

        const node = await senderNodeRegistry.register(plan.targetSenderNode);
        const run = await provisioningRunStore.append(
          proxmoxAdapter.simulateProvisioning(plan, node.id)
        );

        nodes.push({
          ...node,
          capabilities: proxmoxAdapter.describeCapabilities(node)
        });
        runs.push(run);
      }

      await auditLog.append({
        actorType: Array.isArray(body) ? "system" : body.actorId ? "operator" : "system",
        actorId,
        action: "proxmox_mock_nodes.seeded",
        targetType: "sender_node",
        targetId: "proxmox",
        riskLevel: "medium",
        metadata: {
          count: nodes.length,
          runIds: runs.map((run) => run.id),
          sideEffects: "local-state-only",
          smtpEnabledByPlatform: false,
          proxmoxApiEnabled: false,
          sshEnabled: false
        }
      });

      return json(response, 201, {
        nodes,
        runs
      });
    }

    if (request.method === "POST" && request.url === "/v1/backups/plan") {
      const body = await readOptionalJson<BackupPlanInput>(request);
      const plan = tryBuild(response, () => buildBackupPlan(body ?? {}));

      if (!plan) {
        return;
      }

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "backup.plan_created",
        targetType: "backup",
        targetId: plan.id,
        riskLevel: "medium",
        metadata: {
          target: plan.target,
          resources: plan.resources,
          dryRun: plan.dryRun,
          sideEffects: plan.sideEffects,
          blockedOperations: plan.blockedOperations
        }
      });

      return json(response, 201, {
        plan
      });
    }

    if (request.method === "POST" && request.url === "/v1/backups/simulate") {
      const body = await readOptionalJson<BackupPlanInput>(request);
      const plan = tryBuild(response, () => buildBackupPlan(body ?? {}));

      if (!plan) {
        return;
      }

      const simulation = await backupSimulationStore.append(
        simulateBackup(plan, await backupSnapshots(plan.resources))
      );

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "backup.simulated",
        targetType: "backup",
        targetId: simulation.id,
        riskLevel: simulation.status === "blocked" ? "high" : "medium",
        metadata: {
          planId: plan.id,
          status: simulation.status,
          snapshots: simulation.snapshots,
          warnings: simulation.warnings,
          dryRun: simulation.dryRun,
          sideEffects: simulation.sideEffects
        }
      });

      return json(response, 201, {
        simulation
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
      const killSwitchDecision = evaluateKillSwitch(await killSwitchStore.get(), "accept_send_request");

      if (!killSwitchDecision.allowed) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "send_request.blocked_by_kill_switch",
          targetType: "campaign",
          targetId: body.campaignId ?? "unknown",
          riskLevel: "critical",
          metadata: {
            recipient: body.recipient?.email,
            decision: killSwitchDecision,
            smtpEnabled: false
          }
        });

        return json(response, 423, {
          allowed: false,
          reason: "kill_switch_active",
          message: killSwitchDecision.message,
          killSwitch: killSwitchDecision.state
        });
      }

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

function tryBuild<T>(response: ServerResponse, factory: () => T): T | undefined {
  try {
    return factory();
  } catch (error) {
    json(response, 422, {
      error: "validation_error",
      message: error instanceof Error ? error.message : "Invalid request payload."
    });
    return undefined;
  }
}

async function backupSnapshots(resources: BackupResource[]): Promise<BackupResourceSnapshot[]> {
  const snapshots: BackupResourceSnapshot[] = [];

  for (const resource of resources) {
    snapshots.push({
      resource,
      count: await countBackupResource(resource),
      source: sourceForBackupResource(resource)
    });
  }

  return snapshots;
}

async function countBackupResource(resource: BackupResource): Promise<number> {
  if (resource === "audit_events") {
    return (await auditLog.list()).length;
  }

  if (resource === "sender_nodes") {
    return (await senderNodeRegistry.list()).length;
  }

  if (resource === "send_jobs") {
    return (await sendQueue.list()).length;
  }

  if (resource === "send_results") {
    return (await sendResultStore.list()).length;
  }

  if (resource === "suppression_entries") {
    return (await suppressionList.list()).length;
  }

  if (resource === "rate_limit_counters") {
    return (await rateLimitStore.list()).length;
  }

  if (resource === "provisioning_runs") {
    return (await provisioningRunStore.list()).length;
  }

  if (resource === "ip_reputation_reports") {
    return (await ipReputationReportStore.list()).length;
  }

  return 0;
}

function sourceForBackupResource(resource: BackupResource): string {
  return `local-file:${resource}`;
}

function isStuckJobRecoveryAction(value: unknown): value is StuckJobRecoveryAction {
  return value === "fail" || value === "requeue";
}

function parseSenderNodeRetirementApprovalRoute(request: IncomingMessage): {
  senderNodeId: string;
} | null {
  const parts = requestUrl(request).pathname.split("/").filter(Boolean);

  if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "sender-nodes" || parts[3] !== "approve-retirement") {
    return null;
  }

  return {
    senderNodeId: decodeURIComponent(parts[2] ?? "")
  };
}

function parseSenderNodeControlRoute(request: IncomingMessage): {
  senderNodeId: string;
  action: SenderNodeManualAction | string;
} | null {
  const parts = requestUrl(request).pathname.split("/").filter(Boolean);

  if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "sender-nodes") {
    return null;
  }

  return {
    senderNodeId: decodeURIComponent(parts[2] ?? ""),
    action: parts[3] ?? ""
  };
}
