/**
 * Onboarding Wizard — port 1:1 desde Pencil frame `T9osf` / `GygQG`.
 *
 * Estructura literal:
 *   PageHeader (M5gN0)  ·  Stepper de 6 pasos horizontales (cL78x)
 *   WizardBody (uqjXO):
 *     · Form (IZ1we) — 3 SectionCards con field rows (Identidad, Inventario, Red)
 *     · OpenClawColumn (vBXlY, 360w) — gradient prompt card + meta card
 *   GatesHead + GatesStrip (3 gate cards horizontales)
 *   ActionBar — save + tooltip + back + submit
 *
 * Valores literales: padding, color, gap exactos del .pen.
 */

import {
  ArrowLeft,
  ArrowUp,
  Info,
  KeyRound,
  Lock,
  Save,
  Send,
  ShieldAlert,
  ShieldX,
  Sparkles,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import { compactLabel, formatNumber, humanize } from "../../shared/lib/formatters.ts";

/* --------------------------------------------------------------------------
 * Canonical steps (Pencil cL78x)
 * ------------------------------------------------------------------------ */
const STEPS = [
  { kicker: "PASO 1", title: "Servidor", category: "server" },
  { kicker: "PASO 2", title: "IPs y dominios", category: "network" },
  { kicker: "PASO 3", title: "DNS", category: "dns" },
  { kicker: "PASO 4", title: "Límites", category: "limits" },
  { kicker: "PASO 5", title: "Cumplimiento", category: "compliance" },
  { kicker: "PASO 6", title: "Revisión", category: "review" }
] as const;

type StepStatus = "active" | "ready" | "pending" | "blocked";

function deriveStepStatus(
  category: string,
  readinessByCategory: Record<string, number>,
  blockers: string[]
): StepStatus {
  const normalized = category.toLowerCase();
  const blocker = blockers.some((b) => b.toLowerCase().includes(normalized));
  if (blocker) return "blocked";
  const readiness = Object.entries(readinessByCategory).find(
    ([k]) => k.toLowerCase().includes(normalized)
  )?.[1];
  if (readiness === undefined) return "pending";
  if (readiness >= 1) return "ready";
  if (readiness > 0) return "active";
  return "pending";
}

/* --------------------------------------------------------------------------
 * Main section
 * ------------------------------------------------------------------------ */
export function OnboardingSection({ data }: { data: DashboardData }) {
  const onboarding = data.onboardingState;
  const blockers = onboarding.blockers ?? [];
  const warnings = onboarding.warnings ?? [];
  const stepStatuses = STEPS.map((step) =>
    deriveStepStatus(step.category, onboarding.readinessByCategory, blockers)
  );
  const activeIndex = Math.max(0, stepStatuses.findIndex((s) => s === "active" || s === "pending" || s === "blocked"));

  return (
    <section className="flex flex-col gap-5" style={{ maxWidth: 1352 }}>
      <PageHeader activeIndex={activeIndex} />
      <Stepper statuses={stepStatuses} activeIndex={activeIndex} />

      <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
        <Form data={data} />
        <OpenClawColumn blockers={blockers} warnings={warnings} canGenerate={onboarding.canGenerateTopologyPlan} />
      </div>

      <GatesHead />
      <GatesStrip data={data} />
      <ActionBar />
    </section>
  );
}

/* --------------------------------------------------------------------------
 * PageHeader (M5gN0)
 * ------------------------------------------------------------------------ */
function PageHeader({ activeIndex }: { activeIndex: number }) {
  const stepNum = activeIndex + 1;
  const stepTitle = STEPS[activeIndex]?.title ?? STEPS[0].title;
  return (
    <header className="flex flex-col gap-2.5">
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
        style={{ letterSpacing: "1.2px" }}
      >
        PASO {stepNum} DE 6 · {stepTitle.toUpperCase()}
      </span>
      <h1
        className="m-0 text-[32px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Onboarding del servidor de envío
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        El asistente captura y valida el servidor físico, sus IPs, dominios, DNS, límites y permisos
        antes de pedir el visto bueno humano. OpenClaw observa la evidencia y recomienda, pero nunca
        ejecuta cambios por su cuenta.
      </p>
    </header>
  );
}

/* --------------------------------------------------------------------------
 * Stepper (cL78x): 6 steps con conectores horizontales
 * ------------------------------------------------------------------------ */
function Stepper({ statuses, activeIndex }: { statuses: StepStatus[]; activeIndex: number }) {
  return (
    <ol
      className="m-0 p-0 list-none flex items-center rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: "16px 20px", gap: 14, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      {STEPS.map((step, i) => {
        const status = statuses[i];
        const isActive = i === activeIndex;
        const isReady = status === "ready";
        const isBlocked = status === "blocked";
        const circleBg = isActive ? "#F59E0B" : isReady ? "#15803D" : isBlocked ? "#FEE2E2" : "#FFFBF5";
        const circleFg = isActive || isReady ? "#FFFBF5" : isBlocked ? "#B91C1C" : "#8A8073";
        const circleBorder = !isActive && !isReady ? "#EAE0CE" : "transparent";
        const kickerColor = isActive ? "#EA580C" : isReady ? "#15803D" : isBlocked ? "#B91C1C" : "#8A8073";
        const titleColor = isActive || isReady ? "#1A1410" : "#5C544A";
        const titleWeight = isActive || isReady ? 600 : 500;

        return (
          <li key={step.kicker} className="flex items-center min-w-0" style={{ gap: 10 }}>
            <div className="flex items-center" style={{ gap: 10 }}>
              <span
                aria-hidden="true"
                className="grid place-items-center rounded-full text-[13px] font-[family-name:var(--font-mono)]"
                style={{
                  width: 32,
                  height: 32,
                  background: circleBg,
                  color: circleFg,
                  fontWeight: isActive || isReady ? 700 : 600,
                  boxShadow: circleBorder !== "transparent" ? `inset 0 0 0 1px ${circleBorder}` : undefined
                }}
              >
                {isReady ? "✓" : i + 1}
              </span>
              <div className="flex flex-col gap-0.5">
                <span
                  className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                  style={{ color: kickerColor, letterSpacing: "1px" }}
                >
                  {step.kicker}
                </span>
                <span
                  className="text-[13px] font-[family-name:var(--font-sans)] leading-tight"
                  style={{ color: titleColor, fontWeight: titleWeight }}
                >
                  {step.title}
                </span>
              </div>
            </div>
            {i < STEPS.length - 1 ? (
              <span aria-hidden="true" className="block h-px flex-1 bg-[#EAE0CE]" style={{ minWidth: 24 }} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------------------------
 * Form (IZ1we): 3 SectionCards
 * ------------------------------------------------------------------------ */
function Form({ data }: { data: DashboardData }) {
  const identity = data.physicalHost.identity;
  const capacity = data.physicalHost.capacity;
  const onboarding = data.onboardingState;
  const known = onboarding.knownInputs;
  const knownStr = (key: string): string => {
    const v = known[key];
    if (v === undefined || v === null || v === "") return "—";
    return String(v);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Sección 1 — Identidad */}
      <SectionCard
        eyebrow="SECCIÓN 1"
        title="Identidad del servidor"
        pillTone="neutral"
        pillText={`${formatNumber(Object.keys(known).length)} campos`}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Hostname" value={identity.label || knownStr("hostname") || "unknown"} mono />
          <Field label="Centro de datos" value={identity.location || knownStr("datacenter") || "unknown"} />
          <Field
            label="Rol"
            value={knownStr("role") !== "—" ? knownStr("role") : "primario"}
          />
          <Field
            label="Entorno"
            value={knownStr("environment") !== "—" ? knownStr("environment") : "mvp.local"}
          />
        </div>
      </SectionCard>

      {/* Sección 2 — Inventario */}
      <SectionCard
        eyebrow="SECCIÓN 2"
        title="Inventario físico"
        pillTone="info"
        pillText="hardware snapshot"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="CPU" value={capacity.cpuCores ? `${capacity.cpuCores} cores` : "unknown"} />
          <Field label="RAM" value={capacity.memoryGb ? `${capacity.memoryGb} GB` : "unknown"} />
          <Field label="Storage" value={capacity.storageUsableGb ? `${capacity.storageUsableGb} GB` : "unknown"} />
          <Field label="Link" value={capacity.networkInterfaces ? `${capacity.networkInterfaces} ifaces` : "unknown"} />
        </div>
      </SectionCard>

      {/* Sección 3 — Red */}
      <SectionCard
        eyebrow="SECCIÓN 3"
        title="Red e identidad de envío"
        pillTone="success"
        pillText={`${formatNumber(capacity.ipPoolSize ?? 0)} IPs`}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="eth0" value={knownStr("eth0") !== "—" ? knownStr("eth0") : "—"} mono />
          <Field label="eth1" value={knownStr("eth1") !== "—" ? knownStr("eth1") : "—"} mono />
          <Field label="IPMI" value={knownStr("ipmi") !== "—" ? knownStr("ipmi") : "—"} mono />
          <Field label="Dominios" value={knownStr("domains") !== "—" ? knownStr("domains") : "—"} />
        </div>
      </SectionCard>
    </div>
  );
}

function SectionCard({
  eyebrow,
  title,
  pillTone,
  pillText,
  children
}: {
  eyebrow: string;
  title: string;
  pillTone: "neutral" | "info" | "success";
  pillText: string;
  children: React.ReactNode;
}) {
  const pillBg = pillTone === "neutral" ? "#F5F5F4" : pillTone === "info" ? "#DBEAFE" : "#DCFCE7";
  const pillFg = pillTone === "neutral" ? "#5C544A" : pillTone === "info" ? "#1D4ED8" : "#15803D";
  return (
    <section
      className="flex flex-col gap-4 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
            style={{ letterSpacing: "1.2px" }}
          >
            {eyebrow}
          </span>
          <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            {title}
          </h3>
        </div>
        <span
          className="inline-block rounded-[4px] px-2 py-1 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ background: pillBg, color: pillFg }}
        >
          {pillText}
        </span>
      </header>
      {children}
    </section>
  );
}

/**
 * Field row Pencil: label small Inter + valor en input-like read-only.
 */
function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
        style={{ letterSpacing: "0.4px" }}
      >
        {label}
      </span>
      <div
        className="rounded-[6px] border border-[#EAE0CE] bg-[#F7F2EA] px-3 py-2.5"
        aria-readonly="true"
      >
        <span
          className={`text-[12px] ${mono ? "font-[family-name:var(--font-mono)]" : "font-[family-name:var(--font-sans)]"} text-[#1A1410]`}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * OpenClaw column (vBXlY, 360w)
 * ------------------------------------------------------------------------ */
function OpenClawColumn({
  blockers,
  warnings,
  canGenerate
}: {
  blockers: string[];
  warnings: string[];
  canGenerate: boolean;
}) {
  const message =
    blockers.length > 0
      ? `Detecté ${formatNumber(blockers.length)} bloqueos pendientes. ¿Resumimos el siguiente con mayor impacto?`
      : warnings.length > 0
        ? `Hay ${formatNumber(warnings.length)} advertencias activas. Podemos priorizar antes del gate de lanzamiento.`
        : canGenerate
          ? "Inventario completo. Puedo proponer el plan de topología cuando lo autorices."
          : "Avanzando el inventario sin bloqueos. Al completar los campos abiertos genero el plan.";

  return (
    <div className="flex flex-col gap-4">
      <div
        className="rounded-[12px] p-[2px]"
        style={{
          background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
          boxShadow: "0 8px 24px rgba(26, 20, 16, 0.13)"
        }}
      >
        <div className="flex flex-col gap-4 rounded-[10px] bg-[#FFFBF5]" style={{ padding: 20 }}>
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid h-8 w-8 place-items-center rounded-[8px] text-[#FFFBF5]"
              style={{
                background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)"
              }}
            >
              <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
                OpenClaw
              </span>
              <span
                className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]"
                style={{ letterSpacing: "0.4px" }}
              >
                Operador supervisado
              </span>
            </div>
          </div>

          <div
            className="rounded-[8px] border border-[#EAE0CE] bg-[#F7F2EA] px-3.5 py-3.5"
          >
            <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#1A1410]">
              {message}
            </p>
          </div>

          <div
            aria-hidden="true"
            className="flex items-center gap-2 rounded-[6px] border border-[#EAE0CE] bg-[#FFFBF5] px-3 py-3"
          >
            <span className="flex-1 text-[12px] font-[family-name:var(--font-sans)] text-[#8A8073]">
              Responde a OpenClaw…
            </span>
            <ArrowUp size={14} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
          </div>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled
              className="inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[#1A1410] px-3 py-2.5 text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5] disabled:cursor-default disabled:opacity-100"
            >
              <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
              Sugerir siguiente paso
            </button>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073] text-center">
              interacción real vive fuera del panel
            </span>
          </div>
        </div>
      </div>

      <div
        className="flex flex-col gap-2 rounded-[8px] border border-[#EAE0CE] bg-[#F7F2EA]"
        style={{ padding: 14 }}
      >
        <div className="flex items-center gap-2">
          <Info size={13} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
          <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
            Por qué OpenClaw observa aquí
          </span>
        </div>
        <p className="m-0 text-[11px] font-[family-name:var(--font-caption)] leading-[1.45] text-[#5C544A]">
          El onboarding requiere validación humana en cada gate. OpenClaw correlaciona la evidencia
          capturada y propone próximos pasos, pero no escribe en producción.
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Gates head + strip
 * ------------------------------------------------------------------------ */
function GatesHead() {
  return (
    <header className="flex flex-col gap-1.5">
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
        style={{ letterSpacing: "1.2px" }}
      >
        VALIDACIONES Y GATES
      </span>
      <h2 className="m-0 text-[13px] font-[family-name:var(--font-sans)] text-[#5C544A]">
        Pendientes humanas antes de habilitar el servidor para envío
      </h2>
    </header>
  );
}

function GatesStrip({ data }: { data: DashboardData }) {
  const blockers = data.onboardingState.blockers ?? [];
  const operatingNorth = data.operatingNorth;

  // Pencil cards estáticas; las renderizo cuando aplique según contrato.
  const cards: Array<{
    iconBg: string;
    iconColor: string;
    pillBg: string;
    pillFg: string;
    icon: React.ReactNode;
    title: string;
    pillText: string;
    desc: string;
  }> = [];

  if (blockers.length > 0) {
    cards.push({
      iconBg: "#FEF3C7",
      iconColor: "#B45309",
      pillBg: "#FEF3C7",
      pillFg: "#B45309",
      icon: <ShieldAlert size={18} strokeWidth={1.75} aria-hidden="true" />,
      title: "Cumplimiento pendiente",
      pillText: `${formatNumber(blockers.length)} bloqueos`,
      desc:
        "A la espera de que un revisor humano firme el cumplimiento de políticas y registre la evidencia."
    });
  }

  if (!operatingNorth.delivrixSendsRealEmail || blockers.some((b) => b.toLowerCase().includes("dns"))) {
    cards.push({
      iconBg: "#FEE2E2",
      iconColor: "#B91C1C",
      pillBg: "#FEE2E2",
      pillFg: "#B91C1C",
      icon: <ShieldX size={18} strokeWidth={1.75} aria-hidden="true" />,
      title: "DNS no validado",
      pillText: "crítico",
      desc:
        "Las zonas y registros aún no se verifican contra los resolvers internos del clúster de envío."
    });
  }

  cards.push({
    iconBg: "#EDE9FE",
    iconColor: "#7C3AED",
    pillBg: "#EDE9FE",
    pillFg: "#7C3AED",
    icon: <KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />,
    title: "SSH no autorizado",
    pillText: "manual",
    desc:
      "OpenClaw no tiene credenciales para acceder por SSH. Necesita autorización manual del operador con rol elevado."
  });

  return (
    <div className="grid gap-3.5 grid-cols-1 md:grid-cols-3">
      {cards.slice(0, 3).map((card) => (
        <article
          key={card.title}
          className="flex gap-3.5 rounded-[6px] border border-[#EAE0CE] bg-[#FFFFFF]"
          style={{ padding: 16 }}
        >
          <span
            aria-hidden="true"
            className="grid shrink-0 place-items-center rounded-[4px]"
            style={{
              width: 36,
              height: 36,
              background: card.iconBg,
              color: card.iconColor
            }}
          >
            {card.icon}
          </span>
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <header className="flex items-center justify-between gap-2">
              <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
                {card.title}
              </h3>
              <span
                className="inline-block rounded-full px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
                style={{ background: card.pillBg, color: card.pillFg }}
              >
                {card.pillText}
              </span>
            </header>
            <p className="m-0 text-[12px] font-[family-name:var(--font-caption)] leading-[1.45] text-[#5C544A]">
              {card.desc}
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Action bar
 * ------------------------------------------------------------------------ */
function ActionBar() {
  return (
    <section
      className="flex items-center justify-between gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: "14px 18px", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <button
        type="button"
        disabled
        className="inline-flex items-center gap-2 rounded-[6px] px-3 py-2.5 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#5C544A] disabled:cursor-default disabled:opacity-100"
      >
        <Save size={14} strokeWidth={1.75} aria-hidden="true" />
        Guardar borrador
      </button>

      <div className="flex items-center gap-3.5">
        <span
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#B45309] bg-[#FEF3C7] px-3 py-2"
          aria-label="tooltip"
        >
          <Lock size={12} strokeWidth={1.75} className="text-[#B45309]" aria-hidden="true" />
          <span className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#B45309]">
            Requiere validación humana del gate de cumplimiento
          </span>
        </span>
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-2 rounded-[6px] border border-[#EAE0CE] bg-[#FFFBF5] px-4 py-2.5 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410] disabled:cursor-default disabled:opacity-100"
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          Volver
        </button>
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-2 rounded-[6px] border border-[#EAE0CE] bg-[#F5F5F4] px-5 py-2.5 text-[13px] font-[family-name:var(--font-sans)] font-bold text-[#8A8073] disabled:cursor-default disabled:opacity-100"
          style={{ opacity: 0.55 }}
        >
          <Send size={14} strokeWidth={1.75} aria-hidden="true" />
          Enviar para aprobación
        </button>
      </div>
    </section>
  );
}

/* Silence unused import */
void humanize;
void compactLabel;
