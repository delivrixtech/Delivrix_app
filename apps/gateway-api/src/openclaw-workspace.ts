import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  WarmupRampBatch,
  WarmupRampPauseReason,
  WarmupRampSchedule,
  WarmupRampState
} from "../../../packages/domain/src/warmup/ramp-plan.ts";

export interface OpenClawWorkspaceOptions {
  rootDir?: string;
  now?: () => Date;
}

export interface OpenClawWorkspaceFileRef {
  path: string;
  absolutePath: string;
}

export interface OpenClawWorkspaceExecutionInput {
  skill: string;
  params: Record<string, unknown>;
  outcome: "success" | "blocked" | "failed";
  durationMs: number;
  evidence?: Record<string, unknown>;
}

export interface OpenClawWorkspaceLearning {
  path: string;
  content: string;
}

const defaultWorkspaceDir = process.platform === "darwin"
  ? "runtime/openclaw-workspace"
  : "/data/.openclaw/workspace";
const managedDirs = ["skills", "executions", "learnings", "inventory"] as const;

export class OpenClawWorkspace {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: OpenClawWorkspaceOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? process.env.OPENCLAW_WORKSPACE_DIR ?? defaultWorkspaceDir);
    this.now = options.now ?? (() => new Date());
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async ensureBase(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await Promise.all(managedDirs.map((dirName) => mkdir(join(this.rootDir, dirName), { recursive: true })));
  }

  async writeSkillDefinition(skill: string, content: string): Promise<OpenClawWorkspaceFileRef> {
    await this.ensureBase();
    return this.writeRelative(`skills/${safeSegment(skill)}.v1.md`, content);
  }

  async readLearnings(skill?: string): Promise<OpenClawWorkspaceLearning[]> {
    await this.ensureBase();
    const learningDir = join(this.rootDir, "learnings");
    const entries = await readdir(learningDir, { withFileTypes: true });
    const slug = skill ? safeSegment(skill) : "";
    const learnings: OpenClawWorkspaceLearning[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      if (slug && !entry.name.includes(slug)) {
        continue;
      }
      const absolutePath = join(learningDir, entry.name);
      learnings.push({
        path: this.relativePath(absolutePath),
        content: await readFile(absolutePath, "utf8")
      });
    }

    return learnings.sort((left, right) => left.path.localeCompare(right.path));
  }

  async writeExecutionRecord(input: OpenClawWorkspaceExecutionInput): Promise<OpenClawWorkspaceFileRef> {
    await this.ensureBase();
    const now = this.now();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 19).replaceAll(":", "");
    const domain = stringValue(input.params.domain) ?? stringValue(input.params.hostname) ?? "global";
    const path = [
      "executions",
      date,
      `${time}-${safeSegment(input.skill)}-${safeSegment(domain)}-${input.outcome}.md`
    ].join("/");
    return this.writeRelative(path, renderExecutionMarkdown({
      ...input,
      occurredAt: now.toISOString()
    }));
  }

  async writeLearning(input: {
    skill: string;
    title: string;
    content: string;
  }): Promise<OpenClawWorkspaceFileRef> {
    await this.ensureBase();
    const date = this.now().toISOString().slice(0, 10);
    const path = `learnings/${date}-${safeSegment(input.skill)}-${safeSegment(input.title)}.md`;
    return this.writeRelative(path, input.content);
  }

  async writeWorkspaceFile(path: string, content: string): Promise<OpenClawWorkspaceFileRef> {
    await this.ensureBase();
    const topLevel = path.split(/[\\/]/g)[0];
    if (!managedDirs.includes(topLevel as (typeof managedDirs)[number])) {
      throw new Error(`OpenClaw workspace file must be inside ${managedDirs.join(", ")}.`);
    }
    return this.writeRelative(path, content);
  }

  async readWorkspaceFile(path: string): Promise<string> {
    await this.ensureBase();
    const topLevel = path.split(/[\\/]/g)[0];
    if (!managedDirs.includes(topLevel as (typeof managedDirs)[number])) {
      throw new Error(`OpenClaw workspace file must be inside ${managedDirs.join(", ")}.`);
    }
    return readFile(this.resolveRelative(path), "utf8");
  }

  async updateInventoryJson<T>(
    name: string,
    updater: (current: T | null) => T
  ): Promise<OpenClawWorkspaceFileRef> {
    await this.ensureBase();
    const path = `inventory/${inventoryBaseName(name)}.json`;
    const current = await this.readInventoryJson<T>(name);
    return this.writeRelative(path, `${JSON.stringify(updater(current), null, 2)}\n`);
  }

  async readInventoryJson<T>(name: string): Promise<T | null> {
    await this.ensureBase();
    const absolutePath = this.resolveRelative(`inventory/${inventoryBaseName(name)}.json`);
    try {
      return JSON.parse(await readFile(absolutePath, "utf8")) as T;
    } catch {
      return null;
    }
  }

  async snapshot(): Promise<{ rootDir: string; files: string[] }> {
    await this.ensureBase();
    const files: string[] = [];
    for (const dirName of managedDirs) {
      await collectFiles(join(this.rootDir, dirName), this.rootDir, files);
    }
    return {
      rootDir: this.rootDir,
      files: files.sort()
    };
  }

  private async writeRelative(path: string, content: string): Promise<OpenClawWorkspaceFileRef> {
    const absolutePath = this.resolveRelative(path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    return {
      path: this.relativePath(absolutePath),
      absolutePath
    };
  }

  private resolveRelative(path: string): string {
    const absolutePath = resolve(this.rootDir, path);
    const rel = relative(this.rootDir, absolutePath);
    if (rel.startsWith("..") || rel === "") {
      throw new Error(`OpenClaw workspace path escapes root: ${path}`);
    }
    return absolutePath;
  }

  private relativePath(absolutePath: string): string {
    return relative(this.rootDir, absolutePath).split(/[\\/]/g).join("/");
  }
}

