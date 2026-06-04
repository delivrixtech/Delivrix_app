import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";
import { createInternalHttpAdapter } from "../internal-http-adapter.ts";
import { handleLegacyAuthorizationDeprecated } from "./legacy-authorization.ts";

test("legacy authorization route fails closed with canonical ApprovalGate pointer", async () => {
  const events: AuditEventInput[] = [];
  const { response, getResponse } = createInternalHttpAdapter({});

  await handleLegacyAuthorizationDeprecated({
    response,
    route: "/v1/agent/proposals/:id/approve",
    canonicalEndpoint: "/v1/openclaw/proposals/proposal-1/sign",
    proposalId: "proposal-1",
    auditLog: {
      async append(event) {
        events.push(event);
      }
    }
  });

  const result = getResponse();
  const body = result.body as Record<string, unknown>;
  assert.equal(result.statusCode, 410);
  assert.equal(body.rejectReason, "canonical_hmac_signature_required");
  assert.equal(body.canonicalEndpoint, "/v1/openclaw/proposals/proposal-1/sign");
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.legacy_authorization.deprecated");
  assert.equal(events[0].decision, "reject");
});
