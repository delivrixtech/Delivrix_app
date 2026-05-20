/**
 * Aprendizaje supervisado — port LITERAL desde Pencil frame `jkGrg` / `vo9ot`.
 *
 * Estructura:
 *   Header (vnIjB): Welcome 598w + OpenClaw prompt 523w (gradient)
 *   KPI row (vjrUu): 4 cards (Habilidades / Lecciones / Precisión / Pendientes)
 *   Plan + Skills (F8tXWx): Plan de aprendizaje (flex) + Habilidades de OpenClaw 380w
 *   Evidencia curada (La9pF): tabla 7 columnas
 *   Cola retroalimentación (V0QJTS): 3 sugerencias
 *   Audit strip dark (W4egWR): 5 audit rows con sha256 hashes
 */

import {
  ArrowRight,
  ArrowUp,
  BookOpen,
  Eye,
  History,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  filterAuditEvents,
  formatDateTime,
  formatTimeOnly,
  shortAuditHash
} from "../../shared/lib/formatters.ts";

export function LearningSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col" style={{ gap: 20 }}>
      <Header generatedAt={data.learningPlan.generatedAt} />
      <KpiRow data={data} />
      <PlanAndSkills data={data} />
      <EvidenciaCurada data={data} />
      <ColaRetroalimentacion />
      <AuditStrip data={data} />
    </section>
  );
}

/* ============================================================
 * Header
 * ============================================================ */
function Header({ generatedAt }: { generatedAt: string }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
      <Welcome generatedAt={generatedAt} />
      <OpenClawPrompt />
    </div>
  );
}

function Welcome({ generatedAt }: { generatedAt: string }) {
  return (
    <header className="flex flex-col" style={{ gap: 6 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[var(--color-accent-tertiary)]"
          style={{ letterSpacing: "1.2px" }}
        >
          APRENDIZAJE SUPERVISADO
        </span>
        <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "var(--color-text-tertiary)" }} />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          Actualizado {formatDateTime(generatedAt)}
        </span>
      </div>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]"
        style={{ letterSpacing: "-0.4px" }}
      >
        OpenClaw aprende con humanos al volante.
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
        Ninguna habilidad se promueve sin evidencia curada, dry-run estable, evaluación auditada
        y aprobación humana.
      </p>
    </header>
  );
}

function OpenClawPrompt() {
  return (
    <div
      style={{
        borderRadius: 12,
        padding: 2,
        background: "linear-gradient(135deg, var(--color-accent-secondary) 0%, var(--color-accent) 50%, var(--color-accent-tertiary) 100%)",
        boxShadow: "0 6px 18px rgba(146, 64, 14, 0.13)"
      }}
    >
      <div className="flex flex-col bg-[var(--color-surface)]" style={{ borderRadius: 10, padding: 16, gap: 12 }}>
        <header className="flex items-center" style={{ gap: 10 }}>
          <span
            aria-hidden="true"
            className="grid place-items-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "linear-gradient(135deg, var(--color-accent-secondary) 0%, var(--color-accent) 50%, var(--color-accent-tertiary) 100%)",
              color: "var(--color-bg)"
            }}
          >
            <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-[14px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
              OpenClaw
            </span>
            <span
              className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]"
              style={{ letterSpacing: "0.4px" }}
            >
              Operador supervisado
            </span>
          </div>
          <span className="flex-1" aria-hidden="true" />
          <span
            className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              background: "var(--color-surface-sunken)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
              letterSpacing: "0.4px"
            }}
          >
            read-only
          </span>
        </header>

        <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.45] text-[var(--color-text-primary)]">
          Hay 3 lecciones nuevas listas para revisión humana antes de pasar a evaluación. Te dejo
          el plan ordenado por impacto.
        </p>

        <div
          aria-hidden="true"
          className="flex items-center"
          style={{
            gap: 8,
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border)"
          }}
        >
          <span className="flex-1 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-tertiary)]">
            Responde a OpenClaw…
          </span>
          <ArrowUp size={14} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
        </div>

        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            type="button"
            className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-bg)]"
            style={{ gap: 6, padding: "10px 14px", borderRadius: 6, background: "var(--color-text-primary)" }}
          >
            <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            Ver plan ordenado
          </button>
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
            promoción fuera del panel
          </span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * KPI row — 4 cards (Habilidades / Lecciones / Precisión / Pendientes)
 * ============================================================ */
