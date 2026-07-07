// Parseo del evento de GitHub Actions a un objetivo de auditoria normalizado.
// Cubre el alcance v1: Pull Requests y despliegues reales (deployment /
// deployment_status). El payload llega como JSON en GITHUB_EVENT_PATH.

import { readFile } from "node:fs/promises";

export type PullRequestTarget = {
  kind: "pull_request";
  action: string;
  number: number;
  title: string;
  body: string;
  author: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  labels: string[];
};

export type DeploymentTarget = {
  kind: "deployment";
  deploymentId: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  state: string;
};

export type UnsupportedTarget = {
  kind: "unsupported";
  eventName: string;
};

export type AuditTarget = PullRequestTarget | DeploymentTarget | UnsupportedTarget;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parsePullRequest(payload: Record<string, any>): AuditTarget {
  const pr = payload.pull_request ?? {};
  const labels = Array.isArray(pr.labels)
    ? pr.labels.map((label: any) => str(label?.name)).filter((name: string) => name.length > 0)
    : [];
  return {
    kind: "pull_request",
    action: str(payload.action, "unknown"),
    number: num(pr.number),
    title: str(pr.title),
    body: str(pr.body),
    author: str(pr.user?.login),
    headSha: str(pr.head?.sha),
    baseSha: str(pr.base?.sha),
    baseRef: str(pr.base?.ref),
    labels
  };
}

function parseDeployment(payload: Record<string, any>): AuditTarget {
  const deployment = payload.deployment ?? {};
  const status = payload.deployment_status ?? {};
  return {
    kind: "deployment",
    deploymentId: num(deployment.id),
    sha: str(deployment.sha),
    ref: str(deployment.ref),
    task: str(deployment.task),
    environment: str(deployment.environment),
    state: str(status.state)
  };
}

// Push a una rama de despliegue (p.ej. produ) tratado como un deploy real: se
// audita el commit tip (after) como objetivo de tipo deployment.
function parsePush(payload: Record<string, any>): AuditTarget {
  const ref = str(payload.ref);
  const branch = ref.replace(/^refs\/heads\//, "");
  return {
    kind: "deployment",
    deploymentId: 0,
    sha: str(payload.after),
    ref,
    task: "push",
    environment: branch,
    state: ""
  };
}

// Convierte (eventName, payload) en un AuditTarget. Funcion pura: testeable sin
// tocar el filesystem.
export function parseEvent(eventName: string, payload: Record<string, any>): AuditTarget {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return parsePullRequest(payload);
  }
  if (eventName === "deployment" || eventName === "deployment_status") {
    return parseDeployment(payload);
  }
  if (eventName === "push") {
    return parsePush(payload);
  }
  return { kind: "unsupported", eventName };
}

// Lee el evento real del run de Actions desde GITHUB_EVENT_PATH.
export async function readEventFromActions(
  env: NodeJS.ProcessEnv = process.env
): Promise<AuditTarget> {
  const eventName = str(env.GITHUB_EVENT_NAME, "unknown");
  const eventPath = str(env.GITHUB_EVENT_PATH);
  if (eventPath.length === 0) {
    return { kind: "unsupported", eventName };
  }
  const raw = await readFile(eventPath, "utf8");
  const payload = JSON.parse(raw) as Record<string, any>;
  return parseEvent(eventName, payload);
}
