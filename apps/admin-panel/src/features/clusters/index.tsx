/**
 * Clústeres — port desde Pencil frame `V8h2t` (sección Clusters únicamente).
 *
 * Seguridad vive en su pantalla aparte (`features/safety`). Esta solo muestra
 * el inventario de clústeres + sender nodes + acciones siguientes.
 */

import { Server } from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatNumber,
  humanize
} from "../../shared/lib/formatters.ts";

export function ClustersSection({ data }: { data: DashboardData }) {
  const clusters = data.clusters;
  const totals = clusters.totals;
  const totalClusters = totals.clusters ?? clusters.clusters.length;
  const totalSenders =
    totals.senderNodes ?? clusters.clusters.reduce((sum, c) => sum + c.senderNodes.length, 0);
  const totalActiveOrWarming = totals.activeOrWarmingNodes ?? 0;
  const totalProvisioningRuns = totals.provisioningRuns ?? 0;

  return (
    <section className="flex flex-col gap-5" style={{ maxWidth: 1352 }}>
      <Hero />

      <KpiRow
        clusters={totalClusters}
        senderNodes={totalSenders}
        activeOrWarming={totalActiveOrWarming}
        provisioningRuns={totalProvisioningRuns}
      />

      <div className="flex flex-col gap-3.5">
        {clusters.clusters.length === 0 ? (
          <EmptyCard message="Sin clústeres bajo gobierno. Generar plan de topología desde Onboarding." />
        ) : (
          clusters.clusters.map((cluster, index) => (
            <ClusterCard key={cluster.id} cluster={cluster} index={index + 1} />
          ))
        )}
        {clusters.nextActions.length > 0 ? (
          <NextActions actions={clusters.nextActions} />
        ) : null}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Hero
 * ------------------------------------------------------------------------ */
function Hero() {
  return (
    <header className="flex flex-col gap-2.5">
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
        style={{ letterSpacing: "1.2px" }}
      >
        INFRAESTRUCTURA · CLÚSTERES
      </span>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Clústeres y nodos de envío
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Inventario de clústeres de sender nodes, su salud y reputación. Plan dry-run y acciones
        siguientes salen directo del contrato `/v1/admin/clusters`.
      </p>
    </header>
  );
}

/* --------------------------------------------------------------------------
 * KPI row
 * ------------------------------------------------------------------------ */
function KpiRow({
  clusters,
  senderNodes,
  activeOrWarming,
  provisioningRuns
}: {
  clusters: number;
  senderNodes: number;
  activeOrWarming: number;
  provisioningRuns: number;
}) {
  return (
    <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        icon={<Server size={14} strokeWidth={1.75} />}
        label="CLÚSTERES"
        value={formatNumber(clusters)}
        pillTone="info"
        pillText="bajo gobierno"
      />
      <Kpi
        icon={<Server size={14} strokeWidth={1.75} />}
        label="SENDER NODES"
        value={formatNumber(senderNodes)}
        pillTone="success"
        pillText="inventariados"
      />
      <Kpi
        icon={<Server size={14} strokeWidth={1.75} />}
        label="ACTIVOS / WARMING"
        value={formatNumber(activeOrWarming)}
        pillTone={activeOrWarming > 0 ? "success" : "warning"}
        pillText={activeOrWarming > 0 ? "operando" : "sin tráfico"}
      />
      <Kpi
        icon={<Server size={14} strokeWidth={1.75} />}
        label="PROVISIONING RUNS"
        value={formatNumber(provisioningRuns)}
        pillTone="info"
        pillText="dry-run"
      />
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  pillTone,
  pillText
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  pillTone: "success" | "info" | "warning" | "critical";
  pillText: string;
}) {
  const tone = pillStyle(pillTone);
  return (
    <article
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" style={{ color: "#8A8073" }}>
            {icon}
          </span>
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
            style={{ letterSpacing: "1px" }}
          >
            {label}
          </span>
        </div>
        <span
          className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ background: tone.bg, color: tone.fg }}
        >
          {pillText}
        </span>
      </header>
      <div
        className="text-[28px] font-[family-name:var(--font-mono)] font-bold leading-none text-[#1A1410] tabular-nums"
        style={{ letterSpacing: "-0.4px" }}
      >
        {value}
      </div>
    </article>
  );
}

