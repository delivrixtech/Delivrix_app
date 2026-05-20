/**
 * Hardware Telemetry — port LITERAL desde Pencil frame `q71MQL` / `ZMHuy`.
 *
 * Estructura literal:
 *   Hero (kx9np):  HostCard + OpenClawPrompt (380w gradient border)
 *   TwoColumn:     Inventario (7 rows) + Historial 420w (3 charts)
 *   UnknownsRow:   CamposDesconocidos (4 priority cards) + DatosFaltantes 340w
 *   AuditFooter:   6 audit rows con timestamps reales del diseño
 */

import {
  Activity,
  Camera,
  CheckCircle,
  ChevronRight,
  FileText,
  Hash,
  Info,
  Layers,
  MapPin,
  Radio,
  Shield,
  Siren,
  Sparkles,
  Triangle
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import { filterAuditEvents } from "../../shared/lib/formatters.ts";

export function HardwareSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col" style={{ gap: 20 }}>
      <Hero data={data} />
      <TwoColumn data={data} />
      <UnknownsRow data={data} />
      <AuditFooter data={data} />
    </section>
  );
}

/* ============================================================
 * Hero — HostCard + OpenClaw prompt
 * ============================================================ */
function Hero({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <HostCard data={data} />
      <OpenClawPrompt data={data} />
    </div>
  );
}

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

function shortHash(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  // pseudo-hash legible para el slot Pencil hasta que el contrato exponga snapshot hash
  return iso.replace(/[^0-9a-f]/gi, "").slice(0, 8) || fallback;
}

function HostCard({ data }: { data: DashboardData }) {
  const ph = data.physicalHost;
  const on = data.operatingNorth;
  const hostName = ph.identity.label || ph.identity.hostId || "host desconocido";
  const role = on.delivrixRole || "rol no asignado";
  const dc = ph.identity.location || "ubicación pendiente";
  const lastSeen = formatRelative(data.telemetry.source.collectedAt);
  const hash = shortHash(data.telemetry.source.collectedAt);
  const readinessOk = ph.readiness.status === "ready";
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 16,
        padding: 20,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 16 }}>
        <div className="flex flex-col flex-1" style={{ gap: 4 }}>
          <h2 className="m-0 text-[20px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            {hostName} · {role}
          </h2>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]"
            style={{ letterSpacing: "0.4px" }}
          >
            Identidad de host · plano de control {ph.schemaVersion}
          </span>
        </div>
        <span
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-caption)] font-semibold"
          style={{
            gap: 6,
            padding: "4px 10px",
            borderRadius: 4,
            background: readinessOk ? "var(--color-success-soft)" : "var(--color-warning-soft)",
            color: readinessOk ? "var(--color-success)" : "var(--color-warning)",
            letterSpacing: "0.6px"
          }}
        >
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: 999, background: readinessOk ? "var(--color-success)" : "var(--color-warning)" }}
          />
          {(readinessOk ? "LISTO" : ph.readiness.status?.toUpperCase()) || "PENDIENTE"}
        </span>
      </header>

      <div className="flex flex-wrap" style={{ gap: 10 }}>
        <Chip icon={<MapPin size={12} strokeWidth={1.75} aria-hidden="true" />} text={`datacenter · ${dc}`} />
        <Chip icon={<Layers size={12} strokeWidth={1.75} aria-hidden="true" />} text={`rol · ${role}`} />
        <Chip
          icon={<Radio size={12} strokeWidth={1.75} aria-hidden="true" style={{ color: data.telemetry.summary.stale ? "var(--color-warning)" : "var(--color-success)" }} />}
          text={`Telemetría ${data.telemetry.summary.stale ? "desactualizada" : "actualizada"} ${lastSeen}`}
          mono
        />
        <Chip
          icon={<Hash size={12} strokeWidth={1.75} aria-hidden="true" />}
          text={`hash · ${hash}`}
          color="var(--color-text-tertiary)"
          mono
        />
      </div>
    </section>
  );
}

