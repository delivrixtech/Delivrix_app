/**
 * Onboarding Wizard — migrado al MOLDE Aivora (features/overview/TravigueOverviewProto.tsx).
 *
 * Los primitivos vienen de shared/ui/aivora (Card radius 18 + hairline + shadow-sm,
 * KpiCard tile+número tabular, SectionHead eyebrow+h1 light, AdvisorCard gradient).
 * Los colores salen SOLO de tokens var(--color-*), por lo que la vista es theme-aware.
 *
 * DATOS REALES: los campos son display-only del contrato (`physicalHost`,
 * `operatingNorth`, `onboardingState`, `telemetry`) y caen a "—" cuando el
 * contrato no trae el dato. Nada de series/valores decorativos: los KpiCard no
 * llevan sparkline ni delta porque el contrato no expone histórico de readiness.
 */

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Info,
  KeyRound,
  ListChecks,
  Lock,
  Network,
  Save,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DashboardData } from "../../shared/api/client.ts";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary.ts";
import { useToast } from "../../shared/ui/v2/index.ts";
import { useOpenClawIntent } from "../../shared/ui/v2/index.ts";
import type { ReactNode } from "react";
import {
  AdvisorCard,
  aivoraGradient,
  Button,
  Card,
  Eyebrow,
  Heading,
  KpiCard,
  Pill,
  SectionHead
} from "../../shared/ui/aivora/index.tsx";

/* MonoCode / EmptyState locales al molde Aivora (tokens · sin B/N de v5). El módulo
 * aivora no exporta estas dos piezas y no se debe tocar, así que viven acá calcadas
 * con los mismos tokens del demo (mono 11px dim; empty-state con Heading + Caption). */
function MonoCode({ children }: { children: ReactNode }) {
  return (
    <span
      className="font-[family-name:var(--font-mono)]"
      style={{ fontSize: 11, lineHeight: 1.5, color: "var(--color-text-tertiary)" }}
    >
      {children}
    </span>
  );
}

function EmptyState({
  title,
  body,
  action
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start" style={{ gap: 8, padding: "24px 16px" }}>
      <Heading level={3}>{title}</Heading>
      {body ? (
        <p
          className="m-0 font-[family-name:var(--font-body)]"
          style={{ fontSize: 13, color: "var(--color-text-secondary)", maxWidth: 520 }}
        >
          {body}
        </p>
      ) : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function OnboardingSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col" style={{ gap: 24 }}>
      <PageHeader />
      <OnboardingKpis data={data} />
      <Stepper data={data} />
      <WizardBody data={data} />
      <GatesHead />
      <GatesStrip data={data} />
      <ActionBar data={data} />
    </section>
  );
}

/* ============================================================
 * PageHeader — eyebrow + h1 light (molde SectionHead)
 * ============================================================ */
function PageHeader() {
  return (
    <SectionHead
      eyebrow="Paso 1 de 6 · Inventario físico"
      title="Onboarding del servidor de envío"
      subtitle="El asistente captura y valida el servidor físico, sus IPs, dominios, DNS, límites y permisos antes de pedir el visto bueno humano. OpenClaw observa la evidencia y recomienda, pero nunca ejecuta cambios por su cuenta."
    />
  );
}

/* ============================================================
 * OnboardingKpis — resumen real derivado de onboardingState.
 * Sin sparkline/delta: el contrato no expone histórico de readiness.
 * ============================================================ */
function OnboardingKpis({ data }: { data: DashboardData }) {
  const readiness = data.onboardingState.readinessByCategory ?? {};
  // `total` es el readiness global autoritativo del backend (0..100), ya calculado
  // como round((infra+network+dns+compliance+security+autonomy)/6) en
  // packages/domain/src/openclaw-onboarding.ts. Lo usamos tal cual: NO promediamos
  // las categorías nosotros (eso incluiría `total` dentro del promedio e inflaría el
  // número, contradiciendo la fuente de verdad). Cae a "—" cuando el contrato no lo trae.
  const total = readiness.total;
  const readinessPct =
    typeof total === "number" && Number.isFinite(total) ? Math.round(total) : null;

  const pending = data.onboardingState.pendingQuestions?.length ?? 0;
  const blockers = data.onboardingState.blockers?.length ?? 0;
  const unknowns =
    (data.physicalHost.quality.unknownFields?.length ?? 0) +
    (data.telemetry.quality.unknownFields?.length ?? 0);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 20 }}>
      <KpiCard
        label="Readiness global"
        value={readinessPct === null ? "—" : readinessPct}
        suffix={readinessPct === null ? undefined : "%"}
        icon={ShieldCheck}
      />
      <KpiCard label="Preguntas pendientes" value={pending} icon={ListChecks} />
      <KpiCard label="Bloqueos" value={blockers} icon={ShieldAlert} />
      <KpiCard label="Campos sin completar" value={unknowns} icon={CircleDashed} />
    </div>
  );
}

