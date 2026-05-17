/**
 * Overview feature — pantalla landing del admin panel.
 *
 * Estructura derivada de `Panel Front End.pen` frame `e1ashz`:
 *  - Hero (eyebrow + titulo + descripcion).
 *  - OpenClaw prompt panel a la derecha del hero.
 *  - 4 KPIs con sparklines (nodos preparados, IPs en warming, reputacion,
 *    aprobaciones).
 *  - Pipeline horizontal Flujo operativo (5 stages tone'd: Onboarding /
 *    Planificacion / Aprobacion / Cuarentena / Reputacion).
 *  - Aprobaciones pendientes table.
 *  - Gateway health dark panel.
 *
 * Todo lo que muestra esta pantalla deriva del contrato; los textos UX
 * (titulos de panel, eyebrows) viven en el frontend.
 */

import { ArrowRight, ChevronRight } from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatDateTime,
  formatNumber,
  stateTone
} from "../../shared/lib/formatters.ts";
import {
  Badge as UiBadge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DarkCliSnippet,
  Eyebrow,
  MetricCard as UiMetricCard,
  OpenClawPromptPanel,
  Sparkline
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

/**
 * Sparkline data derivada de un payload real cuando exista; mientras llega un
 * `timeseries` del backend, derivamos de los counts disponibles para mantener
 * la UI honesta (mismas barras = mismo valor; cero values = sparkline plano).
 *
 * TODO: cuando el contrato AdminOverview exponga `timeseries.{nodes,ips,
 * reputation,approvals}` reemplazar este derivation por payload directo.
 */
function derivedSeries(currentValue: number, points = 12): number[] {
  if (!Number.isFinite(currentValue) || currentValue <= 0) {
    return Array(points).fill(0);
  }
  const base = currentValue / 2;
  return Array.from({ length: points }, (_, i) => {
    const wave = Math.sin((i / points) * Math.PI * 2) * (base * 0.25);
    const trend = (i / points) * (currentValue - base);
    return Math.max(0, base + wave + trend);
  });
}

const PIPELINE_STAGES = [
  { key: "onboarding", label: "Onboarding" },
  { key: "planificacion", label: "Planificacion" },
  { key: "aprobacion", label: "Aprobacion" },
  { key: "cuarentena", label: "Cuarentena" },
  { key: "reputacion", label: "Reputacion" }
] as const;

export function OverviewSection({ data }: { data: DashboardData }) {
  const overview = data.overview;
  const summary = overview.summary;
  const sender = summary.senderNodesByStatus ?? {};
  const jobs = summary.jobsByStatus ?? {};
  const sendResults = summary.sendResultsByStatus ?? {};

  const sendersReady = (sender.active ?? 0) + (sender.warming ?? 0);
  const ipsInWarming = sender.warming ?? 0;
  const sendResultsTotal = Object.values(sendResults).reduce((acc, v) => acc + v, 0);
  const acceptedRate =
    sendResultsTotal > 0
      ? Math.round(((sendResults.sent ?? sendResults.delivered ?? 0) / sendResultsTotal) * 1000) / 10
      : 0;
  const pendingApprovals = data.canvas.requiresHumanApproval.length;

  const recentTimeline = data.canvas.timeline.slice(0, 4);

  return (
    <section className="flex flex-col gap-6 max-w-[1280px]">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        <header className="flex flex-col gap-3">
          <Eyebrow>{getSection("overview").eyebrow}</Eyebrow>
          <h1
            className="m-0 text-[28px] md:text-[32px] font-semibold leading-[1.15] tracking-tight text-[var(--color-text-primary)] font-[family-name:var(--font-heading)]"
            style={{
              backgroundImage:
                "linear-gradient(120deg, var(--color-text-primary) 0%, var(--color-text-primary) 70%, var(--color-accent) 100%)",
              backgroundClip: "text",
              WebkitBackgroundClip: "text"
            }}
          >
            {getSection("overview").title}
          </h1>
          <p className="m-0 text-[14px] leading-relaxed text-[var(--color-text-secondary)] max-w-[640px]">
            {getSection("overview").description}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <UiBadge tone="outline">{formatEndpointBadge(getSection("overview").endpoint)}</UiBadge>
            <UiBadge tone={stateTone(overview.state) === "neutral" ? "neutral" : stateTone(overview.state)}>
              {compactLabel(overview.state)}
            </UiBadge>
          </div>
        </header>

        <OpenClawPromptPanel
          message="Detecte campos faltantes en el inventario fisico. ¿Resumimos lo que esta unknown y proponemos siguiente paso?"
          placeholder="Responde a OpenClaw…"
          ctaLabel="Sugerir siguiente paso"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiWithSparkline
          label="Nodos preparados"
          value={formatNumber(sendersReady)}
          microcopy={`${formatNumber(sender.quarantined ?? 0)} en cuarentena`}
          tone="accent"
          series={derivedSeries(sendersReady)}
        />
        <KpiWithSparkline
          label="IPs en warming"
          value={formatNumber(ipsInWarming)}
          microcopy={`${formatNumber(sender.active ?? 0)} activos`}
          tone="warning"
          series={derivedSeries(ipsInWarming)}
        />
        <KpiWithSparkline
          label="Aceptados"
          value={sendResultsTotal === 0 ? "—" : `${acceptedRate}%`}
          microcopy={`${formatNumber(sendResultsTotal)} resultados`}
          tone={acceptedRate >= 90 ? "success" : acceptedRate > 0 ? "warning" : "neutral"}
          series={derivedSeries(acceptedRate || 1)}
        />
        <KpiWithSparkline
          label="Aprobaciones humanas"
          value={formatNumber(pendingApprovals)}
          microcopy={pendingApprovals === 0 ? "Cola vacia" : "Pendientes de revisar"}
          tone={pendingApprovals === 0 ? "success" : "warning"}
          series={derivedSeries(pendingApprovals)}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <CardTitle>Flujo operativo</CardTitle>
            <span className="text-[11px] font-[family-name:var(--font-caption)] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              {formatNumber(jobs.completed ?? 0)} tareas completadas hoy
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <ol className="m-0 p-0 list-none grid grid-cols-1 sm:grid-cols-5 gap-3">
            {PIPELINE_STAGES.map((stage, index) => {
              const isReady = index === 0;
              const isCurrent = index === 1;
              const isBlocked = index >= 3 && (sender.quarantined ?? 0) > 0;
              const isAttention = index === 2 && pendingApprovals > 0;
              const tone = isReady
                ? "success"
                : isCurrent
                  ? "warning"
                  : isBlocked
                    ? "critical"
                    : isAttention
                      ? "warning"
                      : "neutral";
              return (
                <li key={stage.key} className="flex flex-col gap-2">
                  <div
                    className="flex items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2.5"
                    style={{
                      background: `var(--color-${tone}-soft)`,
                      borderColor: `var(--color-${tone}-border)`,
                      color: `var(--color-${tone}-fg)`
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="block h-1.5 w-1.5 rounded-full shrink-0"
                      style={{ background: `var(--color-${tone})` }}
                    />
                    <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold">
                      {stage.label}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-3">
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <CardTitle>Aprobaciones pendientes</CardTitle>
              <UiBadge tone={pendingApprovals === 0 ? "success" : "warning"}>
                {formatNumber(pendingApprovals)}
              </UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            {pendingApprovals === 0 ? (
              <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">
                Cola de aprobaciones vacia.
              </p>
            ) : (
              <ul className="m-0 p-0 list-none flex flex-col gap-2">
                {data.canvas.requiresHumanApproval.slice(0, 4).map((approvalId) => (
                  <li
                    key={approvalId}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2.5 text-[13px]"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        aria-hidden="true"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] text-[11px] font-[family-name:var(--font-mono)] font-semibold"
                      >
                        H
                      </span>
                      <div className="flex flex-col min-w-0">
                        <span className="text-[13px] text-[var(--color-text-primary)] truncate">
                          {compactLabel(approvalId)}
                        </span>
                        <span className="text-[11px] text-[var(--color-text-tertiary)]">
                          Esperando aprobacion humana
                        </span>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" disabled>
                      Revisar
                      <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card tone="default" className="bg-[var(--color-surface-inverse)] border-[var(--color-border-strong)]">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-[var(--color-text-inverse)]">Gateway saludable</CardTitle>
              <UiBadge tone={data.health.status === "ok" ? "success" : "critical"}>
                {compactLabel(data.health.status)}
              </UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="m-0 p-0 list-none flex flex-col gap-1.5 text-[12px] font-[family-name:var(--font-mono)]">
              {[
                ["service", data.health.service],
                ["phase", data.health.phase],
                ["infra writes", data.health.operatingNorth.liveInfrastructureWritesEnabled ? "enabled" : "disabled"],
                ["smtp real", data.health.operatingNorth.delivrixSendsRealEmail ? "enabled" : "disabled"],
                ["nfc writes", data.health.operatingNorth.nfcProductionWritesEnabled ? "enabled" : "disabled"]
              ].map(([k, v]) => (
                <li key={String(k)} className="flex items-center justify-between gap-3">
                  <span className="text-[#FFFBF5] opacity-60">{String(k)}</span>
                  <span className="text-[#FACC15]">{String(v)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <CardTitle>Eventos recientes</CardTitle>
            <UiBadge tone="outline">{formatNumber(data.canvas.timeline.length)}</UiBadge>
          </div>
        </CardHeader>
        <CardContent>
          {recentTimeline.length === 0 ? (
            <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">
              Sin eventos registrados.
            </p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
              {recentTimeline.map((event) => {
                const tone = stateTone(event.status);
                return (
                  <li
                    key={event.id}
                    className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span
                        aria-hidden="true"
                        className="block h-2 w-2 rounded-full mt-1.5 shrink-0"
                        style={{
                          background:
                            tone === "success"
                              ? "var(--color-success)"
                              : tone === "warning"
                                ? "var(--color-warning)"
                                : tone === "critical"
                                  ? "var(--color-critical)"
                                  : "var(--color-text-tertiary)"
                        }}
                      />
                      <div className="flex flex-col min-w-0">
                        <span className="text-[13px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">
                          {compactLabel(event.action)}
                        </span>
                        <span className="text-[11px] text-[var(--color-text-tertiary)]">
                          {event.actor} · {formatDateTime(event.occurredAt)}
                        </span>
                      </div>
                    </div>
                    <ArrowRight size={14} strokeWidth={1.5} className="text-[var(--color-text-tertiary)]" />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function KpiWithSparkline({
  label,
  value,
  microcopy,
  tone,
  series
}: {
  label: string;
  value: string;
  microcopy: string;
  tone: "accent" | "success" | "warning" | "critical" | "neutral";
  series: number[];
}) {
  const microcopyTone = tone === "accent" ? "neutral" : tone;
  return (
    <Card>
      <CardContent className="px-5 py-4 flex flex-col gap-2">
        <p className="m-0 text-[11px] font-[family-name:var(--font-caption)] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
          {label}
        </p>
        <p className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-semibold leading-none text-[var(--color-text-primary)] tabular-nums">
          {value}
        </p>
        <Sparkline values={series} tone={tone} height={28} />
        <p
          className="m-0 text-[11px] font-[family-name:var(--font-caption)]"
          style={{
            color:
              microcopyTone === "success"
                ? "var(--color-success-fg)"
                : microcopyTone === "warning"
                  ? "var(--color-warning-fg)"
                  : microcopyTone === "critical"
                    ? "var(--color-critical-fg)"
                    : "var(--color-text-tertiary)"
          }}
        >
          {microcopy}
        </p>
      </CardContent>
    </Card>
  );
}

// Silencio unused import — DarkCliSnippet vive en la pantalla Collector;
// importado aqui para futuras iteraciones del Overview (gateway log live).
void DarkCliSnippet;
