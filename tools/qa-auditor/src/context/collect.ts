// Recolector de contexto: a partir del objetivo (PR o deployment) consulta a
// GitHub lo estrictamente necesario y aplica el presupuesto. La salida
// (AuditContext) es lo unico que ven los subagentes; nunca reciben el cliente
// ni el token.

import type { GithubClient } from "../github/client.ts";
import type { PullRequestTarget, DeploymentTarget } from "../github/event.ts";
import {
  buildBoundedDiff,
  classifyPath,
  truncate,
  type FileCategory,
  type SkippedFile
} from "./budget.ts";

export type FileIndexEntry = {
  path: string;
  category: FileCategory;
  status: string;
};

export type AuditContext = {
  kind: "pull_request" | "deployment";
  identifier: string;
  title: string;
  body: string;
  author: string;
  changedFileCount: number;
  includedFiles: string[];
  skipped: SkippedFile[];
  truncated: boolean;
  diffText: string;
  fileIndex: FileIndexEntry[];
};

export type ContextLimits = {
  maxChangedFiles: number;
  maxDiffBytes: number;
  maxFilePatchBytes: number;
};

export async function collectPullRequestContext(
  client: GithubClient,
  target: PullRequestTarget,
  limits: ContextLimits
): Promise<AuditContext> {
  const files = await client.listPullRequestFiles(target.number, limits.maxChangedFiles);
  const bounded = buildBoundedDiff(files, {
    maxDiffBytes: limits.maxDiffBytes,
    maxFilePatchBytes: limits.maxFilePatchBytes
  });
  const fileIndex: FileIndexEntry[] = files.map((file) => ({
    path: file.filename,
    category: classifyPath(file.filename),
    status: file.status
  }));

  return {
    kind: "pull_request",
    identifier: `PR #${target.number}`,
    title: target.title,
    body: target.body,
    author: target.author,
    changedFileCount: files.length,
    includedFiles: bounded.includedFiles,
    skipped: bounded.skipped,
    truncated: bounded.truncated,
    diffText: bounded.text,
    fileIndex
  };
}

export async function collectDeploymentContext(
  client: GithubClient,
  target: DeploymentTarget,
  limits: ContextLimits
): Promise<AuditContext> {
  const rawDiff = await client.getCommitDiff(target.sha);
  const bounded = truncate(rawDiff, limits.maxDiffBytes);
  const shortSha = target.sha.slice(0, 7);

  return {
    kind: "deployment",
    identifier: `deploy ${shortSha} -> ${target.environment || "default"}`,
    title: `Despliegue ${shortSha} (${target.task || "deploy"}) a ${target.environment || "default"}`,
    body: `ref=${target.ref} state=${target.state}`,
    author: "",
    changedFileCount: 0,
    includedFiles: [],
    skipped: [],
    truncated: bounded.truncated,
    diffText: bounded.text,
    fileIndex: []
  };
}
