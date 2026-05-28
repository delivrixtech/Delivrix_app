import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";

const defaultWorkspaceDir = process.platform === "darwin"
  ? "runtime/openclaw-workspace"
  : "/data/.openclaw/workspace";
const defaultMaxFileBytes = 1024 * 1024;

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface OpenClawWorkspaceRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog?: AuditSink;
  rootDir?: string;
  maxFileBytes?: number;
  rateLimiter?: WorkspaceReadRateLimiter;
  now?: () => Date;
}

export interface WorkspaceTreeResponse {
  path: string;
  nodes: WorkspaceNode[];
  source: {
    kind: "live" | "mock";
    trusted: boolean;
  };
}

export interface WorkspaceFileResponse {
  path: string;
  content: string;
  mimeType: string;
  size: number;
  source: {
    kind: "live" | "mock";
    trusted: boolean;
  };
}

export interface WorkspaceNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

interface ResolvedWorkspacePath {
  absolutePath: string;
  workspacePath: string;
}

export class OpenClawWorkspaceRouteError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = "OpenClawWorkspaceRouteError";
  }
}

export class WorkspaceReadRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly nowMs: () => number;

  constructor(
    limit = 120,
    windowMs = 60_000,
    nowMs = () => Date.now()
  ) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.nowMs = nowMs;
  }

  consume(key: string): boolean {
    const now = this.nowMs();
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) {
      return false;
    }
    current.count += 1;
    return true;
  }
}

export async function handleOpenClawWorkspaceTreeHttp(
  deps: OpenClawWorkspaceRouteDependencies
): Promise<void> {
  enforceRateLimit(deps);
  const requestedPath = new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams.get("path") ?? "/";
  const resolvedPath = await resolveWorkspacePath(deps.rootDir, requestedPath);
  const targetStat = await lstat(resolvedPath.absolutePath);
  if (!targetStat.isDirectory()) {
    throw new OpenClawWorkspaceRouteError(404, "not_directory", "Workspace path is not a directory.");
  }

  const entries = await readdir(resolvedPath.absolutePath, { withFileTypes: true });
  const nodes: WorkspaceNode[] = [];
  for (const entry of entries) {
    const childPath = joinWorkspacePath(resolvedPath.workspacePath, entry.name);
    if (isSensitiveWorkspacePath(childPath) || entry.isSymbolicLink()) {
      continue;
    }

    const childAbsolutePath = resolve(resolvedPath.absolutePath, entry.name);
    const childStat = await lstat(childAbsolutePath);
    if (!childStat.isDirectory() && !childStat.isFile()) {
      continue;
    }

    nodes.push({
      name: entry.name,
      path: childPath,
      kind: childStat.isDirectory() ? "directory" : "file",
      ...(childStat.isFile() ? {
        size: childStat.size,
        mimeType: workspaceMimeType(entry.name)
      } : {}),
      modifiedAt: childStat.mtime.toISOString()
    });
  }

  nodes.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  await auditWorkspaceRead(deps, {
    action: "oc.workspace.read_tree",
    targetId: resolvedPath.workspacePath,
    metadata: {
      path: resolvedPath.workspacePath,
      nodeCount: nodes.length
    }
  });

  json(deps.response, 200, {
    path: resolvedPath.workspacePath,
    nodes,
    source: {
      kind: "live",
      trusted: true
    }
  } satisfies WorkspaceTreeResponse);
}

export async function handleOpenClawWorkspaceFileHttp(
  deps: OpenClawWorkspaceRouteDependencies
): Promise<void> {
  enforceRateLimit(deps);
  const requestedPath = new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams.get("path");
  if (!requestedPath) {
    throw new OpenClawWorkspaceRouteError(400, "invalid_path", "Workspace file path is required.");
  }

  const resolvedPath = await resolveWorkspacePath(deps.rootDir, requestedPath);
  if (isSensitiveWorkspacePath(resolvedPath.workspacePath)) {
    throw new OpenClawWorkspaceRouteError(403, "forbidden_path", "Workspace path is not exposed through the browser.");
  }

  const targetStat = await lstat(resolvedPath.absolutePath);
  if (!targetStat.isFile()) {
    throw new OpenClawWorkspaceRouteError(404, "not_file", "Workspace path is not a file.");
  }

  const size = (await stat(resolvedPath.absolutePath)).size;
  const maxFileBytes = deps.maxFileBytes ?? defaultMaxFileBytes;
  if (size > maxFileBytes) {
    throw new OpenClawWorkspaceRouteError(413, "file_too_large", "Workspace file exceeds the response size cap.");
  }

  const content = await readFile(resolvedPath.absolutePath, "utf8");
  const mimeType = workspaceMimeType(resolvedPath.workspacePath);

  await auditWorkspaceRead(deps, {
    action: "oc.workspace.read_file",
    targetId: resolvedPath.workspacePath,
    metadata: {
      path: resolvedPath.workspacePath,
      size,
      mimeType
    }
  });

  json(deps.response, 200, {
    path: resolvedPath.workspacePath,
    content,
    mimeType,
    size,
    source: {
      kind: "live",
      trusted: true
    }
  } satisfies WorkspaceFileResponse);
}

