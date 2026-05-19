import { auditLog } from "../../lib/audit.js";

const GATEWAY_BASE = process.env.DELIVRIX_GATEWAY_URL ?? "http://host.docker.internal:3000";
const BEARER = process.env.DELIVRIX_OPENCLAW_TOKEN ?? "";

export interface ReadResult<T> {
  endpoint: string;
  ok: boolean;
  data?: T;
  error?: string;
}

async function readEndpoint<T>(path: string, auditId: string): Promise<ReadResult<T>> {
  try {
    const res = await fetch(`${GATEWAY_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${BEARER}`
      }
    });

    if (!res.ok) {
      await auditLog.append({
        actorType: "openclaw",
        actorId: "openclaw-hostinger-prod",
        action: auditId,
        targetType: "gateway_read",
        targetId: path,
        riskLevel: "low",
        metadata: { status: res.status, responseOk: false }
      });
      return { endpoint: path, ok: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as T;
    await auditLog.append({
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: auditId,
      targetType: "gateway_read",
      targetId: path,
      riskLevel: "low",
      metadata: { status: 200, responseOk: true }
    });
    return { endpoint: path, ok: true, data };
  } catch (err) {
    await auditLog.append({
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: auditId,
      targetType: "gateway_read",
      targetId: path,
      riskLevel: "low",
      metadata: { responseOk: false, error: String(err) }
    });
    return { endpoint: path, ok: false, error: String(err) };
  }
}

export interface GatewayReads {
  sendResults: ReadResult<unknown>;
  ipReputation: ReadResult<unknown>;
  stuckJobs: ReadResult<unknown>;
  senderNodes: ReadResult<unknown>;
  auditEvents: ReadResult<unknown>;
}

export async function fetchAllReads(): Promise<GatewayReads> {
  const [sendResults, ipReputation, stuckJobs, senderNodes, auditEvents] = await Promise.all([
    readEndpoint("/v1/send-results", "oc.read.send_results"),
    readEndpoint("/v1/ip-reputation/reports", "oc.read.ip_reputation"),
    readEndpoint("/v1/stuck-jobs", "oc.read.stuck_jobs"),
    readEndpoint("/v1/sender-nodes", "oc.read.sender_nodes"),
    readEndpoint("/v1/audit-events?limit=50", "oc.read.audit")
  ]);

  return { sendResults, ipReputation, stuckJobs, senderNodes, auditEvents };
}
