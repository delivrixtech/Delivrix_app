/**
 * Canvas OpenClaw — port literal del Pencil frame `m4v5T` / `gvu8o` / `FWp8B`.
 *
 * Estructura literal:
 *   Body horizontal split:
 *     Canvas wrap (flex):
 *       Hero (padding 20/28/16/28)
 *       Toolbar (padding 10/28, fill var(--color-surface-sunken), borders arriba/abajo):
 *         csel | trange (1h/24h/7d) | zoom (-/100%/+) | fit | (spacer) | legend
 *       Canvas inner (padding 20/28):
 *         Swimlanes (5 carriles verticales con colores literales)
 *       Prompt strip (padding 12/28): gradient border 2px + 2 botones
 *       Footer (padding 10/28/14/28, fill var(--color-surface-sunken)): 4 quick facts
 *     Detail panel 360w right (fill var(--color-surface-sunken), border-left):
 *       dpHead (white) + dpBody con 5 secciones verticales
 *
 * En vivo: useQuery con refetchInterval 5_000 sobre /v1/openclaw/live-canvas
 * para que el operador vea la propuesta de OpenClaw y los cambios de estado
 * con latencia <= 5s sin abrir WebSocket.
 *
 * D+5 PM: el prompt strip permite aprobaciones locales supervisadas. El bundle
 * sigue sin tocar infraestructura live; solo llama endpoints Gateway auditados.
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
import { LiveIndicator } from "../../shared/ui/v2/index.ts";
import { CanvasFlow } from "./canvas-flow.tsx";

type CanvasData = OpenClawCanvasPayload["canvas"];
type CanvasNode = CanvasData["nodes"][number];

/** Paleta literal Pencil de cada lane (NO inventar fuera de este map). */
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
  const liveUpdatedAt = liveCanvas.dataUpdatedAt || Date.now();

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
        webdockInventory={data.webdockInventory}
        webdockDrift={data.webdockDrift}
        timeRange={timeRange}
        zoom={zoom}
        onTimeRangeChange={setTimeRange}
        onZoomChange={setZoom}
        onSelectNode={setSelectedId}
        selectedId={selectedId}
        onPrimaryPromptAction={() => setRunbookOpen(true)}
        liveUpdatedAt={liveUpdatedAt}
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
  webdockInventory,
  webdockDrift,
  timeRange,
  zoom,
  onTimeRangeChange,
  onZoomChange,
  onSelectNode,
  selectedId,
  onPrimaryPromptAction,
  liveUpdatedAt
}: {
  canvas: CanvasData;
  webdockInventory: DashboardData["webdockInventory"];
  webdockDrift: DashboardData["webdockDrift"];
  timeRange: OpenClawCanvasTimeRangeId;
  zoom: number;
  onTimeRangeChange: (id: OpenClawCanvasTimeRangeId) => void;
  onZoomChange: (z: number) => void;
  onSelectNode: (id: string) => void;
  selectedId: string | null;
  onPrimaryPromptAction: () => void;
  liveUpdatedAt: number;
}) {
  return (
    <div className="flex flex-col bg-[var(--color-bg)] min-w-0">
      <Hero canvas={canvas} webdockInventory={webdockInventory} liveUpdatedAt={liveUpdatedAt} />
      <WebdockLiveBanner inventory={webdockInventory} drift={webdockDrift} />
      <StartHereBanner
        canvas={canvas}
        onOpenRunbook={onPrimaryPromptAction}
        onSelectNode={onSelectNode}
      />
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
        <CanvasFlow
          canvas={canvas}
          selectedId={selectedId}
          onSelectNode={onSelectNode}
        />
      </div>
      {/* PromptStrip sticky bottom — Fix P0 AUDIT_CANVAS_DEEP §4:
          el CTA principal (operador aprueba lo que OpenClaw propone) ya no se
          entierra abajo del swimlanes. backdrop-filter para no tapar el contexto. */}
      <div
        style={{
          position: "sticky",
          bottom: 0,
          zIndex: 10,
          background: "color-mix(in srgb, var(--color-bg) 88%, transparent)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          borderTop: "1px solid var(--color-border)"
        }}
      >
        <PromptStrip prompt={canvas.prompt} onPrimary={onPrimaryPromptAction} />
      </div>
      <Footer canvas={canvas} />
    </div>
  );
}

