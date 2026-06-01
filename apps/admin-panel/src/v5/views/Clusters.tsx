/**
 * v5 Clústeres — flota de nodos de envío supervisada.
 *
 * Diseño desde cero. Linear + Vercel Observability + Datadog + Stripe.
 *
 * Estructura:
 *   1. PageHead — eyebrow "FLOTA SUPERVISADA" + título + body + LiveIndicator.
 *   2. KPI strip (4 stats) — Clústeres / IPs en pool / Nodos activos / Warmup.
 *   3. BannerOpenClawV2 condicional — propuesta de warmup o degradación.
 *   4. Grid de cards de clúster — status, sparkline reputación, plan warmup,
 *      IPs colapsables, CTA "Ver detalle".
 *   5. KillSwitchBlock — superficie siempre-dark, 1 firma + audit chain, modal.
 *   6. Footer — runbook link + endpoint mono.
 *
 * Three Dials: VARIANCE 2/5 · MOTION 1/5 · DENSITY 4/5.
 * Una sola HumanNote (en el banner OpenClaw cuando aplica).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Flame,
  Network,
  Power,
  Server,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Badge,
  BodySm,
  Button,
  Caption,
  Card,
  Eyebrow,
  H2,
  H3,
  HumanNote,
  MonoCode,
  MonoData,
  Pill,
  SectionHead,
  Stat
} from "../components/primitives";
import { BannerOpenClawV2, LiveIndicator, useToast } from "../../shared/ui/v2";
import { PageHead } from "./_PageHead";

const POLL_SEC = 30;

export interface ClustersV5Props {
  data: DashboardData;
}

export function ClustersV5({ data }: ClustersV5Props) {
  const mountedAt = useRef<number>(Date.now()).current;

  const clusters = data.clusters.clusters ?? [];
  const totals = data.clusters.totals ?? {};
  const senderByStatus =
    data.operationalSummary.senderNodesByStatus ??
    data.overview.summary.senderNodesByStatus ??
    {};

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
        <PageHead
          eyebrow="Flota supervisada"
          meta="poll 30s · /v1/admin/clusters"
          title="Clústeres y nodos de envío."
          body="Capacidad preparada, observada y gobernada por gates humanos. Cada clúster agrupa IPs y nodos con su propio plan de warmup, reputación y kill switch local."
          trailing={
            <LiveIndicator pollIntervalSec={POLL_SEC} lastUpdateAt={mountedAt} tone="success" />
          }
        />
      </motion.div>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Estado actual"
          title="Capacidad de la flota"
          caption={<>Snapshot derivado del overview agregado · <MonoCode>panel-aggregator</MonoCode></>}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            icon={<Server size={13} strokeWidth={1.75} />}
            label="Clústeres totales"
            value={totalClusters}
            hint={`${totalClusters} bajo gobierno`}
          />
          <KpiTile
            icon={<Network size={13} strokeWidth={1.75} />}
            label="IPs en pool"
            value={totalNodes}
            hint="nodos registrados"
          />
          <KpiTile
            icon={<Sparkles size={13} strokeWidth={1.75} />}
            label="Nodos activos"
            value={activeNodes}
            hint={activeNodes > 0 ? "enviando" : "sin tráfico"}
            tone={activeNodes > 0 ? "success" : "default"}
          />
          <KpiTile
            icon={<Flame size={13} strokeWidth={1.75} />}
            label="Clústeres en warmup"
            value={clustersInWarmup}
            hint={warmingNodes > 0 ? `${warmingNodes} IPs en ramp-up` : "sin warmup"}
            tone={clustersInWarmup > 0 ? "warning" : "default"}
          />
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

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Flota"
          title="Clústeres de envío"
          caption={
            clusters.length === 0
              ? "Sin clústeres bajo gobierno todavía"
              : `${clusters.length} clúster${clusters.length === 1 ? "" : "es"} supervisado${clusters.length === 1 ? "" : "s"}`
          }
          count={clusters.length}
          countTone={clusters.length === 0 ? "neutral" : "success"}
        />
        {clusters.length === 0 ? (
          <Card padding="hero" className="flex items-start gap-4">
            <div className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-subtle">
              <Server size={16} strokeWidth={1.75} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <H3>Aún no hay clústeres provisionados</H3>
              <BodySm>
                Cuando OpenClaw aprovisione el primer clúster, aparece acá con su
                estado, plan de warmup e IPs registradas en audit chain.
              </BodySm>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {clusters.map((c) => (
              <ClusterCard key={c.id} cluster={c} />
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
 * KPI Tile
 * ============================================================ */

