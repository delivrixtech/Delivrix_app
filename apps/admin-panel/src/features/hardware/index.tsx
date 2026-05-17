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

export function HardwareSection({ data }: { data: DashboardData }) {
  void data;
  return (
    <section className="flex flex-col" style={{ gap: 20, maxWidth: 1352 }}>
      <Hero />
      <TwoColumn />
      <UnknownsRow />
      <AuditFooter />
    </section>
  );
}

/* ============================================================
 * Hero — HostCard + OpenClaw prompt
 * ============================================================ */
function Hero() {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <HostCard />
      <OpenClawPrompt />
    </div>
  );
}

function HostCard() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 16,
        padding: 20,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 16 }}>
        <div className="flex flex-col flex-1" style={{ gap: 4 }}>
          <h2 className="m-0 text-[20px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            nodo-04 · sender-fleet
          </h2>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]"
            style={{ letterSpacing: "0.4px" }}
          >
            Identidad de host · plano de control v1.4
          </span>
        </div>
        <span
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-caption)] font-semibold"
          style={{
            gap: 6,
            padding: "4px 10px",
            borderRadius: 4,
            background: "#DCFCE7",
            color: "#15803D",
            letterSpacing: "0.6px"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: "#15803D" }} />
          LISTO
        </span>
      </header>

      <div className="flex flex-wrap" style={{ gap: 10 }}>
        <Chip icon={<MapPin size={12} strokeWidth={1.75} aria-hidden="true" />} text="datacenter · iad-01" />
        <Chip icon={<Layers size={12} strokeWidth={1.75} aria-hidden="true" />} text="rol · sender-fleet" />
        <Chip
          icon={<Radio size={12} strokeWidth={1.75} aria-hidden="true" style={{ color: "#15803D" }} />}
          text="Telemetría actualizada hace 14s"
          mono
        />
        <Chip
          icon={<Hash size={12} strokeWidth={1.75} aria-hidden="true" />}
          text="hash · 7f2a91c4"
          color="#8A8073"
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
  color = "#5C544A"
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
        background: "#F7F2EA",
        border: "1px solid #EAE0CE",
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

function OpenClawPrompt() {
  return (
    <aside
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 18,
        borderRadius: 8,
        background: "#FFFFFF",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.13)",
        border: "2px solid transparent",
        backgroundImage:
          "linear-gradient(#FFFFFF, #FFFFFF), linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
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
            background: "linear-gradient(135deg, #FACC15 0%, #EA580C 100%)",
            color: "#FFFBF5"
          }}
        >
          <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="flex flex-col flex-1" style={{ gap: 1 }}>
          <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
            OpenClaw
          </span>
          <span className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Operador IA supervisado
          </span>
        </div>
        <span
          className="inline-flex items-center text-[9px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            gap: 4,
            padding: "2px 6px",
            borderRadius: 4,
            background: "#FEF3C7",
            color: "#B45309",
            letterSpacing: "0.4px"
          }}
        >
          <Triangle size={10} strokeWidth={2} aria-hidden="true" />
          AVISO
        </span>
      </header>

      <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
        CPU sostenido alto en 3 de los últimos 6 snapshots. ¿Revisamos el clúster A?
      </p>

      <div
        className="flex items-center"
        style={{
          gap: 8,
          padding: "8px 10px",
          borderRadius: 6,
          background: "#F7F2EA",
          border: "1px solid #EAE0CE"
        }}
      >
        <FileText size={12} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        <span className="flex-1 text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A] truncate">
          evidencia · snap-7f2a91c4
        </span>
        <ChevronRight size={12} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
      </div>

      <div className="flex" style={{ gap: 8 }}>
        <button
          type="button"
          className="flex-1 inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]"
          style={{ gap: 6, padding: "10px 12px", borderRadius: 6, background: "#1A1410" }}
        >
          <Siren size={14} strokeWidth={1.75} aria-hidden="true" />
          Ver incidente
        </button>
        <button
          type="button"
          className="flex-1 inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]"
          style={{
            gap: 6,
            padding: "10px 12px",
            borderRadius: 6,
            background: "#FFFFFF",
            border: "1px solid #EAE0CE"
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
function TwoColumn() {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] items-start">
      <Inventario />
      <Historial />
    </div>
  );
}

