/**
 * Onboarding Wizard — port LITERAL desde Pencil frame `T9osf` / `GygQG`.
 *
 * Cada texto, color, padding e icono viene del .pen. Los campos del formulario
 * muestran los placeholders literales (hostname `vps-edge-01.delivrix.io`,
 * datacenter `mad-2 · Madrid Norte`, etc.) tal como Pencil los dibuja.
 */

import {
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Cpu,
  Eye,
  FileSearch,
  Info,
  KeyRound,
  Link as LinkIcon,
  Lock,
  MessageSquare,
  Network,
  Save,
  Send,
  ShieldAlert,
  ShieldX,
  Sparkles,
  WandSparkles
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DashboardData } from "../../shared/api/client.ts";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary.ts";
import { useToast } from "../../shared/ui/v2/index.ts";
import { BannerOpenClawV2 } from "../../shared/ui/v2/index.ts";

export function OnboardingSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col" style={{ gap: 20 }}>
      <PageHeader />
      <Stepper data={data} />
      <WizardBody data={data} />
      <GatesHead />
      <GatesStrip data={data} />
      <ActionBar data={data} />
    </section>
  );
}

/* ============================================================
 * PageHeader (M5gN0)
 * ============================================================ */
function PageHeader() {
  return (
    <header className="flex flex-col" style={{ gap: 10 }}>
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-accent-tertiary)]"
        style={{ letterSpacing: "var(--tracking-widest)" }}
      >
        PASO 1 DE 6 · INVENTARIO FÍSICO
      </span>
      <h1
        className="m-0 text-[32px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]"
      >
        Onboarding del servidor de envío
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
        El asistente captura y valida el servidor físico, sus IPs, dominios, DNS, límites y
        permisos antes de pedir el visto bueno humano. OpenClaw observa la evidencia y
        recomienda, pero nunca ejecuta cambios por su cuenta.
      </p>
    </header>
  );
}

/* ============================================================
 * Stepper (cL78x) — 6 pasos con conectores horizontales
 * ============================================================ */
interface OnboardingStepConfig {
  title: string;
  category: string;
  readinessKeys: string[];
  questionCategories: string[];
  blockerTerms: string[];
}

export interface OnboardingStep {
  kicker: string;
  title: string;
  category: string;
  score: number | null;
  pendingQuestions: number;
  blockers: number;
}

const ONBOARDING_STEP_CONFIG: OnboardingStepConfig[] = [
  {
    title: "Servidor",
    category: "server",
    readinessKeys: ["infrastructure"],
    questionCategories: ["server", "proxmox"],
    blockerTerms: ["server", "cpu", "ram", "storage", "proxmox"]
  },
  {
    title: "IPs y dominios",
    category: "network",
    readinessKeys: ["network"],
    questionCategories: ["network", "ip_pool", "domains"],
    blockerTerms: ["network", "uplink", "ip", "pool", "provider", "ptr", "domain"]
  },
  {
    title: "DNS",
    category: "dns",
    readinessKeys: ["dns"],
    questionCategories: ["dns"],
    blockerTerms: ["dns"]
  },
  {
    title: "Límites",
    category: "limits",
    readinessKeys: [],
    questionCategories: ["limits"],
    blockerTerms: ["limit", "warmup", "volume", "sender_node", "node"]
  },
  {
    title: "Cumplimiento",
    category: "compliance",
    readinessKeys: ["compliance"],
    questionCategories: ["compliance"],
    blockerTerms: ["compliance", "physical_address", "opt_out", "suppression", "consent", "authorization"]
  },
  {
    title: "Revisión",
    category: "review",
    readinessKeys: ["security", "autonomy"],
    questionCategories: ["security", "autonomy"],
    blockerTerms: ["security", "secret", "audit", "kill_switch", "autonomy", "human_approval"]
  }
];

/**
 * Deriva el stepper desde `onboardingState`: readiness, preguntas pendientes y blockers.
 * Si el contrato no trae señales, no se inventan pasos de demostración.
 */