async function collectFiles(dir: string, rootDir: string, output: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolutePath, rootDir, output);
      continue;
    }
    if (entry.isFile()) {
      output.push(relative(rootDir, absolutePath).split(/[\\/]/g).join("/"));
    }
  }
}

function renderExecutionMarkdown(input: OpenClawWorkspaceExecutionInput & { occurredAt: string }): string {
  return [
    `# ${input.skill} · ${input.outcome}`,
    "",
    `- occurredAt: ${input.occurredAt}`,
    `- durationMs: ${input.durationMs}`,
    "",
    "## Params",
    "",
    "```json",
    JSON.stringify(input.params, null, 2),
    "```",
    "",
    "## Evidence",
    "",
    "```json",
    JSON.stringify(input.evidence ?? {}, null, 2),
    "```",
    ""
  ].join("\n");
}

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || "unknown";
}

function inventoryBaseName(value: string): string {
  return safeSegment(value.replace(/\.json$/i, ""));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Snapshot persistido de un ramp gradual de warmup. Vive en
 * `inventory/warmup-progress.json` bajo el array `ramps[]`, lado a lado con
 * los `runs[]` legacy del seed inicial.
 */
export interface WarmupRampRecord {
  rampId: string;
  domain: string;
  serverSlug: string | null;
  serverIp: string;
  schedule: WarmupRampSchedule;
  state: WarmupRampState;
  pauseReason?: WarmupRampPauseReason;
  recipientPool: string[];
  totalPlanned: number;
  totalSent: number;
  totalBounced: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  nextBatchAt?: string;
  batches: WarmupRampBatch[];
  actorId: string;
  approvalToken: string;
}

export interface WarmupRampEventRecord {
  rampId: string;
  occurredAt: string;
  action:
    | "oc.warmup.ramp_started"
    | "oc.warmup.ramp_batch_sent"
    | "oc.warmup.ramp_paused"
    | "oc.warmup.ramp_resumed"
    | "oc.warmup.ramp_completed"
    | "oc.warmup.ramp_failed";
  batchIndex?: number;
  metadata: Record<string, unknown>;
}

interface WarmupProgressInventory {
  runs?: unknown[];
  ramps?: WarmupRampRecord[];
  rampEvents?: WarmupRampEventRecord[];
}

export async function appendWarmupRamp(
  workspace: OpenClawWorkspace,
  ramp: WarmupRampRecord
): Promise<void> {
  await workspace.updateInventoryJson<WarmupProgressInventory>(
    "warmup-progress.json",
    (current) => ({
      ...(current ?? {}),
      runs: current?.runs ?? [],
      ramps: [...(current?.ramps ?? []), ramp],
      rampEvents: current?.rampEvents ?? []
    })
  );
}

export async function updateWarmupRamp(
  workspace: OpenClawWorkspace,
  rampId: string,
  patch: Partial<WarmupRampRecord>
): Promise<WarmupRampRecord | null> {
  let updated: WarmupRampRecord | null = null;
  await workspace.updateInventoryJson<WarmupProgressInventory>(
    "warmup-progress.json",
    (current) => {
      const ramps = current?.ramps ?? [];
      const next = ramps.map((ramp) => {
        if (ramp.rampId !== rampId) return ramp;
        const merged: WarmupRampRecord = { ...ramp, ...patch, rampId: ramp.rampId };
        updated = merged;
        return merged;
      });
      return {
        ...(current ?? {}),
        runs: current?.runs ?? [],
        ramps: next,
        rampEvents: current?.rampEvents ?? []
      };
    }
  );
  return updated;
}

export async function appendWarmupRampEvent(
  workspace: OpenClawWorkspace,
  event: WarmupRampEventRecord
): Promise<void> {
  await workspace.updateInventoryJson<WarmupProgressInventory>(
    "warmup-progress.json",
    (current) => ({
      ...(current ?? {}),
      runs: current?.runs ?? [],
      ramps: current?.ramps ?? [],
      rampEvents: [...(current?.rampEvents ?? []), event]
    })
  );
}

export async function getActiveRamps(
  workspace: OpenClawWorkspace
): Promise<WarmupRampRecord[]> {
  const inventory = await workspace
    .readInventoryJson<WarmupProgressInventory>("warmup-progress.json")
    .catch(() => null);
  const ramps = inventory?.ramps ?? [];
  return ramps.filter(
    (ramp) => ramp.state === "running" || ramp.state === "paused" || ramp.state === "auto_paused"
  );
}

export async function getRampById(
  workspace: OpenClawWorkspace,
  rampId: string
): Promise<WarmupRampRecord | null> {
  const inventory = await workspace
    .readInventoryJson<WarmupProgressInventory>("warmup-progress.json")
    .catch(() => null);
  return inventory?.ramps?.find((ramp) => ramp.rampId === rampId) ?? null;
}

export async function getRampByDomain(
  workspace: OpenClawWorkspace,
  domain: string
): Promise<WarmupRampRecord | null> {
  const inventory = await workspace
    .readInventoryJson<WarmupProgressInventory>("warmup-progress.json")
    .catch(() => null);
  const ramps = inventory?.ramps ?? [];
  const normalized = domain.toLowerCase();
  const active = ramps.find(
    (ramp) =>
      ramp.domain.toLowerCase() === normalized &&
      (ramp.state === "running" || ramp.state === "paused" || ramp.state === "auto_paused")
  );
  if (active) return active;
  return ramps.filter((ramp) => ramp.domain.toLowerCase() === normalized).at(-1) ?? null;
}