/* ============================================================
 * Stepper — 6 pasos con conectores horizontales
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
    <Card>
      <ol
        className="m-0 p-0 list-none flex items-center overflow-x-auto snap-x snap-mandatory [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ gap: 14, padding: "16px 20px" }}
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
                    background: active ? "var(--color-accent)" : "var(--color-surface-sunken)",
                    color: active ? "var(--color-accent-fg)" : "var(--color-text-tertiary)",
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
                      color: active ? "var(--color-accent)" : "var(--color-text-tertiary)",
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
    </Card>
  );
}

function OnboardingStepsEmptyState() {
  return (
    <Card>
      <EmptyState
        title="Sin pasos de onboarding disponibles"
        body="El contrato no devolvió categorías de readiness ni preguntas pendientes."
        action={<MonoCode>{READ_ENDPOINTS.openClawOnboardingState}</MonoCode>}
      />
    </Card>
  );
}

/* ============================================================
 * WizardBody — Form (3 cards) + OpenClawColumn (360w)
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

  // Helpers para mostrar capacidad real desde el contrato o '—' si null.
  const cpuLine = cap.cpuCores
    ? `${cap.cpuCores} cores${cap.cpuThreads ? ` · ${cap.cpuThreads} threads` : ""}`
    : "—";
  const ramLine = cap.memoryGb ? `${cap.memoryGb} GB` : "—";
  const storageLine = cap.storageUsableGb ? `${cap.storageUsableGb} GB usables` : "—";
  const linkLine = cap.networkInterfaces ? `${cap.networkInterfaces} interfaces` : "—";

  // Sección 3 — SOLO datos reales del contrato. El recolector captura AGREGADOS
  // (conteo de interfaces `cap.networkInterfaces`, tamaño del pool `cap.ipPoolSize`)
  // y el onboarding declara `domainsCount`/`totalIps` en inputSummary. NO existe un
  // desglose por-interfaz (inputSummary solo trae serverModel/proxmoxStatus/totalIps/
  // domainsCount/targetDailyVolume/autonomyMode), así que no se inventan filas
  // BOND0/ETH2/IPMI con una topología que el sistema nunca capturó.
  const domainsCount = typeof known["domainsCount"] === "number" ? (known["domainsCount"] as number) : null;
  const totalIps = typeof known["totalIps"] === "number" ? (known["totalIps"] as number) : null;
  const poolSize = cap.ipPoolSize ?? totalIps;
  const interfacesCount = cap.networkInterfaces ?? null;
  const hasNetworkFacts =
    (interfacesCount ?? 0) > 0 || poolSize !== null || domainsCount !== null;

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {/* Sección 1 — Identidad (datos reales de physicalHost.identity + operatingNorth) */}
      <SectionCard
        icon={<ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 1"
        title="Identidad del servidor"
        pillTone="neutral"
        pillText="campos requeridos"
      >
        <FieldRow label="HOSTNAME" value={ph.identity.label || knownStr("hostname", "—")} />
        <FieldRow label="DATACENTER" value={ph.identity.location || knownStr("datacenter", "—")} />
        <FieldRow label="ROL" value={on.delivrixRole || knownStr("role", "—")} />
        <FieldRow
          label="ENTORNO"
          value={on.environment || data.onboardingState.environment || knownStr("environment", "—")}
        />
      </SectionCard>

      {/* Sección 2 — Inventario de cómputo (capacidad real desde el contrato) */}
      <SectionCard
        icon={<Cpu size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 2"
        title="Inventario de cómputo"
        pillTone="neutral"
        pillText="detectado por el recolector"
      >
        <FieldRow label="CPU" value={cpuLine} badge={cap.cpuCores ? "DETECTADO" : undefined} />
        <FieldRow label="MEMORIA RAM" value={ramLine} badge={cap.memoryGb ? "DETECTADO" : undefined} />
        <FieldRow label="ALMACENAMIENTO" value={storageLine} badge={cap.storageUsableGb ? "DETECTADO" : undefined} />
        <FieldRow label="ENLACE PRIMARIO" value={linkLine} badge={cap.networkInterfaces ? "DETECTADO" : undefined} />
      </SectionCard>

      {/* Sección 3 — Red y direccionamiento (agregados reales del contrato; sin
          topología por-interfaz inventada). Empty-state honesto si no hay dato. */}
      <SectionCard
        icon={<Network size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 3"
        title="Red y direccionamiento"
        pillTone="neutral"
        pillText={
          interfacesCount !== null
            ? `${interfacesCount} interfaz${interfacesCount === 1 ? "" : "es"} detectada${interfacesCount === 1 ? "" : "s"}`
            : "sin datos de red"
        }
      >
        {hasNetworkFacts ? (
          <>
            <FieldRow
              label="INTERFACES DE RED"
              value={interfacesCount !== null ? `${interfacesCount}` : "—"}
              badge={interfacesCount !== null ? "DETECTADO" : undefined}
            />
            <FieldRow
              label="POOL DE IPs"
              value={poolSize !== null ? `${poolSize} IPs` : "—"}
              badge={cap.ipPoolSize !== null && cap.ipPoolSize !== undefined ? "DETECTADO" : undefined}
            />
            <FieldRow
              label="DOMINIOS DECLARADOS"
              value={domainsCount !== null ? `${domainsCount}` : "—"}
            />
          </>
        ) : (
          <div className="sm:col-span-2">
            <EmptyState
              title="Sin datos de red capturados aún"
              body="El recolector todavía no reporta interfaces, pool de IPs ni dominios para este servidor. El desglose por-interfaz (bonding, gestión, IPMI) no forma parte del snapshot actual."
              action={<MonoCode>{READ_ENDPOINTS.openClawOnboardingState}</MonoCode>}
            />
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function SectionCard({
  icon,
  kicker,
  title,
  pillTone,
  pillText,
  children
}: {
  icon: React.ReactNode;
  kicker: string;
  title: string;
  pillTone: "neutral" | "success" | "warning" | "critical" | "info" | "accent";
  pillText: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col" style={{ gap: 18, padding: 20 }}>
      {/* SecHead */}
      <header className="flex items-center justify-between" style={{ gap: 10 }}>
        <div className="flex items-center" style={{ gap: 10 }}>
          {/* tile NEUTRO del molde (KpiCard): sin relleno semántico decorativo.
              El color/estado vive en el Pill y en los badges por campo, no en el ícono. */}
          <span
            aria-hidden="true"
            className="grid place-items-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "color-mix(in srgb, var(--color-text-primary) 5%, transparent)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)"
            }}
          >
            {icon}
          </span>
          <div className="flex flex-col" style={{ gap: 2 }}>
            <Eyebrow>{kicker}</Eyebrow>
            <h3 className="m-0 text-[16px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
              {title}
            </h3>
          </div>
        </div>
        <Pill tone={pillTone}>{pillText}</Pill>
      </header>

      {/* Field rows in 2 columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 16 }}>
        {children}
      </div>
    </Card>
  );
}

function FieldRow({ label, value, badge }: { label: string; value: string; badge?: string }) {
  return (
    <div className="flex flex-col min-w-0" style={{ gap: 6 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <Eyebrow>{label}</Eyebrow>
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
        style={{
          padding: "12px 10px",
          borderRadius: 8,
          background: "var(--color-surface-sunken)",
          border: "1px solid var(--color-border)"
        }}
      >
        <span className="text-[13px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)] break-words [overflow-wrap:anywhere]">{value}</span>
      </div>
    </div>
  );
}

/* ============================================================
 * OpenClawColumn (360w) — Advisor gradient del molde
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

/**
 * OpenClawCard — superficie Advisor del molde (AdvisorCard: gradient + sparkle).
 * Los CTAs conservan la funcionalidad real: pre-llenan el chat OpenClaw vía
 * useOpenClawIntent (SSH bridge ya cableado), no son botones muertos.
 */
function OpenClawCard({ unknownsCount, blockers }: { unknownsCount: number; blockers: number }) {
  const { sendIntent } = useOpenClawIntent();
  const { toast } = useToast();

  const title =
    blockers > 0
      ? `${blockers} bloqueo${blockers === 1 ? "" : "s"} en onboarding`
      : unknownsCount > 0
        ? `${unknownsCount} campo${unknownsCount === 1 ? "" : "s"} sin completar`
        : "Inventario completo";
  const body =
    blockers > 0
      ? `Tengo ${blockers} bloqueo${blockers === 1 ? "" : "s"} pendiente${blockers === 1 ? "" : "s"}. ¿Quieres que resuma el más crítico antes del gate?`
      : unknownsCount > 0
        ? `Detecté ${unknownsCount} campo${unknownsCount === 1 ? "" : "s"} sin completar en tu inventario. ¿Quieres que resuma lo que falta antes del gate de cumplimiento?`
        : "Inventario completo. Puedo proponer el plan de topología cuando lo autorices.";

  const send = (label: string) => {
    const prompt = `Acción del operador: ${label}.\n\nContexto del onboarding: ${title} · ${body}\n\nPor favor tráeme la evidencia o la recomendación ordenada por impacto, y dime qué decisión humana necesitas antes del gate. Cita los snapshots y eventos del audit chain.`;
    sendIntent(prompt, `onboarding:${label}`);
    toast.info(`Enviando a OpenClaw · ${label}`, {
      description: "Prompt pre-llenado en el chat. Revisa y presiona Enter para ejecutar.",
      duration: 2500
    });
  };

  return (
    <AdvisorCard>
      <div style={{ padding: 18 }}>
        <div className="flex items-center" style={{ gap: 9 }}>
          <div
            aria-hidden="true"
            className="grid place-items-center"
            style={{ width: 30, height: 30, borderRadius: 9, background: aivoraGradient }}
          >
            <Sparkles size={16} color="var(--color-accent-fg)" />
          </div>
          <div className="text-[14.5px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)]">
            Advisor · OpenClaw
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            borderLeft: "2px solid var(--color-accent)",
            paddingLeft: 12
          }}
        >
          <div className="text-[13.5px] font-[family-name:var(--font-sans)] font-semibold leading-snug text-[var(--color-text-primary)]">
            {title}
          </div>
          <div
            className="text-[13px] font-[family-name:var(--font-body)] text-[var(--color-text-secondary)]"
            style={{ marginTop: 4, lineHeight: 1.5 }}
          >
            {body}
          </div>
          <div className="flex flex-wrap items-center" style={{ gap: 6, marginTop: 10 }}>
            {blockers > 0 ? (
              <Pill tone="critical">{blockers} bloqueo{blockers === 1 ? "" : "s"}</Pill>
            ) : null}
            <Pill tone={unknownsCount > 0 ? "neutral" : "success"}>
              {unknownsCount > 0 ? `${unknownsCount} campo${unknownsCount === 1 ? "" : "s"} sin completar` : "inventario completo"}
            </Pill>
          </div>
        </div>

        <div className="flex flex-wrap items-center" style={{ gap: 8, marginTop: 14 }}>
          <button
            type="button"
            onClick={() => send("Revisar recomendación")}
            className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              gap: 6,
              padding: "8px 14px",
              borderRadius: 10,
              background: aivoraGradient,
              color: "var(--color-accent-fg)",
              fontSize: 13,
              border: "none",
              cursor: "pointer"
            }}
          >
            Revisar recomendación
            <ArrowRight size={13} strokeWidth={2.25} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => send("Ver evidencia")}
            className="inline-flex items-center font-[family-name:var(--font-caption)] font-medium leading-none transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              fontSize: 13,
              cursor: "pointer"
            }}
          >
            Ver evidencia
          </button>
        </div>
      </div>
    </AdvisorCard>
  );
}

