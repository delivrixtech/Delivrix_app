/**
 * Clusters & Security — port desde Pencil frame `V8h2t` / `aTHLP`.
 *
 * Estructura:
 *   Hero (tpwNV) — PageHeader vertical
 *   KPI row (xlQ5q) — 4 cards: Clusters / Sender nodes / Infra writes / Kill switch
 *   Tabs (Clusters / Barandillas) — pattern del Collector
 *   Clusters tab: tabla por cluster con sender nodes
 *   Barandillas tab: SecuritySection con allowed/blocked actions, gates, roles
 */

import { useState } from "react";
import { Power, ShieldAlert, ShieldCheck, Server } from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatNumber,
  humanize
} from "../../shared/lib/formatters.ts";

type TabKey = "clusters" | "barandillas";

export function ClustersSecuritySection({ data }: { data: DashboardData }) {
  const [tab, setTab] = useState<TabKey>("clusters");
  const clusters = data.clusters;
  const killSwitchOn = data.killSwitch.enabled;
  const liveWrites = data.operatingNorth.liveInfrastructureWritesEnabled;
  const totalSenders =
    clusters.totals.senderNodes ??
    clusters.clusters.reduce((sum, c) => sum + c.senderNodes.length, 0);

  return (
    <section className="flex flex-col gap-5" style={{ maxWidth: 1352 }}>
      <Hero killSwitchOn={killSwitchOn} liveWrites={liveWrites} />

      <KpiRow
        clusters={clusters.totals.clusters ?? clusters.clusters.length}
        senderNodes={totalSenders}
        infraWrites={liveWrites}
        killSwitchOn={killSwitchOn}
      />

      <Tabs current={tab} onChange={setTab} />

      {tab === "clusters" ? <ClustersTab clusters={clusters} /> : null}
      {tab === "barandillas" ? <SecurityTab data={data} /> : null}
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Hero
 * ------------------------------------------------------------------------ */
function Hero({
  killSwitchOn,
  liveWrites
}: {
  killSwitchOn: boolean;
  liveWrites: boolean;
}) {
  const headline = killSwitchOn
    ? "Kill switch activo"
    : liveWrites
      ? "Frontera abierta"
      : "Barandillas firmes";
  const tone = killSwitchOn ? "critical" : liveWrites ? "warning" : "success";
  const toneBg = tone === "critical" ? "#FEE2E2" : tone === "warning" ? "#FEF3C7" : "#DCFCE7";
  const toneFg = tone === "critical" ? "#B91C1C" : tone === "warning" ? "#B45309" : "#15803D";
  return (
    <header className="flex items-end justify-between gap-3 flex-wrap">
      <div className="flex flex-col gap-2.5 min-w-0">
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          INFRAESTRUCTURA · SEGURIDAD
        </span>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
          style={{ letterSpacing: "-0.4px" }}
        >
          Clústeres y nodos de envío
        </h1>
        <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
          Inventario de clústeres de sender nodes, su salud y reputación, más la frontera
          operativa (kill switch, acciones permitidas, gates pendientes, roles del norte).
        </p>
      </div>
      <span
        className="inline-block rounded-[4px] px-3 py-1.5 text-[11px] font-[family-name:var(--font-caption)] font-bold"
        style={{ background: toneBg, color: toneFg }}
      >
        {headline}
      </span>
    </header>
  );
}

/* --------------------------------------------------------------------------
 * KPI row
 * ------------------------------------------------------------------------ */
function KpiRow({
  clusters,
  senderNodes,
  infraWrites,
  killSwitchOn
}: {
  clusters: number;
  senderNodes: number;
  infraWrites: boolean;
  killSwitchOn: boolean;
}) {
  return (
    <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        icon={<Server size={14} strokeWidth={1.75} aria-hidden="true" />}
        label="CLÚSTERES"
        value={formatNumber(clusters)}
        pillTone="info"
        pillText="bajo gobierno"
      />
      <Kpi
        icon={<Server size={14} strokeWidth={1.75} aria-hidden="true" />}
        label="SENDER NODES"
        value={formatNumber(senderNodes)}
        pillTone="success"
        pillText="inventario completo"
      />
      <Kpi
        icon={<ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />}
        label="INFRA WRITES"
        value={infraWrites ? "ENABLED" : "DISABLED"}
        pillTone={infraWrites ? "critical" : "success"}
        pillText={infraWrites ? "atención" : "dry-run"}
      />
      <Kpi
        icon={<Power size={14} strokeWidth={1.75} aria-hidden="true" />}
        label="KILL SWITCH"
        value={killSwitchOn ? "ACTIVO" : "ARMADO"}
        pillTone={killSwitchOn ? "critical" : "success"}
        pillText={killSwitchOn ? "corte real" : "listo"}
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
  const tone = pillToneStyle(pillTone);
  return (
    <article
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span style={{ color: "#8A8073" }} aria-hidden="true">
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

function pillToneStyle(tone: "success" | "info" | "warning" | "critical") {
  switch (tone) {
    case "success":
      return { bg: "#DCFCE7", fg: "#15803D" };
    case "info":
      return { bg: "#DBEAFE", fg: "#1D4ED8" };
    case "warning":
      return { bg: "#FEF3C7", fg: "#B45309" };
    case "critical":
      return { bg: "#FEE2E2", fg: "#B91C1C" };
  }
}

/* --------------------------------------------------------------------------
 * Tabs (Collector pattern)
 * ------------------------------------------------------------------------ */
function Tabs({ current, onChange }: { current: TabKey; onChange: (k: TabKey) => void }) {
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "clusters", label: "Clusters" },
    { key: "barandillas", label: "Barandillas" }
  ];
  return (
    <div className="flex items-end gap-1 border-b border-[#EAE0CE]" style={{ marginBottom: -1 }}>
      {tabs.map((t) => {
        const active = t.key === current;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className="relative px-3.5 py-2.5 text-[13px] font-[family-name:var(--font-sans)] transition-colors"
            style={{
              color: active ? "#1A1410" : "#5C544A",
              fontWeight: active ? 600 : 500
            }}
          >
            {t.label}
            <span
              aria-hidden="true"
              className="absolute left-0 right-0 -bottom-px h-px"
              style={{ background: active ? "#EA580C" : "transparent" }}
            />
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Clusters tab
 * ------------------------------------------------------------------------ */
function ClustersTab({ clusters }: { clusters: DashboardData["clusters"] }) {
  return (
    <div className="flex flex-col gap-3.5">
      {clusters.clusters.length === 0 ? (
        <EmptyCard message="Sin clústeres bajo gobierno. Generar plan de topología desde Onboarding." />
      ) : (
        clusters.clusters.map((cluster, index) => (
          <ClusterCard key={cluster.id} cluster={cluster} index={index + 1} />
        ))
      )}
      {clusters.nextActions.length > 0 ? <NextActionsList actions={clusters.nextActions} /> : null}
    </div>
  );
}

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
            <tr className="text-left text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]" style={{ letterSpacing: "0.4px" }}>
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

function NextActionsList({
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

/* --------------------------------------------------------------------------
 * Security tab — barandillas
 * ------------------------------------------------------------------------ */
function SecurityTab({ data }: { data: DashboardData }) {
  const on = data.operatingNorth;
  const allowed = on.allowedActions ?? [];
  const blocked = on.blockedActions ?? [];
  const gates = on.gates ?? [];

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid gap-3.5 grid-cols-1 lg:grid-cols-2">
        <ActionListCard
          title="Acciones permitidas"
          items={allowed}
          tone="success"
          empty="Sin acciones permitidas configuradas."
        />
        <ActionListCard
          title="Acciones bloqueadas"
          items={blocked}
          tone="critical"
          empty="Sin acciones bloqueadas explícitamente."
        />
      </div>

      {gates.length > 0 ? (
        <section
          className="flex flex-col gap-2.5 rounded-[8px] border border-[#B45309]"
          style={{ padding: 20, background: "#FEF3C7" }}
        >
          <header className="flex items-center gap-2">
            <ShieldAlert size={16} strokeWidth={1.75} className="text-[#B45309]" aria-hidden="true" />
            <h3 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#B45309]">
              Gates por cumplir ({formatNumber(gates.length)})
            </h3>
          </header>
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#1A1410]">
            Subir volumen o autonomía exige cumplir cada gate y dejarlo auditado.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {gates.map((gate) => (
              <span
                key={gate}
                className="inline-block rounded-[4px] border border-[#B45309] bg-[#FFFFFF] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] text-[#B45309]"
              >
                {gate}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section
        className="flex flex-col gap-3.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
        style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
      >
        <header className="flex items-center gap-2">
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Roles del norte operativo
          </h2>
          <span className="flex-1" aria-hidden="true" />
          <span
            className="inline-block rounded-[4px] border border-[#EAE0CE] bg-[#F7F2EA] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] text-[#5C544A]"
          >
            read-only
          </span>
        </header>
        <dl className="m-0 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <RoleField label="Delivrix" value={compactLabel(on.delivrixRole)} />
          <RoleField label="OpenClaw" value={compactLabel(on.openClawRole)} />
          <RoleField label="NFC" value={compactLabel(on.nfcRole)} />
        </dl>
      </section>

      {data.killSwitch.enabled ? (
        <section
          className="flex flex-col gap-2 rounded-[8px] border-l-4"
          style={{ padding: 20, background: "#FFFFFF", borderLeftColor: "#B91C1C", border: "1px solid #EAE0CE", borderLeftWidth: 4 }}
        >
          <header className="flex items-center gap-2">
            <Power size={16} strokeWidth={1.75} className="text-[#B91C1C]" aria-hidden="true" />
            <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#B91C1C]">
              Kill switch activo
            </h3>
          </header>
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
            {data.killSwitch.reason || "Sin razón registrada."} — activado por{" "}
            <span className="font-[family-name:var(--font-mono)] text-[#1A1410]">
              {data.killSwitch.updatedBy || "system"}
            </span>
            .
          </p>
        </section>
      ) : null}
    </div>
  );
}

function ActionListCard({
  title,
  items,
  tone,
  empty
}: {
  title: string;
  items: string[];
  tone: "success" | "critical";
  empty: string;
}) {
  const t = pillToneStyle(tone);
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          {title}
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ background: t.bg, color: t.fg }}
        >
          {formatNumber(items.length)}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span
              key={item}
              className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)]"
              style={{ background: t.bg, color: t.fg }}
            >
              {compactLabel(item)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function RoleField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[6px] bg-[#F7F2EA] px-3 py-2.5">
      <dt
        className="m-0 text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
        style={{ letterSpacing: "0.4px" }}
      >
        {label}
      </dt>
      <dd className="m-0 text-[13px] font-[family-name:var(--font-sans)] text-[#1A1410]">
        {value}
      </dd>
    </div>
  );
}
