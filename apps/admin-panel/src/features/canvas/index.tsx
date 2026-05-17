/**
 * Canvas feature: topologia del control plane.
 *
 * Renderiza el grafo de nodos OpenClaw, el inspector lateral del nodo
 * seleccionado, los bloqueos agrupados por categoria (categoria viene del
 * contrato) y la timeline reciente. Microcopy del banner root-cause sale de
 * `root-cause.ts` (frontend redaction). La decision operacional vive en
 * `OpenClawCanvasPayload.blockedBy[*]` del contrato.
 */

import { useMemo, useState } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node
} from "@xyflow/react";
import type {
  ContractStatus,
  DashboardData,
  OpenClawCanvasPayload
} from "../../shared/api/client.ts";
import {
  compactLabel,
  formatDateTime,
  formatMetricValue,
  formatNumber,
  humanize,
  stateTone,
  type Tone
} from "../../shared/lib/formatters.ts";
import { cn } from "../../shared/lib/cn.ts";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge as UiBadge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DefinitionList,
  Eyebrow,
  MetricCard as UiMetricCard,
  NoticeBanner,
  PageHeader
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";
import { describeHardwareRootCause } from "./root-cause.ts";

type CanvasBlocker = OpenClawCanvasPayload["canvas"]["blockedBy"][number];
type CanvasBlockerCategory = CanvasBlocker["category"];
type CanvasBlockerGroups = Record<CanvasBlockerCategory, CanvasBlocker[]>;

const blockerCategoryOrder: CanvasBlockerCategory[] = [
  "hardware",
  "openclaw",
  "network",
  "provider",
  "other"
];

const blockerCategoryLabels: Record<CanvasBlockerCategory, string> = {
  hardware: "Hardware",
  openclaw: "OpenClaw",
  network: "Red",
  provider: "Provider / DevOps",
  other: "Otros"
};

const CANVAS_LEGEND_STATES: ContractStatus[] = [
  "ready",
  "needs_review",
  "blocked",
  "not_started"
];

const NODE_WIDTH = 200;
const NODE_HEIGHT = 84;

function groupCanvasBlockers(blockers: CanvasBlocker[]): CanvasBlockerGroups {
  const groups: CanvasBlockerGroups = {
    hardware: [],
    openclaw: [],
    network: [],
    provider: [],
    other: []
  };
  for (const blocker of blockers) {
    const bucket = groups[blocker.category];
    if (bucket) {
      bucket.push(blocker);
    } else {
      groups.other.push(blocker);
    }
  }
  return groups;
}

function hardwareBlockersAreRootCause(blockers: CanvasBlocker[]): boolean {
  if (blockers.length === 0) return false;
  const hardwareCount = blockers.filter((blocker) => blocker.category === "hardware").length;
  return hardwareCount >= Math.ceil(blockers.length / 2);
}

function toneColorVar(tone: Tone): string {
  if (tone === "success") return "var(--color-success)";
  if (tone === "warning") return "var(--color-warning)";
  if (tone === "critical") return "var(--color-critical)";
  return "var(--color-text-tertiary)";
}

function edgeColor(status: ContractStatus): string {
  const tone = stateTone(status);
  if (tone === "success") return "#198754";
  if (tone === "warning") return "#b7791f";
  if (tone === "critical") return "#c2413a";
  return "#8b98a5";
}

function CanvasLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {CANVAS_LEGEND_STATES.map((status) => (
        <span
          key={status}
          className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]"
        >
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-[2px]"
            style={{ background: toneColorVar(stateTone(status)) }}
          />
          {compactLabel(status)}
        </span>
      ))}
    </div>
  );
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

export function CanvasSection({ data }: { data: DashboardData }) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { nodes, edges } = useCanvasFlow(data.canvas);
  const current = data.canvas.nodes.find((node) => node.id === data.canvas.currentStepId);
  const selectedNode = selectedNodeId
    ? data.canvas.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;
  const blockerGroups = useMemo(() => groupCanvasBlockers(data.canvas.blockedBy), [data.canvas.blockedBy]);
  const hardwareBlockerCount = blockerGroups.hardware.length;
  const totalBlockers = data.canvas.blockedBy.length;
  const showRootCauseBanner = hardwareBlockersAreRootCause(data.canvas.blockedBy);

  const incomingEdges = selectedNode
    ? data.canvas.edges.filter((edge) => edge.to === selectedNode.id)
    : [];
  const outgoingEdges = selectedNode
    ? data.canvas.edges.filter((edge) => edge.from === selectedNode.id)
    : [];

  return (
    <section className="flex flex-col gap-5 max-w-[1280px]">
      <PageHeader
        eyebrow={getSection("canvas").eyebrow}
        title={getSection("canvas").title}
        description={getSection("canvas").description}
        badge={{ label: compactLabel(data.canvas.mode), tone: "neutral" }}
        endpoint={formatEndpointBadge(getSection("canvas").endpoint)}
      />

      {showRootCauseBanner ? (() => {
        const notice = describeHardwareRootCause(totalBlockers, hardwareBlockerCount);
        return <NoticeBanner tone="warning" title={notice.title} description={notice.description} />;
      })() : null}

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
                  {blockerCategoryOrder.map((category) => {
                    const items = blockerGroups[category];
                    if (items.length === 0) return null;
                    return (
                      <AccordionItem key={category} value={category}>
                        <AccordionTrigger>
                          <span className="font-medium text-[12px] text-[var(--color-text-primary)]">
                            {blockerCategoryLabels[category]}
                          </span>
                          <span className="tabular-nums text-[var(--color-text-secondary)]">
                            {items.length}
                          </span>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="flex flex-wrap gap-1.5">
                            {items.map((item) => (
                              <UiBadge key={item.code} tone={item.severity}>
                                {item.label || humanize(item.code)}
                              </UiBadge>
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
