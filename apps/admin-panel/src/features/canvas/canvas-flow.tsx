/**
 * CanvasFlow — Canvas operacional OpenClaw renderizado con ReactFlow (@xyflow/react v12).
 *
 * Reemplaza el viejo `<Swimlanes>` + `<NodeCard>` de swimlanes con scroll horizontal manual
 * (1100 LOC de chrome a mano) por una pizarra real con:
 *
 *   - nodos custom (DelivrixCanvasNode) que respetan los design tokens y estados
 *   - edges del contrato canvas.edges con color/animación según status
 *   - pan + zoom nativos (sin CSS transform que distorsiona texto)
 *   - background grid + minimap + controls built-in
 *   - pulse halo en cambios de status (v2-tick-halo)
 *
 * Visión original recuperada: HITO_5_7_ADMIN_PANEL_REACT_CANVAS.md decía explícito
 * "Renderiza GET /v1/openclaw/live-canvas con React Flow: nodos, edges, timeline,
 * bloqueos, aprobaciones humanas, drill-down". El paquete siempre estuvo instalado
 * (@xyflow/react v12.10.2) pero el código previo no lo usaba.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  Boxes,
  Cpu,
  Database,
  Flame,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Mail,
  Network,
  Package,
  Radar,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Workflow
} from "lucide-react";
import type {
  OpenClawCanvasLane,
  OpenClawCanvasPayload
} from "../../shared/api/client.ts";

type CanvasData = OpenClawCanvasPayload["canvas"];
type CanvasNode = CanvasData["nodes"][number];
type CanvasEdge = CanvasData["edges"][number];

/** Lane order on Y axis. Lower index = upper lane. */
const LANE_ORDER: OpenClawCanvasLane[] = [
  "onboarding",
  "hardware",
  "provisioning",
  "warming",
  "reputation"
];

const LANE_COLOR: Record<OpenClawCanvasLane, string> = {
  onboarding: "var(--color-success)",
  hardware: "var(--color-info)",
  provisioning: "var(--color-accent-tertiary)",
  warming: "var(--color-warning)",
  reputation: "var(--color-neutral)"
};

const LANE_LABEL: Record<OpenClawCanvasLane, string> = {
  onboarding: "ONBOARDING",
  hardware: "HARDWARE",
  provisioning: "PROVISIONING",
  warming: "CALENTAMIENTO",
  reputation: "REPUTACIÓN"
};

// n8n-style: nodos cuadrados con icono Lucide centrado, label texto debajo.
const NODE_WIDTH = 80;
const NODE_HEIGHT = 80;
const NODE_LABEL_HEIGHT = 44; // espacio del label debajo del nodo
const COL_GAP = 120; // spacing generoso estilo n8n
const ROW_GAP = 100;
const ROW_OFFSET_X = 160;

type DelivrixNodeData = {
  node: CanvasNode;
  laneColor: string;
  selected: boolean;
  hasPrompt: boolean;
  pulseKey: number; // cambia cuando status cambia → trigger CSS halo
} & Record<string, unknown>;

type DelivrixNodeType = Node<DelivrixNodeData, "delivrix">;

interface CanvasFlowProps {
  canvas: CanvasData;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
}

/* ============================================================
 * statusToVisual — shared con index.tsx pero local por independencia
 * ============================================================ */
function statusToVisual(status: string): { dot: string; fg: string; label: string } {
  if (status === "ready") return { dot: "var(--color-success)", fg: "var(--color-success)", label: "listo" };
  if (status === "needs_review") return { dot: "var(--color-warning)", fg: "var(--color-warning)", label: "revisar" };
  if (status === "requires_approval") return { dot: "var(--color-unknown)", fg: "var(--color-unknown)", label: "aprobación" };
  if (status === "blocked") return { dot: "var(--color-critical)", fg: "var(--color-critical)", label: "bloqueado" };
  if (status === "collecting") return { dot: "var(--color-info)", fg: "var(--color-info)", label: "midiendo" };
  if (status === "in_progress") return { dot: "var(--color-accent-tertiary)", fg: "var(--color-accent-tertiary)", label: "en curso" };
  if (status === "disabled_by_mvp") return { dot: "var(--color-text-tertiary)", fg: "var(--color-text-tertiary)", label: "apagado" };
  if (status === "error") return { dot: "var(--color-critical)", fg: "var(--color-critical)", label: "error" };
  if (status === "not_started") return { dot: "var(--color-text-tertiary)", fg: "var(--color-text-tertiary)", label: "pendiente" };
  return { dot: "var(--color-text-tertiary)", fg: "var(--color-text-tertiary)", label: "desconocido" };
}