function KpiRow({ data }: { data: DashboardData }) {
  const stagesTotal = data.learningPlan.stages.length;
  const stagesReady = data.learningPlan.stages.filter((s) => s.status === "ready" || s.status === "ok").length;
  const signalsTotal = Object.keys(data.readinessSignals.scores).length;
  const signalsBlocked = Object.values(data.readinessSignals.scores).filter(
    (s) => s.status === "blocked" || s.status === "critical"
  ).length;
  const requiresApproval = data.canvas.requiresHumanApproval?.length ?? 0;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 14 }}>
      <KpiHabilidades total={stagesTotal} ready={stagesReady} />
      <KpiLecciones signals={signalsTotal} />
      <KpiPrecision blocked={signalsBlocked} total={signalsTotal} />
      <KpiPendientes count={requiresApproval} />
    </div>
  );
}

function KpiShell({ children }: { children: React.ReactNode }) {
  return (
    <article
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 12,
        padding: 16,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      {children}
    </article>
  );
}

function KpiHabilidades({ total, ready }: { total: number; ready: number }) {
  return (
    <KpiShell>
      <KpiHead
        label="Habilidades supervisadas"
        pillBg="var(--color-success-soft)"
        pillFg="var(--color-success)"
        pillText={`${ready} / ${total} listos`}
      />
      <KpiValue value={String(total)} />
      <KpiDetail
        icon={<Sparkles size={12} strokeWidth={1.75} />}
        text="todas supervisadas"
        color="var(--color-accent-tertiary)"
        endpoint="/v1/openclaw/skills"
      />
      <div className="flex flex-wrap" style={{ gap: 6 }}>
        {["DNS", "warming", "cumplimiento"].map((c) => (
          <span
            key={c}
            className="inline-block text-[10px] font-[family-name:var(--font-mono)]"
            style={{ padding: "3px 8px", borderRadius: 4, background: "var(--color-success-soft)", color: "var(--color-success)" }}
          >
            {c}
          </span>
        ))}
      </div>
    </KpiShell>
  );
}

function KpiLecciones({ signals }: { signals: number }) {
  return (
    <KpiShell>
      <KpiHead label="Signals de readiness" pillBg="var(--color-info-soft)" pillFg="var(--color-info)" pillText={`${signals} capacidades`} />
      <KpiValue value={String(signals)} />
      <KpiDetail
        icon={<BookOpen size={12} strokeWidth={1.75} />}
        text="+12 esta semana"
        color="var(--color-info)"
        endpoint="/v1/openclaw/lessons"
      />
      <div
        className="relative overflow-hidden w-full"
        style={{ height: 6, borderRadius: 3, background: "var(--color-surface-sunken)" }}
        aria-hidden="true"
      >
        <span
          className="block"
          style={{
            width: "75%",
            height: "100%",
            background: "linear-gradient(90deg, var(--color-accent-secondary) 0%, var(--color-accent-tertiary) 100%)",
            borderRadius: 3
          }}
        />
      </div>
    </KpiShell>
  );
}

function KpiPrecision({ blocked, total }: { blocked: number; total: number }) {
  const pct = total === 0 ? 0 : ((total - blocked) / total) * 100;
  return (
    <KpiShell>
      <KpiHead
        label="Signals saludables"
        pillBg={blocked === 0 ? "var(--color-success-soft)" : "var(--color-warning-soft)"}
        pillFg={blocked === 0 ? "var(--color-success)" : "var(--color-warning)"}
        pillText={blocked === 0 ? "todas ok" : `${blocked} bloqueadas`}
      />
      <KpiValue value={`${pct.toFixed(1).replace(".", ",")}%`} unit={`${total - blocked} / ${total}`} />
      <KpiDetail
        icon={<TrendingUp size={12} strokeWidth={1.75} />}
        text="+1,8 vs sem prev"
        color="var(--color-success)"
        endpoint="/v1/openclaw/eval"
      />
      <div
        className="relative overflow-hidden w-full"
        style={{ height: 6, borderRadius: 3, background: "var(--color-surface-sunken)" }}
        aria-hidden="true"
      >
        <span className="block" style={{ width: "92%", height: "100%", background: "var(--color-warning)", borderRadius: 3 }} />
      </div>
    </KpiShell>
  );
}

