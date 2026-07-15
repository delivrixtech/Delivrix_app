/**
 * Overview Dashboard — molde oficial "Aivora" con DATOS REALES.
 *
 * Reescritura de referencia sobre los primitivos de src/shared/ui/aivora
 * (Card, SectionHead, KpiCard, StateBadge, PlacementGauge, AvatarGroup,
 * AdvisorCard). La vista replica el demo aprobado (TravigueOverviewProto)
 * pero cada número, badge, track y gauge sale de `data: DashboardData`.
 *
 * Nada mock: donde no hay serie/medición real se muestra un estado vacío
 * honesto ("—" / "sin medición aún") en vez de barritas decorativas.
 */
import {
  ArrowRight,
  Flame,
  HardDrive,
  ListX,
  Server,
  ShieldCheck,
  Sparkles,
  Sprout,
  Target,
  type LucideIcon
} from "lucide-react";
import type {
  DashboardData,
  IpReputationReport,
  OpenClawCanvasLane,
  OpenClawCanvasPromptAction,
  SenderNodeContract
} from "../../shared/api/client.ts";
import { formatNumber } from "../../shared/lib/formatters.ts";
import {
  AdvisorCard,
  AvatarGroup,
  Card,
  KpiCard,
  PlacementGauge,
  SectionHead,
  StateBadge,
  aivoraGradient,
  stateColor,
  stateNeedsLeftBorder
} from "../../shared/ui/aivora/index.tsx";

/* ============================================================
 * Helpers de datos reales (sin mock)
 * ============================================================ */

/** Reputación agregada = (sent + delivered) / total de envíos. null si no hay envíos. */
function computeReputation(data: DashboardData): number | null {
  const byStatus =
    data.operationalSummary.sendResultsByStatus ??
    data.overview.summary.sendResultsByStatus ??
    {};
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const ok = (byStatus.sent ?? 0) + (byStatus.delivered ?? 0);
  return Math.round((ok / total) * 1000) / 10;
}

/** Placement promedio (score) sobre los reportes de reputación. null si no hay reportes. */
function averagePlacement(reports: IpReputationReport[]): number | null {
  if (reports.length === 0) return null;
  const sum = reports.reduce((a, r) => a + (r.score ?? 0), 0);
  return Math.round(sum / reports.length);
}

/** Último reporte por senderNodeId (gana el generatedAt más reciente). */
function latestReportsByNode(reports: IpReputationReport[]): Map<string, IpReputationReport> {
  const map = new Map<string, IpReputationReport>();
  for (const r of reports) {
    const prev = map.get(r.senderNodeId);
    if (!prev || new Date(r.generatedAt).getTime() > new Date(prev.generatedAt).getTime()) {
      map.set(r.senderNodeId, r);
    }
  }
  return map;
}

/** Iniciales de un label para el AvatarGroup (2 chars). */
function initials(value: string): string {
  const words = value.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "··";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const placementColor = (v: number | null): string =>
  v === null
    ? "var(--color-text-tertiary)"
    : v >= 75
      ? "var(--color-success)"
      : v >= 45
        ? "var(--color-warning)"
        : "var(--color-critical)";

/**
 * Etiqueta honesta para una acción del prompt en esta superficie de SOLO LECTURA.
 *
 * El overview no aplica / aprueba / descarta / pospone nada: su único efecto es
 * navegar al canvas, donde la acción real (`kind`) se ejecuta con su gate de
 * aprobación. Por eso NO reutilizamos `action.label` ("Aplicar"/"Descartar"/
 * "Aprobar"), que prometería una mutación que aquí no ocurre. La etiqueta refleja
 * el `kind` del contrato y deja claro que se resuelve "en canvas", en línea con el
 * badge "Solo lectura".
 */
function readonlyActionLabel(action: OpenClawCanvasPromptAction): string {
  switch (action.kind) {
    case "open_runbook":
      return "Ver runbook en canvas";
    case "view_evidence":
      return "Ver evidencia en canvas";
    case "ack":
      return "Revisar y aprobar en canvas";
    case "snooze":
      return "Posponer en canvas";
    default:
      return "Ver en canvas";
  }
}

/* ============================================================
 * Overview
 * ============================================================ */
export function OverviewSection({
  data,
  onNavigate
}: {
  data: DashboardData;
  /** Requerido: App.tsx siempre lo provee. La navegación al canvas es el único
   *  efecto que esta vista de solo lectura puede disparar. */
  onNavigate: (section: string) => void;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 24, width: "100%" }}>
      <Welcome data={data} />
      <KpiRow data={data} />
      <RampTimeline data={data} onNavigate={onNavigate} />
      <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] items-start" style={{ gap: 20 }}>
        <BandejasTable data={data} />
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <PlacementByProvider data={data} />
          <Advisor data={data} onNavigate={onNavigate} />
        </div>
      </div>
    </section>
  );
}