/* ============================================================
 * DelivrixCanvasNode — n8n-style: icono centrado + status dot esquina + label afuera
 * ============================================================ */

/** Mapea node.kind/label a un icono Lucide real. Estilo n8n: cada nodo tiene
 * personalidad visual identificable de un vistazo. */
type LucideIcon = ComponentType<{ size?: number; strokeWidth?: number; color?: string; style?: React.CSSProperties }>;

function nodeIcon(node: CanvasNode): LucideIcon {
  const k = (node.kind ?? "").toLowerCase();
  const lbl = node.label.toLowerCase();
  if (k.includes("dns") || lbl.includes("dns")) return Globe;
  if (k.includes("tls") || lbl.includes("tls") || lbl.includes("ssl") || lbl.includes("acme")) return ShieldCheck;
  if (k.includes("smtp") || lbl.includes("smtp") || lbl.includes("postfix") || lbl.includes("mail")) return Mail;
  if (k.includes("dkim") || lbl.includes("dkim") || k.includes("spf") || lbl.includes("spf") || lbl.includes("key")) return KeyRound;
  if (lbl.includes("inventario") || lbl.includes("inventory") || lbl.includes("captura")) return Package;
  if (lbl.includes("hardware") || lbl.includes("telemetry") || lbl.includes("cpu") || lbl.includes("ram")) return Cpu;
  if (lbl.includes("validac") || lbl.includes("validation") || lbl.includes("revisión")) return ShieldCheck;
  if (lbl.includes("proxmox") || lbl.includes("host")) return HardDrive;
  if (lbl.includes("cluster") || lbl.includes("topolog")) return Boxes;
  if (lbl.includes("vps") || lbl.includes("lxc") || lbl.includes("container")) return Server;
  if (lbl.includes("sender") || lbl.includes("envío") || lbl.includes("send")) return Send;
  if (lbl.includes("calenta") || lbl.includes("warmup") || lbl.includes("warming") || lbl.includes("rampa") || lbl.includes("ramp")) return Flame;
  if (lbl.includes("reputa")) return Sparkles;
  if (lbl.includes("escala") || lbl.includes("monitor") || lbl.includes("observe")) return Radar;
  if (lbl.includes("capaci") || lbl.includes("ready")) return Gauge;
  if (lbl.includes("collector") || lbl.includes("devops") || lbl.includes("snapshot")) return Database;
  if (lbl.includes("network") || lbl.includes("conn")) return Network;
  if (lbl.includes("plan") || lbl.includes("workflow")) return Workflow;
  // fallback
  return Activity;
}

