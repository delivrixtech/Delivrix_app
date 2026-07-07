// Cliente REST de GitHub basado en fetch nativo (Node 24): cero dependencias.
// El token se inyecta; en CI viene del GITHUB_TOKEN del workflow o de un token
// de instalacion de la GitHub App. fetchImpl es inyectable para tests offline.

import { log } from "../logging.ts";

export type ChangedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousFilename?: string;
};

export type IssueComment = {
  id: number;
  body: string;
  user: string;
};

export type CheckRunInput = {
  name: string;
  headSha: string;
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  text: string;
};

export type GithubClientOptions = {
  token: string;
  owner: string;
  repo: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

type RequestOptions = {
  method?: string;
  accept?: string;
  body?: unknown;
  rawText?: boolean;
};

const API_VERSION = "2022-11-28";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGithubClient(options: GithubClientOptions) {
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const owner = options.owner;
  const repo = options.repo;

  async function request(path: string, opts: RequestOptions = {}): Promise<any> {
    const url = path.startsWith("http") ? path : `${apiBase}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: opts.accept ?? "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": "delivrix-qa-auditor"
    };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let lastError = "unknown";
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await fetchImpl(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      });

      if (response.ok) {
        return opts.rawText ? await response.text() : await response.json();
      }

      // 5xx y rate limit secundario son reintetables; el resto no.
      const retryable = response.status >= 500 || response.status === 429 || response.status === 403;
      lastError = `github_http_${response.status}`;
      if (!retryable || attempt === maxRetries) {
        const detail = await response.text().catch(() => "");
        throw new Error(`GitHub ${opts.method ?? "GET"} ${path} -> ${response.status} ${detail.slice(0, 300)}`);
      }
      const backoffMs = 500 * 2 ** attempt;
      log.warn("github_retry", { path, status: response.status, attempt, backoffMs });
      await sleep(backoffMs);
    }
    throw new Error(`GitHub request agotada: ${lastError}`);
  }

  async function getPullRequestDiff(prNumber: number): Promise<string> {
    return request(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      accept: "application/vnd.github.diff",
      rawText: true
    });
  }

  // Lee un archivo del repo (contents API) en un ref dado. null si no existe
  // (404) o no es un blob base64. Se usa para QA_CONTEXT.md desde la rama base.
  async function getFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const json: any = await request(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      if (json && typeof json.content === "string" && json.encoding === "base64") {
        return Buffer.from(json.content, "base64").toString("utf8");
      }
      return null;
    } catch {
      return null;
    }
  }

  async function listPullRequestFiles(prNumber: number, maxFiles: number): Promise<ChangedFile[]> {
    const perPage = 100;
    const files: ChangedFile[] = [];
    for (let page = 1; files.length < maxFiles && page <= 20; page += 1) {
      const batch: any[] = await request(
        `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`
      );
      for (const item of batch) {
        files.push({
          filename: String(item.filename ?? ""),
          status: String(item.status ?? ""),
          additions: Number(item.additions ?? 0),
          deletions: Number(item.deletions ?? 0),
          changes: Number(item.changes ?? 0),
          patch: typeof item.patch === "string" ? item.patch : undefined,
          previousFilename:
            typeof item.previous_filename === "string" ? item.previous_filename : undefined
        });
      }
      if (batch.length < perPage) {
        break;
      }
    }
    return files.slice(0, maxFiles);
  }

  async function getPullRequest(prNumber: number): Promise<{
    mergeable: boolean | null;
    mergeableState: string;
    number: number;
    headSha: string;
    baseSha: string;
    title: string;
    body: string;
  }> {
    const pr: any = await request(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return {
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      mergeableState: String(pr.mergeable_state ?? "unknown"),
      number: Number(pr.number ?? prNumber),
      headSha: String(pr.head?.sha ?? ""),
      baseSha: String(pr.base?.sha ?? ""),
      title: String(pr.title ?? ""),
      body: String(pr.body ?? "")
    };
  }

  async function getCommitDiff(sha: string): Promise<string> {
    return request(`/repos/${owner}/${repo}/commits/${sha}`, {
      accept: "application/vnd.github.diff",
      rawText: true
    });
  }

  async function listIssueComments(issueNumber: number): Promise<IssueComment[]> {
    const batch: any[] = await request(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
    );
    return batch.map((item) => ({
      id: Number(item.id ?? 0),
      body: String(item.body ?? ""),
      user: String(item.user?.login ?? "")
    }));
  }

  async function createIssueComment(issueNumber: number, body: string): Promise<void> {
    await request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: { body }
    });
  }

  async function updateIssueComment(commentId: number, body: string): Promise<void> {
    await request(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: { body }
    });
  }

  // Idempotencia: en cada synchronize del PR actualizamos NUESTRO comentario en
  // vez de crear uno nuevo. Identificamos el comentario por un marcador HTML
  // oculto incluido en el cuerpo.
  async function upsertMarkerComment(
    issueNumber: number,
    marker: string,
    body: string
  ): Promise<"created" | "updated"> {
    const comments = await listIssueComments(issueNumber);
    const existing = comments.find((comment) => comment.body.includes(marker));
    if (existing) {
      await updateIssueComment(existing.id, body);
      return "updated";
    }
    await createIssueComment(issueNumber, body);
    return "created";
  }

  async function createCheckRun(input: CheckRunInput): Promise<void> {
    await request(`/repos/${owner}/${repo}/check-runs`, {
      method: "POST",
      body: {
        name: input.name,
        head_sha: input.headSha,
        status: "completed",
        conclusion: input.conclusion,
        output: {
          title: input.title,
          summary: input.summary,
          text: input.text.slice(0, 60_000)
        }
      }
    });
  }

  return {
    getPullRequestDiff,
    getPullRequest,
    getFileContent,
    listPullRequestFiles,
    getCommitDiff,
    listIssueComments,
    createIssueComment,
    updateIssueComment,
    upsertMarkerComment,
    createCheckRun
  };
}

export type GithubClient = ReturnType<typeof createGithubClient>;