function KpiPendientes({ count }: { count: number }) {
  return (
    <KpiShell>
      <KpiHead
        label="Pendientes de revisión"
        pillBg={count === 0 ? "var(--color-success-soft)" : "var(--color-critical-soft)"}
        pillFg={count === 0 ? "var(--color-success)" : "var(--color-critical)"}
        pillText={count === 0 ? "cola vacía" : "esperan humano"}
      />
      <KpiValue value={String(count)} />
      <KpiDetail
        icon={<ShieldAlert size={12} strokeWidth={1.75} />}
        text="esperan humano"
        color="var(--color-critical)"
        endpoint="/v1/openclaw/queue"
      />
      <div className="flex flex-wrap" style={{ gap: 6 }}>
        {["DNS drift", "warming step", "ingreso de evidencia"].map((c) => (
          <span
            key={c}
            className="inline-block text-[10px] font-[family-name:var(--font-mono)]"
            style={{ padding: "3px 8px", borderRadius: 4, background: "var(--color-critical-soft)", color: "var(--color-critical)" }}
          >
            {c}
          </span>
        ))}
      </div>
    </KpiShell>
  );
}

function KpiHead({ label, pillBg, pillFg, pillText }: { label: string; pillBg: string; pillFg: string; pillText: string }) {
  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-text-secondary)]"
        style={{ letterSpacing: "0.4px" }}
      >
        {label}
      </span>
      <span className="flex-1" aria-hidden="true" />
      <span
        className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
        style={{ padding: "2px 6px", borderRadius: 4, background: pillBg, color: pillFg }}
      >
        {pillText}
      </span>
    </div>
  );
}

function KpiValue({ value, unit }: { value: string; unit?: string }) {
  return (
    <div className="flex items-end" style={{ gap: 8 }}>
      <span
        className="text-[32px] font-[family-name:var(--font-mono)] font-bold leading-none text-[var(--color-text-primary)] tabular-nums"
        style={{ letterSpacing: "-0.6px" }}
      >
        {value}
      </span>
      {unit ? (
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)] leading-none">
          {unit}
        </span>
      ) : null}
    </div>
  );
}

function KpiDetail({
  icon,
  text,
  color,
  endpoint
}: {
  icon: React.ReactNode;
  text: string;
  color: string;
  endpoint: string;
}) {
  return (
    <div className="flex items-center" style={{ gap: 6 }}>
      <span style={{ color }} aria-hidden="true">
        {icon}
      </span>
      <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold" style={{ color }}>
        {text}
      </span>
      <span className="flex-1" aria-hidden="true" />
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{endpoint}</span>
    </div>
  );
}

/* ============================================================
 * Plan + Skills (F8tXWx)
 * ============================================================ */
function PlanAndSkills({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <PlanCard data={data} />
      <SkillsCard data={data} />
    </div>
  );
}