/* ── Welcome — eyebrow + h1 light + subtítulo con conteos reales ── */
function Welcome({ data }: { data: DashboardData }) {
  const total = data.senderNodes.length;
  const sender =
    data.operationalSummary.senderNodesByStatus ??
    data.overview.summary.senderNodesByStatus ??
    {};
  const warming = sender.warming ?? 0;
  const placement = averagePlacement(data.ipReputationReports);

  const byStatus =
    data.operationalSummary.sendResultsByStatus ??
    data.overview.summary.sendResultsByStatus ??
    {};
  const totalSends = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const hasSends = totalSends > 0;

  const parts = [
    `${total} ${total === 1 ? "nodo de envío" : "nodos de envío"}`,
    warming > 0 ? `${warming} en calentamiento` : "sin calentamiento activo",
    placement !== null ? `placement promedio ${placement}%` : "sin medición de placement aún"
  ];

  return (
    <SectionHead
      eyebrow="Panel operativo"
      title={
        hasSends ? (
          <>
            Capacidad activa,{" "}
            <span style={{ fontWeight: 500 }}>
              {formatNumber(totalSends)} {totalSends === 1 ? "envío registrado" : "envíos registrados"}
            </span>
            .
          </>
        ) : (
          <>
            Capacidad preparada, <span style={{ fontWeight: 500 }}>sin envíos reales</span>.
          </>
        )
      }
      subtitle={parts.join(" · ")}
      // Copy estático intencional: el contrato DashboardData no expone un flag de
      // capacidades/permisos, y toda la vista es de solo lectura (ninguna acción
      // muta estado desde aquí). Coherente con el Advisor, cuyos botones solo
      // navegan al canvas en lugar de prometer "Aplicar/Descartar".
      right={
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 11px",
            borderRadius: 999,
            background: "var(--color-success-soft)",
            color: "var(--color-success)",
            fontSize: 12,
            fontWeight: 600
          }}
        >
          <span
            style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-success)" }}
            aria-hidden="true"
          />
          Solo lectura
        </span>
      }
    />
  );
}

/* ── KPI row — 4 KpiCards con datos reales (sin delta/spark: no hay serie histórica) ── */
function KpiRow({ data }: { data: DashboardData }) {
  const total = data.senderNodes.length;
  const sender =
    data.operationalSummary.senderNodesByStatus ??
    data.overview.summary.senderNodesByStatus ??
    {};
  const warming = sender.warming ?? 0;
  const dlq = data.stuckJobs.count;
  const reputation = computeReputation(data);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 20 }}>
      <KpiCard label="Nodos de envío" value={formatNumber(total)} icon={Server} />
      <KpiCard label="Calentando" value={formatNumber(warming)} icon={Flame} />
      <KpiCard label="Errores DLQ" value={formatNumber(dlq)} icon={ListX} />
      <KpiCard
        label="Índice de reputación"
        value={reputation === null ? "—" : reputation.toFixed(1).replace(".", ",")}
        suffix={reputation === null ? undefined : "%"}
        icon={Target}
      />
    </div>
  );
}

/* ============================================================
 * Línea de rampa — canvas.nodes agrupados por lane
 * ============================================================ */
type LaneDef = { id: OpenClawCanvasLane; label: string; sub: string; Icon: LucideIcon };

const LANES: LaneDef[] = [
  { id: "onboarding", label: "Onboarding", sub: "Alta + DNS/DKIM", Icon: Sprout },
  { id: "hardware", label: "Hardware", sub: "Host físico + red", Icon: Server },
  { id: "provisioning", label: "Provisionamiento", sub: "VPS + Postfix", Icon: HardDrive },
  { id: "warming", label: "Calentamiento", sub: "Rampa gradual", Icon: Flame },
  { id: "reputation", label: "Reputación", sub: "Placement estable", Icon: ShieldCheck }
];

