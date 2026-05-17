/**
 * Clusters feature: inventario de sender nodes por cluster.
 *
 * Una Card por cluster con tabla real (Nodo / Estado / Salud) consumida desde
 * `clusters.clusters[*].senderNodes`. KPIs leen `clusters.totals` por nombre
 * explicito (sin Object.entries).
 */

import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatNumber,
  humanize,
  stateTone
} from "../../shared/lib/formatters.ts";
import { cn } from "../../shared/lib/cn.ts";
import {
  Badge as UiBadge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  MetricCard as UiMetricCard,
  PageHeader
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

export function ClustersSection({ data }: { data: DashboardData }) {
  const totals = data.clusters.totals;
  const totalClusters = totals.clusters ?? data.clusters.clusters.length;
  const totalSenderNodes = totals.senderNodes ?? data.clusters.clusters.reduce((sum, c) => sum + c.senderNodes.length, 0);
  const totalProvisioningRuns = totals.provisioningRuns ?? 0;
  const totalActiveOrWarming = totals.activeOrWarmingNodes ?? 0;

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow={getSection("clusters").eyebrow}
        title={getSection("clusters").title}
        description={getSection("clusters").description}
        badge={{ label: compactLabel(data.clusters.mode), tone: "neutral" }}
        endpoint={formatEndpointBadge(getSection("clusters").endpoint)}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <UiMetricCard
          label="Clusters"
          value={formatNumber(totalClusters)}
          microcopy="Bajo gobierno"
          microcopyTone="neutral"
        />
        <UiMetricCard
          label="Sender nodes"
          value={formatNumber(totalSenderNodes)}
          microcopy={`${formatNumber(totalActiveOrWarming)} activos o calentando`}
          microcopyTone={totalActiveOrWarming > 0 ? "success" : "neutral"}
        />
        <UiMetricCard
          label="Provisioning runs"
          value={formatNumber(totalProvisioningRuns)}
          microcopy={totalProvisioningRuns === 0 ? "Sin runs registrados" : "Plan dry-run"}
          microcopyTone="neutral"
        />
        <UiMetricCard
          label="Acciones siguientes"
          value={formatNumber(data.clusters.nextActions.length)}
          microcopy="En backlog operacional"
          microcopyTone="neutral"
        />
      </div>

      <div className="flex flex-col gap-3">
        {data.clusters.clusters.map((cluster, index) => {
          const tone = stateTone(cluster.managementState);
          return (
            <Card key={cluster.id} tone={tone === "neutral" ? "neutral" : tone}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] text-[13px] font-medium text-[var(--color-text-secondary)] tabular-nums">
                      {index + 1}
                    </div>
                    <div className="min-w-0">
                      <CardTitle>{humanize(cluster.provider)}</CardTitle>
                      <code className="m-0 mt-1 block text-[11px] font-mono text-[var(--color-text-secondary)]">{cluster.id}</code>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <UiBadge tone="outline">{formatNumber(cluster.senderNodes.length)} nodos</UiBadge>
                    <UiBadge tone={tone === "neutral" ? "neutral" : tone}>{compactLabel(cluster.managementState)}</UiBadge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {cluster.senderNodes.length === 0 ? (
                  <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">Cluster sin sender nodes registrados.</p>
                ) : (
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-[12px] min-w-[360px]">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
                          <th className="font-medium px-1 py-1.5">Nodo</th>
                          <th className="font-medium px-1 py-1.5">Estado</th>
                          <th className="font-medium px-1 py-1.5">Salud</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cluster.senderNodes.map((node, nodeIndex) => {
                          const nodeStatusTone = stateTone(node.status);
                          const healthTone = node.healthSeverity ? stateTone(node.healthSeverity) : "neutral";
                          return (
                            <tr
                              key={node.id}
                              className={cn(
                                "border-t border-[var(--color-border)]",
                                nodeIndex === 0 && "border-t-0"
                              )}
                            >
                              <td className="px-1 py-2 text-[var(--color-text-primary)]">{node.label}</td>
                              <td className="px-1 py-2">
                                <UiBadge size="sm" tone={nodeStatusTone === "neutral" ? "neutral" : nodeStatusTone}>
                                  {compactLabel(node.status)}
                                </UiBadge>
                              </td>
                              <td className="px-1 py-2">
                                {node.healthSeverity ? (
                                  <UiBadge size="sm" tone={healthTone === "neutral" ? "neutral" : healthTone}>
                                    {compactLabel(node.healthSeverity)}
                                  </UiBadge>
                                ) : (
                                  <span className="text-[11px] text-[var(--color-text-tertiary)]">unknown</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {data.clusters.nextActions.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Acciones siguientes</CardTitle>
              <UiBadge tone="outline">{formatNumber(data.clusters.nextActions.length)}</UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="m-0 p-0 list-none flex flex-col gap-2">
              {data.clusters.nextActions.map((action) => {
                const tone = stateTone(action.status);
                return (
                  <li key={action.id} className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[13px]">
                    <span className="text-[var(--color-text-primary)]">{action.label}</span>
                    <UiBadge size="sm" tone={tone === "neutral" ? "neutral" : tone}>{compactLabel(action.status)}</UiBadge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