/**
 * OpenClawMeta — hermana OSCURA del Advisor: en modo claro va `ink` para que la
 * columna derecha (Advisor + Meta) forme UN bloque negro cohesivo (borde derecho
 * del marco), no una card oscura suelta flotando entre las claras del formulario.
 * En modo oscuro no cambia nada.
 */
function OpenClawMeta() {
  return (
    <Card ink className="flex flex-col" style={{ gap: 8, padding: 14 }}>
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
    </Card>
  );
}

/* ============================================================
 * GatesHead + GatesStrip
 * ============================================================ */
function GatesHead() {
  return (
    <SectionHead
      eyebrow="Validaciones y gates"
      title="Pendientes humanas antes de habilitar el servidor para envío"
    />
  );
}

type GateTone = "success" | "warning" | "critical" | "info" | "neutral";

interface GateStatus {
  tone: GateTone;
  title: string;
  pillText: string;
  desc: string;
}

const GATE_TONE_STYLE: Record<GateTone, { bg: string; color: string }> = {
  success: { bg: "var(--color-success-soft)", color: "var(--color-success)" },
  warning: { bg: "var(--color-warning-soft)", color: "var(--color-warning)" },
  critical: { bg: "var(--color-critical-soft)", color: "var(--color-critical)" },
  info: { bg: "var(--color-info-soft)", color: "var(--color-info)" },
  neutral: { bg: "var(--color-unknown-soft)", color: "var(--color-unknown)" }
};