/* ============================================================
 * StartHereBanner — orienta al operador.
 *
 * H.23 UX fix: la pantalla anterior mostraba 15 nodos sin decirle al
 * operador "haz esto primero". Este banner detecta el primer nodo que
 * requiere intervención humana y deja claro: cuál es, por qué, y dónde
 * está el runbook. Sin esto, el Canvas se siente como un panel técnico
 * abstracto en vez de una guía operativa.
 *
 * Lógica:
 *   - Si el contrato trae un `prompt`, ese es el siguiente paso → CTA
 *     "Revisar plan dry-run" abre el modal de runbook.
 *   - Si no hay prompt pero hay algún nodo `blocked | needs_review |
 *     requires_approval`, ese es el siguiente paso → CTA selecciona el
 *     nodo en el detail panel.
 *   - Si todo está limpio, se oculta (no estorba).
 * ============================================================ */
function StartHereBanner({
  canvas,
  onOpenRunbook,
  onSelectNode
}: {
  canvas: CanvasData;
  onOpenRunbook: () => void;
  onSelectNode: (id: string) => void;
}) {
  const targetNode = canvas.prompt
    ? canvas.nodes.find((n) => n.id === canvas.prompt!.nodeId) ?? null
    : canvas.nodes.find(
        (n) =>
          n.status === "blocked" ||
          n.status === "needs_review" ||
          n.status === "requires_approval"
      ) ?? null;

  if (!targetNode) return null;

  const hasPrompt = canvas.prompt !== null && canvas.prompt.nodeId === targetNode.id;
  const laneColor = LANE_COLOR[targetNode.lane];
  const ctaLabel = hasPrompt
    ? canvas.prompt!.primaryAction.label
    : `Inspeccionar "${targetNode.label}"`;
  const reason = hasPrompt
    ? canvas.prompt!.body
    : targetNode.summary;

  return (
    <div
      className="flex items-center"
      style={{
        gap: 14,
        padding: "14px 28px",
        background: "var(--color-surface)",
        borderTop: "1px solid var(--color-border)",
        borderBottom: "1px solid var(--color-border)",
        borderLeft: `1px solid ${laneColor}`
      }}
    >
      <span
        aria-hidden="true"
        className="grid place-items-center shrink-0"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: "var(--color-accent)",
          color: "var(--color-accent-fg)"
        }}
      >
        <Sparkles size={17} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
        <div className="inline-flex items-center" style={{ gap: 8 }}>
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-accent-tertiary)]"
            style={{ letterSpacing: "1.2px" }}
          >
            Empieza aquí
          </span>
          <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "var(--color-text-tertiary)" }} />
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
            style={{ color: laneColor, letterSpacing: "0.8px" }}
          >
            {LANE_LABEL[targetNode.lane]} · {targetNode.label}
          </span>
        </div>
        <p
          className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.4] text-[var(--color-text-primary)]"
          style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
        >
          {reason}
        </p>
      </div>
      <div className="inline-flex items-center shrink-0" style={{ gap: 8 }}>
        {!hasPrompt ? (
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)] hidden sm:inline">
            sin propuesta automática
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            onSelectNode(targetNode.id);
            if (hasPrompt) onOpenRunbook();
          }}
          className="inline-flex items-center bg-[var(--color-text-primary)]"
          style={{ gap: 6, padding: "9px 14px", borderRadius: 6 }}
        >
          <WandSparkles size={13} strokeWidth={1.75} className="text-[var(--color-on-dark-strong)]" aria-hidden="true" />
          <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-on-dark-strong)]">
            {ctaLabel}
          </span>
        </button>
      </div>
    </div>
  );
}

/* ============================================================
 * Hero (frame VqpXu) — eyebrow + titular + lead
 * ============================================================ */
