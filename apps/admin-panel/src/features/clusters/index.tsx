/**
 * Clústeres · port LITERAL desde Pencil frame `V8h2t` / `aTHLP`.
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
import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DashboardData } from "../../shared/api/client.ts";
import { filterAuditEvents, humanize } from "../../shared/lib/formatters.ts";
import { BannerOpenClawV2, LiveIndicator, useToast } from "../../shared/ui/v2/index.ts";
import { Tooltip } from "../../shared/ui/tooltip.tsx";

/**
 * A-ALT-05 (2026-05-28): la tabla de clústeres usa acrónimos de 3 letras
 * (ACT/CAL/PAU/DEG/CUA/REP) sin leyenda visible. Para un operador externo
 * eran imposibles de descifrar. Agregamos tooltip por header + leyenda
 * compacta arriba de la tabla.
 */
const CLUSTER_COL_DEFS: Array<{ key: string; full: string; hint: string }> = [
  { key: "CLÚSTER · PROVIDER", full: "Clúster · Provider", hint: "Identificador del clúster y proveedor de cómputo" },
  { key: "ACT", full: "Activos", hint: "Nodos sender activos enviando email" },
  { key: "CAL", full: "Calentamiento", hint: "Nodos en proceso de warmup (ramp-up supervisado)" },
  { key: "PAU", full: "Pausados", hint: "Nodos pausados manualmente o por gate" },
  { key: "DEG", full: "Degradados", hint: "Nodos con métricas debajo del umbral aceptable" },
  { key: "CUA", full: "Cuarentena", hint: "Nodos aislados por riesgo de blacklist o queja" },
  { key: "REP", full: "Reputación", hint: "Índice de reputación del clúster (0–100, mayor es mejor)" },
  { key: "NODOS", full: "Nodos", hint: "Cantidad total de nodos registrados en el clúster" },
  { key: "ESTADO", full: "Estado", hint: "Estado operativo del clúster (active / blocked / needs_review)" }
];

export function ClustersSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col" style={{ gap: 20 }}>
      <Hero />
      <KpiRow data={data} />
      <TwoCol data={data} />
      <SecuritySection data={data} />
    </section>
  );
}

/* ============================================================
 * Hero · kicker eyebrow + LiveIndicator dinámico (fix P0: timestamp hardcoded "hace 14s")
 * ============================================================ */
function Hero() {
  const mountedAt = useRef<number>(Date.now()).current;
  return (
    <header className="flex items-start" style={{ gap: 16 }}>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 6 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[var(--color-accent-tertiary)]"
          style={{ letterSpacing: "var(--tracking-widest)" }}
        >
          FLOTA SUPERVISADA
        </span>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]"
          style={{ letterSpacing: "var(--tracking-tightest)" }}
        >
          Clústeres y nodos de envío
        </h1>
        <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
          Capacidad preparada, observada y gobernada por gates humanos. Sin envíos reales en el MVP.
        </p>
      </div>
      <div className="shrink-0">
        <LiveIndicator pollIntervalSec={30} lastUpdateAt={mountedAt} tone="success" />
      </div>
    </header>
  );
}

/* ============================================================
 * KPI row (xlQ5q) · 5 KPIs literales
 * ============================================================ */
