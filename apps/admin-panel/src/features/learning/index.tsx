/**
 * Aprendizaje (OpenClaw learning plan) — Pencil frame `jkGrg` / `vo9ot`.
 *
 * Estructura: Header + KPI row + Plan + Skills + Evidencia curada + Cola
 * retroalimentación + Audit strip (dark).
 *
 * Datos: `data.learningPlan` (stages + modelGovernance) + `data.readinessSignals`
 * (scores por capacidad + recomendaciones).
 */

import { GraduationCap, ShieldCheck, Sparkles } from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatNumber,
  humanize,
  stateTone,
  type Tone
} from "../../shared/lib/formatters.ts";

export function LearningSection({ data }: { data: DashboardData }) {
  const plan = data.learningPlan;
  const signals = data.readinessSignals;
  const totalStages = plan.stages.length;
  const readyStages = plan.stages.filter((s) => stateTone(s.status) === "success").length;
  const blockedStages = plan.stages.filter((s) => stateTone(s.status) === "critical").length;
  const totalSignals = Object.keys(signals.scores).length;
  const blockedSignals = Object.values(signals.scores).filter(
    (s) => stateTone(s.status) === "critical"
  ).length;
  const governance = signals.modelGovernance;

  return (
    <section className="flex flex-col gap-5" style={{ maxWidth: 1352 }}>
      <Header generatedAt={plan.generatedAt} />
      <KpiRow
        totalStages={totalStages}
        readyStages={readyStages}
        blockedStages={blockedStages}
        totalSignals={totalSignals}
        blockedSignals={blockedSignals}
        governance={governance}
      />
      <PlanAndSignals plan={plan} signals={signals} />
      <EvidenceCurada signals={signals} />
      <FeedbackQueue plan={plan} />
      <AuditStrip governance={governance} />
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Header
 * ------------------------------------------------------------------------ */
function Header({ generatedAt }: { generatedAt: string }) {
  return (
    <header className="flex flex-col gap-2.5">
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
        style={{ letterSpacing: "1.2px" }}
      >
        OPENCLAW · APRENDIZAJE SUPERVISADO
      </span>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Plan de aprendizaje y readiness
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Stages del plan supervisado, signals de readiness por capacidad y gobierno del modelo.
        La promoción y el entrenamiento real requieren aprobación humana.
      </p>
      <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
        generado {generatedAt}
      </span>
    </header>
  );
}

/* --------------------------------------------------------------------------
 * KPI row
 * ------------------------------------------------------------------------ */
function KpiRow({
  totalStages,
  readyStages,
  blockedStages,
  totalSignals,
  blockedSignals,
  governance
}: {
  totalStages: number;
  readyStages: number;
  blockedStages: number;
  totalSignals: number;
  blockedSignals: number;
  governance: DashboardData["readinessSignals"]["modelGovernance"];
}) {
  return (
    <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        icon={<GraduationCap size={14} strokeWidth={1.75} />}
        label="STAGES"
        value={`${formatNumber(readyStages)} / ${formatNumber(totalStages)}`}
        pillTone="success"
        pillText="completados"
      />
      <Kpi
        icon={<Sparkles size={14} strokeWidth={1.75} />}
        label="STAGES BLOQUEADOS"
        value={formatNumber(blockedStages)}
        pillTone={blockedStages > 0 ? "critical" : "success"}
        pillText={blockedStages > 0 ? "atención" : "limpio"}
      />
      <Kpi
        icon={<ShieldCheck size={14} strokeWidth={1.75} />}
        label="READINESS SIGNALS"
        value={`${formatNumber(totalSignals - blockedSignals)} / ${formatNumber(totalSignals)}`}
        pillTone={blockedSignals > 0 ? "warning" : "success"}
        pillText={blockedSignals > 0 ? `${formatNumber(blockedSignals)} bloqueadas` : "todas ok"}
      />
      <Kpi
        icon={<ShieldCheck size={14} strokeWidth={1.75} />}
        label="MODEL GOVERNANCE"
        value={humanize(governance.modelMode)}
        pillTone={governance.canSelfPromote ? "critical" : "success"}
        pillText={governance.canSelfPromote ? "auto-promueve" : "humano aprueba"}
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
        className="text-[24px] font-[family-name:var(--font-mono)] font-bold leading-none text-[#1A1410] tabular-nums"
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

function toneStyle(tone: Tone) {
  if (tone === "success") return { bg: "#DCFCE7", fg: "#15803D" };
  if (tone === "warning") return { bg: "#FEF3C7", fg: "#B45309" };
  if (tone === "critical") return { bg: "#FEE2E2", fg: "#B91C1C" };
  return { bg: "#F5F5F4", fg: "#5C544A" };
}

/* --------------------------------------------------------------------------
 * Plan + Signals
 * ------------------------------------------------------------------------ */
function PlanAndSignals({
  plan,
  signals
}: {
  plan: DashboardData["learningPlan"];
  signals: DashboardData["readinessSignals"];
}) {
  return (
    <div className="grid gap-3.5 grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start">
      <PlanCard plan={plan} />
      <SignalsCard signals={signals} />
    </div>
  );
}

function PlanCard({ plan }: { plan: DashboardData["learningPlan"] }) {
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Plan supervisado
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          {formatNumber(plan.stages.length)} stages
        </span>
      </header>
      <ol className="m-0 p-0 list-none flex flex-col gap-2">
        {plan.stages.map((stage) => {
          const tone = stateTone(stage.status);
          const t = toneStyle(tone);
          return (
            <li
              key={stage.id}
              className="flex items-start gap-3 rounded-[6px] border border-[#EAE0CE] bg-[#F7F2EA] px-3 py-2.5"
            >
              <span
                aria-hidden="true"
                className="grid h-6 w-6 place-items-center rounded-full text-[11px] font-[family-name:var(--font-mono)] font-semibold text-[#FFFBF5] shrink-0 tabular-nums"
                style={{ background: tone === "neutral" ? "#8A8073" : t.fg }}
              >
                {stage.order}
              </span>
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
                    {stage.title}
                  </span>
                  <span
                    className="inline-block rounded-[4px] px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                    style={{ background: t.bg, color: t.fg, letterSpacing: "0.4px" }}
                  >
                    {compactLabel(stage.status)}
                  </span>
                </div>
                {stage.goal ? (
                  <span className="text-[11px] font-[family-name:var(--font-sans)] text-[#5C544A]">
                    {stage.goal}
                  </span>
                ) : null}
                {stage.exitGate ? (
                  <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
                    gate de salida: {stage.exitGate}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function SignalsCard({ signals }: { signals: DashboardData["readinessSignals"] }) {
  const entries = Object.entries(signals.scores);
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Signals por capacidad
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          {formatNumber(entries.length)} capacidades
        </span>
      </header>
      {entries.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Sin signals registrados.
        </p>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
          {entries.map(([key, s]) => {
            const tone = stateTone(s.status);
            const t = toneStyle(tone);
            const pct = s.score === null ? 0 : Math.max(0, Math.min(100, s.score));
            return (
              <li key={key} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[#1A1410]">
                    {humanize(key)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073] tabular-nums"
                    >
                      {Math.round(s.confidence * 100)}% conf
                    </span>
                    <span
                      className="inline-block rounded-[4px] px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                      style={{ background: t.bg, color: t.fg, letterSpacing: "0.4px" }}
                    >
                      {compactLabel(s.status)}
                    </span>
                  </div>
                </div>
                <div
                  className="relative h-1.5 w-full overflow-hidden rounded-[3px] bg-[#F7F2EA]"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-[3px]"
                    style={{ width: `${pct}%`, background: t.fg }}
                  />
                </div>
                {s.reason ? (
                  <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
                    {s.reason}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Evidencia curada (recomendaciones)
 * ------------------------------------------------------------------------ */
function EvidenceCurada({ signals }: { signals: DashboardData["readinessSignals"] }) {
  const recs = signals.recommendations;
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Evidencia curada
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ background: "#DBEAFE", color: "#1D4ED8" }}
        >
          {formatNumber(recs.length)} recomendaciones
        </span>
      </header>
      {recs.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Sin recomendaciones curadas.
        </p>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col">
          {recs.map((r, i) => {
            const tone = stateTone(r.status);
            const t = toneStyle(tone);
            return (
              <li
                key={r.id}
                className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-2.5 ${i < recs.length - 1 ? "border-b border-[#EAE0CE]" : ""}`}
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[#1A1410] truncate">
                    {r.label}
                  </span>
                  <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
                    {formatNumber(r.evidenceRefs.length)} evidencias
                  </span>
                </div>
                {r.requiresHumanApproval ? (
                  <span
                    className="inline-block rounded-[4px] px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                    style={{ background: "#FEF3C7", color: "#B45309", letterSpacing: "0.4px" }}
                  >
                    aprob. humana
                  </span>
                ) : (
                  <span aria-hidden="true" />
                )}
                <span
                  className="inline-block rounded-[4px] px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                  style={{ background: t.bg, color: t.fg, letterSpacing: "0.4px" }}
                >
                  {compactLabel(r.status)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Feedback queue
 * ------------------------------------------------------------------------ */
function FeedbackQueue({ plan }: { plan: DashboardData["learningPlan"] }) {
  // Cola derivada: stages que esperan operator review
  const queue = plan.stages.filter(
    (s) => stateTone(s.status) === "warning" || s.status === "needs_review" || s.status === "requires_approval"
  );
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Cola de retroalimentación humana
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            background: queue.length === 0 ? "#DCFCE7" : "#FEF3C7",
            color: queue.length === 0 ? "#15803D" : "#B45309"
          }}
        >
          {formatNumber(queue.length)}
        </span>
      </header>
      {queue.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Cola vacía. Ningún stage espera revisión humana ahora.
        </p>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {queue.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-[6px] bg-[#F7F2EA] px-3 py-2.5 text-[12px]"
            >
              <span className="text-[#1A1410] font-[family-name:var(--font-sans)] font-medium truncate">
                {s.title}
              </span>
              <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#B45309]">
                espera revisión
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Audit strip (dark panel)
 * ------------------------------------------------------------------------ */
function AuditStrip({
  governance
}: {
  governance: DashboardData["readinessSignals"]["modelGovernance"];
}) {
  const rows: Array<[string, string]> = [
    ["model.mode", governance.modelMode],
    ["model.version", governance.modelVersion],
    ["prompt.version", governance.promptVersion],
    ["can_self_promote", governance.canSelfPromote ? "true" : "false"],
    ["requires_human_approval", governance.requiresHumanApproval ? "true" : "false"]
  ];
  return (
    <section
      className="rounded-[8px] bg-[#1A1410]"
      style={{ padding: "14px 18px", boxShadow: "0 6px 18px rgba(0, 0, 0, 0.13)" }}
    >
      <header className="flex items-center gap-2 mb-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full"
          style={{ background: governance.canSelfPromote ? "#F87171" : "#4ADE80" }}
        />
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{ color: "#FFFBF5", letterSpacing: "1.2px" }}
        >
          Model Governance — append-only audit
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col gap-1">
        {rows.map(([k, v]) => (
          <li
            key={k}
            className="flex items-center justify-between gap-3 text-[11px] font-[family-name:var(--font-mono)]"
          >
            <span style={{ color: "rgba(255, 251, 245, 0.6)" }}>{k}</span>
            <span style={{ color: k.includes("self_promote") && v === "true" ? "#F87171" : "#FACC15" }}>
              {v}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