function Hero({
  canvas,
  webdockInventory,
  liveUpdatedAt
}: {
  canvas: CanvasData;
  webdockInventory: DashboardData["webdockInventory"];
  liveUpdatedAt: number;
}) {
  const totalNodes = canvas.nodes.length;
  const readyNodes = canvas.nodes.filter((n) => n.status === "ready").length;
  const blockedNodes = canvas.nodes.filter(
    (n) => n.status === "blocked" || n.status === "needs_review" || n.status === "requires_approval"
  ).length;
  const liveBadge = webdockInventory.source.kind === "live" ? "Webdock vivo" : "Webdock mock";
  return (
    <header
      className="flex bg-[var(--color-bg)]"
      style={{ gap: 16, padding: "20px 28px 16px 28px", alignItems: "flex-start" }}
    >
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 6 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[var(--color-accent-tertiary)]"
            style={{ letterSpacing: "1.2px" }}
          >
            CANVAS OPERATIVO
          </span>
          <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "var(--color-text-tertiary)" }} />
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
            {readyNodes} / {totalNodes} pasos listos · {blockedNodes} esperan tu revisión
          </span>
          <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "var(--color-text-tertiary)" }} />
          <span
            className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
            style={{
              padding: "2px 6px",
              borderRadius: 4,
              background: webdockInventory.source.kind === "live" ? "var(--color-success-soft)" : "var(--color-warning-soft)",
              color: webdockInventory.source.kind === "live" ? "var(--color-success)" : "var(--color-warning)"
            }}
          >
            {liveBadge}
          </span>
        </div>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]"
          style={{ letterSpacing: "-0.4px" }}
        >
          El viaje del servidor a infraestructura de envío.
        </h1>
        <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
          OpenClaw te muestra cada paso del provisioning supervisado: del servidor físico
          en Popayán hasta que las IPs estén calentadas y la reputación firme. Las
          aprobaciones reales pasan por ApprovalGate con 1 firma de operador.
        </p>
      </div>
      <div className="shrink-0">
        <LiveIndicator pollIntervalSec={5} lastUpdateAt={liveUpdatedAt} tone="success" />
      </div>
    </header>
  );
}

/* ============================================================
 * WebdockLiveBanner — Hito 5.11.A.
 *
 * Muestra el estado del collector Webdock + las propuestas de drift que el
 * rules engine de OpenClaw produjo. Cuando todo está alineado, se oculta.
 * ============================================================ */
