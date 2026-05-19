import { randomUUID } from "node:crypto";
import type { SkillContext, SkillResponse } from "../../types.js";
import { auditLog } from "../../lib/audit.js";
import { callBedrockSonnet } from "../../lib/bedrock.js";
import { fetchAllReads } from "./gateway-reads.js";
import { buildDailyReportPrompt } from "./prompt-template.js";

export async function handler(ctx: SkillContext): Promise<SkillResponse> {
  const invokeId = randomUUID();
  const today = new Date().toISOString().slice(0, 10);

  await auditLog.append({
    actorType: "openclaw",
    actorId: "openclaw-hostinger-prod",
    action: "oc.skill.report_ops.invoke",
    targetType: "skill_invocation",
    targetId: invokeId,
    riskLevel: "low",
    metadata: { skillSlug: "delivrix-report-ops", triggerUtterance: ctx.utterance, today }
  });

  const reads = await fetchAllReads();
  const okCount = Object.values(reads).filter((result) => result.ok).length;
  const failedCount = 5 - okCount;

  if (failedCount > 0) {
    await auditLog.append({
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: "oc.skill.report_ops.partial_data",
      targetType: "skill_invocation",
      targetId: invokeId,
      riskLevel: "low",
      metadata: {
        endpointsOk: okCount,
        endpointsFailed: failedCount,
        failedList: Object.entries(reads)
          .filter(([, result]) => !result.ok)
          .map(([key, result]) => ({ key, endpoint: result.endpoint, error: result.error }))
      }
    });
  }

  const prompt = buildDailyReportPrompt(reads, today);
  const llmResponse = await callBedrockSonnet({
    prompt,
    maxTokens: 1200,
    temperature: 0.4
  });

  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) {
    await auditLog.append({
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: "oc.skill.report_ops.notion_skipped",
      targetType: "skill_invocation",
      targetId: invokeId,
      riskLevel: "low",
      metadata: {
        reason: "NOTION_API_KEY no presente; side-effect Notion omitido. Decision auditada en .audit/decision-skip-notion-side-effect.md"
      }
    });
  } else {
    await auditLog.append({
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: "oc.skill.report_ops.notion_pending",
      targetType: "skill_invocation",
      targetId: invokeId,
      riskLevel: "low",
      metadata: {
        reason: "NOTION_API_KEY presente pero escritura no implementada en MVP. Ver Hito 5.12."
      }
    });
  }

  await auditLog.append({
    actorType: "openclaw",
    actorId: "openclaw-hostinger-prod",
    action: "oc.skill.report_ops.completed",
    targetType: "skill_invocation",
    targetId: invokeId,
    riskLevel: "low",
    metadata: {
      reportLengthChars: llmResponse.text.length,
      endpointsOk: okCount,
      endpointsFailed: failedCount,
      modelVersion: "us.anthropic.claude-sonnet-4-6",
      promptVersion: "daily-report-v1",
      tokensUsed: llmResponse.tokensUsed
    }
  });

  return {
    output: llmResponse.text,
    metadata: {
      source: "openclaw-managed",
      skillSlug: "delivrix-report-ops",
      invokeId,
      endpointsOk: okCount,
      endpointsFailed: failedCount,
      notionSideEffect: notionApiKey ? "pending" : "skipped"
    }
  };
}
