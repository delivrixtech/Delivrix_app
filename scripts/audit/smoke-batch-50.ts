#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";

const gatewayBase = process.env.DELIVRIX_GATEWAY_URL ?? "http://127.0.0.1:3000";
const secret = process.env.OPENCLAW_HMAC_SECRET;

if (!secret) {
  console.error("OPENCLAW_HMAC_SECRET is required");
  process.exit(1);
}

const batchId = randomUUID();
const events = Array.from({ length: 50 }, (_, index) => buildEvent(index));
const raw = JSON.stringify({ batchId, events });
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");

const response = await fetch(`${gatewayBase}/v1/agent/audit/batch`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-openclaw-signature": signature,
    "x-openclaw-timestamp": timestamp
  },
  body: raw
});
const body = await response.json() as { accepted?: string[]; rejected?: unknown[] };
console.log(JSON.stringify({
  status: response.status,
  accepted: body.accepted?.length ?? 0,
  rejected: body.rejected?.length ?? 0,
  batchId
}));

if (response.status !== 200 || body.accepted?.length !== 50 || body.rejected?.length !== 0) {
  process.exit(1);
}

function buildEvent(index: number): Record<string, unknown> {
  return {
    id: randomUUID(),
    occurredAt: new Date(Date.now() + index).toISOString(),
    actorType: "openclaw",
    actorId: "openclaw-hostinger-prod",
    action: "oc.audit.smoke_valid",
    targetType: "audit_smoke",
    targetId: `valid-${index}`,
    riskLevel: "low",
    decision: "allow",
    rejectReason: null,
    humanApproved: false,
    approverIds: [],
    killSwitchState: "unknown",
    rollbackToken: null,
    schemaVersion: "2026-05-18.v1",
    promptVersion: "audit-smoke-v1",
    modelVersion: "none",
    evidenceRefs: [],
    metadata: { index }
  };
}