export function handleOpenClawWorkspaceError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof OpenClawWorkspaceRouteError) {
    json(response, error.statusCode, {
      error: error.code,
      message: error.message
    });
    return true;
  }

  if (isNodeError(error) && error.code === "ENOENT") {
    json(response, 404, {
      error: "path_not_found",
      message: "Workspace path was not found."
    });
    return true;
  }

  return false;
}

async function resolveWorkspacePath(rootDir: string | undefined, requestedPath: string): Promise<ResolvedWorkspacePath> {
  const root = resolve(rootDir ?? process.env.OPENCLAW_WORKSPACE_DIR ?? defaultWorkspaceDir);
  const normalizedPath = normalizeWorkspacePath(requestedPath);
  if (isSensitiveWorkspacePath(normalizedPath)) {
    throw new OpenClawWorkspaceRouteError(403, "forbidden_path", "Workspace path is not exposed through the browser.");
  }

  const relativePath = normalizedPath === "/" ? "" : normalizedPath.slice(1);
  const absolutePath = resolve(root, relativePath);
  assertInsideRoot(root, absolutePath);

  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(absolutePath)
  ]);
  assertInsideRoot(realRoot, realTarget);

  return {
    absolutePath: realTarget,
    workspacePath: normalizedPath
  };
}

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  if (trimmed.includes("\0")) {
    throw new OpenClawWorkspaceRouteError(400, "invalid_path", "Workspace path is invalid.");
  }

  const normalized = trimmed.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new OpenClawWorkspaceRouteError(400, "invalid_path", "Workspace path may not contain traversal segments.");
  }

  return `/${parts.join("/")}`;
}

function assertInsideRoot(rootDir: string, absolutePath: string): void {
  const rel = relative(rootDir, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new OpenClawWorkspaceRouteError(400, "invalid_path", "Workspace path escapes the OpenClaw workspace root.");
  }
}

function joinWorkspacePath(parentPath: string, name: string): string {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

function workspaceMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/x-ndjson";
    case ".txt":
    case ".log":
      return "text/plain";
    default:
      return "text/plain";
  }
}

function isSensitiveWorkspacePath(path: string): boolean {
  const parts = path.split("/").filter(Boolean).map((part) => part.toLowerCase());
  const fileName = parts.at(-1) ?? "";
  return (
    parts.includes("dkim-keys") ||
    fileName.endsWith(".private") ||
    fileName.endsWith(".key") ||
    fileName.endsWith(".pem") ||
    fileName.includes("secret") ||
    fileName.includes("credential")
  );
}

function enforceRateLimit(deps: OpenClawWorkspaceRouteDependencies): void {
  if (!deps.rateLimiter) {
    return;
  }
  if (!deps.rateLimiter.consume(rateLimitKey(deps.request))) {
    throw new OpenClawWorkspaceRouteError(429, "rate_limited", "Workspace browser read rate limit exceeded.");
  }
}

function rateLimitKey(request: IncomingMessage): string {
  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return forwardedIp?.split(",")[0]?.trim() || request.socket?.remoteAddress || "local";
}

async function auditWorkspaceRead(
  deps: OpenClawWorkspaceRouteDependencies,
  input: {
    action: "oc.workspace.read_tree" | "oc.workspace.read_file";
    targetId: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  if (!deps.auditLog) {
    return;
  }
  await deps.auditLog.append({
    actorType: "operator",
    actorId: "operator-via-panel",
    action: input.action,
    targetType: "openclaw_workspace_path",
    targetId: auditTargetId(input.targetId),
    riskLevel: "low",
    decision: "n/a",
    metadata: {
      ...input.metadata,
      readOnly: true,
      occurredVia: "admin-panel"
    }
  });
}

function auditTargetId(path: string): string {
  if (path.length <= 256) {
    return path;
  }
  return `${path.slice(0, 220)}:${path.slice(-35)}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}
