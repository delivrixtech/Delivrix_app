/**
 * v5 Clústeres — flota de nodos de envío supervisada.
 *
 * Restyle al MOLDE oficial "Aivora" (features/overview/TravigueOverviewProto.tsx):
 * cards radius 18 + hairline + shadow-sm, KpiCard con tile+número tabular, StateBadge
 * dot+icono, SectionHead eyebrow + h1 light, AdvisorCard para el patrón OpenClaw.
 * Todo el color sale de tokens var(--color-*); nada de hex ni paletas nuevas.
 *
 * DATOS REALES: data.clusters, data.operationalSummary.senderNodesByStatus,
 * data.senderNodes (warmupDay/dailyLimit reales del contrato), data.killSwitch,
 * data.canvas.requiresHumanApproval/blockedBy. Kill switch + modal (POST /v1/kill-switch)
 * intactos. Placeholders falsos ("14d sin medición", "Día 9 · 50k/d") → dato real si
 * existe, o estado vacío honesto con el molde.
 */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Flame,
  Network,
  Power,
  Server,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { loadDashboardData } from "../../shared/api/client";
import type { DashboardData, SenderNodeContract } from "../../shared/api/client";
import { staggerContainer, staggerItem } from "../lib/motion";
import { Card, SectionHead, KpiCard, StateBadge, AdvisorCard, Button, Pill, Eyebrow, aivoraGradient } from "../../shared/ui/aivora";
import { useToast } from "../../shared/ui/v2";

const POLL_SEC = 30;

/* Estilos mono/label reusados — todos derivados de tokens. --font-mono está
 * congelado a Inter (tabular-nums) a propósito: una sola familia, nada ad-hoc. */
const MONO: CSSProperties = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };

/** Compacta un tope diario real (config): 50000 → "50k". */
function compactLimit(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(n);
}

/* ============================================================
 * LivePulse — indicador de frescura del dashboard (dot + label + pulso).
 *
 * NO es un adorno siempre-verde: el tono y el "hace Xs" salen de la señal REAL
 * del query de react-query (dataUpdatedAt = último fetch exitoso, isError = último
 * fetch falló), no de un reloj congelado al montar. Reglas (POLL_SEC = intervalo de
 * refetch de App.tsx):
 *   • último fetch OK y fresco (< 2 ciclos de poll)  → success "En vivo" + pulso.
 *   • sin refetch exitoso hace > 2 ciclos            → warning "Datos atrasados", sin pulso.
 *   • último fetch con error                          → critical "Sin conexión", sin pulso.
 *   • sin ninguna lectura (updatedAt = 0)             → estado neutro honesto, sin "en vivo".
 * El pulso (que en el documento §4 "dice en vivo") corre SOLO en success: nunca fingimos
 * liveness cuando el backend está caído o el dato quedó viejo. prefers-reduced-motion lo apaga.
 * ============================================================ */

type LiveTone = "success" | "warning" | "critical";

function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  return `hace ${Math.floor(minutes / 60)}h`;
}

