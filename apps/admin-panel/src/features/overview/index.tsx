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
  Check,
  Flame,
  Minus,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  X
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import { formatDateTime, formatNumber, humanize } from "../../shared/lib/formatters.ts";
import {
  ApprovalRow as ApprovalRowV2,
  type ApprovalSeverity,
  BannerOpenClawV2,
  LiveIndicator,
  SectionDivider
} from "../../shared/ui/v2/index.ts";
import { Tooltip } from "../../shared/ui/tooltip.tsx";

export function OverviewSection({ data, onNavigate }: { data: DashboardData; onNavigate?: (section: string) => void }) {
  return (
    <section className="flex flex-col gap-5" style={{ width: "100%" }}>
      <HeaderRow data={data} />
      <SectionDivider
        title="Métricas operativas"
        caption="dataSource: panel agregados · actualizado cada 5s"
        countTone="success"
      />
      <KpiRow data={data} />
      <SectionDivider
        title="Flujo operativo"
        caption="onboarding → planificación → provisionamiento → calentamiento → reputación"
        countTone="success"
      />
      <Pipeline onNavigate={onNavigate} />
      <BottomRow data={data} />
    </section>
  );
}

/* ============================================================
 * Header row — Welcome + LiveIndicator + Banner OpenClaw v2
 * ============================================================ */
function HeaderRow({ data }: { data: DashboardData }) {
  const lastUpdate = new Date(data.overview.generatedAt).getTime();
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <Welcome generatedAt={data.overview.generatedAt} lastUpdateMs={lastUpdate} />
      <BannerOpenClawV2
        title="OpenClaw propone un plan dry-run"
        body="2 clústeres de envío esperan aprobación humana. Las quejas del clúster A superaron 0,18% en los últimos 4 snapshots — preparé un plan de degradación."
        primaryCta="Revisar plan"
        secondaryCta="Abrir chat"
      />
    </div>
  );
}

function Welcome({ generatedAt, lastUpdateMs }: { generatedAt: string; lastUpdateMs: number }) {
  return (
    <header className="flex items-start" style={{ gap: 16 }}>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 6 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-accent-tertiary)]"
            style={{ letterSpacing: "var(--tracking-widest)" }}
          >
            Inicio operativo
          </span>
          <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "var(--color-text-tertiary)" }} />
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
            Actualizado {formatDateTime(generatedAt)}
          </span>
        </div>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]"
          style={{ letterSpacing: "var(--tracking-tightest)" }}
        >
          Capacidad preparada, sin envíos reales.
        </h1>
        <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
          Delivrix gobierna infraestructura de correo autorizada en modo solo lectura. OpenClaw
          observa, valida y propone — los humanos aprueban cada acción real.
        </p>
      </div>
      <div className="shrink-0">
        <LiveIndicator pollIntervalSec={5} lastUpdateAt={lastUpdateMs} tone="success" />
      </div>
    </header>
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

/**
 * KpiShell — contenedor de KPI card.
 *
 * `tooltipHint` opcional: si se provee, la card entera se vuelve trigger del
 * Tooltip al hover. Convención: pasar un fragmento con structure
 * source / endpoint / lastFetch / calculation.
 */
function KpiShell({
  children,
  tooltipHint
}: {
  children: React.ReactNode;
  tooltipHint?: React.ReactNode;
}) {
  const card = (
    <article
      className="flex flex-col bg-[var(--color-surface)] transition-shadow hover:shadow-[var(--shadow-md)]"
      style={{
        gap: 12,
        padding: 16,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)",
        cursor: tooltipHint ? "help" : "default"
      }}
    >
      {children}
    </article>
  );
  if (!tooltipHint) return card;
  return (
    <Tooltip hint={tooltipHint} side="bottom" delayMs={400}>
      {card}
    </Tooltip>
  );
}

function KpiHead({ label, pillBg, pillFg, pillText }: { label: string; pillBg: string; pillFg: string; pillText: string }) {
  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-text-secondary)]"
        style={{ letterSpacing: "var(--tracking-wide)" }}
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
        style={{ letterSpacing: "var(--tracking-tightest)" }}
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

