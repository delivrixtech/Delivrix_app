/**
 * Recolector y captura manual — port LITERAL desde Pencil frame `k70xK` / `SqPKX`.
 *
 * Estructura literal:
 *   Hero (Dl3tb)
 *   Tabs (yKT6P): Fuentes (activa) + Captura manual + help
 *   SourcesRow (KFzUx): 4 source cards (Archivo local / Proxmox / Prometheus / IPMI)
 *   OpenClaw Prompt thin gradient (a6nRY)
 *   AcceptedFieldsSection (t0dbV): tabla 6 columnas
 *   AuditSection (lCgdH)
 *   ExplainerSplit (W763AC)
 */

import {
  ArrowRight,
  Cpu,
  Database,
  FileText,
  Folder,
  Info,
  Server,
  Sparkles,
  Upload,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";

export function CollectorSection({ data }: { data: DashboardData }) {
  void data;
  return (
    <section className="flex flex-col" style={{ gap: 24, maxWidth: 1352 }}>
      <Hero />
      <Tabs />
      <SourcesRow />
      <OpenClawPromptWrap />
      <AcceptedFieldsSection />
      <AuditSection />
      <ExplainerSplit />
    </section>
  );
}

/* ============================================================
 * Hero (Dl3tb)
 * ============================================================ */
function Hero() {
  return (
    <header className="flex flex-col" style={{ gap: 10 }}>
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[#EA580C]"
        style={{ letterSpacing: "1.6px" }}
      >
        EVIDENCIA SUPERVISADA
      </span>
      <h1 className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]">
        Recolector y captura manual
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]" style={{ maxWidth: 760 }}>
        El panel es solo lectura. La evidencia entra desde fuentes supervisadas o desde un
        endpoint manual auditado fuera del panel.
      </p>
    </header>
  );
}

/* ============================================================
 * Tabs (yKT6P)
 * ============================================================ */
function Tabs() {
  return (
    <div
      className="flex items-end"
      style={{ borderBottom: "1px solid #EAE0CE" }}
    >
      <div
        className="inline-flex items-center"
        style={{
          gap: 8,
          padding: "14px 4px",
          borderBottom: "2px solid #EA580C",
          marginBottom: -1
        }}
      >
        <Database size={14} strokeWidth={1.75} className="text-[#1A1410]" aria-hidden="true" />
        <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
          Fuentes del recolector
        </span>
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-mono)] font-semibold text-[#5C544A]"
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: "#F7F2EA",
            border: "1px solid #EAE0CE"
          }}
        >
          4
        </span>
      </div>
      <div className="inline-flex items-center" style={{ gap: 8, padding: "14px 18px" }}>
        <Upload size={14} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
        <span className="text-[13px] font-[family-name:var(--font-sans)] font-medium text-[#5C544A]">
          Captura manual
        </span>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]"
          style={{ letterSpacing: "0.6px" }}
        >
          externo
        </span>
      </div>
      <span className="flex-1" aria-hidden="true" />
      <div className="inline-flex items-center" style={{ gap: 6, padding: "10px 4px" }}>
        <Info size={12} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
          Documentación de contratos
        </span>
      </div>
    </div>
  );
}

/* ============================================================
 * SourcesRow (KFzUx) — 4 source cards
 * ============================================================ */
