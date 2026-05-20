/**
 * Overview Dashboard — port LITERAL desde Pencil frame `e1ashz`.
 *
 * Cada texto, color, padding e icono viene del .pen (leído con
 * mcp__pencil-desktop__batch_get + resolveVariables). Los valores numéricos
 * (148, 42, 94,2, 3) se reemplazan con datos reales del backend cuando aplica;
 * los textos descriptivos del diseño se mantienen literales.
 */

import {
  ArrowRight,
  ArrowUp,
  Check,
  Flame,
  Info,
  Minus,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  WandSparkles,
  X
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import { formatDateTime, formatNumber, humanize } from "../../shared/lib/formatters.ts";

export function OverviewSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col gap-5" style={{ width: "100%" }}>
      <HeaderRow data={data} />
      <KpiRow data={data} />
      <Pipeline />
      <BottomRow data={data} />
    </section>
  );
}

/* ============================================================
 * Header row — Welcome + OpenClaw prompt (gradient border)
 * ============================================================ */
function HeaderRow({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
      <Welcome generatedAt={data.overview.generatedAt} />
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
          INICIO OPERATIVO
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
        Capacidad preparada, sin envíos reales.
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
        Delivrix gobierna infraestructura de correo autorizada en modo solo lectura. OpenClaw
        observa, valida y propone — los humanos aprueban cada acción real.
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
        background:
          "linear-gradient(135deg, var(--color-accent-secondary) 0%, var(--color-accent) 50%, var(--color-accent-tertiary) 100%)",
        boxShadow: "0 6px 18px rgba(146, 64, 14, 0.13)"
      }}
    >
      <div className="flex flex-col bg-[var(--color-surface)]" style={{ borderRadius: 10, padding: 16, gap: 12 }}>
        {/* ocHead */}
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

        {/* Message — literal Pencil */}
        <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.45] text-[var(--color-text-primary)]">
          2 clústeres de envío esperan aprobación humana. Las quejas del clúster A superaron
          0,18% en los últimos 4 snapshots — preparé un plan de degradación.
        </p>

        {/* ocInput */}
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

        {/* ocActions */}
        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            type="button"
            disabled
            className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-bg)] disabled:cursor-default disabled:opacity-100"
            style={{
              gap: 6,
              padding: "10px 14px",
              borderRadius: 6,
              background: "var(--color-text-primary)"
            }}
          >
            <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            Sugerir siguiente paso
          </button>
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
            interacción real vive fuera del panel
          </span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * KPI row — 4 cards literales Pencil
 * ============================================================ */
function KpiRow({ data }: { data: DashboardData }) {
  // Preferir /v1/operational-summary cuando exista (ya agrega audit, jobs y
  // sendResults). Caer a data.overview cuando el endpoint nuevo está vacío.
  const opSummary = data.operationalSummary;
  const sender = opSummary.senderNodesByStatus ?? data.overview.summary.senderNodesByStatus ?? {};
  const senderTotal = data.senderNodes.length || Object.values(sender).reduce((a, b) => a + b, 0);
  const ipsWarming = sender.warming ?? 0;
  const sendResultsByStatus =
    opSummary.sendResultsByStatus ?? data.overview.summary.sendResultsByStatus ?? {};
  const totalSends = Object.values(sendResultsByStatus).reduce((a, b) => a + b, 0);
  const acceptedOk = sendResultsByStatus.sent ?? sendResultsByStatus.delivered ?? 0;
  const reputation = totalSends === 0 ? null : Math.round((acceptedOk / totalSends) * 1000) / 10;
  const gatesOpen = data.operatingNorth.gates?.length ?? 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 14 }}>
      <KpiSenderNodes total={senderTotal} />
      <KpiWarming value={ipsWarming} />
      <KpiReputation value={reputation} />
      <KpiGates value={gatesOpen} gates={data.operatingNorth.gates ?? []} />
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
        <span className="text-[14px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)] leading-none">
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

