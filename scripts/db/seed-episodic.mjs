import { createHash, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { defaultPostgresContainer, defaultPostgresUrl, postgresConfig } from "./common.mjs";
import { insertEpisodicEntry, stableStringify } from "../../packages/storage/src/index.ts";

const { Pool } = pg;
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "postgres", defaultPostgresContainer]);
const seedNow = new Date("2026-06-03T12:00:00.000Z");

export function assertEpisodicReviewSeedAllowed(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error("episodic review seed is disabled when NODE_ENV=production");
  }

  const secret = env.OPENCLAW_OPERATOR_HMAC_SECRET?.trim();
  if (!secret) {
    throw new Error("OPENCLAW_OPERATOR_HMAC_SECRET is required for operator review seed entries");
  }

  const config = postgresConfig(env);
  const parsed = new URL(config.url);
  const host = parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!localHosts.has(host)) {
    throw new Error(`episodic review seed refuses non-local POSTGRES_URL host: ${host}`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (/prod|production/i.test(database)) {
    throw new Error(`episodic review seed refuses production-looking database name: ${database}`);
  }

  return { config, secret };
}

export function buildEpisodicReviewSeedEntries(env = process.env) {
  const { secret } = assertEpisodicReviewSeedAllowed(env);
  const day = 24 * 60 * 60 * 1000;
  const daysAgo = (days) => new Date(seedNow.getTime() - days * day);

  return [
    verifiedToolFact("suggest_safe_domain", "success", "domain-candidate-safe", 0, 0.92, {
      domain: "delivrixops-review.test",
      decisionCode: "domain_candidate_safe",
      reputationSignals: ["no_blacklist_hit", "spf_ready", "warming_required"]
    }),
    verifiedToolFact("suggest_safe_domain", "success", "domain-candidate-warmup", 1, 0.78, {
      domain: "control-delivrix-review.test",
      decisionCode: "domain_candidate_warmup_only",
      reputationSignals: ["new_domain", "warmup_required"]
    }),
    verifiedToolFact("suggest_safe_domain", "failed", "domain-candidate-low-reputation", 2, 0.54, {
      domain: "promo-delivrix-review.test",
      decisionCode: "domain_candidate_reputation_watch",
      rejectionCode: "blacklist_signal_present"
    }),
    verifiedToolFact("wait_for_dns_propagation", "success", "dkim-propagated", 0, 0.88, {
      domain: "delivrixops-review.test",
      recordType: "TXT",
      decisionCode: "dkim_txt_propagated"
    }),
    verifiedToolFact("wait_for_dns_propagation", "timeout", "dmarc-timeout", 1, 0.62, {
      domain: "control-delivrix-review.test",
      recordType: "TXT",
      decisionCode: "dmarc_txt_not_propagated"
    }),
    verifiedToolFact("read_route53_zone_records", "success", "route53-spf", 0, 0.81, {
      zoneId: "ZREVIEW000000000",
      recordType: "TXT",
      decisionCode: "spf_record_present"
    }),
    verifiedToolFact("read_webdock_servers", "success", "webdock-bridge-active", 0, 0.85, {
      serverSlug: "server10",
      decisionCode: "webdock_bridge_active",
      continuity: "preserve"
    }),
    verifiedToolFact("configure_complete_smtp", "partial", "smtp-dry-run-partial", 1, 0.67, {
      mode: "dry_run",
      decisionCode: "smtp_dry_run_requires_operator_review",
      gates: ["human_approval", "kill_switch_check"]
    }),
    verifiedToolFact("seed_warmup_pool", "success", "warmup-seed-small", 0, 0.74, {
      schedule: "demo-fast",
      decisionCode: "warmup_seed_ready",
      maxDailyRamp: 250
    }),
    verifiedToolFact("bind_domain_to_server", "success", "domain-bound-review", 0, 0.76, {
      domain: "delivrixops-review.test",
      serverSlug: "server10",
      decisionCode: "domain_binding_ready"
    }),
    verifiedToolFact("configure_email_auth", "rolled_back", "email-auth-rollback", 3, 0.69, {
      domain: "control-delivrix-review.test",
      decisionCode: "rollback_completed",
      rollbackCode: "dkim_selector_conflict"
    }),
    verifiedToolFact("read_route53_domain_detail", "success", "domain-detail-auto-renew", 0, 0.83, {
      domain: "controldelivrix-review.test",
      decisionCode: "domain_auto_renew_verified",
      autoRenew: true
    }),
    operatorFact(secret, "operator-approval-provenance", 0.95, {
      decisionCode: "operator_verified_warmup_limit",
      approvedLimitPerDay: 1000,
      appliesTo: "review_seed_only"
    }),
    operatorFact(secret, "operator-rollback-policy", 0.94, {
      decisionCode: "operator_requires_rollback_plan",
      appliesTo: "dns_and_smtp_changes",
      highImpactAction: true
    }),
    observation("compact_intent", "success", "observation-compaction", 0, 0.35, {
      noteCode: "compaction_completed_for_review_seed"
    }),
    observation("suggest_safe_domain", "success", "observation-model-candidate", 0, 0.31, {
      noteCode: "model_suggested_non_verified_candidate"
    }),
    invalidatedFact("suggest_safe_domain", "success", "invalidated-domain-candidate", daysAgo(7), {
      domain: "old-delivrix-review.test",
      decisionCode: "domain_candidate_invalidated",
      invalidationReason: "review_seed_replacement"
    }),
    invalidatedFact("wait_for_dns_propagation", "success", "invalidated-dns-result", daysAgo(4), {
      domain: "legacy-delivrix-review.test",
      decisionCode: "dns_result_invalidated",
      invalidationReason: "record_changed"
    })
  ];
}

export async function runEpisodicReviewSeed(options = {}) {
  const env = options.env ?? process.env;
  const { config } = assertEpisodicReviewSeedAllowed(env);
  const entries = options.entries ?? buildEpisodicReviewSeedEntries(env);
  const pool = options.pool ?? new Pool({ connectionString: config.url });
  const insert = options.insert ?? insertEpisodicEntry;
  const log = options.log ?? console.log;
  const ownsPool = options.pool === undefined;
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO delivrix, public");
    for (const entry of entries) {
      await insert(client, entry);
    }
    await client.query("COMMIT");
    log(`episodic review seed complete: ${entries.length} deterministic entries`);
    return { inserted: entries.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (typeof client.release === "function") client.release();
    if (ownsPool && typeof pool.end === "function") await pool.end();
  }
}

function verifiedToolFact(tool, outcome, slug, daysAgo, reliability, outcomeData) {
  const intentId = `seed-episodic-${slug}`;
  return {
    intentId,
    step: 1,
    tool,
    inputHash: hash(`${intentId}:${tool}:${outcome}`),
    outcome,
    outcomeData,
    source: "tool_output",
    plane: "verified_fact",
    reliability,
    validAt: new Date(seedNow.getTime() - daysAgo * 24 * 60 * 60 * 1000),
    ttlDays: 90,
    provenance: { kind: "tool_evidence", auditEventId: `audit-${slug}` },
    metadata: {
      auditEventId: `audit-${slug}`,
      toolUseId: `toolu-${slug}`,
      seedKind: "review",
      seedVersion: "episodic-b1-2026-06-03"
    }
  };
}

function operatorFact(secret, slug, reliability, outcomeData) {
  const intentId = `seed-episodic-${slug}`;
  const tool = "operator_review";
  const inputHash = hash(`operator:${slug}`);
  const outcome = "success";
  const signature = {
    actorId: "operator:review-seed",
    auditEventId: `audit-${slug}`,
    auditEventHash: hash(`audit-hash:${slug}`),
    memoryInputHash: inputHash,
    memoryIntentId: intentId,
    memoryOutcome: outcome,
    memoryOutcomeHash: hashJson(outcomeData),
    memoryStep: "1",
    memoryTool: tool,
    proposalId: `proposal-${slug}`,
    signatureId: `sig-${slug}`,
    signedAt: seedNow.toISOString()
  };
  return {
    intentId,
    step: 1,
    tool,
    inputHash,
    outcome,
    outcomeData,
    source: "operator",
    plane: "verified_fact",
    reliability,
    validAt: seedNow,
    ttlDays: 90,
    provenance: { kind: "operator_signature", signatureId: signature.signatureId },
    metadata: {
      operatorSignatureActorId: signature.actorId,
      operatorSignatureAuditEventId: signature.auditEventId,
      operatorSignatureAuditEventHash: signature.auditEventHash,
      operatorSignatureProposalId: signature.proposalId,
      operatorSignatureId: signature.signatureId,
      operatorSignatureSignedAt: signature.signedAt,
      operatorSignatureHmac: createHmac("sha256", secret).update(stableStringify(signature)).digest("hex"),
      seedKind: "review",
      seedVersion: "episodic-b1-2026-06-03"
    }
  };
}

function observation(tool, outcome, slug, daysAgo, _reliability, outcomeData) {
  return {
    intentId: `seed-episodic-${slug}`,
    step: 1,
    tool,
    inputHash: hash(`observation:${slug}`),
    outcome,
    outcomeData,
    source: "openclaw",
    plane: "observation",
    validAt: new Date(seedNow.getTime() - daysAgo * 24 * 60 * 60 * 1000),
    ttlDays: 30,
    provenance: {},
    metadata: {
      seedKind: "review",
      seedVersion: "episodic-b1-2026-06-03"
    }
  };
}

function invalidatedFact(tool, outcome, slug, invalidAt, outcomeData) {
  return {
    ...verifiedToolFact(tool, outcome, slug, 10, 0.8, outcomeData),
    invalidAt
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  runEpisodicReviewSeed().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