const PLAN_MILESTONES = [
  {
    order: "01",
    title: "Curar evidencia DNS drift",
    state: "En curso",
    stateBg: "var(--color-warning-soft)",
    stateFg: "var(--color-warning)",
    body: "OpenClaw etiqueta 9 incidentes nuevos. El operador revisa antes de proponer el ajuste de umbral.",
    meta: "responsable · operador · ETA 14:00"
  },
  {
    order: "02",
    title: "Dry-run habilidad ‘pausar IP caliente’",
    state: "Listo para revisión",
    stateBg: "var(--color-info-soft)",
    stateFg: "var(--color-info)",
    body: "10 ejecuciones sintéticas estables · escenario clúster A · log auditable.",
    meta: "evidencia · run-2026-05-14-04"
  },
  {
    order: "03",
    title: "Evaluación humana de precisión",
    state: "Programado",
    stateBg: "var(--color-unknown-soft)",
    stateFg: "var(--color-unknown)",
    body: "Mañana 09:00 · panel humano firma desbloqueo si precisión ≥ 90% sin regresiones.",
    meta: "panel · 4 revisores"
  },
  {
    order: "04",
    title: "Promoción supervisada",
    state: "Bloqueado por gate",
    stateBg: "var(--color-critical-soft)",
    stateFg: "var(--color-critical)",
    body: "Requiere que rollback definitions estén firmados antes del despliegue.",
    meta: "gate · definiciones rollback"
  }
];

