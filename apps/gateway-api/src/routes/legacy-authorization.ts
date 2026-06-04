import type { ServerResponse } from "node:http";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface LegacyAuthorizationDeprecationInput {
  response: ServerResponse;
  route: string;
  canonicalEndpoint: string;
  proposalId?: string;
  auditLog?: AuditSink;
}

export async function handleLegacyAuthorizationDeprecated(input: LegacyAuthorizationDeprecationInput): Promise<void> {
  await input.auditLog?.append({
    actorType: "system",
    actorId: "gateway-api",
    action: "oc.legacy_authorization.deprecated",
    targetType: "route",
    targetId: input.route,
    riskLevel: "high",
    decision: "reject",
    humanApproved: false,
    metadata: {
      proposalId: input.proposalId ?? null,
      canonicalEndpoint: input.canonicalEndpoint,
      rejectReason: "canonical_hmac_signature_required"
    }
  }).catch(() => undefined);

  return json(input.response, 410, {
    ok: false,
    rejectReason: "canonical_hmac_signature_required",
    deprecatedRoute: input.route,
    canonicalEndpoint: input.canonicalEndpoint,
    message: "Legacy operator authorization is disabled. Use the canonical ApprovalGate HMAC signature endpoint."
  });
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}
