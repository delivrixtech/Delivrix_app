import {
  Activity,
  Boxes,
  BrainCircuit,
  Cpu,
  GitBranch,
  RefreshCw,
  ShieldCheck,
  Workflow
} from "lucide-react";
import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node
} from "@xyflow/react";
import {
  loadDashboardData,
  type ContractStatus,
  type DashboardData,
  type OpenClawCanvasPayload
} from "../shared/api/client.ts";
import {
  compactLabel,
  formatDateTime,
  formatMetricValue,
  formatNumber,
  stateTone,
  type Tone
} from "../shared/lib/formatters.ts";
import {
  Badge as UiBadge,
  BrandBlock,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Eyebrow,
  FreshnessTag,
  MetricCard as UiMetricCard,
  ModeBadge,
  PageHeader,
  Separator,
  ThemeToggle,
  Tooltip,
  TooltipProvider
} from "../shared/ui/index.ts";
import { cn } from "../shared/lib/cn.ts";

type SectionId = "canvas" | "hardware" | "collector" | "workflow" | "clusters" | "learning" | "safety";

type SectionGroup = "live" | "process" | "guardrails";

interface SectionItem {
  id: SectionId;
  label: string;
  group: SectionGroup;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const sections: SectionItem[] = [
  { id: "canvas", label: "Canvas", group: "live", icon: GitBranch },
  { id: "hardware", label: "Hardware", group: "live", icon: Cpu },
  { id: "collector", label: "Collector", group: "live", icon: Activity },
  { id: "workflow", label: "Ruta", group: "process", icon: Workflow },
  { id: "clusters", label: "Clusters", group: "process", icon: Boxes },
  { id: "learning", label: "Aprendizaje", group: "process", icon: BrainCircuit },
  { id: "safety", label: "Seguridad", group: "guardrails", icon: ShieldCheck }
];

const sectionGroupLabels: Record<SectionGroup, string> = {
  live: "Estado vivo",
  process: "Procesos",
  guardrails: "Barandillas"
};

const sectionGroupOrder: SectionGroup[] = ["live", "process", "guardrails"];

export function App() {
  const [activeSection, setActiveSection] = useState<SectionId>("canvas");
  const dashboard = useQuery({
    queryKey: ["admin-panel", "dashboard"],
    queryFn: loadDashboardData,
    refetchInterval: 30_000,
    staleTime: 10_000
  });

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text-primary)]">
        <Topbar
          data={dashboard.data}
          isFetching={dashboard.isFetching}
          lastFetchedAt={dashboard.dataUpdatedAt || null}
          onRefresh={() => void dashboard.refetch()}
        />
        <div className="grid grid-cols-[240px_minmax(0,1fr)] min-h-[calc(100vh-57px)] max-md:grid-cols-1">
          <Sidebar activeSection={activeSection} onSelect={setActiveSection} data={dashboard.data} />
          <main className="min-w-0 px-6 py-6 md:px-8 md:py-8">
            {dashboard.isLoading ? <LoadingState /> : null}
            {dashboard.isError ? (
              <ErrorState message={errorMessage(dashboard.error)} onRefresh={() => void dashboard.refetch()} />
            ) : null}
            {dashboard.data && !dashboard.isLoading && !dashboard.isError ? (
              <SectionView section={activeSection} data={dashboard.data} />
            ) : null}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Topbar({
  data,
  isFetching,
  lastFetchedAt,
  onRefresh
}: {
  data: DashboardData | undefined;
  isFetching: boolean;
  lastFetchedAt: number | null;
  onRefresh: () => void;
}) {
  const operatingNorth = data?.operatingNorth;

  return (
    <header className="sticky top-0 z-40 flex items-center justify-between gap-6 px-6 md:px-8 h-14 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <BrandBlock />
      <div className="flex items-center gap-3">
        {operatingNorth ? (
          <ModeBadge
            liveInfrastructureWritesEnabled={operatingNorth.liveInfrastructureWritesEnabled}
            delivrixSendsRealEmail={operatingNorth.delivrixSendsRealEmail}
            nfcProductionWritesEnabled={operatingNorth.nfcProductionWritesEnabled}
          />
        ) : (
          <UiBadge tone="neutral">Mode loading</UiBadge>
        )}
        <FreshnessTag lastFetchedAt={lastFetchedAt} isFetching={isFetching} />
        <Tooltip hint="Actualizar datos">
          <Button variant="ghost" size="icon" aria-label="Actualizar datos" onClick={onRefresh}>
            <RefreshCw size={15} strokeWidth={1.75} className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
          </Button>
        </Tooltip>
        <ThemeToggle />
      </div>
    </header>
  );
}

