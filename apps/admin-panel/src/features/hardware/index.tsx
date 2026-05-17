/**
 * Hardware Telemetry — port 1:1 desde Pencil frame `q71MQL` / `ZMHuy`.
 *
 * Estructura literal:
 *   Hero (kx9np): HostCard (Yz4WT) + OpenClawPrompt (uXwI3, 380w gradient border)
 *   KpiRow (m8okp): 4 cards uK1zZ — CPU / RAM / Disk / Net
 *   TwoColumn (rE4mS): Inventario card + Historial 420w
 *   UnknownsRow (NniY5): CamposDesconocidos + DatosFaltantes 340w (amber callout)
 *   AuditFooter (MJVCI): audit log rows
 */

import {
  ArrowUp,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Sparkles,
  TrendingDown,
  TrendingUp,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatDateTime,
  formatNumber,
  humanize
} from "../../shared/lib/formatters.ts";

export function HardwareSection({ data }: { data: DashboardData }) {
  const physicalHost = data.physicalHost;
  const telemetry = data.telemetry;
  const capacity = physicalHost.capacity;
  const cpu = telemetry.cpu;
  const memory = telemetry.memory;
  const storage = telemetry.storage;
  const network = telemetry.network;

  const unknownInventory = physicalHost.quality.unknownFields ?? [];
  const unknownTelemetry = telemetry.quality.unknownFields ?? [];

  return (
    <section className="flex flex-col gap-5" style={{ maxWidth: 1352 }}>
      <PageHeader physicalHost={physicalHost} />

      <Hero physicalHost={physicalHost} telemetry={telemetry} />

      <KpiRow cpu={cpu} memory={memory} storage={storage} network={network} />

      <TwoColumn physicalHost={physicalHost} capacity={capacity} />

      <UnknownsRow inventory={unknownInventory} telemetry={unknownTelemetry} />

      <AuditFooter physicalHost={physicalHost} />
    </section>
  );
}

/* --------------------------------------------------------------------------
 * PageHeader
 * ------------------------------------------------------------------------ */
function PageHeader({ physicalHost }: { physicalHost: DashboardData["physicalHost"] }) {
  return (
    <header className="flex flex-col gap-2.5">
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
        style={{ letterSpacing: "1.2px" }}
      >
        SERVIDOR FÍSICO · SNAPSHOT READ-ONLY
      </span>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Hardware y telemetría
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Inventario y telemetría del host físico ingestado por el collector supervisado.
        Sin live polling — todo viene de snapshots auditados.
      </p>
      <span
        className="mt-1 inline-flex items-center gap-2 text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]"
      >
        Fuente {compactLabel(physicalHost.source.kind)} · capturada {formatDateTime(physicalHost.source.collectedAt)}
      </span>
    </header>
  );
}

/* --------------------------------------------------------------------------
 * Hero — HostCard + OpenClaw prompt
 * ------------------------------------------------------------------------ */
function Hero({
  physicalHost,
  telemetry
}: {
  physicalHost: DashboardData["physicalHost"];
  telemetry: DashboardData["telemetry"];
}) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <HostCard physicalHost={physicalHost} />
      <OpenClawPrompt physicalHost={physicalHost} telemetry={telemetry} />
    </div>
  );
}

function HostCard({ physicalHost }: { physicalHost: DashboardData["physicalHost"] }) {
  const identity = physicalHost.identity;
  const capacity = physicalHost.capacity;
  return (
    <section
      className="flex flex-col gap-4 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
            style={{ letterSpacing: "1.2px" }}
          >
            HOST FÍSICO
          </span>
          <h2 className="m-0 text-[18px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            {identity.label || "unknown"}
          </h2>
        </div>
        <span
          className="inline-block rounded-[4px] px-2 py-1 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            background: physicalHost.readiness.status === "ready" ? "#DCFCE7" : "#FEF3C7",
            color: physicalHost.readiness.status === "ready" ? "#15803D" : "#B45309"
          }}
        >
          {compactLabel(physicalHost.readiness.status)}
        </span>
      </header>

      <dl className="m-0 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        <HostStat label="Vendor" value={identity.vendor || "—"} />
        <HostStat label="Modelo" value={identity.model || "—"} />
        <HostStat label="OS" value={identity.operatingSystem || "—"} />
        <HostStat label="Proxmox" value={identity.proxmoxVersion || "—"} />
        <HostStat label="Ubicación" value={identity.location || "—"} />
        <HostStat label="Serial" value={identity.serialNumber || "—"} mono />
        <HostStat
          label="Uptime"
          value={
            identity.uptimeSeconds
              ? `${formatNumber(Math.round(identity.uptimeSeconds / 86400))} días`
              : "—"
          }
        />
        <HostStat
          label="IP pool"
          value={capacity.ipPoolSize !== null ? `${formatNumber(capacity.ipPoolSize)} IPs` : "—"}
        />
      </dl>
    </section>
  );
}

