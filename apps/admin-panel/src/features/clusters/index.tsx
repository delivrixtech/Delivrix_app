/**
 * Clústeres — port LITERAL desde Pencil frame `V8h2t` / `aTHLP`.
 *
 * Estructura:
 *   Hero (tpwNV): eyebrow + título + descripción
 *   KPI row (xlQ5q): 5 KPIs (Clústeres / Nodos / Warming / Degradadas / Kill switch)
 *   TwoCol (T9mlZm): ClusterTable (flex) + DetailPanel + OpenClaw prompt (320w)
 *   SecuritySection (ux3Qt): 9 gates + kill switch card + audit
 */

import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Eye,
  Flame,
  Mail,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";

export function ClustersSection({ data }: { data: DashboardData }) {
  void data;
  return (
    <section className="flex flex-col" style={{ gap: 20, maxWidth: 1352 }}>
      <Hero />
      <KpiRow />
      <TwoCol />
      <SecuritySection />
    </section>
  );
}

/* ============================================================
 * Hero
 * ============================================================ */
function Hero() {
  return (
    <header className="flex flex-col" style={{ gap: 6 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          FLOTA SUPERVISADA
        </span>
        <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "#8A8073" }} />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Actualizado hace 14s
        </span>
      </div>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Clústeres y nodos de envío
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Capacidad preparada, observada y gobernada por gates humanos. Sin envíos reales en el MVP.
      </p>
    </header>
  );
}

/* ============================================================
 * KPI row (xlQ5q) — 5 KPIs literales
 * ============================================================ */
function KpiRow() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5" style={{ gap: 14 }}>
      <Kpi
        icon={<Server size={16} strokeWidth={1.75} style={{ color: "#1D4ED8" }} aria-hidden="true" />}
        label="Clústeres totales"
        value="8"
        sub="En 4 regiones · 24 zonas"
      />
      <Kpi
        icon={<Mail size={16} strokeWidth={1.75} style={{ color: "#15803D" }} aria-hidden="true" />}
        label="Nodos de envío"
        value="148"
        sub="+6 esta semana · /v1/sender-nodes"
      />
      <Kpi
        icon={<Flame size={16} strokeWidth={1.75} style={{ color: "#EA580C" }} aria-hidden="true" />}
        label="IPs en calentamiento"
        value="42"
        sub="día 9 / 28 promedio"
      />
      <Kpi
        icon={<TrendingDown size={16} strokeWidth={1.75} style={{ color: "#B91C1C" }} aria-hidden="true" />}
        label="IPs degradadas"
        value="7"
        sub="pendientes de revisar"
      />
      <Kpi
        icon={<ShieldCheck size={16} strokeWidth={1.75} style={{ color: "#15803D" }} aria-hidden="true" />}
        label="Interruptor de corte"
        value="ARMADO"
        valueSize={24}
        sub="Última prueba hace 14 min"
      />
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
  valueSize = 32
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  valueSize?: number;
}) {
  return (
    <article
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 8,
        padding: 16,
        borderRadius: 6,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(26, 20, 16, 0.08)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{ width: 28, height: 28, borderRadius: 6, background: "#F7F2EA", border: "1px solid #EAE0CE" }}
        >
          {icon}
        </span>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#5C544A]"
          style={{ letterSpacing: "0.4px" }}
        >
          {label}
        </span>
      </header>
      <span
        className="font-[family-name:var(--font-mono)] font-bold leading-none text-[#1A1410] tabular-nums"
        style={{ fontSize: valueSize, letterSpacing: "-0.6px" }}
      >
        {value}
      </span>
      <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">{sub}</span>
    </article>
  );
}

/* ============================================================
 * TwoCol — ClusterTable + DetailPanel + OpenClaw
 * ============================================================ */
function TwoCol() {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
      <ClusterTable />
      <RightCol />
    </div>
  );
}