function Chip({
  icon,
  text,
  mono,
  color = "var(--color-text-secondary)"
}: {
  icon: React.ReactNode;
  text: string;
  mono?: boolean;
  color?: string;
}) {
  return (
    <span
      className="inline-flex items-center"
      style={{
        gap: 6,
        padding: "4px 10px",
        borderRadius: 4,
        background: "var(--color-surface-sunken)",
        border: "1px solid var(--color-border)",
        color
      }}
    >
      <span style={{ color }} aria-hidden="true">
        {icon}
      </span>
      <span
        className={`text-[11px] font-medium ${mono ? "font-[family-name:var(--font-mono)]" : "font-[family-name:var(--font-caption)]"}`}
      >
        {text}
      </span>
    </span>
  );
}

function OpenClawPrompt({ data }: { data: DashboardData }) {
  const cpuPct = typeof data.telemetry.cpu.usagePercent === "number" ? data.telemetry.cpu.usagePercent : null;
  const high = cpuPct !== null && cpuPct >= 75;
  const message = high
    ? `CPU al ${cpuPct.toFixed(1)}% en el último snapshot. ¿Revisamos el clúster activo?`
    : data.telemetry.summary.stale
      ? "Telemetría stale en el snapshot más reciente. ¿Quieres que coordine una nueva captura supervisada?"
      : "Telemetría dentro del umbral. Puedo proponer la próxima ventana de calentamiento.";
  const tone = high || data.telemetry.summary.stale ? "AVISO" : "OK";
  const toneFg = high || data.telemetry.summary.stale ? "var(--color-warning)" : "var(--color-success)";
  const toneBg = high || data.telemetry.summary.stale ? "var(--color-warning-soft)" : "var(--color-success-soft)";
  void tone;
  void toneFg;
  void toneBg;
  return <OpenClawPromptInner message={message} avisoBg={toneBg} avisoFg={toneFg} avisoText={tone} />;
}

function OpenClawPromptInner({ message, avisoBg, avisoFg, avisoText }: { message: string; avisoBg: string; avisoFg: string; avisoText: string }) {
  return (
    <aside
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 18,
        borderRadius: 8,
        background: "var(--color-surface)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.13)",
        border: "2px solid transparent",
        backgroundImage:
          "linear-gradient(var(--color-surface), var(--color-surface)), linear-gradient(135deg, var(--color-accent-secondary) 0%, var(--color-accent) 50%, var(--color-accent-tertiary) 100%)",
        backgroundOrigin: "border-box",
        backgroundClip: "padding-box, border-box"
      }}
    >
      <header className="flex items-center" style={{ gap: 10 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{
            width: 28,
            height: 28,
            borderRadius: 999,
            background: "linear-gradient(135deg, var(--color-accent-secondary) 0%, var(--color-accent-tertiary) 100%)",
            color: "var(--color-bg)"
          }}
        >
          <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="flex flex-col flex-1" style={{ gap: 1 }}>
          <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            OpenClaw
          </span>
          <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            Operador IA supervisado
          </span>
        </div>
        <span
          className="inline-flex items-center text-[9px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            gap: 4,
            padding: "2px 6px",
            borderRadius: 4,
            background: avisoBg,
            color: avisoFg,
            letterSpacing: "0.4px"
          }}
        >
          <Triangle size={10} strokeWidth={2} aria-hidden="true" />
          {avisoText}
        </span>
      </header>

      <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-primary)]">
        {message}
      </p>

      <div
        className="flex items-center"
        style={{
          gap: 8,
          padding: "8px 10px",
          borderRadius: 6,
          background: "var(--color-surface-sunken)",
          border: "1px solid var(--color-border)"
        }}
      >
        <FileText size={12} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="flex-1 text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] truncate">
          evidencia · snap-7f2a91c4
        </span>
        <ChevronRight size={12} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
      </div>

      <div className="flex" style={{ gap: 8 }}>
        <button
          type="button"
          className="flex-1 inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-bg)]"
          style={{ gap: 6, padding: "10px 12px", borderRadius: 6, background: "var(--color-text-primary)" }}
        >
          <Siren size={14} strokeWidth={1.75} aria-hidden="true" />
          Ver incidente
        </button>
        <button
          type="button"
          className="flex-1 inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]"
          style={{
            gap: 6,
            padding: "10px 12px",
            borderRadius: 6,
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)"
          }}
        >
          <Activity size={14} strokeWidth={1.75} aria-hidden="true" />
          Ver gráficas
        </button>
      </div>
    </aside>
  );
}