function WebdockLiveBanner({
  inventory,
  drift
}: {
  inventory: DashboardData["webdockInventory"];
  drift: DashboardData["webdockDrift"];
}) {
  const isLive = inventory.source.kind === "live";
  const proposalCount = drift.proposals.length;
  if (isLive && proposalCount === 0) return null;

  const tone: "info" | "warning" | "critical" = isLive
    ? proposalCount > 0
      ? "warning"
      : "info"
    : "info";
  const palette = {
    info: { bg: "var(--color-info-soft)", fg: "var(--color-info)", border: "var(--color-info)" },
    warning: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)", border: "var(--color-warning)" },
    critical: { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", border: "var(--color-critical)" }
  }[tone];

  const message = !isLive
    ? `Webdock collector en modo mock — configura WEBDOCK_API_KEY para leer servidores reales. ${inventory.summary.total} servidor${inventory.summary.total === 1 ? "" : "es"} de muestra cargado${inventory.summary.total === 1 ? "" : "s"}.`
    : `OpenClaw detectó ${proposalCount} drift${proposalCount === 1 ? "" : "s"} entre Webdock vivo y tus sender_nodes locales. Revisa la propuesta principal abajo.`;

  return (
    <div
      className="flex items-center"
      style={{
        gap: 12,
        padding: "10px 28px",
        background: palette.bg,
        borderTop: `1px solid ${palette.border}33`,
        borderBottom: `1px solid ${palette.border}33`
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: 999, background: palette.fg }}
      />
      <span
        className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
        style={{ color: palette.fg, letterSpacing: "0.8px" }}
      >
        {isLive ? "Webdock vivo" : "Webdock mock"}
      </span>
      <span aria-hidden="true" style={{ width: 4, height: 4, borderRadius: 2, background: palette.fg, opacity: 0.5 }} />
      <span className="text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-primary)] flex-1">
        {message}
      </span>
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">
        {inventory.summary.running} corriendo · {inventory.summary.stopped} apagados · {inventory.summary.suspended} suspendidos
      </span>
    </div>
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
      className="flex items-center bg-[var(--color-surface-sunken)]"
      style={{
        gap: 10,
        padding: "10px 28px",
        borderTop: "1px solid var(--color-border)",
        borderBottom: "1px solid var(--color-border)"
      }}
    >
      {/* csel — cluster selector (caja blanca con icon box) */}
      <button
        type="button"
        className="inline-flex items-center bg-[var(--color-surface)]"
        style={{
          gap: 8,
          padding: "7px 12px",
          borderRadius: 6,
          border: "1px solid var(--color-border)"
        }}
      >
        <Box size={13} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          Clúster:
        </span>
        <span className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-primary)]">
          {activeOption?.label ?? cluster.activeId}
        </span>
        <ChevronDown size={13} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
      </button>

      {/* trange — time range 1h/24h/7d */}
      <div
        className="inline-flex bg-[var(--color-surface)]"
        style={{ padding: 2, borderRadius: 6, border: "1px solid var(--color-border)" }}
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
                background: active ? "var(--color-text-primary)" : "transparent"
              }}
            >
              <span
                className="text-[11px] font-[family-name:var(--font-mono)]"
                style={{
                  color: active ? "var(--color-bg)" : "var(--color-text-secondary)",
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
        className="inline-flex items-stretch bg-[var(--color-surface)]"
        style={{ padding: 2, borderRadius: 6, border: "1px solid var(--color-border)" }}
      >
        <button
          type="button"
          onClick={() => onZoomChange(Math.max(25, zoom - 25))}
          className="grid place-items-center"
          style={{ width: 28, height: 24, borderRadius: 4 }}
          aria-label="Reducir zoom"
        >
          <Minus size={13} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
        </button>
        <span
          className="grid place-items-center text-[11px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-primary)]"
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
          <Plus size={13} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
        </button>
      </div>

      {/* fit — Ajustar */}
      <button
        type="button"
        onClick={() => onZoomChange(100)}
        className="inline-flex items-center bg-[var(--color-surface)]"
        style={{ gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)" }}
      >
        <Maximize size={12} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-secondary)]">
          Ajustar
        </span>
      </button>

      <span className="flex-1" aria-hidden="true" />

      {/* legend — Etapas */}
      <div className="inline-flex items-center" style={{ gap: 10 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold text-[var(--color-text-tertiary)]"
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
            <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-secondary)]">
              {LANE_LEGEND_LABEL[lane]}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}