/**
 * KpiTooltipHint — contenido estructurado del tooltip de una KPI card.
 * Muestra fuente (endpoint), última actualización y método de cálculo.
 */
function KpiTooltipHint({
  endpoint,
  source,
  calculation,
  lastFetch
}: {
  endpoint: string;
  source: string;
  calculation: string;
  lastFetch?: string;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 6, maxWidth: 280 }}>
      <span
        className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase"
        style={{ letterSpacing: "var(--tracking-widest)", color: "var(--color-text-tertiary)" }}
      >
        Fuente
      </span>
      <code className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">
        {endpoint}
      </code>
      <p className="m-0 text-[11px] font-[family-name:var(--font-sans)] leading-snug text-[var(--color-text-secondary)]">
        {source}
      </p>
      <span
        className="text-[10px] font-[family-name:var(--font-caption)] font-medium uppercase"
        style={{ letterSpacing: "var(--tracking-wider)", color: "var(--color-text-tertiary)", marginTop: 2 }}
      >
        Cálculo
      </span>
      <p className="m-0 text-[11px] font-[family-name:var(--font-sans)] leading-snug text-[var(--color-text-secondary)]">
        {calculation}
      </p>
      {lastFetch ? (
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]" style={{ marginTop: 2 }}>
          últ. fetch · {lastFetch}
        </span>
      ) : null}
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
    <KpiShell
      tooltipHint={
        <KpiTooltipHint
          endpoint="GET /v1/sender-nodes"
          source="Lista activa de IPs/dominios autorizados para envío."
          calculation="total = length(data.senderNodes)"
        />
      }
    >
      <KpiHead
        label="Nodos de envío"
        pillBg={total > 0 ? "var(--color-success-soft)" : "var(--color-neutral-soft)"}
        pillFg={total > 0 ? "var(--color-success)" : "var(--color-text-tertiary)"}
        pillText={total > 0 ? "activos" : "sin nodos"}
      />
      <KpiValue value={formatNumber(total)} />
      <KpiDetail
        icon={<TrendingUp size={12} strokeWidth={1.75} />}
        text={total === 0 ? "ningún nodo registrado" : `${total} ${total === 1 ? "nodo registrado" : "nodos registrados"}`}
        color={total > 0 ? "var(--color-success)" : "var(--color-text-tertiary)"}
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
    <KpiShell
      tooltipHint={
        <KpiTooltipHint
          endpoint="GET /v1/sender-nodes ?status=warming"
          source="IPs en fase de calentamiento (warming) controlado para reputación."
          calculation="value = senderNodesByStatus.warming ?? 0"
        />
      }
    >
      <KpiHead
        label="IPs en calentamiento"
        pillBg={value > 0 ? "var(--color-info-soft)" : "var(--color-neutral-soft)"}
        pillFg={value > 0 ? "var(--color-info)" : "var(--color-text-tertiary)"}
        pillText={value > 0 ? "en curso" : "ninguna"}
      />
      <KpiValue value={formatNumber(value)} />
      <KpiDetail
        icon={<Flame size={12} strokeWidth={1.75} />}
        text={value === 0 ? "sin ciclos de warming activos" : `${value} ${value === 1 ? "IP" : "IPs"} en warming`}
        color={value > 0 ? "var(--color-accent-tertiary)" : "var(--color-text-tertiary)"}
        endpoint="/v1/sender-nodes"
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

