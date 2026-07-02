import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  inspectSmtpInventory,
  type SmtpInventoryEntryStatus,
  type SmtpInventoryLiveServer
} from "../smtp-inventory-management.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export interface InspectSmtpInventoryRouteDeps {
  workspace: OpenClawWorkspace;
  listLiveServers?: () => Promise<SmtpInventoryLiveServer[]>;
  emitAudit?: (event: { type: string; [key: string]: unknown }) => Promise<void>;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  now?: () => Date;
  readBoundaryToken?: string;
  rateLimitPerMinute?: number;
}

export async function handleInspectSmtpInventoryHttp(
  request: IncomingMessage,
  response: ServerResponse,
  deps: InspectSmtpInventoryRouteDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "smtp_inventory");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = requestUrl(request);
  const domain = queryValue(url, "domain");
  const serverSlug = queryValue(url, "serverSlug");
  const status = normalizeStatus(queryValue(url, "status"));
  if (queryValue(url, "status") && !status) {
    json(response, 422, { error: "invalid_status" });
    return;
  }

  try {
    if (!deps.listLiveServers) {
      json(response, 503, { error: "smtp_inventory_live_source_missing" });
      return;
    }
    const liveServers = await deps.listLiveServers();
    const report = await inspectSmtpInventory({
      workspace: deps.workspace,
      ...(domain ? { domain } : {}),
      ...(serverSlug ? { serverSlug } : {}),
      ...(status ? { status } : {}),
      liveServers
    });

    await deps.emitAudit?.({
      type: "oc.smtp_inventory.inspect_read",
      ok: report.ok,
      domain,
      serverSlug,
      status,
      timestamp: (deps.now ?? (() => new Date()))().toISOString()
    });

    json(response, 200, report);
  } catch (error) {
    void deps.logger?.warn(
      "openclaw.smtp_inventory_inspect_failed",
      "SMTP inventory inspect failed.",
      { message: errorMessage(error) }
    );
    json(response, 502, { error: "smtp_inventory_inspect_failed", message: errorMessage(error) });
  }
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

function queryValue(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function normalizeStatus(value: string | undefined): SmtpInventoryEntryStatus | undefined {
  if (
    value === "configured" ||
    value === "superseded" ||
    value === "retired" ||
    value === "archived"
  ) {
    return value;
  }
  return undefined;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
