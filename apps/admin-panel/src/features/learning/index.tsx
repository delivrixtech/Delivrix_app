/**
 * Learning feature: signals de readiness + stages del plan de aprendizaje
 * supervisado + gobierno del modelo.
 *
 * Microcopy de Self promote / Human approval sale de `learningCopy` para que
 * la UI no decida si auto-promover es bueno o malo: lo dice el dominio.
 */

import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatNumber,
  humanize,
  stateTone
} from "../../shared/lib/formatters.ts";
import {
  learningCopy,
  pickBinary
} from "../../shared/lib/domain-state-copy.ts";
import { cn } from "../../shared/lib/cn.ts";
import {
  Badge as UiBadge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DefinitionList,
  MetricCard as UiMetricCard,
  PageHeader
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

export function LearningSection({ data }: { data: DashboardData }) {
  const canSelfPromote = data.readinessSignals.modelGovernance.canSelfPromote;
  const requiresHumanApproval = data.readinessSignals.modelGovernance.requiresHumanApproval;
  const modelMode = data.readinessSignals.modelGovernance.modelMode;
  const modelVersion = data.readinessSignals.modelGovernance.modelVersion;
  const promptVersion = data.readinessSignals.modelGovernance.promptVersion;
  const stages = data.learningPlan.stages;
  const scores = data.readinessSignals.scores;
  const totalSignals = Object.keys(scores).length;
  const readyStages = stages.filter((stage) => stateTone(stage.status) === "success").length;

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow={getSection("learning").eyebrow}
        title={getSection("learning").title}
        description={getSection("learning").description}
        badge={{ label: compactLabel(data.learningPlan.mode), tone: "neutral" }}
        endpoint={formatEndpointBadge(getSection("learning").endpoint)}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <UiMetricCard
          label="Stages"
          value={formatNumber(stages.length)}
          microcopy={`${formatNumber(readyStages)} listos`}
          microcopyTone={readyStages > 0 ? "success" : "neutral"}
        />
        <UiMetricCard
          label="Signals"
          value={formatNumber(totalSignals)}
          microcopy="Readiness scores"
          microcopyTone="neutral"
        />
        <UiMetricCard
          label="Self promote"
          value={canSelfPromote ? "Enabled" : "Blocked"}
          microcopy={pickBinary(learningCopy.canSelfPromote, canSelfPromote).copy}
          microcopyTone={pickBinary(learningCopy.canSelfPromote, canSelfPromote).tone}
        />
        <UiMetricCard
          label="Human approval"
          value={requiresHumanApproval ? "Required" : "Optional"}
          microcopy={pickBinary(learningCopy.requiresHumanApproval, requiresHumanApproval).copy}
          microcopyTone={pickBinary(learningCopy.requiresHumanApproval, requiresHumanApproval).tone}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Readiness signals</CardTitle>
              <UiBadge tone="outline">{compactLabel(modelMode)}</UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            {Object.keys(scores).length === 0 ? (
              <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">Sin signals registrados.</p>
            ) : (
              <ul className="m-0 p-0 list-none flex flex-col gap-2">
                {Object.entries(scores).map(([key, score]) => {
                  const tone = stateTone(score.status);
                  const dotColor =
                    tone === "success" ? "var(--color-success)" :
                    tone === "warning" ? "var(--color-warning)" :
                    tone === "critical" ? "var(--color-critical)" :
                    "var(--color-text-tertiary)";
                  return (
                    <li
                      key={key}
                      className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2.5"
                    >
                      <div className="min-w-0 flex items-start gap-2.5">
                        <span aria-hidden="true" className="block h-2 w-2 rounded-full mt-1.5 shrink-0" style={{ background: dotColor }} />
                        <div className="min-w-0">
                          <p className="m-0 text-[13px] text-[var(--color-text-primary)]">{humanize(key)}</p>
                          <p className="m-0 mt-0.5 text-[11px] text-[var(--color-text-secondary)]">{compactLabel(score.reason)}</p>
                        </div>
                      </div>
                      <span className="text-[13px] font-medium tabular-nums text-[var(--color-text-primary)]">
                        {score.score === null ? "—" : `${Math.round(score.score * 100)}%`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Stages</CardTitle>
              <UiBadge tone="outline">{formatNumber(stages.length)}</UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            {stages.length === 0 ? (
              <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">Sin stages registradas.</p>
            ) : (
              <ol className="m-0 p-0 list-none flex flex-col gap-2">
                {stages.map((stage) => {
                  const tone = stateTone(stage.status);
                  const numberBg =
                    tone === "success" ? "bg-[var(--color-success-soft)] text-[var(--color-success-fg)]" :
                    tone === "warning" ? "bg-[var(--color-warning-soft)] text-[var(--color-warning-fg)]" :
                    tone === "critical" ? "bg-[var(--color-critical-soft)] text-[var(--color-critical-fg)]" :
                    "bg-[var(--color-surface-sunken)] text-[var(--color-text-secondary)]";
                  return (
                    <li
                      key={stage.id}
                      className={cn(
                        "flex items-start gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2.5",
                        tone === "success" && "border-l-2 border-l-[var(--color-success)]",
                        tone === "warning" && "border-l-2 border-l-[var(--color-warning)]",
                        tone === "critical" && "border-l-2 border-l-[var(--color-critical)]"
                      )}
                    >
                      <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-medium tabular-nums", numberBg)}>
                        {stage.order}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="m-0 text-[13px] text-[var(--color-text-primary)]">
                          {stage.title ?? stage.label ?? humanize(stage.id)}
                        </p>
                      </div>
                      <UiBadge size="sm" tone={tone === "neutral" ? "neutral" : tone}>
                        {compactLabel(stage.status)}
                      </UiBadge>
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between gap-3">
            <CardTitle>Gobierno del modelo</CardTitle>
            <UiBadge tone="outline">read-only</UiBadge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <DefinitionList
              density="compact"
              rows={[
                { label: "Model mode", value: compactLabel(modelMode) },
                { label: "Model version", value: modelVersion, mono: true },
                { label: "Prompt version", value: promptVersion, mono: true }
              ]}
            />
            <DefinitionList
              density="compact"
              rows={[
                { label: "Self promote", value: canSelfPromote ? "enabled" : "blocked" },
                { label: "Human approval", value: requiresHumanApproval ? "required" : "optional" }
              ]}
            />
            <div>
              <p className="m-0 mb-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">Barandillas</p>
              <p className="m-0 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                {canSelfPromote
                  ? "Riesgo: el modelo puede auto-promoverse sin revision."
                  : "El modelo nunca se auto-promueve. Solo evidencia curada y aprobacion humana."}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