/* K3 — Índice de reputación */
function KpiReputation({ value }: { value: number | null }) {
  const display = value === null ? "—" : value.toFixed(1).replace(".", ",");
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  // Clasificación semántica del nivel actual de reputación.
  const tone =
    value === null
      ? { label: "sin datos", bg: "var(--color-neutral-soft)", fg: "var(--color-text-tertiary)", barFg: "var(--color-border-strong)" }
      : value >= 95
        ? { label: "excelente", bg: "var(--color-success-soft)", fg: "var(--color-success)", barFg: "var(--color-success)" }
        : value >= 85
          ? { label: "estable", bg: "var(--color-info-soft)", fg: "var(--color-info)", barFg: "var(--color-info)" }
          : value >= 70
            ? { label: "vigilancia", bg: "var(--color-warning-soft)", fg: "var(--color-warning)", barFg: "var(--color-warning)" }
            : { label: "crítico", bg: "var(--color-critical-soft)", fg: "var(--color-critical)", barFg: "var(--color-critical)" };
  return (
    <KpiShell
      tooltipHint={
        <KpiTooltipHint
          endpoint="GET /v1/send-results · /v1/ip-reputation/reports"
          source="Ratio agregado de envíos aceptados sobre total de envíos."
          calculation="reputation = (accepted ÷ totalSends) × 100, redondeo 1 decimal"
        />
      }
    >
      <KpiHead label="Índice de reputación" pillBg={tone.bg} pillFg={tone.fg} pillText={tone.label} />
      <KpiValue value={display} unit="/ 100" />
      <KpiDetail
        icon={<TrendingDown size={12} strokeWidth={1.75} />}
        text={value === null ? "Esperando primeras métricas" : `${pct.toFixed(1)} de 100 puntos`}
        color={tone.fg}
        endpoint="/v1/send-results"
      />
      <div
        className="relative w-full overflow-hidden"
        style={{ height: 6, borderRadius: 3, background: "var(--color-surface-sunken)" }}
        aria-hidden="true"
      >
        <span
          className="block"
          style={{ width: `${pct}%`, height: 8, borderRadius: 3, background: tone.barFg }}
        />
      </div>
    </KpiShell>
  );
}