function pillStyle(tone: "success" | "info" | "warning" | "critical") {
  if (tone === "success") return { bg: "#DCFCE7", fg: "#15803D" };
  if (tone === "info") return { bg: "#DBEAFE", fg: "#1D4ED8" };
  if (tone === "warning") return { bg: "#FEF3C7", fg: "#B45309" };
  return { bg: "#FEE2E2", fg: "#B91C1C" };
}

/* --------------------------------------------------------------------------
 * Cluster card
 * ------------------------------------------------------------------------ */
function ClusterCard({
  cluster,
  index
}: {
  cluster: DashboardData["clusters"]["clusters"][number];
  index: number;
}) {
  const tone = clusterTone(cluster.managementState);
  return (
    <article
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{
        padding: 20,
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
        borderLeftWidth: 4,
        borderLeftColor: tone.accent
      }}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 place-items-center rounded-[6px] bg-[#F7F2EA] text-[13px] font-[family-name:var(--font-mono)] font-semibold text-[#5C544A] tabular-nums shrink-0"
          >
            {index}
          </span>
          <div className="flex flex-col gap-0.5 min-w-0">
            <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
              {humanize(cluster.provider)}
            </h3>
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
              {cluster.id}
            </code>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="inline-block rounded-[4px] border border-[#EAE0CE] bg-[#FFFBF5] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A]"
          >
            {formatNumber(cluster.senderNodes.length)} nodos
          </span>
          <span
            className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
            style={{ background: tone.bg, color: tone.fg }}
          >
            {compactLabel(cluster.managementState)}
          </span>
        </div>
      </header>

      {cluster.senderNodes.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Cluster sin sender nodes registrados.
        </p>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr
              className="text-left text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
              style={{ letterSpacing: "0.4px" }}
            >
              <th className="font-semibold py-1.5">Nodo</th>
              <th className="font-semibold py-1.5">Estado</th>
              <th className="font-semibold py-1.5">Salud</th>
            </tr>
          </thead>
          <tbody>
            {cluster.senderNodes.map((node, i) => {
              const ntone = clusterTone(node.status);
              const healthTone = node.healthSeverity ? clusterTone(node.healthSeverity) : null;
              return (
                <tr
                  key={node.id}
                  className={`border-t border-[#EAE0CE] ${i === 0 ? "border-t-0" : ""}`}
                >
                  <td className="py-2 pr-3 text-[#1A1410]">{node.label}</td>
                  <td className="py-2 pr-3">
                    <span
                      className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
                      style={{ background: ntone.bg, color: ntone.fg }}
                    >
                      {compactLabel(node.status)}
                    </span>
                  </td>
                  <td className="py-2">
                    {healthTone ? (
                      <span
                        className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
                        style={{ background: healthTone.bg, color: healthTone.fg }}
                      >
                        {compactLabel(node.healthSeverity!)}
                      </span>
                    ) : (
                      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
                        unknown
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </article>
  );
}

function clusterTone(state: string): { bg: string; fg: string; accent: string } {
  const t = state.toLowerCase();
  if (["ready", "ok", "healthy", "active"].includes(t))
    return { bg: "#DCFCE7", fg: "#15803D", accent: "#15803D" };
  if (["warning", "needs_review", "warming"].includes(t))
    return { bg: "#FEF3C7", fg: "#B45309", accent: "#B45309" };
  if (["blocked", "critical", "quarantined"].includes(t))
    return { bg: "#FEE2E2", fg: "#B91C1C", accent: "#B91C1C" };
  if (t === "unknown") return { bg: "#EDE9FE", fg: "#7C3AED", accent: "#7C3AED" };
  return { bg: "#F5F5F4", fg: "#5C544A", accent: "#EAE0CE" };
}

function NextActions({
  actions
}: {
  actions: DashboardData["clusters"]["nextActions"];
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Acciones siguientes
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          {formatNumber(actions.length)} en backlog
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col gap-2">
        {actions.map((a) => {
          const tone = clusterTone(a.status);
          return (
            <li
              key={a.id}
              className="flex items-center justify-between gap-3 rounded-[6px] border border-[#EAE0CE] bg-[#F7F2EA] px-3 py-2.5 text-[12px]"
            >
              <span className="text-[#1A1410] font-[family-name:var(--font-sans)]">{a.label}</span>
              <span
                className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
                style={{ background: tone.bg, color: tone.fg }}
              >
                {compactLabel(a.status)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EmptyCard({ message }: { message: string }) {
  return (
    <section
      className="rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">{message}</p>
    </section>
  );
}