export function buildOnboardingSteps(onboardingState: DashboardData["onboardingState"]): OnboardingStep[] {
  const readiness = onboardingState.readinessByCategory ?? {};
  const questions = onboardingState.pendingQuestions ?? [];
  const blockers = onboardingState.blockers ?? [];

  return ONBOARDING_STEP_CONFIG
    .map((config) => {
      const score = averageReadiness(config.readinessKeys, readiness);
      const pendingQuestions = questions.filter((question) =>
        config.questionCategories.includes(question.category.toLowerCase())
      ).length;
      const matchedBlockers = blockers.filter((blocker) =>
        config.blockerTerms.some((term) => blocker.toLowerCase().includes(term))
      ).length;

      return {
        title: config.title,
        category: config.category,
        score,
        pendingQuestions,
        blockers: matchedBlockers
      };
    })
    .filter((step) => step.score !== null || step.pendingQuestions > 0 || step.blockers > 0)
    .map((step, index) => ({
      ...step,
      kicker: `PASO ${index + 1}`
    }));
}

export function activeStepIndex(steps: OnboardingStep[]): number {
  if (steps.length === 0) {
    return 0;
  }

  const activeIndex = steps.findIndex((step) => {
    if (step.blockers > 0 || step.pendingQuestions > 0) return true;
    return step.score === null || step.score < 1;
  });

  return activeIndex >= 0 ? activeIndex : steps.length - 1;
}

function averageReadiness(keys: string[], readiness: Record<string, number>): number | null {
  const values = keys
    .map((key) => readiness[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function Stepper({ data }: { data: DashboardData }) {
  const steps = buildOnboardingSteps(data.onboardingState);
  const activeIdx = activeStepIndex(steps);

  if (steps.length === 0) {
    return <OnboardingStepsEmptyState />;
  }

  return (
    <ol
      className="m-0 p-0 list-none flex items-center overflow-x-auto snap-x snap-mandatory bg-[var(--color-surface)] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        gap: 14,
        padding: "16px 20px",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)"
      }}
    >
      {steps.map((step, i) => {
        const active = i === activeIdx;
        return (
        <li key={step.kicker} className="flex items-center shrink-0 snap-start" style={{ gap: 10 }}>
          <div className="flex items-center" style={{ gap: 10 }}>
            <span
              aria-hidden="true"
              className="grid place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: active ? "var(--color-accent)" : "var(--color-bg)",
                color: active ? "var(--color-bg)" : "var(--color-text-tertiary)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: active ? 700 : 600,
                boxShadow: !active ? "inset 0 0 0 1px var(--color-border)" : undefined
              }}
            >
              {i + 1}
            </span>
            <div className="flex flex-col" style={{ gap: 2 }}>
              <span
                className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                style={{
                  color: active ? "var(--color-accent-tertiary)" : "var(--color-text-tertiary)",
                  letterSpacing: "var(--tracking-widest)"
                }}
              >
                {step.kicker}
              </span>
              <span
                className="text-[13px] font-[family-name:var(--font-sans)]"
                style={{
                  color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                  fontWeight: active ? 600 : 500
                }}
              >
                {step.title}
              </span>
            </div>
          </div>
          {i < steps.length - 1 ? (
            <span
              aria-hidden="true"
              className="block"
              style={{ height: 1, flex: 1, minWidth: 16, background: "var(--color-border)" }}
            />
          ) : null}
        </li>
        );
      })}
    </ol>
  );
}

function OnboardingStepsEmptyState() {
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 6,
        padding: "16px 20px",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)"
      }}
    >
      <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
        Sin pasos de onboarding disponibles
      </span>
      <span className="text-[11px] font-[family-name:var(--font-sans)] leading-[1.45] text-[var(--color-text-secondary)]">
        El contrato no devolvió categorías de readiness ni preguntas pendientes.
      </span>
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
        {READ_ENDPOINTS.openClawOnboardingState}
      </span>
    </section>
  );
}