function RampTimeline({
  data,
  onNavigate
}: {
  data: DashboardData;
  onNavigate: (section: string) => void;
}) {
  const nodes = data.canvas.nodes ?? [];
  const currentNode = nodes.find((n) => n.id === data.canvas.currentStepId);
  const activeLane = currentNode?.lane;
  const activeLaneDef = LANES.find((l) => l.id === activeLane);

  return (
    <Card style={{ padding: "18px 20px 22px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap"
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
            Línea de rampa
          </div>
          <div style={{ fontSize: 12.5, color: "var(--color-text-tertiary)", marginTop: 2 }}>
            Onboarding → Reputación · progreso en vivo
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {activeLaneDef ? (
            <span
              style={{
                fontSize: 12,
                color: "var(--color-warming)",
                background: "var(--color-warming-soft)",
                borderRadius: 999,
                padding: "3px 10px",
                fontWeight: 500
              }}
            >
              Fase actual: {activeLaneDef.label}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onNavigate("canvas")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              borderRadius: 10,
              padding: "6px 12px",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer"
            }}
          >
            Abrir canvas
            <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      {nodes.length === 0 ? (
        <div
          style={{
            fontSize: 13,
            color: "var(--color-text-tertiary)",
            padding: "18px 2px"
          }}
        >
          El canvas no reporta nodos todavía. Sin datos de rampa que graficar.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {LANES.map((lane) => {
            const laneNodes = nodes.filter((n) => n.lane === lane.id);
            const isActive = lane.id === activeLane;
            // Subtítulo real del carril: resumen del nodo relevante (el paso actual
            // si cae en este carril, si no el primero). `lane.sub` solo se usa como
            // fallback estático cuando el nodo no trae `summary`.
            const repNode = laneNodes.find((n) => n.id === data.canvas.currentStepId) ?? laneNodes[0];
            const laneSub =
              laneNodes.length === 0 ? "sin nodos" : repNode?.summary?.trim() || lane.sub;
            const progress =
              laneNodes.length === 0
                ? 0
                : Math.round(
                    laneNodes.reduce((a, n) => a + (n.progressPercent ?? 0), 0) / laneNodes.length
                  );
            const done = progress >= 100;
            const color = isActive
              ? "var(--color-warming)"
              : done
                ? "var(--color-success)"
                : "var(--color-text-tertiary)";
            const avatars = laneNodes.slice(0, 3).map((n) => initials(n.label));
            if (laneNodes.length > 3) avatars.push(`+${laneNodes.length - 3}`);

            return (
              <div
                key={lane.id}
                className="grid grid-cols-[104px_1fr] sm:grid-cols-[132px_1fr]"
                style={{
                  gap: 16,
                  alignItems: "center"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      background: "color-mix(in srgb, var(--color-text-primary) 5%, transparent)",
                      border: "1px solid var(--color-border)",
                      display: "grid",
                      placeItems: "center",
                      flex: "none"
                    }}
                  >
                    <lane.Icon size={14} color={color} strokeWidth={1.8} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "var(--color-text-primary)", fontWeight: 500 }}>
                      {lane.label}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--color-text-tertiary)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis"
                      }}
                      title={laneSub}
                    >
                      {laneSub}
                    </div>
                  </div>
                </div>

                <div style={{ position: "relative", height: 34 }}>
                  <div
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: 0,
                      right: 0,
                      height: 2,
                      background: "color-mix(in srgb, var(--color-text-primary) 8%, transparent)",
                      borderRadius: 2,
                      transform: "translateY(-50%)"
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: "50%",
                      transform: "translateY(-50%)",
                      left: 0,
                      width: `${Math.max(progress, laneNodes.length ? 4 : 0)}%`,
                      height: 8,
                      borderRadius: 999,
                      background: done ? color : `color-mix(in srgb, ${color} 45%, transparent)`,
                      border: isActive ? `1px solid ${color}` : "none",
                      boxShadow: isActive
                        ? `0 0 0 3px color-mix(in srgb, ${color} 15%, transparent)`
                        : "none"
                    }}
                  />
                  {laneNodes.length > 0 ? (
                    <div
                      style={{
                        position: "absolute",
                        top: "50%",
                        left: 6,
                        transform: "translateY(-50%)"
                      }}
                    >
                      <AvatarGroup items={avatars} tint={color} />
                    </div>
                  ) : null}
                  <div
                    style={{
                      position: "absolute",
                      top: -2,
                      right: 0,
                      fontSize: 11,
                      color: "var(--color-text-tertiary)",
                      fontVariantNumeric: "tabular-nums"
                    }}
                  >
                    {laneNodes.length === 0 ? "—" : `${progress}%`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ============================================================
 * Bandejas — senderNodes JOIN ipReputationReports
 * ============================================================ */
function BandejasTable({ data }: { data: DashboardData }) {
  const nodes = data.senderNodes;
  const reports = latestReportsByNode(data.ipReputationReports);

  return (
    <Card style={{ overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 20px",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
          Nodos de envío
        </div>
        <span style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>
          {nodes.length} {nodes.length === 1 ? "nodo" : "nodos"}
        </span>
      </div>

      {nodes.length === 0 ? (
        <div style={{ padding: "28px 20px", fontSize: 13, color: "var(--color-text-tertiary)" }}>
          Sin nodos de envío registrados todavía.
        </div>
      ) : (
        <>
          <div
            className="grid grid-cols-[1fr_auto_auto] sm:grid-cols-[1fr_auto_auto_auto]"
            style={{
              fontSize: 11,
              color: "var(--color-text-tertiary)",
              padding: "8px 20px",
              borderBottom: "1px solid var(--color-border)",
              gap: 12,
              textTransform: "uppercase",
              letterSpacing: ".05em"
            }}
          >
            <span>Bandeja</span>
            <span>Estado</span>
            <span style={{ textAlign: "right" }}>Placement</span>
            <span className="hidden sm:block" style={{ textAlign: "right" }}>
              Warmup
            </span>
          </div>
          {nodes.map((node) => (
            <BandejaRow key={node.id} node={node} report={reports.get(node.id)} />
          ))}
        </>
      )}
    </Card>
  );
}

function BandejaRow({
  node,
  report
}: {
  node: SenderNodeContract;
  report?: IpReputationReport;
}) {
  const placement = report ? Math.round(report.score) : null;
  const host = node.hostname ?? node.ipAddress ?? node.provider;
  const leftBorder = stateNeedsLeftBorder(node.status);

  return (
    <div
      className="grid grid-cols-[1fr_auto_auto] sm:grid-cols-[1fr_auto_auto_auto]"
      style={{
        alignItems: "center",
        gap: 12,
        padding: "12px 20px",
        borderBottom: "1px solid var(--color-border)",
        borderLeft: leftBorder
          ? `2px solid ${stateColor(node.status)}`
          : "2px solid transparent"
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            color: "var(--color-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }}
        >
          {node.label}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>
          {node.provider} · {host}
        </div>
      </div>
      <StateBadge status={node.status} />
      <div
        style={{
          textAlign: "right",
          fontSize: 14,
          color: placementColor(placement),
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums"
        }}
        title={placement === null ? "sin medición aún" : undefined}
      >
        {placement === null ? "—" : `${placement}%`}
      </div>
      <div
        className="hidden sm:block"
        style={{
          textAlign: "right",
          fontSize: 12,
          color: "var(--color-text-secondary)",
          fontVariantNumeric: "tabular-nums"
        }}
      >
        {node.warmupDay > 0 ? `día ${node.warmupDay}` : "—"}
      </div>
    </div>
  );
}

/* ============================================================
 * Placement por proveedor — gauges agregados desde los reportes
 * ============================================================ */
function PlacementByProvider({ data }: { data: DashboardData }) {
  const byProvider = new Map<string, { sum: number; n: number }>();
  for (const r of data.ipReputationReports) {
    const acc = byProvider.get(r.provider) ?? { sum: 0, n: 0 };
    acc.sum += r.score ?? 0;
    acc.n += 1;
    byProvider.set(r.provider, acc);
  }
  const gauges = [...byProvider.entries()]
    .map(([provider, { sum, n }]) => ({ provider, value: Math.round(sum / n) }))
    .slice(0, 3);

  return (
    <Card ink style={{ padding: "16px 20px" }}>
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          marginBottom: 6,
          color: "var(--color-text-primary)"
        }}
      >
        Placement por proveedor
      </div>
      {gauges.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--color-text-tertiary)", padding: "16px 0" }}>
          Sin medición de placement aún.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            // Responsive: en desktop entran los N gauges en una fila; en angosto
            // envuelven a 2 (o 1) columnas sin desbordar, gracias a auto-fit.
            gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 110px), 1fr))`,
            gap: 6
          }}
        >
          {gauges.map((g) => (
            <PlacementGauge key={g.provider} value={g.value} label={g.provider} />
          ))}
        </div>
      )}
    </Card>
  );
}

/* ============================================================
 * Advisor OpenClaw — canvas.prompt o readinessSignals.recommendations
 * ============================================================ */
function Advisor({
  data,
  onNavigate
}: {
  data: DashboardData;
  onNavigate: (section: string) => void;
}) {
  const prompt = data.canvas.prompt;
  const recommendation = data.readinessSignals.recommendations[0];

  let body: string;
  let primaryLabel: string;
  let secondaryLabel: string | null;
  // Título (tooltip) que preserva la acción real del contrato para que el operador
  // sepa qué se ejecutará al llegar al canvas, sin que el botón la prometa aquí.
  let primaryTitle: string | undefined;
  let secondaryTitle: string | undefined;
  if (prompt) {
    body = prompt.body || prompt.headline;
    // Honramos `kind`, no el label crudo ("Aplicar"/"Descartar"): esta superficie
    // es solo lectura y únicamente navega al canvas donde la acción se resuelve.
    primaryLabel = readonlyActionLabel(prompt.primaryAction);
    secondaryLabel = readonlyActionLabel(prompt.secondaryAction);
    primaryTitle = `Acción "${prompt.primaryAction.label}" — se ejecuta en el canvas`;
    secondaryTitle = `Acción "${prompt.secondaryAction.label}" — se ejecuta en el canvas`;
  } else if (recommendation) {
    body = recommendation.label;
    primaryLabel = "Ver en canvas";
    secondaryLabel = null;
  } else {
    body =
      "OpenClaw observa la infraestructura en modo solo lectura. Sin recomendaciones pendientes.";
    primaryLabel = "Ver en canvas";
    secondaryLabel = null;
  }

  const chips: string[] = [];
  if (prompt?.severity) chips.push(`severidad ${prompt.severity}`);
  if (prompt && typeof prompt.currentApprovals === "number" && typeof prompt.requiredApprovals === "number") {
    chips.push(`aprobaciones ${prompt.currentApprovals}/${prompt.requiredApprovals}`);
  }

  return (
    <AdvisorCard>
      <div style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: aivoraGradient,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Sparkles size={16} color="var(--color-accent-fg)" />
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 500, color: "var(--color-text-primary)" }}>
            Advisor · OpenClaw
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            borderLeft: "2px solid transparent",
            borderImage: `${aivoraGradient} 1`,
            paddingLeft: 12
          }}
        >
          {prompt?.headline ? (
            <div
              style={{
                fontSize: 13.5,
                color: "var(--color-text-primary)",
                fontWeight: 600,
                marginBottom: 4
              }}
            >
              {prompt.headline}
            </div>
          ) : null}
          <div
            style={{
              fontSize: 13.5,
              color: "var(--color-text-secondary)",
              lineHeight: 1.5,
              fontWeight: 300
            }}
          >
            {body}
          </div>
          {chips.length > 0 ? (
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              {chips.map((c) => (
                <span
                  key={c}
                  style={{
                    fontSize: 11.5,
                    color: "var(--color-accent)",
                    background: "var(--color-accent-soft)",
                    borderRadius: 999,
                    padding: "3px 9px"
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button
            type="button"
            onClick={() => onNavigate("canvas")}
            title={primaryTitle}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: aivoraGradient,
              color: "var(--color-accent-fg)",
              border: "none",
              borderRadius: 10,
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer"
            }}
          >
            {primaryLabel}
            <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {secondaryLabel ? (
            <button
              type="button"
              onClick={() => onNavigate("canvas")}
              title={secondaryTitle}
              style={{
                background: "transparent",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                padding: "8px 16px",
                fontSize: 13,
                cursor: "pointer"
              }}
            >
              {secondaryLabel}
            </button>
          ) : null}
        </div>
      </div>
    </AdvisorCard>
  );
}
