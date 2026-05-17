/**
 * Workflow (Ruta) feature: secuencia ordenada de pasos del operador.
 *
 * Tally global + filter chips (Todos / Pendientes / Bloqueados) operan sobre
 * stateTone derivado del contrato. statusReason vive elevado bajo el titulo de
 * cada step. La frontera de lectura se renderiza al pie consumiendo
 * `workflow.readBoundary.allowedEndpoints`.
 */

import { useMemo, useState } from "react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatNumber,
  stateTone
} from "../../shared/lib/formatters.ts";
import { cn } from "../../shared/lib/cn.ts";
import {
  Badge as UiBadge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

type WorkflowFilter = "all" | "pending" | "blocked";

function WorkflowTally({ label, value, dotColor }: { label: string; value: number; dotColor: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]">
      <span aria-hidden="true" className="block h-2 w-2 rounded-full" style={{ background: dotColor }} />
      <span className="tabular-nums font-medium text-[var(--color-text-primary)]">{formatNumber(value)}</span>
      <span>{label}</span>
    </span>
  );
}

function WorkflowFilterChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1 text-[12px] transition-colors",
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-medium"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-[11px] text-[var(--color-text-tertiary)]">{formatNumber(count)}</span>
    </button>
  );
}

function WorkflowTokenGroup({ label, items, mono }: { label: string; items: string[]; mono?: boolean }) {
  return (
    <div>
      <p className="m-0 mb-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">{label}</p>
      {items.length === 0 ? (
        <p className="m-0 text-[12px] text-[var(--color-text-tertiary)]">Sin items.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) =>
            mono ? (
              <code
                key={item}
                className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-2 py-0.5 text-[11px] font-mono text-[var(--color-text-secondary)]"
              >
                {item}
              </code>
            ) : (
              <UiBadge key={item} tone="neutral">{compactLabel(item)}</UiBadge>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function WorkflowSection({ data }: { data: DashboardData }) {
  const [filter, setFilter] = useState<WorkflowFilter>("all");

  const tally = useMemo(() => {
    const counts = { ready: 0, needsReview: 0, blocked: 0, notStarted: 0 };
    for (const step of data.workflow.steps) {
      const tone = stateTone(step.status);
      if (tone === "success") counts.ready += 1;
      else if (tone === "warning") counts.needsReview += 1;
      else if (tone === "critical") counts.blocked += 1;
      else counts.notStarted += 1;
    }
    return counts;
  }, [data.workflow.steps]);

  const filteredSteps = useMemo(() => {
    if (filter === "all") return data.workflow.steps;
    if (filter === "blocked") {
      return data.workflow.steps.filter((step) => stateTone(step.status) === "critical");
    }
    return data.workflow.steps.filter((step) => {
      const tone = stateTone(step.status);
      return tone === "warning" || tone === "neutral" || tone === "critical";
    });
  }, [data.workflow.steps, filter]);

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow={getSection("workflow").eyebrow}
        title={getSection("workflow").title}
        description={getSection("workflow").description}
        badge={{ label: compactLabel(data.workflow.mode), tone: "neutral" }}
        endpoint={formatEndpointBadge(getSection("workflow").endpoint)}
      />

      <Card>
        <CardContent className="px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <WorkflowTally label="Listos" value={tally.ready} dotColor="var(--color-success)" />
              <span className="text-[12px] text-[var(--color-text-tertiary)]">·</span>
              <WorkflowTally label="En revision" value={tally.needsReview} dotColor="var(--color-warning)" />
              <span className="text-[12px] text-[var(--color-text-tertiary)]">·</span>
              <WorkflowTally label="Bloqueados" value={tally.blocked} dotColor="var(--color-critical)" />
              <span className="text-[12px] text-[var(--color-text-tertiary)]">·</span>
              <WorkflowTally label="No iniciados" value={tally.notStarted} dotColor="var(--color-text-tertiary)" />
            </div>
            <div className="flex items-center gap-1">
              <WorkflowFilterChip label="Todos" count={data.workflow.steps.length} active={filter === "all"} onClick={() => setFilter("all")} />
              <WorkflowFilterChip label="Pendientes" count={tally.needsReview + tally.blocked + tally.notStarted} active={filter === "pending"} onClick={() => setFilter("pending")} />
              <WorkflowFilterChip label="Bloqueados" count={tally.blocked} active={filter === "blocked"} onClick={() => setFilter("blocked")} />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {filteredSteps.length === 0 ? (
          <Card>
            <CardContent className="px-5 py-8 text-center">
              <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">
                Sin pasos en este filtro.
              </p>
            </CardContent>
          </Card>
        ) : (
          filteredSteps.map((step) => {
            const tone = stateTone(step.status);
            return (
              <Card key={step.id} tone={tone === "neutral" ? "neutral" : tone}>
                <CardContent className="px-5 py-4">
                  <div className="flex items-start gap-4">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] text-[13px] font-medium text-[var(--color-text-secondary)] tabular-nums">
                      {step.order}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="m-0 text-[15px] font-medium text-[var(--color-text-primary)]">{step.title}</h3>
                          <p className="m-0 mt-1 text-[12px] text-[var(--color-text-secondary)]">
                            {step.statusReason}
                          </p>
                        </div>
                        <UiBadge tone={tone === "neutral" ? "neutral" : tone}>{compactLabel(step.status)}</UiBadge>
                      </div>
                      <p className="m-0 mt-3 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                        {step.operatorQuestion}
                      </p>
                      <p className="m-0 mt-2 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
                        {step.purpose}
                      </p>
                      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                        <WorkflowTokenGroup label="Data sources" items={step.dataSources} mono />
                        <WorkflowTokenGroup label="Evidence" items={step.evidenceToShow} />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between gap-3">
            <CardTitle>Frontera de lectura</CardTitle>
            <UiBadge tone="outline">{formatNumber(data.workflow.readBoundary.allowedEndpoints.length)} endpoints</UiBadge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="m-0 mb-3 text-[12px] text-[var(--color-text-secondary)]">
            Los unicos endpoints que el panel puede consumir. Cualquier ruta fuera de esta lista es rechazada por el proxy del frontend.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {data.workflow.readBoundary.allowedEndpoints.map((endpoint) => (
              <code
                key={endpoint}
                className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-2 py-1 text-[11px] font-mono text-[var(--color-text-secondary)]"
              >
                {endpoint}
              </code>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