function LivePulse({ pollSec, updatedAt, isError }: { pollSec: number; updatedAt: number; isError: boolean }) {
  const reduce = useReducedMotion();
  const [, setTick] = useState(0);
  useEffect(() => {
    // Tick de 1s: hace avanzar el "hace Xs" y deja que el tono vire a "atrasado"
    // aunque no llegue un re-render nuevo del query (p. ej. el poll dejó de refrescar).
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const hasSignal = updatedAt > 0;
  const ageSec = hasSignal ? Math.max(0, Math.floor((Date.now() - updatedAt) / 1000)) : null;
  // "Atrasado" = el loop de poll no entregó dato fresco en 2 ciclos + gracia.
  const staleThreshold = pollSec * 2 + 5;

  const tone: LiveTone = isError
    ? "critical"
    : !hasSignal || (ageSec != null && ageSec > staleThreshold)
    ? "warning"
    : "success";
  const live = tone === "success";

  const color =
    tone === "warning" ? "var(--color-warning)" : tone === "critical" ? "var(--color-critical)" : "var(--color-success)";
  const soft =
    tone === "warning"
      ? "var(--color-warning-soft)"
      : tone === "critical"
      ? "var(--color-critical-soft)"
      : "var(--color-success-soft)";
  const label = isError ? "Sin conexión" : tone === "warning" ? "Datos atrasados" : "En vivo";
  const rel = hasSignal ? formatRelative(updatedAt) : null;

  return (
    <span
      aria-label={rel ? `${label}: actualizado ${rel}` : `${label}: sin lectura de frescura`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        background: soft,
        color
      }}
    >
      <span aria-hidden="true" style={{ position: "relative", width: 8, height: 8, display: "inline-block" }}>
        {reduce || !live ? null : (
          <motion.span
            style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }}
            initial={{ scale: 1, opacity: 0.4 }}
            animate={{ scale: 2.2, opacity: 0 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span
          style={{ position: "absolute", top: 2, left: 2, width: 4, height: 4, borderRadius: "50%", background: color }}
        />
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.01em", fontVariantNumeric: "tabular-nums" }}>
        {label} · poll {pollSec}s{rel ? ` · ${rel}` : ""}
      </span>
    </span>
  );
}

export interface ClustersV5Props {
  data: DashboardData;
}

export function ClustersV5({ data }: ClustersV5Props) {
  // Nos re-suscribimos al MISMO query del dashboard (la fuente que App.tsx refresca
  // cada 30s) solo para LEER su frescura real: dataUpdatedAt (último fetch OK) e isError.
  // enabled:false → este observador no dispara un segundo loop de poll; refleja el estado
  // compartido del cache de forma reactiva. Así el badge deja de colgar de un reloj de montaje.
  const dashboardQuery = useQuery({
    queryKey: ["admin-panel", "dashboard"],
    queryFn: loadDashboardData,
    enabled: false
  });

  const clusters = data.clusters.clusters ?? [];
  const totals = data.clusters.totals ?? {};
  const senderByStatus =
    data.operationalSummary.senderNodesByStatus ??
    data.overview.summary.senderNodesByStatus ??
    {};

  // Índice de contratos reales de nodos (warmupDay + dailyLimit) por id.
  const nodeContractById = new Map<string, SenderNodeContract>(
    (data.senderNodes ?? []).map((n) => [n.id, n])
  );

  const totalClusters = totals.clusters ?? clusters.length;
  const totalNodes =
    data.senderNodes.length ||
    totals.senderNodes ||
    clusters.reduce((sum, c) => sum + (c.senderNodes?.length ?? 0), 0);
  const activeNodes = senderByStatus.active ?? senderByStatus.ready ?? 0;
  const warmingNodes = senderByStatus.warming ?? 0;
  const clustersInWarmup = clusters.filter((c) =>
    (c.senderNodes ?? []).some((n) => n.status.toLowerCase().includes("warming"))
  ).length;

  const ks = data.killSwitch;
  const approvals = data.canvas.requiresHumanApproval ?? [];
  const blockers = data.canvas.blockedBy ?? [];

  const showBanner = warmingNodes > 0 || approvals.length > 0 || blockers.length > 0;

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <SectionHead
          eyebrow="Flota supervisada"
          title="Clústeres y nodos de envío."
          subtitle="Capacidad preparada, observada y gobernada por gates humanos. Cada clúster agrupa IPs y nodos con su propio plan de warmup, reputación y kill switch local."
          right={
            <LivePulse
              pollSec={POLL_SEC}
              updatedAt={dashboardQuery.dataUpdatedAt}
              isError={dashboardQuery.isError}
            />
          }
        />
      </motion.div>

      <motion.section variants={staggerItem} className="flex flex-col gap-4">
        <SectionHead
          eyebrow="Estado actual"
          title="Capacidad de la flota"
          subtitle={
            <>
              Snapshot derivado del overview agregado ·{" "}
              <span style={{ ...MONO, color: "var(--color-text-tertiary)" }}>panel-aggregator</span>
            </>
          }
        />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard icon={Server} label="Clústeres totales" value={totalClusters} />
          <KpiCard icon={Network} label="IPs en pool" value={totalNodes} />
          <KpiCard icon={CircleCheck} label="Nodos activos" value={activeNodes} />
          <KpiCard icon={Flame} label="Clústeres en warmup" value={clustersInWarmup} />
        </div>
      </motion.section>

      {showBanner ? (
        <motion.div variants={staggerItem}>
          <OpenClawBanner
            warming={warmingNodes}
            approvals={approvals.length}
            blockers={blockers.length}
          />
        </motion.div>
      ) : null}

      <motion.section variants={staggerItem} className="flex flex-col gap-4">
        <SectionHead
          eyebrow="Flota"
          title="Clústeres de envío"
          subtitle={
            clusters.length === 0
              ? "Sin clústeres bajo gobierno todavía"
              : `${clusters.length} clúster${clusters.length === 1 ? "" : "es"} supervisado${clusters.length === 1 ? "" : "s"}`
          }
        />
        {clusters.length === 0 ? (
          <Card style={{ padding: 20 }} className="flex items-start gap-4">
            <div
              className="grid shrink-0 place-items-center"
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                background: "color-mix(in srgb, var(--color-text-primary) 5%, transparent)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-tertiary)"
              }}
            >
              <Server size={18} strokeWidth={1.7} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
                Aún no hay clústeres provisionados
              </div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)" }}>
                Cuando OpenClaw aprovisione el primer clúster, aparece acá con su estado, plan de
                warmup e IPs registradas en audit chain.
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {clusters.map((c) => (
              <ClusterCard key={c.id} cluster={c} nodeContractById={nodeContractById} />
            ))}
          </div>
        )}
      </motion.section>

      <motion.div variants={staggerItem}>
        <KillSwitchBlock ks={ks} />
      </motion.div>

      <motion.div variants={staggerItem}>
        <FooterBar />
      </motion.div>
    </motion.div>
  );
}