/* K1 — Nodos de envío (literal Pencil) */
function KpiSenderNodes({ total }: { total: number }) {
  const bars = [
    { h: 18, op: 0.35, color: "var(--color-accent-secondary)" },
    { h: 24, op: 0.45, color: "var(--color-accent-secondary)" },
    { h: 20, op: 0.4, color: "var(--color-accent-secondary)" },
    { h: 28, op: 0.55, color: "var(--color-accent)" },
    { h: 30, op: 0.7, color: "var(--color-accent)" },
    { h: 24, op: 0.6, color: "var(--color-accent)" },
    { h: 32, op: 0.8, color: "var(--color-accent-tertiary)" },
    { h: 36, op: 1.0, color: "var(--color-accent-tertiary)" }
  ];
  return (
    <KpiShell>
      <KpiHead label="Nodos de envío" pillBg="var(--color-success-soft)" pillFg="var(--color-success)" pillText="+6 esta semana" />
      <KpiValue value={formatNumber(total)} />
      <KpiDetail
        icon={<TrendingUp size={12} strokeWidth={1.75} />}
        text="+6 esta semana"
        color="var(--color-success)"
        endpoint="/v1/sender-nodes"
      />
      <div className="flex items-end w-full" style={{ gap: 3, height: 36 }}>
        {bars.map((b, i) => (
          <span
            key={i}
            className="flex-1"
            style={{ height: b.h, background: b.color, opacity: b.op, borderRadius: 2 }}
            aria-hidden="true"
          />
        ))}
      </div>
    </KpiShell>
  );
}

/* K2 — IPs en calentamiento (literal Pencil) */
function KpiWarming({ value }: { value: number }) {
  return (
    <KpiShell>
      <KpiHead label="IPs en calentamiento" pillBg="var(--color-info-soft)" pillFg="var(--color-info)" pillText="día 9 / 28 prom" />
      <KpiValue value={formatNumber(value)} />
      <KpiDetail
        icon={<Flame size={12} strokeWidth={1.75} />}
        text="día 9 / 28 prom"
        color="var(--color-accent-tertiary)"
        endpoint="/v1/warming"
      />
      <div
        className="relative w-full overflow-hidden"
        style={{ height: 6, borderRadius: 3, background: "var(--color-surface-sunken)" }}
        aria-hidden="true"
      >
        <div className="flex h-full" style={{ gap: 4 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 48,
                height: "100%",
                borderRadius: 3,
                background: "linear-gradient(90deg, var(--color-accent-secondary) 0%, var(--color-accent-tertiary) 100%)"
              }}
            />
          ))}
        </div>
      </div>
    </KpiShell>
  );
}

/* K3 — Índice de reputación (literal Pencil) */
function KpiReputation({ value }: { value: number | null }) {
  const display = value === null ? "—" : value.toFixed(1).replace(".", ",");
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <KpiShell>
      <KpiHead label="Índice de reputación" pillBg="var(--color-warning-soft)" pillFg="var(--color-warning)" pillText="warning" />
      <KpiValue value={display} unit="/ 100" />
      <KpiDetail
        icon={<TrendingDown size={12} strokeWidth={1.75} />}
        text="-1,4 vs 24h"
        color="var(--color-warning)"
        endpoint="/v1/reputation"
      />
      <div
        className="relative w-full overflow-hidden"
        style={{ height: 6, borderRadius: 3, background: "var(--color-surface-sunken)" }}
        aria-hidden="true"
      >
        <span
          className="block"
          style={{ width: `${pct}%`, height: 8, borderRadius: 3, background: "var(--color-warning)" }}
        />
      </div>
    </KpiShell>
  );
}

/* K4 — Gates abiertos (literal Pencil) */
function KpiGates({ value, gates }: { value: number; gates: string[] }) {
  return (
    <KpiShell>
      <KpiHead label="Gates abiertos" pillBg="var(--color-critical-soft)" pillFg="var(--color-critical)" pillText="espera aprobación" />
      <KpiValue value={formatNumber(value)} />
      <KpiDetail
        icon={<ShieldAlert size={12} strokeWidth={1.75} />}
        text="espera aprobación"
        color="var(--color-critical)"
        endpoint="/v1/gates"
      />
      <div className="flex flex-wrap" style={{ gap: 6 }}>
        {gates.slice(0, 3).map((g) => (
          <span
            key={g}
            className="inline-block text-[10px] font-[family-name:var(--font-mono)]"
            style={{ padding: "3px 8px", borderRadius: 4, background: "var(--color-critical-soft)", color: "var(--color-critical)" }}
          >
            {g.replace(/_/g, " ")}
          </span>
        ))}
      </div>
    </KpiShell>
  );
}

/* ============================================================
 * Pipeline — 5 stages literales Pencil + chevron entre cada uno
 * ============================================================ */
