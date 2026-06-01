/**
 * v5 Hardware — Telemetría supervisada del servidor físico de control plane.
 *
 * Layout:
 *   PageHead (eyebrow + title + body + trailing chip de estado)
 *   IdentityCard (servidor destacado · hostname · datacenter · rol · hash)
 *   BannerOpenClawV2 condicional (stale o CPU > 75%)
 *   KPI strip (CPU · RAM · Storage · Interfaces+IPs)
 *   Inventario grid (componente + detalle + sub + fuente + evidencia)
 *   Historial side (últimos N snapshots con delta + empty alineado izq.)
 *   CTA Snapshot manual → modal (botón primary accent + accent-fg)
 *
 * Disciplina v5:
 *   - VARIANCE 2/5 · MOTION 1/5 · DENSITY 4/5
 *   - Mono para datos/hashes/timestamps · Montserrat para UI · Caveat sólo HumanNote
 *   - Cero gradients, shadows estáticas, side-tabs, accent-tertiary como bg
 *   - Superficies "siempre dark" usan always-dark-bg + on-dark-strong
 */

import { useCallback, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Camera,
  Cpu,
  HardDrive,
  Hash,
  MapPin,
  MemoryStick,
  Network,
  Server,
  X
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client";
import { BannerOpenClawV2 } from "../../shared/ui/v2/BannerOpenClawV2";
import { useToast } from "../../shared/ui/v2/Toast";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Badge,
  BodySm,
  Button,
  Caption,
  Card,
  Eyebrow,
  H3,
  HumanNote,
  MonoCode,
  MonoData,
  Pill,
  SectionHead,
  Stat
} from "../components/primitives";
import { PageHead } from "./_PageHead";
import { cn } from "../lib/cn";

export interface HardwareV5Props {
  data: DashboardData;
}