/**
 * Deriva el estado real de un gate desde el contrato: si hay un blocker que lo
 * afecta, si el readiness de su categoría está completo (100), a medias, o si el
 * contrato aún no reporta readiness para esa categoría. NUNCA afirma "no validado"
 * sin evidencia: cuando no hay dato, el estado es "sin evaluar" (neutral).
 */
function resolveGate(opts: {
  label: string;
  readiness: number | undefined;
  hasBlocker: boolean;
  copy: { validated: string; pending: string; blocked: string; unknown: string };
}): GateStatus {
  const { label, readiness, hasBlocker, copy } = opts;
  if (hasBlocker) {
    return { tone: "critical", title: `${label} bloqueado`, pillText: "bloqueado", desc: copy.blocked };
  }
  if (typeof readiness !== "number" || !Number.isFinite(readiness)) {
    return { tone: "neutral", title: `${label} sin evaluar`, pillText: "sin datos", desc: copy.unknown };
  }
  if (readiness >= 100) {
    return { tone: "success", title: `${label} validado`, pillText: "validado", desc: copy.validated };
  }
  // Readiness parcial = "en progreso" → tono INFO (cyan). El slot `warning` (ámbar)
  // queda reservado EXCLUSIVAMENTE a PAUSED (doc §3, cero ámbar fuera de paused);
  // un readiness a medias no es un estado "pausado".
  return { tone: "info", title: `${label} en validación`, pillText: `${Math.round(readiness)}%`, desc: copy.pending };
}

