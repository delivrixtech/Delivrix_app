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
  ReactFlow,
  type Edge,
  type Node
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
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
  humanize,
  stateTone,
  type Tone
} from "../shared/lib/formatters.ts";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge as UiBadge,
  BrandBlock,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DefinitionList,
  Eyebrow,
  FreshnessTag,
  MetricCard as UiMetricCard,
  ModeBadge,
  NoticeBanner,
  PageHeader,
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { nodes, edges } = useCanvasFlow(data.canvas);
  const current = data.canvas.nodes.find((node) => node.id === data.canvas.currentStepId);
  const selectedNode = selectedNodeId
    ? data.canvas.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;
  const blockerGroups = useMemo(() => groupBlockers(data.canvas.blockedBy), [data.canvas.blockedBy]);
  const hardwareBlockerCount = blockerGroups.hardware.length;
  const totalBlockers = data.canvas.blockedBy.length;
  const showRootCauseBanner = totalBlockers > 0 && hardwareBlockerCount >= Math.ceil(totalBlockers / 2);

  const incomingEdges = selectedNode
    ? data.canvas.edges.filter((edge) => edge.to === selectedNode.id)
    : [];
  const outgoingEdges = selectedNode
    ? data.canvas.edges.filter((edge) => edge.from === selectedNode.id)
    : [];

  return (
    <section className="flex flex-col gap-5 max-w-[1280px]">
      <PageHeader
        eyebrow="OpenClaw"
        title="Canvas vivo"
        description={
          totalBlockers > 0
            ? `Topologia del control plane con ${totalBlockers} bloqueos activos. Selecciona un nodo para ver detalle.`
            : "Topologia del control plane. Selecciona un nodo para ver detalle, dependencias y bloqueos."
        }
        badge={{ label: compactLabel(data.canvas.mode), tone: "neutral" }}
        endpoint="GET /v1/openclaw/live-canvas"
      />

      {showRootCauseBanner ? (
        <NoticeBanner
          tone="warning"
          title="Causa raiz: snapshot de hardware pendiente"
          description={`Ingestar un snapshot via POST /v1/devops/collector/manual-snapshots/ingest libera la mayoria de los ${totalBlockers} bloqueos (${hardwareBlockerCount} estan en hardware).`}
        />
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <UiMetricCard
          label="Paso actual"
          value={compactLabel(current?.label ?? data.canvas.currentStepId)}
          microcopy={compactLabel(current?.status)}
          microcopyTone={stateTone(current?.status) === "neutral" ? "neutral" : stateTone(current?.status)}
        />
        <UiMetricCard
          label="Nodos del grafo"
          value={formatNumber(data.canvas.nodes.length)}
          microcopy={`${formatNumber(data.canvas.edges.length)} dependencias`}
          microcopyTone="neutral"
        />
        <UiMetricCard
          label="Bloqueos activos"
          value={formatNumber(totalBlockers)}
          microcopy={
            totalBlockers === 0
              ? "Topologia limpia"
              : showRootCauseBanner
                ? "Causa raiz: 1"
                : `${blockerGroups.openclaw.length + blockerGroups.network.length + blockerGroups.provider.length + blockerGroups.other.length} otras categorias`
          }
          microcopyTone={totalBlockers === 0 ? "success" : "critical"}
        />
        <UiMetricCard
          label="Aprobaciones humanas"
          value={formatNumber(data.canvas.requiresHumanApproval.length)}
          microcopy="Pendientes de revisar"
          microcopyTone="warning"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-3">
        <Card className="overflow-hidden">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Topologia</CardTitle>
              <CanvasLegend />
            </div>
          </CardHeader>
          <div className="h-[560px] relative bg-[var(--color-bg)]">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.4}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => setSelectedNodeId(null)}
            >
              <Background gap={24} size={1} color="var(--color-border)" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          {selectedNode ? (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Eyebrow>Inspector</Eyebrow>
                    <CardTitle className="mt-1">{selectedNode.label}</CardTitle>
                  </div>
                  <UiBadge tone={stateTone(selectedNode.status) === "neutral" ? "neutral" : stateTone(selectedNode.status)}>
                    {compactLabel(selectedNode.status)}
                  </UiBadge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="m-0 mb-3 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                  {selectedNode.summary}
                </p>
                {selectedNode.metrics.length > 0 ? (
                  <DefinitionList
                    density="compact"
                    rows={selectedNode.metrics.map((metric) => ({
                      label: metric.label,
                      value: formatMetricValue(metric.value, metric.unit)
                    }))}
                  />
                ) : null}
                {(incomingEdges.length > 0 || outgoingEdges.length > 0) ? (
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div>
                      <p className="m-0 mb-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
                        Entra de
                      </p>
                      {incomingEdges.length === 0 ? (
                        <p className="m-0 text-[12px] text-[var(--color-text-tertiary)]">Sin dependencias.</p>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {incomingEdges.map((edge) => {
                            const source = data.canvas.nodes.find((n) => n.id === edge.from);
                            return (
                              <button
                                key={edge.id}
                                type="button"
                                onClick={() => setSelectedNodeId(edge.from)}
                                className="text-left text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
                              >
                                {source?.label ?? edge.from}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="m-0 mb-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
                        Alimenta a
                      </p>
                      {outgoingEdges.length === 0 ? (
                        <p className="m-0 text-[12px] text-[var(--color-text-tertiary)]">Sin descendientes.</p>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {outgoingEdges.map((edge) => {
                            const target = data.canvas.nodes.find((n) => n.id === edge.to);
                            return (
                              <button
                                key={edge.id}
                                type="button"
                                onClick={() => setSelectedNodeId(edge.to)}
                                className="text-left text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
                              >
                                {target?.label ?? edge.to}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-4"
                  onClick={() => setSelectedNodeId(null)}
                >
                  Cerrar inspector
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <Eyebrow>Inspector</Eyebrow>
                <CardTitle className="mt-1">Selecciona un nodo</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="m-0 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                  Click en cualquier nodo del canvas para ver detalle, dependencias y bloqueos asociados.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <CardTitle>Bloqueos por categoria</CardTitle>
                <UiBadge tone={totalBlockers === 0 ? "success" : "critical"}>{formatNumber(totalBlockers)}</UiBadge>
              </div>
            </CardHeader>
            <CardContent>
              {totalBlockers === 0 ? (
                <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">Sin bloqueos activos.</p>
              ) : (
                <Accordion type="multiple" className="flex flex-col gap-1.5">
                  {(
                    [
                      { key: "hardware", label: "Hardware", icon: "ti-cpu" },
                      { key: "openclaw", label: "OpenClaw", icon: "ti-brain" },
                      { key: "network", label: "Red", icon: "ti-network" },
                      { key: "provider", label: "Provider / DevOps", icon: "ti-building" },
                      { key: "other", label: "Otros", icon: "ti-tag" }
                    ] as const
                  ).map((group) => {
                    const items = blockerGroups[group.key];
                    if (items.length === 0) return null;
                    return (
                      <AccordionItem key={group.key} value={group.key}>
                        <AccordionTrigger>
                          <span className="flex items-center gap-2">
                            <span className="font-medium text-[12px] text-[var(--color-text-primary)]">{group.label}</span>
                          </span>
                          <span className="tabular-nums text-[var(--color-text-secondary)]">
                            {items.length}
                          </span>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="flex flex-wrap gap-1.5">
                            {items.map((item) => (
                              <UiBadge key={item} tone="warning">{humanize(item)}</UiBadge>
                            ))}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <CardTitle>Timeline reciente</CardTitle>
                <UiBadge tone="outline">{formatNumber(data.canvas.timeline.length)}</UiBadge>
              </div>
            </CardHeader>
            <CardContent>
              {data.canvas.timeline.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">Sin eventos registrados.</p>
              ) : (
                <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
                  {data.canvas.timeline.slice(0, 5).map((event) => {
                    const tone = stateTone(event.status);
                    const dotColor =
                      tone === "success" ? "bg-[var(--color-success)]" :
                      tone === "warning" ? "bg-[var(--color-warning)]" :
                      tone === "critical" ? "bg-[var(--color-critical)]" :
                      "bg-[var(--color-text-tertiary)]";
                    return (
                      <li key={event.id} className="flex items-start gap-2.5 text-[12px]">
                        <span aria-hidden="true" className={cn("block h-2 w-2 rounded-full mt-1.5 shrink-0", dotColor)} />
                        <div className="min-w-0">
                          <p className="m-0 text-[var(--color-text-primary)]">{compactLabel(event.action)}</p>
                          <p className="m-0 text-[11px] text-[var(--color-text-tertiary)]">
                            {event.actor} · {formatDateTime(event.occurredAt)}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

function CanvasLegend() {
  const items: Array<{ label: string; color: string }> = [
    { label: "Ready", color: "var(--color-success)" },
    { label: "Needs review", color: "var(--color-warning)" },
    { label: "Blocked", color: "var(--color-critical)" },
    { label: "Not started", color: "var(--color-text-tertiary)" }
  ];
  return (
    <div className="flex flex-wrap items-center gap-3">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
          <span aria-hidden="true" className="h-2 w-2 rounded-[2px]" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function groupBlockers(blockers: string[]) {
  const groups = {
    hardware: [] as string[],
    openclaw: [] as string[],
    network: [] as string[],
    provider: [] as string[],
    other: [] as string[]
  };
  for (const blocker of blockers) {
    const lower = blocker.toLowerCase();
    if (/cpu|ram|memory|storage|smart|power|fan|chassis|thermal|hardware|temperature|psu|ups|uptime|kernel|model|server|capacity/.test(lower)) {
      groups.hardware.push(blocker);
    } else if (/openclaw|readiness|learning|plan|stage|signal|evidence|onboarding|topology|provisioning|scheduler|skill|llm/.test(lower)) {
      groups.openclaw.push(blocker);
    } else if (/network|ip pool|ip type|uplink|dns|interface|rx mbps|tx mbps|latency|ptr|dkim|tls/.test(lower)) {
      groups.network.push(blocker);
    } else if (/provider|isp|webdock|proxmox|ipmi|prometheus|bmc|ssh|hostinger|aws|approval|operator/.test(lower)) {
      groups.provider.push(blocker);
    } else {
      groups.other.push(blocker);
    }
  }
  return groups;
}

function HardwareSection({ data }: { data: DashboardData }) {
  const capacity = data.physicalHost.capacity;
  const telemetry = data.telemetry;
  const collector = data.collector;
  const identity = data.physicalHost.identity;
  const physicalHost = data.physicalHost;
  const unknownInventoryFields = physicalHost.quality.unknownFields.map(humanize);
  const unknownTelemetryFields = telemetry.quality.unknownFields.map(humanize);
  const unknownCollectorFields = collector.unknownCapabilities.map(humanize);
  const inventoryComplete = unknownInventoryFields.length === 0;
  const inventoryMissingRatio = inventoryComplete ? 0 : unknownInventoryFields.length / 10;
  const showInventoryBlocker = inventoryMissingRatio >= 0.5;

  const microcopyForCapacity = (value: number | null) =>
    value === null
      ? { copy: "Esperando snapshot manual", tone: "warning" as Tone }
      : { copy: "Snapshot vigente", tone: "success" as Tone };

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow="Servidor fisico"
        title="Hardware y telemetria"
        description="Inventario y telemetria del host fisico Delivrix en Popayan. Los datos provienen del snapshot read-only ingestado por el collector supervisado, no de live polling."
        badge={{
          label: compactLabel(physicalHost.source.kind),
          tone: physicalHost.source.kind === "mock" ? "warning" : "neutral"
        }}
        endpoint="GET /v1/hardware/physical-host"
      />

      {showInventoryBlocker ? (
        <NoticeBanner
          tone="warning"
          title="Inventario pendiente"
          description="Faltan datos clave del host fisico. Ingestar un snapshot via POST /v1/devops/collector/manual-snapshots/ingest libera la mayoria de campos unknown."
        />
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <UiMetricCard
          label="CPU cores"
          value={formatMetricValue(capacity.cpuCores, "cores")}
          microcopy={microcopyForCapacity(capacity.cpuCores).copy}
          microcopyTone={microcopyForCapacity(capacity.cpuCores).tone}
        />
        <UiMetricCard
          label="RAM"
          value={formatMetricValue(capacity.memoryGb, "GB")}
          microcopy={microcopyForCapacity(capacity.memoryGb).copy}
          microcopyTone={microcopyForCapacity(capacity.memoryGb).tone}
        />
        <UiMetricCard
          label="Storage"
          value={formatMetricValue(capacity.storageUsableGb, "GB")}
          microcopy={microcopyForCapacity(capacity.storageUsableGb).copy}
          microcopyTone={microcopyForCapacity(capacity.storageUsableGb).tone}
        />
        <UiMetricCard
          label="IP pool"
          value={formatMetricValue(capacity.ipPoolSize, "IPs")}
          microcopy={microcopyForCapacity(capacity.ipPoolSize).copy}
          microcopyTone={microcopyForCapacity(capacity.ipPoolSize).tone}
        />
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

function CollectorSection({ data }: { data: DashboardData }) {
  const collector = data.supervisedCollector;
  const ingestion = data.snapshotIngestion;
  const blockedSources = collector.sources.filter((source) => source.status === "blocked").length;
  const reviewSources = collector.sources.filter((source) => source.status === "needs_review").length;
  const requiredFields = ingestion.acceptedFieldPaths.filter((field) => field.requiredFor !== "optional");
  const uiPostEnabled = ingestion.uiPolicy.adminPanelCanPost;

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow="DevOps"
        title="Collector supervisado"
        description="El collector observa el host fisico, Proxmox y Prometheus en modo read-only y propone los siguientes pasos seguros sin escribir nada. El panel solo lee el contrato, no inicia colecciones ni postea snapshots."
        badge={{
          label: compactLabel(collector.collectorMode),
          tone: "neutral"
        }}
        endpoint="GET /v1/devops/collector/supervised-plan"
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
          microcopy={uiPostEnabled ? "UI puede mutar - revisar" : "Read-only enforced"}
          microcopyTone={uiPostEnabled ? "critical" : "success"}
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

function CollectorTokenGroup({ label, tone, items }: { label: string; tone: "success" | "warning" | "critical" | "neutral"; items: string[] }) {
  return (
    <div>
      <p className="m-0 mb-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">{label}</p>
      {items.length === 0 ? (
        <p className="m-0 text-[12px] text-[var(--color-text-tertiary)]">Sin items.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <UiBadge key={item} tone={tone}>{compactLabel(item)}</UiBadge>
          ))}
        </div>
      )}
    </div>
  );
}

type WorkflowFilter = "all" | "pending" | "blocked";

function WorkflowSection({ data }: { data: DashboardData }) {
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
        eyebrow="Ruta"
        title="Workflow operacional"
        description="Secuencia de pasos que el operador humano debe seguir para diagnosticar el control plane. Cada paso describe la pregunta, las fuentes de datos y la evidencia esperada."
        badge={{ label: compactLabel(data.workflow.mode), tone: "neutral" }}
        endpoint="GET /v1/admin/workflow"
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

function ClustersSection({ data }: { data: DashboardData }) {
  const totals = data.clusters.totals;
  const totalClusters = totals.clusters ?? data.clusters.clusters.length;
  const totalSenderNodes = totals.senderNodes ?? data.clusters.clusters.reduce((sum, c) => sum + c.senderNodes.length, 0);
  const totalProvisioningRuns = totals.provisioningRuns ?? 0;
  const totalActiveOrWarming = totals.activeOrWarmingNodes ?? 0;

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow="Infraestructura"
        title="Clusters y VPS"
        description="Inventario de clusters de sender nodes gobernados por Delivrix. Cada cluster agrupa VPS/LXC por proveedor y muestra los nodos vivos con su estado operacional."
        badge={{ label: compactLabel(data.clusters.mode), tone: "neutral" }}
        endpoint="GET /v1/admin/clusters"
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

function LearningSection({ data }: { data: DashboardData }) {
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
        eyebrow="OpenClaw"
        title="Aprendizaje supervisado"
        description="OpenClaw aprende por evidencia curada, no se auto-promueve y depende de aprobacion humana. Esta pantalla expone los signals de readiness y los stages del plan de aprendizaje."
        badge={{ label: compactLabel(data.learningPlan.mode), tone: "neutral" }}
        endpoint="GET /v1/openclaw/learning-plan"
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
          microcopy={canSelfPromote ? "Riesgo: modelo se auto-asciende" : "Modelo no se auto-asciende"}
          microcopyTone={canSelfPromote ? "critical" : "success"}
        />
        <UiMetricCard
          label="Human approval"
          value={requiresHumanApproval ? "Required" : "Optional"}
          microcopy={requiresHumanApproval ? "Barandilla activa" : "Sin revisor humano"}
          microcopyTone={requiresHumanApproval ? "success" : "critical"}
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

const NODE_WIDTH = 200;
const NODE_HEIGHT = 84;

function useCanvasFlow(canvas: OpenClawCanvasPayload["canvas"]) {
  return useMemo(() => {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 56, marginx: 24, marginy: 24 });
    graph.setDefaultEdgeLabel(() => ({}));

    canvas.nodes.forEach((node) => {
      graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    });
    canvas.edges.forEach((edge) => {
      graph.setEdge(edge.from, edge.to);
    });

    dagre.layout(graph);

    const nodes: Node[] = canvas.nodes.map((node) => {
      const layout = graph.node(node.id);
      return {
        id: node.id,
        position: {
          x: (layout?.x ?? 0) - NODE_WIDTH / 2,
          y: (layout?.y ?? 0) - NODE_HEIGHT / 2
        },
        data: {
          label: <CanvasNodeLabel node={node} />
        },
        className: `delivrix-node delivrix-node-${stateTone(node.status)}`,
        style: { width: NODE_WIDTH }
      };
    });

    const nodeOrder = new Map(canvas.nodes.map((node, index) => [node.id, index]));
    const edges: Edge[] = canvas.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      animated: stateTone(edge.status) === "warning" || stateTone(edge.status) === "critical",
      style: {
        stroke: edgeColor(edge.status),
        strokeWidth: 1.5
      },
      labelStyle: {
        fill: "var(--color-text-secondary)",
        fontSize: 11,
        fontWeight: 500
      },
      labelBgStyle: {
        fill: "var(--color-surface)",
        stroke: "var(--color-border)",
        strokeWidth: 0.5
      },
      labelBgPadding: [6, 4],
      labelBgBorderRadius: 4,
      zIndex: nodeOrder.get(edge.to) ?? 0
    }));

    return { nodes, edges };
  }, [canvas]);
}

function CanvasNodeLabel({ node }: { node: OpenClawCanvasPayload["canvas"]["nodes"][number] }) {
  const tone = stateTone(node.status);
  return (
    <div className="flex flex-col gap-1 px-3 py-2 text-left">
      <div className="flex items-start justify-between gap-2">
        <strong className="m-0 text-[12px] font-medium text-[var(--color-text-primary)] leading-tight">
          {node.label}
        </strong>
        <UiBadge size="sm" tone={tone === "neutral" ? "neutral" : tone}>
          {compactLabel(node.status)}
        </UiBadge>
      </div>
      <p className="m-0 text-[11px] leading-snug text-[var(--color-text-secondary)] line-clamp-2">
        {node.summary}
      </p>
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
