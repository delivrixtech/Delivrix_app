import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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
