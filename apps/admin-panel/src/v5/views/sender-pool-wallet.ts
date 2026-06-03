import type { AuditEvent } from "../../shared/api/client";

export interface WalletTx {
  id: string;
  occurredAt: string;
  domain: string;
  amount: number;
  actor: string;
}

const TRACKED_WALLET_ACTIONS = new Set([
  "oc.domain.registered",
  "register_domain_route53.success"
]);

export function computeWalletTransactions(events: AuditEvent[], now = new Date()): WalletTx[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const out: WalletTx[] = [];

  for (const event of events) {
    if (!TRACKED_WALLET_ACTIONS.has(event.action)) continue;
    const occurredAt = new Date(event.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) continue;
    if (occurredAt.getUTCFullYear() !== year || occurredAt.getUTCMonth() !== month) continue;

    const cost = Number(event.metadata?.costUsd ?? 0);
    if (!Number.isFinite(cost) || cost <= 0) continue;

    const metadataDomain = event.metadata?.domain;
    out.push({
      id: event.id,
      occurredAt: event.occurredAt,
      domain: typeof metadataDomain === "string" && metadataDomain.trim() ? metadataDomain : event.targetId,
      amount: cost,
      actor: event.actorId ?? "-"
    });
  }

  return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
}
