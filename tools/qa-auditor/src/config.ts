// Configuracion central del QA Auditor. Toda la entrada llega por variables de
// entorno inyectadas por el workflow de GitHub Actions. Sin valores por defecto
// peligrosos: si falta lo critico, el caller decide degradar a dry-run.

import { SEVERITIES, type Severity } from "./subagents/schema.ts";

export type AuditorConfig = {
  enabled: boolean;
  dryRun: boolean;
  githubToken: string;
  githubApiBase: string;
  repoOwner: string;
  repoName: string;
  anthropicApiKey: string;
  anthropicApiBase: string;
  model: string;
  maxTokensPerSubagent: number;
  maxChangedFiles: number;
  maxDiffBytes: number;
  maxFilePatchBytes: number;
  failOn: Severity;
  postComment: boolean;
  createCheckRun: boolean;
};

export type ConfigResult =
  | { ok: true; config: AuditorConfig }
  | { ok: false; reason: string };

function readEnv(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number.parseInt(readEnv(env, name), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = readEnv(env, name).toLowerCase();
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return fallback;
}

function coerceSeverityThreshold(value: string, fallback: Severity): Severity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as Severity) : fallback;
}

// Construye la config desde el entorno. `argv` permite forzar dry-run por CLI
// (`--dry-run`) ademas de la variable QA_DRY_RUN.
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): ConfigResult {
  const repository = readEnv(env, "GITHUB_REPOSITORY");
  const slashIndex = repository.indexOf("/");
  if (slashIndex <= 0 || slashIndex === repository.length - 1) {
    return { ok: false, reason: "GITHUB_REPOSITORY ausente o invalido (esperado owner/name)" };
  }

  const githubToken = readEnv(env, "QA_GITHUB_TOKEN") || readEnv(env, "GITHUB_TOKEN");
  if (githubToken.length === 0) {
    return { ok: false, reason: "Falta GITHUB_TOKEN/QA_GITHUB_TOKEN para hablar con la API de GitHub" };
  }

  const anthropicApiKey = readEnv(env, "ANTHROPIC_API_KEY");
  const cliDryRun = argv.includes("--dry-run");
  // Sin API key no podemos auditar de verdad: degradamos a dry-run en vez de
  // fallar, para no bloquear el PR por un secreto faltante (p.ej. en forks).
  const dryRun = cliDryRun || readBool(env, "QA_DRY_RUN", false) || anthropicApiKey.length === 0;

  const config: AuditorConfig = {
    enabled: readBool(env, "QA_AUDITOR_ENABLED", true),
    dryRun,
    githubToken,
    githubApiBase: readEnv(env, "GITHUB_API_URL", "https://api.github.com"),
    repoOwner: repository.slice(0, slashIndex),
    repoName: repository.slice(slashIndex + 1),
    anthropicApiKey,
    anthropicApiBase: readEnv(env, "ANTHROPIC_API_BASE", "https://api.anthropic.com"),
    model: readEnv(env, "QA_MODEL", "claude-sonnet-4-6"),
    maxTokensPerSubagent: readInt(env, "QA_MAX_TOKENS", 4096),
    maxChangedFiles: readInt(env, "QA_MAX_FILES", 60),
    maxDiffBytes: readInt(env, "QA_MAX_DIFF_BYTES", 240_000),
    maxFilePatchBytes: readInt(env, "QA_MAX_FILE_PATCH_BYTES", 24_000),
    failOn: coerceSeverityThreshold(readEnv(env, "QA_FAIL_ON", "blocker"), "blocker"),
    postComment: readBool(env, "QA_POST_COMMENT", true),
    createCheckRun: readBool(env, "QA_CREATE_CHECK_RUN", true)
  };

  return { ok: true, config };
}