const INVENTORY_ROWS = [
  {
    component: "CPU",
    detail: "AMD EPYC 7763",
    sub: "2 sockets · 128 cores",
    source: "IPMI",
    sourceBg: "#DBEAFE",
    sourceFg: "#1D4ED8",
    hash: "#a3f1bd4e"
  },
  {
    component: "Sockets / Cores",
    detail: "Topología detectada",
    sub: "2 × 64 cores · HT activo",
    source: "/proc",
    sourceBg: "#F5F5F4",
    sourceFg: "#57534E",
    hash: "#bc1209ef"
  },
  {
    component: "Módulos RAM",
    detail: "16 × 32 GB DDR4 ECC",
    sub: "512 GB · 8 canales",
    source: "IPMI",
    sourceBg: "#DBEAFE",
    sourceFg: "#1D4ED8",
    hash: "#7e2410af"
  },
  {
    component: "Almacenamiento",
    detail: "NVMe SSD × 4",
    sub: "8 TB · RAID-10",
    source: "/proc",
    sourceBg: "#F5F5F4",
    sourceFg: "#57534E",
    hash: "#cd8721ba"
  },
  {
    component: "NIC",
    detail: "Mellanox ConnectX-6",
    sub: "2 × 100 GbE · LACP",
    source: "IPMI",
    sourceBg: "#DBEAFE",
    sourceFg: "#1D4ED8",
    hash: "#ef0934aa"
  },
  {
    component: "PSU",
    detail: "Redundante 1+1",
    sub: "1600 W · titanium",
    source: "IPMI",
    sourceBg: "#DBEAFE",
    sourceFg: "#1D4ED8",
    hash: "#02e312bf"
  },
  {
    component: "Sensores térmicos",
    detail: "12 sondas activas",
    sub: "cpu0–cpu1 · psu0–psu1",
    source: "snapshot manual",
    sourceBg: "#EDE9FE",
    sourceFg: "#7C3AED",
    hash: "#a4d217dc"
  }
];

function Inventario() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 14,
        padding: 20,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 12 }}>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Inventario
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            7 componentes verificados contra el contrato
          </span>
        </div>
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-semibold"
          style={{ gap: 4, padding: "4px 8px", borderRadius: 4, background: "#DCFCE7", color: "#15803D" }}
        >
          <CheckCircle size={11} strokeWidth={1.75} aria-hidden="true" />
          sin huérfanos
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
          background: "#F7F2EA"
        }}
      >
        {["COMPONENTE", "DETALLE", "FUENTE", "EVIDENCIA"].map((h, i) => (
          <span
            key={h}
            className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
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
              border: "1px solid #EAE0CE"
            }}
          >
            <div className="flex flex-col" style={{ gap: 2 }}>
              <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
                {row.component}
              </span>
              <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#5C544A]">
                {row.detail}
              </span>
            </div>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]">{row.sub}</span>
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
              className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073] text-right"
            >
              {row.hash}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Historial() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 16,
        padding: 20,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Historial de telemetría
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Tres ventanas · captura cada 60 s
          </span>
        </div>
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A]"
          style={{
            padding: "4px 8px",
            borderRadius: 4,
            background: "#F7F2EA",
            border: "1px solid #EAE0CE"
          }}
        >
          últimas 24h
        </span>
      </header>

      <ChartCPU />
      <ChartRAM />
      <ChartTemp />
    </section>
  );
}

function ChartCPU() {
  const bars = [30, 36, 42, 46, 52, 54, 60, 56, 52, 48, 42, 38];
  const axis = ["00:00", "12:00", "23:59"];
  return (
    <ChartShell
      title="USO CPU"
      pillText="68%"
      pillBg="#FEF3C7"
      pillFg="#B45309"
      bars={bars}
      axis={axis}
      highlightedIndex={6}
    />
  );
}

function ChartRAM() {
  const bars = [42, 48, 52, 50, 56, 58, 62, 64, 68, 72, 70, 66];
  const axis = ["00:00", "12:00", "23:59"];
  return (
    <ChartShell
      title="USO RAM"
      pillText="72%"
      pillBg="#FEF3C7"
      pillFg="#B45309"
      bars={bars}
      axis={axis}
      highlightedIndex={9}
    />
  );
}

