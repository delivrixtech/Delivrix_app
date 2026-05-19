import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:3000";
const hmacSecret = process.env.OPENCLAW_HMAC_SECRET ?? "";
const scenario = process.env.D6_SCENARIO;
const sqlitePath = process.env.GATEWAY_SQLITE_FILE ?? "runtime/gateway.sqlite";

if (!hmacSecret) {
  throw new Error("OPENCLAW_HMAC_SECRET is required.");
}

if (scenario !== "bh" && scenario !== "oh") {
  throw new Error("D6_SCENARIO must be bh or oh.");
}

const config = scenario === "bh"
  ? {
      scenario: "business_hours",
      nodeId: "svc-mvp-test-02",
      quarantineProposalId: "smoke-quarantine-bh",
      reason: "Spamhaus SBL hit detectado",
      evidenceRefs: ["sha:abc123"],
      revertBody: {
        reason: "Investigado, IP descartada",
        metadata: { targetStatus: "retired" }
      }
    }
  : {
      scenario: "off_hours",
      nodeId: "svc-mvp-test-03",
      quarantineProposalId: "smoke-quarantine-oh",
      reason: "Spamhaus SBL hit detectado off-hours",
      evidenceRefs: ["sha:def456"],
      revertBody: {
        reason: "Incidente contenido, restaurar default active"
      }
    };

const outputs: Record<string, unknown> = {
  scenario: config.scenario,
  nodeId: config.nodeId
};

async function main() {
  await ensureNodeSeeded();
  outputs.nodeBeforeQuarantine = await smokeNode(config.nodeId);

  outputs.quarantinePropose = await postHmac("/v1/agent/proposals", {
    proposal: {
      id: config.quarantineProposalId,
      category: "node_quarantine_proposed",
      severity: "critical",
      headline: `Cuarentena ${config.nodeId}`,
      body: config.reason,
      evidenceRefs: config.evidenceRefs,
      runbookRef: "incident-quarantine-runbook.md",
      targetRef: config.nodeId,
      delivrix_actions_required: ["propose_quarantine", "update_sender_node_metadata"]
    },
    audit: { skillSlug: "smoke", modelVersion: "manual", promptVersion: "v1" },
    schemaVersion: "2026-05-18.v1"
  });

  const approveA = await approve(config.quarantineProposalId, "op-juanes-a");
  outputs.approveA = approveA;

  if (scenario === "oh") {
    outputs.approveB = await approve(config.quarantineProposalId, "op-juanes-b");
  }

  const executeResult = await postHmac("/v1/agent/runbook/execute", {
    proposalId: config.quarantineProposalId,
    runbookId: "incident-quarantine",
    input: {
      nodeId: config.nodeId,
      reason: config.reason,
      evidenceRefs: config.evidenceRefs
    }
  }) as { rollbackToken: string; rollbackExpiresAt: string; newState: unknown };

  outputs.quarantineExecute = executeResult;
  outputs.nodeAfterQuarantine = await smokeNode(config.nodeId);

  const revertResult = await postJson("/v1/agent/runbook/revert", {
    rollbackToken: executeResult.rollbackToken,
    ...config.revertBody
  }, {
    "X-Operator-Id": "op-juanes-a"
  });

  outputs.revert = revertResult;
  outputs.nodeAfterRevert = await smokeNode(config.nodeId);
  outputs.quarantineRollbackRows = incidentQuarantineRows(config.nodeId);

  console.log(JSON.stringify(outputs, null, 2));
}

async function ensureNodeSeeded() {
  const existing = await smokeNode(config.nodeId);

  if (existing) {
    outputs.seed = { skipped: true, node: existing };
    return;
  }

  const proposalId = `seed-register-${config.nodeId}`;
  outputs.seedPropose = await postHmac("/v1/agent/proposals", {
    proposal: {
      id: proposalId,
      category: "node_register_proposed",
      severity: "low",
      headline: `Registrar ${config.nodeId}`,
      body: "Seed D6 AM",
      evidenceRefs: [],
      runbookRef: "register-sender-node-local-runbook.md",
      targetRef: config.nodeId,
      delivrix_actions_required: ["propose_register_sender_node", "register_sender_node_local"]
    },
    audit: { skillSlug: "smoke", modelVersion: "manual", promptVersion: "v1" },
    schemaVersion: "2026-05-18.v1"
  });
  outputs.seedApprove = await approve(proposalId, "op-juanes-a");
  outputs.seedExecute = await postHmac("/v1/agent/runbook/execute", {
    proposalId,
    runbookId: "register-sender-node-local",
    input: {
      id: config.nodeId,
      label: config.nodeId === "svc-mvp-test-02" ? "MVP Test 02" : "MVP Test 03",
      provider: "webdock",
      status: "warming",
      ipAddress: config.nodeId === "svc-mvp-test-02" ? "185.243.12.41" : "185.243.12.42",
      hostname: `${config.nodeId}.delivrix.local`,
      dailyLimit: 50,
      warmupDay: 1
    }
  });
}

async function approve(proposalId: string, operatorId: string) {
  const response = await postJson(`/v1/agent/proposals/${encodeURIComponent(proposalId)}/approve`, "", {
    "X-Operator-Id": operatorId
  }) as {
    quorum: {
      current: number;
      required: number;
      reached: boolean;
      mode?: string;
      serverTime?: string;
      operatorLocalHour?: number;
      approverIds: string[];
    };
  };

  return { quorum: response.quorum };
}

async function postHmac(path: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", hmacSecret)
    .update(`${timestamp}.${raw}`)
    .digest("hex");

  return postJson(path, raw, {
    "X-OpenClaw-Signature": signature,
    "X-OpenClaw-Timestamp": timestamp
  });
}

async function postJson(path: string, payload: unknown, headers: Record<string, string> = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const response = await fetch(`${gatewayBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: raw
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function smokeNode(nodeId: string) {
  const response = await fetch(`${gatewayBaseUrl}/v1/sender-nodes`);
  const body = await response.json() as Array<Record<string, unknown>> | { nodes?: Array<Record<string, unknown>> };

  if (!response.ok) {
    throw new Error(`/v1/sender-nodes returned HTTP ${response.status}.`);
  }

  const nodes = Array.isArray(body) ? body : body.nodes ?? [];
  return nodes.find((node) => node.id === nodeId) ?? null;
}

function incidentQuarantineRows(nodeId: string) {
  const db = new DatabaseSync(sqlitePath);
  const rows = db.prepare(`
    SELECT rollback_token AS rollbackToken, runbook_id AS runbookId, target_id AS targetId, status
    FROM rollback_snapshots
    WHERE runbook_id = 'incident-quarantine' AND target_id = ?
    ORDER BY created_at ASC
  `).all(nodeId);
  db.close();

  return rows;
}

await main();