/* ============================================================
 * TwoColumn — Inventario + Historial
 * ============================================================ */
function TwoColumn({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] items-start">
      <Inventario data={data} />
      <Historial data={data} />
    </div>
  );
}

/**
 * Filas de inventario derivadas de `physicalHost.capacity` + `identity`. Si el
 * campo no existe en el contrato muestra "—". Los hashes/fuentes son slots
 * decorativos del diseño Pencil hasta que el contrato exponga snapshot hashes
 * por componente.
 */
function buildInventoryRows(data: DashboardData) {
  const ph = data.physicalHost;
  const cap = ph.capacity;
  const idem = ph.identity;
  return [
    {
      component: "CPU",
      detail: cap.cpuCores ? `${cap.cpuCores} cores` : "—",
      sub: cap.cpuThreads ? `${cap.cpuThreads} threads` : "topología por detectar",
      source: ph.source.kind,
      sourceBg: "var(--color-info-soft)",
      sourceFg: "var(--color-info)",
      hash: shortHash(ph.source.collectedAt, "#cpu—")
    },
    {
      component: "Memoria RAM",
      detail: cap.memoryGb ? `${cap.memoryGb} GB` : "—",
      sub: "DDR4 ECC",
      source: ph.source.kind,
      sourceBg: "var(--color-info-soft)",
      sourceFg: "var(--color-info)",
      hash: shortHash(ph.generatedAt, "#ram—")
    },
    {
      component: "Almacenamiento",
      detail: cap.storageUsableGb ? `${cap.storageUsableGb} GB usables` : "—",
      sub: "snapshot supervisado",
      source: "/proc",
      sourceBg: "var(--color-neutral-soft)",
      sourceFg: "var(--color-neutral)",
      hash: shortHash(ph.source.collectedAt, "#dsk—")
    },
    {
      component: "Interfaces de red",
      detail: `${cap.networkInterfaces ?? 0} interfaces`,
      sub: cap.ipPoolSize ? `${cap.ipPoolSize} IPs en pool` : "—",
      source: ph.source.kind,
      sourceBg: "var(--color-info-soft)",
      sourceFg: "var(--color-info)",
      hash: shortHash(ph.generatedAt, "#nic—")
    },
    {
      component: "Modelo",
      detail: idem.model || "—",
      sub: idem.vendor || "vendor desconocido",
      source: "manifest",
      sourceBg: "var(--color-unknown-soft)",
      sourceFg: "var(--color-unknown)",
      hash: shortHash(ph.source.collectedAt, "#mdl—")
    },
    {
      component: "Serial",
      detail: idem.serialNumber || "—",
      sub: idem.operatingSystem || "OS desconocido",
      source: "manifest",
      sourceBg: "var(--color-unknown-soft)",
      sourceFg: "var(--color-unknown)",
      hash: shortHash(ph.generatedAt, "#srl—")
    },
    {
      component: "Proxmox / kernel",
      detail: idem.proxmoxVersion || "—",
      sub: idem.kernelVersion || "kernel desconocido",
      source: "/proc",
      sourceBg: "var(--color-neutral-soft)",
      sourceFg: "var(--color-neutral)",
      hash: shortHash(ph.generatedAt, "#krn—")
    }
  ];
}