function ChartTemp() {
  const bars = [22, 26, 30, 32, 36, 40, 46, 50, 54, 60, 52, 48];
  const axis = ["-12h", "-6h", "ahora"];
  return (
    <ChartShell
      title="TEMP CPU"
      pillText="56°C"
      pillBg="#FEF3C7"
      pillFg="#B45309"
      bars={bars}
      axis={axis}
      highlightedIndex={9}
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
        background: "#FFFBF5",
        border: "1px solid #EAE0CE"
      }}
    >
      <header className="flex items-center justify-between" style={{ gap: 8 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
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
                  ? "linear-gradient(180deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)"
                  : "#F59E0B"
            }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        {axis.map((a) => (
          <span key={a} className="text-[9px] font-[family-name:var(--font-mono)] text-[#8A8073]">
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
const UNKNOWN_ROWS = [
  {
    order: "01",
    path: "sensors.ipmi.cpu0.thermal_margin",
    desc:
      "Contrato sin respuesta. Activar el módulo de margen térmico IPMI en el recolector."
  },
  {
    order: "02",
    path: "network.optical_module_temp",
    desc:
      "Sin lectura del módulo óptico. Verificar permisos SNMP y reintentar el snapshot."
  },
  {
    order: "03",
    path: "psu.efficiency_index",
    desc:
      "PSU no expone índice de eficiencia. Actualizar firmware al canal estable v2.18."
  },
  {
    order: "04",
    path: "storage.smart.wearout_remaining",
    desc:
      "SMART devuelve null. Programar smartctl --all en el próximo ciclo y persistir el hash."
  }
];

function UnknownsRow() {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
      <CamposDesconocidos />
      <DatosFaltantes />
    </div>
  );
}

function CamposDesconocidos() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 14,
        padding: 20,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 12 }}>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Campos desconocidos
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            El contrato no devolvió valor en 4 campos · ordenados por prioridad
          </span>
        </div>
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-semibold"
          style={{ gap: 4, padding: "4px 8px", borderRadius: 4, background: "#EDE9FE", color: "#7C3AED" }}
        >
          <Info size={11} strokeWidth={1.75} aria-hidden="true" />
          4 sin valor
        </span>
      </header>

      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 8 }}>
        {UNKNOWN_ROWS.map((row) => (
          <li
            key={row.path}
            className="flex"
            style={{
              gap: 12,
              padding: "12px 14px",
              borderRadius: 4,
              background: "#EDE9FE",
              border: "1px solid #7C3AED"
            }}
          >
            <span
              aria-hidden="true"
              className="grid place-items-center text-[#FFFBF5] tabular-nums shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: 4,
                background: "#7C3AED",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 700
              }}
            >
              {row.order}
            </span>
            <div className="flex flex-col flex-1" style={{ gap: 4 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <code className="text-[12px] font-[family-name:var(--font-mono)] text-[#1A1410]">
                  {row.path}
                </code>
                <span className="flex-1" aria-hidden="true" />
                <span
                  className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#7C3AED]"
                  style={{ letterSpacing: "0.4px" }}
                >
                  sin valor
                </span>
              </div>
              <p className="m-0 text-[11px] font-[family-name:var(--font-caption)] leading-[1.45] text-[#5C544A]">
                {row.desc}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DatosFaltantes() {
  return (
    <section
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 20,
        borderRadius: 8,
        background: "#FEF3C7",
        border: "1px solid #B45309"
      }}
    >
      <header className="flex items-center" style={{ gap: 10 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{ width: 32, height: 32, borderRadius: 8, background: "#B45309", color: "#FFFBF5" }}
        >
          <Triangle size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Datos faltantes
          </h3>
          <span className="text-[10px] font-[family-name:var(--font-caption)] text-[#5C544A]">
            4 campos · 2 colectores afectados
          </span>
        </div>
      </header>

      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
        Los campos sin valor bloquean el cálculo del puntaje de salud. OpenClaw recomienda
        iniciar un snapshot manual antes del próximo ciclo de aprendizaje.
      </p>

      <div
        className="flex flex-col bg-[#FFFFFF]"
        style={{
          gap: 6,
          padding: "10px 12px",
          borderRadius: 4,
          border: "1px solid #EAE0CE"
        }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-[family-name:var(--font-caption)] font-semibold text-[#5C544A]">
            impacto en puntaje
          </span>
          <span className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[#B45309]">
            -12 puntos
          </span>
        </div>
        <div
          aria-hidden="true"
          className="overflow-hidden"
          style={{ height: 6, borderRadius: 3, background: "#EAE0CE" }}
        >
          <span style={{ display: "block", width: 120, height: 6, borderRadius: 3, background: "#B45309" }} />
        </div>
      </div>

      <button
        type="button"
        className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]"
        style={{ gap: 6, padding: "10px 12px", borderRadius: 6, background: "#1A1410" }}
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
const AUDIT_ROWS = [
  {
    ts: "2026-05-16 09:14:22",
    actor: "operador@delivrix",
    action: "snapshot.manual",
    detail: "nodo-04 · campo storage.smart.wearout_remaining",
    sourceText: "manual",
    sourceBg: "#F7F2EA",
    sourceFg: "#5C544A",
    sourceBorder: "#EAE0CE",
    rowBg: "transparent"
  },
  {
    ts: "2026-05-16 09:08:51",
    actor: "system.collector",
    action: "contract.evaluate",
    detail: "nodo-04 · 4 campos sin valor detectados",
    sourceText: "contract",
    sourceBg: "#DBEAFE",
    sourceFg: "#1D4ED8",
    sourceBorder: "#DBEAFE",
    rowBg: "#F7F2EA"
  },
  {
    ts: "2026-05-16 08:55:14",
    actor: "system.warming",
    action: "advance_stage",
    detail: "nodo-04 → día 7 del ciclo de aprendizaje",
    sourceText: "warming",
    sourceBg: "#DCFCE7",
    sourceFg: "#15803D",
    sourceBorder: "#DCFCE7",
    rowBg: "transparent"
  },
  {
    ts: "2026-05-16 08:42:07",
    actor: "openclaw.agent",
    action: "insight.propose",
    detail: "CPU sostenido alto · sugerir revisión clúster A",
    sourceText: "openclaw",
    sourceBg: "#EDE9FE",
    sourceFg: "#7C3AED",
    sourceBorder: "#EDE9FE",
    rowBg: "#F7F2EA"
  },
  {
    ts: "2026-05-16 08:31:48",
    actor: "system.collector",
    action: "inventory.refresh",
    detail: "nodo-04 · 7 componentes verificados · hash actualizado",
    sourceText: "contract",
    sourceBg: "#DBEAFE",
    sourceFg: "#1D4ED8",
    sourceBorder: "#DBEAFE",
    rowBg: "transparent"
  },
  {
    ts: "2026-05-16 08:20:11",
    actor: "operador@delivrix",
    action: "contract.review",
    detail: "abrir vista hardware · sólo lectura",
    sourceText: "review",
    sourceBg: "#FFFFFF",
    sourceFg: "#5C544A",
    sourceBorder: "#EAE0CE",
    rowBg: "#F7F2EA"
  }
];

function AuditFooter() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 12,
        padding: 20,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 12 }}>
        <div className="flex flex-col flex-1" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Registro de auditoría
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Últimas 6 acciones · trazabilidad sólo lectura
          </span>
        </div>
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-semibold"
          style={{ gap: 4, padding: "4px 8px", borderRadius: 4, background: "#DBEAFE", color: "#1D4ED8" }}
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
          background: "#F7F2EA"
        }}
      >
        {["TIMESTAMP", "ACTOR", "ACCIÓN", "DETALLE", "FUENTE"].map((h, i) => (
          <span
            key={h}
            className="text-[9px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
            style={{ letterSpacing: "0.6px", textAlign: i === 4 ? "right" : "left" }}
          >
            {h}
          </span>
        ))}
      </div>

      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 2 }}>
        {AUDIT_ROWS.map((row, i) => (
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
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{row.ts}</span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] font-medium text-[#EA580C] truncate">
              {row.actor}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] font-semibold text-[#1A1410] truncate">
              {row.action}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A] truncate">
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
