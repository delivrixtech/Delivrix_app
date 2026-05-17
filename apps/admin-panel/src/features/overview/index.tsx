/**
 * Overview Dashboard — port 1:1 desde Pencil frame `e1ashz`.
 *
 * Valores literales (colores, paddings, font-weights) en
 * DOCUMENTACION/pencil-dumps/01_overview_spec.md. La estructura es:
 *
 *   Header row:  Welcome (598w)  ·  OpenClaw prompt (gradient-bordered 523w)
 *   KPI row:     4 cards (Sender nodes / Warming / Reputation / Gates)
 *   Pipeline:    5 stage cards tonal + connectors
 *   Bottom row:  Activity & approvals (flex)  ·  Side pane 380w (Gates + System health dark)
 *
 * Los textos vienen del contrato; los valores que Pencil hardcodea (148/42/94,2/3)
 * se reemplazan por counts reales del payload manteniendo el formato visual.
 */

import {
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Flame,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatDateTime,
  formatNumber
} from "../../shared/lib/formatters.ts";

export function OverviewSection({ data }: { data: DashboardData }) {
  const summary = data.overview.summary;
  const sender = summary.senderNodesByStatus ?? {};
  const sendResults = summary.sendResultsByStatus ?? {};

  const senderNodesTotal =
    (sender.active ?? 0) +
    (sender.warming ?? 0) +
    (sender.quarantined ?? 0) +
    (sender.standby ?? 0) +
    (sender.retired ?? 0);
  const senderActive = sender.active ?? 0;
  const ipsWarming = sender.warming ?? 0;

  const sendTotal = Object.values(sendResults).reduce((a, b) => a + b, 0);
  const sendOk = sendResults.sent ?? sendResults.delivered ?? 0;
  const acceptedPct = sendTotal === 0 ? 0 : Math.round((sendOk / sendTotal) * 1000) / 10;
  const reputationIndex = acceptedPct === 0 ? 0 : Math.min(100, Math.round(acceptedPct * 10) / 10);

  const gatesOpen = data.operatingNorth.gates?.length ?? 0;
  const approvals = data.canvas.requiresHumanApproval ?? [];
  const timeline = data.canvas.timeline ?? [];

  return (
    <section
      className="flex flex-col gap-5"
      style={{ maxWidth: 1352 }}
    >
      {/* Header row: Welcome + OpenClaw prompt */}
      <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,598px)_minmax(0,523px)] items-start">
        <Welcome data={data} />
        <OpenClawPromptCard data={data} />
      </div>

      {/* KPI row */}
      <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <KpiSenderNodes value={senderNodesTotal} activeDelta={senderActive} />
        <KpiWarming value={ipsWarming} />
        <KpiReputation value={reputationIndex} />
        <KpiGates value={gatesOpen} gates={data.operatingNorth.gates ?? []} />
      </div>

      {/* Pipeline */}
      <Pipeline data={data} />

      {/* Bottom row */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
        <ActivityApprovalsCard approvals={approvals} timeline={timeline} />
        <SidePane data={data} />
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Welcome
 * ------------------------------------------------------------------------ */
function Welcome({ data }: { data: DashboardData }) {
  const lastFetched = formatDateTime(data.overview.generatedAt);
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          INICIO OPERATIVO
        </span>
        <span aria-hidden="true" className="h-1 w-1 rounded-[2px] bg-[#8A8073]" />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Actualizado {lastFetched}
        </span>
      </div>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Capacidad preparada, sin envíos reales.
      </h1>
      <p className="m-0 mt-1 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Delivrix gobierna infraestructura de correo autorizada en modo solo lectura.
        OpenClaw observa, valida y propone — los humanos aprueban cada acción real.
      </p>
    </header>
  );
}

/* --------------------------------------------------------------------------
 * OpenClaw prompt — gradient border wrapper
 * ------------------------------------------------------------------------ */