function GatesStrip({ data }: { data: DashboardData }) {
  const readiness = data.onboardingState.readinessByCategory ?? {};
  const blockers = data.onboardingState.blockers ?? [];
  const hasBlocker = (...terms: string[]) =>
    blockers.some((b) => terms.some((t) => b.toLowerCase().includes(t)));

  const compliance = resolveGate({
    label: "Cumplimiento",
    readiness: readiness.compliance,
    hasBlocker: hasBlocker("compliance", "opt_out", "suppression", "consent", "physical_address", "authorization"),
    copy: {
      validated: "Un revisor humano firmó el cumplimiento de políticas y quedó registrada la evidencia.",
      pending: "A la espera de que un revisor humano firme el cumplimiento de políticas y registre la evidencia.",
      blocked: "Hay bloqueos de cumplimiento que deben resolverse antes de firmar el gate.",
      unknown: "El contrato aún no reporta readiness de cumplimiento para este servidor."
    }
  });
  const dns = resolveGate({
    label: "DNS",
    readiness: readiness.dns,
    hasBlocker: hasBlocker("dns"),
    copy: {
      validated: "Las zonas y registros están verificados contra los resolvers internos del clúster de envío.",
      pending: "Las zonas y registros aún no se verifican contra los resolvers internos del clúster de envío.",
      blocked: "Hay bloqueos de DNS que impiden habilitar el servidor para envío.",
      unknown: "El contrato aún no reporta readiness de DNS para este servidor."
    }
  });

  // SSH no tiene categoría de readiness propia en el contrato; su gate se deriva
  // solo del blocker declarado. El estado por defecto describe el proceso estándar
  // (autorización manual en cada alta) sin afirmar que el acceso esté hoy denegado.
  const sshBlocked = hasBlocker("ssh");
  const ssh: GateStatus = sshBlocked
    ? {
      tone: "critical",
      title: "Acceso SSH bloqueado",
      pillText: "bloqueado",
      desc: "Hay un bloqueo de SSH declarado en el onboarding; requiere resolución del operador con rol elevado."
    }
    : {
      tone: "info",
      title: "Acceso SSH · autorización manual",
      pillText: "autorizar manualmente",
      desc: "El acceso SSH de OpenClaw requiere autorización manual del operador con rol elevado en cada alta de servidor."
    };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 20 }}>
      <GateCard
        iconBg={GATE_TONE_STYLE[compliance.tone].bg}
        iconColor={GATE_TONE_STYLE[compliance.tone].color}
        icon={<ShieldCheck size={18} strokeWidth={1.75} aria-hidden="true" />}
        title={compliance.title}
        pillTone={compliance.tone}
        pillText={compliance.pillText}
        desc={compliance.desc}
      />
      <GateCard
        iconBg={GATE_TONE_STYLE[dns.tone].bg}
        iconColor={GATE_TONE_STYLE[dns.tone].color}
        icon={<Network size={18} strokeWidth={1.75} aria-hidden="true" />}
        title={dns.title}
        pillTone={dns.tone}
        pillText={dns.pillText}
        desc={dns.desc}
      />
      <GateCard
        iconBg={GATE_TONE_STYLE[ssh.tone].bg}
        iconColor={GATE_TONE_STYLE[ssh.tone].color}
        icon={<KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />}
        title={ssh.title}
        pillTone={ssh.tone}
        pillText={ssh.pillText}
        desc={ssh.desc}
      />
    </div>
  );
}