function Pipeline() {
  return (
    <section
      className="bg-[var(--color-surface)]"
      style={{
        borderRadius: 8,
        padding: 20,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      {/* pipeHead */}
      <header className="flex items-center" style={{ gap: 12, marginBottom: 16 }}>
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Flujo operativo
          </h2>
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
            Onboarding → planificación → provisionamiento dry-run → calentamiento → reputación.
            Cada transición tiene un gate humano.
          </p>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <button
          type="button"
          className="inline-flex items-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]"
          style={{ gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border-strong)", background: "transparent" }}
        >
          Abrir canvas
          <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>

      {/* Stages row */}
      <div className="relative">
        <div
          aria-label="Pipeline operativo"
          className="flex snap-x snap-mandatory items-stretch gap-3 overflow-x-auto pb-2 md:gap-0 md:overflow-visible md:pb-0"
        >
          <StageCard
            title="Onboarding"
            body="Servidor, IPs y dominios capturados"
            footer="100% · 6/6 pasos"
            variant="success"
          />
          <StageConnector />
          <StageCard
            title="Planificación"
            body="Plan de topología generado dry-run"
            footer="contrato · /v1/clusters/plan"
            variant="success"
          />
          <StageConnector />
          <StageCard
            title="Provisionamiento"
            body="Dry-run · Postfix, DKIM, TLS, DNS, plan de calentamiento"
            footer={null}
            variant="in_progress"
            progress={62}
          />
          <StageConnector />
          <StageCard
            title="Calentamiento"
            body="42 IPs en calentamiento · espera aprobación"
            footer="requiere aprobación humana"
            variant="warning"
          />
          <StageConnector />
          <StageCard
            title="Reputación"
            body="Observadores listos · tráfico simulado"
            footer="sin envíos reales en el MVP"
            variant="neutral"
          />
        </div>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 md:hidden"
          style={{ background: "linear-gradient(90deg, transparent 0%, var(--color-surface) 100%)" }}
        />
      </div>
    </section>
  );
}

type StageVariant = "success" | "in_progress" | "warning" | "neutral";

function StageCard({
  title,
  body,
  footer,
  variant,
  progress
}: {
  title: string;
  body: string;
  footer: string | null;
  variant: StageVariant;
  progress?: number;
}) {
  const style = stageStyle(variant);
  return (
    <div
      className="flex min-w-[280px] flex-[0_0_280px] snap-start flex-col md:min-w-0 md:flex-1"
      style={{
        gap: 10,
        padding: 14,
        borderRadius: 8,
        background: style.bg,
        border: `1px solid ${style.border}`
      }}
    >
      <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
        {title}
      </span>
      <p className="m-0 text-[11px] font-[family-name:var(--font-sans)] leading-[1.4] text-[var(--color-text-primary)]">
        {body}
      </p>
      {variant === "in_progress" && progress !== undefined ? (
        <div
          className="overflow-hidden"
          style={{ height: 5, borderRadius: 3, background: "var(--color-surface)" }}
          aria-hidden="true"
        >
          <span
            className="block"
            style={{
              width: `${progress}%`,
              height: "100%",
              background: "linear-gradient(90deg, var(--color-accent-secondary) 0%, var(--color-accent-tertiary) 100%)"
            }}
          />
        </div>
      ) : null}
      {footer ? (
        <span className="text-[10px] font-[family-name:var(--font-mono)] font-medium" style={{ color: style.footerFg }}>
          {footer}
        </span>
      ) : null}
    </div>
  );
}

function StageConnector() {
  return (
    <div className="hidden place-items-center md:grid" style={{ width: 18, height: 22 }}>
      <ArrowRight size={14} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
    </div>
  );
}

function stageStyle(variant: StageVariant) {
  if (variant === "success")
    return { bg: "var(--color-success-soft)", border: "var(--color-success)", footerFg: "var(--color-text-secondary)" };
  if (variant === "in_progress")
    return {
      bg: "linear-gradient(135deg, rgba(250, 204, 21, 0.2) 0%, rgba(234, 88, 12, 0.2) 100%)",
      border: "var(--color-accent-tertiary)",
      footerFg: "var(--color-accent-tertiary)"
    };
  if (variant === "warning")
    return { bg: "var(--color-warning-soft)", border: "var(--color-warning)", footerFg: "var(--color-warning)" };
  return { bg: "var(--color-neutral-soft)", border: "var(--color-border)", footerFg: "var(--color-text-tertiary)" };
}

/* ============================================================
 * Bottom row — Aprobaciones + Side pane (Gates + System health)
 * ============================================================ */
function BottomRow({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <ApprovalsCard data={data} />
      <SidePane data={data} />
    </div>
  );
}

function ApprovalsCard({ data }: { data: DashboardData }) {
  const approvalIds = data.canvas.requiresHumanApproval ?? [];
  const count = approvalIds.length;
  // Mapping de IDs → metadata visual. Pencil tiene 3 ejemplos canónicos;
  // se asignan por keyword del ID; los que no matchean caen al genérico.
  const VARIANTS = [
    {
      key: "warming",
      iconBg: "var(--color-warning-soft)",
      iconColor: "var(--color-warning)",
      pillBg: "var(--color-warning-soft)",
      pillFg: "var(--color-warning)",
      pillText: "warming",
      desc: "OpenClaw propone avanzar el ciclo de calentamiento. Vigilancia de reputación activa.",
      meta1: "contrato · /v1/warming/plan"
    },
    {
      key: "dns",
      iconBg: "var(--color-critical-soft)",
      iconColor: "var(--color-critical)",
      pillBg: "var(--color-critical-soft)",
      pillFg: "var(--color-critical)",
      pillText: "dns",
      desc: "Drift SPF/DKIM/DMARC detectado · plan dry-run listo, no se realizó escritura real.",
      meta1: "contrato · /v1/dns/plan"
    },
    {
      key: "ssh",
      iconBg: "var(--color-unknown-soft)",
      iconColor: "var(--color-unknown)",
      pillBg: "var(--color-unknown-soft)",
      pillFg: "var(--color-unknown)",
      pillText: "ssh",
      desc: "Alcance del permiso desconocido hasta firmar la regla de 2 personas. SSH desactivado por defecto.",
      meta1: "runbook · ssh-gate.md"
    },
    {
      key: "generic",
      iconBg: "var(--color-surface-sunken)",
      iconColor: "var(--color-text-secondary)",
      pillBg: "var(--color-surface-sunken)",
      pillFg: "var(--color-text-secondary)",
      pillText: "humano",
      desc: "Acción que requiere autorización humana antes de avanzar.",
      meta1: "contrato · /v1/openclaw/queue"
    }
  ];
  const pickVariant = (id: string) => {
    const lower = id.toLowerCase();
    return VARIANTS.find((v) => v.key !== "generic" && lower.includes(v.key)) ?? VARIANTS[3];
  };
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      {/* acHead */}
      <header
        className="flex items-center"
        style={{
          gap: 12,
          padding: "16px 18px 14px 18px",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Aprobaciones pendientes
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            Cada acción que un humano debe validar
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: "var(--color-critical-soft)", color: "var(--color-critical)" }}
        >
          {formatNumber(count)} pendientes
        </span>
      </header>

      {/* acList — derivado de canvas.requiresHumanApproval */}
      {count === 0 ? (
        <div style={{ padding: "14px 18px" }}>
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
            Cola de aprobaciones vacía. Todas las acciones supervisadas están autorizadas o no
            requieren intervención humana.
          </p>
        </div>
      ) : (
        approvalIds.slice(0, 3).map((id, i) => {
          const v = pickVariant(id);
          const icon = v.key === "warming"
            ? <Flame size={18} strokeWidth={1.75} />
            : v.key === "dns"
              ? <ShieldAlert size={18} strokeWidth={1.75} />
              : v.key === "ssh"
                ? <Info size={18} strokeWidth={1.75} />
                : <Info size={18} strokeWidth={1.75} />;
          return (
            <ApprovalRow
              key={id}
              iconBg={v.iconBg}
              iconColor={v.iconColor}
              icon={icon}
              title={id.replace(/_/g, " ")}
              pillBg={v.pillBg}
              pillFg={v.pillFg}
              pillText={v.pillText}
              desc={v.desc}
              meta1={v.meta1}
              meta2="pendiente"
              showBorder={i < Math.min(approvalIds.length, 3) - 1}
            />
          );
        })
      )}
    </section>
  );
}

function ApprovalRow({
  iconBg,
  iconColor,
  icon,
  title,
  pillBg,
  pillFg,
  pillText,
  desc,
  meta1,
  meta2,
  showBorder
}: {
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  title: string;
  pillBg: string;
  pillFg: string;
  pillText: string;
  desc: string;
  meta1: string;
  meta2: string;
  showBorder: boolean;
}) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: 12,
        padding: "14px 18px",
        borderBottom: showBorder ? "1px solid var(--color-border)" : "none"
      }}
    >
      <span
        aria-hidden="true"
        className="grid place-items-center"
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: iconBg,
          color: iconColor,
          flexShrink: 0
        }}
      >
        {icon}
      </span>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 2 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)] truncate">
            {title}
          </span>
          <span
            className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
            style={{ padding: "2px 6px", borderRadius: 4, background: pillBg, color: pillFg }}
          >
            {pillText}
          </span>
        </div>
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.4] text-[var(--color-text-secondary)]">
          {desc}
        </p>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{meta1}</span>
          <span aria-hidden="true" className="rounded-[1.5px]" style={{ width: 3, height: 3, background: "var(--color-text-tertiary)" }} />
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{meta2}</span>
        </div>
      </div>
      <button
        type="button"
        className="inline-flex items-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]"
        style={{
          gap: 6,
          padding: "7px 12px",
          borderRadius: 6,
          border: "1px solid var(--color-border-strong)",
          background: "transparent",
          flexShrink: 0
        }}
      >
        Revisar
        <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/* Side pane: Gates + System health dark */