function DelivrixCanvasNode({ data }: NodeProps<DelivrixNodeType>) {
  const { node, laneColor, selected, hasPrompt, pulseKey } = data;
  const visual = statusToVisual(node.status);
  const Icon = nodeIcon(node);
  const hasError = node.status === "blocked" || node.status === "error";
  const borderColor = selected
    ? laneColor
    : hasPrompt
      ? "var(--color-warning)"
      : "rgba(255,255,255,0.10)";
  const borderWidth = selected || hasPrompt ? 2 : 1;

  return (
    <div
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT + NODE_LABEL_HEIGHT,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8
      }}
    >
      {/* Icon body — el bloque que se arrastra */}
      <div
        key={pulseKey}
        className="v2-tick-halo delivrix-node-body"
        style={{
          position: "relative",
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          borderRadius: 16,
          background: hasPrompt ? "var(--color-warning-soft)" : "var(--color-always-dark-surface)",
          border: `${borderWidth}px solid ${borderColor}`,
          boxShadow: hasPrompt
            ? "0 0 0 4px rgba(245,158,11,0.10), 0 8px 20px rgba(0,0,0,0.4)"
            : selected
              ? "0 0 0 4px rgba(255,255,255,0.04), 0 8px 20px rgba(0,0,0,0.4)"
              : "0 4px 12px rgba(0,0,0,0.3)",
          display: "grid",
          placeItems: "center",
          transition: "transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease"
        }}
      >
        {/* Handles visibles siempre — n8n style con port circle */}
        <Handle
          type="target"
          position={Position.Left}
          style={{
            width: 10,
            height: 10,
            background: "#14110d",
            border: `2px solid ${laneColor}`,
            opacity: 0.95
          }}
        />
        <Handle
          type="source"
          position={Position.Right}
          style={{
            width: 10,
            height: 10,
            background: "#14110d",
            border: `2px solid ${laneColor}`,
            opacity: 0.95
          }}
        />

        {/* Lucide icon centrado coloreado por lane */}
        <Icon size={30} strokeWidth={1.6} color={laneColor} />

        {/* Status dot esquina top-right (n8n usa círculo coloreado) */}
        <span
          aria-hidden="true"
          title={visual.label}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 10,
            height: 10,
            borderRadius: 999,
            background: visual.dot,
            border: "2px solid #25201a",
            boxShadow: `0 0 8px ${visual.dot}88`
          }}
        />

        {/* Alert triangle rojo top-left cuando el nodo está bloqueado/error (n8n style) */}
        {hasError ? (
          <span
            aria-hidden="true"
            title={`${visual.label} — requiere atención`}
            style={{
              position: "absolute",
              top: -4,
              left: -4,
              width: 20,
              height: 20,
              borderRadius: 999,
              background: "var(--color-critical)",
              display: "grid",
              placeItems: "center",
              boxShadow: "0 2px 6px rgba(0,0,0,0.4)"
            }}
          >
            <AlertTriangle size={11} strokeWidth={2.5} color="var(--color-text-inverse)" />
          </span>
        ) : null}

        {/* PROMPT badge esquina inferior cuando hay prompt activo */}
        {hasPrompt ? (
          <span
            className="font-[family-name:var(--font-caption)] font-bold"
            style={{
              position: "absolute",
              bottom: -8,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "2px 7px",
              borderRadius: 4,
              background: "var(--color-warning)",
              color: "#1f1a13",
              fontSize: 9,
              letterSpacing: 0.5,
              boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
              whiteSpace: "nowrap"
            }}
          >
            PROMPT
          </span>
        ) : null}
      </div>

      {/* Label texto AFUERA debajo del nodo (estilo n8n) */}
      <div
        style={{
          maxWidth: NODE_WIDTH + 48,
          textAlign: "center",
          lineHeight: 1.2,
          pointerEvents: "none"
        }}
      >
        <div
          className="font-[family-name:var(--font-body)] font-semibold"
          style={{
            fontSize: 12,
            color: selected || hasPrompt ? "#f5eddf" : "#cdc4b3",
            textShadow: "0 1px 2px rgba(0,0,0,0.6)",
            lineHeight: 1.25
          }}
        >
          {node.label.length > 22 ? `${node.label.slice(0, 22)}…` : node.label}
        </div>
        <div
          className="font-[family-name:var(--font-mono)]"
          style={{
            fontSize: 9,
            color: visual.fg,
            opacity: 0.85,
            marginTop: 3,
            textTransform: "lowercase",
            letterSpacing: 0.3
          }}
        >
          {visual.label}
          {node.metrics.length > 0 && node.metrics[0]!.value !== null
            ? ` · ${node.metrics[0]!.value}${node.metrics[0]!.unit ? node.metrics[0]!.unit : ""}`
            : node.progressPercent > 0
              ? ` · ${node.progressPercent}%`
              : ""}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  delivrix: DelivrixCanvasNode,
  laneLabel: LaneLabelNode
};

/* ============================================================
 * Layout nodes: respeta node.x/node.y del contrato (Tarea 8 backend, 42c9b2d)
 * cuando existen; fallback a auto-layout por lane × col index.
 * Backend usa: x = col * 240, y = laneIdx * 160. Lo respetamos 1:1.
 * ============================================================ */