function OpenClawPromptCard({ data }: { data: DashboardData }) {
  const approvals = data.canvas.requiresHumanApproval ?? [];
  const message =
    approvals.length > 0
      ? `${formatNumber(approvals.length)} aprobaciones humanas esperan revisión. Las quejas observadas y los blockers actuales del canvas alimentan mi propuesta.`
      : "Sin aprobaciones humanas en cola. Puedo proponer la siguiente acción supervisada cuando lo necesites.";

  return (
    <div
      className="rounded-[12px] p-[2px]"
      style={{
        background:
          "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
        boxShadow: "0 6px 18px rgba(146, 64, 14, 0.13)"
      }}
    >
      <div
        className="flex flex-col gap-3 rounded-[10px] bg-[#FFFFFF]"
        style={{ padding: 16 }}
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 place-items-center rounded-[8px] text-[#FFFBF5]"
            style={{
              background:
                "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)"
            }}
          >
            <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
              OpenClaw
            </span>
            <span
              className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]"
              style={{ letterSpacing: "0.4px" }}
            >
              Operador supervisado
            </span>
          </div>
          <span className="flex-1" aria-hidden="true" />
          <span
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-[#EAE0CE] bg-[#F7F2EA] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-semibold text-[#5C544A]"
            style={{ letterSpacing: "0.4px" }}
          >
            read-only
          </span>
        </div>
        <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#1A1410]">
          {message}
        </p>
        <div
          aria-hidden="true"
          className="flex items-center gap-2 rounded-[8px] border border-[#EAE0CE] bg-[#F7F2EA] px-3 py-2.5"
        >
          <span className="flex-1 text-[12px] font-[family-name:var(--font-sans)] text-[#8A8073]">
            Responde a OpenClaw…
          </span>
          <ArrowUp size={14} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-[#1A1410] px-3 py-2 text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5] disabled:cursor-default disabled:opacity-100"
          >
            <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            Sugerir siguiente paso
          </button>
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
            interacción real vive fuera del panel
          </span>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * KPI cards (4 variants)
 * ------------------------------------------------------------------------ */
function KpiShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 16, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      {children}
    </div>
  );
}

function KpiHead({
  label,
  pillTone,
  pillText
}: {
  label: string;
  pillTone: "success" | "info" | "warning" | "critical";
  pillText: string;
}) {
  const pillBg =
    pillTone === "success"
      ? "#DCFCE7"
      : pillTone === "info"
        ? "#DBEAFE"
        : pillTone === "warning"
          ? "#FEF3C7"
          : "#FEE2E2";
  const pillFg =
    pillTone === "success"
      ? "#15803D"
      : pillTone === "info"
        ? "#1D4ED8"
        : pillTone === "warning"
          ? "#B45309"
          : "#B91C1C";
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#5C544A]"
        style={{ letterSpacing: "0.4px" }}
      >
        {label}
      </span>
      <span className="flex-1" aria-hidden="true" />
      <span
        className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
        style={{ background: pillBg, color: pillFg }}
      >
        {pillText}
      </span>
    </div>
  );
}

function KpiValue({ value, unit }: { value: string; unit?: string }) {
  return (
    <div className="flex items-end gap-2">
      <span
        className="text-[32px] font-[family-name:var(--font-mono)] font-bold leading-none text-[#1A1410] tabular-nums"
        style={{ letterSpacing: "-0.6px" }}
      >
        {value}
      </span>
      {unit ? (
        <span className="text-[14px] font-[family-name:var(--font-mono)] text-[#8A8073] leading-none">
          {unit}
        </span>
      ) : null}
    </div>
  );
}

function KpiDetail({
  icon,
  text,
  textColor,
  endpoint
}: {
  icon: React.ReactNode;
  text: string;
  textColor: string;
  endpoint: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span style={{ color: textColor }} aria-hidden="true">
        {icon}
      </span>
      <span
        className="text-[11px] font-[family-name:var(--font-mono)] font-semibold"
        style={{ color: textColor }}
      >
        {text}
      </span>
      <span className="flex-1" aria-hidden="true" />
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
        {endpoint}
      </span>
    </div>
  );
}

function KpiSenderNodes({ value, activeDelta }: { value: number; activeDelta: number }) {
  // Sparkline 8 bars con tonal escalonado.
  const bars = [
    { h: 18, op: 0.35, color: "#FACC15" },
    { h: 24, op: 0.45, color: "#FACC15" },
    { h: 20, op: 0.4, color: "#FACC15" },
    { h: 28, op: 0.55, color: "#F59E0B" },
    { h: 30, op: 0.7, color: "#F59E0B" },
    { h: 24, op: 0.6, color: "#F59E0B" },
    { h: 32, op: 0.8, color: "#EA580C" },
    { h: 36, op: 1.0, color: "#EA580C" }
  ];
  return (
    <KpiShell>
      <KpiHead
        label="Nodos de envío"
        pillTone="success"
        pillText={`${activeDelta > 0 ? "+" : ""}${formatNumber(activeDelta)} activos`}
      />
      <KpiValue value={formatNumber(value)} />
      <KpiDetail
        icon={<TrendingUp size={12} strokeWidth={1.75} />}
        text={activeDelta > 0 ? "operación activa" : "sin tráfico"}
        textColor="#15803D"
        endpoint="/v1/admin/overview"
      />
      <div className="flex items-end gap-[3px] h-9 w-full">
        {bars.map((b, i) => (
          <span
            key={i}
            className="flex-1 rounded-[2px]"
            style={{ height: b.h, background: b.color, opacity: b.op }}
            aria-hidden="true"
          />
        ))}
      </div>
    </KpiShell>
  );
}

function KpiWarming({ value }: { value: number }) {
  return (
    <KpiShell>
      <KpiHead
        label="IPs en calentamiento"
        pillTone="info"
        pillText={value > 0 ? `día ${formatNumber(value)} / 28 prom` : "sin warming"}
      />
      <KpiValue value={formatNumber(value)} />
      <KpiDetail
        icon={<Flame size={12} strokeWidth={1.75} />}
        text="warming activo"
        textColor="#EA580C"
        endpoint="/v1/admin/overview"
      />
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-[3px] bg-[#F7F2EA]"
        aria-hidden="true"
      >
        <div className="flex h-full gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="rounded-[3px]"
              style={{
                width: 48,
                height: "100%",
                background:
                  "linear-gradient(90deg, #FACC15 0%, #EA580C 100%)"
              }}
            />
          ))}
        </div>
      </div>
    </KpiShell>
  );
}