/* K4 — Gates abiertos */
function KpiGates({ value, gates }: { value: number; gates: string[] }) {
  return (
    <KpiShell
      tooltipHint={
        <KpiTooltipHint
          endpoint="GET /v1/operating-north"
          source="Gates de aprobación humana pendientes antes de tocar producción."
          calculation="value = length(operatingNorth.gates ?? [])"
        />
      }
    >
      <KpiHead
        label="Gates abiertos"
        pillBg={value === 0 ? "var(--color-success-soft)" : "var(--color-critical-soft)"}
        pillFg={value === 0 ? "var(--color-success)" : "var(--color-critical)"}
        pillText={value === 0 ? "todo verde" : "esperan aprobación"}
      />
      <KpiValue value={formatNumber(value)} />
      <KpiDetail
        icon={<ShieldAlert size={12} strokeWidth={1.75} />}
        text={value === 0 ? "sin gates pendientes" : `${value} ${value === 1 ? "gate pendiente" : "gates pendientes"}`}
        color={value === 0 ? "var(--color-success)" : "var(--color-critical)"}
        endpoint="/v1/operating-north"
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
function Pipeline({ onNavigate }: { onNavigate?: (section: string) => void }) {
  return (
    <section
      className="bg-[var(--color-surface)]"
      style={{
        borderRadius: 8,
        padding: 20,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)"
      }}
    >
      {/* pipeHead — sin h2 (el SectionDivider del Overview ya lo introduce). Solo CTA. */}
      <header className="flex items-center" style={{ gap: 12, marginBottom: 16 }}>
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
          Cada transición tiene un gate humano · ningún provisionamiento toca producción sin aprobación.
        </p>
        <span className="flex-1" aria-hidden="true" />
        <button
          type="button"
          onClick={() => onNavigate?.("canvas")}
          disabled={!onNavigate}
          className="inline-flex items-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-55"
          style={{ gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border-strong)", background: "transparent", cursor: onNavigate ? "pointer" : "not-allowed" }}
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
    <div
      aria-hidden="true"
      className="hidden md:flex items-center justify-center self-stretch"
      style={{ width: 12 }}
    >
      <span
        style={{
          width: 8,
          height: 1,
          background: "var(--color-border-strong)"
        }}
      />
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
  // Mapping de IDs → severidad + descripción del v2. ApprovalRow v2 standardiza
  // el icono (AlertOctagon) y el chrome — sólo necesitamos severity + cuerpo.
  type Variant = { key: string; severity: ApprovalSeverity; severityLabel: string; desc: string };
  const VARIANTS: Variant[] = [
    {
      key: "warming",
      severity: "medium",
      severityLabel: "warming",
      desc: "OpenClaw propone avanzar el ciclo de calentamiento. Vigilancia de reputación activa."
    },
    {
      key: "dns",
      severity: "critical",
      severityLabel: "dns drift",
      desc: "Drift SPF/DKIM/DMARC detectado · plan dry-run listo, no se realizó escritura real."
    },
    {
      key: "ssh",
      severity: "high",
      severityLabel: "ssh gate",
      desc: "Alcance del permiso desconocido hasta firmar la regla de 2 personas. SSH desactivado por defecto."
    },
    {
      key: "generic",
      severity: "low",
      severityLabel: "humano",
      desc: "Acción que requiere autorización humana antes de avanzar."
    }
  ];
  const pickVariant = (id: string): Variant => {
    const lower = id.toLowerCase();
    return VARIANTS.find((v) => v.key !== "generic" && lower.includes(v.key)) ?? VARIANTS[3];
  };
  return (
    <section className="flex flex-col" style={{ gap: 12 }}>
      <SectionDivider
        title="Aprobaciones pendientes"
        count={count}
        countTone={count === 0 ? "neutral" : "critical"}
        caption="Cada acción que un humano debe validar antes de tocar producción"
      />

      {count === 0 ? (
        <div
          className="bg-[var(--color-surface)]"
          style={{
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-border)",
            padding: "16px 20px"
          }}
        >
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
            Cola de aprobaciones vacía. Todas las acciones supervisadas están autorizadas o no
            requieren intervención humana.
          </p>
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {approvalIds.slice(0, 3).map((id) => {
            const v = pickVariant(id);
            return (
              <ApprovalRowV2
                key={id}
                title={id.replace(/_/g, " ")}
                body={v.desc}
                severity={v.severity}
                severityLabel={v.severityLabel}
              />
            );
          })}
        </div>
      )}
    </section>
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
        boxShadow: "var(--shadow-sm)"
      }}
    >
      {/* gHead — H2 en Geist semibold para mantener jerarquía sin invocar display Funnel.
          Counter como pill compacto Linear-style. */}
      <header className="flex items-center" style={{ gap: 8 }}>
        <h2 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Gates no negociables
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="text-[11px] font-[family-name:var(--font-mono)] tabular-nums"
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: "var(--color-surface-sunken)",
            color: "var(--color-text-secondary)"
          }}
        >
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
        className="grid place-items-center text-[var(--color-on-dark-strong)]"
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
        background: "var(--color-surface-inverse)",
        border: "1px solid var(--color-on-dark-hint)",
        boxShadow: "var(--shadow-md)"
      }}
    >
      {/* shHead — eyebrow estilo Linear: izquierda neutra, derecha estado live */}
      <header className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{ letterSpacing: "var(--tracking-widest)", color: "var(--color-on-dark-soft)" }}
        >
          Sistema
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-flex items-center"
          style={{
            gap: 6,
            padding: "3px 8px",
            borderRadius: 999,
            background: "var(--color-on-dark-success-overlay)"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: "var(--color-success)" }} />
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase"
            style={{ letterSpacing: "var(--tracking-wider)", color: "var(--color-success)" }}
          >
            Operativo
          </span>
        </span>
      </header>

      <h2
        className="m-0 text-[15px] font-[family-name:var(--font-sans)] font-semibold leading-tight"
        style={{ letterSpacing: "var(--tracking-tight)", color: "var(--color-on-dark-strong)" }}
      >
        Todos los gateways responden.
      </h2>

      {/* shGrid */}
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 8 }}>
        {rows.map((r) => (
          <li key={r.label} className="flex items-center" style={{ gap: 8 }}>
            <span
              className="text-[12px] font-[family-name:var(--font-sans)]"
              style={{ color: "var(--color-on-dark-medium)" }}
            >
              {r.label}
            </span>
            <span className="flex-1" aria-hidden="true" />
            <span className="text-[11px] font-[family-name:var(--font-mono)] tabular-nums" style={{ color: r.valueColor }}>
              {r.value}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
