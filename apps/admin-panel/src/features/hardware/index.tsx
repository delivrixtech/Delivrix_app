/**
 * Hardware feature: inventario y telemetria del host fisico.
 *
 * El banner de "siguiente paso recomendado" se enciende cuando el contrato
 * `physicalHost.readiness.recommendedNextStep` viene presente. Tono y texto
 * salen del payload — el frontend no decide cuando ni que mostrar.
 */

import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatMetricValue,
  humanize,
  stateTone
} from "../../shared/lib/formatters.ts";
import { pickCapacityCopy } from "../../shared/lib/domain-state-copy.ts";
import {
  Badge as UiBadge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DefinitionList,
  MetricCard as UiMetricCard,
  NoticeBanner,
  PageHeader
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

export function HardwareSection({ data }: { data: DashboardData }) {
  const capacity = data.physicalHost.capacity;
  const telemetry = data.telemetry;
  const collector = data.collector;
  const identity = data.physicalHost.identity;
  const physicalHost = data.physicalHost;
  const unknownInventoryFields = physicalHost.quality.unknownFields.map(humanize);
  const unknownTelemetryFields = telemetry.quality.unknownFields.map(humanize);
  const unknownCollectorFields = collector.unknownCapabilities.map(humanize);
  const inventoryComplete = unknownInventoryFields.length === 0;
  const recommendedNextStep = physicalHost.readiness.recommendedNextStep;

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow={getSection("hardware").eyebrow}
        title={getSection("hardware").title}
        description={getSection("hardware").description}
        badge={{
          label: compactLabel(physicalHost.source.kind),
          tone: physicalHost.source.kind === "mock" ? "warning" : "neutral"
        }}
        endpoint={formatEndpointBadge(getSection("hardware").endpoint)}
      />

      {recommendedNextStep ? (
        <NoticeBanner
          tone={recommendedNextStep.severity}
          title={recommendedNextStep.label}
          description={
            <>
              {humanize(physicalHost.readiness.primaryBlocker)}. Endpoint supervisado:{" "}
              <code className="font-mono">{recommendedNextStep.endpoint}</code>.
            </>
          }
        />
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {([
          { label: "CPU cores", value: capacity.cpuCores, unit: "cores" },
          { label: "RAM", value: capacity.memoryGb, unit: "GB" },
          { label: "Storage", value: capacity.storageUsableGb, unit: "GB" },
          { label: "IP pool", value: capacity.ipPoolSize, unit: "IPs" }
        ] as const).map(({ label, value, unit }) => {
          const state = pickCapacityCopy(value);
          return (
            <UiMetricCard
              key={label}
              label={label}
              value={formatMetricValue(value, unit)}
              microcopy={state.copy}
              microcopyTone={state.tone}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Inventario</CardTitle>
              <UiBadge tone={inventoryComplete ? "success" : "warning"}>
                {compactLabel(physicalHost.readiness.status)}
              </UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            <DefinitionList
              rows={[
                { label: "Host", value: identity.label || "unknown" },
                { label: "Vendor", value: identity.vendor || "unknown" },
                { label: "Modelo", value: identity.model || "unknown" },
                { label: "OS", value: identity.operatingSystem || "unknown" },
                { label: "Proxmox", value: identity.proxmoxVersion || "unknown" },
                { label: "Ubicacion", value: identity.location || "unknown" }
              ]}
            />
            <div className="mt-4">
              <p className="m-0 mb-2 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
                Campos pendientes
              </p>
              {unknownInventoryFields.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">Inventario completo.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {unknownInventoryFields.map((field) => (
                    <UiBadge key={field} tone="warning">
                      {field}
                    </UiBadge>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Telemetria reciente</CardTitle>
              <UiBadge tone={telemetry.summary.stale ? "warning" : stateTone(telemetry.summary.status) === "neutral" ? "neutral" : "success"}>
                {telemetry.summary.stale ? "stale" : compactLabel(telemetry.summary.status)}
              </UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            <DefinitionList
              rows={[
                { label: "CPU usage", value: formatMetricValue(telemetry.cpu.usagePercent, "%") },
                { label: "CPU temp", value: formatMetricValue(telemetry.cpu.temperatureCelsius, "C") },
                { label: "Memory usage", value: formatMetricValue(telemetry.memory.usagePercent as number | null, "%") },
                { label: "Storage SMART", value: compactLabel(String(telemetry.storage.smartStatus ?? "unknown")) },
                { label: "Network RX/TX", value: `${formatMetricValue(telemetry.network.rxMbps, "Mbps")} / ${formatMetricValue(telemetry.network.txMbps, "Mbps")}` },
                { label: "Power", value: formatMetricValue(telemetry.power.watts as number | null, "W") }
              ]}
            />
            <div className="mt-4">
              <p className="m-0 mb-2 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
                Campos pendientes
              </p>
              {unknownTelemetryFields.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">Telemetria completa.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {unknownTelemetryFields.map((field) => (
                    <UiBadge key={field} tone="warning">
                      {field}
                    </UiBadge>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between gap-3">
            <CardTitle>Collector DevOps</CardTitle>
            <UiBadge tone={stateTone(collector.status) === "neutral" ? "neutral" : "success"}>
              {compactLabel(collector.status)}
            </UiBadge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <DefinitionList
              density="compact"
              rows={[
                { label: "Version", value: collector.collectorVersion, mono: true },
                { label: "SSH", value: collector.permissions.sshEnabled ? "enabled" : "disabled" },
                { label: "Proxmox writes", value: collector.permissions.proxmoxApiWriteEnabled ? "enabled" : "disabled" }
              ]}
            />
            <div>
              <p className="m-0 mb-2 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
                Capacidades pendientes
              </p>
              {unknownCollectorFields.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">Sin capacidades pendientes.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {unknownCollectorFields.map((field) => (
                    <UiBadge key={field} tone="neutral">
                      {field}
                    </UiBadge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