/* ============================================================
 * WizardBody (uqjXO) — Form (3 cards) + OpenClawColumn (360w)
 * ============================================================ */
function WizardBody({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
      <Form data={data} />
      <OpenClawColumn data={data} />
    </div>
  );
}

function Form({ data }: { data: DashboardData }) {
  const ph = data.physicalHost;
  const cap = ph.capacity;
  const on = data.operatingNorth;
  const known = data.onboardingState.knownInputs as Record<string, unknown>;
  const knownStr = (k: string, fb: string): string => {
    const v = known[k];
    return v !== undefined && v !== null && v !== "" ? String(v) : fb;
  };

  // A-MED-05 (2026-05-28): Codex 6500a15 expone environment ("mvp.local")
  // separado de releasePhase (sprint phase interno). Antes ENTORNO mostraba
  // "5.9-manual-snapshot-ingestion-ux" que era jerga.
  const environmentLabel =
    data.onboardingState.environment ?? data.operatingNorth.environment ?? "mvp.local";

  // A-MED-07: sections del backend con detectedFieldCount permite mostrar
  // tag warning si la sección no tiene campos detectados aún.
  const sectionsById = new Map(
    (data.onboardingState.sections ?? []).map((s) => [s.id, s])
  );
  const serverSection = sectionsById.get("server");
  const serverDetected = serverSection?.detectedFieldCount ?? 0;
  const serverTotal = serverSection?.totalFieldCount ?? 0;
  const serverNoData = serverSection != null && serverDetected === 0;

  // Helpers para mostrar capacidad real desde el contrato o '—' si null.
  const cpuLine = cap.cpuCores
    ? `${cap.cpuCores} cores${cap.cpuThreads ? ` · ${cap.cpuThreads} threads` : ""}`
    : "—";
  const ramLine = cap.memoryGb ? `${cap.memoryGb} GB` : "—";
  const storageLine = cap.storageUsableGb ? `${cap.storageUsableGb} GB usables` : "—";
  const linkLine = cap.networkInterfaces ? `${cap.networkInterfaces} interfaces` : "—";

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {/* Sección 1 — Identidad (datos reales de physicalHost.identity + operatingNorth) */}
      <SectionCard
        iconBg="var(--color-warning-soft)"
        iconColor="var(--color-warning)"
        icon={<ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 1"
        title="Identidad del servidor"
        pillBg="var(--color-warning-soft)"
        pillFg="var(--color-warning)"
        pillDot="var(--color-warning)"
        pillText="campos requeridos"
      >
        <FieldRow label="HOSTNAME" value={ph.identity.label || knownStr("hostname", "—")} />
        <FieldRow label="DATACENTER" value={ph.identity.location || knownStr("datacenter", "—")} />
        <FieldRow label="ROL" value={on.delivrixRole || knownStr("role", "—")} />
        <FieldRow label="ENTORNO" value={environmentLabel} />
      </SectionCard>

      {/* Sección 2 — Inventario de cómputo (capacidad real desde el contrato)
       *
       * A-MED-07 (2026-05-28): si el backend reporta detectedFieldCount=0
       * cambiamos el tag de verde "detectado" a warning "pendiente · esperando
       * snapshot" — antes era engañoso ver el verde con todos los campos en --.
       */}
      <SectionCard
        iconBg={serverNoData ? "var(--color-warning-soft)" : "var(--color-info-soft)"}
        iconColor={serverNoData ? "var(--color-warning)" : "var(--color-info)"}
        icon={<Cpu size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 2"
        title="Inventario de cómputo"
        pillBg={serverNoData ? "var(--color-warning-soft)" : "var(--color-info-soft)"}
        pillFg={serverNoData ? "var(--color-warning)" : "var(--color-info)"}
        pillDot={serverNoData ? "var(--color-warning)" : "var(--color-info)"}
        pillText={
          serverSection
            ? serverNoData
              ? "pendiente · esperando snapshot"
              : `${serverDetected}/${serverTotal} campos detectados`
            : "detectado por el recolector"
        }
      >
        <FieldRow label="CPU" value={cpuLine} badge={cap.cpuCores ? "DETECTADO" : undefined} />
        <FieldRow label="MEMORIA RAM" value={ramLine} badge={cap.memoryGb ? "DETECTADO" : undefined} />
        <FieldRow label="ALMACENAMIENTO" value={storageLine} badge={cap.storageUsableGb ? "DETECTADO" : undefined} />
        <FieldRow label="ENLACE PRIMARIO" value={linkLine} badge={cap.networkInterfaces ? "DETECTADO" : undefined} />
      </SectionCard>

      {/* Sección 3 — Interfaces de red (knownInputs cuando exista; placeholder cuando falte)
       *
       * A-ALT-06 (2026-05-28): cuando count===0 el tag debe ser warning, no
       * success. 0 interfaces en un servidor de envío bloquea operación
       * normal — comunicarlo como OK era engañoso.
       */}
      {(() => {
        const ifaces = cap.networkInterfaces ?? 0;
        const isZero = ifaces === 0;
        return (
      <SectionCard
        iconBg={isZero ? "var(--color-warning-soft)" : "var(--color-success-soft)"}
        iconColor={isZero ? "var(--color-warning)" : "var(--color-success)"}
        icon={<Network size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 3"
        title="Interfaces de red"
        pillBg={isZero ? "var(--color-warning-soft)" : "var(--color-success-soft)"}
        pillFg={isZero ? "var(--color-warning)" : "var(--color-success)"}
        pillDot={isZero ? "var(--color-warning)" : "var(--color-success)"}
        pillText={isZero ? "0 interfaces · pendiente de captura" : `${ifaces} interfaces declaradas`}
      >
        <FieldRow label="BOND0 · ENVÍO" value={knownStr("interface_primary", "—")} />
        <FieldRow label="ETH2 · GESTIÓN" value={knownStr("interface_management", "—")} />
        <FieldRow
          label="IPMI · FUERA DE BANDA"
          value={knownStr("interface_ipmi", "—")}
          badge={known["interface_ipmi"] ? "DETECTADO" : undefined}
        />
        <FieldRow
          label="DOMINIO PÚBLICO"
          value={knownStr("public_domain", cap.ipPoolSize ? `${cap.ipPoolSize} IPs · pool` : "—")}
        />
      </SectionCard>
        );
      })()}
    </div>
  );
}

function SectionCard({
  iconBg,
  iconColor,
  icon,
  kicker,
  title,
  pillBg,
  pillFg,
  pillDot,
  pillText,
  children
}: {
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  kicker: string;
  title: string;
  pillBg: string;
  pillFg: string;
  pillDot: string;
  pillText: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 18,
        padding: 20,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)"
      }}
    >
      {/* SecHead */}
      <header className="flex items-center justify-between" style={{ gap: 10 }}>
        <div className="flex items-center" style={{ gap: 10 }}>
          <span
            aria-hidden="true"
            className="grid place-items-center"
            style={{ width: 32, height: 32, borderRadius: 6, background: iconBg, color: iconColor }}
          >
            {icon}
          </span>
          <div className="flex flex-col" style={{ gap: 2 }}>
            <span
              className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
              style={{ letterSpacing: "var(--tracking-widest)" }}
            >
              {kicker}
            </span>
            <h3 className="m-0 text-[16px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
              {title}
            </h3>
          </div>
        </div>
        <span
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-caption)] font-semibold"
          style={{
            gap: 6,
            padding: "4px 10px",
            borderRadius: 4,
            background: pillBg,
            color: pillFg,
            letterSpacing: "var(--tracking-wide)"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: pillDot }} />
          {pillText}
        </span>
      </header>

      {/* Field rows in 2 columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 16 }}>
        {children}
      </div>
    </section>
  );
}

function FieldRow({ label, value, badge }: { label: string; value: string; badge?: string }) {
  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[var(--color-text-tertiary)]"
          style={{ letterSpacing: "var(--tracking-wide)" }}
        >
          {label}
        </span>
        {badge ? (
          <span
            className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
            style={{
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--color-success-soft)",
              color: "var(--color-success)",
              letterSpacing: "var(--tracking-wide)"
            }}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <div
        className="bg-[var(--color-surface)]"
        style={{
          padding: "12px 10px",
          borderRadius: 6,
          border: "1px solid var(--color-border)"
        }}
      >
        <span className="text-[13px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{value}</span>
      </div>
    </div>
  );
}

/* ============================================================
 * OpenClawColumn (vBXlY, 360w)
 * ============================================================ */
function OpenClawColumn({ data }: { data: DashboardData }) {
  const unknownsCount =
    (data.physicalHost.quality.unknownFields?.length ?? 0) +
    (data.telemetry.quality.unknownFields?.length ?? 0);
  const blockers = data.onboardingState.blockers?.length ?? 0;
  return (
    <aside className="flex flex-col" style={{ gap: 16 }}>
      <OpenClawCard unknownsCount={unknownsCount} blockers={blockers} />
      <OpenClawMeta />
    </aside>
  );
}

function OpenClawCard({ unknownsCount, blockers }: { unknownsCount: number; blockers: number }) {
  // Migrado a BannerOpenClawV2 — ~130 LOC duplicadas eliminadas (gradient bulky + ocInput + ocActions)
  //
  // A-MED-06 (2026-05-28): cambiamos "bloqueos" → "ítems pendientes". El
  // término "bloqueo" sugería alarma crítica cuando son ítems normales del
  // checklist de onboarding que aún no se completaron. Lenguaje neutral
  // sin perder información.
  const title =
    blockers > 0
      ? `${blockers} ítem${blockers === 1 ? "" : "s"} pendiente${blockers === 1 ? "" : "s"} en onboarding`
      : unknownsCount > 0
        ? `${unknownsCount} campo${unknownsCount === 1 ? "" : "s"} sin completar`
        : "Inventario completo";
  const body =
    blockers > 0
      ? `Tengo ${blockers} ítem${blockers === 1 ? "" : "s"} pendiente${blockers === 1 ? "" : "s"} antes del gate. ¿Quieres que resuma el más crítico?`
      : unknownsCount > 0
        ? `Detecté ${unknownsCount} campo${unknownsCount === 1 ? "" : "s"} sin completar en tu inventario. ¿Quieres que resuma lo que falta antes del gate de cumplimiento?`
        : "Inventario completo. Puedo proponer el plan de topología cuando lo autorices.";
  return (
    <BannerOpenClawV2
      title={title}
      body={body}
      primaryCta="Revisar recomendación"
      secondaryCta="Ver evidencia"
    />
  );
}

function OpenClawMeta() {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 8,
        padding: 14,
        borderRadius: 8,
        background: "var(--color-surface-sunken)",
        border: "1px solid var(--color-border)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <Info size={13} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Por qué OpenClaw observa aquí
        </span>
      </header>
      <p className="m-0 text-[11px] font-[family-name:var(--font-caption)] leading-[1.45] text-[var(--color-text-secondary)]">
        El onboarding requiere validación humana en cada gate. OpenClaw correlaciona la evidencia
        capturada y propone próximos pasos, pero no escribe en producción.
      </p>
    </div>
  );
}