function KpiReputation({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const trendDown = value < 95;
  return (
    <KpiShell>
      <KpiHead
        label="Índice de reputación"
        pillTone={trendDown ? "warning" : "success"}
        pillText={trendDown ? "warning" : "ok"}
      />
      <KpiValue value={value.toFixed(1).replace(".", ",")} unit="/ 100" />
      <KpiDetail
        icon={trendDown ? <TrendingDown size={12} strokeWidth={1.75} /> : <TrendingUp size={12} strokeWidth={1.75} />}
        text={trendDown ? "tendencia a la baja" : "tendencia al alza"}
        textColor={trendDown ? "#B45309" : "#15803D"}
        endpoint="/v1/admin/overview"
      />
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-[3px] bg-[#F7F2EA]"
        aria-hidden="true"
      >
        <span
          className="block h-2 rounded-[3px]"
          style={{ width: `${pct}%`, background: "#B45309" }}
        />
      </div>
    </KpiShell>
  );
}

function KpiGates({ value, gates }: { value: number; gates: string[] }) {
  return (
    <KpiShell>
      <KpiHead
        label="Gates abiertos"
        pillTone={value === 0 ? "success" : "critical"}
        pillText={value === 0 ? "cumplidos" : "espera aprobación"}
      />
      <KpiValue value={formatNumber(value)} />
      <KpiDetail
        icon={<ShieldAlert size={12} strokeWidth={1.75} />}
        text={value === 0 ? "sin pendientes" : "espera aprobación"}
        textColor={value === 0 ? "#15803D" : "#B91C1C"}
        endpoint="/v1/operating-north"
      />
      <div className="flex flex-wrap gap-1.5">
        {gates.slice(0, 3).map((gate) => (
          <span
            key={gate}
            className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] text-[#B91C1C]"
            style={{ background: "#FEE2E2" }}
          >
            {compactLabel(gate)}
          </span>
        ))}
        {value === 0 ? (
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
            cola limpia
          </span>
        ) : null}
      </div>
    </KpiShell>
  );
}

/* --------------------------------------------------------------------------
 * Pipeline — 5 stage cards + 4 connectors
 * ------------------------------------------------------------------------ */
type StageVariant = "success" | "in_progress" | "warning" | "neutral";

interface StageDef {
  key: string;
  title: string;
  body: string;
  footer: string;
  variant: StageVariant;
}

function deriveStages(data: DashboardData): StageDef[] {
  const onboarding = data.onboardingState;
  const blockers = onboarding.blockers.length;
  const warnings = onboarding.warnings.length;
  const sender = data.overview.summary.senderNodesByStatus ?? {};
  const warming = sender.warming ?? 0;
  const quarantined = sender.quarantined ?? 0;
  const approvals = data.canvas.requiresHumanApproval?.length ?? 0;

  const onboardingVariant: StageVariant =
    blockers > 0 ? "warning" : warnings > 0 ? "in_progress" : onboarding.canGenerateTopologyPlan ? "success" : "neutral";

  const planningVariant: StageVariant = onboarding.canGenerateTopologyPlan
    ? "success"
    : blockers > 0
      ? "neutral"
      : "in_progress";

  const provisioningVariant: StageVariant =
    data.provisioningState.dryRunArtifacts.length > 0 ? "in_progress" : "neutral";

  const warmingVariant: StageVariant =
    approvals > 0 ? "warning" : warming > 0 ? "in_progress" : "neutral";

  const reputationVariant: StageVariant = quarantined > 0 ? "warning" : "neutral";

  return [
    {
      key: "onboarding",
      title: "Onboarding",
      body:
        blockers > 0
          ? `${formatNumber(blockers)} bloqueos abiertos`
          : "Servidor, IPs y dominios capturados",
      footer:
        blockers > 0
          ? `${formatNumber(blockers)} requieren operador`
          : `${formatNumber(Object.keys(onboarding.knownInputs).length)} campos capturados`,
      variant: onboardingVariant
    },
    {
      key: "planning",
      title: "Planificación",
      body: onboarding.canGenerateTopologyPlan
        ? "Plan de topología generado dry-run"
        : "Esperando captura completa",
      footer: "/v1/clusters/plan",
      variant: planningVariant
    },
    {
      key: "provisioning",
      title: "Provisionamiento",
      body: `${formatNumber(data.provisioningState.dryRunArtifacts.length)} artefactos dry-run`,
      footer: `${formatNumber(data.provisioningState.requiredApprovals.length)} aprobaciones req.`,
      variant: provisioningVariant
    },
    {
      key: "warming",
      title: "Calentamiento",
      body: `${formatNumber(warming)} IPs en warming`,
      footer:
        approvals > 0
          ? `${formatNumber(approvals)} esperan aprobación`
          : "sin aprobaciones",
      variant: warmingVariant
    },
    {
      key: "reputation",
      title: "Reputación",
      body: "Observadores listos · tráfico simulado",
      footer: "sin envíos reales en el MVP",
      variant: reputationVariant
    }
  ];
}

function Pipeline({ data }: { data: DashboardData }) {
  const stages = deriveStages(data);
  return (
    <section
      className="flex flex-col gap-4 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-start gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Flujo operativo
          </h2>
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[#5C544A]">
            Onboarding → planificación → provisionamiento dry-run → calentamiento → reputación.
            Cada transición tiene un gate humano.
          </p>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          aria-hidden="true"
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#D4C5A8] px-2.5 py-1.5 text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]"
        >
          GET-only
          <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
        </span>
      </header>

      <ol className="m-0 p-0 list-none flex items-stretch gap-0 w-full">
        {stages.map((stage, i) => {
          const styles = stageStyles(stage.variant);
          return (
            <li key={stage.key} className="flex items-stretch flex-1 min-w-0">
              <div
                className="flex flex-col gap-2.5 rounded-[8px] flex-1 border"
                style={{
                  padding: 14,
                  background: styles.bg,
                  borderColor: styles.border
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="block h-1.5 w-1.5 rounded-[3px]"
                    style={{ background: styles.border }}
                  />
                  <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
                    {stage.title}
                  </span>
                </div>
                <p
                  className="m-0 text-[11px] font-[family-name:var(--font-sans)] leading-[1.4] text-[#1A1410]"
                >
                  {stage.body}
                </p>
                <p
                  className="m-0 text-[10px] font-[family-name:var(--font-mono)] font-medium"
                  style={{ color: styles.footerFg }}
                >
                  {stage.footer}
                </p>
              </div>
              {i < stages.length - 1 ? (
                <div className="flex items-center" style={{ width: 18 }}>
                  <ChevronRight
                    size={14}
                    strokeWidth={1.75}
                    className="text-[#8A8073] mx-auto"
                    aria-hidden="true"
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function stageStyles(variant: StageVariant) {
  switch (variant) {
    case "success":
      return { bg: "#DCFCE7", border: "#15803D", footerFg: "#15803D" };
    case "in_progress":
      return {
        bg: "linear-gradient(135deg, rgba(250, 204, 21, 0.2) 0%, rgba(234, 88, 12, 0.2) 100%)",
        border: "#EA580C",
        footerFg: "#EA580C"
      };
    case "warning":
      return { bg: "#FEF3C7", border: "#B45309", footerFg: "#B45309" };
    case "neutral":
    default:
      return { bg: "#F5F5F4", border: "#EAE0CE", footerFg: "#5C544A" };
  }
}

/* --------------------------------------------------------------------------
 * Activity & approvals card
 * ------------------------------------------------------------------------ */
function ActivityApprovalsCard({
  approvals,
  timeline
}: {
  approvals: string[];
  timeline: DashboardData["canvas"]["timeline"];
}) {
  const count = approvals.length;
  return (
    <section
      className="flex flex-col rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header
        className="flex items-center gap-3 border-b border-[#EAE0CE]"
        style={{ paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 14 }}
      >
        <div className="flex flex-col gap-0.5 min-w-0">
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[#EA580C]"
            style={{ letterSpacing: "1.2px" }}
          >
            COLA HUMANA
          </span>
          <h2 className="m-0 text-[15px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Aprobaciones y actividad reciente
          </h2>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block rounded-[4px] px-2 py-1 text-[11px] font-[family-name:var(--font-caption)] font-bold"
          style={{ background: "#FEE2E2", color: "#B91C1C" }}
        >
          {formatNumber(count)} en cola
        </span>
      </header>

      <ul className="m-0 p-0 list-none flex flex-col">
        {approvals.length === 0 ? (
          <li className="px-4 py-4 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
            Sin aprobaciones humanas pendientes.
          </li>
        ) : (
          approvals.slice(0, 4).map((approvalId, i) => (
            <li
              key={approvalId}
              className={`flex items-center gap-3 ${
                i < Math.min(approvals.length, 4) - 1 ? "border-b border-[#EAE0CE]" : ""
              }`}
              style={{ paddingLeft: 18, paddingRight: 18, paddingTop: 14, paddingBottom: 14 }}
            >
              <span
                aria-hidden="true"
                className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-[family-name:var(--font-heading)] font-bold text-[#FFFBF5]"
                style={{
                  background:
                    "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)"
                }}
              >
                H
              </span>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410] truncate">
                  {compactLabel(approvalId)}
                </span>
                <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
                  esperando aprobación humana
                </span>
              </div>
              <ChevronRight size={14} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
            </li>
          ))
        )}
      </ul>

      {timeline.length > 0 ? (
        <div
          className="border-t border-[#EAE0CE]"
          style={{ paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 14 }}
        >
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
            style={{ letterSpacing: "1.2px" }}
          >
            Actividad reciente
          </span>
          <ul className="m-0 mt-2 p-0 list-none flex flex-col gap-2">
            {timeline.slice(0, 3).map((event) => (
              <li key={event.id} className="flex items-center gap-2 text-[11px] font-[family-name:var(--font-mono)]">
                <span
                  className="text-[#5C544A] tabular-nums"
                  style={{ minWidth: 110 }}
                >
                  {formatDateTime(event.occurredAt)}
                </span>
                <span className="text-[#1A1410] flex-1 truncate">{event.action}</span>
                <span className="text-[#8A8073]">{event.actor}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Side pane: Gates card + System health dark
 * ------------------------------------------------------------------------ */
function SidePane({ data }: { data: DashboardData }) {
  const gates = data.operatingNorth.gates ?? [];
  return (
    <div className="flex flex-col gap-4">
      <GatesCard gates={gates} />
      <SystemHealthDark data={data} />
    </div>
  );
}

function GatesCard({ gates }: { gates: string[] }) {
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 18, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Gates por cumplir
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ background: "#FEF3C7", color: "#B45309" }}
        >
          {formatNumber(gates.length)}
        </span>
      </header>
      {gates.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Sin gates pendientes.
        </p>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {gates.slice(0, 5).map((gate) => (
            <li
              key={gate}
              className="flex items-center gap-2 rounded-[6px] border border-[#EAE0CE] bg-[#F7F2EA] px-3 py-2"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-[3px] bg-[#B45309]"
              />
              <span className="text-[12px] font-[family-name:var(--font-mono)] text-[#1A1410] truncate flex-1">
                {gate}
              </span>
            </li>
          ))}
          {gates.length > 5 ? (
            <li className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073] px-3">
              + {formatNumber(gates.length - 5)} más
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function SystemHealthDark({ data }: { data: DashboardData }) {
  const ok = data.health.status === "ok";
  const rows: Array<[string, string]> = [
    ["service", data.health.service],
    ["phase", data.health.phase],
    ["infra writes", data.health.operatingNorth.liveInfrastructureWritesEnabled ? "enabled" : "disabled"],
    ["smtp real", data.health.operatingNorth.delivrixSendsRealEmail ? "enabled" : "disabled"],
    ["nfc writes", data.health.operatingNorth.nfcProductionWritesEnabled ? "enabled" : "disabled"]
  ];
  return (
    <section
      className="flex flex-col gap-3.5 rounded-[8px] bg-[#1A1410]"
      style={{ padding: 18, boxShadow: "0 6px 18px rgba(0, 0, 0, 0.13)" }}
    >
      <header className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full"
          style={{ background: ok ? "#4ADE80" : "#F87171" }}
        />
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{ color: ok ? "#86EFAC" : "#FECACA", letterSpacing: "1.2px" }}
        >
          {ok ? "Saludable" : "Atención"}
        </span>
      </header>
      <h2
        className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-semibold leading-tight text-[#FFFBF5]"
        style={{ letterSpacing: "-0.2px" }}
      >
        {ok ? "Todos los gateways responden." : "Hay gateways en alerta."}
      </h2>
      <dl className="m-0 flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 text-[11px] font-[family-name:var(--font-mono)]">
            <dt className="m-0 text-[#FFFBF5] opacity-60">{k}</dt>
            <dd className="m-0 text-[#FACC15]">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