const CLUSTER_ROWS = [
  {
    id: "cluster-eu-01",
    region: "eu-west · fra",
    activos: 18,
    calientes: 4,
    pausas: 1,
    degradados: 1,
    cuarentena: 0,
    reputation: "94.2",
    reputationColor: "#1A1410",
    total: "480 / 600k",
    delta: "+50k · 09:14",
    accent: "#F59E0B",
    selected: true
  },
  {
    id: "cluster-us-02",
    region: "us-east · iad",
    activos: 30,
    calientes: 5,
    pausas: 0,
    degradados: 0,
    cuarentena: 1,
    reputation: "96.7",
    reputationColor: "#1A1410",
    total: "720 / 900k",
    delta: "snapshot · 09:18",
    accent: "transparent"
  },
  {
    id: "cluster-eu-03",
    region: "eu-central · ams",
    activos: 19,
    calientes: 2,
    pausas: 1,
    degradados: 0,
    cuarentena: 0,
    reputation: "92.4",
    reputationColor: "#B45309",
    total: "380 / 500k",
    delta: "recal · 08:55",
    accent: "transparent"
  },
  {
    id: "cluster-latam-01",
    region: "sa-east · gru",
    activos: 14,
    calientes: 3,
    pausas: 0,
    degradados: 1,
    cuarentena: 0,
    reputation: "95.1",
    reputationColor: "#1A1410",
    total: "220 / 300k",
    delta: "+20k · 09:02",
    accent: "transparent"
  },
  {
    id: "cluster-apac-01",
    region: "ap-northeast · nrt",
    activos: 12,
    calientes: 2,
    pausas: 0,
    degradados: 0,
    cuarentena: 0,
    reputation: "97.8",
    reputationColor: "#15803D",
    total: "180 / 240k",
    delta: "snapshot · 09:11",
    accent: "transparent"
  }
];

