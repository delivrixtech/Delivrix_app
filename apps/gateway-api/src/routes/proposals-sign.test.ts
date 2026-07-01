import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, AuditEventInput, CanvasLiveArtifactSnapshot } from "../../../../packages/domain/src/index.ts";
import { createInternalHttpAdapter } from "../internal-http-adapter.ts";
import { handleProposalSign, type ProposalSignStoredProposal } from "./proposals-sign.ts";
import { signOpenClawPayload } from "../security/hmac.ts";

process.env.OPENCLAW_HMAC_SECRET = "test-openclaw-secret";

const proposalId = "123e4567-e89b-42d3-a456-426614174000";
const now = new Date("2026-05-29T21:00:00.000Z");

test("sign happy path dispatches and returns executed", async () => {
  const ctx = context();
  const response = await sign(ctx);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, "executed");
  assert.equal(ctx.dispatches.length, 1);
  assert.equal(ctx.events.some((event) => event.action === "oc.proposal.signed"), true);
  assert.equal(ctx.events.some((event) => event.action === "oc.proposal.executed"), true);
});

test("sign leaves plan approval inert when autonomy flag is off", async () => {
  const ctx = context({ proposal: configureCompleteSmtpProposal() });
  const response = await sign(ctx);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.planApproval, undefined);
  assert.equal(ctx.proposals[0].planApproval, undefined);
  assert.equal(ctx.events.some((event) => event.action === "oc.plan.signed"), false);
  assert.equal(ctx.dispatches.length, 1);
});

test("sign records run-scoped plan approval when autonomy flag is on", async () => {
  const ctx = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal()
  });

  const response = await sign(ctx);
  const planEvent = ctx.events.find((event) => event.action === "oc.plan.signed");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.planApproval.runId, "smtp-run-2026-06-04-a");
  assert.equal(ctx.proposals[0].planApproval?.scope.runId, "smtp-run-2026-06-04-a");
  assert.equal(ctx.proposals[0].planApproval?.scope.domain, "delivrixops.com");
  assert.equal(ctx.proposals[0].planApproval?.scope.requireExistingDomain, undefined);
  assert.match(ctx.proposals[0].planApproval?.scopeHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(planEvent?.targetType, "openclaw_orchestrator_run");
  assert.equal(planEvent?.targetId, "smtp-run-2026-06-04-a");
  assert.equal(planEvent?.humanApproved, true);
  assert.equal(planEvent?.metadata.scopeHash, ctx.proposals[0].planApproval?.scopeHash);
  assert.equal(ctx.dispatches.length, 1);
});

test("sign accepts vpsProviderId as configure_complete_smtp plan scope provider", async () => {
  const ctx = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({
      params: {
        runId: "smtp-contabo-20260622-a",
        domain: "nationalbizrenewal.com",
        vpsProviderId: "contabo",
        requireExistingDomain: true,
        brand: "nationalbizrenewal",
        budgetUsdMax: 25,
        testEmailRecipient: "infra@delivrix.com",
        testEmailSubject: "Smoke autorizado",
        testEmailBody: "Prueba autorizada y auditada"
      }
    })
  });

  const response = await sign(ctx);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.planApproval.provider, "contabo");
  assert.equal(response.body.planApproval.vpsProviderId, "contabo");
  assert.equal(ctx.proposals[0].planApproval?.scope.provider, "contabo");
  assert.equal(ctx.proposals[0].planApproval?.scope.vpsProviderId, "contabo");
  assert.match(ctx.proposals[0].planApproval?.scopeHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(ctx.events.some((event) => event.action === "oc.plan.signed"), true);
  assert.equal(ctx.dispatches.length, 1);
});

test("sign treats empty provider as missing and falls back to vpsProviderId", async () => {
  const ctx = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({
      params: {
        runId: "smtp-contabo-20260622-b",
        domain: "nationalbizrenewal.com",
        provider: " ",
        vpsProviderId: "contabo",
        budgetUsdMax: 25,
        testEmailRecipient: "infra@delivrix.com"
      }
    })
  });

  const response = await sign(ctx);

  assert.equal(response.statusCode, 200);
  assert.equal(ctx.proposals[0].planApproval?.scope.provider, "contabo");
  assert.equal(ctx.proposals[0].planApproval?.scope.vpsProviderId, "contabo");
  assert.equal(ctx.dispatches.length, 1);
});