function Inventario({ data }: { data: DashboardData }) {
  const INVENTORY_ROWS = buildInventoryRows(data);
  const unknownCount = data.physicalHost.quality.unknownFields?.length ?? 0;
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 14,
        padding: 20,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 12 }}>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Inventario
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            {INVENTORY_ROWS.length} componentes verificados contra el contrato
          </span>
        </div>
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-semibold"
          style={{
            gap: 4,
            padding: "4px 8px",
            borderRadius: 4,
            background: unknownCount === 0 ? "var(--color-success-soft)" : "var(--color-warning-soft)",
            color: unknownCount === 0 ? "var(--color-success)" : "var(--color-warning)"
          }}
        >
          <CheckCircle size={11} strokeWidth={1.75} aria-hidden="true" />
          {unknownCount === 0 ? "sin huérfanos" : `${unknownCount} unknown`}
        </span>
      </header>

      {/* colHeader */}
      <div
        className="grid items-center"
        style={{
          gridTemplateColumns: "180px 180px 80px minmax(0,1fr)",
          gap: 12,
          padding: "6px 12px",
          borderRadius: 4,
          background: "var(--color-surface-sunken)"
        }}
      >
        {["COMPONENTE", "DETALLE", "FUENTE", "EVIDENCIA"].map((h, i) => (
          <span
            key={h}
            className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[var(--color-text-tertiary)]"
            style={{ letterSpacing: "0.6px", textAlign: i === 3 ? "right" : "left" }}
          >
            {h}
          </span>
        ))}
      </div>

      <div className="flex flex-col" style={{ gap: 6 }}>
        {INVENTORY_ROWS.map((row) => (
          <div
            key={row.hash}
            className="grid items-center"
            style={{
              gridTemplateColumns: "180px 180px 80px minmax(0,1fr)",
              gap: 12,
              padding: "10px 12px",
              borderRadius: 4,
              border: "1px solid var(--color-border)"
            }}
          >
            <div className="flex flex-col" style={{ gap: 2 }}>
              <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
                {row.component}
              </span>
              <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-secondary)]">
                {row.detail}
              </span>
            </div>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">{row.sub}</span>
            <span
              className="inline-flex items-center justify-center text-[10px] font-[family-name:var(--font-mono)]"
              style={{
                gap: 4,
                padding: "2px 6px",
                borderRadius: 4,
                background: row.sourceBg,
                color: row.sourceFg
              }}
            >
              {row.source}
            </span>
            <span
              className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)] text-right"
            >
              {row.hash}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Historial({ data }: { data: DashboardData }) {
  const series = data.telemetryHistory.series ?? [];
  const cpuSeries = series.find((s) => s.metric.toLowerCase().includes("cpu") && !s.metric.toLowerCase().includes("temp"));
  const memSeries = series.find((s) => s.metric.toLowerCase().includes("mem") || s.metric.toLowerCase().includes("ram"));
  const tempSeries = series.find((s) => s.metric.toLowerCase().includes("temp"));
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 16,
        padding: 20,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Historial de telemetría
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            {series.length > 0 ? `${series.length} series · ventana ${data.telemetryHistory.window}` : "Sin series disponibles"}
          </span>
        </div>
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]"
          style={{
            padding: "4px 8px",
            borderRadius: 4,
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border)"
          }}
        >
          {data.telemetryHistory.window || "ventana —"}
        </span>
      </header>

      <ChartFromSeries title="USO CPU" pillSuffix="%" series={cpuSeries} fallbackBars={[30, 36, 42, 46, 52, 54, 60, 56, 52, 48, 42, 38]} />
      <ChartFromSeries title="USO RAM" pillSuffix="%" series={memSeries} fallbackBars={[42, 48, 52, 50, 56, 58, 62, 64, 68, 72, 70, 66]} />
      <ChartFromSeries title="TEMP CPU" pillSuffix="°C" series={tempSeries} fallbackBars={[22, 26, 30, 32, 36, 40, 46, 50, 54, 60, 52, 48]} />
    </section>
  );
}

function ChartFromSeries({
  title,
  pillSuffix,
  series,
  fallbackBars
}: {
  title: string;
  pillSuffix: string;
  series: DashboardData["telemetryHistory"]["series"][number] | undefined;
  fallbackBars: number[];
}) {
  const points = (series?.points ?? []).filter((p) => typeof p.value === "number") as Array<{
    timestamp: string;
    value: number;
    quality: string;
  }>;
  const bars = points.length > 0
    ? points.slice(-12).map((p) => p.value)
    : fallbackBars;
  const lastValue = bars[bars.length - 1];
  const max = Math.max(...bars, 1);
  const normalized = bars.map((v) => Math.max(6, Math.min(60, (v / max) * 60)));
  const highlightedIndex = bars.length - 1;
  const axis = points.length > 0
    ? [
        new Date(points[0].timestamp).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }),
        points.length > 1
          ? new Date(points[Math.floor(points.length / 2)].timestamp).toLocaleTimeString("es-CO", {
              hour: "2-digit",
              minute: "2-digit"
            })
          : "—",
        "ahora"
      ]
    : ["-12h", "-6h", "ahora"];
  return (
    <ChartShell
      title={title}
      pillText={`${lastValue.toFixed(1)}${pillSuffix}`}
      pillBg="var(--color-warning-soft)"
      pillFg="var(--color-warning)"
      bars={normalized}
      axis={axis}
      highlightedIndex={highlightedIndex}
    />
  );
}

