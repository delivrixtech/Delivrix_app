/**
 * Onboarding Wizard — layout basado en Pencil frame `T9osf` / `GygQG`.
 *
 * El layout (colores, padding, iconos) viene del .pen, pero los campos del
 * formulario ya NO son placeholders de Pencil: son display-only de datos reales
 * del contrato (`physicalHost`, `operatingNorth`, `onboardingState`), y muestran
 * "—" cuando el contrato no trae el dato.
 */

import {
  ArrowLeft,
  CheckCircle2,
  Cpu,
  Info,
  KeyRound,
  Lock,
  Network,
  Save,
  Send,
  ShieldAlert,
  ShieldX
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DashboardData } from "../../shared/api/client.ts";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary.ts";
import { useToast } from "../../shared/ui/v2/index.ts";
import { BannerOpenClawV2 } from "../../shared/ui/v2/index.ts";
import { Button, Card, EmptyState, Eyebrow, MonoCode, Pill, SectionHead } from "../../v5/components/primitives";
import { PageHead } from "../../v5/views/_PageHead";

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
    <PageHead
      eyebrow="Paso 1 de 6 · Inventario físico"
      title="Onboarding del servidor de envío"
      body="El asistente captura y valida el servidor físico, sus IPs, dominios, DNS, límites y permisos antes de pedir el visto bueno humano. OpenClaw observa la evidencia y recomienda, pero nunca ejecuta cambios por su cuenta."
    />
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
    <Card asChild padding="none">
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
    </Card>
  );
}

function OnboardingStepsEmptyState() {
  return (
    <Card padding="none" className="flex flex-col">
      <EmptyState
        title="Sin pasos de onboarding disponibles"
        body="El contrato no devolvió categorías de readiness ni preguntas pendientes."
        action={<MonoCode>{READ_ENDPOINTS.openClawOnboardingState}</MonoCode>}
      />
    </Card>
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
        pillTone="warning"
        pillText="campos requeridos"
      >
        <FieldRow label="HOSTNAME" value={ph.identity.label || knownStr("hostname", "—")} />
        <FieldRow label="DATACENTER" value={ph.identity.location || knownStr("datacenter", "—")} />
        <FieldRow label="ROL" value={on.delivrixRole || knownStr("role", "—")} />
        <FieldRow label="ENTORNO" value={data.health.phase || knownStr("environment", "—")} />
      </SectionCard>

      {/* Sección 2 — Inventario de cómputo (capacidad real desde el contrato) */}
      <SectionCard
        iconBg="var(--color-info-soft)"
        iconColor="var(--color-info)"
        icon={<Cpu size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 2"
        title="Inventario de cómputo"
        pillTone="info"
        pillText="detectado por el recolector"
      >
        <FieldRow label="CPU" value={cpuLine} badge={cap.cpuCores ? "DETECTADO" : undefined} />
        <FieldRow label="MEMORIA RAM" value={ramLine} badge={cap.memoryGb ? "DETECTADO" : undefined} />
        <FieldRow label="ALMACENAMIENTO" value={storageLine} badge={cap.storageUsableGb ? "DETECTADO" : undefined} />
        <FieldRow label="ENLACE PRIMARIO" value={linkLine} badge={cap.networkInterfaces ? "DETECTADO" : undefined} />
      </SectionCard>

      {/* Sección 3 — Interfaces de red (knownInputs cuando exista; placeholder cuando falte) */}
      <SectionCard
        iconBg="var(--color-success-soft)"
        iconColor="var(--color-success)"
        icon={<Network size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 3"
        title="Interfaces de red"
        pillTone="success"
        pillText={`${cap.networkInterfaces ?? 0} interfaces declaradas`}
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
    </div>
  );
}

function SectionCard({
  iconBg,
  iconColor,
  icon,
  kicker,
  title,
  pillTone,
  pillText,
  children
}: {
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  kicker: string;
  title: string;
  pillTone: "neutral" | "success" | "warning" | "critical" | "info" | "accent";
  pillText: string;
  children: React.ReactNode;
}) {
  return (
    <Card padding="relaxed" className="flex flex-col" style={{ gap: 18 }}>
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
    <div className="flex flex-col" style={{ gap: 6 }}>
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
    <Card tone="quiet" padding="none" className="flex flex-col" style={{ gap: 8, padding: 14 }}>
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
        pillTone="warning"
        pillText={blockersCount > 0 ? `${blockersCount} bloqueos` : "revisión humana"}
        desc="A la espera de que un revisor humano firme el cumplimiento de políticas y registre la evidencia."
      />
      <GateCard
        iconBg={dnsBlocker ? "var(--color-critical-soft)" : "var(--color-warning-soft)"}
        iconColor={dnsBlocker ? "var(--color-critical)" : "var(--color-warning)"}
        icon={<ShieldX size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="DNS no validado"
        pillTone={dnsBlocker ? "critical" : "warning"}
        pillText={dnsBlocker ? "crítico" : "pendiente"}
        desc="Las zonas y registros aún no se verifican contra los resolvers internos del clúster de envío."
      />
      <GateCard
        iconBg="var(--color-unknown-soft)"
        iconColor="var(--color-unknown)"
        icon={<KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="SSH no autorizado"
        pillTone="info"
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
    <Card padding="none" className="flex" style={{ gap: 14, padding: 16 }}>
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
          <Pill tone={pillTone} dot={false}>
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
      padding="none"
      className="flex flex-wrap items-center"
      style={{ gap: 12, padding: "14px 18px", justifyContent: "space-between" }}
    >
      <Button type="button" variant="ghost" size="md" onClick={handleExport}>
        <Save size={14} strokeWidth={1.75} aria-hidden="true" />
        Exportar snapshot
      </Button>

      <div className="flex flex-wrap items-center" style={{ gap: 12 }}>
        {blockers > 0 ? (
          <Pill tone="warning" dot={false}>
            <Lock size={12} strokeWidth={1.75} aria-hidden="true" />
            {blockers} bloqueo{blockers === 1 ? "" : "s"} · {unknowns} campo{unknowns === 1 ? "" : "s"} sin completar
          </Pill>
        ) : (
          <Pill tone="success" dot={false}>
            <CheckCircle2 size={12} strokeWidth={1.75} aria-hidden="true" />
            Sin bloqueos · listo para evaluación
          </Pill>
        )}
        <Button type="button" variant="secondary" size="md" onClick={() => void handleRefresh()}>
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