/* ============================================================
 * GatesHead + GatesStrip
 * ============================================================ */
function GatesHead() {
  return (
    <header className="flex flex-col" style={{ gap: 6 }}>
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
        style={{ letterSpacing: "var(--tracking-widest)" }}
      >
        VALIDACIONES Y GATES
      </span>
      <h2 className="m-0 text-[13px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
        Pendientes humanas antes de habilitar el servidor para envío
      </h2>
    </header>
  );
}

function GatesStrip({ data }: { data: DashboardData }) {
  const blockers = data.onboardingState.blockers ?? [];
  const blockersCount = blockers.length;
  const dnsBlocker = blockers.some((b) => b.toLowerCase().includes("dns"));
  const sshBlocker = blockers.some((b) => b.toLowerCase().includes("ssh"));
  return (
    <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 14 }}>
      <GateCard
        iconBg="var(--color-warning-soft)"
        iconColor="var(--color-warning)"
        icon={<ShieldAlert size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="Cumplimiento pendiente"
        pillBg="var(--color-warning-soft)"
        pillFg="var(--color-warning)"
        pillText={blockersCount > 0 ? `${blockersCount} pendientes` : "revisión humana"}
        desc="A la espera de que un revisor humano firme el cumplimiento de políticas y registre la evidencia."
      />
      <GateCard
        iconBg={dnsBlocker ? "var(--color-critical-soft)" : "var(--color-warning-soft)"}
        iconColor={dnsBlocker ? "var(--color-critical)" : "var(--color-warning)"}
        icon={<ShieldX size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="DNS no validado"
        pillBg={dnsBlocker ? "var(--color-critical-soft)" : "var(--color-warning-soft)"}
        pillFg={dnsBlocker ? "var(--color-critical)" : "var(--color-warning)"}
        pillText={dnsBlocker ? "crítico" : "pendiente"}
        desc="Las zonas y registros aún no se verifican contra los resolvers internos del clúster de envío."
      />
      <GateCard
        iconBg="var(--color-unknown-soft)"
        iconColor="var(--color-unknown)"
        icon={<KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="SSH no autorizado"
        pillBg="var(--color-unknown-soft)"
        pillFg="var(--color-unknown)"
        pillText={sshBlocker ? "ssh bloqueado" : "autorizar manualmente"}
        desc="OpenClaw no tiene credenciales para acceder por SSH. Necesita autorización manual del operador con rol elevado."
      />
    </div>
  );
}

function GateCard({
  iconBg,
  iconColor,
  icon,
  title,
  pillBg,
  pillFg,
  pillText,
  desc
}: {
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  title: string;
  pillBg: string;
  pillFg: string;
  pillText: string;
  desc: string;
}) {
  return (
    <article
      className="flex bg-[var(--color-surface)]"
      style={{ gap: 14, padding: 16, borderRadius: 6, border: "1px solid var(--color-border)" }}
    >
      <span
        aria-hidden="true"
        className="grid place-items-center shrink-0"
        style={{ width: 36, height: 36, borderRadius: 4, background: iconBg, color: iconColor }}
      >
        {icon}
      </span>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 4 }}>
        <header className="flex items-center" style={{ gap: 8 }}>
          <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            {title}
          </h3>
          <span className="flex-1" aria-hidden="true" />
          <span
            className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-semibold"
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: pillBg,
              color: pillFg,
              letterSpacing: "var(--tracking-wide)"
            }}
          >
            {pillText}
          </span>
        </header>
        <p className="m-0 text-[12px] font-[family-name:var(--font-caption)] leading-[1.45] text-[var(--color-text-secondary)]">
          {desc}
        </p>
      </div>
    </article>
  );
}

