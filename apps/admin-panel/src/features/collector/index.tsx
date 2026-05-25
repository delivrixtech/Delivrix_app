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
import { filterAuditEvents, formatTimeOnly, shortAuditHash } from "../../shared/lib/formatters.ts";
import { BannerOpenClawV2 } from "../../shared/ui/v2/index.ts";

export function CollectorSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col" style={{ gap: 24 }}>
      <Hero />
      <Tabs sourcesCount={data.supervisedCollector.sources.length} />
      <SourcesRow data={data} />
      <OpenClawPromptWrap data={data} />
      <AcceptedFieldsSection data={data} />
      <AuditSection data={data} />
      <ExplainerSplit data={data} />
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
        className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[var(--color-accent-tertiary)]"
        style={{ letterSpacing: "var(--tracking-widest)" }}
      >
        EVIDENCIA SUPERVISADA
      </span>
      <h1 className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]">
        Recolector y captura manual
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]" style={{ maxWidth: 760 }}>
        El panel es solo lectura. La evidencia entra desde fuentes supervisadas o desde un
        endpoint manual auditado fuera del panel.
      </p>
    </header>
  );
}

/* ============================================================
 * Tabs (yKT6P)
 * ============================================================ */
function Tabs({ sourcesCount }: { sourcesCount: number }) {
  return (
    <div
      className="flex items-end"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <div
        className="inline-flex items-center"
        style={{
          gap: 8,
          padding: "14px 4px",
          borderBottom: "2px solid var(--color-accent-tertiary)",
          marginBottom: -1
        }}
      >
        <Database size={14} strokeWidth={1.75} className="text-[var(--color-text-primary)]" aria-hidden="true" />
        <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Fuentes del recolector
        </span>
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-secondary)]"
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border)"
          }}
        >
          {sourcesCount}
        </span>
      </div>
      <div className="inline-flex items-center" style={{ gap: 8, padding: "14px 18px" }}>
        <Upload size={14} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
        <span className="text-[13px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-secondary)]">
          Captura manual
        </span>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]"
          style={{ letterSpacing: "var(--tracking-wider)" }}
        >
          externo
        </span>
      </div>
      <span className="flex-1" aria-hidden="true" />
      <div className="inline-flex items-center" style={{ gap: 6, padding: "10px 4px" }}>
        <Info size={12} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          Documentación de contratos
        </span>
      </div>
    </div>
  );
}

/* ============================================================
 * SourcesRow (KFzUx) — 4 source cards
 * ============================================================ */
function statusStyle(status: string): {
  state: string;
  stateBg: string;
  stateFg: string;
  confidenceColor: string;
  confidence: number;
} {
  const t = status.toLowerCase();
  if (t === "ready" || t === "ok" || t === "fresh")
    return { state: "LISTO", stateBg: "var(--color-success-soft)", stateFg: "var(--color-success)", confidenceColor: "var(--color-success)", confidence: 95 };
  if (t === "needs_review" || t === "stale")
    return {
      state: "DESACTUALIZADO",
      stateBg: "var(--color-warning-soft)",
      stateFg: "var(--color-warning)",
      confidenceColor: "var(--color-warning)",
      confidence: 45
    };
  if (t === "blocked" || t === "critical")
    return { state: "BLOQUEADO", stateBg: "var(--color-critical-soft)", stateFg: "var(--color-critical)", confidenceColor: "var(--color-critical)", confidence: 15 };
  if (t === "unknown")
    return { state: "DESCONOCIDO", stateBg: "var(--color-unknown-soft)", stateFg: "var(--color-unknown)", confidenceColor: "var(--color-unknown)", confidence: 0 };
  return { state: status.toUpperCase(), stateBg: "var(--color-neutral-soft)", stateFg: "var(--color-text-secondary)", confidenceColor: "var(--color-text-secondary)", confidence: 50 };
}

function sourceIcon(kind: string): React.ReactNode {
  const t = kind.toLowerCase();
  if (t.includes("file") || t.includes("local")) return <Folder size={16} strokeWidth={1.75} aria-hidden="true" />;
  if (t.includes("proxmox") || t.includes("api")) return <Server size={16} strokeWidth={1.75} aria-hidden="true" />;
  if (t.includes("prometheus") || t.includes("metric"))
    return <Cpu size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-warning)" }} />;
  if (t.includes("ipmi") || t.includes("sensor"))
    return <Cpu size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-unknown)" }} />;
  return <Database size={16} strokeWidth={1.75} aria-hidden="true" />;
}