function layoutNodes(
  canvasNodes: CanvasNode[],
  lanes: OpenClawCanvasLane[],
  selectedId: string | null,
  promptNodeId: string | null,
  statusSignatures: Record<string, string>
): DelivrixNodeType[] {
  // Group by lane preserving the order they arrive in `nodes` (backend order = chronological)
  const byLane: Record<OpenClawCanvasLane, CanvasNode[]> = {} as any;
  for (const lane of lanes) byLane[lane] = [];
  for (const n of canvasNodes) {
    if (byLane[n.lane]) byLane[n.lane]!.push(n);
  }

  const result: DelivrixNodeType[] = [];
  lanes.forEach((lane, laneIdx) => {
    const nodes = byLane[lane] ?? [];
    nodes.forEach((node, colIdx) => {
      // Backend devuelve x/y estables (Tarea 8). Si no, fallback frontend.
      const backendX = (node as { x?: number }).x;
      const backendY = (node as { y?: number }).y;
      // Backend devuelve x=col*240, y=lane*160. Reescalamos a nuestro grid
      // (col*168, lane*180) para que respire estilo n8n. Si no hay backend coords,
      // usamos fallback frontend.
      const x =
        typeof backendX === "number"
          ? ROW_OFFSET_X + (backendX / 240) * (NODE_WIDTH + COL_GAP)
          : ROW_OFFSET_X + colIdx * (NODE_WIDTH + COL_GAP);
      const y =
        typeof backendY === "number"
          ? 32 + (backendY / 160) * (NODE_HEIGHT + NODE_LABEL_HEIGHT + ROW_GAP)
          : 32 + laneIdx * (NODE_HEIGHT + NODE_LABEL_HEIGHT + ROW_GAP);
      result.push({
        id: node.id,
        type: "delivrix",
        position: { x, y },
        // pulseKey reflects last seen status — when changes it remounts node and triggers halo
        data: {
          node,
          laneColor: LANE_COLOR[lane],
          selected: node.id === selectedId,
          hasPrompt: node.id === promptNodeId,
          pulseKey: hashString(statusSignatures[node.id] ?? node.status)
        }
      });
    });
  });
  return result;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* ============================================================
 * layoutEdges — mapea canvas.edges del contrato a edges ReactFlow
 * ============================================================ */
function layoutEdges(canvasEdges: CanvasEdge[]): Edge[] {
  return canvasEdges.map((e) => {
    const isBlocked = e.status === "blocked" || e.status === "error";
    const isReady = e.status === "ready";
    const isProgress = e.status === "in_progress" || e.status === "collecting";
    const color = isBlocked
      ? "#f87171"
      : isReady
        ? "#4ade80"
        : isProgress
          ? "#fbbf24"
          : "rgba(255,255,255,0.22)";
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      animated: isProgress || isBlocked,
      type: "smoothstep",
      style: {
        stroke: color,
        strokeWidth: isBlocked ? 2.5 : 2,
        // n8n usa dashed para edges no-ejecutados, sólida para ready
        strokeDasharray: isReady ? undefined : "6,4"
      }
      // n8n-style: SIN flechas, SIN labels. La conexión es lo que importa visualmente.
    };
  });
}

/* ============================================================
 * LaneBackgroundNodes — nodos no-interactivos que sirven como "bandas" para cada lane.
 * Viven DENTRO del viewport ReactFlow (no overlay DOM) así que se mueven con pan/zoom
 * y siempre quedan alineados con los nodos reales.
 * ============================================================ */
function laneBackgroundNodes(
  lanes: OpenClawCanvasLane[],
  _totalWidth: number
): Node[] {
  return lanes.map((lane, idx) => ({
    id: `__lane_${lane}`,
    type: "laneLabel",
    position: { x: 8, y: 32 + idx * (NODE_HEIGHT + NODE_LABEL_HEIGHT + ROW_GAP) },
    data: { lane },
    draggable: false,
    selectable: false,
    focusable: false,
    width: 120,
    height: NODE_HEIGHT + NODE_LABEL_HEIGHT,
    style: { zIndex: -1, pointerEvents: "none" }
  }));
}

function LaneLabelNode({ data }: NodeProps<Node<{ lane: OpenClawCanvasLane }, "laneLabel">>) {
  const lane = data.lane;
  return (
    <div
      style={{
        height: NODE_HEIGHT + NODE_LABEL_HEIGHT,
        display: "flex",
        alignItems: "center",
        gap: 8,
        pointerEvents: "none"
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: 999, background: LANE_COLOR[lane], flexShrink: 0, boxShadow: `0 0 8px ${LANE_COLOR[lane]}` }}
      />
      <span
        className="font-[family-name:var(--font-caption)] font-bold uppercase"
        style={{
          color: LANE_COLOR[lane],
          fontSize: 9,
          letterSpacing: "1.5px",
          textShadow: "0 1px 2px rgba(0,0,0,0.5)"
        }}
      >
        {LANE_LABEL[lane]}
      </span>
    </div>
  );
}