function statusToVisual(status: string): { dot: string; fg: string; label: string } {
  if (status === "ready") return { dot: "var(--color-success)", fg: "var(--color-success)", label: "listo" };
  if (status === "needs_review") return { dot: "var(--color-warning)", fg: "var(--color-warning)", label: "revisar" };
  if (status === "requires_approval") return { dot: "var(--color-unknown)", fg: "var(--color-unknown)", label: "aprobación" };
  if (status === "blocked") return { dot: "var(--color-critical)", fg: "var(--color-critical)", label: "bloqueado" };
  if (status === "collecting") return { dot: "var(--color-info)", fg: "var(--color-info)", label: "midiendo" };
  if (status === "disabled_by_mvp") return { dot: "var(--color-text-tertiary)", fg: "var(--color-text-tertiary)", label: "apagado" };
  if (status === "error") return { dot: "var(--color-critical)", fg: "var(--color-critical)", label: "error" };
  if (status === "not_started") return { dot: "var(--color-text-tertiary)", fg: "var(--color-text-tertiary)", label: "pendiente" };
  return { dot: "var(--color-text-tertiary)", fg: "var(--color-text-tertiary)", label: "desconocido" };
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
  const [pending, setPending] = useState<"approve" | "execute" | "revert" | null>(null);
  const [signed] = useState(false);
  const [execution] = useState<{ rollbackToken?: string; rollbackExpiresAt?: string } | null>(null);
  const [destinationOpen, setDestinationOpen] = useState(false);

  if (!prompt) {
    return (
      <div className="flex flex-col" style={{ padding: "12px 28px" }}>
        <div
          className="flex items-center bg-[var(--color-surface)]"
          style={{
            gap: 10,
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid var(--color-border)"
          }}
        >
          <Sparkles size={14} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
          <span className="text-[12px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
            OpenClaw sin propuestas pendientes. Bitácora limpia.
          </span>
        </div>
      </div>
    );
  }
  const operatorId = getCurrentOperatorId();
  const signedByOperator = signed || (prompt.signedByOperatorIds ?? []).includes(operatorId);
  const requiredApprovals = prompt.requiredApprovals ?? 1;
  const currentApprovals = Math.max(prompt.currentApprovals ?? 0, signedByOperator ? 1 : 0);
  const quorumReached = prompt.quorumReached === true || currentApprovals >= requiredApprovals;
  const rollbackToken = execution?.rollbackToken ?? prompt.rollbackToken;
  const rollbackExpiresAt = execution?.rollbackExpiresAt ?? prompt.rollbackExpiresAt;
  const isQuarantinePrompt = prompt.runbookId === "incident-quarantine" || prompt.severity === "critical";
  const quorumMode = prompt.quorumResolution?.mode;
  const quorumModeCopy = quorumMode === "business_hours"
    ? "Modo: business_hours (1 firma)"
    : quorumMode === "off_hours"
      ? "Modo: off_hours (2 firmas)"
      : null;

  async function approveAndMaybeExecute() {
    if (!prompt?.proposalId || signedByOperator) {
      return;
    }

    setPending("approve");
    window.dispatchEvent(new CustomEvent("delivrix:approval-gate-required", {
      detail: {
        proposalId: prompt.proposalId,
        canonicalEndpoint: `/v1/openclaw/proposals/${encodeURIComponent(prompt.proposalId)}/sign`
      }
    }));
    onPrimary();
    setPending(null);
  }

  async function revertExecutedRunbook(targetStatus?: "active" | "retired" | "quarantined") {
    if (!rollbackToken) {
      return;
    }

    setPending("revert");
    window.dispatchEvent(new CustomEvent("delivrix:approval-gate-required", {
      detail: {
        rollbackToken,
        targetStatus,
        reason: "rollback_requires_canonical_approval_gate"
      }
    }));
    setDestinationOpen(false);
    setPending(null);
  }

  return (
    <div className="flex flex-col" style={{ padding: "12px 28px" }}>
      <div
        style={{
          padding: 2,
          borderRadius: 10,
          background: isQuarantinePrompt ? "var(--color-critical)" : "var(--color-accent)",
          boxShadow: "none"
        }}
      >
        <div
          className="flex items-start bg-[var(--color-surface)]"
          style={{ gap: 14, padding: "12px 14px", borderRadius: 8 }}
        >
          <span
            aria-hidden="true"
            className="grid place-items-center shrink-0"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: isQuarantinePrompt ? "var(--color-critical)" : "var(--color-accent)",
              color: isQuarantinePrompt ? "var(--color-text-inverse)" : "var(--color-accent-fg)"
            }}
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
            <span className="text-[13px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
              {prompt.headline}
            </span>
            {isQuarantinePrompt ? (
              <span
                className="inline-flex w-fit text-[10px] font-[family-name:var(--font-mono)] font-semibold"
                style={{
                  padding: "2px 7px",
                  borderRadius: 999,
                  background: "var(--color-critical-soft)",
                  color: "var(--color-critical-border)"
                }}
              >
                Crítico
              </span>
            ) : null}
            <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.4] text-[var(--color-text-primary)]">
              {prompt.body}
            </p>
            {prompt.requiresApproval ? (
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">
                Firmas: {Math.min(currentApprovals, requiredApprovals)}/{requiredApprovals}
                {quorumReached ? " · quorum listo" : ""}
                {quorumModeCopy ? ` · ${quorumModeCopy}` : ""}
              </span>
            ) : null}
            {rollbackToken ? (
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">
                Rollback disponible hasta {rollbackExpiresAt ? formatDateTime(rollbackExpiresAt) : "7d"}
              </span>
            ) : null}
          </div>
          <div className="flex items-center shrink-0" style={{ gap: 8 }}>
            <button
              type="button"
              className="inline-flex items-center bg-transparent"
              style={{
                gap: 6,
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px solid var(--color-border-strong)"
              }}
            >
              <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
                {prompt.secondaryAction.label}
              </span>
            </button>
            {prompt.requiresApproval && prompt.proposalId ? (
              <button
                type="button"
                onClick={() => void approveAndMaybeExecute()}
                disabled={signedByOperator || pending !== null}
                className="inline-flex items-center"
                style={{
                  gap: 6,
                  padding: "8px 14px",
                  borderRadius: 6,
                  background: signedByOperator ? "var(--color-border)" : isQuarantinePrompt ? "var(--color-critical)" : "var(--color-accent)"
                }}
              >
                <span
                  className="text-[11px] font-[family-name:var(--font-sans)] font-semibold"
                  style={{ color: isQuarantinePrompt && !signedByOperator ? "var(--color-surface)" : "var(--color-text-primary)" }}
                >
                  {signedByOperator
                    ? "Ya firmaste"
                    : pending === "approve"
                      ? "Abriendo gate"
                      : isQuarantinePrompt ? "Gate urgente" : "Firmar en gate"}
                </span>
              </button>
            ) : null}
            {rollbackToken && isQuarantinePrompt ? (
              <button
                type="button"
                onClick={() => setDestinationOpen(true)}
                disabled={pending !== null}
                className="inline-flex items-center bg-transparent"
                style={{
                  gap: 6,
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--color-critical)"
                }}
              >
                <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-critical)]">
                  Decidir destino
                </span>
              </button>
            ) : rollbackToken ? (
              <button
                type="button"
                onClick={() => void revertExecutedRunbook()}
                disabled={pending !== null}
                className="inline-flex items-center bg-transparent"
                style={{
                  gap: 6,
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--color-critical)"
                }}
              >
                <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-critical)]">
                  {pending === "revert" ? "Revirtiendo" : "Revertir"}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={onPrimary}
              className="inline-flex items-center bg-[var(--color-text-primary)]"
              style={{
                gap: 6,
                padding: "8px 14px",
                borderRadius: 6
              }}
            >
              <WandSparkles size={12} strokeWidth={1.75} className="text-[var(--color-on-dark-strong)]" aria-hidden="true" />
              <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-on-dark-strong)]">
                {prompt.primaryAction.label}
              </span>
            </button>
          </div>
        </div>
      </div>
      {destinationOpen && rollbackToken ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center"
          style={{ background: "rgba(26, 20, 16, 0.36)" }}
        >
          <div
            className="flex flex-col bg-[var(--color-surface)]"
            style={{
              width: 340,
              gap: 10,
              padding: 16,
              borderRadius: 8,
              border: "1px solid var(--color-border)",
              boxShadow: "var(--shadow-lg)"
            }}
          >
            <span className="text-[13px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
              Destino de cuarentena
            </span>
            <div className="grid grid-cols-1" style={{ gap: 8 }}>
              {[
                ["active", "Reactivar"],
                ["retired", "Retirar"],
                ["quarantined", "Mantener cuarentena"]
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => void revertExecutedRunbook(value as "active" | "retired" | "quarantined")}
                  className="inline-flex items-center justify-between bg-[var(--color-bg)]"
                  style={{
                    padding: "9px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--color-border-strong)"
                  }}
                >
                  <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
                    {label}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setDestinationOpen(false)}
              className="inline-flex items-center justify-center bg-transparent"
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid var(--color-border)"
              }}
            >
              <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-secondary)]">
                Cancelar
              </span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getCurrentOperatorId(): string {
  return "op-juanes-a";
}