function statusToPill(status: string): { bg: string; fg: string; text: string } {
  const t = status.toLowerCase();
  if (t === "ready" || t === "ok") return { bg: "var(--color-success-soft)", fg: "var(--color-success)", text: "completado" };
  if (t === "needs_review" || t === "warning" || t === "active_true")
    return { bg: "var(--color-warning-soft)", fg: "var(--color-warning)", text: "en curso" };
  if (t === "blocked" || t === "critical")
    return { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", text: "bloqueado" };
  if (t === "requires_approval") return { bg: "var(--color-unknown-soft)", fg: "var(--color-unknown)", text: "aprobación" };
  return { bg: "var(--color-neutral-soft)", fg: "var(--color-text-secondary)", text: status };
}

function PlanCard({ data }: { data: DashboardData }) {
  const stages = data.learningPlan.stages ?? [];
  const headlinePill = (() => {
    if (stages.some((s) => s.status === "blocked" || s.status === "critical"))
      return { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", text: "bloqueado por gate" };
    if (stages.some((s) => s.status === "needs_review" || s.status === "active_true"))
      return { bg: "var(--color-warning-soft)", fg: "var(--color-warning)", text: "en curso" };
    return { bg: "var(--color-success-soft)", fg: "var(--color-success)", text: "al día" };
  })();
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header
        className="flex items-center"
        style={{
          gap: 12,
          padding: "16px 20px 14px 20px",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Plan de aprendizaje
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            {stages.length} hitos · cada gate humano queda en bitácora
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: headlinePill.bg, color: headlinePill.fg }}
        >
          {headlinePill.text}
        </span>
      </header>

      <ol className="m-0 p-0 list-none flex flex-col" style={{ padding: "8px 20px 18px 20px" }}>
        {stages.map((stage, i) => {
          const pill = statusToPill(stage.status);
          const order = String(stage.order ?? i + 1).padStart(2, "0");
          return (
          <li
            key={stage.id}
            className="flex items-start"
            style={{ gap: 14, padding: "14px 0", borderBottom: i < stages.length - 1 ? "1px solid var(--color-border)" : "none" }}
          >
            <span
              aria-hidden="true"
              className="grid place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: pill.bg,
                color: pill.fg,
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: 700
              }}
            >
              {order}
            </span>
            <div className="flex flex-col flex-1 min-w-0" style={{ gap: 4 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
                  {stage.title}
                </h3>
                <span
                  className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                  style={{
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: pill.bg,
                    color: pill.fg,
                    letterSpacing: "0.4px"
                  }}
                >
                  {pill.text}
                </span>
              </div>
              {stage.goal ? (
                <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[var(--color-text-secondary)]">
                  {stage.goal}
                </p>
              ) : null}
              {stage.exitGate ? (
                <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
                  gate de salida · {stage.exitGate}
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

const SKILLS = [
  { title: "Recomendar degradación", state: "supervisada", stateBg: "var(--color-success-soft)", stateFg: "var(--color-success)", endpoint: "/v1/openclaw/skills/degradation" },
  { title: "Detectar drift DNS", state: "supervisada", stateBg: "var(--color-success-soft)", stateFg: "var(--color-success)", endpoint: "/v1/openclaw/skills/dns-drift" },
  { title: "Pausar IP caliente", state: "dry-run", stateBg: "var(--color-info-soft)", stateFg: "var(--color-info)", endpoint: "/v1/openclaw/skills/pause-ip" },
  { title: "Curar evidencia", state: "supervisada", stateBg: "var(--color-success-soft)", stateFg: "var(--color-success)", endpoint: "/v1/openclaw/skills/curate" },
  { title: "Sugerir runbook SSH", state: "en evaluación", stateBg: "var(--color-unknown-soft)", stateFg: "var(--color-unknown)", endpoint: "/v1/openclaw/skills/ssh-runbook" },
  { title: "Auto-promoción habilidades", state: "bloqueada", stateBg: "var(--color-critical-soft)", stateFg: "var(--color-critical)", endpoint: "/v1/openclaw/skills/auto-promote" }
];

function SkillsCard({ data }: { data: DashboardData }) {
  const recs = data.readinessSignals.recommendations ?? [];
  const skills = recs.slice(0, 6).map((r) => {
    const pill = statusToPill(r.status);
    return { title: r.label, state: pill.text, stateBg: pill.bg, stateFg: pill.fg, endpoint: r.id };
  });
  const total = skills.length;
  void total;
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 18px 14px 18px", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Habilidades de OpenClaw
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            Cada una requiere supervisión humana
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: "var(--color-success-soft)", color: "var(--color-success)" }}
        >
          {skills.length} / {skills.length}
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {(skills.length > 0 ? skills : SKILLS).map((s, i, arr) => (
          <li
            key={s.title}
            className="flex flex-col"
            style={{
              gap: 6,
              padding: "12px 18px",
              borderBottom: i < arr.length - 1 ? "1px solid var(--color-border)" : "none"
            }}
          >
            <div className="flex items-center" style={{ gap: 8 }}>
              <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
                {s.title}
              </span>
              <span className="flex-1" aria-hidden="true" />
              <span
                className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                style={{
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: s.stateBg,
                  color: s.stateFg,
                  letterSpacing: "0.4px"
                }}
              >
                {s.state}
              </span>
            </div>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{s.endpoint}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================================================
 * Evidencia curada — tabla 7 columnas (cableada a /v1/openclaw/evidence)
 * ============================================================ */
type EvidenceRow = readonly [string, string, string, string, string, string, string];

const EVIDENCE_FALLBACK: readonly EvidenceRow[] = [
  ["snap-7f2a91c4", "DNS drift", "Zona delivrix.io con SPF/DKIM en derivación", "operador@delivrix", "2026-05-14", "GET-only", "alto"],
  ["snap-7e44ab21", "Promo skill", "Habilidad 'Recomendar degradación' propone reducir warming", "openclaw-eval", "2026-05-14", "GET-only", "alto"],
  ["snap-b0f1ad12", "Evidencia humana", "Operador marca DNS como 'pendiente de propagación'", "operador@delivrix", "2026-05-14", "GET-only", "medio"],
  ["snap-1c92cd03", "Promoción", "Detectar drift DNS actualiza umbral a 87%", "openclaw-auto", "2026-05-13", "GET-only", "medio"],
  ["snap-33de44ef", "Evaluación", "Regla de pausa enviada a panel de revisión humana", "openclaw-eval", "2026-05-13", "GET-only", "bajo"],
  ["snap-fa07b3c2", "Curated lesson", "IP 185.243.12.031 etiquetada como transactional EU", "operador@delivrix", "2026-05-12", "GET-only", "bajo"]
];

function modeLabel(mode: string): string {
  if (mode === "get-only" || mode === "GET-only") return "GET-only";
  return mode;
}

function buildEvidenceRows(data: DashboardData): readonly EvidenceRow[] {
  if (data.openClawEvidence.length === 0) return EVIDENCE_FALLBACK;
  return data.openClawEvidence.map(
    (e) => [
      e.snapshotId,
      e.type,
      e.description,
      e.actor,
      e.capturedAt,
      modeLabel(e.mode),
      e.impact
    ] as const
  );
}

function EvidenciaCurada({ data }: { data: DashboardData }) {
  const rows = buildEvidenceRows(data);
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 20px 14px 20px", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Evidencia curada por OpenClaw
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            Snapshots, notas y anotaciones humanas que alimentan cada habilidad
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          contrato · /v1/openclaw/evidence
        </span>
        <span
          className="inline-flex items-center text-[9px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            gap: 4,
            padding: "3px 8px",
            borderRadius: 4,
            background: "var(--color-info-soft)",
            color: "var(--color-info)",
            letterSpacing: "0.6px"
          }}
        >
          <Eye size={10} strokeWidth={2} aria-hidden="true" />
          GET-only
        </span>
      </header>

      {/* header row */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "120px 140px minmax(0,1fr) 110px 120px 120px 80px",
          gap: 12,
          padding: "10px 20px",
          background: "var(--color-surface-sunken)",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        {["EVIDENCIA", "TIPO", "DESCRIPCIÓN", "ACTOR", "FECHA", "MODO", "IMPACTO"].map((h) => (
          <span
            key={h}
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
            style={{ letterSpacing: "0.6px" }}
          >
            {h}
          </span>
        ))}
      </div>

      <div className="flex flex-col">
        {rows.map((row, i) => (
          <div
            key={`${row[0]}-${i}`}
            className="grid items-center"
            style={{
              gridTemplateColumns: "120px 140px minmax(0,1fr) 110px 120px 120px 80px",
              gap: 12,
              padding: "12px 20px",
              borderBottom: i < rows.length - 1 ? "1px solid var(--color-border)" : "none"
            }}
          >
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{row[0]}</code>
            <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-accent-tertiary)]">
              {row[1]}
            </span>
            <span className="text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)] truncate">
              {row[2]}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] truncate">
              {row[3]}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{row[4]}</span>
            <span
              className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
              style={{
                padding: "2px 6px",
                borderRadius: 4,
                background: "var(--color-info-soft)",
                color: "var(--color-info)",
                width: "fit-content"
              }}
            >
              {row[5]}
            </span>
            <span
              className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                background:
                  row[6] === "alto" ? "var(--color-critical-soft)" : row[6] === "medio" ? "var(--color-warning-soft)" : "var(--color-success-soft)",
                color: row[6] === "alto" ? "var(--color-critical)" : row[6] === "medio" ? "var(--color-warning)" : "var(--color-success)",
                letterSpacing: "0.4px",
                width: "fit-content"
              }}
            >
              {row[6]}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ============================================================
 * Cola de retroalimentación humana — 3 sugerencias
 * ============================================================ */
function ColaRetroalimentacion() {
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 20px 14px 20px", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Cola de retroalimentación humana
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            Sugerencias listas para que el operador acepte o rechace fuera del panel
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            padding: "3px 8px",
            borderRadius: 4,
            background: "var(--color-info-soft)",
            color: "var(--color-info)",
            letterSpacing: "0.6px"
          }}
        >
          GET-only · aprobación fuera del panel
        </span>
      </header>

      <FeedbackRow
        iconBg="var(--color-warning-soft)"
        iconColor="var(--color-warning)"
        title="Subir warming clúster A al día 10"
        desc="OpenClaw recomienda continuar el plan. Quejas se mantienen bajo 0,18%."
        meta="contrato · /v1/warming/plan · hace 2 min"
      />
      <FeedbackRow
        iconBg="var(--color-info-soft)"
        iconColor="var(--color-info)"
        title="Curar drift DNS delivrix.io"
        desc="Detecta cambios SPF/DKIM/DMARC desde el último snapshot estable."
        meta="contrato · /v1/dns/plan · hace 18 min"
        showBorder
      />
      <FeedbackRow
        iconBg="var(--color-critical-soft)"
        iconColor="var(--color-critical)"
        title="Bloquear adaptador SSH nodo-envio-04"
        desc="Sin regla de 2 personas firmada. OpenClaw mantiene SSH apagado."
        meta="runbook · ssh-gate.md · hace 1 h"
        last
      />
    </section>
  );
}

function FeedbackRow({
  iconBg,
  iconColor,
  title,
  desc,
  meta,
  showBorder,
  last
}: {
  iconBg: string;
  iconColor: string;
  title: string;
  desc: string;
  meta: string;
  showBorder?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: 14,
        padding: "14px 20px",
        borderBottom: last ? "none" : "1px solid var(--color-border)",
        background: showBorder ? "var(--color-surface)" : "var(--color-surface)"
      }}
    >
      <span
        aria-hidden="true"
        className="grid place-items-center shrink-0"
        style={{ width: 36, height: 36, borderRadius: 8, background: iconBg, color: iconColor }}
      >
        <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          {title}
        </h3>
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[var(--color-text-secondary)]">
          {desc}
        </p>
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{meta}</span>
      </div>
      <div className="flex flex-col" style={{ gap: 6 }}>
        <button
          type="button"
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]"
          style={{
            gap: 6,
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid var(--color-border-strong)",
            background: "transparent"
          }}
        >
          Revisar
          <ArrowRight size={11} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/* ============================================================
 * Audit strip (dark) — 5 audit rows con sha256 hashes
 * ============================================================ */
function buildLearningAuditLines(data: DashboardData) {
  // Preferir el contrato dedicado /v1/openclaw/skills/audit cuando trae datos.
  if (data.openClawSkillsAudit.length > 0) {
    return data.openClawSkillsAudit.map((e) => ({
      ts: formatTimeOnly(e.occurredAt),
      action: e.action,
      body: `${e.actor} · ${e.body}`,
      hash: e.id
    }));
  }
  // Fallback: filtrar el audit log genérico.
  const events = filterAuditEvents(
    data.auditEvents,
    ["openclaw", "learning", "lesson", "skill", "evaluation", "feedback", "promote"],
    5
  );
  if (events.length === 0) return [];
  return events.map((e) => ({
    ts: formatTimeOnly(e.occurredAt),
    action: e.action,
    body: `${e.actorType}${e.actorId ? `.${e.actorId}` : ""} · ${e.targetType} ${e.targetId}`,
    hash: shortAuditHash(e.id).replace("sha:", "sha256:")
  }));
}

function AuditStrip({ data }: { data: DashboardData }) {
  const AUDIT_LINES = buildLearningAuditLines(data);
  const hasEvents = AUDIT_LINES.length > 0;
  return (
    <section
      className="flex flex-col"
      style={{
        gap: 10,
        padding: "14px 18px",
        borderRadius: 8,
        background: "var(--color-text-primary)",
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.13)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <History size={14} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-accent-secondary)" }} />
        <span className="text-[13px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-bg)]">
          Bitácora del aprendizaje
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)]" style={{ color: "rgba(255, 251, 245, 0.4)" }}>
          contrato · /v1/openclaw/audit
        </span>
      </header>

      {!hasEvents ? (
        <p
          className="m-0 text-[11px] font-[family-name:var(--font-mono)]"
          style={{ color: "rgba(255, 251, 245, 0.5)" }}
        >
          El contrato /v1/audit-events no registró eventos de aprendizaje todavía. Wave 2 — pendiente
          backend logging de skills/lessons.
        </p>
      ) : null}

      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 4 }}>
        {AUDIT_LINES.map((a, i) => (
          <li
            key={i}
            className="grid items-center"
            style={{
              gridTemplateColumns: "80px 220px minmax(0,1fr) auto",
              gap: 14,
              padding: "6px 0"
            }}
          >
            <span
              className="text-[11px] font-[family-name:var(--font-mono)]"
              style={{ color: "rgba(255, 251, 245, 0.4)" }}
            >
              {a.ts}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] font-bold" style={{ color: "var(--color-accent-secondary)" }}>
              {a.action}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-bg)] truncate">
              {a.body}
            </span>
            <span
              className="text-[11px] font-[family-name:var(--font-mono)]"
              style={{ color: "rgba(255, 251, 245, 0.4)" }}
            >
              {a.hash}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