/* ============================================================
 * CanvasFlow — componente principal
 * ============================================================ */
export function CanvasFlow({ canvas, selectedId, onSelectNode }: CanvasFlowProps) {
  const promptNodeId = canvas.prompt?.nodeId ?? null;
  // Trackeamos status anterior por nodo para que el pulseKey cambie sólo cuando cambia status
  const previousStatusesRef = useRef<Record<string, string>>({});
  const [statusSignatures, setStatusSignatures] = useState<Record<string, string>>({});

  useEffect(() => {
    const next: Record<string, string> = {};
    let changed = false;
    for (const n of canvas.nodes) {
      next[n.id] = n.status;
      if (previousStatusesRef.current[n.id] !== n.status) changed = true;
    }
    if (changed || Object.keys(next).length !== Object.keys(previousStatusesRef.current).length) {
      previousStatusesRef.current = next;
      setStatusSignatures({ ...next, __t: String(Date.now()) });
    }
  }, [canvas.nodes]);

  const dataNodes = useMemo(
    () => layoutNodes(canvas.nodes, LANE_ORDER, selectedId, promptNodeId, statusSignatures),
    [canvas.nodes, selectedId, promptNodeId, statusSignatures]
  );
  const edges = useMemo(() => layoutEdges(canvas.edges ?? []), [canvas.edges]);

  // Total canvas size — computed from biggest column count
  const maxColPerLane = Math.max(
    1,
    ...LANE_ORDER.map((l) => canvas.nodes.filter((n) => n.lane === l).length)
  );
  const minWidth = ROW_OFFSET_X + maxColPerLane * (NODE_WIDTH + COL_GAP) + 80;
  const minHeight = LANE_ORDER.length * (NODE_HEIGHT + NODE_LABEL_HEIGHT + ROW_GAP) + 80;
  void minWidth; // referenced for sizing calculations
  void minHeight;

  // Mezclamos lane backgrounds (z-index -1) + data nodes
  const allNodes = useMemo(
    () => [...laneBackgroundNodes(LANE_ORDER, minWidth), ...dataNodes],
    [minWidth, dataNodes]
  );

  return (
    <div
      className="delivrix-flow-canvas"
      style={{
        width: "100%",
        height: "100%",
        minHeight: 560,
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.06)",
        // n8n usa fondo casi negro con tinte gris azulado. Reemplazamos warm brown
        // por un dark más neutro tipo editor.
        background: "#171717",
        overflow: "hidden",
        position: "relative"
      }}
    >
      <ReactFlow
        nodes={allNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("__lane_")) return;
          onSelectNode(node.id);
        }}
        fitView
        fitViewOptions={{ padding: 0.22, minZoom: 0.5, maxZoom: 1.1 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        // panOnDrag con botón middle (1) y right (2) — left (0) queda libre
        // para que drag sobre nodo arrastre el nodo, drag sobre empty space
        // active el panOnScroll en su lugar. Esto es el comportamiento n8n.
        panOnDrag={[1, 2]}
        panOnScroll
        selectionOnDrag={false}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.3}
        maxZoom={2}
        defaultEdgeOptions={{ type: "smoothstep" }}
        colorMode="dark"
        nodeDragThreshold={2}
      >
        {/* Dots prominentes estilo n8n: gap 20, size 1.5, alpha mayor */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.5}
          color="rgba(255,255,255,0.18)"
        />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            if (typeof n.id === "string" && n.id.startsWith("__lane_")) {
              return "transparent";
            }
            const data = n.data as Partial<DelivrixNodeData> | undefined;
            if (!data?.node) return "rgba(255,255,255,0.1)";
            return statusToVisual(data.node.status).dot;
          }}
          nodeStrokeColor={() => "rgba(255,255,255,0.15)"}
          nodeBorderRadius={4}
          maskColor="rgba(10, 10, 10, 0.75)"
          style={{
            background: "rgba(30, 30, 30, 0.9)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            backdropFilter: "blur(8px)"
          }}
        />
        <Controls
          showInteractive={false}
          style={{
            background: "rgba(30, 30, 30, 0.9)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            backdropFilter: "blur(8px)",
            color: "#f5eddf"
          }}
        />
      </ReactFlow>
    </div>
  );
}