function ClusterTable() {
  return (
    <div
      className="flex flex-col overflow-hidden bg-[#FFFFFF]"
      style={{ borderRadius: 6, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(26, 20, 16, 0.08)" }}
    >
      <header
        className="flex items-center"
        style={{
          gap: 10,
          padding: "14px 16px",
          background: "#F7F2EA",
          borderBottom: "1px solid #EAE0CE"
        }}
      >
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Tabla de clústeres
        </h2>
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
          5 visibles · 8 totales
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">/v1/admin/clusters</span>
      </header>
      <div
        className="grid"
        style={{
          gridTemplateColumns: "minmax(0,1.4fr) 60px 60px 60px 60px 60px 70px 110px 120px",
          gap: 10,
          padding: "10px 14px",
          background: "#F7F2EA",
          borderBottom: "1px solid #EAE0CE"
        }}
      >
        {["CLÚSTER · REGIÓN", "ACT", "CAL", "PAU", "DEG", "CUA", "REP", "ENVIADOS", "ÚLTIMO"].map((h) => (
          <span
            key={h}
            className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
            style={{ letterSpacing: "0.6px" }}
          >
            {h}
          </span>
        ))}
      </div>
      <ul className="m-0 p-0 list-none flex flex-col">
        {CLUSTER_ROWS.map((row, i) => (
          <li
            key={row.id}
            className="grid items-center"
            style={{
              gridTemplateColumns: "minmax(0,1.4fr) 60px 60px 60px 60px 60px 70px 110px 120px",
              gap: 10,
              padding: "12px 14px",
              borderTop: i > 0 ? "1px solid #EAE0CE" : "none",
              borderLeft: row.selected ? "2px solid #F59E0B" : "none",
              background: row.selected ? "#FFFBF5" : "transparent"
            }}
          >
            <div className="flex flex-col" style={{ gap: 2 }}>
              <div className="flex items-center" style={{ gap: 6 }}>
                {row.selected ? (
                  <ChevronDown size={12} strokeWidth={1.75} className="text-[#EA580C]" aria-hidden="true" />
                ) : (
                  <span aria-hidden="true" style={{ width: 12 }} />
                )}
                <code className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[#1A1410]">
                  {row.id}
                </code>
              </div>
              <span className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]" style={{ paddingLeft: 18 }}>
                {row.region}
              </span>
            </div>
            <CellPill value={String(row.activos).padStart(2, "0")} kind="act" />
            <CellPill value={String(row.calientes).padStart(2, "0")} kind="cal" />
            <CellPill value={String(row.pausas).padStart(2, "0")} kind="pau" />
            <CellPill value={String(row.degradados).padStart(2, "0")} kind="deg" />
            <CellPill value={String(row.cuarentena).padStart(2, "0")} kind="cua" />
            <span
              className="text-[12px] font-[family-name:var(--font-mono)] font-semibold"
              style={{ color: row.reputationColor }}
            >
              {row.reputation}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]">{row.total}</span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{row.delta}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CellPill({ value, kind }: { value: string; kind: "act" | "cal" | "pau" | "deg" | "cua" }) {
  const style =
    kind === "act"
      ? { bg: "#DCFCE7", fg: "#15803D" }
      : kind === "cal"
        ? { bg: "#FEF3C7", fg: "#B45309" }
        : kind === "pau"
          ? { bg: "#F7F2EA", fg: "#5C544A" }
          : kind === "deg"
            ? { bg: "#FEE2E2", fg: "#B91C1C" }
            : { bg: "#EDE9FE", fg: "#7C3AED" };
  return (
    <span
      className="inline-flex items-center text-[10px] font-[family-name:var(--font-mono)] font-bold"
      style={{
        gap: 4,
        padding: "2px 6px",
        borderRadius: 4,
        background: value === "00" ? "transparent" : style.bg,
        color: value === "00" ? "#8A8073" : style.fg,
        width: "fit-content"
      }}
    >
      {value}
      {value !== "00" ? <span className="opacity-70">{kind}</span> : null}
    </span>
  );
}

/* ============================================================
 * RightCol: DetailPanel + OpenClaw
 * ============================================================ */
function RightCol() {
  return (
    <div className="flex flex-col" style={{ gap: 14 }}>
      <DetailPanel />
      <OpenClawPrompt />
    </div>
  );
}

function DetailPanel() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ gap: 14, padding: 18, borderRadius: 6, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(26, 20, 16, 0.08)" }}
    >
      <header className="flex flex-col" style={{ gap: 4 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          INSPECCIÓN · CLUSTER-EU-01
        </span>
        <h3 className="m-0 text-[15px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Frankfurt · eu-west
        </h3>
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          480 / 600k enviados en 24 h
        </span>
      </header>

      <div
        className="flex flex-col"
        style={{ gap: 8, padding: 12, borderRadius: 4, background: "#F7F2EA", border: "1px solid #EAE0CE" }}
      >
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#5C544A]"
          style={{ letterSpacing: "0.6px" }}
        >
          REPUTACIÓN · 24 H
        </span>
        <div className="flex items-end" style={{ gap: 3, height: 40 }}>
          {[28, 32, 30, 34, 36, 38, 34, 30, 28, 26, 28, 32].map((h, i) => (
            <span
              key={i}
              className="flex-1"
              style={{ height: h, borderRadius: 2, background: i === 6 ? "#EA580C" : "#F59E0B", opacity: 0.6 + i * 0.03 }}
              aria-hidden="true"
            />
          ))}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">00:00</span>
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#1A1410]">94.2</span>
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">ahora</span>
        </div>
      </div>

      <div
        className="flex flex-col"
        style={{ gap: 8, padding: 12, borderRadius: 4, background: "#F7F2EA", border: "1px solid #EAE0CE" }}
      >
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#5C544A]"
          style={{ letterSpacing: "0.6px" }}
        >
          PLAN WARMING
        </span>
        <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
          {[
            { label: "Día 9 · 50k/d", state: "actual", color: "#EA580C" },
            { label: "Día 10 · 75k/d", state: "propuesto", color: "#B45309" },
            { label: "Día 14 · 200k/d", state: "humano gate", color: "#7C3AED" }
          ].map((s) => (
            <li key={s.label} className="flex items-center" style={{ gap: 6 }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: s.color }} />
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410]">{s.label}</span>
              <span className="flex-1" aria-hidden="true" />
              <span className="text-[10px] font-[family-name:var(--font-caption)]" style={{ color: s.color }}>
                {s.state}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function OpenClawPrompt() {
  return (
    <div
      style={{
        borderRadius: 12,
        padding: 2,
        background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
        boxShadow: "0 6px 18px rgba(146, 64, 14, 0.13)"
      }}
    >
      <div className="flex flex-col bg-[#FFFFFF]" style={{ borderRadius: 10, padding: 16, gap: 12 }}>
        <header className="flex items-center" style={{ gap: 10 }}>
          <span
            aria-hidden="true"
            className="grid place-items-center"
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "linear-gradient(135deg, #FACC15 0%, #EA580C 100%)",
              color: "#FFFBF5"
            }}
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className="text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            OpenClaw recomienda
          </span>
        </header>
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#1A1410]">
          Las quejas del clúster eu-01 subieron a 0,18%. Sugiero degradar IPs antes del próximo
          ciclo de warming.
        </p>
        <button
          type="button"
          className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]"
          style={{ gap: 6, padding: "10px 12px", borderRadius: 6, background: "#1A1410" }}
        >
          <WandSparkles size={13} strokeWidth={1.75} aria-hidden="true" />
          Revisar plan de degradación
        </button>
      </div>
    </div>
  );
}

/* ============================================================
 * SecuritySection (ux3Qt)
 * ============================================================ */
function SecuritySection() {
  return (
    <section className="flex flex-col" style={{ gap: 14 }}>
      <header className="flex flex-col" style={{ gap: 4 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[#EA580C]"
            style={{ letterSpacing: "1.2px" }}
          >
            GOBIERNO
          </span>
          <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "#8A8073" }} />
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
            9 gates · 1 interruptor
          </span>
        </div>
        <h2
          className="m-0 text-[22px] font-[family-name:var(--font-heading)] font-bold leading-tight text-[#1A1410]"
          style={{ letterSpacing: "-0.2px" }}
        >
          Seguridad e interruptor de corte
        </h2>
      </header>

      <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
        <GatesCard />
        <SecRight />
      </div>
    </section>
  );
}

const GATES = [
  { check: "ok", label: "Log de auditoría append-only", note: "verificado" },
  { check: "ok", label: "Dry-run obligatorio antes de escribir", note: "verificado" },
  { check: "ok", label: "Panel solo lectura · GET-only", note: "verificado" },
  { check: "ok", label: "Kill switch probado", note: "hace 14 min" },
  { check: "ok", label: "Regla de dos personas activa", note: "ok" },
  { check: "warn", label: "Definiciones de rollback firmadas", note: "3 faltantes" },
  { check: "warn", label: "Autorización por rol", note: "revisión pendiente" },
  { check: "bad", label: "Drift DNS SPF/DMARC", note: "alerta abierta" },
  { check: "off", label: "Puente NFC", note: "deshabilitado" }
] as const;

function GatesCard() {
  return (
    <section
      className="flex flex-col overflow-hidden bg-[#FFFFFF]"
      style={{ borderRadius: 6, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(26, 20, 16, 0.08)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 10, padding: "14px 16px", background: "#F7F2EA", borderBottom: "1px solid #EAE0CE" }}
      >
        <Shield size={14} strokeWidth={1.75} className="text-[#1D4ED8]" aria-hidden="true" />
        <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Gates de la flota
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: "#DCFCE7", color: "#15803D" }}
        >
          5 / 9 ok
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {GATES.map((g, i) => {
          const color = g.check === "ok" ? "#15803D" : g.check === "warn" ? "#B45309" : g.check === "bad" ? "#B91C1C" : "#8A8073";
          return (
            <li
              key={g.label}
              className="flex items-center"
              style={{
                gap: 12,
                padding: "12px 16px",
                borderTop: i > 0 ? "1px solid #EAE0CE" : "none"
              }}
            >
              <span
                aria-hidden="true"
                className="grid place-items-center text-[#FFFBF5] text-[10px]"
                style={{ width: 18, height: 18, borderRadius: 999, background: color, fontWeight: 700 }}
              >
                {g.check === "ok" ? "✓" : g.check === "warn" ? "!" : g.check === "bad" ? "×" : "−"}
              </span>
              <span className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[#1A1410]">
                {g.label}
              </span>
              <span className="flex-1" aria-hidden="true" />
              <span className="text-[10px] font-[family-name:var(--font-mono)]" style={{ color }}>
                {g.note}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SecRight() {
  return (
    <div className="flex flex-col" style={{ gap: 14 }}>
      <KillSwitchCard />
      <TooltipCard />
      <AuditLogCard />
    </div>
  );
}

function KillSwitchCard() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ gap: 12, padding: 18, borderRadius: 6, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(26, 20, 16, 0.08)" }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <ShieldCheck size={14} strokeWidth={1.75} className="text-[#15803D]" aria-hidden="true" />
        <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Interruptor de corte
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{
            gap: 6,
            padding: "3px 8px",
            borderRadius: 999,
            background: "#DCFCE7",
            color: "#15803D",
            letterSpacing: "0.6px"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: "#15803D" }} />
          ARMADO
        </span>
      </header>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[#5C544A]">
        Última prueba · hace 14 min · superada
      </p>
      <button
        type="button"
        className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]"
        style={{ gap: 6, padding: "10px 12px", borderRadius: 6, background: "#1A1410" }}
      >
        Activar interruptor de corte
      </button>
      <span className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]">
        Requiere rol elevado + regla de 2 personas
      </span>
    </section>
  );
}

function TooltipCard() {
  return (
    <div
      className="flex items-center"
      style={{
        gap: 8,
        padding: "8px 12px",
        borderRadius: 6,
        background: "#FEF3C7",
        border: "1px solid #B45309"
      }}
    >
      <Eye size={12} strokeWidth={1.75} className="text-[#B45309]" aria-hidden="true" />
      <span className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#B45309]">
        Aprobación humana requerida para tocar el switch
      </span>
    </div>
  );
}

function AuditLogCard() {
  const rows = [
    { ts: "09:18", actor: "operador@delivrix", action: "Plan dry-run", color: "#1A1410" },
    { ts: "09:14", actor: "sre-01@delivrix", action: "Probó kill switch", color: "#1A1410" },
    { ts: "09:04", actor: "openclaw", action: "Recomendó degradar", color: "#EA580C" },
    { ts: "08:54", actor: "collector", action: "Drift DNS", color: "#1D4ED8" }
  ];
  return (
    <section
      className="flex flex-col overflow-hidden bg-[#FFFFFF]"
      style={{ borderRadius: 6, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(26, 20, 16, 0.08)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 8, padding: "12px 14px", background: "#F7F2EA", borderBottom: "1px solid #EAE0CE" }}
      >
        <h3 className="m-0 text-[12px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Audit log · clúster
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">/v1/audit</span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {rows.map((r, i) => (
          <li
            key={i}
            className="grid items-center"
            style={{
              gridTemplateColumns: "50px minmax(0,1fr) auto",
              gap: 8,
              padding: "10px 14px",
              borderTop: i > 0 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{r.ts}</span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold truncate" style={{ color: r.color }}>
              {r.actor}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-sans)] text-[#5C544A]">{r.action}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

void ArrowDown;
void ArrowUp;