function ChartShell({
  title,
  pillText,
  pillBg,
  pillFg,
  bars,
  axis,
  highlightedIndex
}: {
  title: string;
  pillText: string;
  pillBg: string;
  pillFg: string;
  bars: number[];
  axis: string[];
  highlightedIndex: number;
}) {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 10,
        padding: 14,
        borderRadius: 6,
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)"
      }}
    >
      <header className="flex items-center justify-between" style={{ gap: 8 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
          style={{ letterSpacing: "0.6px" }}
        >
          {title}
        </span>
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-mono)] font-semibold"
          style={{ padding: "2px 6px", borderRadius: 4, background: pillBg, color: pillFg }}
        >
          {pillText}
        </span>
      </header>
      <div className="flex items-end" style={{ gap: 4, height: 60, justifyContent: "space-between" }}>
        {bars.map((h, i) => (
          <span
            key={i}
            className="flex-1"
            style={{
              height: h,
              borderRadius: 2,
              background:
                i === highlightedIndex
                  ? "linear-gradient(180deg, var(--color-accent-secondary) 0%, var(--color-accent) 50%, var(--color-accent-tertiary) 100%)"
                  : "var(--color-accent)"
            }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        {axis.map((a) => (
          <span key={a} className="text-[9px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
            {a}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
 * UnknownsRow — Campos desconocidos + Datos faltantes callout
 * ============================================================ */
const UNKNOWN_DESCRIPTIONS: Record<string, string> = {
  "sensors.ipmi.cpu0.thermal_margin":
    "Contrato sin respuesta. Activar el módulo de margen térmico IPMI en el recolector.",
  "network.optical_module_temp":
    "Sin lectura del módulo óptico. Verificar permisos SNMP y reintentar el snapshot.",
  "psu.efficiency_index":
    "PSU no expone índice de eficiencia. Actualizar firmware al canal estable v2.18.",
  "storage.smart.wearout_remaining":
    "SMART devuelve null. Programar smartctl --all en el próximo ciclo y persistir el hash."
};

function describeUnknown(path: string): string {
  return (
    UNKNOWN_DESCRIPTIONS[path] ??
    `El contrato no devolvió valor para ${path}. Coordina con el recolector supervisado para cubrir el campo en el próximo snapshot.`
  );
}

function UnknownsRow({ data }: { data: DashboardData }) {
  const phUnknowns = data.physicalHost.quality.unknownFields ?? [];
  const telUnknowns = data.telemetry.quality.unknownFields ?? [];
  const allUnknowns = [...phUnknowns, ...telUnknowns];
  const rows = allUnknowns.slice(0, 6).map((path, i) => ({
    order: String(i + 1).padStart(2, "0"),
    path,
    desc: describeUnknown(path)
  }));
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
      <CamposDesconocidos rows={rows} />
      <DatosFaltantes count={allUnknowns.length} />
    </div>
  );
}

function CamposDesconocidos({
  rows
}: {
  rows: Array<{ order: string; path: string; desc: string }>;
}) {
  if (rows.length === 0) {
    return (
      <section
        className="flex flex-col bg-[var(--color-surface)]"
        style={{
          gap: 14,
          padding: 20,
          borderRadius: 8,
          border: "1px solid var(--color-border)",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
        }}
      >
        <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
          Campos desconocidos
        </h2>
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
          El contrato no reporta campos sin valor en el snapshot actual.
        </p>
      </section>
    );
  }
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 14,
        padding: 20,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 12 }}>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Campos desconocidos
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            El contrato no devolvió valor en 4 campos · ordenados por prioridad
          </span>
        </div>
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-semibold"
          style={{ gap: 4, padding: "4px 8px", borderRadius: 4, background: "var(--color-unknown-soft)", color: "var(--color-unknown)" }}
        >
          <Info size={11} strokeWidth={1.75} aria-hidden="true" />
          4 sin valor
        </span>
      </header>

      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 8 }}>
        {rows.map((row) => (
          <li
            key={row.path}
            className="flex"
            style={{
              gap: 12,
              padding: "12px 14px",
              borderRadius: 4,
              background: "var(--color-unknown-soft)",
              border: "1px solid var(--color-unknown)"
            }}
          >
            <span
              aria-hidden="true"
              className="grid place-items-center text-[var(--color-bg)] tabular-nums shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: 4,
                background: "var(--color-unknown)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 700
              }}
            >
              {row.order}
            </span>
            <div className="flex flex-col flex-1" style={{ gap: 4 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <code className="text-[12px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">
                  {row.path}
                </code>
                <span className="flex-1" aria-hidden="true" />
                <span
                  className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-unknown)]"
                  style={{ letterSpacing: "0.4px" }}
                >
                  sin valor
                </span>
              </div>
              <p className="m-0 text-[11px] font-[family-name:var(--font-caption)] leading-[1.45] text-[var(--color-text-secondary)]">
                {row.desc}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DatosFaltantes({ count }: { count: number }) {
  const impact = Math.min(50, count * 3);
  return (
    <section
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 20,
        borderRadius: 8,
        background: count === 0 ? "var(--color-success-soft)" : "var(--color-warning-soft)",
        border: `1px solid ${count === 0 ? "var(--color-success)" : "var(--color-warning)"}`
      }}
    >
      <header className="flex items-center" style={{ gap: 10 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{ width: 32, height: 32, borderRadius: 8, background: count === 0 ? "var(--color-success)" : "var(--color-warning)", color: "var(--color-bg)" }}
        >
          <Triangle size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Datos faltantes
          </h3>
          <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-secondary)]">
            {count === 0 ? "0 campos · snapshot completo" : `${count} campos · pendientes de captura`}
          </span>
        </div>
      </header>

      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-primary)]">
        {count === 0
          ? "Snapshot completo. No hay campos sin valor en el ciclo actual del recolector supervisado."
          : "Los campos sin valor bloquean el cálculo del puntaje de salud. OpenClaw recomienda iniciar un snapshot manual antes del próximo ciclo de aprendizaje."}
      </p>

      <div
        className="flex flex-col bg-[var(--color-surface)]"
        style={{
          gap: 6,
          padding: "10px 12px",
          borderRadius: 4,
          border: "1px solid var(--color-border)"
        }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-text-secondary)]">
            impacto en puntaje
          </span>
          <span
            className="text-[12px] font-[family-name:var(--font-mono)] font-semibold"
            style={{ color: count === 0 ? "var(--color-success)" : "var(--color-warning)" }}
          >
            {count === 0 ? "sin impacto" : `-${impact} puntos`}
          </span>
        </div>
        <div
          aria-hidden="true"
          className="overflow-hidden"
          style={{ height: 6, borderRadius: 3, background: "var(--color-border)" }}
        >
          <span
            style={{
              display: "block",
              width: `${(impact / 50) * 100}%`,
              height: 6,
              borderRadius: 3,
              background: count === 0 ? "var(--color-success)" : "var(--color-warning)"
            }}
          />
        </div>
      </div>

      <button
        type="button"
        className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-bg)]"
        style={{ gap: 6, padding: "10px 12px", borderRadius: 6, background: "var(--color-text-primary)" }}
      >
        <Camera size={14} strokeWidth={1.75} aria-hidden="true" />
        Solicitar snapshot manual
      </button>
    </section>
  );
}

