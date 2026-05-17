/**
 * Clusters & Security feature — pantalla unificada Pencil frame `V8h2t`.
 *
 * Une las dos pantallas previas en una sola vista con tabs internas:
 *   - Tab "Clusters": inventario de sender nodes (era features/clusters).
 *   - Tab "Barandillas": norte operativo, kill switch, gates (era features/safety).
 *
 * Razon: Pencil colapsa Seguridad dentro de la pantalla de Clusters porque
 * comparten contexto operativo (norte + estado de infra). El panel sigue siendo
 * 100% GET — los tabs solo eligen que datos del contrato mostrar.
 */

import { useMemo } from "react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatNumber,
  humanize,
  stateTone,
  type Tone
} from "../../shared/lib/formatters.ts";
import {
  pickBinary,
  safetyCopy
} from "../../shared/lib/domain-state-copy.ts";
import { cn } from "../../shared/lib/cn.ts";
import {
  Badge as UiBadge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  MetricCard as UiMetricCard,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

function ActionTokenList({
  items,
  tone,
  empty
}: {
  items: string[];
  tone: Extract<Tone, "success" | "warning" | "critical" | "neutral">;
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">{empty}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <UiBadge key={item} tone={tone}>
          {compactLabel(item)}
        </UiBadge>
      ))}
    </div>
  );
}

function RoleField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2.5">
      <dt className="m-0 text-[11px] font-[family-name:var(--font-caption)] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
        {label}
      </dt>
      <dd className="m-0 text-[13px] text-[var(--color-text-primary)]">{value}</dd>
    </div>
  );
}