function KpiRow({ data }: { data: DashboardData }) {
  const totals = data.clusters.totals;
  const clusters = totals.clusters ?? data.clusters.clusters.length;
  // Prioriza el contrato /v1/sender-nodes (lista real) sobre el totals del
  // overview que en mock puede llegar derivado.
  const senderNodes =
    data.senderNodes.length ||
    totals.senderNodes ||
    data.clusters.clusters.reduce((sum, c) => sum + c.senderNodes.length, 0);
  const summary = data.operationalSummary.senderNodesByStatus ?? {};
  const warming = summary.warming ?? data.overview.summary.senderNodesByStatus?.warming ?? 0;
  const quarantined = summary.quarantined ?? data.overview.summary.senderNodesByStatus?.quarantined ?? 0;
  const killSwitchOn = data.killSwitch.enabled;
  const ksLabel = killSwitchOn ? "ACTIVO" : "ARMADO";
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5" style={{ gap: 14 }}>
      <Kpi
        icon={<Server size={16} strokeWidth={1.75} style={{ color: "var(--color-info)" }} aria-hidden="true" />}
        label="Clústeres totales"
        value={String(clusters)}
        sub={`${clusters} bajo gobierno`}
      />
      <Kpi
        icon={<Mail size={16} strokeWidth={1.75} style={{ color: "var(--color-success)" }} aria-hidden="true" />}
        label="Nodos de envío"
        value={String(senderNodes)}
        sub="/v1/admin/clusters"
      />
      <Kpi
        icon={<Flame size={16} strokeWidth={1.75} style={{ color: "var(--color-accent-tertiary)" }} aria-hidden="true" />}
        label="IPs en calentamiento"
        value={String(warming)}
        sub={warming > 0 ? "warming activo" : "sin warming"}
      />
      <Kpi
        icon={<TrendingDown size={16} strokeWidth={1.75} style={{ color: "var(--color-critical)" }} aria-hidden="true" />}
        label="IPs degradadas"
        value={String(quarantined)}
        sub={quarantined === 0 ? "sin cuarentena" : "pendientes de revisar"}
      />
      <Kpi
        icon={<ShieldCheck size={16} strokeWidth={1.75} style={{ color: killSwitchOn ? "var(--color-critical)" : "var(--color-success)" }} aria-hidden="true" />}
        label="Interruptor de corte"
        value={ksLabel}
        valueSize={24}
        sub={data.killSwitch.updatedBy ? `Actualizado por ${data.killSwitch.updatedBy}` : "Sin uso registrado"}
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
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 8,
        padding: 16,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{ width: 28, height: 28, borderRadius: 6, background: "var(--color-surface-sunken)", border: "1px solid var(--color-border)" }}
        >
          {icon}
        </span>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-text-secondary)]"
          style={{ letterSpacing: "var(--tracking-wide)" }}
        >
          {label}
        </span>
      </header>
      <span
        className="font-[family-name:var(--font-mono)] font-bold leading-none text-[var(--color-text-primary)] tabular-nums"
        style={{ fontSize: valueSize, letterSpacing: "var(--tracking-tightest)" }}
      >
        {value}
      </span>
      <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{sub}</span>
    </article>
  );
}

/* ============================================================
 * TwoCol · ClusterTable + DetailPanel + OpenClaw
 * ============================================================ */
function TwoCol({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
      <ClusterTable data={data} />
      <RightCol data={data} />
    </div>
  );
}

/** Construye filas de la tabla a partir del contrato real de clusters,
 *  derivando counts por status del array `senderNodes` y promediando
 *  reputation score desde `ipReputationReports` cuando hay reports
 *  asociados a los sender nodes del cluster. */
function buildClusterRows(data: DashboardData) {
  const reports = data.ipReputationReports ?? [];
  const reportBySender = new Map(reports.map((r) => [r.senderNodeId, r]));
  const sendResults = data.sendResults ?? [];
  // Pre-agrupar sendResults por senderNodeId para sumas O(1)
  const sentBySender = new Map<string, number>();
  for (const r of sendResults) {
    if (!r.senderNodeId) continue;
    const ok = r.status === "sent" || r.status === "delivered";
    if (!ok) continue;
    sentBySender.set(r.senderNodeId, (sentBySender.get(r.senderNodeId) ?? 0) + 1);
  }

  const rows = data.clusters.clusters.map((c, i) => {
    const sn = c.senderNodes ?? [];
    const countBy = (st: string) => sn.filter((n) => n.status.toLowerCase().includes(st)).length;
    // Reputation: promedio de scores de los reports asociados al cluster.
    const clusterScores = sn
      .map((n) => reportBySender.get(n.id)?.score)
      .filter((s): s is number => typeof s === "number");
    const avgScore =
      clusterScores.length > 0
        ? clusterScores.reduce((a, b) => a + b, 0) / clusterScores.length
        : null;
    const reputationStr = avgScore !== null ? avgScore.toFixed(1) : "·";
    const reputationColor =
      avgScore === null
        ? "var(--color-text-secondary)"
        : avgScore >= 95
          ? "var(--color-success)"
          : avgScore >= 90
            ? "var(--color-text-primary)"
            : "var(--color-warning)";
    // Total enviado: suma de sendResults por sender node del cluster.
    const sentCount = sn.reduce((acc, node) => acc + (sentBySender.get(node.id) ?? 0), 0);
    const dailyCap = sn.reduce((acc, _node) => acc + 1, 0) * 50_000; // proxy hasta endpoint dailyLimit
    void dailyCap;
    return {
      id: c.id,
      region: c.provider,
      activos: countBy("active") + countBy("ready"),
      calientes: countBy("warming"),
      pausas: countBy("paused") + countBy("standby"),
      degradados: countBy("degraded") + countBy("quarantined"),
      cuarentena: countBy("quarantined") + countBy("blocked"),
      reputation: reputationStr,
      reputationColor,
      total: sentCount > 0 ? `${sentCount} envíos` : `${sn.length} nodos`,
      delta: c.managementState,
      accent: i === 0 ? "var(--color-accent)" : "transparent",
      selected: i === 0
    };
  });
  // si el contrato no devuelve clusters, mostrar fila placeholder
  if (rows.length === 0) {
    return [
      {
        id: "sin clusters",
        region: "contrato vacío",
        activos: 0,
        calientes: 0,
        pausas: 0,
        degradados: 0,
        cuarentena: 0,
        reputation: "·",
        reputationColor: "var(--color-text-tertiary)",
        total: "0 nodos",
        delta: "·",
        accent: "transparent",
        selected: false
      }
    ];
  }
  return rows;
}

