/**
 * Collector feature: fuentes supervisadas + politica de ingestion.
 *
 * Tabs separan Fuentes (4 source cards) / Ingesta manual (contrato del endpoint
 * + mapping field-to-target) / Politica (gates + acciones permitidas/bloqueadas).
 * El panel es GET-only; el endpoint POST de ingesta vive fuera del panel.
 */

import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatDateTime,
  formatNumber,
  humanize,
  stateTone,
  type Tone
} from "../../shared/lib/formatters.ts";
import {
  collectorCopy,
  pickBinary
} from "../../shared/lib/domain-state-copy.ts";
import {
  Badge as UiBadge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DefinitionList,
  MetricCard as UiMetricCard,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

function CollectorTokenGroup({
  label,
  tone,
  items
}: {
  label: string;
  tone: Extract<Tone, "success" | "warning" | "critical" | "neutral">;
  items: string[];
}) {
  return (
    <div>
      <p className="m-0 mb-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
        {label}
      </p>
      {items.length === 0 ? (
        <p className="m-0 text-[12px] text-[var(--color-text-tertiary)]">Sin items.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <UiBadge key={item} tone={tone}>
              {compactLabel(item)}
            </UiBadge>
          ))}
        </div>
      )}
    </div>
  );
}

export function CollectorSection({ data }: { data: DashboardData }) {
  const collector = data.supervisedCollector;
  const ingestion = data.snapshotIngestion;
  const blockedSources = collector.sources.filter((source) => source.status === "blocked").length;
  const reviewSources = collector.sources.filter((source) => source.status === "needs_review").length;
  const requiredFields = ingestion.acceptedFieldPaths.filter((field) => field.requiredFor !== "optional");
  const uiPostEnabled = ingestion.uiPolicy.adminPanelCanPost;

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow={getSection("collector").eyebrow}
        title={getSection("collector").title}
        description={getSection("collector").description}
        badge={{
          label: compactLabel(collector.collectorMode),
          tone: "neutral"
        }}
        endpoint={formatEndpointBadge(getSection("collector").endpoint)}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <UiMetricCard
          label="Estado"
          value={compactLabel(collector.status)}
          microcopy="Plan de readiness"
          microcopyTone={stateTone(collector.status) === "neutral" ? "neutral" : stateTone(collector.status)}
        />
        <UiMetricCard
          label="Fuentes"
          value={formatNumber(collector.sources.length)}
          microcopy={`${formatNumber(blockedSources)} bloqueadas, ${formatNumber(reviewSources)} en revision`}
          microcopyTone={blockedSources > 0 ? "critical" : "neutral"}
        />
        <UiMetricCard
          label="Frescas"
          value={formatNumber(collector.freshness.freshSources)}
          microcopy={`${formatNumber(collector.freshness.unknownSources)} unknown`}
          microcopyTone={collector.freshness.freshSources > 0 ? "success" : "warning"}
        />
        <UiMetricCard
          label="Panel writes"
          value={uiPostEnabled ? "Enabled" : "Disabled"}
          microcopy={pickBinary(collectorCopy.panelWrites, uiPostEnabled).copy}
          microcopyTone={pickBinary(collectorCopy.panelWrites, uiPostEnabled).tone}
        />
      </div>

      <Tabs defaultValue="sources">
        <TabsList>
          <TabsTrigger value="sources">Fuentes</TabsTrigger>
          <TabsTrigger value="ingestion">Ingesta manual</TabsTrigger>
          <TabsTrigger value="policy">Politica</TabsTrigger>
        </TabsList>

        <TabsContent value="sources">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {collector.sources.map((source) => {
              const tone = stateTone(source.status);
              return (
                <Card key={source.id} tone={tone === "neutral" ? "neutral" : tone}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle>{source.label}</CardTitle>
                        <p className="m-0 mt-1 text-[12px] text-[var(--color-text-secondary)]">
                          {compactLabel(source.kind)} / {compactLabel(source.safeCollection.transport)}
                        </p>
                      </div>
                      <UiBadge tone={tone === "neutral" ? "neutral" : tone}>{compactLabel(source.status)}</UiBadge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="m-0 mb-3 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                      {source.purpose}
                    </p>
                    <DefinitionList
                      density="compact"
                      rows={[
                        { label: "Permiso", value: compactLabel(source.minimumPermission) },
                        { label: "Secreto", value: source.safeCollection.requiresSecret ? "required" : "not required" },
                        { label: "Writes", value: source.safeCollection.writesEnabled ? "enabled" : "disabled" },
                        { label: "Frescura", value: source.freshness.lastCollectedAt ? formatDateTime(source.freshness.lastCollectedAt) : "unknown" }
                      ]}
                    />
                    {source.safeCollection.commandPreview ? (
                      <code className="mt-3 block rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-2 py-1.5 text-[11px] font-mono text-[var(--color-text-secondary)] overflow-x-auto">
                        {source.safeCollection.commandPreview}
                      </code>
                    ) : null}
                    {source.safeCollection.endpoint ? (
                      <code className="mt-2 block rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-2 py-1.5 text-[11px] font-mono text-[var(--color-text-secondary)] overflow-x-auto">
                        {source.safeCollection.endpoint}
                      </code>
                    ) : null}
                    {source.blockedBy.length > 0 ? (
                      <div className="mt-3">
                        <p className="m-0 mb-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
                          Bloqueos
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {source.blockedBy.map((blocker) => (
                            <UiBadge key={blocker} tone={tone === "critical" ? "critical" : "warning"}>
                              {compactLabel(blocker)}
                            </UiBadge>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="ingestion">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card>
              <CardHeader>
                <div className="flex items-baseline justify-between gap-3">
                  <CardTitle>Contrato del endpoint</CardTitle>
                  <UiBadge tone="outline">{ingestion.snapshotSchemaVersion}</UiBadge>
                </div>
              </CardHeader>
              <CardContent>
                <DefinitionList
                  density="compact"
                  rows={[
                    { label: "Endpoint", value: `${ingestion.manualEndpoint.method} ${ingestion.manualEndpoint.path}`, mono: true },
                    { label: "Expone en panel", value: ingestion.manualEndpoint.exposedInAdminPanel ? "yes" : "no" },
                    { label: "Aprobacion", value: ingestion.manualEndpoint.requiresHumanApproval ? "required" : "not required" },
                    { label: "Raw payload", value: ingestion.manualEndpoint.storesRawPayload ? "stored" : "not stored" },
                    { label: "Modo del panel", value: ingestion.uiPolicy.adminPanelShowsContractOnly ? "contract only" : "interactive" },
                    { label: "Redact antes de hash", value: ingestion.redactionPolicy.redactsBeforeHash ? "yes" : "no" },
                    { label: "Stores raw secrets", value: ingestion.redactionPolicy.storesRawSecrets ? "yes" : "no" }
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Campos esperados</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-2">
                  {requiredFields.map((field) => (
                    <div key={field.path} className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2">
                      <code className="m-0 text-[11px] font-mono text-[var(--color-text-secondary)]">{field.path}</code>
                      <span className="text-[11px] text-[var(--color-text-tertiary)]">→</span>
                      <code className="m-0 text-[11px] font-mono text-[var(--color-text-primary)]">{field.mapsTo}</code>
                    </div>
                  ))}
                </div>
                {ingestion.redactionPolicy.rejectedKeys.length > 0 ? (
                  <div className="mt-4">
                    <p className="m-0 mb-2 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
                      Rejected keys
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {ingestion.redactionPolicy.rejectedKeys.map((key) => (
                        <UiBadge key={key} tone="critical">
                          {humanize(key)}
                        </UiBadge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="policy">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card>
              <CardHeader>
                <CardTitle>Politica de ingestion</CardTitle>
              </CardHeader>
              <CardContent>
                <DefinitionList
                  density="compact"
                  rows={[
                    { label: "Manual snapshot", value: collector.ingestionPolicy.acceptsManualSnapshot ? "enabled" : "disabled" },
                    { label: "Live mutation", value: collector.ingestionPolicy.acceptsLiveMutation ? "enabled" : "disabled" },
                    { label: "Source changes", value: collector.ingestionPolicy.requiresOperatorApprovalForSourceChange ? "approval required" : "open" },
                    { label: "Raw secrets", value: collector.ingestionPolicy.storesRawSecrets ? "stored" : "rejected" },
                    { label: "Snapshot hash", value: collector.auditPolicy.snapshotHashRequired ? "required" : "optional" }
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Gates y acciones</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-3">
                  <CollectorTokenGroup label="Gates" tone="warning" items={collector.gates} />
                  <CollectorTokenGroup label="Siguientes acciones seguras" tone="success" items={collector.nextSafeActions} />
                  <CollectorTokenGroup label="Acciones bloqueadas" tone="critical" items={collector.blockedActions} />
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