function SidePane({ data }: { data: DashboardData }) {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <GatesCard data={data} />
      <SystemHealthDark data={data} />
    </div>
  );
}

/* Gates no negociables — base canónica + gates reales de operatingNorth */
function GatesCard({ data }: { data: DashboardData }) {
  const ks = data.killSwitch;
  const live = data.operatingNorth.liveInfrastructureWritesEnabled;
  const nfc = data.operatingNorth.nfcProductionWritesEnabled;
  const base: Array<{ kind: "ok" | "warn" | "bad" | "off"; label: string; note: string }> = [
    { kind: "ok", label: "Log de auditoría append-only", note: "verificado" },
    {
      kind: ks.enabled ? "bad" : "ok",
      label: "Interruptor probado",
      note: ks.updatedAt ? new Date(ks.updatedAt).toLocaleDateString("es-CO") : "sin uso"
    },
    { kind: "ok", label: "Dry-run antes de escribir", note: "verificado" },
    { kind: "ok", label: "Panel solo GET", note: "verificado" },
    {
      kind: live ? "warn" : "ok",
      label: "Live infrastructure writes",
      note: live ? "enabled · revisar" : "disabled"
    },
    {
      kind: nfc ? "warn" : "off",
      label: "Puente NFC",
      note: nfc ? "enabled" : "deshabilitado"
    }
  ];
  // gates específicos del operating-north — humanize() convierte
  // `admin_panel_reads_canvas_and_hardware_from_backend_contracts` en
  // "admin panel reads canvas and hardware from backend contracts".
  const opGates = (data.operatingNorth.gates ?? []).map((g) => ({
    kind: "warn" as const,
    label: humanize(g),
    rawLabel: g,
    note: "revisión pendiente"
  }));
  const gates = [...base, ...opGates];
  const okCount = gates.filter((g) => g.kind === "ok").length;
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 12,
        padding: 18,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      {/* gHead */}
      <header className="flex items-center" style={{ gap: 8 }}>
        <h2 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
          Gates no negociables
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-secondary)]">
          {okCount}/{gates.length}
        </span>
      </header>

      {/* gateList */}
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 8 }}>
        {gates.map((g, i) => {
          const raw = "rawLabel" in g && typeof g.rawLabel === "string" ? g.rawLabel : g.label;
          return (
            <GateRow
              key={`${i}-${raw}`}
              kind={g.kind}
              label={g.label}
              rawLabel={raw}
              note={g.note}
            />
          );
        })}
      </ul>
    </section>
  );
}