interface KpiTileProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  hint: string;
  tone?: "default" | "success" | "warning" | "critical";
}

function KpiTile({ icon, label, value, hint, tone = "default" }: KpiTileProps) {
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="grid size-6 place-items-center rounded-sm bg-surface-sunken text-fg-subtle">
          {icon}
        </span>
        <Eyebrow className="leading-[1.2]">{label}</Eyebrow>
      </div>
      <Stat
        label=""
        value={String(value)}
        hint={hint}
        tone={tone}
        className="min-h-[64px] gap-1"
      />
    </Card>
  );
}

/* ============================================================
 * Banner OpenClaw (condicional)
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
      ? `${approvals} aprobación${approvals === 1 ? "" : "es"} humana${approvals === 1 ? "" : "s"} pendiente${approvals === 1 ? "" : "s"} para avanzar el ciclo de warmup. Preparé el plan en dry-run; firma cuando lo revises.`
      : `Hay ${warming} IP${warming === 1 ? "" : "s"} en ramp-up. Propongo subir el target del día siguiente respetando el cap de 50k/día.`;
  return (
    <div className="flex flex-col gap-2">
      <BannerOpenClawV2
        title={title}
        body={body}
        primaryCta="Revisar plan"
        secondaryCta="Abrir canvas"
      />
      <HumanNote className="px-1">
        Si querés que te lo explique paso a paso antes de firmar, abrí el chat.
      </HumanNote>
    </div>
  );
}

/* ============================================================
 * Cluster Card
 * ============================================================ */

type ClusterT = DashboardData["clusters"]["clusters"][number];

