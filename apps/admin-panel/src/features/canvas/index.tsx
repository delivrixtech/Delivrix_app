/**
 * Canvas OpenClaw — port literal del Pencil frame `m4v5T` / `gvu8o` / `FWp8B`.
 *
 * Estructura literal:
 *   Body horizontal split:
 *     Canvas wrap (flex):
 *       Hero (padding 20/28/16/28)
 *       Toolbar (padding 10/28, fill #F7F2EA, borders arriba/abajo):
 *         csel | trange (1h/24h/7d) | zoom (-/100%/+) | fit | (spacer) | legend
 *       Canvas inner (padding 20/28):
 *         Swimlanes (5 carriles verticales con colores literales)
 *       Prompt strip (padding 12/28): gradient border 2px + 2 botones
 *       Footer (padding 10/28/14/28, fill #F7F2EA): 4 quick facts
 *     Detail panel 360w right (fill #F7F2EA, border-left):
 *       dpHead (white) + dpBody con 5 secciones verticales
 *
 * En vivo: useQuery con refetchInterval 5_000 sobre /v1/openclaw/live-canvas
 * para que el operador vea la propuesta de OpenClaw y los cambios de estado
 * con latencia <= 5s sin abrir WebSocket.
 *
 * GET-only: el prompt strip muestra propuestas y los botones abren modales con
 * instrucciones del runbook, nunca POSTean al backend.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Box,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Hash,
  Maximize,
  Maximize2,
  Minus,
  Plus,
  Sparkles,
  User,
  WandSparkles,
  X
} from "lucide-react";
import {
  getJson,
  READ_ENDPOINTS,
  type DashboardData,
  type OpenClawCanvasLane,
  type OpenClawCanvasPayload,
  type OpenClawCanvasTimeRangeId
} from "../../shared/api/client.ts";
import { formatDateTime } from "../../shared/lib/formatters.ts";

type CanvasData = OpenClawCanvasPayload["canvas"];
type CanvasNode = CanvasData["nodes"][number];

/** Paleta literal Pencil de cada lane (NO inventar fuera de este map). */
const LANE_COLOR: Record<OpenClawCanvasLane, string> = {
  onboarding: "#15803D",
  hardware: "#1D4ED8",
  provisioning: "#EA580C",
  warming: "#B45309",
  reputation: "#57534E"
};

const LANE_LABEL: Record<OpenClawCanvasLane, string> = {
  onboarding: "ONBOARDING",
  hardware: "HARDWARE",
  provisioning: "PROVISIONING",
  warming: "CALENTAMIENTO",
  reputation: "REPUTACIÓN"
};

const LANE_LEGEND_LABEL: Record<OpenClawCanvasLane, string> = {
  onboarding: "Onboarding",
  hardware: "Hardware",
  provisioning: "Provisioning",
  warming: "Calentamiento",
  reputation: "Reputación"
};