export function ClustersSecuritySection({ data }: { data: DashboardData }) {
  const clusters = data.clusters;
  const killSwitchOn = data.killSwitch.enabled;
  const liveWritesOn = data.operatingNorth.liveInfrastructureWritesEnabled;
  const smtpRealOn = data.operatingNorth.delivrixSendsRealEmail;
  const nfcWritesOn = data.operatingNorth.nfcProductionWritesEnabled;
  const gates = data.operatingNorth.gates ?? [];

  const totals = clusters.totals;
  const totalClusters = totals.clusters ?? clusters.clusters.length;
  const totalSenderNodes =
    totals.senderNodes ?? clusters.clusters.reduce((sum, c) => sum + c.senderNodes.length, 0);
  const totalActiveOrWarming = totals.activeOrWarmingNodes ?? 0;
  const totalProvisioningRuns = totals.provisioningRuns ?? 0;

  const guardrailHeadline = useMemo(() => {
    if (killSwitchOn) return "Kill switch activo";
    if (liveWritesOn || smtpRealOn || nfcWritesOn) return "Frontera abierta";
    return "Barandillas firmes";
  }, [killSwitchOn, liveWritesOn, smtpRealOn, nfcWritesOn]);

  return (
    <section className="flex flex-col gap-5 max-w-[1280px]">
      <PageHeader
        eyebrow={getSection("clusters-security").eyebrow}
        title={getSection("clusters-security").title}
        description={getSection("clusters-security").description}
        badge={{
          label: guardrailHeadline,
          tone: killSwitchOn ? "critical" : liveWritesOn || smtpRealOn || nfcWritesOn ? "warning" : "success"
        }}
        endpoint={formatEndpointBadge(getSection("clusters-security").endpoint)}
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
          label="Infra writes"
          value={liveWritesOn ? "Enabled" : "Disabled"}
          microcopy={pickBinary(safetyCopy.liveInfrastructureWrites, liveWritesOn).copy}
          microcopyTone={pickBinary(safetyCopy.liveInfrastructureWrites, liveWritesOn).tone}
        />
        <UiMetricCard
          label="Kill switch"
          value={killSwitchOn ? "Active" : "Inactive"}
          microcopy={
            killSwitchOn
              ? `Activado por ${data.killSwitch.updatedBy || "system"}`
              : pickBinary(safetyCopy.killSwitchActive, false).copy
          }
          microcopyTone={pickBinary(safetyCopy.killSwitchActive, killSwitchOn).tone}
        />
      </div>

      <Tabs defaultValue="clusters">
        <TabsList>
          <TabsTrigger value="clusters">Clusters</TabsTrigger>
          <TabsTrigger value="guardrails">Barandillas</TabsTrigger>
        </TabsList>

        <TabsContent value="clusters">
          <div className="flex flex-col gap-3">
            {clusters.clusters.length === 0 ? (
              <Card>
                <CardContent className="px-5 py-6">
                  <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">
                    No hay clusters bajo gobierno. Generar plan de topologia desde Onboarding.
                  </p>
                </CardContent>
              </Card>
            ) : (
              clusters.clusters.map((cluster, index) => {
                const tone = stateTone(cluster.managementState);
                return (
                  <Card key={cluster.id} tone={tone === "neutral" ? "neutral" : tone}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] text-[13px] font-[family-name:var(--font-mono)] font-medium text-[var(--color-text-secondary)] tabular-nums">
                            {index + 1}
                          </div>
                          <div className="min-w-0">
                            <CardTitle>{humanize(cluster.provider)}</CardTitle>
                            <code className="m-0 mt-1 block text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">
                              {cluster.id}
                            </code>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <UiBadge tone="outline">{formatNumber(cluster.senderNodes.length)} nodos</UiBadge>
                          <UiBadge tone={tone === "neutral" ? "neutral" : tone}>
                            {compactLabel(cluster.managementState)}
                          </UiBadge>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {cluster.senderNodes.length === 0 ? (
                        <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">
                          Cluster sin sender nodes registrados.
                        </p>
                      ) : (
                        <div className="overflow-x-auto -mx-1">
                          <table className="w-full text-[12px] min-w-[360px]">
                            <thead>
                              <tr className="text-left text-[11px] font-[family-name:var(--font-caption)] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
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
                                      <UiBadge
                                        size="sm"
                                        tone={nodeStatusTone === "neutral" ? "neutral" : nodeStatusTone}
                                      >
                                        {compactLabel(node.status)}
                                      </UiBadge>
                                    </td>
                                    <td className="px-1 py-2">
                                      {node.healthSeverity ? (
                                        <UiBadge
                                          size="sm"
                                          tone={healthTone === "neutral" ? "neutral" : healthTone}
                                        >
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
              })
            )}

            {clusters.nextActions.length > 0 ? (
              <Card>
                <CardHeader>
                  <div className="flex items-baseline justify-between gap-3">
                    <CardTitle>Acciones siguientes</CardTitle>
                    <UiBadge tone="outline">{formatNumber(clusters.nextActions.length)}</UiBadge>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="m-0 p-0 list-none flex flex-col gap-2">
                    {clusters.nextActions.map((action) => {
                      const tone = stateTone(action.status);
                      return (
                        <li
                          key={action.id}
                          className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[13px]"
                        >
                          <span className="text-[var(--color-text-primary)]">{action.label}</span>
                          <UiBadge size="sm" tone={tone === "neutral" ? "neutral" : tone}>
                            {compactLabel(action.status)}
                          </UiBadge>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            ) : null}

            <p className="m-0 text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
              {formatNumber(totalProvisioningRuns)} provisioning runs registrados desde el plan dry-run.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="guardrails">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <UiMetricCard
                label="SMTP real"
                value={smtpRealOn ? "Enabled" : "Disabled"}
                microcopy={pickBinary(safetyCopy.delivrixSendsRealEmail, smtpRealOn).copy}
                microcopyTone={pickBinary(safetyCopy.delivrixSendsRealEmail, smtpRealOn).tone}
              />
              <UiMetricCard
                label="NFC writes"
                value={nfcWritesOn ? "Enabled" : "Disabled"}
                microcopy={pickBinary(safetyCopy.nfcProductionWrites, nfcWritesOn).copy}
                microcopyTone={pickBinary(safetyCopy.nfcProductionWrites, nfcWritesOn).tone}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Card>
                <CardHeader>
                  <div className="flex items-baseline justify-between gap-3">
                    <CardTitle>Acciones permitidas</CardTitle>
                    <UiBadge tone="success">
                      {formatNumber(data.operatingNorth.allowedActions.length)}
                    </UiBadge>
                  </div>
                </CardHeader>
                <CardContent>
                  <ActionTokenList
                    items={data.operatingNorth.allowedActions}
                    tone="success"
                    empty="Sin acciones permitidas configuradas."
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <div className="flex items-baseline justify-between gap-3">
                    <CardTitle>Acciones bloqueadas</CardTitle>
                    <UiBadge tone="critical">
                      {formatNumber(data.operatingNorth.blockedActions.length)}
                    </UiBadge>
                  </div>
                </CardHeader>
                <CardContent>
                  <ActionTokenList
                    items={data.operatingNorth.blockedActions}
                    tone="critical"
                    empty="Sin acciones bloqueadas explicitamente."
                  />
                </CardContent>
              </Card>
            </div>

            {gates.length > 0 ? (
              <Card>
                <CardHeader>
                  <div className="flex items-baseline justify-between gap-3">
                    <CardTitle>Gates por cumplir</CardTitle>
                    <UiBadge tone="warning">{formatNumber(gates.length)}</UiBadge>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="m-0 mb-3 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                    Lista de gates declarados por el norte operativo. Subir volumen o autonomia
                    exige cumplir cada gate y dejarlo auditado.
                  </p>
                  <ActionTokenList items={gates} tone="warning" empty="Sin gates pendientes." />
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <div className="flex items-baseline justify-between gap-3">
                  <CardTitle>Roles del norte operativo</CardTitle>
                  <UiBadge tone="outline">read-only</UiBadge>
                </div>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 m-0">
                  <RoleField label="Delivrix" value={compactLabel(data.operatingNorth.delivrixRole)} />
                  <RoleField label="OpenClaw" value={compactLabel(data.operatingNorth.openClawRole)} />
                  <RoleField label="NFC" value={compactLabel(data.operatingNorth.nfcRole)} />
                </dl>
              </CardContent>
            </Card>

            {data.killSwitch.enabled ? (
              <Card tone="critical">
                <CardHeader>
                  <CardTitle>Kill switch activo</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="m-0 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                    {data.killSwitch.reason || "Sin razon registrada."} —{" "}
                    <span className="text-[var(--color-text-primary)]">
                      activado por {data.killSwitch.updatedBy || "system"}
                    </span>
                    .
                  </p>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