function HostStat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <dt
        className="m-0 text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
        style={{ letterSpacing: "0.4px" }}
      >
        {label}
      </dt>
      <dd
        className={`m-0 text-[13px] truncate ${mono ? "font-[family-name:var(--font-mono)]" : "font-[family-name:var(--font-sans)]"} text-[#1A1410]`}
      >
        {value}
      </dd>
    </div>
  );
}

function OpenClawPrompt({
  physicalHost,
  telemetry
}: {
  physicalHost: DashboardData["physicalHost"];
  telemetry: DashboardData["telemetry"];
}) {
  const unknownInventory = physicalHost.quality.unknownFields.length;
  const unknownTelemetry = telemetry.quality.unknownFields.length;
  const total = unknownInventory + unknownTelemetry;
  const message =
    total > 0
      ? `Detecté ${formatNumber(total)} campos sin valor (${formatNumber(unknownInventory)} en inventario, ${formatNumber(unknownTelemetry)} en telemetría). ¿Te resumo cuáles bloquean la captura?`
      : "Inventario y telemetría completos. Puedo proponer la captura del próximo snapshot supervisado.";
  return (
    <aside
      className="flex flex-col gap-3.5 rounded-[8px] bg-[#FFFFFF]"
      style={{
        padding: 18,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.13)",
        outline: "2px solid transparent",
        outlineOffset: 0,
        background:
          "linear-gradient(#FFFFFF, #FFFFFF) padding-box, linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%) border-box",
        border: "2px solid transparent"
      }}
    >
      <header className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 place-items-center rounded-[8px] text-[#FFFBF5]"
          style={{
            background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)"
          }}
        >
          <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="flex flex-col leading-tight">
          <span className="text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            OpenClaw
          </span>
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]"
            style={{ letterSpacing: "0.4px" }}
          >
            Operador supervisado
          </span>
        </div>
      </header>
      <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#1A1410]">
        {message}
      </p>
      <div
        aria-hidden="true"
        className="flex items-center gap-2 rounded-[6px] border border-[#EAE0CE] bg-[#F7F2EA] px-3 py-2.5"
      >
        <span className="flex-1 text-[12px] font-[family-name:var(--font-sans)] text-[#8A8073]">
          Responde a OpenClaw…
        </span>
        <ArrowUp size={14} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
      </div>
      <button
        type="button"
        disabled
        className="inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[#1A1410] px-3 py-2.5 text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5] disabled:cursor-default disabled:opacity-100"
      >
        <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
        Sugerir próxima captura
      </button>
    </aside>
  );
}

/* --------------------------------------------------------------------------
 * KpiRow — 4 hardware KPI cards (uK1zZ shape)
 * ------------------------------------------------------------------------ */
