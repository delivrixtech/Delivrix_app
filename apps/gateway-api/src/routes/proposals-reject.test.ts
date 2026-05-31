import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, AuditEventInput, CanvasLiveArtifactSnapshot } from "../../../../packages/domain/src/index.ts";
import { createInternalHttpAdapter } from "../internal-http-adapter.ts";
import { handleProposalReject } from "./proposals-reject.ts";
import type { ProposalSignStoredProposal } from "./proposals-sign.ts";
import { signOpenClawPayload } from "../security/hmac.ts";

process.env.OPENCLAW_HMAC_SECRET = "test-openclaw-secret";

const proposalId = "123e4567-e89b-42d3-a456-426614174000";
const now = new Date("2026-05-29T21:30:00.000Z");

test("reject happy path marks proposal rejected", async () => {
  const ctx = context();
  const response = await reject(ctx);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "rejected");
  assert.equal(ctx.proposals[0].status, "rejected");
  assert.equal(ctx.events.at(-1)?.action, "oc.proposal.rejected");
});

test("reject kill switch armed returns 423", async () => {
  const ctx = context({ killSwitchEnabled: true });
  const response = await reject(ctx);
  assert.equal(response.statusCode, 423);
  assert.equal(response.body.rejectReason, "kill_switch_armed");
});

test("reject non UUID proposalId returns 400", async () => {
  const ctx = context();
  const response = await reject(ctx, { proposalId: "not-uuid" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.rejectReason, "schema_mismatch");
});

test("reject empty body returns 400", async () => {
  const ctx = context();
  const response = await reject(ctx, { body: null });
  assert.equal(response.statusCode, 400);
});

test("reject invalid actorId returns 400", async () => {
  const ctx = context();
  const response = await reject(ctx, { body: { actorId: "bad actor", reason: "Rechazo suficientemente largo" } });
  assert.equal(response.statusCode, 400);
});

test("reject short reason returns 400", async () => {
  const ctx = context();
  const response = await reject(ctx, { body: { actorId: "operator-juanes", reason: "short" } });
  assert.equal(response.statusCode, 400);
});

test("reject absent proposal returns 404", async () => {
  const ctx = context({ proposals: [] });
  const response = await reject(ctx);
  assert.equal(response.statusCode, 404);
});

test("reject non pending proposal returns 409", async () => {
  const ctx = context({ proposal: baseProposal({ status: "signed" }) });
  const response = await reject(ctx);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.currentStatus, "signed");
});

test("reject blocks on broken audit chain", async () => {
  const ctx = context({ chainOk: false });
  const response = await reject(ctx);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.rejectReason, "audit_chain_broken");
});

test("reject requires HMAC outside local unsigned panel mode", async () => {
  const ctx = context({ env: { NODE_ENV: "production" } });
  const response = await reject(ctx, { auth: "none" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.rejectReason, "signature_required");
});

test("reject webhook failure does not block and canvas is updated", async () => {
  const ctx = context({ webhookThrows: true });
  const response = await reject(ctx);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.webhookBroadcast.delivered, false);
  assert.equal(ctx.artifacts[0].approvalStatus, "rejected");
  assert.equal(ctx.artifacts[0].rejectionReason, "Rechazo esta propuesta por contrato incorrecto");
  assert.equal(ctx.artifacts[0].blocks[0]?.order, 1);
});

interface TestContext {
  proposals: ProposalSignStoredProposal[];
  events: AuditEvent[];
  artifacts: CanvasLiveArtifactSnapshot[];
  deps: Parameters<typeof handleProposalReject>[0];
}

function context(options: {
  proposal?: ProposalSignStoredProposal;
  proposals?: ProposalSignStoredProposal[];
  killSwitchEnabled?: boolean;
  chainOk?: boolean;
  webhookThrows?: boolean;
  env?: Record<string, string | undefined>;
} = {}): TestContext {
  const proposals = options.proposals ?? [options.proposal ?? baseProposal()];
  const events: AuditEvent[] = [];
  const artifacts: CanvasLiveArtifactSnapshot[] = [];
  const deps = {
    request: undefined as never,
    response: undefined as never,
    proposalId,
    auditLog: {
      async append(event: AuditEventInput) {
        const persisted = {
          id: `audit-${events.length + 1}`,
          occurredAt: now.toISOString(),
          decision: "allow",
          rejectReason: null,
          humanApproved: false,
          approverIds: [],
          killSwitchState: "unknown",
          rollbackToken: null,
          schemaVersion: "2026-05-18.v1",
          promptVersion: null,
          modelVersion: null,
          evidenceRefs: [],
          prevHash: events.at(-1)?.hash ?? "GENESIS",
          hash: `hash-${events.length + 1}`,
          ...event
        } as AuditEvent;
        events.push(persisted);
        return persisted;
      },
      async list() {
        return events;
      }
    },
    auditChain: {
      async verify() {
        return {
          ok: options.chainOk ?? true,
          totalEvents: 10,
          emptyChain: false,
          lastHash: "headhash",
          sourcePath: "test",
          ...(options.chainOk === false ? { brokenAt: { seq: 2, reason: "hash_mismatch", expectedHash: "a", actualHash: "b" } } : {})
        };
      }
    },
    proposalsStore: proposals,
    canvasState: {
      async upsertArtifact(artifact: CanvasLiveArtifactSnapshot) {
        artifacts.push(artifact);
      }
    },
    webhookBroadcaster: {
      async broadcast() {
        if (options.webhookThrows) throw new Error("webhook down");
        return { delivered: true, buffered: false };
      }
    },
    readKillSwitch: async () => ({ enabled: options.killSwitchEnabled ?? false }),
    env: options.env,
    now: () => now
  } satisfies Omit<Parameters<typeof handleProposalReject>[0], "request" | "response"> & {
    request: never;
    response: never;
  };
  return { proposals, events, artifacts, deps: deps as Parameters<typeof handleProposalReject>[0] };
}

async function reject(ctx: TestContext, options: {
  proposalId?: string;
  body?: unknown;
  auth?: "hmac" | "none";
} = {}) {
  const bodyPayload = options.body === undefined
    ? {
        actorId: "operator/juanes",
        reason: "Rechazo esta propuesta por contrato incorrecto"
      }
    : options.body;
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = options.auth === "none"
    ? {}
    : {
        "x-openclaw-timestamp": String(timestamp),
        "x-openclaw-signature": signOpenClawPayload(
          JSON.stringify(bodyPayload),
          timestamp,
          process.env.OPENCLAW_HMAC_SECRET!
        )
      };
  const { request, response, getResponse } = createInternalHttpAdapter({
    body: bodyPayload,
    headers
  });
  await handleProposalReject({
    ...ctx.deps,
    request,
    response,
    proposalId: options.proposalId ?? proposalId
  });
  return getResponse() as ReturnType<typeof getResponse> & { body: Record<string, any> };
}

function baseProposal(overrides: Partial<ProposalSignStoredProposal> = {}): ProposalSignStoredProposal {
  return {
    id: proposalId,
    category: "supervised_local_state",
    severity: "high",
    headline: "Registrar dominio smoke",
    body: "Dry-run validado",
    runbookRef: "register_domain",
    targetRef: "delivrix-smoke.test",
    targetType: "domain",
    skillSlug: "register_domain_route53",
    params: { domain: "delivrix-smoke.test", years: 1, autoRenew: false },
    proposalHash: "hash-proposal",
    delivrix_actions_required: ["register_domain_route53"],
    requiresApproval: true,
    status: "pending",
    expiresAt: "2026-05-29T22:00:00.000Z",
    ...overrides
  };
}