test("sign seals sibling provider/account channels in configure_complete_smtp plan scope", async () => {
  const params = {
    runId: "smtp-run-2026-06-04-a",
    domain: "delivrixops.com",
    provider: "route53-webdock",
    brand: "Delivrix",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@delivrixops.com",
    testEmailSubject: "Smoke autorizado",
    testEmailBody: "Prueba autorizada y auditada"
  };
  const baseline = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({ params })
  });
  const withSiblingProvider = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({
      params: { ...params, vpsProviderId: "contabo", serverAccountId: "Quaternary" }
    })
  });

  const baselineResponse = await sign(baseline);
  const siblingResponse = await sign(withSiblingProvider);

  assert.equal(baselineResponse.statusCode, 200);
  assert.equal(siblingResponse.statusCode, 200);
  assert.equal(withSiblingProvider.proposals[0].planApproval?.scope.provider, "route53-webdock");
  assert.equal(withSiblingProvider.proposals[0].planApproval?.scope.vpsProviderId, "contabo");
  assert.equal(withSiblingProvider.proposals[0].planApproval?.scope.serverAccountId, "quaternary");
  assert.equal(withSiblingProvider.proposals[0].planApproval?.scopeHash === baseline.proposals[0].planApproval?.scopeHash, false);
  assert.equal(withSiblingProvider.events.some((event) =>
    event.action === "oc.plan.signed"
    && (event.metadata as { scope?: { serverAccountId?: string } } | undefined)?.scope?.serverAccountId === "quaternary"
  ), true);
});

test("sign seals reuseServerSlug in configure_complete_smtp plan scope", async () => {
  const ctx = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({
      params: {
        runId: "smtp-reuse-2026-07-01-a",
        domain: "delivrixops.com",
        provider: "route53-webdock",
        reuseServerSlug: "Server-60",
        serverAccountId: "Secondary",
        brand: "Delivrix",
        budgetUsdMax: 25,
        testEmailRecipient: "ops@delivrixops.com",
        testEmailSubject: "Smoke autorizado",
        testEmailBody: "Prueba autorizada y auditada"
      }
    })
  });

  const response = await sign(ctx);

  assert.equal(response.statusCode, 200);
  assert.equal(ctx.proposals[0].planApproval?.scope.reuseServerSlug, "server-60");
  assert.equal(ctx.proposals[0].planApproval?.scope.serverAccountId, "secondary");
  assert.equal(response.body.planApproval.reuseServerSlug, "server-60");
  assert.match(ctx.proposals[0].planApproval?.scopeHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(ctx.events.some((event) =>
    event.action === "oc.plan.signed"
    && (event.metadata as { scope?: { reuseServerSlug?: string } } | undefined)?.scope?.reuseServerSlug === "server-60"
  ), true);
});

test("sign records strict existing-domain adoption in run-scoped plan approval", async () => {
  const ctx = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({
      params: {
        runId: "smtp-run-2026-06-04-a",
        domain: "controldelivrix.app",
        provider: "route53-webdock",
        requireExistingDomain: true,
        brand: "Delivrix",
        budgetUsdMax: 25,
        testEmailRecipient: "ops@delivrixops.com",
        testEmailSubject: "Smoke autorizado",
        testEmailBody: "Prueba autorizada y auditada"
      }
    })
  });

  const response = await sign(ctx);

  assert.equal(response.statusCode, 200);
  assert.equal(ctx.proposals[0].planApproval?.scope.domain, "controldelivrix.app");
  assert.equal(ctx.proposals[0].planApproval?.scope.requireExistingDomain, true);
  assert.match(ctx.proposals[0].planApproval?.scopeHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(ctx.events.some((event) => event.action === "oc.plan.signed"), true);
});

