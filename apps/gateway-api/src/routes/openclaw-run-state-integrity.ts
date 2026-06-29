// Read-only HTTP route backing the `read_run_state_integrity` OpenClaw tool.
// The agent asks "is any domain sending without a registered run?"; the gateway
// cross-references real-send audit events against the provisioning runs and
// returns the orphan domains (the annualcorpfilings case) + failed/cancelled runs.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";
import {
  checkRunStateIntegrity,
  type RunStateRun,
  type RunStateSend
} from "../run-state-integrity.ts";

export interface ReadRunStateIntegrityDeps {
  listRuns: () => Promise<RunStateRun[]>;
  listSends: () => Promise<RunStateSend[]>;
  emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  now?: () => Date;
  readBoundaryToken?: string;
  rateLimitPerMinute?: number;
}

export async function handleReadRunStateIntegrity(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadRunStateIntegrityDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "run_state_integrity");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  try {
    const [runs, sends] = await Promise.all([deps.listRuns(), deps.listSends()]);
    const report = checkRunStateIntegrity({ runs, sends });

    await deps.emitAudit?.({
      type: "oc.provisioning.run_state_integrity_read",
      ok: report.ok,
      domainsWithoutRun: report.totals.domainsWithoutRun,
      failedRuns: report.totals.failedRuns,
      timestamp: (deps.now ?? (() => new Date()))().toISOString()
    });

    json(response, 200, report);
  } catch (error) {
    void deps.logger?.warn(
      "openclaw.run_state_integrity_failed",
      "Run-state integrity read failed.",
      { message: errorMessage(error) }
    );
    json(response, 502, { error: "run_state_integrity_read_failed", message: errorMessage(error) });
  }
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