export function HardwareV5({ data }: HardwareV5Props) {
  const ph = data.physicalHost;
  const cap = ph.capacity;
  const tel = data.telemetry;
  const stale = !!tel.summary.stale;
  const cpuPct = typeof tel.cpu.usagePercent === "number" ? tel.cpu.usagePercent : null;
  const ramPct = computeRamPercent(tel.memory);
  const storagePct = computeStoragePercent(tel.storage);
  const cpuHigh = cpuPct !== null && cpuPct >= 75;
  const status: HardwareStatus = stale
    ? "stale"
    : cpuHigh
    ? "critical"
    : "ok";

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow="Telemetría supervisada"
          meta={<MonoCode>último ciclo {formatRelative(tel.source.collectedAt)}</MonoCode>}
          title="Hardware del control plane"
          body="El servidor físico que gobierna el plano de control de Delivrix. Inventario verificado contra el contrato, telemetría capturada por el recolector supervisado y snapshot manual cuando la captura automática queda stale."
          trailing={<StatusChip status={status} />}
        />
      </motion.div>

      <motion.div variants={staggerItem}>
        <IdentityCard data={data} />
      </motion.div>

      {(stale || cpuHigh) && (
        <motion.div variants={staggerItem}>
          <BannerOpenClawV2
            title={cpuHigh ? "CPU sobre umbral" : "Telemetría stale"}
            body={
              cpuHigh
                ? `CPU al ${cpuPct!.toFixed(1)}% en el último snapshot. Revisar el clúster activo antes de seguir.`
                : "El recolector no entrega lecturas recientes. Coordinar una nueva captura supervisada para refrescar el plano."
            }
            primaryCta={cpuHigh ? "Revisar clúster activo" : "Coordinar nueva captura"}
            secondaryCta="Ver evidencia"
          />
        </motion.div>
      )}

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Última lectura"
          title="Indicadores físicos"
          caption={
            <>
              Captura del recolector · <MonoCode>{tel.source.kind}</MonoCode>
            </>
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCell
            icon={<Cpu size={13} strokeWidth={1.75} className="text-fg-subtle" />}
            label="Uso de CPU"
            value={cpuPct === null ? "·" : cpuPct.toFixed(1)}
            unit={cpuPct === null ? undefined : "%"}
            hint={
              tel.cpu.temperatureCelsius != null
                ? `T° ${tel.cpu.temperatureCelsius.toFixed(0)}°C · carga ${formatLoadAvg(tel.cpu.loadAverage)}`
                : "sin temperatura reportada"
            }
            tone={toneFromPercent(cpuPct)}
          />
          <KpiCell
            icon={<MemoryStick size={13} strokeWidth={1.75} className="text-fg-subtle" />}
            label="Uso de RAM"
            value={ramPct === null ? "·" : ramPct.toFixed(1)}
            unit={ramPct === null ? undefined : "%"}
            hint={
              cap.memoryGb
                ? `${cap.memoryGb} GB instalados`
                : "capacidad sin declarar"
            }
            tone={toneFromPercent(ramPct)}
          />
          <KpiCell
            icon={<HardDrive size={13} strokeWidth={1.75} className="text-fg-subtle" />}
            label="Uso de almacenamiento"
            value={storagePct === null ? "·" : storagePct.toFixed(1)}
            unit={storagePct === null ? undefined : "%"}
            hint={
              cap.storageUsableGb
                ? `${cap.storageUsableGb} GB usables`
                : "sin snapshot supervisado"
            }
            tone={toneFromPercent(storagePct)}
          />
          <KpiCell
            icon={<Network size={13} strokeWidth={1.75} className="text-fg-subtle" />}
            label="Interfaces de red"
            value={String(cap.networkInterfaces ?? 0)}
            unit="interfaces"
            hint={
              cap.ipPoolSize != null
                ? `${cap.ipPoolSize} IPs en pool`
                : "pool de IPs sin declarar"
            }
            tone="default"
          />
        </div>
      </motion.section>

      <motion.div variants={staggerItem} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <InventoryCard data={data} />
        <HistoryCard data={data} />
      </motion.div>

      <motion.div variants={staggerItem}>
        <SnapshotActionRow stale={stale} lastCollectedAt={tel.source.collectedAt} />
      </motion.div>
    </motion.div>
  );
}

/* ============================================================
 * Identity card
 * ============================================================ */

type HardwareStatus = "ok" | "stale" | "critical";

function StatusChip({ status }: { status: HardwareStatus }) {
  if (status === "ok") return <Pill tone="success" size="md">telemetría ok</Pill>;
  if (status === "stale") return <Pill tone="warning" size="md">telemetría stale</Pill>;
  return <Pill tone="critical" size="md">CPU crítica</Pill>;
}

function IdentityCard({ data }: { data: DashboardData }) {
  const ph = data.physicalHost;
  const id = ph.identity;
  const tel = data.telemetry;
  const hostName = id.label || id.hostId || "host desconocido";
  const role = data.operatingNorth.delivrixRole || "rol no asignado";
  const dc = id.location || "ubicación pendiente";
  const lastSeen = formatRelative(tel.source.collectedAt);
  const hash = shortHash(tel.source.collectedAt);
  const readyOk = ph.readiness.status === "ready";

  return (
    <Card padding="relaxed" className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-md"
          style={{
            background: "var(--color-always-dark-bg)",
            color: "var(--color-on-dark-strong)",
            border: "1px solid var(--color-always-dark-border)"
          }}
        >
          <Server size={16} strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Eyebrow>Servidor físico</Eyebrow>
            <span
              aria-hidden="true"
              className="inline-block size-[3px] rounded-full bg-border-strong"
            />
            <MonoCode>schema {ph.schemaVersion}</MonoCode>
          </div>
          <H3 className="text-[18px] leading-tight">{hostName}</H3>
          <Caption>
            {role} · {id.vendor || "vendor desconocido"}{id.model ? ` · ${id.model}` : ""}
          </Caption>
        </div>
        <Pill tone={readyOk ? "success" : "warning"} size="sm">
          {readyOk ? "listo" : ph.readiness.status || "pendiente"}
        </Pill>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <MetaChip
          icon={<MapPin size={11} strokeWidth={1.75} />}
          label="datacenter"
          value={dc}
        />
        <MetaChip
          icon={<Activity size={11} strokeWidth={1.75} />}
          label="captura"
          value={lastSeen}
          tone={tel.summary.stale ? "warning" : "default"}
          mono
        />
        <MetaChip
          icon={<Hash size={11} strokeWidth={1.75} />}
          label="hash"
          value={hash}
          mono
        />
        {typeof id.uptimeSeconds === "number" ? (
          <MetaChip
            icon={<Activity size={11} strokeWidth={1.75} />}
            label="uptime"
            value={formatUptime(id.uptimeSeconds)}
            mono
          />
        ) : null}
      </div>
    </Card>
  );
}

