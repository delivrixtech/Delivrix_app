// Entrypoint del QA Auditor en GitHub Actions.
// Flujo: config -> kill-switch -> parse evento -> recolectar contexto ->
// runAudit (3 subagentes) -> publicar (comentario + check run + step summary).
// Postura fail-open: un problema de infra del auditor NO debe tumbar el PR; el
// gating real lo da la conclusion del check run + branch protection.

import { appendFile, writeFile } from "node:fs/promises";
import { loadConfig, type AuditorConfig } from "./config.ts";
import { log, registerSecret } from "./logging.ts";
import { readEventFromActions, type AuditTarget } from "./github/event.ts";
import { createGithubClient, type GithubClient } from "./github/client.ts";
import { createAnthropicClient } from "./anthropic/client.ts";
import {
  collectDeploymentContext,
  collectPullRequestContext,
  type AuditContext
} from "./context/collect.ts";
import { runAudit, type AuditOutcome } from "./orchestrator.ts";
import { COMMENT_MARKER } from "./report/render.ts";

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "edited"]);

async function writeArtifacts(config: AuditorConfig, outcome: AuditOutcome): Promise<void> {
  await writeFile("qa-audit-report.md", outcome.report, "utf8");
  await writeFile(
    "qa-audit-report.json",
    JSON.stringify(
      {
        verdict: outcome.verdict,
        conclusion: outcome.conclusion,
        counts: outcome.counts,
        subagents: `${outcome.subagentsOk}/${outcome.subagentsTotal}`,
        findings: outcome.findings,
        perDimension: outcome.perDimension
      },
      null,
      2
    ),
    "utf8"
  );
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, `${outcome.report}\n`, "utf8");
  }
}

async function publish(
  client: GithubClient,
  config: AuditorConfig,
  target: AuditTarget,
  outcome: AuditOutcome,
  headSha: string
): Promise<void> {
  if (config.dryRun) {
    log.info("dry_run_skip_publish", { verdict: outcome.verdict, conclusion: outcome.conclusion });
    return;
  }

  if (target.kind === "pull_request" && config.postComment) {
    const result = await client.upsertMarkerComment(target.number, COMMENT_MARKER, outcome.report);
    log.info("comment_published", { pr: target.number, result });
  }

  if (config.createCheckRun) {
    await client.createCheckRun({
      name: "Delivrix QA Senior",
      headSha,
      conclusion: outcome.conclusion,
      title: `Veredicto: ${outcome.verdict}`,
      summary: outcome.checkSummary,
      text: outcome.report
    });
    log.info("check_run_published", { conclusion: outcome.conclusion });
  }
}

async function resolveContext(
  client: GithubClient,
  config: AuditorConfig,
  target: AuditTarget
): Promise<{ context: AuditContext; headSha: string } | null> {
  const limits = {
    maxChangedFiles: config.maxChangedFiles,
    maxDiffBytes: config.maxDiffBytes,
    maxFilePatchBytes: config.maxFilePatchBytes
  };

  if (target.kind === "pull_request") {
    if (!PR_ACTIONS.has(target.action) || target.number === 0) {
      log.info("pr_action_ignorada", { action: target.action, number: target.number });
      return null;
    }
    const context = await collectPullRequestContext(client, target, limits);
    return { context, headSha: target.headSha };
  }

  if (target.kind === "deployment") {
    if (target.sha.length === 0) {
      log.warn("deployment_sin_sha");
      return null;
    }
    const context = await collectDeploymentContext(client, target, limits);
    return { context, headSha: target.sha };
  }

  log.info("evento_no_soportado", { eventName: target.eventName });
  return null;
}

async function main(): Promise<number> {
  const loaded = loadConfig();
  if (!loaded.ok) {
    log.error("config_invalida", { reason: loaded.reason });
    return 0; // fail-open: no tumbar el PR por config
  }
  const config = loaded.config;
  registerSecret(config.githubToken);
  registerSecret(config.anthropicApiKey);

  if (!config.enabled) {
    log.warn("kill_switch_activo", { hint: "QA_AUDITOR_ENABLED=false" });
    return 0;
  }

  if (config.anthropicApiKey.length === 0) {
    log.warn("anthropic_key_ausente", { hint: "se omite la auditoria (probable fork sin secretos)" });
    return 0;
  }

  const target = await readEventFromActions();
  const client = createGithubClient({
    token: config.githubToken,
    owner: config.repoOwner,
    repo: config.repoName,
    apiBase: config.githubApiBase
  });

  const resolved = await resolveContext(client, config, target);
  if (resolved === null) {
    return 0;
  }

  const anthropic = createAnthropicClient({
    apiKey: config.anthropicApiKey,
    model: config.model,
    apiBase: config.anthropicApiBase
  });

  const outcome = await runAudit({
    context: resolved.context,
    anthropic,
    model: config.model,
    maxTokensPerSubagent: config.maxTokensPerSubagent,
    failOn: config.failOn,
    headSha: resolved.headSha,
    dryRun: config.dryRun
  });

  log.info("auditoria_completa", {
    verdict: outcome.verdict,
    conclusion: outcome.conclusion,
    findings: outcome.findings.length,
    subagents: `${outcome.subagentsOk}/${outcome.subagentsTotal}`
  });

  await writeArtifacts(config, outcome);
  await publish(client, config, target, outcome, resolved.headSha);

  // Gating opcional del job: por defecto fail-open (0). Con QA_EXIT_ON_FAIL=true
  // el job falla cuando el check seria failure.
  const exitOnFail = (process.env.QA_EXIT_ON_FAIL ?? "false").toLowerCase() === "true";
  return exitOnFail && outcome.conclusion === "failure" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    log.error("error_inesperado", { error: String(error) });
    // fail-open ante errores no controlados.
    process.exitCode = 0;
  });