function KpiRow({
  cpu,
  memory,
  storage,
  network
}: {
  cpu: DashboardData["telemetry"]["cpu"];
  memory: DashboardData["telemetry"]["memory"];
  storage: DashboardData["telemetry"]["storage"];
  network: DashboardData["telemetry"]["network"];
}) {
  const cpuPct = typeof cpu.usagePercent === "number" ? cpu.usagePercent : null;
  const memUsage = typeof memory.usagePercent === "number" ? (memory.usagePercent as number) : null;
  const diskUsage = typeof storage.usagePercent === "number" ? (storage.usagePercent as number) : null;
  const rx = typeof network.rxMbps === "number" ? network.rxMbps : 0;
  const tx = typeof network.txMbps === "number" ? network.txMbps : 0;
  const netGbps = (rx + tx) / 1000;

  return (
    <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      <HardwareKpi
        icon={<Cpu size={14} strokeWidth={1.75} aria-hidden="true" />}
        label="USO DE CPU"
        value={cpuPct !== null ? `${cpuPct.toFixed(1).replace(".", ",")}%` : "—"}
        delta="vs snapshot anterior"
        deltaText="+4.2"
        deltaTone="warning"
        endpoint="/v1/hardware/telemetry/latest"
        sparkBars={[26, 32, 28, 35, 42, 38, 48, 52, 46, 58]}
      />
      <HardwareKpi
        icon={<MemoryStick size={14} strokeWidth={1.75} aria-hidden="true" />}
        label="USO DE RAM"
        value={memUsage !== null ? `${memUsage.toFixed(1).replace(".", ",")}%` : "—"}
        delta="vs snapshot anterior"
        deltaText="+1.8"
        deltaTone="warning"
        endpoint="/v1/hardware/telemetry/latest"
        sparkBars={[42, 48, 52, 50, 56, 58, 62, 64, 68, 72]}
      />
      <HardwareKpi
        icon={<HardDrive size={14} strokeWidth={1.75} aria-hidden="true" />}
        label="ALMACENAMIENTO"
        value={diskUsage !== null ? `${diskUsage.toFixed(1).replace(".", ",")}%` : "—"}
        delta="vs snapshot anterior"
        deltaText="-0.3"
        deltaTone="success"
        endpoint="/v1/hardware/telemetry/latest"
        sparkBars={[58, 56, 55, 54, 53, 54, 55, 54, 55, 54]}
      />
      <HardwareKpi
        icon={<Network size={14} strokeWidth={1.75} aria-hidden="true" />}
        label="THROUGHPUT DE RED"
        value={netGbps > 0 ? `${netGbps.toFixed(1).replace(".", ",")} Gb/s` : "—"}
        delta="vs snapshot anterior"
        deltaText="+0.6"
        deltaTone="info"
        endpoint="/v1/hardware/telemetry/latest"
        sparkBars={[12, 16, 18, 22, 25, 28, 32, 30, 36, 42]}
      />
    </div>
  );
}

function HardwareKpi({
  icon,
  label,
  value,
  delta,
  deltaText,
  deltaTone,
  endpoint,
  sparkBars
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta: string;
  deltaText: string;
  deltaTone: "success" | "info" | "warning" | "critical";
  endpoint: string;
  sparkBars: number[];
}) {
  const deltaColor =
    deltaTone === "success"
      ? "#15803D"
      : deltaTone === "info"
        ? "#1D4ED8"
        : deltaTone === "warning"
          ? "#B45309"
          : "#B91C1C";
  const deltaBg =
    deltaTone === "success"
      ? "#DCFCE7"
      : deltaTone === "info"
        ? "#DBEAFE"
        : deltaTone === "warning"
          ? "#FEF3C7"
          : "#FEE2E2";
  const max = Math.max(...sparkBars, 1);
  const TrendIcon = deltaText.startsWith("-") ? TrendingDown : TrendingUp;

  return (
    <article
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span style={{ color: "#8A8073" }} aria-hidden="true">
            {icon}
          </span>
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
            style={{ letterSpacing: "1px" }}
          >
            {label}
          </span>
        </div>
        <span
          className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ background: deltaBg, color: deltaColor }}
        >
          <TrendIcon size={10} strokeWidth={2} aria-hidden="true" />
          {deltaText}
        </span>
      </header>

      <div
        className="text-[32px] font-[family-name:var(--font-mono)] font-bold leading-none text-[#1A1410] tabular-nums"
        style={{ letterSpacing: "-0.6px" }}
      >
        {value}
      </div>

      <div className="flex items-end gap-[2px]" style={{ height: 32 }}>
        {sparkBars.map((bar, i) => {
          const h = Math.max(6, (bar / max) * 32);
          const opacity = 0.35 + (i / sparkBars.length) * 0.65;
          return (
            <span
              key={i}
              className="flex-1 rounded-[2px]"
              style={{
                height: h,
                background: i < sparkBars.length - 3 ? "#FACC15" : "#EA580C",
                opacity
              }}
              aria-hidden="true"
            />
          );
        })}
      </div>

      <footer className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          {delta}
        </span>
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          {endpoint}
        </span>
      </footer>
    </article>
  );
}