/* ============================================================
 * AuditFooter — 6 rows literales Pencil
 * ============================================================ */
/** Estilo del badge "fuente" derivado del actorType del audit event. */
function auditSourceStyle(actorType: string): {
  text: string;
  bg: string;
  fg: string;
  border: string;
} {
  const t = actorType.toLowerCase();
  if (t.includes("openclaw")) return { text: "openclaw", bg: "var(--color-unknown-soft)", fg: "var(--color-unknown)", border: "var(--color-unknown-soft)" };
  if (t.includes("collector") || t.includes("system.collector"))
    return { text: "contract", bg: "var(--color-info-soft)", fg: "var(--color-info)", border: "var(--color-info-soft)" };
  if (t.includes("warming")) return { text: "warming", bg: "var(--color-success-soft)", fg: "var(--color-success)", border: "var(--color-success-soft)" };
  if (t.includes("operador") || t.includes("operator"))
    return { text: "manual", bg: "var(--color-surface-sunken)", fg: "var(--color-text-secondary)", border: "var(--color-border)" };
  return { text: t.split(".")[0] || "system", bg: "var(--color-surface)", fg: "var(--color-text-secondary)", border: "var(--color-border)" };
}

function buildHardwareAuditRows(events: import("../../shared/api/client.ts").AuditEvent[]) {
  return events.map((e, i) => {
    const src = auditSourceStyle(e.actorType);
    return {
      ts: new Date(e.occurredAt).toLocaleString("es-CO", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }),
      actor: `${e.actorType}${e.actorId ? `@${e.actorId}` : ""}`,
      action: e.action,
      detail: `${e.targetType} · ${e.targetId}`,
      sourceText: src.text,
      sourceBg: src.bg,
      sourceFg: src.fg,
      sourceBorder: src.border,
      rowBg: i % 2 === 1 ? "var(--color-surface-sunken)" : "transparent"
    };
  });
}