test("sign rejects incomplete plan scope when autonomy flag is on", async () => {
  const ctx = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({
      params: {
        brand: "Delivrix",
        budgetUsdMax: 25,
        testEmailRecipient: "ops@delivrixops.com",
        testEmailSubject: "Smoke",
        testEmailBody: "Authorized smoke"
      }
    })
  });

  const response = await sign(ctx);

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.rejectReason, "plan_scope_missing");
  assert.equal(ctx.events.some((event) => event.action === "oc.plan.signed"), false);
  assert.equal(ctx.dispatches.length, 0);
});

test("sign rejects when provider and vpsProviderId are missing or empty", async () => {
  const ctx = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({
      params: {
        runId: "smtp-contabo-20260622-c",
        domain: "nationalbizrenewal.com",
        provider: " ",
        budgetUsdMax: 25,
        testEmailRecipient: "infra@delivrix.com"
      }
    })
  });

  const response = await sign(ctx);

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.rejectReason, "plan_scope_missing");
  assert.equal(response.body.details.includes("params.provider or params.vpsProviderId is required."), true);
  assert.equal(ctx.events.some((event) => event.action === "oc.plan.signed"), false);
  assert.equal(ctx.dispatches.length, 0);
});

test("sign rejects non-boolean requireExistingDomain in plan scope", async () => {
  const ctx = context({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    proposal: configureCompleteSmtpProposal({
      params: {
        runId: "smtp-run-2026-06-04-a",
        domain: "delivrixops.com",
        provider: "route53-webdock",
        requireExistingDomain: "true",
        brand: "Delivrix",
        budgetUsdMax: 25,
        testEmailRecipient: "ops@delivrixops.com",
        testEmailSubject: "Smoke autorizado",
        testEmailBody: "Prueba autorizada y auditada"
      }
    })
  });

  const response = await sign(ctx);

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.rejectReason, "plan_scope_missing");
  assert.equal(ctx.events.some((event) => event.action === "oc.plan.signed"), false);
  assert.equal(ctx.dispatches.length, 0);
});

test("sign keeps private approval token out of public signature fields", async () => {
  const ctx = context();
  const response = await sign(ctx);
  const dispatch = ctx.dispatches[0] as { approvalToken: { tokenId: string } };
  const approved = ctx.events.find((event) => event.action === "oc.artifact.approved");
  const signed = ctx.events.find((event) => event.action === "oc.proposal.signed");

  assert.match(response.body.signatureId, /^sig_/);
  assert.notEqual(dispatch.approvalToken.tokenId, response.body.signatureId);
  assert.equal(ctx.proposals[0].signatureId, response.body.signatureId);
  assert.equal(ctx.artifacts[0].executionId, response.body.signatureId);
  assert.equal(approved?.metadata.executionId, response.body.signatureId);
  assert.equal(typeof approved?.metadata.approvalTokenHash, "string");
  assert.equal(signed?.metadata.signatureId, response.body.signatureId);
  assert.equal(signed?.metadata.approvalTokenHash, approved?.metadata.approvalTokenHash);
});

test("sign kill switch armed returns 423", async () => {
  const ctx = context({ killSwitchEnabled: true });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 423);
  assert.equal(response.body.rejectReason, "kill_switch_armed");
  assert.equal(ctx.dispatches.length, 0);
});

test("sign rejects non UUID v4 proposalId", async () => {
  const ctx = context();
  const response = await sign(ctx, { proposalId: "not-a-uuid" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.rejectReason, "schema_mismatch");
});

test("sign returns 404 when proposal is absent", async () => {
  const ctx = context({ proposals: [] });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.rejectReason, "proposal_not_found");
});

test("sign returns 409 when proposal is not pending", async () => {
  const ctx = context({ proposal: baseProposal({ status: "rejected" }) });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.rejectReason, "proposal_not_pending");
});

test("sign expires stale pending proposal", async () => {
  const ctx = context({ proposal: baseProposal({ expiresAt: "2026-05-29T20:59:59.000Z" }) });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 410);
  assert.equal(response.body.rejectReason, "proposal_expired");
  assert.equal(ctx.proposals[0].status, "expired");
});

test("sign rejects proposal that does not require approval", async () => {
  const ctx = context({ proposal: baseProposal({ requiresApproval: false }) });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.rejectReason, "proposal_does_not_require_approval");
});

