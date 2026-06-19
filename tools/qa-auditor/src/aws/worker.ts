// Lambda "worker": auditoria pesada, invocada async por el receiver. Mintea un
// installation token (JWT de App -> token), recolecta el contexto, corre los 3
// subagentes (mas el flag de conflicto de merge) y publica comentario + check
// run. Reusa el nucleo de tools/qa-auditor/src. Solo corre en Lambda.

import { loadSecrets } from "./secrets.ts";
import { getInstallationToken } from "../github/app-auth.ts";
import { parseEvent } from "../github/event.ts";
import { createGithubClient } from "../github/client.ts";
import { createBedrockClient } from "../bedrock/client.ts";
import {
  collectDeploymentContext,
  collectPullRequestContext,
  type AuditContext,
  type ContextLimits
} from "../context/collect.ts";
import { runAudit } from "../orchestrator.ts";
import { buildMergeConflictFinding } from "../subagents/merge-conflict.ts";
import { SEVERITIES, type Finding, type Severity } from "../subagents/schema.ts";
import { COMMENT_MARKER } from "../report/render.ts";
import { log, registerSecret } from "../logging.ts";

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function failOnEnv(env: NodeJS.ProcessEnv): Severity {
  const value = env.QA_FAIL_ON ?? "";
  return (SEVERITIES as readonly string[]).includes(value) ? (value as Severity) : "blocker";
}

type WorkerInput = { eventName: string; delivery?: string; payload: any };

export const handler = async (input: WorkerInput): Promise<void> => {
  const secrets = await loadSecrets();
  registerSecret(secrets.githubAppPrivateKey);
  registerSecret(secrets.webhookSecret);

  const payload = input.payload ?? {};
  const repository = payload.repository ?? {};
  const fullName = String(repository.full_name ?? "");
  const slash = fullName.indexOf("/");
  const owner = slash > 0 ? fullName.slice(0, slash) : String(repository.owner?.login ?? "");
  const name = slash > 0 ? fullName.slice(slash + 1) : String(repository.name ?? "");
  const installationId = Number(payload.installation?.id ?? 0);

  if (!owner || !name || !installationId || secrets.appId.length === 0) {
    log.error("worker_payload_incompleto", { owner, name, installationId });
    return;
  }

  const token = await getInstallationToken({
    appId: secrets.appId,
    privateKeyPem: secrets.githubAppPrivateKey,
    installationId
  });
  registerSecret(token.token);

  const client = createGithubClient({ token: token.token, owner, repo: name });
  const target = parseEvent(input.eventName, payload);

  const env = process.env;
  const limits: ContextLimits = {
    maxChangedFiles: intEnv(env, "QA_MAX_FILES", 60),
    maxDiffBytes: intEnv(env, "QA_MAX_DIFF_BYTES", 240_000),
    maxFilePatchBytes: intEnv(env, "QA_MAX_FILE_PATCH_BYTES", 24_000)
  };
  const model =
    env.QA_MODEL && env.QA_MODEL.length > 0 ? env.QA_MODEL : "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const maxTokens = intEnv(env, "QA_MAX_TOKENS", 4096);

  let context: AuditContext;
  let headSha = "";
  const extraFindings: Finding[] = [];

  if (target.kind === "pull_request") {
    if (!PR_ACTIONS.has(target.action) || target.number === 0) {
      log.info("pr_action_ignorada_worker", { action: target.action });
      return;
    }
    context = await collectPullRequestContext(client, target, limits);
    headSha = target.headSha;
    try {
      const pr = await client.getPullRequest(target.number);
      const conflict = buildMergeConflictFinding({
        mergeable: pr.mergeable,
        mergeableState: pr.mergeableState,
        number: pr.number
      });
      if (conflict) {
        extraFindings.push(conflict);
      }
    } catch (error) {
      log.warn("merge_info_no_disponible", { error: String(error) });
    }
  } else if (target.kind === "deployment") {
    if (target.sha.length === 0) {
      return;
    }
    context = await collectDeploymentContext(client, target, limits);
    headSha = target.sha;
  } else {
    log.info("evento_no_soportado_worker", { eventName: input.eventName });
    return;
  }

  const llm = createBedrockClient({ modelId: model, region: env.AWS_REGION });
  const outcome = await runAudit({
    context,
    anthropic: llm,
    model,
    maxTokensPerSubagent: maxTokens,
    failOn: failOnEnv(env),
    headSha,
    dryRun: false,
    extraFindings
  });

  if (target.kind === "pull_request") {
    const result = await client.upsertMarkerComment(target.number, COMMENT_MARKER, outcome.report);
    log.info("comentario_publicado", { pr: target.number, result });
  }
  await client.createCheckRun({
    name: "Delivrix QA Senior",
    headSha,
    conclusion: outcome.conclusion,
    title: `Veredicto: ${outcome.verdict}`,
    summary: outcome.checkSummary,
    text: outcome.report
  });
  log.info("worker_done", {
    verdict: outcome.verdict,
    conclusion: outcome.conclusion,
    findings: outcome.findings.length,
    delivery: input.delivery
  });
};
