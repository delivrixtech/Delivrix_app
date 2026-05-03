import {
  RateLimitService,
  SenderNodeRegistry,
  evaluateKillSwitch,
  getOperatingNorthSnapshot,
  requestRateLimitRules,
  senderNodeRateLimitRule,
  simulateSendResult
} from "../../../packages/domain/src/index.ts";
import {
  LocalFileAuditLog,
  LocalFileKillSwitchStore,
  LocalFileRateLimitStore,
  LocalFileSendResultStore,
  LocalFileSenderNodeStore
} from "../../../packages/local-store/src/index.ts";
import { LocalFileSendQueue } from "../../../packages/queue/src/index.ts";

const queue = new LocalFileSendQueue();
const auditLog = new LocalFileAuditLog();
const killSwitchStore = new LocalFileKillSwitchStore();
const sendResultStore = new LocalFileSendResultStore();
const senderNodeRegistry = new SenderNodeRegistry(new LocalFileSenderNodeStore());
const rateLimitService = new RateLimitService(new LocalFileRateLimitStore());
const requestRateLimitProfile = {
  campaignDailyLimit: Number(process.env.RATE_LIMIT_CAMPAIGN_DAILY ?? 100),
  senderDomainDailyLimit: Number(process.env.RATE_LIMIT_SENDER_DOMAIN_DAILY ?? 300),
  recipientDomainDailyLimit: Number(process.env.RATE_LIMIT_RECIPIENT_DOMAIN_DAILY ?? 100)
};
const operatingNorth = getOperatingNorthSnapshot();
console.log("control-worker ready");
console.log(`phase=${operatingNorth.phase} mode=control-plane-safe-no-smtp`);
console.log("role=delivrix-internal-ops-worker nfc_sends_real_email=true");

const killSwitchDecision = evaluateKillSwitch(await killSwitchStore.get(), "claim_send_job");

if (!killSwitchDecision.allowed) {
  await auditLog.append({
    actorType: "system",
    actorId: "worker",
    action: "worker.blocked_by_kill_switch",
    targetType: "operation",
    targetId: "claim_send_job",
    riskLevel: "critical",
    metadata: {
      decision: killSwitchDecision,
      smtpEnabled: false
    }
  });
  console.log(killSwitchDecision.message);
  console.log("No job was claimed.");
  process.exit(0);
}

const job = await queue.claimNext();

if (!job) {
  console.log("No queued jobs found.");
} else {
  console.log(`Claimed ${job.id} for ${job.request.recipient.email}`);
  await auditLog.append({
    actorType: "system",
    actorId: "worker",
    action: "send_job.claimed",
    targetType: "send_job",
    targetId: job.id,
    riskLevel: "low",
    metadata: {
      recipient: job.request.recipient.email,
      campaignId: job.request.campaignId
    }
  });

  const senderNode = await senderNodeRegistry.findAvailableFor(job.request);

  if (!senderNode) {
    const reason = "No available sender node. Register Webdock bridge nodes before processing.";
    await queue.markFailed(job.id, reason);
    await auditLog.append({
      actorType: "system",
      actorId: "worker",
      action: "send_job.failed_no_sender_node",
      targetType: "send_job",
      targetId: job.id,
      riskLevel: "medium",
      metadata: {
        reason,
        smtpEnabled: false
      }
    });
    console.log(reason);
  } else {
    await queue.assignSenderNode(job.id, senderNode.id);
    await auditLog.append({
      actorType: "system",
      actorId: "worker",
      action: "send_job.sender_node_assigned",
      targetType: "send_job",
      targetId: job.id,
      riskLevel: "low",
      metadata: {
        senderNodeId: senderNode.id,
        provider: senderNode.provider,
        status: senderNode.status,
        smtpEnabled: false
      }
    });

    console.log(`Assigned sender node ${senderNode.id}`);
    const rateLimitRules = [
      ...requestRateLimitRules(job.request, requestRateLimitProfile),
      senderNodeRateLimitRule(senderNode)
    ];
    const rateLimitDecision = await rateLimitService.consume(rateLimitRules);

    if (!rateLimitDecision.allowed) {
      const reason = "Rate limit exceeded during worker enforcement.";
      await queue.markBlocked(job.id, reason);
      await auditLog.append({
        actorType: "system",
        actorId: "worker",
        action: "send_job.rate_limited",
        targetType: "send_job",
        targetId: job.id,
        riskLevel: "medium",
        metadata: {
          reason,
          violations: rateLimitDecision.violations,
          senderNodeId: senderNode.id,
          smtpEnabled: false
        }
      });
      console.log(reason);
    } else {
      console.log("SMTP is disabled in Base 1/2; generating simulated result.");
      const simulatedResult = simulateSendResult({
        ...job,
        senderNodeId: senderNode.id
      });
      const result = await sendResultStore.create({
        sendJobId: job.id,
        senderNodeId: senderNode.id,
        ...simulatedResult
      });
      const jobFailed = result.status === "failed";

      if (jobFailed) {
        await queue.markFailed(job.id, "Simulated send result failed.");
      } else {
        await queue.markCompleted(job.id);
      }

      await auditLog.append({
        actorType: "system",
        actorId: "worker",
        action: "send_result.simulated",
        targetType: "send_result",
        targetId: result.id,
        riskLevel: result.status === "complaint" || result.status === "bounce" ? "medium" : "low",
        metadata: {
          sendJobId: job.id,
          senderNodeId: senderNode.id,
          status: result.status,
          smtpEnabled: false,
          phase: "base-2"
        }
      });

      console.log(`Recorded simulated result ${result.status} for ${job.id}`);
    }
  }
}
