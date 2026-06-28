// Read-only HTTP route backing the `read_delivery_reason` OpenClaw tool.
// The agent asks "why did message X on server Y bounce?"; the gateway runs the
// read-only mail.log lookup over SSH server-side and returns the parsed reason.
// The agent never holds SSH credentials or runs shell — it only sees the result.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";
import {
  collectDeliveryReason,
  type DeliveryLogRunner
} from "../openclaw-delivery-reason.ts";
import { deliveryReasonParamSchema } from "../skill-schemas.ts";

export interface ReadDeliveryReasonDeps {
  sshRunner: DeliveryLogRunner;
  emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  now?: () => Date;
  readBoundaryToken?: string;
  rateLimitPerMinute?: number;
}

export async function handleReadDeliveryReason(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadDeliveryReasonDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "delivery_reason");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = new URL(request.url ?? "", "http://localhost");
  const parsed = deliveryReasonParamSchema.safeParse({
    serverSlug: url.searchParams.get("serverSlug"),
    serverIp: url.searchParams.get("serverIp"),
    messageId: url.searchParams.get("messageId")
  });
  if (!parsed.success) {
    json(response, 400, { error: "invalid_params", issues: parsed.error.issues });
    return;
  }
  const params = parsed.data;

  try {
    const outcome = await collectDeliveryReason({
      sshRunner: deps.sshRunner,
      serverSlug: params.serverSlug,
      serverIp: params.serverIp,
      messageId: params.messageId
    });

    await deps.emitAudit?.({
      type: "oc.smtp.delivery_reason_read",
      serverSlug: params.serverSlug,
      messageId: params.messageId,
      found: outcome.ok,
      finalStatus: outcome.reason?.finalStatus ?? null,
      dsnCode: outcome.reason?.dsnCode ?? null,
      timestamp: (deps.now ?? (() => new Date()))().toISOString()
    });

    json(response, 200, {
      serverSlug: params.serverSlug,
      messageId: params.messageId,
      found: outcome.ok,
      reason: outcome.reason ?? null,
      summaryCounts: outcome.summaryCounts,
      ...(outcome.error ? { error: outcome.error } : {})
    });
  } catch (error) {
    void deps.logger?.warn(
      "openclaw.delivery_reason_failed",
      "Delivery reason read failed.",
      { serverSlug: params.serverSlug, message: errorMessage(error) }
    );
    json(response, 502, { error: "delivery_reason_read_failed", message: errorMessage(error) });
  }
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
