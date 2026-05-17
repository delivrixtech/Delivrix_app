/**
 * Canvas (OpenClaw) — pantalla del control plane.
 *
 * Pencil frame `m4v5T` / `gvu8o`. Layout:
 *   Body horizontal: Canvas wrap (flex) + Detail panel 360w sticky right.
 *
 * Render:
 *   - Topología con ReactFlow auto-layout (dagre TB).
 *   - Inspector del nodo seleccionado (metrics + dependencias).
 *   - Bloqueos agrupados por categoría (del contrato `blockedBy[*].category`).
 *   - Timeline reciente.
 *
 * El panel es 100% GET. Categorías y severidades vienen del contrato.
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
  formatNumber,
  humanize,
  stateTone,
  type Tone
} from "../../shared/lib/formatters.ts";

type CanvasBlocker = OpenClawCanvasPayload["canvas"]["blockedBy"][number];
type CanvasBlockerCategory = CanvasBlocker["category"];

const BLOCKER_CATEGORY_ORDER: CanvasBlockerCategory[] = [
  "hardware",
  "openclaw",
  "network",
  "provider",
  "other"
];

const BLOCKER_CATEGORY_LABELS: Record<CanvasBlockerCategory, string> = {
  hardware: "Hardware",
  openclaw: "OpenClaw",
  network: "Red",
  provider: "Provider / DevOps",
  other: "Otros"
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 92;

export function CanvasSection({ data }: { data: DashboardData }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvas = data.canvas;
  const { nodes, edges } = useCanvasFlow(canvas);
  const selectedNode = selectedId
    ? canvas.nodes.find((n) => n.id === selectedId) ?? null
    : null;
  const blockerGroups = useMemo(() => groupBlockers(canvas.blockedBy), [canvas.blockedBy]);

  return (
    <section className="flex flex-col gap-5" style={{ maxWidth: 1352 }}>
      <Hero canvas={canvas} />

      <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
        <CanvasWrap nodes={nodes} edges={edges} onSelect={setSelectedId} />
        <DetailPanel
          selected={selectedNode}
          allNodes={canvas.nodes}
          allEdges={canvas.edges}
          blockerGroups={blockerGroups}
          timeline={canvas.timeline}
          requiresApproval={canvas.requiresHumanApproval}
          onSelect={setSelectedId}
        />
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Hero
 * ------------------------------------------------------------------------ */
function Hero({ canvas }: { canvas: OpenClawCanvasPayload["canvas"] }) {
  const current = canvas.nodes.find((n) => n.id === canvas.currentStepId);
  return (
    <header className="flex items-end justify-between gap-3 flex-wrap">
      <div className="flex flex-col gap-2.5 min-w-0">
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          OPENCLAW · CANVAS EN VIVO
        </span>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
          style={{ letterSpacing: "-0.4px" }}
        >
          Topología del control plane
        </h1>
        <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
          Grafo de nodos OpenClaw con dependencias, bloqueos por categoría y timeline reciente.
          Datos del contrato `/v1/openclaw/canvas`.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-block rounded-[4px] border border-[#EAE0CE] bg-[#FFFFFF] px-2.5 py-1 text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]"
        >
          paso actual: {compactLabel(current?.label ?? canvas.currentStepId)}
        </span>
        <span
          className="inline-block rounded-[4px] px-2.5 py-1 text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{
            background: canvas.blockedBy.length === 0 ? "#DCFCE7" : "#FEE2E2",
            color: canvas.blockedBy.length === 0 ? "#15803D" : "#B91C1C",
            letterSpacing: "0.4px"
          }}
        >
          {canvas.blockedBy.length === 0
            ? "topología limpia"
            : `${formatNumber(canvas.blockedBy.length)} bloqueos`}
        </span>
      </div>
    </header>
  );
}

/* --------------------------------------------------------------------------
 * Canvas wrap (ReactFlow)
 * ------------------------------------------------------------------------ */
function useCanvasFlow(canvas: OpenClawCanvasPayload["canvas"]) {
  return useMemo(() => {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: "TB", nodesep: 32, ranksep: 64, marginx: 24, marginy: 24 });
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
        data: { label: <CanvasNodeLabel node={node} /> },
        className: "delivrix-canvas-node",
        style: { width: NODE_WIDTH, padding: 0, border: "none", background: "transparent" }
      };
    });

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
        fill: "#5C544A",
        fontSize: 11,
        fontFamily: "var(--font-mono)"
      },
      labelBgStyle: {
        fill: "#FFFFFF",
        stroke: "#EAE0CE",
        strokeWidth: 0.5
      },
      labelBgPadding: [6, 4],
      labelBgBorderRadius: 4
    }));

    return { nodes, edges };
  }, [canvas]);
}

function edgeColor(status: ContractStatus): string {
  const tone = stateTone(status);
  if (tone === "success") return "#15803D";
  if (tone === "warning") return "#B45309";
  if (tone === "critical") return "#B91C1C";
  return "#8A8073";
}

