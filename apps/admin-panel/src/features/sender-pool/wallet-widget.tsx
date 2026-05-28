/**
 * WalletWidget — versión MVP primitivo (decisión CTO D8 + visual D10+).
 *
 * Muestra el wallet operativo del agente para acciones costosas (hoy: solo
 * Route53 RegisterDomain). Lee audit events del gateway, filtra por mes actual
 * + action `oc.domain.registered`, suma `costUsd` de metadata y compara contra
 * el cap mensual configurado en env (`AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD`).
 *
 * Spec arquitectural completo en
 * `DOCUMENTACION/ARQUITECTURA_MEMORIA_AGENTE_DELIVRIX_2026_05_27.md` (§ wallet)
 * y decisión registrada como D8 en `SPRINT_DEMO_VIERNES_STATUS.md`. El wallet
 * inteligente con tablas dedicadas, ownership, optimización LLM, alertas
 * threshold, multi-wallet y refill entra en sprint S1 post-demo.
 *
 * Caption honesto en el widget: este es "wallet primitivo" — el S1 trae
 * control granular. El demo viernes ya muestra la metáfora wallet a jefes.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wallet, TrendingDown, AlertTriangle, Check } from "lucide-react";
import { getJson } from "../../shared/api/client.ts";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary.ts";

/* ============================================================
 * Tipos del audit event minimal — mirror del shape backend
 * ============================================================ */

interface AuditEventWire {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
  metadata?: {
    costUsd?: number;
    domain?: string;
    operationId?: string;
    [key: string]: unknown;
  };
}

interface AuditEventsResponse {
  events?: AuditEventWire[];
}

/* ============================================================
 * Constantes — vienen del env del gateway. Hoy hardcoded en frontend
 * porque el endpoint dedicado de wallet config entra en S1.
 * ============================================================ */

const CAP_USD = 50;
const WALLET_NAME = "Route53 Domains";
const TRACKED_ACTIONS = new Set([
  "oc.domain.registered",
  "register_domain_route53.success"
]);

/* ============================================================
 * Hooks
 * ============================================================ */

function useWalletTransactions() {
  return useQuery({
    queryKey: ["wallet", "transactions", "route53-domains"],
    queryFn: async () => {
      try {
        const data = await getJson<AuditEventsResponse>(READ_ENDPOINTS.auditEvents);
        return data.events ?? [];
      } catch {
        return [] as AuditEventWire[];
      }
    },
    refetchInterval: 30_000,
    staleTime: 15_000
  });
}

function isThisMonth(iso: string): boolean {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return false;
    const now = new Date();
    return (
      date.getUTCFullYear() === now.getUTCFullYear() &&
      date.getUTCMonth() === now.getUTCMonth()
    );
  } catch {
    return false;
  }
}

function extractCostUsd(event: AuditEventWire): number {
  const raw = event.metadata?.costUsd;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return raw;
}

/* ============================================================
 * <WalletWidget> — root
 * ============================================================ */

export function WalletWidget() {
  const txQuery = useWalletTransactions();

  const summary = useMemo(() => {
    const events = txQuery.data ?? [];
    const monthTx = events.filter(
      (e) => TRACKED_ACTIONS.has(e.action) && isThisMonth(e.occurredAt)
    );
    monthTx.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const spent = monthTx.reduce((acc, e) => acc + extractCostUsd(e), 0);
    const available = Math.max(0, CAP_USD - spent);
    const pctUsed = Math.min(100, (spent / CAP_USD) * 100);
    return { monthTx, spent, available, pctUsed };
  }, [txQuery.data]);

  const zone = zoneFromPct(summary.pctUsed);

  return (
    <section
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 18,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 12,
        boxShadow: "var(--shadow-sm)"
      }}
      aria-labelledby="wallet-widget-title"
    >
      <header className="flex items-center" style={{ gap: 10 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center shrink-0"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "var(--color-accent-tertiary-soft, var(--color-surface-sunken))",
            color: "var(--color-accent-tertiary)"
          }}
        >
          <Wallet size={16} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col" style={{ gap: 1, minWidth: 0 }}>
          <span
            id="wallet-widget-title"
            className="font-[family-name:var(--font-sans)] font-semibold truncate"
            style={{ fontSize: 13, color: "var(--color-text-primary)" }}
          >
            Wallet operativo · {WALLET_NAME}
          </span>
          <span
            className="font-[family-name:var(--font-caption)]"
            style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}
          >
            Mes en curso · cap configurado en `.env.local`
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <ZoneBadge zone={zone} />
      </header>

      <ProgressBar pct={summary.pctUsed} zone={zone} />

      <div
        className="grid"
        style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}
      >
        <Stat label="Cap mensual" value={formatUsd(CAP_USD)} tone="neutral" />
        <Stat
          label="Gastado"
          value={formatUsd(summary.spent)}
          tone={summary.spent > 0 ? "warning" : "neutral"}
          icon={<TrendingDown size={11} strokeWidth={1.75} />}
        />
        <Stat
          label="Disponible"
          value={formatUsd(summary.available)}
          tone={summary.available > CAP_USD * 0.2 ? "success" : "warning"}
        />
      </div>

      <TransactionsList
        transactions={summary.monthTx.slice(0, 5)}
        loading={txQuery.isLoading}
      />

      <p
        className="m-0 font-[family-name:var(--font-caption)]"
        style={{
          fontSize: 10.5,
          color: "var(--color-text-tertiary)",
          lineHeight: 1.5,
          paddingTop: 4,
          borderTop: "0.5px solid var(--color-border)"
        }}
      >
        Wallet primitivo · sprint S1 trae control granular, optimización del agente,
        alertas threshold (80/95/100%) y multi-wallet con ownership por humano.
      </p>
    </section>
  );
}

