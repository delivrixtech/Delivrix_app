import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:3000";
const hmacSecret = process.env.OPENCLAW_HMAC_SECRET ?? "";
const sqlitePath = process.env.GATEWAY_SQLITE_FILE ?? "runtime/gateway.sqlite";

if (!hmacSecret) {
  throw new Error("OPENCLAW_HMAC_SECRET is required.");
}

const outputs: Record<string, unknown> = {};

const registerProposal = {
  proposal: {
    id: "smoke-register-01",
    category: "node_register_proposed",
    severity: "low",
    headline: "Registrar svc-mvp-test-01",
    body: "Smoke MVP",
    evidenceRefs: [],
    runbookRef: "register-sender-node-local-runbook.md",
    targetRef: "svc-mvp-test-01",
    delivrix_actions_required: ["propose_register_sender_node", "register_sender_node_local"]
  },
  audit: { skillSlug: "smoke", modelVersion: "manual", promptVersion: "v1" },
  schemaVersion: "2026-05-18.v1"
};

const warmingProposal = {
  proposal: {
    id: "smoke-warming-01",
    category: "warming_step_proposed",
    severity: "low",
    headline: "Subir warming svc-mvp-test-01 dia 1 a 2",
    body: "Smoke MVP",
    evidenceRefs: [],
    runbookRef: "warming-step-runbook.md",
    targetRef: "svc-mvp-test-01",
    delivrix_actions_required: ["propose_warming_step", "record_human_decision"]
  },
  audit: { skillSlug: "smoke", modelVersion: "manual", promptVersion: "v1" },
  schemaVersion: "2026-05-18.v1"
};

const pauseProposal = {
  proposal: {
    id: "smoke-pause-01",
    category: "node_pause_proposed",
    severity: "high",
    headline: "Pausar svc-mvp-test-01",
    body: "Smoke MVP",
    evidenceRefs: [],
    runbookRef: "pause-ip-runbook.md",
    targetRef: "svc-mvp-test-01",
    delivrix_actions_required: ["propose_pause_ip", "update_sender_node_metadata"]
  },
  audit: { skillSlug: "smoke", modelVersion: "manual", promptVersion: "v1" },
  schemaVersion: "2026-05-18.v1"
};

async function main() {
  const existingNode = await smokeNode();
  if (existingNode) {
    outputs.registerAlreadyPresent = {
      node: existingNode,
      rollbackSnapshot: latestRollbackSnapshot("register-sender-node-local")
    };
  } else {
    outputs.registerPropose = await postHmac("/v1/agent/proposals", registerProposal);
    outputs.registerApprove = await approve("smoke-register-01", "op-juanes-a");
    outputs.registerExecute = await postHmac("/v1/agent/runbook/execute", {
      proposalId: "smoke-register-01",
      runbookId: "register-sender-node-local",
      input: {
        id: "svc-mvp-test-01",
        label: "MVP Test 01",
        provider: "webdock",
        status: "warming",
        ipAddress: "185.243.12.40",
        hostname: "svc-mvp-test-01.delivrix.local",
        dailyLimit: 50,
        warmupDay: 1
      }
    });
  }
  outputs.nodeAfterRegister = await smokeNode();

  outputs.warmingPropose = await postHmac("/v1/agent/proposals", warmingProposal);
  outputs.warmingApproveA = await approve("smoke-warming-01", "op-juanes-a");
  outputs.warmingApproveB = await approve("smoke-warming-01", "op-juanes-b");
  outputs.warmingExecute = await postHmac("/v1/agent/runbook/execute", {
    proposalId: "smoke-warming-01",
    runbookId: "warming-step",
    input: { nodeId: "svc-mvp-test-01" }
  });
  outputs.nodeAfterWarming = await smokeNode();

  outputs.pausePropose = await postHmac("/v1/agent/proposals", pauseProposal);
  outputs.pauseApprove = await approve("smoke-pause-01", "op-juanes-a");
  outputs.pauseExecute = await postHmac("/v1/agent/runbook/execute", {
    proposalId: "smoke-pause-01",
    runbookId: "pause-ip",
    input: { nodeId: "svc-mvp-test-01", reason: "smoke_reputation_pause" }
  });
  outputs.nodeAfterPause = await smokeNode();

  const pauseExecute = outputs.pauseExecute as { rollbackToken?: string };
  if (!pauseExecute.rollbackToken) {
    throw new Error("pause rollbackToken missing.");
  }

  outputs.pauseRevert = await postJson("/v1/agent/runbook/revert", {
    rollbackToken: pauseExecute.rollbackToken,
    reason: "reputation_recovered"
  }, {
    "X-Operator-Id": "op-juanes-a"
  });
  outputs.nodeAfterRevert = await smokeNode();
  outputs.rollbackSnapshots = rollbackSnapshotSummary();

  console.log(JSON.stringify(outputs, null, 2));
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

async function approve(proposalId: string, operatorId: string) {
  return postJson(`/v1/agent/proposals/${encodeURIComponent(proposalId)}/approve`, "", {
    "X-Operator-Id": operatorId
  });
}

async function smokeNode() {
  const response = await fetch(`${gatewayBaseUrl}/v1/sender-nodes`);
  const body = await response.json() as Array<Record<string, unknown>> | { nodes?: Array<Record<string, unknown>> };

  if (!response.ok) {
    throw new Error(`/v1/sender-nodes returned HTTP ${response.status}.`);
  }

  const nodes = Array.isArray(body) ? body : body.nodes ?? [];
  return nodes.find((node) => node.id === "svc-mvp-test-01") ?? null;
}

function latestRollbackSnapshot(runbookId: string) {
  const db = new DatabaseSync(sqlitePath);
  const row = db.prepare(`
    SELECT rollback_token AS rollbackToken, runbook_id AS runbookId, target_id AS targetId, status
    FROM rollback_snapshots
    WHERE runbook_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(runbookId) ?? null;
  db.close();
  return row;
}

function rollbackSnapshotSummary() {
  const db = new DatabaseSync(sqlitePath);
  const rows = db.prepare(`
    SELECT rollback_token AS rollbackToken, runbook_id AS runbookId, target_id AS targetId, status
    FROM rollback_snapshots
    ORDER BY created_at ASC
  `).all();
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM rollback_snapshots
    GROUP BY status
    ORDER BY status ASC
  `).all();
  db.close();

  return { rows, counts };
}

await main();