function CanvasNodeLabel({
  node
}: {
  node: OpenClawCanvasPayload["canvas"]["nodes"][number];
}) {
  const tone = stateTone(node.status);
  const toneStyle = nodeToneStyle(tone);
  return (
    <div
      className="flex flex-col gap-1.5 rounded-[6px] border bg-[#FFFFFF] px-3 py-2.5 text-left"
      style={{
        borderColor: toneStyle.border,
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <strong className="m-0 text-[12px] font-[family-name:var(--font-sans)] font-semibold leading-tight text-[#1A1410] truncate">
          {node.label}
        </strong>
        <span
          className="inline-block rounded-[4px] px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase whitespace-nowrap"
          style={{ background: toneStyle.bg, color: toneStyle.fg, letterSpacing: "0.4px" }}
        >
          {compactLabel(node.status)}
        </span>
      </div>
      <p className="m-0 text-[11px] font-[family-name:var(--font-sans)] leading-snug text-[#5C544A] line-clamp-2">
        {node.summary}
      </p>
    </div>
  );
}

function nodeToneStyle(tone: Tone): { bg: string; fg: string; border: string } {
  if (tone === "success") return { bg: "#DCFCE7", fg: "#15803D", border: "#15803D" };
  if (tone === "warning") return { bg: "#FEF3C7", fg: "#B45309", border: "#B45309" };
  if (tone === "critical") return { bg: "#FEE2E2", fg: "#B91C1C", border: "#B91C1C" };
  return { bg: "#F5F5F4", fg: "#5C544A", border: "#EAE0CE" };
}

function CanvasWrap({
  nodes,
  edges,
  onSelect
}: {
  nodes: Node[];
  edges: Edge[];
  onSelect: (id: string | null) => void;
}) {
  return (
    <div
      className="rounded-[8px] border border-[#EAE0CE] overflow-hidden"
      style={{ height: 620, background: "#FFFBF5", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
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
        onNodeClick={(_e, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background gap={24} size={1} color="#EAE0CE" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Detail panel
 * ------------------------------------------------------------------------ */
function DetailPanel({
  selected,
  allNodes,
  allEdges,
  blockerGroups,
  timeline,
  requiresApproval,
  onSelect
}: {
  selected: OpenClawCanvasPayload["canvas"]["nodes"][number] | null;
  allNodes: OpenClawCanvasPayload["canvas"]["nodes"];
  allEdges: OpenClawCanvasPayload["canvas"]["edges"];
  blockerGroups: Record<CanvasBlockerCategory, CanvasBlocker[]>;
  timeline: OpenClawCanvasPayload["canvas"]["timeline"];
  requiresApproval: string[];
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="flex flex-col gap-3.5">
      {selected ? (
        <SelectedNodeCard
          node={selected}
          allNodes={allNodes}
          allEdges={allEdges}
          onSelect={onSelect}
        />
      ) : (
        <EmptyInspectorCard />
      )}

      <BlockersCard groups={blockerGroups} />

      <TimelineCard timeline={timeline} />

      <ApprovalsCard items={requiresApproval} />
    </aside>
  );
}

function EmptyInspectorCard() {
  return (
    <section
      className="flex flex-col gap-2 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 18, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <span
        className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
        style={{ letterSpacing: "1.2px" }}
      >
        INSPECTOR
      </span>
      <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
        Selecciona un nodo
      </h2>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Click en cualquier nodo del grafo para ver detalle, dependencias y bloqueos asociados.
      </p>
    </section>
  );
}

function SelectedNodeCard({
  node,
  allNodes,
  allEdges,
  onSelect
}: {
  node: OpenClawCanvasPayload["canvas"]["nodes"][number];
  allNodes: OpenClawCanvasPayload["canvas"]["nodes"];
  allEdges: OpenClawCanvasPayload["canvas"]["edges"];
  onSelect: (id: string) => void;
}) {
  const tone = stateTone(node.status);
  const incoming = allEdges.filter((e) => e.to === node.id);
  const outgoing = allEdges.filter((e) => e.from === node.id);
  const toneStyle = nodeToneStyle(tone);
  return (
    <section
      className="flex flex-col gap-2.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 18, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
            style={{ letterSpacing: "1.2px" }}
          >
            {humanize(node.kind)}
          </span>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            {node.label}
          </h2>
        </div>
        <span
          className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase whitespace-nowrap"
          style={{ background: toneStyle.bg, color: toneStyle.fg, letterSpacing: "0.4px" }}
        >
          {compactLabel(node.status)}
        </span>
      </header>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        {node.summary}
      </p>

      {node.metrics.length > 0 ? (
        <dl className="m-0 flex flex-col gap-1.5">
          {node.metrics.slice(0, 4).map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3">
              <dt
                className="m-0 text-[10px] font-[family-name:var(--font-caption)] uppercase text-[#8A8073]"
                style={{ letterSpacing: "0.4px" }}
              >
                {m.label}
              </dt>
              <dd className="m-0 text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410] tabular-nums">
                {m.value !== null ? m.value : "—"}
                {m.unit ? ` ${m.unit}` : ""}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {incoming.length > 0 || outgoing.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#EAE0CE]">
          <div className="flex flex-col gap-1">
            <span
              className="text-[10px] font-[family-name:var(--font-caption)] uppercase text-[#8A8073]"
              style={{ letterSpacing: "0.4px" }}
            >
              Entra de
            </span>
            {incoming.map((e) => {
              const source = allNodes.find((n) => n.id === e.from);
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onSelect(e.from)}
                  className="text-left text-[11px] font-[family-name:var(--font-sans)] text-[#5C544A] hover:text-[#EA580C] transition-colors"
                >
                  {source?.label ?? e.from}
                </button>
              );
            })}
          </div>
          <div className="flex flex-col gap-1">
            <span
              className="text-[10px] font-[family-name:var(--font-caption)] uppercase text-[#8A8073]"
              style={{ letterSpacing: "0.4px" }}
            >
              Alimenta a
            </span>
            {outgoing.map((e) => {
              const target = allNodes.find((n) => n.id === e.to);
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onSelect(e.to)}
                  className="text-left text-[11px] font-[family-name:var(--font-sans)] text-[#5C544A] hover:text-[#EA580C] transition-colors"
                >
                  {target?.label ?? e.to}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function groupBlockers(blockers: CanvasBlocker[]): Record<CanvasBlockerCategory, CanvasBlocker[]> {
  const groups: Record<CanvasBlockerCategory, CanvasBlocker[]> = {
    hardware: [],
    openclaw: [],
    network: [],
    provider: [],
    other: []
  };
  for (const b of blockers) {
    const bucket = groups[b.category];
    if (bucket) bucket.push(b);
    else groups.other.push(b);
  }
  return groups;
}

function BlockersCard({
  groups
}: {
  groups: Record<CanvasBlockerCategory, CanvasBlocker[]>;
}) {
  const total = Object.values(groups).reduce((a, b) => a + b.length, 0);
  return (
    <section
      className="flex flex-col gap-2.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 18, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Bloqueos por categoría
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            background: total === 0 ? "#DCFCE7" : "#FEE2E2",
            color: total === 0 ? "#15803D" : "#B91C1C"
          }}
        >
          {formatNumber(total)}
        </span>
      </header>
      {total === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Sin bloqueos activos.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {BLOCKER_CATEGORY_ORDER.map((cat) => {
            const items = groups[cat];
            if (items.length === 0) return null;
            return (
              <div key={cat} className="flex flex-col gap-1">
                <span
                  className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
                  style={{ letterSpacing: "0.4px" }}
                >
                  {BLOCKER_CATEGORY_LABELS[cat]} · {formatNumber(items.length)}
                </span>
                <div className="flex flex-wrap gap-1">
                  {items.map((b, index) => (
                    <span
                      key={`${b.category}:${b.code}:${index}`}
                      className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-mono)]"
                      style={{
                        background: b.severity === "critical" ? "#FEE2E2" : "#FEF3C7",
                        color: b.severity === "critical" ? "#B91C1C" : "#B45309"
                      }}
                    >
                      {b.label || humanize(b.code)}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TimelineCard({
  timeline
}: {
  timeline: OpenClawCanvasPayload["canvas"]["timeline"];
}) {
  return (
    <section
      className="flex flex-col gap-2.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 18, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Timeline reciente
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block rounded-[4px] border border-[#EAE0CE] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A]"
        >
          {formatNumber(timeline.length)}
        </span>
      </header>
      {timeline.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Sin eventos registrados.
        </p>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
          {timeline.slice(0, 5).map((e) => {
            const tone = stateTone(e.status);
            return (
              <li
                key={e.id}
                className="flex items-start gap-2 text-[11px] font-[family-name:var(--font-mono)]"
              >
                <span
                  aria-hidden="true"
                  className="block h-1.5 w-1.5 rounded-full mt-1.5 shrink-0"
                  style={{
                    background:
                      tone === "success"
                        ? "#15803D"
                        : tone === "warning"
                          ? "#B45309"
                          : tone === "critical"
                            ? "#B91C1C"
                            : "#8A8073"
                  }}
                />
                <div className="flex flex-col min-w-0">
                  <span className="text-[#1A1410]">{compactLabel(e.action)}</span>
                  <span className="text-[#8A8073]">
                    {e.actor} · {formatDateTime(e.occurredAt)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ApprovalsCard({ items }: { items: string[] }) {
  return (
    <section
      className="flex flex-col gap-2.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 18, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Aprobaciones humanas
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            background: items.length === 0 ? "#DCFCE7" : "#FEF3C7",
            color: items.length === 0 ? "#15803D" : "#B45309"
          }}
        >
          {formatNumber(items.length)}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Cola de aprobaciones vacía.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.slice(0, 6).map((id) => (
            <span
              key={id}
              className="inline-block rounded-[4px] bg-[#FEF3C7] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] text-[#B45309]"
            >
              {compactLabel(id)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