function relativeAge(iso: string | null | undefined): string {
  if (!iso) return "sin datos";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "sin datos";
  const diff = Math.max(0, Date.now() - t);
  if (diff < 60_000) return `hace ${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `hace ${Math.round(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.round(diff / 3_600_000)} h`;
  return `hace ${Math.round(diff / 86_400_000)} d`;
}

function SourcesRow({ data }: { data: DashboardData }) {
  const sources = data.supervisedCollector.sources ?? [];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 14 }}>
      {sources.map((s) => {
        const style = statusStyle(s.status);
        return (
          <SourceCard
            key={s.id}
            name={s.label}
            icon={sourceIcon(s.kind)}
            state={style.state}
            stateBg={style.stateBg}
            stateFg={style.stateFg}
            confidence={style.confidence}
            confidenceColor={style.confidenceColor}
            endpoint={
              s.safeCollection.endpoint
                ? `${s.safeCollection.transport.toUpperCase()} · ${s.safeCollection.endpoint}`
                : s.safeCollection.commandPreview || s.safeCollection.transport
            }
            mode={s.readOnly ? "solo lectura" : "rw"}
            lastSeen={relativeAge(s.freshness.lastCollectedAt)}
          />
        );
      })}
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
}: {
  name: string;
  icon: React.ReactNode;
  state: string;
  stateBg: string;
  stateFg: string;
  confidence: number;
  confidenceColor: string;
  endpoint: string;
  mode: string;
  lastSeen: string;
}) {
  return (
    <article
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 14,
        padding: 16,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)"
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
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border)"
          }}
        >
          {icon}
        </span>
        <h3 className="m-0 text-[14px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
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
            letterSpacing: "var(--tracking-wide)"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: stateFg }} />
          {state}
        </span>
      </header>

      <div className="flex items-end" style={{ gap: 8 }}>
        <span
          className="text-[26px] font-[family-name:var(--font-mono)] font-bold leading-none tabular-nums"
          style={{ letterSpacing: "var(--tracking-tightest)", color: confidenceColor }}
        >
          {confidence === 0 ? "—" : `${confidence}%`}
        </span>
        <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)] leading-none">
          confianza
        </span>
      </div>

      <div
        className="relative overflow-hidden w-full"
        style={{ height: 6, borderRadius: 3, background: "var(--color-surface-sunken)" }}
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
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{endpoint}</span>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[var(--color-text-secondary)]"
            style={{ padding: "1px 6px", borderRadius: 4, background: "var(--color-surface-sunken)", letterSpacing: "var(--tracking-wide)" }}
          >
            {mode}
          </span>
          <span className="flex-1" aria-hidden="true" />
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{lastSeen}</span>
        </div>
      </div>
    </article>
  );
}

/* ============================================================
 * OpenClaw Prompt — migrado a BannerOpenClawV2 (~145 LOC duplicadas eliminadas).
 * Mantiene la lógica de derivación de mensaje por estado de fuente
 * (blocked > stale > unknown > ok); el chrome es ahora el del building block v2.
 * ============================================================ */
function OpenClawPromptWrap({ data }: { data: DashboardData }) {
  const stale = data.supervisedCollector.sources.find(
    (s) => s.status === "needs_review" || s.freshness.stale
  );
  const blocked = data.supervisedCollector.sources.find((s) => s.status === "blocked");
  const unknown = data.supervisedCollector.sources.find((s) => s.status === "unknown");
  let title = "Fuentes dentro del umbral";
  let body: string = "Todas las fuentes están dentro del umbral de frescura. Puedo proponer el próximo ciclo de captura.";
  if (blocked) {
    title = `${blocked.label} bloqueado`;
    body = `${blocked.label} está bloqueado: ${blocked.blockedBy[0] ?? "sin contexto"}. Frescura ${relativeAge(blocked.freshness.lastCollectedAt)}.`;
  } else if (stale) {
    title = `${stale.label} stale`;
    body = `${stale.label} no se ha refrescado en ${relativeAge(stale.freshness.lastCollectedAt)}. ¿Quieres que investigue?`;
  } else if (unknown) {
    title = `${unknown.label} sin datos`;
    body = `${unknown.label} aún sin datos. Coordina con el operador para activar el snapshot inicial.`;
  }
  return (
    <BannerOpenClawV2
      title={title}
      body={body}
      primaryCta="Investigar fuente"
      secondaryCta="Ver runbook"
    />
  );
}

/* ============================================================
 * AcceptedFieldsSection (t0dbV) — tabla 6 columnas
 * ============================================================ */
function sourceStylePill(kind: string): { bg: string; fg: string } {
  const t = kind.toLowerCase();
  if (t.includes("file") || t.includes("local") || t.includes("proxmox") || t === "manual")
    return { bg: "var(--color-success-soft)", fg: "var(--color-success)" };
  if (t.includes("prometheus") || t.includes("http")) return { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" };
  if (t.includes("ipmi") || t.includes("sensor")) return { bg: "var(--color-unknown-soft)", fg: "var(--color-unknown)" };
  return { bg: "var(--color-info-soft)", fg: "var(--color-info)" };
}

function AcceptedFieldsSection({ data }: { data: DashboardData }) {
  const fields = data.snapshotIngestion.acceptedFieldPaths ?? [];
  const schemaVersion = data.snapshotIngestion.snapshotSchemaVersion;
  const requiredCount = fields.filter((f) => f.requiredFor !== "optional").length;
  const rows = fields.map((f) => {
    const matchingSource = data.supervisedCollector.sources.find((s) =>
      f.path.toLowerCase().includes(s.kind.toLowerCase())
    );
    const sourceName = matchingSource ? matchingSource.label : "contrato";
    const sourcePill = sourceStylePill(matchingSource?.kind || "contrato");
    const sourceStatus = matchingSource?.status ?? "ready";
    const rowState =
      sourceStatus === "blocked"
        ? "sin valor"
        : sourceStatus === "needs_review"
          ? "desactualizado"
          : sourceStatus === "unknown"
            ? "sin valor"
            : "validado";
    return {
      path: f.path,
      type: f.type,
      source: sourceName,
      sourceBg: sourcePill.bg,
      sourceFg: sourcePill.fg,
      mapsTo: f.mapsTo,
      requiredFor: f.requiredFor,
      rowState
    };
  });
  void requiredCount;
  return <AcceptedFieldsTable rows={rows} schemaVersion={schemaVersion} requiredCount={requiredCount} />;
}

function AcceptedFieldsTable({
  rows,
  schemaVersion,
  requiredCount
}: {
  rows: Array<{
    path: string;
    type: string;
    source: string;
    sourceBg: string;
    sourceFg: string;
    mapsTo: string;
    requiredFor: string;
    rowState: string;
  }>;
  schemaVersion: string;
  requiredCount: number;
}) {
  const ACCEPTED_FIELDS = rows;
  return (
    <section className="flex flex-col" style={{ gap: 12 }}>
      <header className="flex items-end justify-between" style={{ gap: 16 }}>
        <div className="flex flex-col" style={{ gap: 4 }}>
          <h2 className="m-0 text-[18px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            Campos aceptados
          </h2>
          <span className="text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">
            Contrato firmado · valida cada snapshot antes de aceptarlo
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 10 }}>
          <span
            className="inline-flex items-center text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]"
            style={{
              gap: 6,
              padding: "4px 8px",
              borderRadius: 4,
              background: "var(--color-surface-sunken)",
              border: "1px solid var(--color-border)"
            }}
          >
            schema · {schemaVersion}
          </span>
          <span
            className="inline-flex items-center text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]"
            style={{
              gap: 6,
              padding: "4px 8px",
              borderRadius: 4,
              background: "var(--color-surface-sunken)",
              border: "1px solid var(--color-border)"
            }}
          >
            {requiredCount} / {ACCEPTED_FIELDS.length} requeridos
          </span>
        </div>
      </header>

      <div
        className="bg-[var(--color-surface)]"
        style={{
          borderRadius: 8,
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-sm)",
          overflow: "hidden"
        }}
      >
        <div
          className="grid items-center"
          style={{
            gridTemplateColumns: "260px 150px 170px 180px 130px minmax(0,1fr)",
            gap: 16,
            padding: "14px 16px",
            background: "var(--color-surface-sunken)",
            borderBottom: "1px solid var(--color-border)"
          }}
        >
          {["PATH", "TIPO", "FUENTE", "MAPEO INTERNO", "REQUERIDO PARA", "ESTADO"].map((h) => (
            <span
              key={h}
              className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
              style={{ letterSpacing: "var(--tracking-wider)" }}
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
              borderTop: i > 0 ? "1px solid var(--color-border)" : "none"
            }}
          >
            <div className="flex flex-col" style={{ gap: 2 }}>
              <code className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-primary)] truncate">
                {row.path}
              </code>
              <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
                vía contrato
              </span>
            </div>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">{row.type}</span>
            <span
              className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                gap: 6,
                padding: "3px 8px",
                borderRadius: 4,
                background: row.sourceBg,
                color: row.sourceFg,
                letterSpacing: "var(--tracking-wide)",
                width: "fit-content"
              }}
            >
              {row.source}
            </span>
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] truncate">
              {row.mapsTo}
            </code>
            <span className="text-[11px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">{row.requiredFor}</span>
            <span
              className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                gap: 6,
                padding: "3px 8px",
                borderRadius: 999,
                background:
                  row.rowState === "validado"
                    ? "var(--color-success-soft)"
                    : row.rowState === "desactualizado"
                      ? "var(--color-warning-soft)"
                      : "var(--color-unknown-soft)",
                color:
                  row.rowState === "validado"
                    ? "var(--color-success)"
                    : row.rowState === "desactualizado"
                      ? "var(--color-warning)"
                      : "var(--color-unknown)",
                letterSpacing: "var(--tracking-wide)",
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
function buildAuditRows(data: DashboardData): Array<[string, string, string, string, string]> {
  const events = filterAuditEvents(
    data.auditEvents,
    ["collector", "snapshot", "source", "manual_snapshot", "ingestion", "supervised"],
    5
  );
  if (events.length === 0) {
    return [["—", "—", "sin audit", "el contrato no registró eventos de ingesta todavía", "—"]];
  }
  return events.map((e) => [
    formatTimeOnly(e.occurredAt),
    `${e.actorType}${e.actorId ? `.${e.actorId}` : ""}`.slice(0, 28),
    e.action,
    `${e.targetType} · ${e.targetId}`,
    shortAuditHash(e.id)
  ]);
}

function AuditSection({ data }: { data: DashboardData }) {
  const rows = buildAuditRows(data);
  return <AuditTable rows={rows} />;
}

function AuditTable({ rows }: { rows: Array<[string, string, string, string, string]> }) {
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{ gap: 12, padding: 20, borderRadius: 8, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header className="flex items-center" style={{ gap: 12 }}>
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            Bitácora de ingesta
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
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
            background: "var(--color-info-soft)",
            color: "var(--color-info)"
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
          background: "var(--color-surface-sunken)",
          borderRadius: 4
        }}
      >
        {["HORA", "ACTOR", "ACCIÓN", "DETALLE", "HASH"].map((h) => (
          <span
            key={h}
            className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
            style={{ letterSpacing: "var(--tracking-wider)" }}
          >
            {h}
          </span>
        ))}
      </div>

      <ul className="m-0 p-0 list-none flex flex-col">
        {rows.map(([ts, actor, action, detail, hash], i) => (
          <li
            key={i}
            className="grid items-center"
            style={{
              gridTemplateColumns: "80px 180px 220px minmax(0,1fr) 80px",
              gap: 12,
              padding: "8px 12px",
              borderTop: i > 0 ? "1px solid var(--color-border)" : "none"
            }}
          >
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">{ts}</span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-accent-tertiary)] truncate">
              {actor}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-primary)]">
              {action}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] truncate">
              {detail}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{hash}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================================================
 * ExplainerSplit
 * ============================================================ */
function ExplainerSplit({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ExplainerText data={data} />
      <CliSnippet />
    </div>
  );
}

function ExplainerText({ data }: { data: DashboardData }) {
  const outputs =
    data.snapshotIngestion.parserOutputs?.slice(0, 4) ??
    [
      "physical_host.identity.* → tabla physical_hosts",
      "physical_host.capacity.* → tabla capacities",
      "telemetry.* → series timescaled · 60 s",
      "sensors.ipmi.* → tabla sensors"
    ];
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{ gap: 12, padding: 20, borderRadius: 8, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <h2 className="m-0 text-[14px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
        Por qué la ingesta vive fuera del panel
      </h2>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
        El admin panel es 100% GET. La ingesta supervisada de snapshots requiere un operador con
        rol elevado corriendo el CLI fuera del panel. Esto preserva la barandilla read-only del
        norte operativo y evita un POST cliente que pudiera ser comprometido.
      </p>
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
        {outputs.map((l) => (
          <li
            key={l}
            className="inline-flex items-center"
            style={{
              gap: 8,
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--color-surface-sunken)"
            }}
          >
            <ArrowRight size={11} strokeWidth={2} className="text-[var(--color-accent-tertiary)]" aria-hidden="true" />
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{l}</code>
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
    input: "var(--color-on-dark-strong)",
    info: "var(--color-accent-secondary)",
    success: "var(--color-success-border)",
    error: "var(--color-critical)"
  };
  return (
    <section
      style={{
        borderRadius: 8,
        background: "var(--color-surface-inverse)",
        border: "1px solid var(--color-on-dark-hint)",
        overflow: "hidden",
        boxShadow: "var(--shadow-md)"
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{ gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--color-on-dark-faint)" }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              aria-hidden="true"
              style={{ width: 10, height: 10, borderRadius: 999, background: "var(--color-on-dark-faint)" }}
            />
          ))}
          <span
            className="ml-2 text-[11px] font-[family-name:var(--font-mono)]"
            style={{ color: "var(--color-on-dark-medium)" }}
          >
            delivrix-cli — captura manual
          </span>
        </div>
        <button
          type="button"
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-mono)]"
          style={{ gap: 6, padding: "4px 8px", borderRadius: 4, background: "var(--color-on-dark-hint)", color: "var(--color-on-dark-strong)" }}
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