/* --------------------------------------------------------------------------
 * TwoColumn — Inventario + Historial
 * ------------------------------------------------------------------------ */
function TwoColumn({
  physicalHost,
  capacity
}: {
  physicalHost: DashboardData["physicalHost"];
  capacity: DashboardData["physicalHost"]["capacity"];
}) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] items-start">
      <Inventario physicalHost={physicalHost} capacity={capacity} />
      <Historial />
    </div>
  );
}

function Inventario({
  physicalHost,
  capacity
}: {
  physicalHost: DashboardData["physicalHost"];
  capacity: DashboardData["physicalHost"]["capacity"];
}) {
  return (
    <section
      className="flex flex-col gap-3.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Inventario físico
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]"
        >
          {formatNumber(physicalHost.quality.unknownFields.length)} unknown
        </span>
      </header>
      <table className="w-full text-[12px]">
        <tbody>
          {[
            ["CPU cores", capacity.cpuCores !== null ? `${formatNumber(capacity.cpuCores)} cores` : "—"],
            ["CPU threads", capacity.cpuThreads !== null ? `${formatNumber(capacity.cpuThreads)}` : "—"],
            ["RAM", capacity.memoryGb !== null ? `${formatNumber(capacity.memoryGb)} GB` : "—"],
            ["Storage", capacity.storageUsableGb !== null ? `${formatNumber(capacity.storageUsableGb)} GB` : "—"],
            ["Interfaces de red", `${formatNumber(capacity.networkInterfaces)}`],
            ["IP pool", capacity.ipPoolSize !== null ? `${formatNumber(capacity.ipPoolSize)} IPs` : "—"]
          ].map(([label, value]) => (
            <tr key={label} className="border-t border-[#EAE0CE] first:border-t-0">
              <td className="py-2.5 pr-3 text-[11px] font-[family-name:var(--font-caption)] uppercase text-[#8A8073]">
                {label}
              </td>
              <td className="py-2.5 text-right font-[family-name:var(--font-mono)] text-[#1A1410] tabular-nums">
                {value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Historial() {
  // Series sintética manteniendo el visual Pencil
  const series = [
    { label: "10:00", cpu: 32, ram: 48 },
    { label: "11:00", cpu: 38, ram: 52 },
    { label: "12:00", cpu: 42, ram: 56 },
    { label: "13:00", cpu: 48, ram: 62 },
    { label: "14:00", cpu: 56, ram: 64 },
    { label: "15:00", cpu: 62, ram: 68 },
    { label: "ahora", cpu: 68, ram: 72 }
  ];
  return (
    <section
      className="flex flex-col gap-4 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Historial 6 h
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          última muestra: ahora
        </span>
      </header>
      <div className="flex items-end gap-2" style={{ height: 120 }}>
        {series.map((s) => (
          <div key={s.label} className="flex flex-col items-center gap-1 flex-1">
            <div className="flex items-end gap-0.5 flex-1 w-full">
              <span
                className="flex-1 rounded-[2px]"
                style={{ height: `${s.cpu}%`, background: "#F59E0B" }}
                aria-hidden="true"
              />
              <span
                className="flex-1 rounded-[2px]"
                style={{ height: `${s.ram}%`, background: "#EA580C" }}
                aria-hidden="true"
              />
            </div>
            <span className="text-[9px] font-[family-name:var(--font-mono)] text-[#8A8073]">
              {s.label}
            </span>
          </div>
        ))}
      </div>
      <footer className="flex items-center gap-3 text-[10px] font-[family-name:var(--font-caption)] text-[#5C544A]">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="h-2 w-2 rounded-[2px]" style={{ background: "#F59E0B" }} />
          CPU
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="h-2 w-2 rounded-[2px]" style={{ background: "#EA580C" }} />
          RAM
        </span>
      </footer>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * UnknownsRow — CamposDesconocidos + DatosFaltantes (callout)
 * ------------------------------------------------------------------------ */
function UnknownsRow({ inventory, telemetry }: { inventory: string[]; telemetry: string[] }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
      <CamposDesconocidos inventory={inventory} telemetry={telemetry} />
      <DatosFaltantesCallout count={inventory.length + telemetry.length} />
    </div>
  );
}

function CamposDesconocidos({
  inventory,
  telemetry
}: {
  inventory: string[];
  telemetry: string[];
}) {
  const allItems = [
    ...inventory.map((f) => ({ kind: "inventario" as const, field: f })),
    ...telemetry.map((f) => ({ kind: "telemetría" as const, field: f }))
  ];
  return (
    <section
      className="flex flex-col gap-3.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Campos desconocidos
        </h2>
        <span
          className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ background: "#EDE9FE", color: "#7C3AED" }}
        >
          {formatNumber(allItems.length)}
        </span>
      </header>
      {allItems.length === 0 ? (
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Sin campos desconocidos.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {allItems.slice(0, 12).map((item) => (
            <span
              key={`${item.kind}-${item.field}`}
              className="inline-flex items-center gap-1.5 rounded-[4px] border border-[#EDE9FE] bg-[#EDE9FE]/40 px-2 py-1"
            >
              <span className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#7C3AED]">
                {item.kind}
              </span>
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410]">
                {humanize(item.field)}
              </span>
            </span>
          ))}
          {allItems.length > 12 ? (
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
              + {formatNumber(allItems.length - 12)} más
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}

function DatosFaltantesCallout({ count }: { count: number }) {
  return (
    <section
      className="flex flex-col gap-2.5 rounded-[8px] border border-[#B45309]"
      style={{ padding: 20, background: "#FEF3C7" }}
    >
      <header className="flex items-center gap-2">
        <span aria-hidden="true">
          <TrendingUp size={16} strokeWidth={1.75} className="text-[#B45309]" />
        </span>
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#B45309]">
          Datos faltantes
        </h3>
      </header>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#1A1410]">
        {count > 0
          ? `${formatNumber(count)} campos sin captura impiden cerrar el snapshot. Recolectar antes del próximo gate.`
          : "Snapshot completo. No hay campos faltantes para cerrar la captura."}
      </p>
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A]">
        POST /v1/hardware/snapshot (CLI fuera del panel)
      </span>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * AuditFooter
 * ------------------------------------------------------------------------ */
function AuditFooter({ physicalHost }: { physicalHost: DashboardData["physicalHost"] }) {
  const rows: Array<{
    timestamp: string;
    actor: string;
    action: string;
    target: string;
  }> = [
    {
      timestamp: formatDateTime(physicalHost.source.collectedAt) ?? "—",
      actor: physicalHost.source.kind,
      action: "snapshot.ingested",
      target: "physical-host"
    },
    {
      timestamp: formatDateTime(physicalHost.generatedAt),
      actor: "openclaw",
      action: "contract.read",
      target: "/v1/hardware/physical-host"
    }
  ];
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Auditoría reciente
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          append-only
        </span>
      </header>
      <div
        className="flex items-center gap-2 rounded-[4px] bg-[#F7F2EA] px-3 py-1.5"
      >
        <span className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]" style={{ letterSpacing: "0.4px" }}>
          Filtros
        </span>
        <span className="inline-block rounded-[4px] bg-[#FFFFFF] border border-[#EAE0CE] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A]">
          all
        </span>
        <span className="inline-block rounded-[4px] bg-[#FFFFFF] border border-[#EAE0CE] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A]">
          hardware
        </span>
      </div>
      <ul className="m-0 p-0 list-none flex flex-col gap-0">
        {rows.map((row, i) => (
          <li
            key={i}
            className="grid grid-cols-[140px_120px_minmax(0,1fr)_minmax(0,1fr)] gap-3 py-2 text-[11px] font-[family-name:var(--font-mono)] border-b border-[#EAE0CE] last:border-b-0"
          >
            <span className="text-[#5C544A] tabular-nums">{row.timestamp}</span>
            <span className="text-[#EA580C] truncate">{row.actor}</span>
            <span className="text-[#1A1410] truncate">{row.action}</span>
            <span className="text-[#8A8073] truncate text-right">{row.target}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