/* ============================================================
 * Banner OpenClaw (condicional) — molde AdvisorCard
 * ============================================================ */

function OpenClawBanner({
  warming,
  approvals,
  blockers
}: {
  warming: number;
  approvals: number;
  blockers: number;
}) {
  const title =
    blockers > 0
      ? "Bloqueos activos en topología"
      : approvals > 0
      ? "Plan de warmup espera aprobación humana"
      : "OpenClaw propone calentar IPs nuevas";
  const body =
    blockers > 0
      ? `Detecté ${blockers} bloqueo${blockers === 1 ? "" : "s"} activos en la topología del canvas. Te marco cuáles afectan la flota antes de proponer el siguiente paso.`
      : approvals > 0
      ? `${approvals} aprobación${approvals === 1 ? "" : "es"} humana${approvals === 1 ? "" : "s"} pendiente${approvals === 1 ? "" : "s"} para avanzar el ciclo de warmup. Preparé el plan en dry-run; firmá cuando lo revises.`
      : `Hay ${warming} IP${warming === 1 ? "" : "s"} en ramp-up. Propongo subir el target del día siguiente respetando el tope diario configurado.`;

  // Disciplina de color del documento: el acento AZUL nunca codifica estado (solo CTA/
  // alcance neutro). Bloqueos = critical (rojo). Warmup = warming (cyan), que significa
  // "proceso". Aprobaciones = neutral (atención sin gastar cyan ni el ámbar reservado a
  // paused). Cero azul-como-estado, cero cyan fuera de warmup.
  const chips: Array<{ label: string; tone: "neutral" | "warming" | "critical" }> = [];
  if (blockers > 0) chips.push({ label: `${blockers} bloqueo${blockers === 1 ? "" : "s"}`, tone: "critical" });
  if (approvals > 0) chips.push({ label: `${approvals} aprobación${approvals === 1 ? "" : "es"}`, tone: "neutral" });
  if (warming > 0) chips.push({ label: `${warming} en ramp-up`, tone: "warming" });

  return (
    <AdvisorCard>
      <div style={{ padding: 20 }}>
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
            <Sparkles size={16} color="#fff" />
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 500, color: "var(--color-text-primary)" }}>
            Advisor · OpenClaw
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            borderLeft: "2px solid var(--color-accent-soft)",
            paddingLeft: 12
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)", letterSpacing: "-0.01em" }}>
            {title}
          </div>
          <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)", fontWeight: 300 }}>
            {body}
          </div>
          {chips.length > 0 ? (
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              {chips.map((c) => (
                <Pill key={c.label} tone={c.tone}>
                  {c.label}
                </Pill>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <Button variant="gradient">
            <Sparkles size={14} />
            Revisar plan
          </Button>
          <Button variant="ghost">
            Abrir canvas
            <ArrowRight size={13} strokeWidth={1.9} />
          </Button>
        </div>

        <div style={{ marginTop: 12, fontSize: 12.5, fontStyle: "italic", color: "var(--color-text-tertiary)" }}>
          Si querés que te lo explique paso a paso antes de firmar, abrí el chat.
        </div>
      </div>
    </AdvisorCard>
  );
}

/* ============================================================
 * Cluster Card — molde Card + StateBadge
 * ============================================================ */

type ClusterT = DashboardData["clusters"]["clusters"][number];

const STATUS_BADGE: Record<ClusterStatus, { status: string; label: string }> = {
  active: { status: "active", label: "Activo" },
  warmup: { status: "warming", label: "Warmup" },
  paused: { status: "paused", label: "Pausado" },
  error: { status: "quarantined", label: "Error" }
};

function ClusterCard({
  cluster,
  nodeContractById
}: {
  cluster: ClusterT;
  nodeContractById: Map<string, SenderNodeContract>;
}) {
  const [expanded, setExpanded] = useState(false);
  const nodes = cluster.senderNodes ?? [];
  const status = inferClusterStatus(cluster);
  const badge = STATUS_BADGE[status];

  const warmingNodes = nodes.filter((n) => n.status.toLowerCase().includes("warming"));
  const activeCount = nodes.filter((n) => {
    const s = n.status.toLowerCase();
    return s.includes("active") || s.includes("ready");
  }).length;

  // Plan de warmup REAL: warmupDay + dailyLimit del contrato de cada nodo calentando.
  const warmupReal = warmingNodes.reduce(
    (acc, n) => {
      const c = nodeContractById.get(n.id);
      if (!c) return acc;
      return {
        day: Math.max(acc.day, c.warmupDay ?? 0),
        limit: Math.max(acc.limit, c.dailyLimit ?? 0),
        matched: acc.matched + 1
      };
    },
    { day: 0, limit: 0, matched: 0 }
  );

  return (
    <Card style={{ padding: 20 }} className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span style={{ ...MONO, fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
              {cluster.id}
            </span>
            <StateBadge status={badge.status} label={badge.label} />
          </div>
          <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
            {cluster.provider} · estado{" "}
            <span style={{ ...MONO, color: "var(--color-text-secondary)" }}>{cluster.managementState}</span>
          </span>
        </div>
        <span
          style={{
            ...MONO,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--color-text-secondary)",
            background: "color-mix(in srgb, var(--color-text-primary) 5%, transparent)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: "3px 8px",
            whiteSpace: "nowrap"
          }}
        >
          {nodes.length} IPs
        </span>
      </header>

      {/* Reputación — sin serie real disponible: estado vacío honesto con el molde. */}
      <div
        className="flex items-center justify-between gap-2"
        style={{
          borderRadius: 12,
          border: "1px dashed var(--color-border)",
          padding: "8px 12px"
        }}
      >
        <Eyebrow>Reputación</Eyebrow>
        <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>pendiente · sin medición</span>
      </div>

      {/* Plan de warmup — dato REAL (warmupDay/dailyLimit) o estado honesto. */}
      {warmingNodes.length > 0 ? (
        <div
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5"
          style={{
            borderRadius: 12,
            border: "1px solid var(--color-border)",
            background: "color-mix(in srgb, var(--color-text-primary) 5%, transparent)",
            padding: "8px 12px"
          }}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Flame size={13} strokeWidth={1.9} color="var(--color-warming)" />
            <span style={{ fontSize: 12.5, color: "var(--color-text-primary)" }}>
              {warmupReal.matched > 0 && warmupReal.day > 0
                ? `Plan warmup · Día ${warmupReal.day}`
                : "Plan warmup en curso"}
            </span>
            {warmupReal.limit > 0 ? (
              <Pill tone="neutral" style={{ fontWeight: 500 }}>
                cap {compactLimit(warmupReal.limit)}/día · config
              </Pill>
            ) : null}
          </div>
          <span style={{ ...MONO, fontSize: 11.5, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
            {warmingNodes.length} en ramp-up
          </span>
        </div>
      ) : (
        <div
          className="flex items-center justify-between gap-2"
          style={{
            borderRadius: 12,
            border: "1px solid var(--color-border)",
            background: "color-mix(in srgb, var(--color-text-primary) 5%, transparent)",
            padding: "8px 12px"
          }}
        >
          <div className="flex items-center gap-2">
            <Sparkles size={13} strokeWidth={1.9} color="var(--color-text-tertiary)" />
            <span style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>Sin warmup en curso</span>
          </div>
          <span style={{ ...MONO, fontSize: 11.5, color: "var(--color-text-tertiary)" }}>
            {activeCount} activos
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 self-start rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        {expanded ? (
          <ChevronDown size={13} strokeWidth={1.9} />
        ) : (
          <ChevronRight size={13} strokeWidth={1.9} />
        )}
        {expanded ? "Ocultar IPs" : `Ver ${nodes.length} IP${nodes.length === 1 ? "" : "s"}`}
      </button>

      {expanded ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {nodes.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>Sin nodos asignados.</span>
          ) : (
            nodes.map((n) => <NodeRow key={n.id} node={n} />)
          )}
        </ul>
      ) : null}

      <div
        className="flex items-center justify-end gap-2"
        style={{ borderTop: "1px solid var(--color-border)", paddingTop: 14 }}
      >
        <Button variant="ghost">Configurar</Button>
        <Button variant="ghost">
          Ver detalle
          <ArrowRight size={12} strokeWidth={1.9} />
        </Button>
      </div>
    </Card>
  );
}

function NodeRow({ node }: { node: ClusterT["senderNodes"][number] }) {
  return (
    <li
      className="flex items-center gap-3"
      style={{ borderRadius: 8, padding: "6px 8px" }}
    >
      <span
        aria-hidden="true"
        style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: statusDot(node.status) }}
      />
      <span style={{ ...MONO, flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {node.label || node.id}
      </span>
      <StateBadge status={normalizeNodeStatus(node.status)} label={node.status} />
    </li>
  );
}

/* ============================================================
 * Kill Switch Block (always-dark) — intacto
 * ============================================================ */

interface KillSwitchBlockProps {
  ks: DashboardData["killSwitch"];
}

function KillSwitchBlock({ ks }: KillSwitchBlockProps) {
  const armed = !ks.enabled;
  const [modalOpen, setModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (payload: { enabled: boolean; reason: string; actorId: string }) => {
      const res = await fetch("/v1/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ` · ${text.slice(0, 120)}` : ""}`);
      }
      return res.json() as Promise<{ killSwitch: { enabled: boolean } }>;
    },
    onSuccess: (result) => {
      const nowEnabled = result.killSwitch.enabled;
      toast.success(
        nowEnabled ? "Interruptor de corte ACTIVADO" : "Interruptor de corte rearmado",
        {
          description: nowEnabled
            ? "Pipeline de envío bloqueado. Audit event escrito."
            : "Pipeline disponible. Audit event escrito."
        }
      );
      void queryClient.invalidateQueries({ queryKey: ["admin-panel", "dashboard"] });
      setModalOpen(false);
    },
    onError: (error) => {
      toast.error("No se pudo cambiar el interruptor de corte", {
        description: error instanceof Error ? error.message : "Error desconocido"
      });
    }
  });

  const responsable = ks.updatedBy || "sin registro";
  const updatedAt = ks.updatedAt
    ? new Date(ks.updatedAt).toLocaleString("es-CO", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      })
    : "—";

  const buttonBg = "var(--color-always-dark-bg)";
  const buttonBorder = "1px solid var(--color-always-dark-border-strong)";

  return (
    <>
      <section
        className="flex flex-col overflow-hidden rounded-[10px]"
        style={{
          background: "var(--color-always-dark-bg)",
          border: "1px solid var(--color-always-dark-border)"
        }}
      >
        <div
          className="flex items-start gap-4 p-5"
          style={{ borderBottom: "1px solid var(--color-always-dark-border)" }}
        >
          <div
            className="grid size-10 shrink-0 place-items-center rounded-md"
            style={{
              background: armed
                ? "var(--color-on-dark-success-overlay)"
                : "var(--color-on-dark-critical-overlay)",
              color: "var(--color-on-dark-strong)"
            }}
            aria-hidden="true"
          >
            <Power size={18} strokeWidth={1.75} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span
                className="font-mono text-[10px] font-semibold uppercase leading-none"
                style={{ color: "var(--color-on-dark-medium)", letterSpacing: "0.14em" }}
              >
                Interruptor de corte
              </span>
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[10px] font-medium"
                style={{
                  background: armed
                    ? "var(--color-on-dark-success-overlay)"
                    : "var(--color-on-dark-critical-overlay)",
                  color: "var(--color-on-dark-strong)"
                }}
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 rounded-full"
                  style={{
                    background: armed ? "var(--color-success)" : "var(--color-critical)"
                  }}
                />
                {armed ? "Armado" : "Activado"}
              </span>
            </div>
            <h2
              className="m-0 font-heading text-[16px] font-semibold leading-[1.25]"
              style={{ color: "var(--color-on-dark-strong)", letterSpacing: "-0.01em" }}
            >
              {armed
                ? "Pipeline disponible · listo para corte de emergencia"
                : "Pipeline bloqueado · corte de emergencia activo"}
            </h2>
            <p
              className="m-0 font-sans text-[12.5px] leading-[1.5]"
              style={{ color: "var(--color-on-dark-medium)", maxWidth: 520 }}
            >
              {ks.reason
                ? `Razón · ${ks.reason}`
                : "Sin uso registrado. Cualquier acción queda en audit chain con el operador responsable."}
            </p>
          </div>
          <div className="hidden flex-col items-end gap-1 lg:flex">
            <span
              className="font-mono text-[10px] uppercase"
              style={{ color: "var(--color-on-dark-soft)", letterSpacing: "0.14em" }}
            >
              Responsable
            </span>
            <span
              className="font-mono text-[12px]"
              style={{ color: "var(--color-on-dark-strong)" }}
            >
              {responsable}
            </span>
            <span
              className="font-mono text-[10px]"
              style={{ color: "var(--color-on-dark-soft)" }}
            >
              {updatedAt}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <span
            className="font-sans text-[11px]"
            style={{ color: "var(--color-on-dark-medium)" }}
          >
            1 firma operador · audit chain SHA-256 · rol elevado obligatorio.
          </span>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={mutation.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 font-sans text-[13px] font-semibold transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              background: buttonBg,
              border: buttonBorder,
              color: "var(--color-on-dark-strong)",
              cursor: mutation.isPending ? "wait" : "pointer"
            }}
          >
            <Power size={13} strokeWidth={1.75} />
            {mutation.isPending
              ? "Procesando…"
              : armed
              ? "Activar interruptor"
              : "Rearmar interruptor"}
          </button>
        </div>
      </section>

      {modalOpen ? (
        <KillSwitchModal
          armed={armed}
          isPending={mutation.isPending}
          onCancel={() => setModalOpen(false)}
          onConfirm={(reason, actorId) => mutation.mutate({ enabled: armed, reason, actorId })}
        />
      ) : null}
    </>
  );
}

/* ============================================================
 * Modal de confirmación KillSwitch — intacto
 * ============================================================ */

function KillSwitchModal({
  armed,
  isPending,
  onCancel,
  onConfirm
}: {
  armed: boolean;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string, actorId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [actorId, setActorId] = useState("");

  const activating = armed;
  const reasonValid = !activating || reason.trim().length >= 4;
  const actorValid = actorId.trim().length >= 2;
  const canSubmit = reasonValid && actorValid && !isPending;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onConfirm(reason.trim(), actorId.trim());
  }, [canSubmit, reason, actorId, onConfirm]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cluster-killswitch-modal-title"
      className="fixed inset-0 z-[9990] flex items-start justify-center overflow-y-auto px-4 py-4"
      style={{
        background: "color-mix(in srgb, var(--color-always-dark-bg) 62%, transparent)",
        // Safari exige el prefijo -webkit para el desenfoque del scrim del modal.
        WebkitBackdropFilter: "blur(4px)",
        backdropFilter: "blur(4px)"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        className="my-auto flex w-full max-w-[460px] flex-col overflow-hidden rounded-[10px]"
        style={{
          background: "var(--color-always-dark-surface)",
          border: "1px solid var(--color-always-dark-border-strong)",
          boxShadow: "var(--shadow-lg)",
          maxHeight: "calc(100dvh - 32px)"
        }}
      >
        <header
          className="flex shrink-0 items-start gap-3 p-5"
          style={{ borderBottom: "1px solid var(--color-always-dark-border)" }}
        >
          <div
            className="grid size-9 shrink-0 place-items-center rounded-md"
            style={{
              background: activating
                ? "var(--color-on-dark-critical-overlay)"
                : "var(--color-on-dark-success-overlay)",
              color: "var(--color-on-dark-strong)"
            }}
            aria-hidden="true"
          >
            <ShieldCheck size={16} strokeWidth={1.75} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2
              id="cluster-killswitch-modal-title"
              className="m-0 font-heading text-[15px] font-semibold leading-[1.25]"
              style={{ color: "var(--color-on-dark-strong)", letterSpacing: "-0.01em" }}
            >
              {activating ? "Activar interruptor de corte" : "Rearmar interruptor"}
            </h2>
            <span
              className="font-sans text-[11.5px] leading-[1.4]"
              style={{ color: "var(--color-on-dark-medium)" }}
            >
              {activating
                ? "Bloqueará el pipeline de envío. Acción reversible y auditada."
                : "Restaurará el pipeline. Audit event escrito."}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="grid size-7 shrink-0 place-items-center rounded transition-colors hover:bg-[var(--color-on-dark-hint)] disabled:cursor-not-allowed"
            style={{ color: "var(--color-on-dark-medium)" }}
            aria-label="Cancelar"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {activating ? (
            <label className="flex flex-col gap-1.5">
              <span
                className="font-mono text-[10px] font-semibold uppercase"
                style={{ color: "var(--color-on-dark-medium)", letterSpacing: "0.14em" }}
              >
                Razón <span style={{ color: "var(--color-critical)" }}>*</span>
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ej: pico de quejas detectado en clúster A; dry-run no resolvió."
                rows={3}
                disabled={isPending}
                className="w-full rounded-md px-3 py-2 font-sans text-[12.5px] leading-[1.45] outline-none transition-colors focus:border-white/40"
                style={{
                  background: "var(--color-always-dark-bg)",
                  border: "1px solid var(--color-always-dark-border)",
                  color: "var(--color-on-dark-strong)",
                  resize: "vertical",
                  minHeight: 72
                }}
              />
              {!reasonValid && reason.length > 0 ? (
                <span className="font-sans text-[11px]" style={{ color: "var(--color-critical)" }}>
                  Mínimo 4 caracteres.
                </span>
              ) : null}
            </label>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span
              className="font-mono text-[10px] font-semibold uppercase"
              style={{ color: "var(--color-on-dark-medium)", letterSpacing: "0.14em" }}
            >
              Operador (1 firma + audit chain) <span style={{ color: "var(--color-critical)" }}>*</span>
            </span>
            <input
              type="text"
              value={actorId}
              onChange={(e) => setActorId(e.target.value)}
              placeholder="op-juanes-a / op-mariana-b"
              disabled={isPending}
              autoFocus
              className="w-full rounded-md px-3 py-2 font-mono text-[12.5px] outline-none transition-colors focus:border-white/40"
              style={{
                background: "var(--color-always-dark-bg)",
                border: "1px solid var(--color-always-dark-border)",
                color: "var(--color-on-dark-strong)"
              }}
            />
            <span
              className="font-sans text-[10.5px]"
              style={{ color: "var(--color-on-dark-soft)" }}
            >
              ID del operador que ejecuta. Audit chain registra quién hizo qué.
            </span>
          </label>
        </div>

        <footer
          className="flex shrink-0 items-center justify-end gap-2 p-4"
          style={{
            background: "var(--color-always-dark-bg)",
            borderTop: "1px solid var(--color-always-dark-border)"
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex items-center rounded-md px-3.5 py-2 font-sans text-[12.5px] font-semibold transition-colors hover:bg-[var(--color-on-dark-hint)] disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              background: "transparent",
              color: "var(--color-on-dark-medium)",
              border: "1px solid var(--color-always-dark-border)"
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-md px-3.5 py-2 font-sans text-[12.5px] font-semibold transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              background: activating ? "var(--color-critical)" : "var(--color-success)",
              color: "var(--color-on-dark-strong)",
              border: "none",
              cursor: canSubmit ? "pointer" : "not-allowed"
            }}
          >
            <Power size={12} strokeWidth={1.75} />
            {isPending
              ? "Procesando…"
              : activating
              ? "Confirmar activación"
              : "Confirmar rearmado"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ============================================================
 * Footer — molde Card
 * ============================================================ */

function FooterBar() {
  return (
    <Card style={{ padding: "12px 16px" }} className="flex flex-wrap items-center justify-between gap-3">
      <a
        href="https://docs.delivrix.dev/runbooks/clusters"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2"
        style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}
      >
        <BookOpen size={13} strokeWidth={1.75} />
        Runbook · clústeres y kill switch
      </a>
      <span style={{ ...MONO, fontSize: 11, color: "var(--color-text-tertiary)" }}>
        GET /v1/admin/clusters · POST /v1/kill-switch
      </span>
    </Card>
  );
}

/* ============================================================
 * Helpers
 * ============================================================ */

type ClusterStatus = "active" | "warmup" | "paused" | "error";

function inferClusterStatus(c: ClusterT): ClusterStatus {
  const ms = (c.managementState || "").toLowerCase();
  if (ms.includes("error") || ms.includes("blocked") || ms.includes("critical")) return "error";
  const nodes = c.senderNodes ?? [];
  if (nodes.length === 0) return "paused";
  const statuses = nodes.map((n) => n.status.toLowerCase());
  if (statuses.some((s) => s.includes("warming"))) return "warmup";
  if (statuses.every((s) => s.includes("paused") || s.includes("standby"))) return "paused";
  if (statuses.some((s) => s.includes("active") || s.includes("ready"))) return "active";
  return "paused";
}

/** Mapea el status real del nodo al enum que reconoce StateBadge del molde. */
function normalizeNodeStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("active") || s.includes("ready")) return "active";
  if (s.includes("warming")) return "warming";
  if (s.includes("quarantin")) return "quarantined";
  if (s.includes("degrad")) return "degraded";
  if (s.includes("paused") || s.includes("standby")) return "paused";
  if (s.includes("retired")) return "retired";
  return raw;
}

function statusDot(raw: string): string {
  const s = normalizeNodeStatus(raw);
  switch (s) {
    case "active":
      return "var(--color-success)";
    case "warming":
      return "var(--color-warming)";
    case "quarantined":
      return "var(--color-critical)";
    case "degraded":
    case "paused":
      return "var(--color-warning)";
    default:
      return "var(--color-text-tertiary)";
  }
}