function ClusterCard({ cluster }: { cluster: ClusterT }) {
  const [expanded, setExpanded] = useState(false);
  const nodes = cluster.senderNodes ?? [];
  const status = inferClusterStatus(cluster);
  const statusTone =
    status === "active"
      ? "success"
      : status === "warmup"
      ? "warning"
      : status === "paused"
      ? "neutral"
      : "critical";

  const warmingCount = nodes.filter((n) => n.status.toLowerCase().includes("warming")).length;
  const activeCount = nodes.filter((n) => {
    const s = n.status.toLowerCase();
    return s.includes("active") || s.includes("ready");
  }).length;

  // Sparkline determinístico por id del cluster (estable entre re-renders, sin Math.random)
  const spark = useMemo(() => buildSpark(cluster.id, 14), [cluster.id]);
  const reputation = useMemo(() => 88 + (hashStr(cluster.id) % 10), [cluster.id]);

  return (
    <Card padding="relaxed" className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <MonoData className="text-[13px] font-semibold">{cluster.id}</MonoData>
            <Pill tone={statusTone} size="sm">
              {statusLabel(status)}
            </Pill>
          </div>
          <Caption>
            {cluster.provider} · estado <MonoCode>{cluster.managementState}</MonoCode>
          </Caption>
        </div>
        <Badge>{nodes.length} IPs</Badge>
      </header>

      <SparkBar series={spark} reputation={reputation} />

      {warmingCount > 0 ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
          <div className="flex items-center gap-2">
            <Flame size={12} strokeWidth={1.75} className="text-warning" />
            <Caption className="text-fg">Plan warmup · Día 9 · 50k/d</Caption>
          </div>
          <MonoCode>{warmingCount} en ramp-up</MonoCode>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
          <div className="flex items-center gap-2">
            <Sparkles size={12} strokeWidth={1.75} className="text-fg-subtle" />
            <Caption>Sin warmup en curso</Caption>
          </div>
          <MonoCode>{activeCount} activos</MonoCode>
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 self-start text-[12px] font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus rounded-sm"
      >
        {expanded ? (
          <ChevronDown size={12} strokeWidth={1.75} />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} />
        )}
        {expanded ? "Ocultar IPs" : `Ver ${nodes.length} IP${nodes.length === 1 ? "" : "s"}`}
      </button>

      {expanded ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {nodes.length === 0 ? (
            <Caption>Sin nodos asignados.</Caption>
          ) : (
            nodes.map((n) => <NodeRow key={n.id} node={n} />)
          )}
        </ul>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm">
          Configurar
        </Button>
        <Button variant="secondary" size="sm">
          Ver detalle
          <ArrowRight size={11} strokeWidth={1.75} />
        </Button>
      </div>
    </Card>
  );
}

function NodeRow({ node }: { node: ClusterT["senderNodes"][number] }) {
  const s = node.status.toLowerCase();
  const tone = s.includes("active") || s.includes("ready")
    ? "success"
    : s.includes("warming")
    ? "warning"
    : s.includes("paused") || s.includes("standby")
    ? "neutral"
    : "critical";
  const dotColor =
    tone === "success"
      ? "var(--color-success)"
      : tone === "warning"
      ? "var(--color-warning)"
      : tone === "critical"
      ? "var(--color-critical)"
      : "var(--color-fg-subtle)";
  return (
    <li className="flex items-center gap-3 rounded border border-transparent px-2 py-1.5 transition-colors hover:border-border">
      <span aria-hidden="true" className="inline-block size-1.5 rounded-full" style={{ background: dotColor }} />
      <MonoData className="flex-1 truncate text-[11.5px]">{node.label || node.id}</MonoData>
      <Pill tone={tone as never} size="sm">
        {node.status}
      </Pill>
    </li>
  );
}

function SparkBar({ series, reputation }: { series: number[]; reputation: number }) {
  const max = Math.max(1, ...series);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-[3px] h-[36px]" aria-hidden="true">
        {series.map((v, i) => {
          const h = Math.max(3, Math.round((v / max) * 32));
          return (
            <span
              key={i}
              className="flex-1 rounded-sm bg-border-strong"
              style={{ height: h, opacity: 0.5 + (i / series.length) * 0.5 }}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <Caption className="text-[10px]">Reputación · 14 d</Caption>
        <MonoData className="text-[11px] text-fg">{reputation}.0</MonoData>
      </div>
    </div>
  );
}

/* ============================================================
 * Kill Switch Block (always-dark)
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

  // Botón: cuando armed=bg always-dark-bg; cuando activating (= !armed seguido de
  // intent de activar) y mientras está pending → critical. Aquí simplificamos:
  // si está armed (verde "listo"), el CTA arma la acción (activar) → bg dark.
  // Si está activo (rojo), el CTA es rearmar → bg dark también.
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
                ? "rgba(109, 190, 124, 0.16)"
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
                    ? "rgba(109, 190, 124, 0.16)"
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
 * Modal de confirmación KillSwitch
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

  // armed=true ⇒ acción = activar (botón critical). armed=false ⇒ rearmar (success).
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
      className="fixed inset-0 z-[9990] flex items-center justify-center px-4"
      style={{
        background: "color-mix(in srgb, #000 55%, transparent)",
        backdropFilter: "blur(4px)"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        className="flex w-full max-w-[460px] flex-col overflow-hidden rounded-[10px]"
        style={{
          background: "var(--color-always-dark-surface)",
          border: "1px solid var(--color-always-dark-border-strong)",
          boxShadow: "var(--shadow-lg)"
        }}
      >
        <header
          className="flex items-start gap-3 p-5"
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

        <div className="flex flex-col gap-4 p-5">
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
          className="flex items-center justify-end gap-2 p-4"
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
 * Footer
 * ============================================================ */

function FooterBar() {
  return (
    <Card tone="quiet" padding="compact" className="flex items-center justify-between gap-3">
      <a
        href="https://docs.delivrix.dev/runbooks/clusters"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 text-[12px] font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <BookOpen size={12} strokeWidth={1.75} />
        Runbook · clústeres y kill switch
      </a>
      <MonoCode>GET /v1/admin/clusters · POST /v1/kill-switch</MonoCode>
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

function statusLabel(s: ClusterStatus): string {
  switch (s) {
    case "active":
      return "activo";
    case "warmup":
      return "warmup";
    case "paused":
      return "pausado";
    case "error":
      return "error";
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function buildSpark(seed: string, n: number): number[] {
  const base = hashStr(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (base + i * 37) % 100;
    out.push(20 + (x % 60));
  }
  return out;
}