const SOURCES = [
  {
    name: "Archivo local",
    icon: <Folder size={16} strokeWidth={1.75} aria-hidden="true" />,
    state: "LISTO",
    stateBg: "#DCFCE7",
    stateFg: "#15803D",
    confidence: 98,
    confidenceColor: "#15803D",
    endpoint: "SSH · /var/lib/delivrix/snapshots",
    mode: "solo lectura",
    lastSeen: "hace 14s"
  },
  {
    name: "Proxmox",
    icon: <Server size={16} strokeWidth={1.75} aria-hidden="true" />,
    state: "LISTO",
    stateBg: "#DCFCE7",
    stateFg: "#15803D",
    confidence: 94,
    confidenceColor: "#15803D",
    endpoint: "HTTPS · /api2/json/nodes",
    mode: "solo lectura",
    lastSeen: "hace 22s"
  },
  {
    name: "Prometheus",
    icon: <Cpu size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: "#B45309" }} />,
    state: "DESACTUALIZADO",
    stateBg: "#FEF3C7",
    stateFg: "#B45309",
    confidence: 41,
    confidenceColor: "#B45309",
    endpoint: "HTTP · /api/v1/query",
    mode: "solo lectura",
    lastSeen: "hace 6 min"
  },
  {
    name: "IPMI",
    icon: <Cpu size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: "#7C3AED" }} />,
    state: "DESCONOCIDO",
    stateBg: "#EDE9FE",
    stateFg: "#7C3AED",
    confidence: 0,
    confidenceColor: "#7C3AED",
    endpoint: "SSH · ipmitool sdr",
    mode: "solo lectura",
    lastSeen: "sin datos"
  }
];

function SourcesRow() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 14 }}>
      {SOURCES.map((s) => (
        <SourceCard key={s.name} {...s} />
      ))}
    </div>
  );
}

function SourceCard({
  name,
  icon,
  state,
  stateBg,
  stateFg,
  confidence,
  confidenceColor,
  endpoint,
  mode,
  lastSeen
}: typeof SOURCES[number]) {
  return (
    <article
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 14,
        padding: 16,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 10 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: "#F7F2EA",
            border: "1px solid #EAE0CE"
          }}
        >
          {icon}
        </span>
        <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-semibold text-[#1A1410]">
          {name}
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-flex items-center text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{
            gap: 4,
            padding: "2px 8px",
            borderRadius: 4,
            background: stateBg,
            color: stateFg,
            letterSpacing: "0.4px"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: stateFg }} />
          {state}
        </span>
      </header>

      <div className="flex items-end" style={{ gap: 8 }}>
        <span
          className="text-[26px] font-[family-name:var(--font-mono)] font-bold leading-none tabular-nums"
          style={{ letterSpacing: "-0.4px", color: confidenceColor }}
        >
          {confidence === 0 ? "—" : `${confidence}%`}
        </span>
        <span className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073] leading-none">
          confianza
        </span>
      </div>

      <div
        className="relative overflow-hidden w-full"
        style={{ height: 6, borderRadius: 3, background: "#F7F2EA" }}
        aria-hidden="true"
      >
        <span
          className="block"
          style={{
            width: `${confidence}%`,
            height: 6,
            borderRadius: 3,
            background: confidenceColor,
            opacity: confidence === 0 ? 0.4 : 1,
            minWidth: confidence === 0 ? 8 : undefined
          }}
        />
      </div>

      <div className="flex flex-col" style={{ gap: 6 }}>
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#1A1410]">{endpoint}</span>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#5C544A]"
            style={{ padding: "1px 6px", borderRadius: 4, background: "#F7F2EA", letterSpacing: "0.4px" }}
          >
            {mode}
          </span>
          <span className="flex-1" aria-hidden="true" />
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{lastSeen}</span>
        </div>
      </div>
    </article>
  );
}

/* ============================================================
 * OpenClaw Prompt Wrap (a6nRY) — thin gradient border
 * ============================================================ */