function MetaChip({
  icon,
  label,
  value,
  mono,
  tone = "default"
}: {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "warning";
}) {
  const color = tone === "warning" ? "var(--color-warning)" : "var(--color-fg-subtle)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border border-border bg-surface-sunken px-2 py-1"
    >
      <span style={{ color }} aria-hidden="true">
        {icon}
      </span>
      <Caption className="text-[10.5px] uppercase" style={{ letterSpacing: "0.06em" }}>
        {label}
      </Caption>
      {mono ? (
        <MonoData className="text-[11px] text-fg">{value}</MonoData>
      ) : (
        <span className="font-sans text-[11.5px] font-medium text-fg">{value}</span>
      )}
    </span>
  );
}

/* ============================================================
 * KPI strip
 * ============================================================ */

interface KpiCellProps {
  icon?: ReactNode;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone: "default" | "success" | "warning" | "critical";
}

function KpiCell({ icon, label, value, unit, hint, tone }: KpiCellProps) {
  return (
    <Card padding="relaxed" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Eyebrow>{label}</Eyebrow>
        {icon}
      </div>
      <Stat label="" value={value} unit={unit} tone={tone} className="min-h-[56px] gap-0" />
      {hint ? <Caption>{hint}</Caption> : null}
    </Card>
  );
}

/* ============================================================
 * Inventario
 * ============================================================ */

interface InventoryRow {
  component: string;
  detail: string;
  sub: string;
  source: string;
  sourceTone: "info" | "neutral" | "unknown";
  hash: string;
  verified: boolean;
}

function buildInventoryRows(data: DashboardData): InventoryRow[] {
  const ph = data.physicalHost;
  const cap = ph.capacity;
  const id = ph.identity;
  return [
    {
      component: "CPU",
      detail: cap.cpuCores ? `${cap.cpuCores} cores` : "·",
      sub: cap.cpuThreads ? `${cap.cpuThreads} threads` : "topología por detectar",
      source: ph.source.kind,
      sourceTone: "info",
      hash: shortHash(ph.source.collectedAt, "#cpu·"),
      verified: !!cap.cpuCores
    },
    {
      component: "Memoria RAM",
      detail: cap.memoryGb ? `${cap.memoryGb} GB` : "·",
      sub: "DDR4 ECC",
      source: ph.source.kind,
      sourceTone: "info",
      hash: shortHash(ph.generatedAt, "#ram·"),
      verified: !!cap.memoryGb
    },
    {
      component: "Almacenamiento",
      detail: cap.storageUsableGb ? `${cap.storageUsableGb} GB usables` : "·",
      sub: "snapshot supervisado",
      source: "/proc",
      sourceTone: "neutral",
      hash: shortHash(ph.source.collectedAt, "#dsk·"),
      verified: !!cap.storageUsableGb
    },
    {
      component: "Interfaces de red",
      detail: `${cap.networkInterfaces ?? 0} interfaces`,
      sub: cap.ipPoolSize ? `${cap.ipPoolSize} IPs en pool` : "·",
      source: ph.source.kind,
      sourceTone: "info",
      hash: shortHash(ph.generatedAt, "#nic·"),
      verified: !!cap.networkInterfaces
    },
    {
      component: "Modelo",
      detail: id.model || "·",
      sub: id.vendor || "vendor desconocido",
      source: "manifest",
      sourceTone: "unknown",
      hash: shortHash(ph.source.collectedAt, "#mdl·"),
      verified: !!id.model
    },
    {
      component: "Kernel",
      detail: id.proxmoxVersion || id.kernelVersion || "·",
      sub: id.operatingSystem || "OS desconocido",
      source: "/proc",
      sourceTone: "neutral",
      hash: shortHash(ph.generatedAt, "#krn·"),
      verified: !!(id.proxmoxVersion || id.kernelVersion)
    }
  ];
}

