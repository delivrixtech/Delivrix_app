// Read-only HTTP route backing the `read_dkim_status` OpenClaw tool.
// The agent asks "is DKIM actually set up for this domain?"; the gateway probes
// the real selectors (Delivrix's s<year>a convention + common ones) and returns
// valid / revoked / absent / unknown — instead of a false "missing" caused by
// querying the wrong selector, or a false "OK" on a revoked key.

import { promises as dns } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";
import { diagnoseDkim } from "../openclaw-dkim-diagnostic.ts";
import { dkimStatusParamSchema } from "../skill-schemas.ts";

export interface ReadDkimStatusDeps {
  /** Injectable for tests; defaults to node:dns resolveTxt with NXDOMAIN handling. */
  resolveTxt?: (fqdn: string) => Promise<string[][]>;
  emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  now?: () => Date;
  readBoundaryToken?: string;
  rateLimitPerMinute?: number;
}

// Return [] for a genuine no-record (NXDOMAIN/ENODATA) so the diagnosis can say
// "absent"; rethrow real resolver failures so it can say "unknown" (never a false
// "absent" just because DNS was unreachable).
async function defaultResolveTxt(fqdn: string): Promise<string[][]> {
  try {
    return await dns.resolveTxt(fqdn);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    throw error;
  }
}

export async function handleReadDkimStatus(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadDkimStatusDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "dkim_status");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = new URL(request.url ?? "", "http://localhost");
  const parsed = dkimStatusParamSchema.safeParse({
    domain: url.searchParams.get("domain"),
    expectedSelector: url.searchParams.get("expectedSelector")
  });
  if (!parsed.success) {
    json(response, 400, { error: "invalid_params", issues: parsed.error.issues });
    return;
  }
  const params = parsed.data;

  try {
    const diagnosis = await diagnoseDkim({
      resolveTxt: deps.resolveTxt ?? defaultResolveTxt,
      domain: params.domain,
      expectedSelector: params.expectedSelector,
      now: deps.now
    });

    await deps.emitAudit?.({
      type: "oc.dns.dkim_status_read",
      domain: params.domain,
      status: diagnosis.status,
      validSelectors: diagnosis.validSelectors,
      timestamp: (deps.now ?? (() => new Date()))().toISOString()
    });

    json(response, 200, diagnosis);
  } catch (error) {
    void deps.logger?.warn(
      "openclaw.dkim_status_failed",
      "DKIM status read failed.",
      { domain: params.domain, message: errorMessage(error) }
    );
    json(response, 502, { error: "dkim_status_read_failed", message: errorMessage(error) });
  }
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
