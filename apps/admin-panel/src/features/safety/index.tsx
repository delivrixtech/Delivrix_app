/**
 * Seguridad — Pencil frame `fAJG6` / `CUxJ8`.
 *
 * Estructura: Hero + KPI row + Two col + Audit + Compliance row + Footer.
 *
 * Datos: `data.operatingNorth` (allowed/blocked/gates/roles) + `data.killSwitch`
 * (enabled/reason/updatedBy) + `data.health.operatingNorth` (booleans).
 */

import { Power, ShieldAlert, ShieldCheck } from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatDateTime,
  formatNumber,
  humanize
} from "../../shared/lib/formatters.ts";

export function SafetySection({ data }: { data: DashboardData }) {
  const on = data.operatingNorth;
  const ks = data.killSwitch;
  const liveWrites = on.liveInfrastructureWritesEnabled;
  const smtpReal = on.delivrixSendsRealEmail;
  const nfcWrites = on.nfcProductionWritesEnabled;

  return (
    <section className="flex flex-col gap-5" style={{ maxWidth: 1352 }}>
      <Hero killSwitchOn={ks.enabled} anyOpen={liveWrites || smtpReal || nfcWrites} />

      <KpiRow killSwitchOn={ks.enabled} liveWrites={liveWrites} smtpReal={smtpReal} nfcWrites={nfcWrites} />

      <TwoCol on={on} ks={ks} />

      <AuditCard ks={ks} on={on} />

      <ComplianceRow gates={on.gates ?? []} />

      <Footer phase={on.phase} />
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Hero
 * ------------------------------------------------------------------------ */
function Hero({ killSwitchOn, anyOpen }: { killSwitchOn: boolean; anyOpen: boolean }) {
  const headline = killSwitchOn
    ? "Kill switch activo"
    : anyOpen
      ? "Frontera abierta"
      : "Barandillas firmes";
  const tone = killSwitchOn ? "critical" : anyOpen ? "warning" : "success";
  const toneBg = tone === "critical" ? "#FEE2E2" : tone === "warning" ? "#FEF3C7" : "#DCFCE7";
  const toneFg = tone === "critical" ? "#B91C1C" : tone === "warning" ? "#B45309" : "#15803D";
  return (
    <header className="flex items-end justify-between gap-3 flex-wrap">
      <div className="flex flex-col gap-2.5 min-w-0">
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          NORTE OPERATIVO · BARANDILLAS
        </span>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
          style={{ letterSpacing: "-0.4px" }}
        >
          Seguridad y frontera operativa
        </h1>
        <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
          Kill switch, acciones permitidas y bloqueadas, gates pendientes y roles del norte.
          Todo se lee desde el contrato; el panel no puede mover ningún booleano.
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
  killSwitchOn,
  liveWrites,
  smtpReal,
  nfcWrites
}: {
  killSwitchOn: boolean;
  liveWrites: boolean;
  smtpReal: boolean;
  nfcWrites: boolean;
}) {
  return (
    <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        icon={<Power size={14} strokeWidth={1.75} />}
        label="KILL SWITCH"
        value={killSwitchOn ? "ACTIVO" : "ARMADO"}
        pillTone={killSwitchOn ? "critical" : "success"}
        pillText={killSwitchOn ? "corte real" : "listo"}
        microcopy={killSwitchOn ? "Detenido por intervención humana" : "Prueba en modo simulado"}
      />
      <Kpi
        icon={<ShieldCheck size={14} strokeWidth={1.75} />}
        label="INFRA WRITES"
        value={liveWrites ? "ENABLED" : "DISABLED"}
        pillTone={liveWrites ? "critical" : "success"}
        pillText={liveWrites ? "atención" : "dry-run"}
        microcopy={liveWrites ? "Riesgo: writes en vivo" : "Solo dry-run en MVP"}
      />
      <Kpi
        icon={<ShieldCheck size={14} strokeWidth={1.75} />}
        label="SMTP REAL"
        value={smtpReal ? "ENABLED" : "DISABLED"}
        pillTone={smtpReal ? "critical" : "success"}
        pillText={smtpReal ? "envío real" : "simulado"}
        microcopy={smtpReal ? "Está enviando correo real" : "Solo simulación"}
      />
      <Kpi
        icon={<ShieldCheck size={14} strokeWidth={1.75} />}
        label="NFC WRITES"
        value={nfcWrites ? "ENABLED" : "DISABLED"}
        pillTone={nfcWrites ? "critical" : "success"}
        pillText={nfcWrites ? "productivo" : "bridge mock"}
        microcopy={nfcWrites ? "Productivo — revisar contrato" : "Bridge en mock"}
      />
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  pillTone,
  pillText,
  microcopy
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  pillTone: "success" | "critical";
  pillText: string;
  microcopy: string;
}) {
  const tone = pillTone === "success" ? { bg: "#DCFCE7", fg: "#15803D" } : { bg: "#FEE2E2", fg: "#B91C1C" };
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
        className="text-[24px] font-[family-name:var(--font-mono)] font-bold leading-none text-[#1A1410] tabular-nums"
        style={{ letterSpacing: "-0.4px" }}
      >
        {value}
      </div>
      <p className="m-0 text-[11px] font-[family-name:var(--font-caption)] text-[#5C544A]">
        {microcopy}
      </p>
    </article>
  );
}

/* --------------------------------------------------------------------------
 * Two col — Allowed + Blocked
 * ------------------------------------------------------------------------ */
function TwoCol({
  on,
  ks
}: {
  on: DashboardData["operatingNorth"];
  ks: DashboardData["killSwitch"];
}) {
  return (
    <div className="grid gap-3.5 grid-cols-1 lg:grid-cols-2 items-start">
      <ActionList
        title="Acciones permitidas"
        items={on.allowedActions ?? []}
        tone="success"
        empty="Sin acciones permitidas configuradas."
      />
      <ActionList
        title="Acciones bloqueadas"
        items={on.blockedActions ?? []}
        tone="critical"
        empty="Sin acciones bloqueadas explícitamente."
        killSwitchOn={ks.enabled}
      />
    </div>
  );
}

function ActionList({
  title,
  items,
  tone,
  empty,
  killSwitchOn
}: {
  title: string;
  items: string[];
  tone: "success" | "critical";
  empty: string;
  killSwitchOn?: boolean;
}) {
  const t = tone === "success" ? { bg: "#DCFCE7", fg: "#15803D" } : { bg: "#FEE2E2", fg: "#B91C1C" };
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
      {killSwitchOn ? (
        <p className="m-0 mt-1 text-[11px] font-[family-name:var(--font-caption)] text-[#B91C1C]">
          Kill switch activo — bloqueos están en efecto a nivel infraestructura.
        </p>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Audit card — historial del kill switch + cambios del norte
 * ------------------------------------------------------------------------ */
function AuditCard({
  ks,
  on
}: {
  ks: DashboardData["killSwitch"];
  on: DashboardData["operatingNorth"];
}) {
  const rows: Array<{ timestamp: string; actor: string; action: string; detail: string }> = [
    {
      timestamp: formatDateTime(ks.updatedAt),
      actor: ks.updatedBy || "system",
      action: ks.enabled ? "kill_switch.enabled" : "kill_switch.armed",
      detail: ks.reason || "—"
    },
    {
      timestamp: formatDateTime(new Date().toISOString()),
      actor: "openclaw",
      action: "operating_north.read",
      detail: `phase=${on.phase}`
    }
  ];
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Auditoría reciente
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          append-only
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {rows.map((row, i) => (
          <li
            key={i}
            className="grid grid-cols-[140px_120px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 py-2.5 text-[11px] font-[family-name:var(--font-mono)] border-b border-[#EAE0CE] last:border-b-0"
          >
            <span className="text-[#5C544A] tabular-nums truncate">{row.timestamp}</span>
            <span className="text-[#EA580C] truncate">{row.actor}</span>
            <span className="text-[#1A1410] truncate">{row.action}</span>
            <span className="text-[#8A8073] truncate text-right">{row.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Compliance row — gates + roles
 * ------------------------------------------------------------------------ */
function ComplianceRow({ gates }: { gates: string[] }) {
  if (gates.length === 0) {
    return (
      <section
        className="flex items-center gap-3 rounded-[8px] border border-[#15803D] bg-[#DCFCE7]"
        style={{ padding: 20 }}
      >
        <ShieldCheck size={16} strokeWidth={1.75} className="text-[#15803D]" aria-hidden="true" />
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[#15803D]">
          Sin gates de cumplimiento pendientes.
        </p>
      </section>
    );
  }
  return (
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
        Subir volumen o autonomía exige cumplir cada gate y dejarlo auditado. Cada gate
        bloquea acciones específicas del operating-north.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {gates.map((g) => (
          <span
            key={g}
            className="inline-block rounded-[4px] border border-[#B45309] bg-[#FFFFFF] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] text-[#B45309]"
          >
            {humanize(g)}
          </span>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Footer — roles del norte
 * ------------------------------------------------------------------------ */
function Footer({ phase }: { phase: string }) {
  return (
    <footer
      className="flex items-center justify-between gap-3 pt-3 border-t border-[#EAE0CE]"
    >
      <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
        operating-north phase
      </span>
      <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410]">
        {phase}
      </span>
    </footer>
  );
}
