// Read-only HTTP route backing the `read_smtp_reachability` OpenClaw tool.
// The agent asks "can server Y actually deliver mail?"; the gateway runs the
// inbound + OUTBOUND port-25 checks over SSH server-side and returns a structured
// verdict that separates "listening on 25" from "can connect out on 25".

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";
import {
  checkSmtpReachability,
  type ReachabilitySshRunner
} from "../openclaw-smtp-reachability.ts";
import { smtpReachabilityParamSchema } from "../skill-schemas.ts";

export interface ReadSmtpReachabilityDeps {
  sshRunner: ReachabilitySshRunner;
  emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  now?: () => Date;
  readBoundaryToken?: string;
  rateLimitPerMinute?: number;
}

export async function handleReadSmtpReachability(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadSmtpReachabilityDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "smtp_reachability");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = new URL(request.url ?? "", "http://localhost");
  const parsed = smtpReachabilityParamSchema.safeParse({
    serverSlug: url.searchParams.get("serverSlug"),
    serverIp: url.searchParams.get("serverIp")
  });
  if (!parsed.success) {
    json(response, 400, { error: "invalid_params", issues: parsed.error.issues });
    return;
  }
  const params = parsed.data;

  try {
    const reachability = await checkSmtpReachability({
      sshRunner: deps.sshRunner,
      serverSlug: params.serverSlug,
      serverIp: params.serverIp
    });

    await deps.emitAudit?.({
      type: "oc.smtp.reachability_read",
      serverSlug: params.serverSlug,
      canSend: reachability.canSend,
      outboundStatus: reachability.outbound.status,
      inboundListening: reachability.inbound.listening,
      timestamp: (deps.now ?? (() => new Date()))().toISOString()
    });

    json(response, 200, { serverSlug: params.serverSlug, ...reachability });
  } catch (error) {
    void deps.logger?.warn(
      "openclaw.smtp_reachability_failed",
      "SMTP reachability read failed.",
      { serverSlug: params.serverSlug, message: errorMessage(error) }
    );
    json(response, 502, { error: "smtp_reachability_read_failed", message: errorMessage(error) });
  }
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