/* ============================================================
 * Footer (frame wMDd5) — 4 quick facts
 * ============================================================ */
function Footer({ canvas }: { canvas: CanvasData }) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(canvas.lastActivity.occurredAt).getTime()) / 1000));
  return (
    <div
      className="flex items-center bg-[var(--color-surface-sunken)]"
      style={{
        gap: 14,
        padding: "10px 28px 14px 28px",
        borderTop: "1px solid var(--color-border)"
      }}
    >
      <div className="inline-flex items-center" style={{ gap: 6 }}>
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 3, background: "var(--color-success)" }}
        />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">
          Actualizado hace {ageSeconds}s
        </span>
      </div>
      <div className="inline-flex items-center" style={{ gap: 6 }}>
        <Maximize2 size={11} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          escala {canvas.scale.zoomPercent}%
        </span>
      </div>
      <div className="inline-flex items-center" style={{ gap: 6 }}>
        <User size={11} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          última: {canvas.lastActivity.actor}
        </span>
      </div>
      <span className="flex-1" aria-hidden="true" />
      <div className="inline-flex items-center" style={{ gap: 6 }}>
        <Hash size={11} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
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
      className="flex flex-col bg-[var(--color-surface-sunken)] min-w-0"
      style={{
        borderLeft: "1px solid var(--color-border)",
        width: "100%"
      }}
    >
      {/* dpHead */}
      <header
        className="flex flex-col bg-[var(--color-surface)]"
        style={{ gap: 6, padding: "20px 20px 16px 20px", borderBottom: "1px solid var(--color-border)" }}
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
          className="m-0 text-[18px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]"
          style={{ letterSpacing: "-0.2px" }}
        >
          Revisión OpenClaw
        </h2>
        <div className="inline-flex items-center" style={{ gap: 8 }}>
          <span className="text-[12px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">
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
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[var(--color-text-secondary)]">
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
                  background: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)"
                }}
              >
                {b}
              </span>
            ))}
          </div>
        </DetailSection>

        <DetailSection title="Métricas observadas">
          {node.metrics.length === 0 ? (
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
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
                  <span className="text-[11px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
                    {m.label}
                  </span>
                  <span className="flex-1" aria-hidden="true" />
                  <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-primary)]">
                    {m.value === null ? "—" : `${m.value}${m.unit ? ` ${m.unit}` : ""}`}
                  </span>
                  <span
                    className="inline-block text-[9px] font-[family-name:var(--font-caption)] uppercase"
                    style={{
                      padding: "1px 5px",
                      borderRadius: 3,
                      background: "var(--color-surface-sunken)",
                      color: "var(--color-text-tertiary)",
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
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
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
                      background: b.severity === "critical" ? "var(--color-critical)" : "var(--color-warning)"
                    }}
                  />
                  <div className="flex flex-col" style={{ gap: 2 }}>
                    <span className="text-[11px] font-[family-name:var(--font-sans)] text-[var(--color-text-primary)]">
                      {b.label}
                    </span>
                    <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
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
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
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
                  <FileText size={11} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
                  <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">
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
                  <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
                    {formatDateTime(t.occurredAt)}
                  </span>
                  <span
                    className="inline-block text-[9px] font-[family-name:var(--font-caption)] uppercase"
                    style={{
                      padding: "1px 6px",
                      borderRadius: 3,
                      background: "var(--color-surface-sunken)",
                      color: "var(--color-text-secondary)",
                      letterSpacing: "0.4px"
                    }}
                  >
                    {t.actor}
                  </span>
                </div>
                <span className="text-[11px] font-[family-name:var(--font-sans)] text-[var(--color-text-primary)]">
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
        borderBottom: last ? "none" : "1px solid var(--color-border)"
      }}
    >
      <h3
        className="m-0 text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
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
  if (status === "ready") return "var(--color-success-soft)";
  if (status === "needs_review") return "var(--color-warning-soft)";
  if (status === "requires_approval") return "var(--color-unknown-soft)";
  if (status === "blocked" || status === "error") return "var(--color-critical-soft)";
  if (status === "collecting") return "var(--color-info-soft)";
  return "var(--color-surface-sunken)";
}