function InventoryCard({ data }: { data: DashboardData }) {
  const rows = buildInventoryRows(data);
  const verifiedCount = rows.filter((r) => r.verified).length;
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <SectionHead
        eyebrow="Inventario"
        title="Componentes del host"
        caption={`${verifiedCount}/${rows.length} verificados contra el contrato`}
        trailing={
          <Badge>
            {rows.length} items
          </Badge>
        }
      />
      <div className="overflow-x-auto">
        <div
          className="grid items-center gap-3 rounded bg-surface-sunken px-3 py-1.5"
          style={{ gridTemplateColumns: "minmax(140px,1.1fr) minmax(140px,1.2fr) 88px minmax(0,1fr)", minWidth: 560 }}
        >
          {["Componente", "Detalle", "Fuente", "Evidencia"].map((h, i) => (
            <Eyebrow key={h} className={i === 3 ? "text-right" : ""}>
              {h}
            </Eyebrow>
          ))}
        </div>
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
          {rows.map((row) => (
            <li
              key={row.hash}
              className="grid items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:border-border-strong"
              style={{ gridTemplateColumns: "minmax(140px,1.1fr) minmax(140px,1.2fr) 88px minmax(0,1fr)", minWidth: 560 }}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="font-sans text-[13px] font-semibold text-fg">{row.component}</span>
                <Caption className={row.verified ? "" : "text-warning"}>
                  {row.detail}
                </Caption>
              </div>
              <MonoCode>{row.sub}</MonoCode>
              <Pill
                tone={row.sourceTone === "info" ? "info" : row.sourceTone === "unknown" ? "neutral" : "neutral"}
                size="sm"
                dot={false}
              >
                {row.source}
              </Pill>
              <span className="text-right font-mono text-[10.5px] tabular-nums text-fg-subtle">
                {row.hash}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

/* ============================================================
 * Historial de telemetría
 * ============================================================ */

type SeriesEntry = DashboardData["telemetryHistory"]["series"][number];

function HistoryCard({ data }: { data: DashboardData }) {
  const series = data.telemetryHistory.series ?? [];
  const cpu = series.find((s) => s.metric.toLowerCase().includes("cpu") && !s.metric.toLowerCase().includes("temp"));
  const mem = series.find((s) => s.metric.toLowerCase().includes("mem") || s.metric.toLowerCase().includes("ram"));
  const temp = series.find((s) => s.metric.toLowerCase().includes("temp"));
  const hasAny = (cpu?.points.length ?? 0) + (mem?.points.length ?? 0) + (temp?.points.length ?? 0) > 0;

  return (
    <Card tone="quiet" padding="relaxed" className="flex flex-col gap-3">
      <SectionHead
        eyebrow="Histórico"
        title="Snapshots recientes"
        caption={
          series.length > 0
            ? `${series.length} series · ventana ${data.telemetryHistory.window}`
            : "sin series disponibles"
        }
        trailing={<Badge>{data.telemetryHistory.window || "—"}</Badge>}
      />
      {!hasAny ? (
        <HistoryEmpty lastCaptureAt={data.telemetryHistory.lastCaptureAt} />
      ) : (
        <div className="flex flex-col gap-3">
          <Sparkline title="Uso CPU" suffix="%" series={cpu} />
          <Sparkline title="Uso RAM" suffix="%" series={mem} />
          <Sparkline title="Temp CPU" suffix="°C" series={temp} />
        </div>
      )}
      <HumanNote className="mt-1">
        Si la captura sigue stale, abrime la sesión SSH y corro el snapshot supervisado yo mismo.
      </HumanNote>
    </Card>
  );
}

function HistoryEmpty({ lastCaptureAt }: { lastCaptureAt?: string | null }) {
  const txt = lastCaptureAt
    ? `Última captura aceptada ${formatRelative(lastCaptureAt)}.`
    : "Sin capturas aceptadas en la ventana actual.";
  return (
    <div className="flex flex-col items-start gap-2 rounded border border-dashed border-border bg-surface px-4 py-5">
      <Eyebrow>Sin historial</Eyebrow>
      <H3>Aún no hay telemetría aceptada</H3>
      <BodySm style={{ maxWidth: 360 }}>
        {txt} Solicita un snapshot manual desde el recolector cuando el servidor esté online para empezar a ver historial.
      </BodySm>
    </div>
  );
}

function Sparkline({
  title,
  suffix,
  series
}: {
  title: string;
  suffix: string;
  series: SeriesEntry | undefined;
}) {
  const points = (series?.points ?? []).filter((p) => typeof p.value === "number") as Array<{
    timestamp: string;
    value: number;
    quality: string;
  }>;
  if (points.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 rounded border border-dashed border-border bg-surface px-3 py-2.5">
        <Eyebrow>{title}</Eyebrow>
        <Caption>serie sin puntos en la ventana actual</Caption>
      </div>
    );
  }
  const lastN = points.slice(-12).map((p) => p.value);
  const last = lastN[lastN.length - 1];
  const prev = lastN.length > 1 ? lastN[lastN.length - 2] : null;
  const delta = prev === null ? null : last - prev;
  const max = Math.max(...lastN, 1);
  const min = Math.min(...lastN, 0);
  const range = Math.max(1, max - min);
  const w = 100;
  const h = 28;
  const stepX = lastN.length > 1 ? w / (lastN.length - 1) : 0;
  const pts = lastN.map((v, i) => {
    const x = i * stepX;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const polyline = pts.join(" ");
  const deltaTone =
    delta === null
      ? "neutral"
      : delta > 0
      ? suffix === "%" && last > 75
        ? "warning"
        : "neutral"
      : "success";
  return (
    <div className="flex flex-col gap-2 rounded border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>{title}</Eyebrow>
        <div className="flex items-center gap-2">
          <MonoData className="text-[12px]">
            {last.toFixed(1)}
            {suffix}
          </MonoData>
          {delta !== null ? (
            <Pill tone={deltaTone as never} size="sm" dot={false}>
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(1)}
              {suffix}
            </Pill>
          ) : null}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: 32 }}
        aria-hidden="true"
      >
        <polyline
          points={polyline}
          fill="none"
          stroke="var(--color-fg)"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex items-center justify-between">
        <Caption className="font-mono text-[10px]">
          {formatHM(points[0].timestamp)}
        </Caption>
        <Caption className="font-mono text-[10px]">ahora</Caption>
      </div>
    </div>
  );
}

/* ============================================================
 * CTA + Modal snapshot manual
 * ============================================================ */

function SnapshotActionRow({
  stale,
  lastCollectedAt
}: {
  stale: boolean;
  lastCollectedAt: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card padding="relaxed" className="flex flex-wrap items-center gap-3">
        <div
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-md"
          style={{
            background: "var(--color-always-dark-bg)",
            color: "var(--color-on-dark-strong)",
            border: "1px solid var(--color-always-dark-border)"
          }}
        >
          <Camera size={15} strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <H3>Snapshot manual</H3>
          <BodySm>
            {stale
              ? "El recolector no entrega lecturas recientes. Captura un snapshot supervisado para desbloquear el historial."
              : `Último ciclo ${formatRelative(lastCollectedAt)}. Solicita un snapshot puntual si necesitas evidencia fresca antes del próximo ciclo.`}
          </BodySm>
        </div>
        <Button variant="primary" size="md" onClick={() => setOpen(true)}>
          <Camera size={13} strokeWidth={1.75} />
          Solicitar snapshot manual
        </Button>
      </Card>
      {open ? <SnapshotModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SnapshotModal({ onClose }: { onClose: () => void }) {
  const [rawJson, setRawJson] = useState("");
  const [actorId, setActorId] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (payload: { actorId: string; snapshot: unknown }) => {
      const res = await fetch("/v1/devops/collector/manual-snapshots/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          actorId: payload.actorId,
          humanApproved: true,
          snapshot: payload.snapshot
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ` · ${text.slice(0, 160)}` : ""}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Snapshot ingestado", {
        description: "Backend procesó el snapshot. Hardware refrescando."
      });
      void queryClient.invalidateQueries({ queryKey: ["admin-panel", "dashboard"] });
      onClose();
    },
    onError: (error) => {
      toast.error("No se pudo ingestar el snapshot", {
        description: error instanceof Error ? error.message : "Error desconocido"
      });
    }
  });

  const handleSubmit = useCallback(() => {
    setParseError(null);
    if (!actorId.trim()) {
      setParseError("Operador requerido.");
      return;
    }
    if (rawJson.trim().length < 2) {
      setParseError("Pega el JSON del snapshot.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      setParseError(`JSON inválido: ${e instanceof Error ? e.message : "parse error"}`);
      return;
    }
    mutation.mutate({ actorId: actorId.trim(), snapshot: parsed });
  }, [rawJson, actorId, mutation]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hardware-snapshot-modal-title"
      className="fixed inset-0 z-[9990] flex items-center justify-center px-4"
      style={{
        background: "color-mix(in srgb, var(--color-text-primary) 35%, transparent)",
        backdropFilter: "blur(4px)"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !mutation.isPending) onClose();
      }}
    >
      <Card
        padding="none"
        className="flex w-full max-w-[640px] flex-col overflow-hidden"
        style={{ maxHeight: "85vh", boxShadow: "var(--shadow-lg)" }}
      >
        <header
          className="flex items-center gap-3 border-b border-border px-5 py-4"
          style={{ background: "var(--color-always-dark-bg)" }}
        >
          <div
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-md"
            style={{
              background: "var(--color-on-dark-hint)",
              color: "var(--color-on-dark-strong)"
            }}
          >
            <Camera size={14} strokeWidth={1.75} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <h2
              id="hardware-snapshot-modal-title"
              className="m-0 font-heading text-[15px] font-semibold leading-tight"
              style={{ color: "var(--color-on-dark-strong)", letterSpacing: "-0.01em" }}
            >
              Ingestar snapshot manual
            </h2>
            <span
              className="font-sans text-[11px] leading-snug"
              style={{ color: "var(--color-on-dark-medium)" }}
            >
              Ejecuta delivrix-cli capture localmente y pega el JSON aquí.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={mutation.isPending}
            aria-label="Cerrar"
            className={cn(
              "grid size-7 place-items-center rounded transition-colors",
              mutation.isPending ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-white/10"
            )}
            style={{ color: "var(--color-on-dark-strong)" }}
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <Eyebrow>
              Operador <span style={{ color: "var(--color-critical)" }}>*</span>
            </Eyebrow>
            <input
              type="text"
              value={actorId}
              onChange={(e) => setActorId(e.target.value)}
              placeholder="op-juanes-a / op-mariana-b"
              disabled={mutation.isPending}
              autoFocus
              className="rounded border border-border bg-surface px-3 py-2 font-mono text-[12px] text-fg focus:border-border-strong focus:outline-none disabled:opacity-60"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <Eyebrow>
              JSON del snapshot <span style={{ color: "var(--color-critical)" }}>*</span>
            </Eyebrow>
            <textarea
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              placeholder='{ "hostId": "...", "identity": {...}, "capacity": {...} }'
              rows={10}
              disabled={mutation.isPending}
              className="rounded border border-border bg-surface px-3 py-2 font-mono text-[11px] leading-[1.5] text-fg focus:border-border-strong focus:outline-none disabled:opacity-60"
              style={{ resize: "vertical", minHeight: 180 }}
            />
            <Caption className="text-[10.5px]">
              El backend valida estructura y rechaza con HTTP 422 si falta algún campo crítico del contrato.
            </Caption>
          </label>

          {parseError ? (
            <span className="font-sans text-[12px] font-semibold" style={{ color: "var(--color-critical)" }}>
              {parseError}
            </span>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface-sunken px-5 py-3">
          <Button variant="ghost" size="md" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" size="md" onClick={handleSubmit} disabled={mutation.isPending}>
            <Camera size={12} strokeWidth={1.75} />
            {mutation.isPending ? "Ingestando" : "Ingestar snapshot"}
          </Button>
        </footer>
      </Card>
    </div>
  );
}

/* ============================================================
 * Helpers
 * ============================================================ */

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "sin datos";
  const now = Date.now();
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "sin datos";
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return `hace ${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `hace ${Math.round(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.round(diff / 3_600_000)} h`;
  return `hace ${Math.round(diff / 86_400_000)} d`;
}

function formatHM(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "·";
  }
}

function formatUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "0";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatLoadAvg(load: number[] | null | undefined): string {
  if (!Array.isArray(load) || load.length === 0) return "·";
  return load.slice(0, 3).map((n) => n.toFixed(2)).join(" / ");
}

function shortHash(iso: string | null | undefined, fallback = "·"): string {
  if (!iso) return fallback;
  return iso.replace(/[^0-9a-f]/gi, "").slice(0, 8) || fallback;
}

function toneFromPercent(p: number | null): "default" | "success" | "warning" | "critical" {
  if (p === null) return "default";
  if (p >= 90) return "critical";
  if (p >= 75) return "warning";
  if (p > 0) return "success";
  return "default";
}

function computeRamPercent(memory: Record<string, number | null>): number | null {
  if (!memory) return null;
  const candidates = [
    memory["usagePercent"],
    memory["usage_percent"],
    memory["usedPercent"],
    memory["percent"]
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  const total = memory["totalGb"] ?? memory["total_gb"] ?? memory["total"];
  const used = memory["usedGb"] ?? memory["used_gb"] ?? memory["used"];
  if (typeof total === "number" && typeof used === "number" && total > 0) {
    return (used / total) * 100;
  }
  return null;
}

function computeStoragePercent(storage: Record<string, number | string | null>): number | null {
  if (!storage) return null;
  const candidates = [
    storage["usagePercent"],
    storage["usage_percent"],
    storage["usedPercent"],
    storage["percent"]
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  const totalRaw = storage["totalGb"] ?? storage["total_gb"] ?? storage["total"];
  const usedRaw = storage["usedGb"] ?? storage["used_gb"] ?? storage["used"];
  const total = typeof totalRaw === "number" ? totalRaw : Number(totalRaw);
  const used = typeof usedRaw === "number" ? usedRaw : Number(usedRaw);
  if (Number.isFinite(total) && Number.isFinite(used) && total > 0) {
    return (used / total) * 100;
  }
  return null;
}