/* ============================================================
 * ActionBar
 * ============================================================ */
/**
 * ActionBar — acciones reales sobre el estado de onboarding.
 *
 * NOTA: el wizard NO es editable (los FieldRow son display-only del estado
 * que ya vive en el backend). Por eso las 3 acciones son operativas:
 *
 * - "Exportar snapshot" → descarga JSON del onboardingState actual al disco.
 *   Útil para auditoría manual / handoff entre operadores.
 * - "Refrescar estado" → invalida la dashboard query y refetchea.
 * - "Solicitar evaluación OpenClaw" → POST /v1/openclaw/onboarding/evaluate.
 *   Backend escribe audit event `openclaw_onboarding.evaluated`. Disabled
 *   cuando hay blockers porque no tiene sentido pedir evaluación sin info.
 */
function ActionBar({ data }: { data: DashboardData }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const blockers = data.onboardingState.blockers?.length ?? 0;
  const unknowns = (data.physicalHost.quality.unknownFields?.length ?? 0) +
    (data.telemetry.quality.unknownFields?.length ?? 0);
  const canEvaluate = blockers === 0;

  // Action 1: descargar snapshot del estado actual.
  const handleExport = () => {
    try {
      const snapshot = {
        capturedAt: new Date().toISOString(),
        physicalHost: data.physicalHost,
        operatingNorth: data.operatingNorth,
        onboardingState: data.onboardingState,
        telemetry: data.telemetry
      };
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `delivrix-onboarding-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Snapshot exportado", {
        description: "Archivo JSON descargado en el sistema.",
        duration: 2500
      });
    } catch (e) {
      toast.error("No se pudo exportar", {
        description: e instanceof Error ? e.message : "Error desconocido"
      });
    }
  };

  // Action 2: refrescar dashboard query.
  const handleRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin-panel", "dashboard"] });
    toast.success("Estado refrescado", { duration: 1800 });
  };

  // Action 3: solicitar evaluación al backend.
  const evaluateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/v1/openclaw/onboarding/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ actorId: "panel-operator" })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ` · ${text.slice(0, 120)}` : ""}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Evaluación enviada a OpenClaw", {
        description: "Audit event escrito · espera la decisión humana del gate."
      });
      void queryClient.invalidateQueries({ queryKey: ["admin-panel", "dashboard"] });
    },
    onError: (error) => {
      toast.error("Falló la solicitud de evaluación", {
        description: error instanceof Error ? error.message : "Error desconocido"
      });
    }
  });

  return (
    <section
      className="flex flex-wrap items-center bg-[var(--color-surface)]"
      style={{
        gap: 12,
        padding: "14px 18px",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)",
        justifyContent: "space-between"
      }}
    >
      <button
        type="button"
        onClick={handleExport}
        className="inline-flex items-center text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        style={{ gap: 8, padding: "10px 12px", borderRadius: 6, background: "transparent", cursor: "pointer" }}
      >
        <Save size={14} strokeWidth={1.75} aria-hidden="true" />
        Exportar snapshot
      </button>

      <div className="flex flex-wrap items-center" style={{ gap: 12 }}>
        {blockers > 0 ? (
          <span
            className="inline-flex items-center text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-warning)]"
            style={{
              gap: 6,
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--color-warning-soft)",
              border: "1px solid var(--color-warning)"
            }}
          >
            <Lock size={12} strokeWidth={1.75} aria-hidden="true" />
            {blockers} bloqueo{blockers === 1 ? "" : "s"} · {unknowns} campo{unknowns === 1 ? "" : "s"} sin completar
          </span>
        ) : (
          <span
            className="inline-flex items-center text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-success)]"
            style={{
              gap: 6,
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--color-success-soft)",
              border: "1px solid var(--color-success)"
            }}
          >
            <CheckCircle2 size={12} strokeWidth={1.75} aria-hidden="true" />
            Sin bloqueos · listo para evaluación
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleRefresh()}
          className="inline-flex items-center text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 8,
            padding: "10px 16px",
            borderRadius: 6,
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            cursor: "pointer"
          }}
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          Refrescar estado
        </button>
        <button
          type="button"
          onClick={() => evaluateMutation.mutate()}
          disabled={!canEvaluate || evaluateMutation.isPending}
          className="inline-flex items-center text-[13px] font-[family-name:var(--font-sans)] font-semibold transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-55"
          style={{
            gap: 8,
            padding: "10px 18px",
            borderRadius: 6,
            background: canEvaluate ? "var(--color-accent)" : "var(--color-neutral-soft)",
            color: canEvaluate ? "var(--color-on-dark-strong)" : "var(--color-text-tertiary)",
            border: canEvaluate ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
            cursor: canEvaluate && !evaluateMutation.isPending ? "pointer" : "not-allowed"
          }}
        >
          <Send size={14} strokeWidth={1.75} aria-hidden="true" />
          {evaluateMutation.isPending ? "Enviando…" : "Solicitar evaluación a OpenClaw"}
        </button>
      </div>
    </section>
  );
}
