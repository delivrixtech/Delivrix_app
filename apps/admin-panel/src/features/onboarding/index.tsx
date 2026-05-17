/**
 * Onboarding feature — wizard del servidor de envio.
 *
 * Pencil frame `T9osf` (Onboarding Wizard). Estructura:
 *   1. PageHeader (eyebrow + title + description).
 *   2. Stepper horizontal de 6 pasos (servidor / IPs / identidad / conexion /
 *      DNS / lanzamiento) tone'd por `onboardingState.readinessByCategory`.
 *   3. Trio de Cards de inventario read-only:
 *      - Hardware del servidor (de `physicalHost.identity` + `capacity`).
 *      - Inventario de campos (de `pendingQuestions`).
 *      - Interfaces de red (de `physicalHost.capacity.networkInterfaces`).
 *   4. OpenClawPromptPanel (un mensaje guiado por `blockers`/`warnings`).
 *   5. Trio de status cards (cumplimiento / TPS / SDR) consumiendo
 *      `operatingNorth.allowedActions` y `gates` cuando aplica.
 *
 * El frontend NO decide cuando esta listo un paso — solo lee
 * `readinessByCategory` (un map<categoria, 0..1>) y mapea a status.
 */

import { AlertTriangle, ArrowUpRight, CheckCircle2, ShieldAlert } from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatMetricValue,
  formatNumber,
  humanize,
  stateTone,
  type Tone
} from "../../shared/lib/formatters.ts";
import {
  Badge as UiBadge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DefinitionList,
  Eyebrow,
  NoticeBanner,
  OpenClawPromptPanel,
  PageHeader,
  Stepper,
  type StepStatus,
  type StepperStep
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

/**
 * Pasos canonicos del onboarding. El orden y los kickers son del frontend
 * (UX), el status se deriva del payload (`readinessByCategory`).
 */
interface CanonicalStep {
  category: string;
  kicker: string;
  title: string;
  description: string;
}

const CANONICAL_STEPS: CanonicalStep[] = [
  {
    category: "server",
    kicker: "Paso 1",
    title: "Servidor",
    description: "Identidad y capacidad del host fisico."
  },
  {
    category: "ips",
    kicker: "Paso 2",
    title: "IPs",
    description: "Pool dedicado y reputacion inicial."
  },
  {
    category: "identity",
    kicker: "Paso 3",
    title: "Identidad",
    description: "Marca, dominios y senders permitidos."
  },
  {
    category: "network",
    kicker: "Paso 4",
    title: "Conexion",
    description: "Interfaces de red e ingreso supervisado."
  },
  {
    category: "dns",
    kicker: "Paso 5",
    title: "DNS",
    description: "Registros SPF / DKIM / DMARC validados."
  },
  {
    category: "launch",
    kicker: "Paso 6",
    title: "Lanzamiento",
    description: "Gate del norte operativo y compromiso humano."
  }
];

function readinessToStatus(score: number | undefined, hasBlocker: boolean): StepStatus {
  if (hasBlocker) return "blocked";
  if (score === undefined) return "pending";
  if (score >= 1) return "ready";
  if (score > 0) return "in_progress";
  return "pending";
}

/** Match laxo: la categoria del payload puede llegar como `server`, `Server`,
 *  `hardware.server`, etc. Compara minusculas y prefijos. */
function findReadinessFor(category: string, readinessByCategory: Record<string, number>): number | undefined {
  const normalized = category.toLowerCase();
  for (const [key, value] of Object.entries(readinessByCategory)) {
    if (key.toLowerCase() === normalized) return value;
    if (key.toLowerCase().includes(normalized)) return value;
  }
  return undefined;
}

function blockersForCategory(category: string, blockers: string[]): string[] {
  const normalized = category.toLowerCase();
  return blockers.filter((blocker) => blocker.toLowerCase().includes(normalized));
}

export function OnboardingSection({ data }: { data: DashboardData }) {
  const onboarding = data.onboardingState;
  const physicalHost = data.physicalHost;
  const operatingNorth = data.operatingNorth;
  const identity = physicalHost.identity;
  const capacity = physicalHost.capacity;
  const pendingQuestions = onboarding.pendingQuestions;
  const blockers = onboarding.blockers;
  const warnings = onboarding.warnings;
  const canGenerate = onboarding.canGenerateTopologyPlan;

  const steps: StepperStep[] = CANONICAL_STEPS.map((step, index) => {
    const readiness = findReadinessFor(step.category, onboarding.readinessByCategory);
    const hasBlocker = blockersForCategory(step.category, blockers).length > 0;
    return {
      id: step.category,
      order: index + 1,
      kicker: step.kicker,
      title: step.title,
      description: step.description,
      status: readinessToStatus(readiness, hasBlocker)
    };
  });

  const hardwareFields: Array<{ label: string; value: string }> = [
    { label: "Host", value: identity.label || "unknown" },
    { label: "Vendor", value: identity.vendor || "unknown" },
    { label: "Modelo", value: identity.model || "unknown" },
    { label: "CPU cores", value: formatMetricValue(capacity.cpuCores, "cores") },
    { label: "Memoria", value: formatMetricValue(capacity.memoryGb, "GB") },
    { label: "Storage", value: formatMetricValue(capacity.storageUsableGb, "GB") }
  ];

  const knownInputCount = Object.keys(onboarding.knownInputs).length;
  const pendingCount = pendingQuestions.length;
  const totalFields = knownInputCount + pendingCount;
  const fieldsCompleteness = totalFields === 0 ? 0 : Math.round((knownInputCount / totalFields) * 100);

  return (
    <section className="flex flex-col gap-6 max-w-[1280px]">
      <PageHeader
        eyebrow={getSection("onboarding").eyebrow}
        title={getSection("onboarding").title}
        description={getSection("onboarding").description}
        badge={{
          label: canGenerate ? "topology plan ready" : "topology plan pending",
          tone: canGenerate ? "success" : "warning"
        }}
        endpoint={formatEndpointBadge(getSection("onboarding").endpoint)}
      />

      {blockers.length > 0 ? (
        <NoticeBanner
          tone="critical"
          title={`${formatNumber(blockers.length)} bloqueos en el onboarding`}
          description="Resolverlos antes de generar el plan de topologia. Cada uno detiene OpenClaw."
        />
      ) : warnings.length > 0 ? (
        <NoticeBanner
          tone="warning"
          title={`${formatNumber(warnings.length)} advertencias del onboarding`}
          description="No bloquean, pero conviene revisar antes de avanzar al gate de lanzamiento."
        />
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <CardTitle>Pasos del wizard</CardTitle>
            <span className="text-[11px] font-[family-name:var(--font-caption)] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              {steps.filter((s) => s.status === "ready").length} / {steps.length} listos
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <Stepper steps={steps} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-3 items-start">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card>
            <CardHeader>
              <Eyebrow>Inventario</Eyebrow>
              <CardTitle className="mt-1">Hardware del servidor</CardTitle>
            </CardHeader>
            <CardContent>
              <DefinitionList density="compact" rows={hardwareFields} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Eyebrow>Inventario</Eyebrow>
              <CardTitle className="mt-1">Campos pendientes</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="m-0 mb-2 text-[12px] text-[var(--color-text-secondary)]">
                {formatNumber(knownInputCount)} capturados / {formatNumber(pendingCount)} faltan
                <span className="ml-1.5 text-[var(--color-text-tertiary)]">({fieldsCompleteness}%)</span>
              </p>
              {pendingQuestions.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">
                  Inventario completo, sin preguntas abiertas.
                </p>
              ) : (
                <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                  {pendingQuestions.slice(0, 5).map((question) => (
                    <li
                      key={question.id}
                      className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-2.5 py-2 text-[12px]"
                    >
                      <UiBadge
                        size="sm"
                        tone={question.priority === "high" ? "critical" : question.priority === "low" ? "neutral" : "warning"}
                      >
                        {compactLabel(question.priority)}
                      </UiBadge>
                      <div className="flex flex-col min-w-0">
                        <code className="m-0 text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)] truncate">
                          {question.fieldPath}
                        </code>
                        <span className="text-[11px] text-[var(--color-text-tertiary)]">
                          {humanize(question.category)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Eyebrow>Inventario</Eyebrow>
              <CardTitle className="mt-1">Interfaces de red</CardTitle>
            </CardHeader>
            <CardContent>
              <DefinitionList
                density="compact"
                rows={[
                  {
                    label: "Interfaces",
                    value: formatNumber(capacity.networkInterfaces ?? 0)
                  },
                  {
                    label: "IP pool",
                    value: formatMetricValue(capacity.ipPoolSize, "IPs")
                  },
                  {
                    label: "Ubicacion",
                    value: identity.location || "unknown"
                  }
                ]}
              />
              <p className="m-0 mt-3 text-[11px] text-[var(--color-text-tertiary)]">
                Detalle por interface vive en la pantalla Hardware.
              </p>
            </CardContent>
          </Card>
        </div>

        <OpenClawPromptPanel
          subtitle="Supervised AI operator"
          message={
            blockers.length > 0
              ? `Tengo ${formatNumber(blockers.length)} bloqueos pendientes en el onboarding. Te paso el siguiente con mas impacto?`
              : warnings.length > 0
                ? `Tengo ${formatNumber(warnings.length)} advertencias activas. Las priorizo o las dejamos para despues del gate?`
                : canGenerate
                  ? "Inventario completo. Puedo proponer el plan de topologia para revisar humanamente."
                  : "Avanzando el inventario sin bloqueos. Cuando completes los campos abiertos genero el plan."
          }
          placeholder="Responde a OpenClaw…"
          ctaLabel="Sugerir siguiente paso"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatusCard
          tone={blockers.length > 0 ? "critical" : "success"}
          icon={blockers.length > 0 ? AlertTriangle : CheckCircle2}
          title="Cumplimiento"
          headline={blockers.length === 0 ? "Sin bloqueos" : `${formatNumber(blockers.length)} bloqueos`}
          microcopy={
            blockers.length === 0
              ? "Norte operativo en read-only — barandillas sostenidas."
              : "Resolver para habilitar generacion de topologia."
          }
          chips={blockers.slice(0, 3)}
        />
        <StatusCard
          tone={canGenerate ? "success" : "warning"}
          icon={canGenerate ? CheckCircle2 : AlertTriangle}
          title="TPS"
          headline={canGenerate ? "Validado" : "No validado"}
          microcopy={
            canGenerate
              ? "El plan de topologia puede generarse cuando el operador autorice."
              : "Capturar los campos pendientes para validar TPS supervisado."
          }
          chips={warnings.slice(0, 3)}
        />
        <StatusCard
          tone={operatingNorth.delivrixSendsRealEmail ? "warning" : "neutral"}
          icon={operatingNorth.delivrixSendsRealEmail ? ShieldAlert : ArrowUpRight}
          title="SDR / autorizacion"
          headline={operatingNorth.delivrixSendsRealEmail ? "Real send enabled" : "Pendiente"}
          microcopy={
            operatingNorth.delivrixSendsRealEmail
              ? "Operador autorizo el envio real. Lanzamiento bajo human-in-the-loop."
              : "El gate sigue cerrado: panel mantiene read-only y SMTP simulado."
          }
          chips={operatingNorth.gates?.slice(0, 3) ?? []}
        />
      </div>
    </section>
  );
}

function StatusCard({
  tone,
  icon: Icon,
  title,
  headline,
  microcopy,
  chips
}: {
  tone: Tone;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string; "aria-hidden"?: boolean }>;
  title: string;
  headline: string;
  microcopy: string;
  chips: string[];
}) {
  const toneStyle = stateTone(tone === "neutral" ? null : tone === "success" ? "success" : tone);
  void toneStyle;
  return (
    <Card tone={tone === "neutral" ? "neutral" : tone}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span
              aria-hidden="true"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)]"
              style={{
                background:
                  tone === "success"
                    ? "var(--color-success-soft)"
                    : tone === "warning"
                      ? "var(--color-warning-soft)"
                      : tone === "critical"
                        ? "var(--color-critical-soft)"
                        : "var(--color-surface-sunken)",
                color:
                  tone === "success"
                    ? "var(--color-success-fg)"
                    : tone === "warning"
                      ? "var(--color-warning-fg)"
                      : tone === "critical"
                        ? "var(--color-critical-fg)"
                        : "var(--color-text-secondary)"
              }}
            >
              <Icon size={14} strokeWidth={1.75} aria-hidden />
            </span>
            <CardTitle>{title}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="m-0 text-[18px] font-[family-name:var(--font-heading)] font-semibold text-[var(--color-text-primary)] leading-tight">
          {headline}
        </p>
        <p className="m-0 mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          {microcopy}
        </p>
        {chips.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <UiBadge
                key={chip}
                size="sm"
                tone={tone === "neutral" ? "outline" : tone}
              >
                {compactLabel(chip)}
              </UiBadge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