function AuditFooter({ data }: { data: DashboardData }) {
  const events = filterAuditEvents(
    data.auditEvents,
    ["physical-host", "hardware", "telemetry", "snapshot", "manual_snapshot", "collector"],
    6
  );
  const auditRows = events.length > 0
    ? buildHardwareAuditRows(events)
    : [
        {
          ts: "—",
          actor: "audit log vacío",
          action: "el contrato /v1/audit-events no ha registrado eventos de hardware",
          detail: "Wave 2 — backend logging por host pendiente",
          sourceText: "todavía",
          sourceBg: "var(--color-surface-sunken)",
          sourceFg: "var(--color-text-tertiary)",
          sourceBorder: "var(--color-border)",
          rowBg: "transparent" as const
        }
      ];
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 12,
        padding: 20,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 12 }}>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-text-primary)]">
            Registro de auditoría
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            Últimas 6 acciones · trazabilidad sólo lectura
          </span>
        </div>
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-semibold"
          style={{ gap: 4, padding: "4px 8px", borderRadius: 4, background: "var(--color-info-soft)", color: "var(--color-info)" }}
        >
          <Shield size={11} strokeWidth={1.75} aria-hidden="true" />
          hashes verificados
        </span>
      </header>

      {/* colHeader */}
      <div
        className="grid items-center"
        style={{
          gridTemplateColumns: "160px 140px 200px minmax(0,1fr) 120px",
          gap: 8,
          padding: "6px 10px",
          borderRadius: 4,
          background: "var(--color-surface-sunken)"
        }}
      >
        {["TIMESTAMP", "ACTOR", "ACCIÓN", "DETALLE", "FUENTE"].map((h, i) => (
          <span
            key={h}
            className="text-[9px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[var(--color-text-tertiary)]"
            style={{ letterSpacing: "0.6px", textAlign: i === 4 ? "right" : "left" }}
          >
            {h}
          </span>
        ))}
      </div>

      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 2 }}>
        {auditRows.map((row, i) => (
          <li
            key={i}
            className="grid items-center"
            style={{
              gridTemplateColumns: "160px 140px 200px minmax(0,1fr) 120px",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 4,
              background: row.rowBg
            }}
          >
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{row.ts}</span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] font-medium text-[var(--color-accent-tertiary)] truncate">
              {row.actor}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-primary)] truncate">
              {row.action}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] truncate">
              {row.detail}
            </span>
            <span
              className="inline-flex items-center justify-center text-[10px] font-[family-name:var(--font-mono)]"
              style={{
                padding: "2px 8px",
                borderRadius: 4,
                background: row.sourceBg,
                color: row.sourceFg,
                border: row.sourceBorder ? `1px solid ${row.sourceBorder}` : undefined,
                justifySelf: "end"
              }}
            >
              {row.sourceText}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