function Sidebar({
  activeSection,
  onSelect,
  data
}: {
  activeSection: SectionId;
  onSelect: (section: SectionId) => void;
  data: DashboardData | undefined;
}) {
  return (
    <aside className="flex flex-col justify-between gap-6 p-4 border-r border-[var(--color-border)] bg-[var(--color-surface)] max-md:border-r-0 max-md:border-b">
      <nav className="flex flex-col gap-5" aria-label="Secciones del panel">
        {sectionGroupOrder.map((group) => {
          const items = sections.filter((section) => section.group === group);
          return (
            <div key={group} className="flex flex-col gap-1.5">
              <Eyebrow className="px-2">{sectionGroupLabels[group]}</Eyebrow>
              {items.map((section) => {
                const Icon = section.icon;
                const active = section.id === activeSection;
                const tone = toneForSection(section.id, data);
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => onSelect(section.id)}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-[13px] transition-colors",
                      active
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-medium"
                        : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                      {section.label}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block h-1.5 w-1.5 rounded-full",
                        tone === "success" && "bg-[var(--color-success)]",
                        tone === "warning" && "bg-[var(--color-warning)]",
                        tone === "critical" && "bg-[var(--color-critical)]",
                        tone === "neutral" && "bg-[var(--color-text-tertiary)]"
                      )}
                    />
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="flex flex-col gap-2 px-2">
        <Separator />
        <UiBadge tone="outline" className="self-start">Read-only</UiBadge>
        <p className="m-0 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
          Delivrix LLC · Desarrollado por JECT
        </p>
      </div>
    </aside>
  );
}

function SectionView({ section, data }: { section: SectionId; data: DashboardData }) {
  if (section === "canvas") return <CanvasSection data={data} />;
  if (section === "hardware") return <HardwareSection data={data} />;
  if (section === "collector") return <CollectorSection data={data} />;
  if (section === "workflow") return <WorkflowSection data={data} />;
  if (section === "clusters") return <ClustersSection data={data} />;
  if (section === "learning") return <LearningSection data={data} />;
  return <SafetySection data={data} />;
}

function CanvasSection({ data }: { data: DashboardData }) {
  const { nodes, edges } = useCanvasFlow(data.canvas);
  const current = data.canvas.nodes.find((node) => node.id === data.canvas.currentStepId);

  return (
    <section className="page-stack">
      <TitleRow eyebrow="OpenClaw" title="Canvas vivo" badge={data.canvas.mode} />
      <section className="metric-grid metric-grid-compact">
        <MetricCard label="Paso actual" value={compactLabel(current?.label ?? data.canvas.currentStepId)} tone={stateTone(current?.status)} meta={compactLabel(current?.status)} />
        <MetricCard label="Nodos" value={formatNumber(data.canvas.nodes.length)} tone="neutral" meta="Graph contract" />
        <MetricCard label="Bloqueos" value={formatNumber(data.canvas.blockedBy.length)} tone={data.canvas.blockedBy.length > 0 ? "critical" : "success"} meta="OpenClaw state" />
        <MetricCard label="Aprobaciones" value={formatNumber(data.canvas.requiresHumanApproval.length)} tone="warning" meta="Human gates" />
      </section>
      <section className="canvas-layout">
        <div className="flow-panel">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            fitView
            minZoom={0.45}
            maxZoom={1.35}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className="side-panel">
          <PanelHeader title="Timeline" badge={`${data.canvas.timeline.length}`} />
          <div className="timeline-list">
            {data.canvas.timeline.map((event) => (
              <article key={event.id} className={`timeline-item timeline-${stateTone(event.status)}`}>
                <div>
                  <strong>{compactLabel(event.action)}</strong>
                  <p>{formatDateTime(event.occurredAt)}</p>
                </div>
                <Badge tone={stateTone(event.status)}>{event.actor}</Badge>
              </article>
            ))}
          </div>
          <div className="blocker-box">
            <PanelHeader title="Bloqueos" badge={`${data.canvas.blockedBy.length}`} />
            <TokenList items={data.canvas.blockedBy.slice(0, 12)} tone="critical" empty="Sin bloqueos" />
          </div>
        </aside>
      </section>
    </section>
  );
}

function HardwareSection({ data }: { data: DashboardData }) {
  const capacity = data.physicalHost.capacity;
  const telemetry = data.telemetry;
  const collector = data.collector;

  return (
    <section className="page-stack">
      <TitleRow eyebrow="Servidor fisico" title="Hardware y telemetria" badge={data.physicalHost.source.kind} />
      <section className="metric-grid">
        <MetricCard label="CPU" value={formatMetricValue(capacity.cpuCores, "cores")} tone={capacity.cpuCores === null ? "warning" : "success"} meta="capacity.cpuCores" />
        <MetricCard label="RAM" value={formatMetricValue(capacity.memoryGb, "GB")} tone={capacity.memoryGb === null ? "warning" : "success"} meta="capacity.memoryGb" />
        <MetricCard label="Storage" value={formatMetricValue(capacity.storageUsableGb, "GB")} tone={capacity.storageUsableGb === null ? "warning" : "success"} meta="capacity.storageUsableGb" />
        <MetricCard label="IP pool" value={formatMetricValue(capacity.ipPoolSize, "IPs")} tone={capacity.ipPoolSize === null ? "warning" : "success"} meta="capacity.ipPoolSize" />
      </section>
      <section className="two-column">
        <section className="panel">
          <PanelHeader title="Inventario" badge={data.physicalHost.readiness.status} />
          <DefinitionGrid rows={[
            ["Host", data.physicalHost.identity.label],
            ["Vendor", data.physicalHost.identity.vendor],
            ["Modelo", data.physicalHost.identity.model],
            ["OS", data.physicalHost.identity.operatingSystem],
            ["Proxmox", data.physicalHost.identity.proxmoxVersion],
            ["Ubicacion", data.physicalHost.identity.location]
          ]} />
          <TokenList items={data.physicalHost.quality.unknownFields} tone="warning" empty="Inventario completo" />
        </section>
        <section className="panel">
          <PanelHeader title="Telemetry latest" badge={telemetry.summary.stale ? "stale" : telemetry.summary.status} />
          <DefinitionGrid rows={[
            ["CPU usage", formatMetricValue(telemetry.cpu.usagePercent, "%")],
            ["CPU temp", formatMetricValue(telemetry.cpu.temperatureCelsius, "C")],
            ["Memory usage", formatMetricValue(telemetry.memory.usagePercent as number | null, "%")],
            ["Storage SMART", compactLabel(String(telemetry.storage.smartStatus ?? "unknown"))],
            ["Network RX/TX", `${formatMetricValue(telemetry.network.rxMbps, "Mbps")} / ${formatMetricValue(telemetry.network.txMbps, "Mbps")}`],
            ["Power", formatMetricValue(telemetry.power.watts as number | null, "W")]
          ]} />
          <TokenList items={telemetry.quality.unknownFields} tone="warning" empty="Telemetry completa" />
        </section>
      </section>
      <section className="panel">
        <PanelHeader title="Collector DevOps" badge={collector.collectorMode} />
        <div className="definition-grid">
          <DefinitionRow label="Status" value={compactLabel(collector.status)} />
          <DefinitionRow label="Version" value={collector.collectorVersion} />
          <DefinitionRow label="SSH" value={collector.permissions.sshEnabled ? "enabled" : "disabled"} />
          <DefinitionRow label="Proxmox writes" value={collector.permissions.proxmoxApiWriteEnabled ? "enabled" : "disabled"} />
        </div>
        <TokenList items={collector.unknownCapabilities} tone="neutral" empty="Sin campos pendientes" />
      </section>
    </section>
  );
}

function CollectorSection({ data }: { data: DashboardData }) {
  const collector = data.supervisedCollector;
  const ingestion = data.snapshotIngestion;
  const blockedSources = collector.sources.filter((source) => source.status === "blocked").length;
  const reviewSources = collector.sources.filter((source) => source.status === "needs_review").length;
  const requiredFields = ingestion.acceptedFieldPaths.filter((field) => field.requiredFor !== "optional");

  return (
    <section className="page-stack">
      <TitleRow eyebrow="DevOps" title="Collector supervisado" badge={collector.collectorMode} />
      <section className="metric-grid">
        <MetricCard label="Estado" value={compactLabel(collector.status)} tone={stateTone(collector.status)} meta="readiness plan" />
        <MetricCard label="Fuentes" value={formatNumber(collector.sources.length)} tone="neutral" meta={`${formatNumber(blockedSources)} bloqueadas`} />
        <MetricCard label="Fresh" value={formatNumber(collector.freshness.freshSources)} tone={collector.freshness.freshSources > 0 ? "success" : "warning"} meta={`${formatNumber(collector.freshness.unknownSources)} unknown`} />
        <MetricCard label="UI POST" value={ingestion.uiPolicy.adminPanelCanPost ? "enabled" : "disabled"} tone={ingestion.uiPolicy.adminPanelCanPost ? "critical" : "success"} meta="admin boundary" />
      </section>
      <section className="collector-grid">
        <section className="panel collector-main-panel">
          <PanelHeader title="Fuentes read-only" badge={`${reviewSources + blockedSources}`} />
          <div className="source-grid">
            {collector.sources.map((source) => (
              <article key={source.id} className={`source-card source-${stateTone(source.status)}`}>
                <div className="source-card-head">
                  <div>
                    <strong>{source.label}</strong>
                    <p>{compactLabel(source.kind)} / {compactLabel(source.safeCollection.transport)}</p>
                  </div>
                  <Badge tone={stateTone(source.status)}>{compactLabel(source.status)}</Badge>
                </div>
                <p>{source.purpose}</p>
                <DefinitionGrid rows={[
                  ["Permiso", compactLabel(source.minimumPermission)],
                  ["Secreto", source.safeCollection.requiresSecret ? "required" : "not required"],
                  ["Writes", source.safeCollection.writesEnabled ? "enabled" : "disabled"],
                  ["Fresh", source.freshness.lastCollectedAt ? formatDateTime(source.freshness.lastCollectedAt) : "unknown"]
                ]} />
                {source.safeCollection.commandPreview ? (
                  <code className="inline-code">{source.safeCollection.commandPreview}</code>
                ) : null}
                {source.safeCollection.endpoint ? (
                  <code className="inline-code">{source.safeCollection.endpoint}</code>
                ) : null}
                <TokenList items={source.blockedBy} tone={source.status === "blocked" ? "critical" : "warning"} empty="Sin bloqueos" />
              </article>
            ))}
          </div>
        </section>
        <aside className="panel collector-side-panel">
          <PanelHeader title="Ingestion auditada" badge={collector.ingestionPolicy.snapshotSchemaVersion} />
          <DefinitionGrid rows={[
            ["Manual snapshot", collector.ingestionPolicy.acceptsManualSnapshot ? "enabled" : "disabled"],
            ["Live mutation", collector.ingestionPolicy.acceptsLiveMutation ? "enabled" : "disabled"],
            ["Source changes", collector.ingestionPolicy.requiresOperatorApprovalForSourceChange ? "approval required" : "open"],
            ["Raw secrets", collector.ingestionPolicy.storesRawSecrets ? "stored" : "rejected"],
            ["Snapshot hash", collector.auditPolicy.snapshotHashRequired ? "required" : "optional"]
          ]} />
          <TokenGroup title="Gates" items={collector.gates} />
          <TokenGroup title="Next safe actions" items={collector.nextSafeActions} />
          <TokenGroup title="Blocked actions" items={collector.blockedActions} />
        </aside>
      </section>
      <section className="panel">
        <PanelHeader title="Snapshot manual" badge={ingestion.snapshotSchemaVersion} />
        <section className="snapshot-contract-grid">
          <div className="snapshot-contract-column">
            <DefinitionGrid rows={[
              ["Endpoint", `${ingestion.manualEndpoint.method} ${ingestion.manualEndpoint.path}`],
              ["Visible en panel", ingestion.manualEndpoint.exposedInAdminPanel ? "yes" : "no"],
              ["Aprobacion", ingestion.manualEndpoint.requiresHumanApproval ? "required" : "not required"],
              ["Raw payload", ingestion.manualEndpoint.storesRawPayload ? "stored" : "not stored"],
              ["UI mode", ingestion.uiPolicy.adminPanelShowsContractOnly ? "contract only" : "interactive"]
            ]} />
            <TokenGroup title="Required signals" items={requiredFields.map((field) => `${field.path} -> ${field.mapsTo}`)} />
          </div>
          <div className="snapshot-contract-column">
            <DefinitionGrid rows={[
              ["Redact before hash", ingestion.redactionPolicy.redactsBeforeHash ? "yes" : "no"],
              ["Stores raw secrets", ingestion.redactionPolicy.storesRawSecrets ? "yes" : "no"],
              ["Parser outputs", ingestion.parserOutputs.join(", ")],
              ["Panel methods", ingestion.uiPolicy.allowedPanelMethods.join(", ")]
            ]} />
            <TokenGroup title="Rejected keys" items={ingestion.redactionPolicy.rejectedKeys} />
          </div>
          <div className="snapshot-contract-column">
            <TokenGroup title="Gates" items={ingestion.gates} />
            <TokenGroup title="Next safe actions" items={ingestion.nextSafeActions} />
            <TokenGroup title="Blocked actions" items={ingestion.blockedActions} />
          </div>
        </section>
      </section>
    </section>
  );
}

function WorkflowSection({ data }: { data: DashboardData }) {
  return (
    <section className="page-stack">
      <TitleRow eyebrow="Ruta" title="Workflow operacional" badge={data.workflow.mode} />
      <section className="panel">
        <PanelHeader title="Frontera de lectura" badge={`${data.workflow.readBoundary.allowedEndpoints.length}`} />
        <TokenList items={data.workflow.readBoundary.allowedEndpoints} tone="neutral" empty="Sin endpoints" />
      </section>
      <section className="workflow-list">
        {data.workflow.steps.map((step) => (
          <article key={step.id} className={`workflow-step workflow-${stateTone(step.status)}`}>
            <div className="workflow-step-index">{step.order}</div>
            <div className="workflow-step-body">
              <div className="workflow-step-head">
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.operatorQuestion}</p>
                </div>
                <Badge tone={stateTone(step.status)}>{compactLabel(step.status)}</Badge>
              </div>
              <p className="workflow-purpose">{step.purpose}</p>
              <div className="workflow-grid">
                <TokenGroup title="Data sources" items={step.dataSources} />
                <TokenGroup title="Evidence" items={step.evidenceToShow} />
              </div>
              <p className="workflow-reason">{step.statusReason}</p>
            </div>
          </article>
        ))}
      </section>
    </section>
  );
}

function ClustersSection({ data }: { data: DashboardData }) {
  return (
    <section className="page-stack">
      <TitleRow eyebrow="Infraestructura" title="Clusters y VPS" badge={data.clusters.mode} />
      <section className="metric-grid">
        {Object.entries(data.clusters.totals).slice(0, 4).map(([key, value]) => (
          <MetricCard key={key} label={compactLabel(key)} value={formatNumber(value)} tone="neutral" meta="clusterOverview.totals" />
        ))}
      </section>
      <section className="workflow-list">
        {data.clusters.clusters.map((cluster, index) => (
          <article key={cluster.id} className={`workflow-step workflow-${stateTone(cluster.managementState)}`}>
            <div className="workflow-step-index">{index + 1}</div>
            <div className="workflow-step-body">
              <div className="workflow-step-head">
                <div>
                  <h3>{compactLabel(cluster.provider)}</h3>
                  <p>{cluster.id}</p>
                </div>
                <Badge tone={stateTone(cluster.managementState)}>{compactLabel(cluster.managementState)}</Badge>
              </div>
              <TokenList items={cluster.senderNodes.map((node) => `${node.label}: ${compactLabel(node.status)}`)} tone="neutral" empty="Sin nodos" />
            </div>
          </article>
        ))}
      </section>
    </section>
  );
}

function LearningSection({ data }: { data: DashboardData }) {
  return (
    <section className="page-stack">
      <TitleRow eyebrow="OpenClaw" title="Aprendizaje supervisado" badge={data.learningPlan.mode} />
      <section className="metric-grid metric-grid-compact">
        <MetricCard label="Stages" value={formatNumber(data.learningPlan.stages.length)} tone="neutral" meta="learningPlan.stages" />
        <MetricCard label="Signals" value={formatNumber(Object.keys(data.readinessSignals.scores).length)} tone="neutral" meta="readinessSignals.scores" />
        <MetricCard label="Self promote" value={data.readinessSignals.modelGovernance.canSelfPromote ? "enabled" : "blocked"} tone="critical" meta="modelGovernance" />
        <MetricCard label="Human approval" value={data.readinessSignals.modelGovernance.requiresHumanApproval ? "required" : "optional"} tone="warning" meta="modelGovernance" />
      </section>
      <section className="two-column">
        <section className="panel">
          <PanelHeader title="Readiness signals" badge={data.readinessSignals.modelGovernance.modelMode} />
          <div className="signal-list">
            {Object.entries(data.readinessSignals.scores).map(([key, score]) => (
              <article key={key} className={`signal-row signal-${stateTone(score.status)}`}>
                <div>
                  <strong>{compactLabel(key)}</strong>
                  <p>{compactLabel(score.reason)}</p>
                </div>
                <span>{score.score === null ? "unknown" : `${Math.round(score.score * 100)}%`}</span>
              </article>
            ))}
          </div>
        </section>
        <section className="panel">
          <PanelHeader title="Stages" badge={`${data.learningPlan.stages.length}`} />
          <div className="action-list">
            {data.learningPlan.stages.map((stage) => (
              <div key={stage.id} className="action-row">
                <Badge tone={stateTone(stage.status)}>{stage.order}</Badge>
                <span>{stage.label}</span>
              </div>
            ))}
          </div>
        </section>
      </section>
    </section>
  );
}

function SafetySection({ data }: { data: DashboardData }) {
  const killSwitchOn = data.killSwitch.enabled;
  const liveWritesOn = data.operatingNorth.liveInfrastructureWritesEnabled;
  const smtpRealOn = data.operatingNorth.delivrixSendsRealEmail;
  const nfcWritesOn = data.operatingNorth.nfcProductionWritesEnabled;
  const allBoundariesHeld = !liveWritesOn && !smtpRealOn && !nfcWritesOn;
  const gates = data.operatingNorth.gates ?? [];

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow="Barandillas"
        title="Seguridad operacional"
        description={
          allBoundariesHeld
            ? "Las cuatro fronteras del norte operativo estan respetadas. El panel no ejecuta acciones reales: ningun write a infra, SMTP, NFC ni cola productiva."
            : "Hay al menos una frontera operativa habilitada. Revisar antes de continuar."
        }
        badge={{
          label: killSwitchOn ? "Kill switch on" : "Kill switch off",
          tone: killSwitchOn ? "critical" : "success"
        }}
        endpoint="GET /v1/operating-north"
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <UiMetricCard
          label="Infra writes"
          value={liveWritesOn ? "Enabled" : "Disabled"}
          microcopy={liveWritesOn ? "Riesgo: writes en vivo" : "Solo dry-run en MVP"}
          microcopyTone={liveWritesOn ? "critical" : "success"}
        />
        <UiMetricCard
          label="SMTP real"
          value={smtpRealOn ? "Enabled" : "Disabled"}
          microcopy={smtpRealOn ? "Esta enviando correo real" : "Solo simulacion"}
          microcopyTone={smtpRealOn ? "critical" : "success"}
        />
        <UiMetricCard
          label="NFC writes"
          value={nfcWritesOn ? "Enabled" : "Disabled"}
          microcopy={nfcWritesOn ? "Productivo" : "Bridge en mock"}
          microcopyTone={nfcWritesOn ? "critical" : "success"}
        />
        <UiMetricCard
          label="Kill switch"
          value={killSwitchOn ? "Active" : "Inactive"}
          microcopy={
            killSwitchOn
              ? `Activado por ${data.killSwitch.updatedBy || "system"}`
              : "Listo para activar si hace falta"
          }
          microcopyTone={killSwitchOn ? "critical" : "success"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Acciones permitidas</CardTitle>
              <UiBadge tone="success">{formatNumber(data.operatingNorth.allowedActions.length)}</UiBadge>
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
              <UiBadge tone="critical">{formatNumber(data.operatingNorth.blockedActions.length)}</UiBadge>
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
              Lista de gates declarados por el norte operativo. Subir volumen o autonomia exige cumplir
              cada gate y dejarlo auditado.
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
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <RoleField label="Delivrix" value={compactLabel(data.operatingNorth.delivrixRole)} />
            <RoleField label="OpenClaw" value={compactLabel(data.operatingNorth.openClawRole)} />
            <RoleField label="NFC" value={compactLabel(data.operatingNorth.nfcRole)} />
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}

function ActionTokenList({
  items,
  tone,
  empty
}: {
  items: string[];
  tone: "success" | "warning" | "critical" | "neutral";
  empty: string;
}) {
  if (items.length === 0) {
    return (
      <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">{empty}</p>
    );
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
      <dt className="m-0 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
        {label}
      </dt>
      <dd className="m-0 text-[13px] text-[var(--color-text-primary)]">{value}</dd>
    </div>
  );
}

function useCanvasFlow(canvas: OpenClawCanvasPayload["canvas"]) {
  return useMemo(() => {
    const nodeOrder = new Map(canvas.nodes.map((node, index) => [node.id, index]));
    const nodes: Node[] = canvas.nodes.map((node, index) => ({
      id: node.id,
      position: {
        x: (index % 3) * 300,
        y: Math.floor(index / 3) * 190
      },
      data: {
        label: <CanvasNodeLabel node={node} />
      },
      className: `flow-node flow-node-${stateTone(node.status)}`,
      style: {
        width: 248
      }
    }));
    const edges: Edge[] = canvas.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      animated: stateTone(edge.status) === "warning" || stateTone(edge.status) === "critical",
      style: {
        stroke: edgeColor(edge.status),
        strokeWidth: 2
      },
      labelStyle: {
        fill: "#65717d",
        fontSize: 11,
        fontWeight: 700
      },
      zIndex: nodeOrder.get(edge.to) ?? 0
    }));

    return { nodes, edges };
  }, [canvas]);
}

function CanvasNodeLabel({ node }: { node: OpenClawCanvasPayload["canvas"]["nodes"][number] }) {
  return (
    <div className="flow-node-card">
      <div className="flow-node-head">
        <strong>{node.label}</strong>
        <Badge tone={stateTone(node.status)}>{compactLabel(node.status)}</Badge>
      </div>
      <p>{node.summary}</p>
      <div className="flow-metrics">
        {node.metrics.slice(0, 2).map((metric) => (
          <span key={metric.id}>{metric.label}: {formatMetricValue(metric.value, metric.unit)}</span>
        ))}
      </div>
    </div>
  );
}

function TitleRow({ eyebrow, title, badge }: { eyebrow: string; title: string; badge: string }) {
  return (
    <div className="page-title-row">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <Badge tone="neutral">{compactLabel(badge)}</Badge>
    </div>
  );
}

function PanelHeader({ title, badge }: { title: string; badge: string }) {
  return (
    <div className="panel-heading">
      <h3>{title}</h3>
      <Badge tone={stateTone(badge)}>{compactLabel(badge)}</Badge>
    </div>
  );
}

function MetricCard({ label, value, tone, meta }: { label: string; value: string; tone: Tone; meta: string }) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value metric-value-small">{value}</strong>
      <span className="metric-meta">{meta}</span>
    </article>
  );
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function StatusPill({ label, value }: { label: string; value: ContractStatus }) {
  const tone = stateTone(value);
  return (
    <span className={`status-pill status-${tone}`}>
      <span className="status-dot" />
      <span>{label}</span>
      <strong>{compactLabel(value)}</strong>
    </span>
  );
}

function TokenGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="workflow-token-group">
      <strong>{title}</strong>
      <TokenList items={items} tone="neutral" empty="Sin datos" />
    </div>
  );
}

function TokenList({ items, tone, empty }: { items: string[]; tone: Tone; empty: string }) {
  if (items.length === 0) {
    return <p className="empty-inline">{empty}</p>;
  }

  return (
    <div className="token-grid">
      {items.map((item) => (
        <Badge key={item} tone={tone}>{compactLabel(item)}</Badge>
      ))}
    </div>
  );
}

function DefinitionGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="definition-grid">
      {rows.map(([label, value]) => <DefinitionRow key={label} label={label} value={value} />)}
    </div>
  );
}

function DefinitionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="definition-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LoadingState() {
  return (
    <section className="skeleton-grid">
      <div className="skeleton skeleton-wide" />
      <div className="skeleton" />
      <div className="skeleton" />
      <div className="skeleton skeleton-table" />
    </section>
  );
}

function ErrorState({ message, onRefresh }: { message: string; onRefresh: () => void }) {
  return (
    <section className="notice notice-critical">
      <div>
        <h2>Gateway no disponible</h2>
        <p>{message}</p>
      </div>
      <button className="button button-secondary" type="button" onClick={onRefresh}>
        Actualizar
      </button>
    </section>
  );
}

function toneForSection(section: SectionId, data: DashboardData | undefined): Tone {
  if (!data) return "neutral";
  if (section === "canvas") return stateTone(data.canvas.nodes.find((node) => node.id === data.canvas.currentStepId)?.status);
  if (section === "hardware") return data.telemetry.summary.stale ? "warning" : stateTone(data.telemetry.summary.status);
  if (section === "collector") return stateTone(data.supervisedCollector.status);
  if (section === "workflow") return "success";
  if (section === "clusters") return stateTone(data.clusters.clusters[0]?.managementState ?? "unknown");
  if (section === "learning") return stateTone(data.readinessSignals.scores.provisioningReadiness?.status ?? "unknown");
  return data.operatingNorth.liveInfrastructureWritesEnabled || data.killSwitch.enabled ? "critical" : "success";
}

function edgeColor(status: ContractStatus): string {
  const tone = stateTone(status);
  if (tone === "success") return "#198754";
  if (tone === "warning") return "#b7791f";
  if (tone === "critical") return "#c2413a";
  return "#8b98a5";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "No se pudo cargar el panel.";
}