/* ============================================================
 * Runbook modal — abre cuando el operador hace clic en el primary action
 * del prompt. NO ejecuta nada en el backend; solo muestra los pasos del
 * runbook .md y los hashes de evidencia para que el operador apruebe con
 * firma explícita.
 * ============================================================ */
function RunbookModal({
  prompt,
  onClose
}: {
  prompt: NonNullable<CanvasData["prompt"]>;
  onClose: () => void;
}) {
  // Escape trap + body scroll lock + restore focus on close.
  // Fix P0 AUDIT_CANVAS_DEEP — modal sin atrapar Escape ni focus.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

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
        className="flex flex-col bg-[var(--color-bg)]"
        style={{
          width: "min(540px, 100%)",
          maxHeight: "min(720px, 90vh)",
          borderRadius: 12,
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-lg)"
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-start"
          style={{ gap: 12, padding: "20px 22px 16px 22px", borderBottom: "1px solid var(--color-border)" }}
        >
          <span
            aria-hidden="true"
            className="grid place-items-center shrink-0"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "var(--color-accent)",
              color: "var(--color-accent-fg)"
            }}
          >
            <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="flex flex-col flex-1" style={{ gap: 2 }}>
            <span
              className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-accent-tertiary)]"
              style={{ letterSpacing: "0.8px" }}
            >
              Aprobar fuera del panel
            </span>
            <h2
              id="runbook-title"
              className="m-0 text-[18px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]"
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
            <X size={16} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
          </button>
        </header>

        <div
          className="flex flex-col overflow-y-auto"
          style={{ padding: "16px 22px 20px 22px", gap: 16 }}
        >
          <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-primary)]">
            {prompt.body}
          </p>

          <section className="flex flex-col" style={{ gap: 8 }}>
            <h3
              className="m-0 text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
              style={{ letterSpacing: "0.8px" }}
            >
              Pasos siguientes (fuera del panel)
            </h3>
            <ol
              className="m-0 flex flex-col"
              style={{ gap: 6, paddingLeft: 18 }}
            >
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-primary)]">
                Abre el runbook{" "}
                <code
                  className="text-[11px] font-[family-name:var(--font-mono)]"
                  style={{
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text-primary)"
                  }}
                >
                  {prompt.primaryAction.runbookRef ?? "runbook.md"}
                </code>{" "}
                en el repositorio.
              </li>
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-primary)]">
                Verifica la evidencia firmada (hashes abajo).
              </li>
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-primary)]">
                Captura la firma del operador autorizado en ApprovalGate.
              </li>
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-primary)]">
                Ejecuta el paso en modo dry-run primero. Solo después aplica.
              </li>
              <li className="text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-primary)]">
                Registra el commit con el hash del audit log.
              </li>
            </ol>
          </section>

          <section className="flex flex-col" style={{ gap: 8 }}>
            <h3
              className="m-0 text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
              style={{ letterSpacing: "0.8px" }}
            >
              Evidencia
            </h3>
            {prompt.evidenceRefs.length === 0 ? (
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
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
                    <Hash size={11} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
                    <code
                      className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]"
                      style={{
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "var(--color-surface-sunken)",
                        border: "1px solid var(--color-border)"
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
              background: "var(--color-warning-soft)",
              border: "1px solid var(--color-warning-border)"
            }}
          >
            <span className="text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-warning)]"
              style={{ letterSpacing: "0.6px" }}
            >
              Importante
            </span>
            <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[var(--color-warning-fg)]">
              Este botón sólo abre revisión. La acción real se aprueba con
              ApprovalGate, firma de operador y audit chain.
            </p>
          </section>
        </div>

        <footer
          className="flex items-center"
          style={{ gap: 8, padding: "14px 22px", borderTop: "1px solid var(--color-border)" }}
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
              border: "1px solid var(--color-border-strong)"
            }}
          >
            <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
              Entendido
            </span>
          </button>
          <a
            href={`https://github.com/delivrix/delivrix/blob/main/DOCUMENTACION/${prompt.primaryAction.runbookRef ?? ""}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center bg-[var(--color-text-primary)]"
            style={{ gap: 6, padding: "8px 14px", borderRadius: 6, textDecoration: "none" }}
          >
            <ExternalLink size={12} strokeWidth={1.75} className="text-[var(--color-on-dark-strong)]" aria-hidden="true" />
            <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-on-dark-strong)]">
              Abrir runbook
            </span>
          </a>
        </footer>
      </div>
    </div>
  );
}