function OpenClawPromptWrap() {
  return (
    <div
      style={{
        borderRadius: 13,
        padding: 1.5,
        background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <div className="flex" style={{ gap: 24, padding: 24, borderRadius: 8, background: "#FFFBF5" }}>
        <div className="flex flex-col flex-1 min-w-0" style={{ gap: 12 }}>
          <header className="flex items-center" style={{ gap: 10 }}>
            <span
              aria-hidden="true"
              className="grid place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "linear-gradient(135deg, #FACC15 0%, #EA580C 100%)",
                color: "#FFFBF5"
              }}
            >
              <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <div className="flex flex-col" style={{ gap: 1 }}>
              <span className="text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
                OpenClaw
              </span>
              <span
                className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]"
                style={{ letterSpacing: "0.4px" }}
              >
                Operador supervisado
              </span>
            </div>
            <span className="flex-1" aria-hidden="true" />
            <span
              className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                padding: "2px 8px",
                borderRadius: 4,
                background: "#FEF3C7",
                color: "#B45309",
                letterSpacing: "0.4px"
              }}
            >
              aviso
            </span>
          </header>
          <p className="m-0 text-[15px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
            Prometheus no se ha refrescado en 6 minutos. ¿Quieres que investigue?
          </p>
          <div className="flex items-center" style={{ gap: 8 }}>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
              fuente · Prometheus · /api/v1/query
            </span>
            <span aria-hidden="true" style={{ width: 3, height: 3, borderRadius: 999, background: "#8A8073" }} />
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">hace 6 min</span>
          </div>
        </div>

        <div className="flex flex-col" style={{ gap: 10, width: 240 }}>
          <button
            type="button"
            className="inline-flex items-center justify-center text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]"
            style={{ gap: 8, padding: "12px 14px", borderRadius: 6, background: "#1A1410" }}
          >
            <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            Investigar fuente
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]"
            style={{
              gap: 8,
              padding: 12,
              borderRadius: 6,
              border: "1px solid #EAE0CE",
              background: "transparent"
            }}
          >
            <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
            Ver runbook
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * AcceptedFieldsSection (t0dbV) — tabla 6 columnas
 * ============================================================ */
const ACCEPTED_FIELDS = [
  {
    path: "physical_host.identity.hostname",
    type: "string",
    source: "Archivo local",
    sourceBg: "#DCFCE7",
    sourceFg: "#15803D",
    mapsTo: "physical_host.identity.label",
    requiredFor: "topology",
    rowState: "validado"
  },
  {
    path: "physical_host.capacity.cpu_cores",
    type: "integer",
    source: "Proxmox",
    sourceBg: "#DCFCE7",
    sourceFg: "#15803D",
    mapsTo: "capacity.cpuCores",
    requiredFor: "warming",
    rowState: "validado"
  },
  {
    path: "physical_host.capacity.memory_gb",
    type: "integer",
    source: "Proxmox",
    sourceBg: "#DCFCE7",
    sourceFg: "#15803D",
    mapsTo: "capacity.memoryGb",
    requiredFor: "warming",
    rowState: "validado"
  },
  {
    path: "telemetry.cpu.usage_percent",
    type: "float",
    source: "Prometheus",
    sourceBg: "#FEF3C7",
    sourceFg: "#B45309",
    mapsTo: "telemetry.cpu.usagePercent",
    requiredFor: "alerting",
    rowState: "desactualizado"
  },
  {
    path: "telemetry.memory.usage_percent",
    type: "float",
    source: "Prometheus",
    sourceBg: "#FEF3C7",
    sourceFg: "#B45309",
    mapsTo: "telemetry.memory.usagePercent",
    requiredFor: "alerting",
    rowState: "desactualizado"
  },
  {
    path: "sensors.ipmi.cpu0.thermal_margin",
    type: "float",
    source: "IPMI",
    sourceBg: "#EDE9FE",
    sourceFg: "#7C3AED",
    mapsTo: "telemetry.cpu.thermalStatus",
    requiredFor: "safety",
    rowState: "sin valor"
  }
];