test("sign blocks when audit chain is broken", async () => {
  const ctx = context({ chainOk: false });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.rejectReason, "audit_chain_broken");
});

test("sign rejects invalid optional HMAC header", async () => {
  const ctx = context();
  const response = await sign(ctx, {
    headers: { "x-openclaw-signature": "bad" }
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.rejectReason, "signature_invalid");
});

test("sign requires HMAC outside local unsigned panel mode", async () => {
  const ctx = context({ env: { NODE_ENV: "production" } });
  const response = await sign(ctx, { auth: "none" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.rejectReason, "signature_required");
  assert.equal(ctx.dispatches.length, 0);
});

test("sign rejects future-phase generic action ids even when skill alias matches", async () => {
  const ctx = context({
    proposal: baseProposal({
      skillSlug: "upsert_dns_route53",
      delivrix_actions_required: ["dns_live_change"]
    })
  });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.rejectReason, "skill_action_mismatch");
});

test("sign rejects when skill is not authorized by proposal actions", async () => {
  const ctx = context({ proposal: baseProposal({ delivrix_actions_required: ["record_human_decision"] }) });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.rejectReason, "skill_action_mismatch");
  assert.equal(ctx.dispatches.length, 0);
});

test("sign rejects empty body schema", async () => {
  const ctx = context();
  const response = await sign(ctx, { body: null });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.rejectReason, "schema_mismatch");
});

test("sign rejects actorId with invalid characters", async () => {
  const ctx = context();
  const response = await sign(ctx, { body: { actorId: "bad actor", reason: "Aprobado por lectura completa" } });
  assert.equal(response.statusCode, 400);
});

test("sign rejects too short reason", async () => {
  const ctx = context();
  const response = await sign(ctx, { body: { actorId: "operator-juanes", reason: "short" } });
  assert.equal(response.statusCode, 400);
});

test("sign rejects too long reason", async () => {
  const ctx = context();
  const response = await sign(ctx, { body: { actorId: "operator-juanes", reason: "x".repeat(501) } });
  assert.equal(response.statusCode, 400);
});

test("sign maps dispatcher timeout to 202 executing", async () => {
  const ctx = context({ dispatchResult: { ok: false, statusCode: 504, summary: { error: "handler_timeout" }, durationMs: 60000 } });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.status, "executing");
  assert.match(response.body.pollEndpoint, /\/status$/);
  assert.equal(ctx.proposals[0].status, "executing");
});

test("sign maps handler failure to 502", async () => {
  const ctx = context({ dispatchResult: { ok: false, statusCode: 409, summary: { error: "blocked" }, durationMs: 10 } });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.status, "execution_failed");
});

test("sign does not block when webhook broadcast fails", async () => {
  const ctx = context({ webhookThrows: true });
  const response = await sign(ctx);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.webhookBroadcast.delivered, false);
});

test("sign replay returns 409 on second signature", async () => {
  const ctx = context();
  const first = await sign(ctx);
  const second = await sign(ctx);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.currentStatus, "executed");
});

test("sign writes chain prev hash into signed metadata", async () => {
  const ctx = context({ chainLastHash: "headhash-123" });
  await sign(ctx);
  const signed = ctx.events.find((event) => event.action === "oc.proposal.signed");
  assert.equal(signed?.metadata.chainPrevHash, "headhash-123");
});

test("sign updates canvas artifact as approved with executionId", async () => {
  const ctx = context();
  const response = await sign(ctx);
  assert.equal(ctx.artifacts.length, 1);
  assert.equal(ctx.artifacts[0].approvalStatus, "approved");
  assert.equal(ctx.artifacts[0].executionId, response.body.signatureId);
  assert.equal(ctx.artifacts[0].blocks[0]?.order, 1);
});