/* ============================================================
 * Sub-componentes
 * ============================================================ */

type Zone = "safe" | "warning" | "critical";

function zoneFromPct(pct: number): Zone {
  if (pct >= 95) return "critical";
  if (pct >= 80) return "warning";
  return "safe";
}

function ZoneBadge({ zone }: { zone: Zone }) {
  const label = zone === "safe" ? "Saludable" : zone === "warning" ? "Atención" : "Crítico";
  const Icon = zone === "safe" ? Check : zone === "warning" ? AlertTriangle : AlertTriangle;
  const tone =
    zone === "safe"
      ? { bg: "var(--color-success-soft)", fg: "var(--color-success)" }
      : zone === "warning"
        ? { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" }
        : { bg: "var(--color-critical-soft)", fg: "var(--color-critical)" };
  return (
    <span
      className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold"
      style={{
        gap: 4,
        padding: "3px 8px",
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        fontSize: 10,
        letterSpacing: "0.4px",
        textTransform: "uppercase"
      }}
    >
      <Icon size={10} strokeWidth={2} aria-hidden="true" />
      {label}
    </span>
  );
}

function ProgressBar({ pct, zone }: { pct: number; zone: Zone }) {
  const fill =
    zone === "safe"
      ? "var(--color-success)"
      : zone === "warning"
        ? "var(--color-warning)"
        : "var(--color-critical)";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={`Wallet ${WALLET_NAME} ${Math.round(pct)}% gastado`}
      style={{
        position: "relative",
        height: 8,
        background: "var(--color-surface-sunken)",
        borderRadius: 999,
        overflow: "hidden"
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: `${Math.max(2, pct)}%`,
          background: fill,
          borderRadius: 999,
          transition: "width 240ms ease, background 200ms ease"
        }}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon
}: {
  label: string;
  value: string;
  tone: "neutral" | "success" | "warning" | "critical";
  icon?: React.ReactNode;
}) {
  const color =
    tone === "success"
      ? "var(--color-success)"
      : tone === "warning"
        ? "var(--color-warning)"
        : tone === "critical"
          ? "var(--color-critical)"
          : "var(--color-text-primary)";
  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      <span
        className="font-[family-name:var(--font-caption)] font-semibold uppercase"
        style={{
          fontSize: 9.5,
          letterSpacing: "0.6px",
          color: "var(--color-text-tertiary)"
        }}
      >
        {label}
      </span>
      <span
        className="inline-flex items-center font-[family-name:var(--font-mono)] font-semibold"
        style={{ gap: 4, fontSize: 14, color, lineHeight: 1.2 }}
      >
        {icon ? <span style={{ color }}>{icon}</span> : null}
        {value}
      </span>
    </div>
  );
}

function TransactionsList({
  transactions,
  loading
}: {
  transactions: AuditEventWire[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <p
        className="m-0 font-[family-name:var(--font-mono)]"
        style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "8px 0" }}
      >
        Leyendo transacciones del audit log…
      </p>
    );
  }
  if (transactions.length === 0) {
    return (
      <p
        className="m-0 font-[family-name:var(--font-caption)]"
        style={{
          fontSize: 11,
          color: "var(--color-text-tertiary)",
          padding: "10px 0",
          lineHeight: 1.5
        }}
      >
        Sin compras este mes. El wallet está intacto — cuando OpenClaw registre un
        dominio aprovado, aparece acá con timestamp y firmante.
      </p>
    );
  }
  return (
    <ul
      className="flex flex-col"
      style={{ gap: 6, padding: 0, margin: 0, listStyle: "none" }}
    >
      {transactions.map((tx) => (
        <li
          key={tx.id}
          className="flex items-center"
          style={{
            gap: 10,
            padding: "8px 10px",
            background: "var(--color-surface-sunken)",
            borderRadius: 6
          }}
        >
          <div className="flex flex-col min-w-0" style={{ gap: 1, flex: 1 }}>
            <span
              className="font-[family-name:var(--font-mono)] truncate"
              style={{ fontSize: 11.5, color: "var(--color-text-primary)" }}
            >
              {tx.metadata?.domain ?? tx.targetId}
            </span>
            <span
              className="font-[family-name:var(--font-caption)]"
              style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
            >
              {formatDateShort(tx.occurredAt)} · firmado por{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{tx.actorId}</code>
            </span>
          </div>
          <span
            className="font-[family-name:var(--font-mono)] font-semibold"
            style={{ fontSize: 12, color: "var(--color-warning)" }}
          >
            -{formatUsd(extractCostUsd(tx))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ============================================================
 * Helpers
 * ============================================================ */

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatDateShort(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString("es-CO", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}
