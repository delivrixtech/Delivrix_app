import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  EpisodicScratchValidationError,
  queryByInputHash,
  queryByIntent,
  queryByToolAndOutcome,
  retrieveTrustWeighted,
  type EpisodicEntry,
  type ScratchOutcome
} from "../../../../packages/storage/src/index.ts";

interface EpisodicScratchReadDeps {
  request: IncomingMessage;
  response: ServerResponse;
  pool: Pick<Pool, "query">;
  readBoundaryToken?: string;
}

const secretKeyPattern = /token|secret|password|private|api[_-]?key|credential|authorization/i;

export async function handleReadEpisodicScratchHttp(deps: EpisodicScratchReadDeps): Promise<void> {
  if (deps.readBoundaryToken && deps.request.headers["x-delivrix-token"] !== deps.readBoundaryToken) {
    return json(deps.response, 401, { error: "read_boundary_token_invalid" });
  }

  try {
    const url = requestUrl(deps.request);
    const intentId = optionalParam(url, "intentId");
    const inputHash = optionalParam(url, "inputHash");
    const tool = optionalParam(url, "tool");
    const outcome = optionalParam(url, "outcome");
    const sinceDays = optionalIntegerParam(url, "sinceDays");
    const limit = optionalIntegerParam(url, "limit");
    const weighted = url.searchParams.get("weighted") === "true";

    if (!intentId && !inputHash && !tool) {
      return json(deps.response, 400, {
        error: "missing_query",
        details: "Provide intentId, inputHash, or tool."
      });
    }

    let entries: EpisodicEntry[];
    if (intentId) {
      entries = await queryByIntent(deps.pool, intentId);
    } else if (inputHash) {
      entries = await queryByInputHash(deps.pool, inputHash, {
        ...(tool ? { tool } : {}),
        ...(sinceDays === undefined ? {} : { sinceDays })
      });
    } else if (tool && outcome) {
      entries = await queryByToolAndOutcome(deps.pool, tool, outcomeValue(outcome), {
        ...(limit === undefined ? {} : { limit }),
        ...(sinceDays === undefined ? {} : { sinceDays })
      });
    } else if (tool && weighted) {
      entries = await retrieveTrustWeighted(deps.pool, { tool }, limit ?? 10);
    } else {
      return json(deps.response, 400, {
        error: "missing_query",
        details: "tool queries require outcome, or weighted=true."
      });
    }

    return json(deps.response, 200, {
      entries: entries.map(redactEntry)
    });
  } catch (error) {
    if (error instanceof EpisodicScratchValidationError) {
      return json(deps.response, 400, {
        error: error.code,
        details: error.message
      });
    }
    return json(deps.response, 503, {
      error: "episodic_scratch_unavailable",
      details: error instanceof Error ? error.message : "Scratch store query failed."
    });
  }
}

function redactEntry(entry: EpisodicEntry): EpisodicEntry {
  return redactObject(entry) as EpisodicEntry;
}

function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value instanceof Date) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value;
  if (value instanceof Map) return value;
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretKeyPattern.test(key) ? "[redacted]" : redactObject(item)
    ])
  );
}

function outcomeValue(value: string): ScratchOutcome {
  const allowed: ScratchOutcome[] = [
    "success",
    "failed",
    "rolled_back",
    "rollback_failed",
    "cancelled_by_operator",
    "timeout",
    "partial"
  ];
  if (allowed.includes(value as ScratchOutcome)) return value as ScratchOutcome;
  throw new EpisodicScratchValidationError("invalid_outcome", "Invalid scratch outcome.");
}

function optionalParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function optionalIntegerParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EpisodicScratchValidationError(`invalid_${name}`, `${name} must be a positive integer.`);
  }
  return parsed;
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