function GateRow({
  kind,
  label,
  rawLabel,
  note
}: {
  kind: "ok" | "warn" | "bad" | "off";
  label: string;
  rawLabel: string;
  note: string;
}) {
  const dot =
    kind === "ok"
      ? { bg: "var(--color-success)", icon: <Check size={10} strokeWidth={2} aria-hidden="true" /> }
      : kind === "warn"
        ? { bg: "var(--color-warning)", icon: <TriangleAlert size={10} strokeWidth={2} aria-hidden="true" /> }
        : kind === "bad"
          ? { bg: "var(--color-critical)", icon: <X size={10} strokeWidth={2} aria-hidden="true" /> }
          : { bg: "var(--color-neutral)", icon: <Minus size={10} strokeWidth={2} aria-hidden="true" /> };
  const noteColor =
    kind === "ok" ? "var(--color-success)" : kind === "warn" ? "var(--color-warning)" : kind === "bad" ? "var(--color-critical)" : "var(--color-text-tertiary)";

  return (
    <li className="flex items-center min-w-0" style={{ gap: 8 }} title={rawLabel}>
      <span
        aria-hidden="true"
        className="grid place-items-center text-[var(--color-bg)]"
        style={{ width: 16, height: 16, borderRadius: 8, background: dot.bg, flexShrink: 0 }}
      >
        {dot.icon}
      </span>
      <span
        className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)] truncate"
        style={{ flex: "1 1 auto", minWidth: 0 }}
      >
        {label}
      </span>
      <span
        className="text-[10px] font-[family-name:var(--font-mono)]"
        style={{ color: noteColor, whiteSpace: "nowrap", flexShrink: 0 }}
      >
        {note}
      </span>
    </li>
  );
}