test("sign redacts secrets from executed audit metadata", async () => {
  const ctx = context({
    dispatchResult: {
      ok: true,
      statusCode: 200,
      summary: { ok: true, token: "abc", nested: { privateKey: "secret" } },
      durationMs: 1
    }
  });
  await sign(ctx);
  const executed = ctx.events.find((event) => event.action === "oc.proposal.executed");
  assert.deepEqual(executed?.metadata.handlerResponseSummary, {
    ok: true,
    token: "[REDACTED]",
    nested: { privateKey: "[REDACTED]" }
  });
  assert.deepEqual(ctx.proposals[0].executionOutcome, {
    ok: true,
    token: "[REDACTED]",
    nested: { privateKey: "[REDACTED]" }
  });
  assert.equal(ctx.proposals[0].executionStatusCode, 200);
  assert.equal(ctx.proposals[0].executionDurationMs, 1);
  assert.equal(ctx.proposals[0].executionCompletedAt, now.toISOString());
});

test("sign redacts secrets embedded in handler response strings", async () => {
  const ctx = context({
    dispatchResult: {
      ok: true,
      statusCode: 200,
      summary: "Authorization: Bearer abc123 token=secretvalue",
      durationMs: 1
    }
  });
  await sign(ctx);
  const executed = ctx.events.find((event) => event.action === "oc.proposal.executed");
  assert.equal(executed?.metadata.handlerResponseSummary, "Authorization: Bearer [REDACTED] token=[REDACTED]");
});

interface TestContext {
  proposals: ProposalSignStoredProposal[];
  events: AuditEvent[];
  artifacts: CanvasLiveArtifactSnapshot[];
  dispatches: unknown[];
  deps: Parameters<typeof handleProposalSign>[0];
}

function context(options: {
  proposal?: ProposalSignStoredProposal;
  proposals?: ProposalSignStoredProposal[];
  killSwitchEnabled?: boolean;
  chainOk?: boolean;
  chainLastHash?: string;
  dispatchResult?: { ok: boolean; statusCode: number; summary: unknown; durationMs: number };
  webhookThrows?: boolean;
  env?: Record<string, string | undefined>;
} = {}): TestContext {
  const proposals = options.proposals ?? [options.proposal ?? baseProposal()];
  const events: AuditEvent[] = [];
  const artifacts: CanvasLiveArtifactSnapshot[] = [];
  const dispatches: unknown[] = [];
  const dispatchResult = options.dispatchResult ?? {
    ok: true,
    statusCode: 200,
    summary: { ok: true },
    durationMs: 5
  };
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
          lastHash: options.chainLastHash ?? "headhash",
          sourcePath: "test",
          ...(options.chainOk === false ? { brokenAt: { seq: 8, reason: "hash_mismatch", expectedHash: "a", actualHash: "b" } } : {})
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
    dispatcher: {
      async dispatch(input: unknown) {
        dispatches.push(input);
        return dispatchResult;
      }
    },
    readKillSwitch: async () => ({ enabled: options.killSwitchEnabled ?? false }),
    env: options.env,
    now: () => now
  } satisfies Omit<Parameters<typeof handleProposalSign>[0], "request" | "response"> & {
    request: never;
    response: never;
  };
  return { proposals, events, artifacts, dispatches, deps: deps as Parameters<typeof handleProposalSign>[0] };
}

async function sign(ctx: TestContext, options: {
  proposalId?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: "hmac" | "none";
} = {}) {
  const bodyPayload = options.body === undefined
    ? {
        actorId: "operator/juanes",
        reason: "Aprobado desde Canvas Live tras revisar el dry-run"
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
    headers: { ...headers, ...(options.headers ?? {}) }
  });
  await handleProposalSign({
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

function configureCompleteSmtpProposal(overrides: Partial<ProposalSignStoredProposal> = {}): ProposalSignStoredProposal {
  return baseProposal({
    category: "supervised_local_state",
    severity: "critical",
    headline: "SMTP completo autorizado",
    runbookRef: "configure_complete_smtp",
    targetRef: "smtp-run-2026-06-04-a",
    targetType: "openclaw_orchestrator_run",
    skillSlug: "configure_complete_smtp",
    params: {
      runId: "smtp-run-2026-06-04-a",
      domain: "delivrixops.com",
      provider: "route53-webdock",
      brand: "Delivrix",
      budgetUsdMax: 25,
      testEmailRecipient: "ops@delivrixops.com",
      testEmailSubject: "Smoke autorizado",
      testEmailBody: "Prueba autorizada y auditada"
    },
    delivrix_actions_required: ["configure_complete_smtp"],
    ...overrides
  });
}