export function CanvasSection({ data }: { data: DashboardData }) {
  // H.23 — Polling vivo cada 5s contra el contrato dedicado. `initialData`
  // viene del dashboard general para que el primer render sea instantáneo
  // y luego se refresque por su cuenta.
  const liveCanvas = useQuery({
    queryKey: ["canvas-live"],
    queryFn: () => getJson<OpenClawCanvasPayload>(READ_ENDPOINTS.openClawLiveCanvas),
    refetchInterval: 5_000,
    staleTime: 4_000,
    initialData: { canvas: data.canvas } as OpenClawCanvasPayload
  });

  const canvas = liveCanvas.data?.canvas ?? data.canvas;

  // Estado UI local: nodo seleccionado, time range, zoom, runbook modal.
  const [selectedId, setSelectedId] = useState<string | null>(
    canvas.selectedNodeId ?? canvas.currentStepId
  );
  const [timeRange, setTimeRange] = useState<OpenClawCanvasTimeRangeId>(
    canvas.timeRange.active
  );
  const [zoom, setZoom] = useState<number>(canvas.scale.zoomPercent);
  const [runbookOpen, setRunbookOpen] = useState<boolean>(false);

  // Cuando el contrato propone un nodo nuevo a inspeccionar, sincronizar la
  // selección si el operador todavía estaba en el currentStepId default.
  useEffect(() => {
    if (canvas.selectedNodeId && canvas.selectedNodeId !== selectedId) {
      setSelectedId(canvas.selectedNodeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas.selectedNodeId]);

  const selectedNode = useMemo(
    () => canvas.nodes.find((n) => n.id === selectedId) ?? null,
    [canvas.nodes, selectedId]
  );

  return (
    <section className="grid gap-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] items-stretch">
      <CanvasWrap
        canvas={canvas}
        timeRange={timeRange}
        zoom={zoom}
        onTimeRangeChange={setTimeRange}
        onZoomChange={setZoom}
        onSelectNode={setSelectedId}
        selectedId={selectedId}
        onPrimaryPromptAction={() => setRunbookOpen(true)}
      />
      <DetailPanel selected={selectedNode} canvas={canvas} />
      {runbookOpen && canvas.prompt ? (
        <RunbookModal prompt={canvas.prompt} onClose={() => setRunbookOpen(false)} />
      ) : null}
    </section>
  );
}

/* ============================================================
 * Canvas wrap: Hero + Toolbar + Swimlanes + Prompt strip + Footer
 * ============================================================ */
function CanvasWrap({
  canvas,
  timeRange,
  zoom,
  onTimeRangeChange,
  onZoomChange,
  onSelectNode,
  selectedId,
  onPrimaryPromptAction
}: {
  canvas: CanvasData;
  timeRange: OpenClawCanvasTimeRangeId;
  zoom: number;
  onTimeRangeChange: (id: OpenClawCanvasTimeRangeId) => void;
  onZoomChange: (z: number) => void;
  onSelectNode: (id: string) => void;
  selectedId: string | null;
  onPrimaryPromptAction: () => void;
}) {
  return (
    <div className="flex flex-col bg-[#FFFBF5] min-w-0">
      <Hero canvas={canvas} />
      <Toolbar
        cluster={canvas.cluster}
        timeRange={timeRange}
        timeRangeOptions={canvas.timeRange.options}
        zoom={zoom}
        onTimeRangeChange={onTimeRangeChange}
        onZoomChange={onZoomChange}
        lanes={canvas.lanes}
      />
      <div className="flex flex-col" style={{ padding: "20px 28px 0 28px" }}>
        <Swimlanes
          lanes={canvas.lanes}
          nodes={canvas.nodes}
          selectedId={selectedId}
          promptNodeId={canvas.prompt?.nodeId ?? null}
          zoomPercent={zoom}
          onSelect={onSelectNode}
        />
      </div>
      <PromptStrip prompt={canvas.prompt} onPrimary={onPrimaryPromptAction} />
      <Footer canvas={canvas} />
    </div>
  );
}

/* ============================================================
 * Hero (frame VqpXu) — eyebrow + titular + lead
 * ============================================================ */
function Hero({ canvas }: { canvas: CanvasData }) {
  const blocked = canvas.blockedBy.length;
  const approvals = canvas.requiresHumanApproval.length;
  return (
    <header
      className="flex flex-col bg-[#FFFBF5]"
      style={{ gap: 6, padding: "20px 28px 16px 28px" }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          CANVAS OPERATIVO
        </span>
        <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "#8A8073" }} />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          contrato · /v1/openclaw/live-canvas
        </span>
      </div>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Flujo supervisado de OpenClaw.
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Pipeline GET-only desde el servidor físico hasta la reputación. {blocked} bloqueo
        {blocked === 1 ? "" : "s"} activo{blocked === 1 ? "" : "s"} · {approvals} aprobación
        {approvals === 1 ? "" : "es"} humana{approvals === 1 ? "" : "s"} requerida{approvals === 1 ? "" : "s"}.
      </p>
    </header>
  );
}

/* ============================================================
 * Toolbar (frame pSrQo) — cluster selector + time range + zoom + fit + legend
 * ============================================================ */
function Toolbar({
  cluster,
  timeRange,
  timeRangeOptions,
  zoom,
  onTimeRangeChange,
  onZoomChange,
  lanes
}: {
  cluster: CanvasData["cluster"];
  timeRange: OpenClawCanvasTimeRangeId;
  timeRangeOptions: OpenClawCanvasTimeRangeId[];
  zoom: number;
  onTimeRangeChange: (id: OpenClawCanvasTimeRangeId) => void;
  onZoomChange: (z: number) => void;
  lanes: OpenClawCanvasLane[];
}) {
  const activeOption = cluster.options.find((o) => o.id === cluster.activeId);
  return (
    <div
      className="flex items-center bg-[#F7F2EA]"
      style={{
        gap: 10,
        padding: "10px 28px",
        borderTop: "1px solid #EAE0CE",
        borderBottom: "1px solid #EAE0CE"
      }}
    >
      {/* csel — cluster selector (caja blanca con icon box) */}
      <button
        type="button"
        className="inline-flex items-center bg-[#FFFFFF]"
        style={{
          gap: 8,
          padding: "7px 12px",
          borderRadius: 6,
          border: "1px solid #EAE0CE"
        }}
      >
        <Box size={13} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
          Clúster:
        </span>
        <span className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[#1A1410]">
          {activeOption?.label ?? cluster.activeId}
        </span>
        <ChevronDown size={13} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
      </button>

      {/* trange — time range 1h/24h/7d */}
      <div
        className="inline-flex bg-[#FFFFFF]"
        style={{ padding: 2, borderRadius: 6, border: "1px solid #EAE0CE" }}
      >
        {timeRangeOptions.map((opt) => {
          const active = opt === timeRange;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onTimeRangeChange(opt)}
              className="inline-flex items-center"
              style={{
                padding: "5px 10px",
                borderRadius: 4,
                background: active ? "#1A1410" : "transparent"
              }}
            >
              <span
                className="text-[11px] font-[family-name:var(--font-mono)]"
                style={{
                  color: active ? "#FFFBF5" : "#5C544A",
                  fontWeight: active ? 600 : "normal"
                }}
              >
                {opt}
              </span>
            </button>
          );
        })}
      </div>

      {/* zoom — minus / 100% / plus */}
      <div
        className="inline-flex items-stretch bg-[#FFFFFF]"
        style={{ padding: 2, borderRadius: 6, border: "1px solid #EAE0CE" }}
      >
        <button
          type="button"
          onClick={() => onZoomChange(Math.max(25, zoom - 25))}
          className="grid place-items-center"
          style={{ width: 28, height: 24, borderRadius: 4 }}
          aria-label="Reducir zoom"
        >
          <Minus size={13} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
        </button>
        <span
          className="grid place-items-center text-[11px] font-[family-name:var(--font-mono)] font-semibold text-[#1A1410]"
          style={{ width: 46, height: 24 }}
        >
          {zoom}%
        </span>
        <button
          type="button"
          onClick={() => onZoomChange(Math.min(200, zoom + 25))}
          className="grid place-items-center"
          style={{ width: 28, height: 24, borderRadius: 4 }}
          aria-label="Aumentar zoom"
        >
          <Plus size={13} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
        </button>
      </div>

      {/* fit — Ajustar */}
      <button
        type="button"
        onClick={() => onZoomChange(100)}
        className="inline-flex items-center bg-[#FFFFFF]"
        style={{ gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid #EAE0CE" }}
      >
        <Maximize size={12} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-sans)] font-medium text-[#5C544A]">
          Ajustar
        </span>
      </button>

      <span className="flex-1" aria-hidden="true" />

      {/* legend — Etapas */}
      <div className="inline-flex items-center" style={{ gap: 10 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold text-[#8A8073]"
          style={{ letterSpacing: "0.6px" }}
        >
          Etapas
        </span>
        {lanes.map((lane) => (
          <span key={lane} className="inline-flex items-center" style={{ gap: 5 }}>
            <span
              aria-hidden="true"
              style={{ width: 8, height: 8, borderRadius: 4, background: LANE_COLOR[lane] }}
            />
            <span className="text-[10px] font-[family-name:var(--font-caption)] text-[#5C544A]">
              {LANE_LEGEND_LABEL[lane]}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
 * Swimlanes (frame md4va) — 5 carriles horizontales
 * ============================================================ */
function Swimlanes({
  lanes,
  nodes,
  selectedId,
  promptNodeId,
  zoomPercent,
  onSelect
}: {
  lanes: OpenClawCanvasLane[];
  nodes: CanvasNode[];
  selectedId: string | null;
  promptNodeId: string | null;
  zoomPercent: number;
  onSelect: (id: string) => void;
}) {
  const scale = zoomPercent / 100;
  return (
    <div
      className="overflow-hidden bg-[#F7F2EA]"
      style={{
        borderRadius: 10,
        border: "1px solid #EAE0CE"
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          width: scale !== 1 ? `${100 / scale}%` : "100%"
        }}
      >
        {lanes.map((lane, idx) => {
          const laneNodes = nodes.filter((n) => n.lane === lane);
          if (laneNodes.length === 0) return null;
          return (
            <SwimlaneRow
              key={lane}
              lane={lane}
              nodes={laneNodes}
              selectedId={selectedId}
              promptNodeId={promptNodeId}
              onSelect={onSelect}
              isLast={idx === lanes.length - 1}
            />
          );
        })}
      </div>
    </div>
  );
}

function SwimlaneRow({
  lane,
  nodes,
  selectedId,
  promptNodeId,
  onSelect,
  isLast
}: {
  lane: OpenClawCanvasLane;
  nodes: CanvasNode[];
  selectedId: string | null;
  promptNodeId: string | null;
  onSelect: (id: string) => void;
  isLast: boolean;
}) {
  const color = LANE_COLOR[lane];
  return (
    <div
      className="flex items-stretch"
      style={{
        borderBottom: isLast ? "none" : "1px solid #EAE0CE"
      }}
    >
      {/* Lane label sidebar 120w */}
      <div
        className="flex items-center shrink-0"
        style={{
          gap: 6,
          padding: "16px 12px 16px 16px",
          width: 120
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 3, background: color }}
        />
        <span
          className="text-[9px] font-[family-name:var(--font-caption)] font-bold"
          style={{ color, letterSpacing: "0.8px" }}
        >
          {LANE_LABEL[lane]}
        </span>
      </div>
      {/* Lane row con nodos horizontales separados por chevrons */}
      <div
        className="flex items-center flex-1 overflow-x-auto"
        style={{ gap: 14, padding: "14px 16px 14px 8px" }}
      >
        {nodes.map((node, i) => (
          <div key={node.id} className="flex items-center" style={{ gap: 14 }}>
            <NodeCard
              node={node}
              selected={node.id === selectedId}
              hasPrompt={node.id === promptNodeId}
              laneColor={color}
              onSelect={() => onSelect(node.id)}
            />
            {i < nodes.length - 1 ? (
              <ChevronRight
                size={14}
                strokeWidth={1.75}
                className="text-[#8A8073] shrink-0"
                aria-hidden="true"
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeCard({
  node,
  selected,
  hasPrompt,
  laneColor,
  onSelect
}: {
  node: CanvasNode;
  selected: boolean;
  hasPrompt: boolean;
  laneColor: string;
  onSelect: () => void;
}) {
  if (hasPrompt) {
    // Estilo especial: gradient border 2px + shadow grande (frame T1iIlE).
    return (
      <button
        type="button"
        onClick={onSelect}
        className="text-left shrink-0"
        style={{
          padding: 2,
          width: 184,
          borderRadius: 10,
          background: "linear-gradient(135deg, #FACC15 0%, #EA580C 100%)",
          boxShadow: "0 6px 14px rgba(146, 64, 14, 0.2)"
        }}
      >
        <div
          className="flex flex-col bg-[#FFFFFF]"
          style={{ gap: 6, padding: 12, borderRadius: 8 }}
        >
          <NodeCardBody node={node} />
        </div>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col shrink-0 text-left"
      style={{
        gap: 6,
        padding: 12,
        width: 172,
        borderRadius: 8,
        background: selected
          ? "linear-gradient(135deg, rgba(250, 204, 21, 0.14) 0%, rgba(234, 88, 12, 0.14) 100%), #FFFFFF"
          : "#FFFFFF",
        border: selected ? `1px solid ${laneColor}` : "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <NodeCardBody node={node} />
    </button>
  );
}

function NodeCardBody({ node }: { node: CanvasNode }) {
  const statusVisual = statusToVisual(node.status);
  return (
    <>
      <div className="flex items-center" style={{ gap: 6 }}>
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 999, background: statusVisual.dot }}
        />
        <span
          className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{ color: statusVisual.fg, letterSpacing: "0.4px" }}
        >
          {statusVisual.label}
        </span>
      </div>
      <span className="text-[12.5px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410] leading-tight">
        {node.label}
      </span>
      {node.metrics.length > 0 && node.metrics[0]!.value !== null ? (
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          {node.metrics[0]!.label}: {node.metrics[0]!.value}
          {node.metrics[0]!.unit ? ` ${node.metrics[0]!.unit}` : ""}
        </span>
      ) : (
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          progreso {node.progressPercent}%
        </span>
      )}
    </>
  );
}

function statusToVisual(status: string): { dot: string; fg: string; label: string } {
  if (status === "ready") return { dot: "#15803D", fg: "#15803D", label: "listo" };
  if (status === "needs_review") return { dot: "#B45309", fg: "#B45309", label: "revisar" };
  if (status === "requires_approval") return { dot: "#7C3AED", fg: "#7C3AED", label: "aprobación" };
  if (status === "blocked") return { dot: "#B91C1C", fg: "#B91C1C", label: "bloqueado" };
  if (status === "collecting") return { dot: "#1D4ED8", fg: "#1D4ED8", label: "midiendo" };
  if (status === "disabled_by_mvp") return { dot: "#8A8073", fg: "#8A8073", label: "apagado" };
  if (status === "error") return { dot: "#B91C1C", fg: "#B91C1C", label: "error" };
  if (status === "not_started") return { dot: "#8A8073", fg: "#8A8073", label: "pendiente" };
  return { dot: "#8A8073", fg: "#8A8073", label: "desconocido" };
}

/* ============================================================
 * Prompt strip (frame AcDzC) — gradient border + 2 botones
 * ============================================================ */
function PromptStrip({
  prompt,
  onPrimary
}: {
  prompt: CanvasData["prompt"];
  onPrimary: () => void;
}) {
  if (!prompt) {
    return (
      <div className="flex flex-col" style={{ padding: "12px 28px" }}>
        <div
          className="flex items-center bg-[#FFFFFF]"
          style={{
            gap: 10,
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid #EAE0CE"
          }}
        >
          <Sparkles size={14} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
          <span className="text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
            OpenClaw sin propuestas pendientes. Bitácora limpia.
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col" style={{ padding: "12px 28px" }}>
      <div
        style={{
          padding: 2,
          borderRadius: 10,
          background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
          boxShadow: "0 6px 18px rgba(146, 64, 14, 0.13)"
        }}
      >
        <div
          className="flex items-start bg-[#FFFFFF]"
          style={{ gap: 14, padding: "12px 14px", borderRadius: 8 }}
        >
          <span
            aria-hidden="true"
            className="grid place-items-center shrink-0"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "linear-gradient(135deg, #FACC15 0%, #EA580C 100%)",
              color: "#FFFBF5"
            }}
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
            <span className="text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
              {prompt.headline}
            </span>
            <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.4] text-[#1A1410]">
              {prompt.body}
            </p>
          </div>
          <div className="flex items-center shrink-0" style={{ gap: 8 }}>
            <button
              type="button"
              className="inline-flex items-center bg-transparent"
              style={{
                gap: 6,
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px solid #D4C5A8"
              }}
            >
              <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
                {prompt.secondaryAction.label}
              </span>
            </button>
            <button
              type="button"
              onClick={onPrimary}
              className="inline-flex items-center bg-[#1A1410]"
              style={{
                gap: 6,
                padding: "8px 14px",
                borderRadius: 6
              }}
            >
              <WandSparkles size={12} strokeWidth={1.75} className="text-[#FFFBF5]" aria-hidden="true" />
              <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]">
                {prompt.primaryAction.label}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * Footer (frame wMDd5) — 4 quick facts
 * ============================================================ */
function Footer({ canvas }: { canvas: CanvasData }) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(canvas.lastActivity.occurredAt).getTime()) / 1000));
  return (
    <div
      className="flex items-center bg-[#F7F2EA]"
      style={{
        gap: 14,
        padding: "10px 28px 14px 28px",
        borderTop: "1px solid #EAE0CE"
      }}
    >
      <div className="inline-flex items-center" style={{ gap: 6 }}>
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 3, background: "#15803D" }}
        />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A]">
          Actualizado hace {ageSeconds}s
        </span>
      </div>
      <div className="inline-flex items-center" style={{ gap: 6 }}>
        <Maximize2 size={11} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          escala {canvas.scale.zoomPercent}%
        </span>
      </div>
      <div className="inline-flex items-center" style={{ gap: 6 }}>
        <User size={11} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          última: {canvas.lastActivity.actor}
        </span>
      </div>
      <span className="flex-1" aria-hidden="true" />
      <div className="inline-flex items-center" style={{ gap: 6 }}>
        <Hash size={11} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          audit · {canvas.lastActivity.auditHash}
        </span>
      </div>
    </div>
  );
}

/* ============================================================
 * Detail panel (frame dt6l7) — 360w right, 5 secciones
 * ============================================================ */
function DetailPanel({
  selected,
  canvas
}: {
  selected: CanvasNode | null;
  canvas: CanvasData;
}) {
  const node = selected ?? canvas.nodes[0]!;
  const visual = statusToVisual(node.status);
  return (
    <aside
      className="flex flex-col bg-[#F7F2EA] min-w-0"
      style={{
        borderLeft: "1px solid #EAE0CE",
        width: "100%"
      }}
    >
      {/* dpHead */}
      <header
        className="flex flex-col bg-[#FFFFFF]"
        style={{ gap: 6, padding: "20px 20px 16px 20px", borderBottom: "1px solid #EAE0CE" }}
      >
        <div className="inline-flex items-center" style={{ gap: 8 }}>
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: 3, background: LANE_COLOR[node.lane] }}
          />
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold"
            style={{ color: LANE_COLOR[node.lane], letterSpacing: "0.8px" }}
          >
            {LANE_LABEL[node.lane]}
          </span>
        </div>
        <h2
          className="m-0 text-[18px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]"
          style={{ letterSpacing: "-0.2px" }}
        >
          Revisión OpenClaw
        </h2>
        <div className="inline-flex items-center" style={{ gap: 8 }}>
          <span className="text-[12px] font-[family-name:var(--font-mono)] text-[#5C544A]">
            {node.label}
          </span>
        </div>
        <span
          className="inline-block w-fit text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{
            padding: "3px 8px",
            borderRadius: 4,
            background: pillBg(node.status),
            color: visual.fg,
            letterSpacing: "0.4px"
          }}
        >
          {visual.label}
        </span>
      </header>

      {/* dpBody — 5 secciones */}
      <div className="flex flex-col overflow-y-auto">
        <DetailSection title="Resumen">
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#5C544A]">
            {node.summary}
          </p>
          <div className="flex flex-wrap" style={{ gap: 6 }}>
            {node.badges.map((b) => (
              <span
                key={b}
                className="inline-block text-[10px] font-[family-name:var(--font-mono)]"
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "#F7F2EA",
                  border: "1px solid #EAE0CE",
                  color: "#5C544A"
                }}
              >
                {b}
              </span>
            ))}
          </div>
        </DetailSection>

        <DetailSection title="Métricas observadas">
          {node.metrics.length === 0 ? (
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
              Sin métricas para este nodo (contrato vacío).
            </span>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 4 }}>
              {node.metrics.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center"
                  style={{ gap: 8 }}
                >
                  <span className="text-[11px] font-[family-name:var(--font-sans)] text-[#5C544A]">
                    {m.label}
                  </span>
                  <span className="flex-1" aria-hidden="true" />
                  <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold text-[#1A1410]">
                    {m.value === null ? "—" : `${m.value}${m.unit ? ` ${m.unit}` : ""}`}
                  </span>
                  <span
                    className="inline-block text-[9px] font-[family-name:var(--font-caption)] uppercase"
                    style={{
                      padding: "1px 5px",
                      borderRadius: 3,
                      background: "#F7F2EA",
                      color: "#8A8073",
                      letterSpacing: "0.4px"
                    }}
                  >
                    {m.quality}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Bloqueos y dependencias">
          {canvas.blockedBy.length === 0 ? (
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
              Sin bloqueos activos en este momento.
            </span>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
              {canvas.blockedBy.slice(0, 5).map((b) => (
                <li
                  key={b.code}
                  className="flex items-start"
                  style={{ gap: 8 }}
                >
                  <span
                    aria-hidden="true"
                    className="shrink-0"
                    style={{
                      width: 6,
                      height: 6,
                      marginTop: 6,
                      borderRadius: 3,
                      background: b.severity === "critical" ? "#B91C1C" : "#B45309"
                    }}
                  />
                  <div className="flex flex-col" style={{ gap: 2 }}>
                    <span className="text-[11px] font-[family-name:var(--font-sans)] text-[#1A1410]">
                      {b.label}
                    </span>
                    <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
                      {b.category} · {b.severity}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Aprobaciones humanas">
          {canvas.requiresHumanApproval.length === 0 ? (
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
              No hay aprobaciones pendientes.
            </span>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 4 }}>
              {canvas.requiresHumanApproval.slice(0, 6).map((a) => (
                <li
                  key={a}
                  className="inline-flex items-center"
                  style={{ gap: 6 }}
                >
                  <FileText size={11} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
                  <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]">
                    {a.replaceAll("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Bitácora reciente" last>
          <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
            {canvas.timeline.slice(0, 4).map((t) => (
              <li key={t.id} className="flex flex-col" style={{ gap: 2 }}>
                <div className="inline-flex items-center" style={{ gap: 6 }}>
                  <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
                    {formatDateTime(t.occurredAt)}
                  </span>
                  <span
                    className="inline-block text-[9px] font-[family-name:var(--font-caption)] uppercase"
                    style={{
                      padding: "1px 6px",
                      borderRadius: 3,
                      background: "#F7F2EA",
                      color: "#5C544A",
                      letterSpacing: "0.4px"
                    }}
                  >
                    {t.actor}
                  </span>
                </div>
                <span className="text-[11px] font-[family-name:var(--font-sans)] text-[#1A1410]">
                  {t.action}
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      </div>
    </aside>
  );
}

function DetailSection({
  title,
  children,
  last
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section
      className="flex flex-col"
      style={{
        gap: 8,
        padding: last ? "16px 20px 20px 20px" : "16px 20px",
        borderBottom: last ? "none" : "1px solid #EAE0CE"
      }}
    >
      <h3
        className="m-0 text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
        style={{ letterSpacing: "0.8px" }}
      >
        {title}
      </h3>
      <div className="flex flex-col" style={{ gap: 8 }}>
        {children}
      </div>
    </section>
  );
}

function pillBg(status: string): string {
  if (status === "ready") return "#DCFCE7";
  if (status === "needs_review") return "#FEF3C7";
  if (status === "requires_approval") return "#EDE9FE";
  if (status === "blocked" || status === "error") return "#FEE2E2";
  if (status === "collecting") return "#DBEAFE";
  return "#F7F2EA";
}

/* ============================================================
 * Runbook modal — abre cuando el operador hace clic en el primary action
 * del prompt. NO ejecuta nada en el backend; solo muestra los pasos del
 * runbook .md y los hashes de evidencia para que el operador apruebe afuera
 * con regla de 2 personas firmada.
 * ============================================================ */
function RunbookModal({
  prompt,
  onClose
}: {
  prompt: NonNullable<CanvasData["prompt"]>;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="runbook-title"
      className="fixed inset-0 grid place-items-center"
      style={{
        background: "rgba(26, 20, 16, 0.45)",
        zIndex: 50,
        padding: 24
      }}
      onClick={onClose}
    >
      <div
        className="flex flex-col bg-[#FFFBF5]"
        style={{
          width: "min(540px, 100%)",
          maxHeight: "min(720px, 90vh)",
          borderRadius: 12,
          border: "1px solid #EAE0CE",
          boxShadow: "0 24px 60px rgba(26, 20, 16, 0.3)"
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-start"
          style={{ gap: 12, padding: "20px 22px 16px 22px", borderBottom: "1px solid #EAE0CE" }}
        >
          <span
            aria-hidden="true"
            className="grid place-items-center shrink-0"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "linear-gradient(135deg, #FACC15 0%, #EA580C 100%)",
              color: "#FFFBF5"
            }}
          >
            <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="flex flex-col flex-1" style={{ gap: 2 }}>
            <span
              className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#EA580C]"
              style={{ letterSpacing: "0.8px" }}
            >
              Aprobar fuera del panel
            </span>
            <h2
              id="runbook-title"
              className="m-0 text-[18px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]"
              style={{ letterSpacing: "-0.2px" }}
            >
              {prompt.headline}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="grid place-items-center"
            style={{ width: 28, height: 28, borderRadius: 6 }}
          >
            <X size={16} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
          </button>
        </header>

        <div
          className="flex flex-col overflow-y-auto"
          style={{ padding: "16px 22px 20px 22px", gap: 16 }}
        >
          <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
            {prompt.body}
          </p>

          <section className="flex flex-col" style={{ gap: 8 }}>
            <h3
              className="m-0 text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
              style={{ letterSpacing: "0.8px" }}
            >
              Pasos siguientes (fuera del panel)
            </h3>
            <ol
              className="m-0 flex flex-col"
              style={{ gap: 6, paddingLeft: 18 }}
            >
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
                Abre el runbook{" "}
                <code
                  className="text-[11px] font-[family-name:var(--font-mono)]"
                  style={{
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "#F7F2EA",
                    border: "1px solid #EAE0CE",
                    color: "#1A1410"
                  }}
                >
                  {prompt.primaryAction.runbookRef ?? "runbook.md"}
                </code>{" "}
                en el repositorio.
              </li>
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
                Verifica la evidencia firmada (hashes abajo).
              </li>
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
                Solicita la firma de la segunda persona autorizada (regla de
                dos personas).
              </li>
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
                Ejecuta el paso en modo dry-run primero. Solo después aplica.
              </li>
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
                Registra el commit con el hash del audit log.
              </li>
            </ol>
          </section>

          <section className="flex flex-col" style={{ gap: 8 }}>
            <h3
              className="m-0 text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
              style={{ letterSpacing: "0.8px" }}
            >
              Evidencia
            </h3>
            {prompt.evidenceRefs.length === 0 ? (
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
                Sin evidencia adicional adjunta.
              </span>
            ) : (
              <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 4 }}>
                {prompt.evidenceRefs.map((e) => (
                  <li
                    key={e}
                    className="inline-flex items-center"
                    style={{ gap: 6 }}
                  >
                    <Hash size={11} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
                    <code
                      className="text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410]"
                      style={{
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "#F7F2EA",
                        border: "1px solid #EAE0CE"
                      }}
                    >
                      {e}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            className="flex flex-col"
            style={{
              gap: 6,
              padding: 12,
              borderRadius: 8,
              background: "#FEF3C7",
              border: "1px solid #FCD34D"
            }}
          >
            <span className="text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#B45309]"
              style={{ letterSpacing: "0.6px" }}
            >
              Importante
            </span>
            <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#78350F]">
              Este botón no ejecuta nada. El panel es GET-only. La acción se
              aprueba y aplica fuera, siguiendo el runbook y la regla de dos
              personas firmada.
            </p>
          </section>
        </div>

        <footer
          className="flex items-center"
          style={{ gap: 8, padding: "14px 22px", borderTop: "1px solid #EAE0CE" }}
        >
          <span className="flex-1" aria-hidden="true" />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center bg-transparent"
            style={{
              gap: 6,
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid #D4C5A8"
            }}
          >
            <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
              Entendido
            </span>
          </button>
          <a
            href={`https://github.com/delivrix/delivrix/blob/main/DOCUMENTACION/${prompt.primaryAction.runbookRef ?? ""}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center bg-[#1A1410]"
            style={{ gap: 6, padding: "8px 14px", borderRadius: 6, textDecoration: "none" }}
          >
            <ExternalLink size={12} strokeWidth={1.75} className="text-[#FFFBF5]" aria-hidden="true" />
            <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]">
              Abrir runbook
            </span>
          </a>
        </footer>
      </div>
    </div>
  );
}
