import type { AuditEvent } from "../../shared/api/client";

export interface WalletTx {
  id: string;
  occurredAt: string;
  domain: string;
  /** `null` = la compra se registró SIN costo en la metadata. No es $0: es "no se registró". */
  amount: number | null;
  actor: string;
}

/**
 * Las acciones que el gateway emite de verdad al registrar un dominio.
 *
 * Estaba desconectada del registrador que HOY está habilitado: la lista traía
 * "register_domain_route53.success", que no la emite NADIE en el repo (solo aparecía acá y en su
 * propio test), y le faltaba "oc.domain.register", que es la que emite el alta por Namecheap
 * (domains-namecheap-purchase.ts:290, con costUsd en la metadata) — con la compra Namecheap
 * habilitada en producción y 4 dominios del inventario comprados por ahí. Consecuencia: la
 * primera compra Namecheap dejaba el KPI en "$0 confirmado" sobre plata gastada.
 */
const TRACKED_WALLET_ACTIONS = new Set([
  "oc.domain.registered", // Route53 (domains-purchase.ts:655)
  "oc.domain.register" // Namecheap (domains-namecheap-purchase.ts:290)
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

    // Una compra sin costUsd YA NO se descarta con `continue`. Antes desaparecía de Movimientos
    // como si no hubiera existido: el dominio se compró igual, la plata salió igual, y el panel
    // mostraba una lista más corta sin decir nada. Ahora viaja con amount null y la vista la
    // rotula "costo no registrado" — no suma al total, pero se ve.
    const raw = Number(event.metadata?.costUsd ?? Number.NaN);
    const cost = Number.isFinite(raw) && raw > 0 ? raw : null;

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