function GateCard({
  iconBg,
  iconColor,
  icon,
  title,
  pillTone,
  pillText,
  desc
}: {
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  title: string;
  pillTone: "neutral" | "success" | "warning" | "critical" | "info" | "accent";
  pillText: string;
  desc: string;
}) {
  return (
    <Card className="flex" style={{ gap: 14, padding: 16 }}>
      <span
        aria-hidden="true"
        className="grid place-items-center shrink-0"
        style={{ width: 36, height: 36, borderRadius: 8, background: iconBg, color: iconColor }}
      >
        {icon}
      </span>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 4 }}>
        <header className="flex items-center" style={{ gap: 8 }}>
          <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            {title}
          </h3>
          <span className="flex-1" aria-hidden="true" />
          <Pill tone={pillTone}>
            {pillText}
          </Pill>
        </header>
        <p className="m-0 text-[12px] font-[family-name:var(--font-caption)] leading-[1.45] text-[var(--color-text-secondary)]">
          {desc}
        </p>
      </div>
    </Card>
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
    <Card
      className="flex flex-wrap items-center"
      style={{ gap: 12, padding: "14px 18px", justifyContent: "space-between" }}
    >
      <Button type="button" variant="ghost" size="md" onClick={handleExport}>
        <Save size={14} strokeWidth={1.75} aria-hidden="true" />
        Exportar snapshot
      </Button>

      <div className="flex flex-wrap items-center" style={{ gap: 12 }}>
        {blockers > 0 ? (
          <Pill tone="critical">
            <Lock size={12} strokeWidth={1.75} aria-hidden="true" />
            {blockers} bloqueo{blockers === 1 ? "" : "s"} · {unknowns} campo{unknowns === 1 ? "" : "s"} sin completar
          </Pill>
        ) : (
          <Pill tone="success">
            <CheckCircle2 size={12} strokeWidth={1.75} aria-hidden="true" />
            Sin bloqueos · listo para evaluación
          </Pill>
        )}
        <Button type="button" variant="ghost" size="md" onClick={() => void handleRefresh()}>
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          Refrescar estado
        </Button>
        <Button
          type="button"
          variant="primary"
          size="md"
          onClick={() => evaluateMutation.mutate()}
          disabled={!canEvaluate || evaluateMutation.isPending}
        >
          <Send size={14} strokeWidth={1.75} aria-hidden="true" />
          {evaluateMutation.isPending ? "Enviando…" : "Solicitar evaluación a OpenClaw"}
        </Button>
      </div>
    </Card>
  );
}