/* System health (dark) — alimentado por data.health.operatingNorth real */
function SystemHealthDark({ data }: { data: DashboardData }) {
  const on = data.health.operatingNorth;
  const sched = data.health.openClaw["scheduler"];
  const fresh = data.supervisedCollector.freshness.lastCollectedAt;
  const freshAge = fresh
    ? (() => {
        const t = new Date(fresh).getTime();
        const diff = Math.max(0, Date.now() - t);
        if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
        if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min`;
        return `${Math.round(diff / 3_600_000)} h`;
      })()
    : "sin datos";
  const jobsTotal = data.operationalSummary.totals.jobs;
  const stuckCount = data.stuckJobs.count;
  const rows = [
    {
      label: "Gateway",
      value: data.health.status === "ok" ? "OK" : data.health.status,
      valueColor: data.health.status === "ok" ? "var(--color-success)" : "var(--color-critical)"
    },
    {
      label: "Cola del worker",
      value: `${jobsTotal} jobs · ${stuckCount} atascados`,
      valueColor: stuckCount === 0 ? "var(--color-success)" : "var(--color-accent-secondary)"
    },
    {
      label: "Phase",
      value: data.health.phase,
      valueColor: "var(--color-accent-secondary)"
    },
    {
      label: "Frescura recolector",
      value: freshAge,
      valueColor: data.supervisedCollector.freshness.staleSources > 0 ? "var(--color-accent-secondary)" : "var(--color-success)"
    },
    {
      label: "Scheduler OpenClaw",
      value: sched ? String(sched) : "no reportado",
      valueColor: "var(--color-accent-secondary)"
    },
    {
      label: "Infra writes",
      value: on.liveInfrastructureWritesEnabled ? "enabled · revisar" : "disabled",
      valueColor: on.liveInfrastructureWritesEnabled ? "var(--color-critical)" : "var(--color-success)"
    },
    {
      label: "SMTP real",
      value: on.delivrixSendsRealEmail ? "enabled" : "simulación",
      valueColor: on.delivrixSendsRealEmail ? "var(--color-critical)" : "var(--color-success)"
    },
    {
      label: "Puente NFC",
      value: on.nfcProductionWritesEnabled ? "enabled" : "deshabilitado",
      valueColor: on.nfcProductionWritesEnabled ? "var(--color-critical)" : "var(--color-text-tertiary)"
    }
  ];
  return (
    <section
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 18,
        borderRadius: 8,
        background: "var(--color-text-primary)",
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.13)"
      }}
    >
      {/* shHead */}
      <header className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
          style={{ letterSpacing: "1.2px" }}
        >
          SISTEMA
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: "var(--color-success)" }} />
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-success)]"
          style={{ letterSpacing: "1.2px" }}
        >
          OPERATIVO
        </span>
      </header>

      <h2
        className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-semibold leading-tight text-[var(--color-bg)]"
        style={{ letterSpacing: "-0.2px" }}
      >
        Todos los gateways responden.
      </h2>

      {/* shGrid */}
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 8 }}>
        {rows.map((r) => (
          <li key={r.label} className="flex items-center" style={{ gap: 8 }}>
            <span className="text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-bg)]" style={{ opacity: 0.8 }}>
              {r.label}
            </span>
            <span className="flex-1" aria-hidden="true" />
            <span className="text-[11px] font-[family-name:var(--font-mono)]" style={{ color: r.valueColor }}>
              {r.value}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