function AcceptedFieldsSection() {
  return (
    <section className="flex flex-col" style={{ gap: 12 }}>
      <header className="flex items-end justify-between" style={{ gap: 16 }}>
        <div className="flex flex-col" style={{ gap: 4 }}>
          <h2 className="m-0 text-[18px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Campos aceptados
          </h2>
          <span className="text-[12px] font-[family-name:var(--font-sans)] text-[#5C544A]">
            Contrato firmado · valida cada snapshot antes de aceptarlo
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 10 }}>
          <span
            className="inline-flex items-center text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]"
            style={{
              gap: 6,
              padding: "4px 8px",
              borderRadius: 4,
              background: "#F7F2EA",
              border: "1px solid #EAE0CE"
            }}
          >
            schema · 5.10.0
          </span>
          <span
            className="inline-flex items-center text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]"
            style={{
              gap: 6,
              padding: "4px 8px",
              borderRadius: 4,
              background: "#F7F2EA",
              border: "1px solid #EAE0CE"
            }}
          >
            6 / 6 requeridos
          </span>
        </div>
      </header>

      <div
        className="bg-[#FFFFFF]"
        style={{
          borderRadius: 8,
          border: "1px solid #EAE0CE",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
          overflow: "hidden"
        }}
      >
        <div
          className="grid items-center"
          style={{
            gridTemplateColumns: "260px 150px 170px 180px 130px minmax(0,1fr)",
            gap: 16,
            padding: "14px 16px",
            background: "#F7F2EA",
            borderBottom: "1px solid #EAE0CE"
          }}
        >
          {["PATH", "TIPO", "FUENTE", "MAPEO INTERNO", "REQUERIDO PARA", "ESTADO"].map((h) => (
            <span
              key={h}
              className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
              style={{ letterSpacing: "0.6px" }}
            >
              {h}
            </span>
          ))}
        </div>

        {ACCEPTED_FIELDS.map((row, i) => (
          <div
            key={row.path}
            className="grid items-center"
            style={{
              gridTemplateColumns: "260px 150px 170px 180px 130px minmax(0,1fr)",
              gap: 16,
              padding: "14px 16px",
              borderTop: i > 0 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <div className="flex flex-col" style={{ gap: 2 }}>
              <code className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[#1A1410] truncate">
                {row.path}
              </code>
              <span className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]">
                vía contrato
              </span>
            </div>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]">{row.type}</span>
            <span
              className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                gap: 6,
                padding: "3px 8px",
                borderRadius: 4,
                background: row.sourceBg,
                color: row.sourceFg,
                letterSpacing: "0.4px",
                width: "fit-content"
              }}
            >
              {row.source}
            </span>
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A] truncate">
              {row.mapsTo}
            </code>
            <span className="text-[11px] font-[family-name:var(--font-sans)] text-[#5C544A]">{row.requiredFor}</span>
            <span
              className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                gap: 6,
                padding: "3px 8px",
                borderRadius: 999,
                background:
                  row.rowState === "validado"
                    ? "#DCFCE7"
                    : row.rowState === "desactualizado"
                      ? "#FEF3C7"
                      : "#EDE9FE",
                color:
                  row.rowState === "validado"
                    ? "#15803D"
                    : row.rowState === "desactualizado"
                      ? "#B45309"
                      : "#7C3AED",
                letterSpacing: "0.4px",
                width: "fit-content"
              }}
            >
              {row.rowState}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ============================================================
 * AuditSection
 * ============================================================ */
const AUDIT_ROWS = [
  ["09:18:42", "operador@delivrix", "snapshot.manual", "nodo-04 · field storage.smart.wearout_remaining", "8c41…b2d"],
  ["09:14:21", "system.collector", "contract.evaluate", "nodo-04 · 4 campos sin valor detectados", "4f7a…1c9"],
  ["09:04:11", "openclaw.agent", "insight.propose", "CPU sostenido alto · sugerir revisión clúster A", "7d41…f1a"],
  ["08:55:14", "system.warming", "advance_stage", "nodo-04 → día 7 del ciclo de aprendizaje", "a2c0…b91"],
  ["08:42:09", "operador@delivrix", "contract.review", "abrir vista recolector · sólo lectura", "c54f…908"]
];