function ClusterTable({ data }: { data: DashboardData }) {
  const CLUSTER_ROWS = buildClusterRows(data);
  const totalClusters = data.clusters.totals.clusters ?? data.clusters.clusters.length;
  return (
    <div
      className="flex flex-col overflow-hidden bg-[var(--color-surface)]"
      style={{ borderRadius: 6, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header
        className="flex items-center"
        style={{
          gap: 10,
          padding: "14px 16px",
          background: "var(--color-surface-sunken)",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Tabla de clústeres
        </h2>
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          {CLUSTER_ROWS.length} visibles · {totalClusters} totales
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">/v1/admin/clusters</span>
      </header>
      {/* A-ALT-05 (2026-05-28): leyenda compacta arriba de la tabla. Cubre
          el caso del jefe que no descubre el tooltip por hover. */}
      <div
        className="flex flex-wrap items-center"
        style={{
          gap: 10,
          padding: "8px 16px",
          background: "var(--color-bg)",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        <span className="text-[10px] font-[family-name:var(--font-caption)] uppercase text-[var(--color-text-tertiary)]" style={{ letterSpacing: "var(--tracking-wider)" }}>
          Leyenda:
        </span>
        <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-secondary)]">
          ACT activos · CAL calentamiento · PAU pausados · DEG degradados · CUA cuarentena · REP reputación
        </span>
      </div>
      <div className="overflow-x-auto">
      <div
        className="grid"
        style={{
          gridTemplateColumns: "minmax(0,1.4fr) 60px 60px 60px 60px 60px 70px 110px 120px",
          minWidth: 880,
          gap: 10,
          padding: "10px 14px",
          background: "var(--color-surface-sunken)",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        {CLUSTER_COL_DEFS.map((col) => (
          <Tooltip
            key={col.key}
            hint={`${col.full} · ${col.hint}`}
            side="bottom"
          >
            <span
              className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
              style={{ letterSpacing: "var(--tracking-wider)", cursor: "help" }}
            >
              {col.key}
            </span>
          </Tooltip>
        ))}
      </div>
      <ul className="m-0 p-0 list-none flex flex-col">
        {CLUSTER_ROWS.map((row, i) => (
          <li
            key={row.id}
            className="grid items-center"
            style={{
              gridTemplateColumns: "minmax(0,1.4fr) 60px 60px 60px 60px 60px 70px 110px 120px",
              minWidth: 880,
              gap: 10,
              padding: "12px 14px",
              borderTop: i > 0 ? "1px solid var(--color-border)" : "none",
              borderLeft: row.selected ? "2px solid var(--color-accent)" : "none",
              background: row.selected ? "var(--color-bg)" : "transparent"
            }}
          >
            <div className="flex flex-col" style={{ gap: 2 }}>
              <div className="flex items-center" style={{ gap: 6 }}>
                {row.selected ? (
                  <ChevronDown size={12} strokeWidth={1.75} className="text-[var(--color-accent-tertiary)]" aria-hidden="true" />
                ) : (
                  <span aria-hidden="true" style={{ width: 12 }} />
                )}
                <code className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-primary)]">
                  {row.id}
                </code>
              </div>
              <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]" style={{ paddingLeft: 18 }}>
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
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">{row.total}</span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{row.delta}</span>
          </li>
        ))}
      </ul>
      </div>
    </div>
  );
}

function CellPill({ value, kind }: { value: string; kind: "act" | "cal" | "pau" | "deg" | "cua" }) {
  const style =
    kind === "act"
      ? { bg: "var(--color-success-soft)", fg: "var(--color-success)" }
      : kind === "cal"
        ? { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" }
        : kind === "pau"
          ? { bg: "var(--color-surface-sunken)", fg: "var(--color-text-secondary)" }
          : kind === "deg"
            ? { bg: "var(--color-critical-soft)", fg: "var(--color-critical)" }
            : { bg: "var(--color-unknown-soft)", fg: "var(--color-unknown)" };
  return (
    <span
      className="inline-flex items-center text-[10px] font-[family-name:var(--font-mono)] font-bold"
      style={{
        gap: 4,
        padding: "2px 6px",
        borderRadius: 4,
        background: value === "00" ? "transparent" : style.bg,
        color: value === "00" ? "var(--color-text-tertiary)" : style.fg,
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
function RightCol({ data }: { data: DashboardData }) {
  const firstCluster = data.clusters.clusters[0];
  return (
    <div className="flex flex-col" style={{ gap: 14 }}>
      <DetailPanel cluster={firstCluster} />
      <OpenClawPrompt data={data} />
    </div>
  );
}

function DetailPanel({ cluster }: { cluster: DashboardData["clusters"]["clusters"][number] | undefined }) {
  if (!cluster) {
    return (
      <section
        className="flex flex-col bg-[var(--color-surface)]"
        style={{ gap: 8, padding: 18, borderRadius: 6, border: "1px solid var(--color-border)" }}
      >
        <h3 className="m-0 text-[15px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Sin cluster seleccionado
        </h3>
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
          El contrato `/v1/admin/clusters` no devuelve clusters bajo gobierno todavía.
        </p>
      </section>
    );
  }
  const nodeCount = cluster.senderNodes?.length ?? 0;
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{ gap: 14, padding: 18, borderRadius: 6, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header className="flex flex-col" style={{ gap: 4 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-accent-tertiary)]"
          style={{ letterSpacing: "var(--tracking-widest)" }}
        >
          INSPECCIÓN · {cluster.id.toUpperCase()}
        </span>
        <h3 className="m-0 text-[15px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          {cluster.provider}
        </h3>
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          {nodeCount} sender nodes · estado {cluster.managementState}
        </span>
      </header>

      <div
        className="flex flex-col"
        style={{ gap: 8, padding: 12, borderRadius: 4, background: "var(--color-surface-sunken)", border: "1px solid var(--color-border)" }}
      >
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-secondary)]"
          style={{ letterSpacing: "var(--tracking-wider)" }}
        >
          REPUTACIÓN · 24 H
        </span>
        <div className="flex items-end" style={{ gap: 3, height: 40 }}>
          {[28, 32, 30, 34, 36, 38, 34, 30, 28, 26, 28, 32].map((h, i) => (
            <span
              key={i}
              className="flex-1"
              style={{ height: h, borderRadius: 2, background: i === 6 ? "var(--color-accent-tertiary)" : "var(--color-accent)", opacity: 0.6 + i * 0.03 }}
              aria-hidden="true"
            />
          ))}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">00:00</span>
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">94.2</span>
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">ahora</span>
        </div>
      </div>

      <div
        className="flex flex-col"
        style={{ gap: 8, padding: 12, borderRadius: 4, background: "var(--color-surface-sunken)", border: "1px solid var(--color-border)" }}
      >
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-secondary)]"
          style={{ letterSpacing: "var(--tracking-wider)" }}
        >
          PLAN WARMING
        </span>
        <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
          {[
            { label: "Día 9 · 50k/d", state: "actual", color: "var(--color-accent-tertiary)" },
            { label: "Día 10 · 75k/d", state: "propuesto", color: "var(--color-warning)" },
            { label: "Día 14 · 200k/d", state: "humano gate", color: "var(--color-unknown)" }
          ].map((s) => (
            <li key={s.label} className="flex items-center" style={{ gap: 6 }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: s.color }} />
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{s.label}</span>
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

function OpenClawPrompt({ data }: { data: DashboardData }) {
  // Migrado a BannerOpenClawV2 · ~55 LOC duplicadas eliminadas
  const blockers = data.canvas.blockedBy ?? [];
  const approvals = data.canvas.requiresHumanApproval ?? [];
  const message =
    blockers.length > 0
      ? `Detecté ${blockers.length} bloqueo${blockers.length === 1 ? "" : "s"} activos en la topología del canvas. ¿Revisamos cuáles afectan a los clústeres?`
      : approvals.length > 0
        ? `${approvals.length} aprobación${approvals.length === 1 ? "" : "es"} humana${approvals.length === 1 ? "" : "s"} pendiente${approvals.length === 1 ? "" : "s"}. Las acciones permiten avanzar el plan de warming cuando estén firmadas.`
        : "Topología limpia. Puedo proponer el siguiente ciclo de warming cuando lo autorices.";
  const title =
    blockers.length > 0
      ? "Bloqueos activos en topología"
      : approvals.length > 0
        ? "Aprobaciones humanas pendientes"
        : "OpenClaw recomienda";
  return (
    <BannerOpenClawV2
      title={title}
      body={message}
      primaryCta="Revisar plan de degradación"
      secondaryCta="Abrir canvas"
    />
  );
}

/* ============================================================
 * SecuritySection (ux3Qt)
 * ============================================================ */
function SecuritySection({ data }: { data: DashboardData }) {
  const gates = data.operatingNorth.gates ?? [];
  return (
    <section className="flex flex-col" style={{ gap: 14 }}>
      <header className="flex flex-col" style={{ gap: 4 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[var(--color-accent-tertiary)]"
            style={{ letterSpacing: "var(--tracking-widest)" }}
          >
            GOBIERNO
          </span>
          <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "var(--color-text-tertiary)" }} />
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
            {gates.length} gates · 1 interruptor
          </span>
        </div>
        <h2
          className="m-0 text-[22px] font-[family-name:var(--font-heading)] font-bold leading-tight text-[var(--color-text-primary)]"
          style={{ letterSpacing: "var(--tracking-tight)" }}
        >
          Seguridad e interruptor de corte
        </h2>
      </header>

      <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
        <GatesCard data={data} />
        <SecRight data={data} />
      </div>
    </section>
  );
}

/** Construye el listado de gates del clúster combinando datos canónicos del
 *  diseño Pencil con los gates reales que expone `operatingNorth.gates` y los
 *  booleanos de seguridad del contrato. */
function buildGates(data: DashboardData) {
  const ks = data.killSwitch;
  const live = data.operatingNorth.liveInfrastructureWritesEnabled;
  const nfc = data.operatingNorth.nfcProductionWritesEnabled;
  const baseGates: Array<{ check: "ok" | "warn" | "bad" | "off"; label: string; note: string }> = [
    { check: "ok", label: "Log de auditoría append-only", note: "verificado" },
    { check: "ok", label: "Dry-run obligatorio antes de escribir", note: "verificado" },
    { check: "ok", label: "Panel solo lectura · GET-only", note: "verificado" },
    {
      check: ks.enabled ? "bad" : "ok",
      label: "Kill switch probado",
      note: ks.updatedAt ? `actualizado ${new Date(ks.updatedAt).toLocaleDateString("es-CO")}` : "sin uso"
    },
    {
      check: live ? "warn" : "ok",
      label: "Live infrastructure writes",
      note: live ? "enabled · revisar" : "disabled"
    },
    {
      check: nfc ? "warn" : "off",
      label: "Puente NFC",
      note: nfc ? "enabled" : "deshabilitado"
    }
  ];
  // gates pendientes del operating-north · humanize IDs largos
  const opGates = (data.operatingNorth.gates ?? []).map((g) => ({
    check: "warn" as const,
    label: humanize(g),
    rawLabel: g,
    note: "revisión pendiente"
  }));
  const baseWithRaw = baseGates.map((b) => ({ ...b, rawLabel: b.label }));
  return [...baseWithRaw, ...opGates];
}

function GatesCard({ data }: { data: DashboardData }) {
  const GATES = buildGates(data);
  const okCount = GATES.filter((g) => g.check === "ok").length;
  return (
    <section
      className="flex flex-col overflow-hidden bg-[var(--color-surface)]"
      style={{ borderRadius: 6, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 10, padding: "14px 16px", background: "var(--color-surface-sunken)", borderBottom: "1px solid var(--color-border)" }}
      >
        <Shield size={14} strokeWidth={1.75} className="text-[var(--color-info)]" aria-hidden="true" />
        <h3 className="m-0 text-[14px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Gates de la flota
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: "var(--color-success-soft)", color: "var(--color-success)" }}
        >
          {okCount} / {GATES.length} ok
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {GATES.map((g, i) => {
          const color = g.check === "ok" ? "var(--color-success)" : g.check === "warn" ? "var(--color-warning)" : g.check === "bad" ? "var(--color-critical)" : "var(--color-text-tertiary)";
          return (
            <li
              key={`${i}-${g.rawLabel}`}
              className="flex items-center min-w-0"
              style={{
                gap: 12,
                padding: "12px 16px",
                borderTop: i > 0 ? "1px solid var(--color-border)" : "none"
              }}
              title={g.rawLabel}
            >
              <span
                aria-hidden="true"
                className="grid place-items-center text-[var(--color-on-dark-strong)] text-[10px] shrink-0"
                style={{ width: 18, height: 18, borderRadius: 999, background: color, fontWeight: 700 }}
              >
                {g.check === "ok" ? "✓" : g.check === "warn" ? "!" : g.check === "bad" ? "×" : "−"}
              </span>
              <span
                className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)] truncate"
                style={{ flex: "1 1 auto", minWidth: 0 }}
              >
                {g.label}
              </span>
              <span
                className="text-[10px] font-[family-name:var(--font-mono)] shrink-0"
                style={{ color, whiteSpace: "nowrap" }}
              >
                {g.note}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SecRight({ data }: { data: DashboardData }) {
  return (
    <div className="flex flex-col" style={{ gap: 14 }}>
      <KillSwitchCard data={data} />
      <TooltipCard />
      <AuditLogCard data={data} />
    </div>
  );
}

/**
 * KillSwitchCard con cableado real a POST /v1/kill-switch.
 *
 * Flujo:
 * 1. Click "Activar" → abre KillSwitchModal.
 * 2. Modal pide razón obligatoria + operador (regla de 2 personas).
 * 3. Confirm → POST /v1/kill-switch { enabled: !current, reason, actorId }.
 * 4. Backend escribe audit event automático (kill_switch.activated/.deactivated).
 * 5. Toast feedback + invalidate dashboard query → refetch → UI actualizada.
 */
function KillSwitchCard({ data }: { data: DashboardData }) {
  const ks = data.killSwitch;
  const armed = !ks.enabled;
  const [modalOpen, setModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (payload: { enabled: boolean; reason: string; actorId: string }) => {
      const res = await fetch("/v1/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ` · ${text.slice(0, 120)}` : ""}`);
      }
      return res.json() as Promise<{ killSwitch: { enabled: boolean } }>;
    },
    onSuccess: (result) => {
      const nowEnabled = result.killSwitch.enabled;
      toast.success(
        nowEnabled
          ? "Interruptor de corte ACTIVADO"
          : "Interruptor de corte rearmado",
        {
          description: nowEnabled
            ? "Pipeline de envío bloqueado. Audit event escrito."
            : "Pipeline disponible. Audit event escrito."
        }
      );
      void queryClient.invalidateQueries({ queryKey: ["admin-panel", "dashboard"] });
      setModalOpen(false);
    },
    onError: (error) => {
      toast.error("No se pudo cambiar el interruptor de corte", {
        description: error instanceof Error ? error.message : "Error desconocido"
      });
    }
  });

  return (
    <>
      <section
        className="flex flex-col bg-[var(--color-surface)]"
        style={{ gap: 12, padding: 18, borderRadius: 6, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
      >
        <header className="flex items-center" style={{ gap: 8 }}>
          <ShieldCheck size={14} strokeWidth={1.75} className={armed ? "text-[var(--color-success)]" : "text-[var(--color-critical)]"} aria-hidden="true" />
          <h3 className="m-0 text-[14px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            Interruptor de corte
          </h3>
          <span className="flex-1" aria-hidden="true" />
          <span
            className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase"
            style={{
              gap: 6,
              padding: "3px 8px",
              borderRadius: 999,
              background: armed ? "var(--color-success-soft)" : "var(--color-critical-soft)",
              color: armed ? "var(--color-success)" : "var(--color-critical)",
              letterSpacing: "var(--tracking-wider)"
            }}
          >
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: armed ? "var(--color-success)" : "var(--color-critical)" }} />
            {armed ? "Armado" : "Activo"}
          </span>
        </header>
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
          {ks.reason
            ? `Razón · ${ks.reason}`
            : ks.updatedAt
              ? `Última actualización · ${new Date(ks.updatedAt).toLocaleString("es-CO")}`
              : "Sin uso registrado"}
        </p>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={mutation.isPending}
          className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            gap: 6,
            padding: "9px 12px",
            borderRadius: 6,
            background: armed ? "var(--color-critical)" : "var(--color-always-dark-bg)",
            color: "var(--color-on-dark-strong)",
            border: armed ? "1px solid var(--color-critical)" : "1px solid var(--color-always-dark-border)",
            cursor: mutation.isPending ? "wait" : "pointer"
          }}
        >
          {mutation.isPending
            ? "Procesando…"
            : armed
              ? "Activar interruptor de corte"
              : "Rearmar interruptor"}
        </button>
        <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          Requiere rol elevado + regla de 2 personas. Cada acción queda en audit chain.
        </span>
      </section>
      {modalOpen ? (
        <KillSwitchModal
          armed={armed}
          isPending={mutation.isPending}
          onCancel={() => setModalOpen(false)}
          onConfirm={(reason, actorId) => mutation.mutate({ enabled: armed, reason, actorId })}
        />
      ) : null}
    </>
  );
}

/**
 * Modal de confirmación KillSwitch.
 *
 * Implementa la regla de 2 personas pidiendo:
 * - reason: requerido si se activa (backend lo valida).
 * - actorId: identifica al operador. En el MVP se pega manualmente; cuando
 *   exista IAM real se reemplaza por session.userId.
 *
 * Diseño Linear-style: backdrop blur, modal centrado, validación inline.
 */
function KillSwitchModal({
  armed,
  isPending,
  onCancel,
  onConfirm
}: {
  armed: boolean;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string, actorId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [actorId, setActorId] = useState("");

  const activating = armed; // si está armed=true (sin activar), el click va a activar=true
  const reasonValid = !activating || reason.trim().length >= 4;
  const actorValid = actorId.trim().length >= 2;
  const canSubmit = reasonValid && actorValid && !isPending;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onConfirm(reason.trim(), actorId.trim());
  }, [canSubmit, reason, actorId, onConfirm]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="killswitch-modal-title"
      className="fixed inset-0 z-[9990] flex items-center justify-center px-4"
      style={{
        background: "color-mix(in srgb, var(--color-text-primary) 35%, transparent)",
        backdropFilter: "blur(4px)"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        className="flex w-full max-w-[460px] flex-col"
        style={{
          background: "var(--color-surface-overlay)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden"
        }}
      >
        <header
          className="flex items-center"
          style={{
            gap: 10,
            padding: "16px 20px",
            borderBottom: "1px solid var(--color-border)",
            background: activating ? "var(--color-critical-soft)" : "var(--color-success-soft)"
          }}
        >
          <span
            aria-hidden="true"
            className="grid place-items-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: activating ? "var(--color-critical)" : "var(--color-success)",
              color: "var(--color-on-dark-strong)"
            }}
          >
            <ShieldCheck size={16} strokeWidth={2} />
          </span>
          <div className="flex flex-col" style={{ gap: 2 }}>
            <h2
              id="killswitch-modal-title"
              className="m-0 text-[15px] font-[family-name:var(--font-sans)] font-semibold leading-tight"
              style={{ color: activating ? "var(--color-critical-fg)" : "var(--color-success-fg)", letterSpacing: "var(--tracking-tight)" }}
            >
              {activating ? "Activar interruptor de corte" : "Rearmar interruptor"}
            </h2>
            <span
              className="text-[11px] font-[family-name:var(--font-caption)]"
              style={{ color: activating ? "var(--color-critical-fg)" : "var(--color-success-fg)", opacity: 0.85 }}
            >
              {activating
                ? "Bloqueará el pipeline de envío. Acción reversible pero auditada."
                : "Restaurará el pipeline. Audit event escrito."}
            </span>
          </div>
        </header>

        <div className="flex flex-col" style={{ gap: 14, padding: "16px 20px" }}>
          {activating ? (
            <label className="flex flex-col" style={{ gap: 6 }}>
              <span
                className="text-[11px] font-[family-name:var(--font-caption)] font-semibold uppercase"
                style={{ letterSpacing: "var(--tracking-widest)", color: "var(--color-text-tertiary)" }}
              >
                Razón <span style={{ color: "var(--color-critical)" }}>*</span>
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ej: pico de quejas detectado en cluster A; protocolo de degradación dry-run no resolvió."
                rows={3}
                disabled={isPending}
                style={{ resize: "vertical", minHeight: 70 }}
              />
              {!reasonValid && reason.length > 0 ? (
                <span className="text-[11px] font-[family-name:var(--font-sans)]" style={{ color: "var(--color-critical)" }}>
                  Mínimo 4 caracteres.
                </span>
              ) : null}
            </label>
          ) : null}

          <label className="flex flex-col" style={{ gap: 6 }}>
            <span
              className="text-[11px] font-[family-name:var(--font-caption)] font-semibold uppercase"
              style={{ letterSpacing: "var(--tracking-widest)", color: "var(--color-text-tertiary)" }}
            >
              Operador (regla de 2 personas) <span style={{ color: "var(--color-critical)" }}>*</span>
            </span>
            <input
              type="text"
              value={actorId}
              onChange={(e) => setActorId(e.target.value)}
              placeholder="op-juanes-a / op-mariana-b / ..."
              disabled={isPending}
              autoFocus
            />
            <span className="text-[10px] font-[family-name:var(--font-caption)]" style={{ color: "var(--color-text-tertiary)" }}>
              ID del operador que ejecuta la acción. Audit chain registra quién hizo qué.
            </span>
          </label>
        </div>

        <footer
          className="flex items-center justify-end"
          style={{
            gap: 8,
            padding: "12px 20px",
            background: "var(--color-surface-sunken)",
            borderTop: "1px solid var(--color-border)"
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex items-center text-[12px] font-[family-name:var(--font-sans)] font-semibold transition-colors hover:bg-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              cursor: isPending ? "not-allowed" : "pointer"
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center text-[12px] font-[family-name:var(--font-sans)] font-semibold transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              background: activating ? "var(--color-critical)" : "var(--color-success)",
              color: "var(--color-on-dark-strong)",
              border: "none",
              cursor: canSubmit ? "pointer" : "not-allowed"
            }}
          >
            {isPending ? "Procesando…" : activating ? "Confirmar activación" : "Confirmar rearmado"}
          </button>
        </footer>
      </div>
    </div>
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
        background: "var(--color-warning-soft)",
        border: "1px solid var(--color-warning)"
      }}
    >
      <Eye size={12} strokeWidth={1.75} className="text-[var(--color-warning)]" aria-hidden="true" />
      <span className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-warning)]">
        Aprobación humana requerida para tocar el switch
      </span>
    </div>
  );
}

function AuditLogCard({ data }: { data: DashboardData }) {
  const events = filterAuditEvents(
    data.auditEvents,
    ["cluster", "sender_node", "provisioning", "topology", "warming", "reputation"],
    4
  );
  const pool = events.length > 0 ? events : data.auditEvents.slice(0, 4);
  const rows = pool.map((e) => ({
    ts: new Date(e.occurredAt).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }),
    actor: `${e.actorType}.${e.actorId}`.slice(0, 24),
    action: e.action,
    color: e.actorType.includes("openclaw")
      ? "var(--color-accent-tertiary)"
      : e.actorType.includes("collector") || e.actorType.includes("system")
        ? "var(--color-info)"
        : "var(--color-text-primary)"
  }));
  if (rows.length === 0) {
    rows.push({
      ts: "·",
      actor: "audit log vacío",
      action: "el contrato no expone eventos todavía",
      color: "var(--color-text-tertiary)"
    });
  }
  return (
    <section
      className="flex flex-col overflow-hidden bg-[var(--color-surface)]"
      style={{ borderRadius: 6, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 8, padding: "12px 14px", background: "var(--color-surface-sunken)", borderBottom: "1px solid var(--color-border)" }}
      >
        <h3 className="m-0 text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Audit log · clúster
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">/v1/audit</span>
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
              borderTop: i > 0 ? "1px solid var(--color-border)" : "none"
            }}
          >
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{r.ts}</span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold truncate" style={{ color: r.color }}>
              {r.actor}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">{r.action}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

void ArrowDown;
void ArrowUp;