function AuditSection() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ gap: 12, padding: 20, borderRadius: 8, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center" style={{ gap: 12 }}>
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Bitácora de ingesta
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Append-only · contrato /v1/devops/collector/audit
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            gap: 4,
            padding: "3px 8px",
            borderRadius: 4,
            background: "#DBEAFE",
            color: "#1D4ED8"
          }}
        >
          hashes verificados
        </span>
      </header>

      <div
        className="grid"
        style={{
          gridTemplateColumns: "80px 180px 220px minmax(0,1fr) 80px",
          gap: 12,
          padding: "8px 12px",
          background: "#F7F2EA",
          borderRadius: 4
        }}
      >
        {["HORA", "ACTOR", "ACCIÓN", "DETALLE", "HASH"].map((h) => (
          <span
            key={h}
            className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
            style={{ letterSpacing: "0.6px" }}
          >
            {h}
          </span>
        ))}
      </div>

      <ul className="m-0 p-0 list-none flex flex-col">
        {AUDIT_ROWS.map(([ts, actor, action, detail, hash], i) => (
          <li
            key={i}
            className="grid items-center"
            style={{
              gridTemplateColumns: "80px 180px 220px minmax(0,1fr) 80px",
              gap: 12,
              padding: "8px 12px",
              borderTop: i > 0 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A]">{ts}</span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] font-semibold text-[#EA580C] truncate">
              {actor}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] font-semibold text-[#1A1410]">
              {action}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A] truncate">
              {detail}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{hash}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================================================
 * ExplainerSplit
 * ============================================================ */
function ExplainerSplit() {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ExplainerText />
      <CliSnippet />
    </div>
  );
}

function ExplainerText() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ gap: 12, padding: 20, borderRadius: 8, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
        Por qué la ingesta vive fuera del panel
      </h2>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        El admin panel es 100% GET. La ingesta supervisada de snapshots requiere un operador con
        rol elevado corriendo el CLI fuera del panel. Esto preserva la barandilla read-only del
        norte operativo y evita un POST cliente que pudiera ser comprometido.
      </p>
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
        {[
          "physical_host.identity.* → tabla physical_hosts",
          "physical_host.capacity.* → tabla capacities",
          "telemetry.* → series timescaled · 60 s",
          "sensors.ipmi.* → tabla sensors"
        ].map((l) => (
          <li
            key={l}
            className="inline-flex items-center"
            style={{
              gap: 8,
              padding: "8px 12px",
              borderRadius: 6,
              background: "#F7F2EA"
            }}
          >
            <ArrowRight size={11} strokeWidth={2} className="text-[#EA580C]" aria-hidden="true" />
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410]">{l}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CliSnippet() {
  const lines = [
    { tone: "input" as const, text: "$ delivrix collector capture --source proxmox" },
    { tone: "info" as const, text: "› authenticating with operator role…" },
    { tone: "success" as const, text: "✓ snapshot signed sha256:a3f1bd…" },
    { tone: "info" as const, text: "› posting to /v1/devops/collector/snapshots" },
    { tone: "success" as const, text: "✓ accepted, schema 5.10.0" },
    { tone: "info" as const, text: "› hash registered in audit log" }
  ];
  const colors: Record<"input" | "info" | "success" | "error", string> = {
    input: "#FFFBF5",
    info: "#FACC15",
    success: "#86EFAC",
    error: "#F87171"
  };
  return (
    <section
      style={{
        borderRadius: 8,
        background: "#1A1410",
        border: "1px solid #1A1410",
        overflow: "hidden",
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.18)"
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{ gap: 12, padding: "10px 14px", borderBottom: "1px solid rgba(255, 251, 245, 0.13)" }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              aria-hidden="true"
              style={{ width: 10, height: 10, borderRadius: 999, background: "rgba(255, 251, 245, 0.15)" }}
            />
          ))}
          <span
            className="ml-2 text-[11px] font-[family-name:var(--font-mono)]"
            style={{ color: "rgba(255, 251, 245, 0.7)" }}
          >
            delivrix-cli — captura manual
          </span>
        </div>
        <button
          type="button"
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-mono)]"
          style={{ gap: 6, padding: "4px 8px", borderRadius: 4, background: "rgba(255, 251, 245, 0.08)", color: "#FFFBF5" }}
        >
          copy
        </button>
      </header>
      <pre className="m-0 overflow-x-auto" style={{ padding: "16px 20px" }}>
        <code className="block text-[12px] font-[family-name:var(--font-mono)] leading-relaxed">
          {lines.map((line, i) => (
            <span key={i} className="block whitespace-pre" style={{ color: colors[line.tone] }}>
              {line.text}
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
}
