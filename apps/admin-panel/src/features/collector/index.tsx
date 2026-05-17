/**
 * Recolector y captura manual — port desde Pencil frame `k70xK` / `SqPKX`.
 *
 * Estructura:
 *   Hero (Dl3tb): PageHeader vertical
 *   Tabs (yKT6P): bottom-border tab strip
 *   SourcesRow (KFzUx): grid de source cards (htIra)
 *   OpenClaw Prompt thin gradient wrap (a6nRY): cornerRadius 13 padding 1.5
 *   AcceptedFieldsSection (t0dbV): contract field rows (NavoK)
 *   AuditSection (lCgdH): audit row table (qPKvl)
 *   ExplainerSplit (W763AC): CLI snippet (WIXCb) + helper text
 */

import { useState } from "react";
import { ArrowUp, Copy, Sparkles, WandSparkles } from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatDateTime,
  formatNumber,
  humanize
} from "../../shared/lib/formatters.ts";

type TabKey = "fuentes" | "ingesta" | "politica";

export function CollectorSection({ data }: { data: DashboardData }) {
  const [tab, setTab] = useState<TabKey>("fuentes");
  const collector = data.supervisedCollector;
  const ingestion = data.snapshotIngestion;

  return (
    <section className="flex flex-col gap-6" style={{ maxWidth: 1352 }}>
      <Hero collector={collector} />
      <Tabs current={tab} onChange={setTab} />

      {tab === "fuentes" ? <SourcesRow sources={collector.sources} /> : null}
      {tab === "ingesta" ? <AcceptedFieldsSection ingestion={ingestion} /> : null}
      {tab === "politica" ? <PoliticaPanel collector={collector} ingestion={ingestion} /> : null}

      <OpenClawPromptThin collector={collector} />
      <AuditSection collector={collector} />
      <ExplainerSplit ingestion={ingestion} />
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Hero
 * ------------------------------------------------------------------------ */
function Hero({ collector }: { collector: DashboardData["supervisedCollector"] }) {
  return (
    <header className="flex flex-col gap-2.5">
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
        style={{ letterSpacing: "1.2px" }}
      >
        DEVOPS · {compactLabel(collector.collectorMode).toUpperCase()}
      </span>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Recolector y captura manual
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Fuentes supervisadas read-only y contrato de la ingesta manual. El panel jamás postea
        snapshots; el endpoint manual vive en CLI fuera de la UI.
      </p>
    </header>
  );
}

/* --------------------------------------------------------------------------
 * Tabs
 * ------------------------------------------------------------------------ */
function Tabs({ current, onChange }: { current: TabKey; onChange: (k: TabKey) => void }) {
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "fuentes", label: "Fuentes" },
    { key: "ingesta", label: "Ingesta manual" },
    { key: "politica", label: "Política" }
  ];
  return (
    <div className="flex items-end gap-1 border-b border-[#EAE0CE]" style={{ marginBottom: -1 }}>
      {tabs.map((t) => {
        const active = t.key === current;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className="relative px-3.5 py-2.5 text-[13px] font-[family-name:var(--font-sans)] transition-colors"
            style={{
              color: active ? "#1A1410" : "#5C544A",
              fontWeight: active ? 600 : 500
            }}
          >
            {t.label}
            <span
              aria-hidden="true"
              className="absolute left-0 right-0 -bottom-px h-px"
              style={{ background: active ? "#EA580C" : "transparent" }}
            />
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Sources row — grid de source cards (Pencil htIra)
 * ------------------------------------------------------------------------ */
function SourcesRow({ sources }: { sources: DashboardData["supervisedCollector"]["sources"] }) {
  return (
    <div className="grid gap-3.5 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
      {sources.map((source) => (
        <SourceCard key={source.id} source={source} />
      ))}
    </div>
  );
}

function SourceCard({
  source
}: {
  source: DashboardData["supervisedCollector"]["sources"][number];
}) {
  const tonePill = sourcePill(source.status);
  return (
    <article
      className="flex flex-col gap-3.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)", minWidth: 240 }}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1 min-w-0">
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
            style={{ letterSpacing: "1.2px" }}
          >
            {humanize(source.kind)}
          </span>
          <h3 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            {source.label}
          </h3>
        </div>
        <span
          className="inline-block rounded-[4px] px-2 py-1 text-[10px] font-[family-name:var(--font-caption)] font-bold whitespace-nowrap"
          style={{ background: tonePill.bg, color: tonePill.fg }}
        >
          {compactLabel(source.status)}
        </span>
      </header>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        {source.purpose}
      </p>
      <dl className="m-0 flex flex-col gap-1.5">
        <SourceRow label="permiso" value={compactLabel(source.minimumPermission)} />
        <SourceRow label="secreto" value={source.safeCollection.requiresSecret ? "required" : "not required"} />
        <SourceRow label="writes" value={source.safeCollection.writesEnabled ? "enabled" : "disabled"} />
        <SourceRow
          label="frescura"
          value={source.freshness.lastCollectedAt ? formatDateTime(source.freshness.lastCollectedAt) : "unknown"}
        />
      </dl>
      {source.safeCollection.commandPreview ? (
        <code className="block rounded-[6px] bg-[#F7F2EA] px-2.5 py-2 text-[10px] font-[family-name:var(--font-mono)] text-[#5C544A] overflow-x-auto">
          {source.safeCollection.commandPreview}
        </code>
      ) : null}
      {source.blockedBy.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {source.blockedBy.map((blocker) => (
            <span
              key={blocker}
              className="inline-block rounded-[4px] px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)]"
              style={{ background: "#FEE2E2", color: "#B91C1C" }}
            >
              {humanize(blocker)}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function SourceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt
        className="m-0 text-[10px] font-[family-name:var(--font-caption)] uppercase text-[#8A8073]"
        style={{ letterSpacing: "0.4px" }}
      >
        {label}
      </dt>
      <dd className="m-0 text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410] tabular-nums truncate">
        {value}
      </dd>
    </div>
  );
}

function sourcePill(status: string): { bg: string; fg: string } {
  const t = status.toLowerCase();
  if (t === "ready" || t === "ok" || t === "fresh") return { bg: "#DCFCE7", fg: "#15803D" };
  if (t === "needs_review" || t === "stale") return { bg: "#FEF3C7", fg: "#B45309" };
  if (t === "blocked" || t === "critical") return { bg: "#FEE2E2", fg: "#B91C1C" };
  if (t === "unknown") return { bg: "#EDE9FE", fg: "#7C3AED" };
  return { bg: "#F5F5F4", fg: "#5C544A" };
}

/* --------------------------------------------------------------------------
 * AcceptedFieldsSection
 * ------------------------------------------------------------------------ */
function AcceptedFieldsSection({
  ingestion
}: {
  ingestion: DashboardData["snapshotIngestion"];
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Campos aceptados
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          schema {ingestion.snapshotSchemaVersion}
        </span>
      </header>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[#5C544A]">
        {ingestion.manualEndpoint.method} {ingestion.manualEndpoint.path} —
        {ingestion.manualEndpoint.requiresHumanApproval ? " requiere aprobación humana" : " sin aprobación"}.
      </p>
      <ul className="m-0 p-0 list-none flex flex-col">
        {ingestion.acceptedFieldPaths.slice(0, 12).map((field, i) => (
          <li
            key={field.path}
            className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 ${
              i < ingestion.acceptedFieldPaths.length - 1 ? "border-b border-[#EAE0CE]" : ""
            }`}
          >
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410] truncate">
              {field.path}
            </code>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">→</span>
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[#EA580C] truncate">
              {field.mapsTo}
            </code>
            <span
              className="inline-block rounded-[4px] px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                background: field.requiredFor === "optional" ? "#F5F5F4" : "#DBEAFE",
                color: field.requiredFor === "optional" ? "#5C544A" : "#1D4ED8",
                letterSpacing: "0.4px"
              }}
            >
              {field.requiredFor}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Politica
 * ------------------------------------------------------------------------ */
function PoliticaPanel({
  collector,
  ingestion
}: {
  collector: DashboardData["supervisedCollector"];
  ingestion: DashboardData["snapshotIngestion"];
}) {
  return (
    <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
      <PolicySection title="Ingestion policy">
        {[
          ["Manual snapshot", collector.ingestionPolicy.acceptsManualSnapshot ? "enabled" : "disabled"],
          ["Live mutation", collector.ingestionPolicy.acceptsLiveMutation ? "enabled" : "disabled"],
          ["Source changes", collector.ingestionPolicy.requiresOperatorApprovalForSourceChange ? "approval required" : "open"],
          ["Raw secrets", collector.ingestionPolicy.storesRawSecrets ? "stored" : "rejected"],
          ["Snapshot hash", collector.auditPolicy.snapshotHashRequired ? "required" : "optional"]
        ].map(([label, value]) => (
          <PolicyRow key={label} label={label} value={value} />
        ))}
      </PolicySection>
      <PolicySection title="UI policy">
        {[
          ["Admin panel writes", ingestion.uiPolicy.adminPanelCanPost ? "enabled" : "disabled"],
          ["File uploads", ingestion.uiPolicy.adminPanelCanUploadFiles ? "enabled" : "disabled"],
          ["Show contract only", ingestion.uiPolicy.adminPanelShowsContractOnly ? "yes" : "no"]
        ].map(([label, value]) => (
          <PolicyRow key={label} label={label} value={value} />
        ))}
      </PolicySection>
    </div>
  );
}

function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="flex flex-col gap-2.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
        {title}
      </h2>
      <dl className="m-0 flex flex-col gap-0">{children}</dl>
    </section>
  );
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-[#EAE0CE] py-2 first:border-t-0">
      <dt
        className="m-0 text-[11px] font-[family-name:var(--font-caption)] uppercase text-[#8A8073]"
        style={{ letterSpacing: "0.4px" }}
      >
        {label}
      </dt>
      <dd className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[#1A1410] tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * OpenClaw thin gradient wrap (cornerRadius 13, padding 1.5)
 * ------------------------------------------------------------------------ */
function OpenClawPromptThin({
  collector
}: {
  collector: DashboardData["supervisedCollector"];
}) {
  const blocked = collector.sources.filter((s) => s.status === "blocked").length;
  const message =
    blocked > 0
      ? `${formatNumber(blocked)} fuentes están bloqueadas. ¿Te propongo el orden para desbloquear?`
      : "Todas las fuentes están listas o en revisión. Puedo proponer la captura del próximo snapshot.";
  return (
    <div
      className="rounded-[13px]"
      style={{
        padding: 1.5,
        background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <div
        className="flex items-center gap-3 rounded-[11.5px] bg-[#FFFFFF]"
        style={{ padding: "14px 18px" }}
      >
        <span
          aria-hidden="true"
          className="grid h-8 w-8 place-items-center rounded-[8px] text-[#FFFBF5] shrink-0"
          style={{
            background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)"
          }}
        >
          <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[12px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            OpenClaw observa el recolector
          </span>
          <span className="text-[12px] font-[family-name:var(--font-sans)] text-[#5C544A] truncate">
            {message}
          </span>
        </div>
        <div
          aria-hidden="true"
          className="flex items-center gap-2 rounded-[6px] border border-[#EAE0CE] bg-[#F7F2EA] px-2.5 py-1.5"
          style={{ minWidth: 220 }}
        >
          <span className="flex-1 text-[11px] font-[family-name:var(--font-sans)] text-[#8A8073]">
            Responde a OpenClaw…
          </span>
          <ArrowUp size={12} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        </div>
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-1.5 rounded-[6px] bg-[#1A1410] px-3 py-2 text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5] disabled:cursor-default disabled:opacity-100"
        >
          <WandSparkles size={12} strokeWidth={1.75} aria-hidden="true" />
          Sugerir orden
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Audit section
 * ------------------------------------------------------------------------ */
function AuditSection({
  collector
}: {
  collector: DashboardData["supervisedCollector"];
}) {
  const rows: Array<{
    timestamp: string;
    source: string;
    event: string;
    detail: string;
  }> = collector.sources.slice(0, 5).map((s) => ({
    timestamp: formatDateTime(s.freshness.lastCollectedAt) ?? "—",
    source: s.kind,
    event: `source.${s.status}`,
    detail: s.label
  }));

  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Auditoría de fuentes
        </h2>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          append-only
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {rows.map((row, i) => (
          <li
            key={i}
            className="grid grid-cols-[140px_120px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 py-2.5 text-[11px] font-[family-name:var(--font-mono)] border-b border-[#EAE0CE] last:border-b-0"
          >
            <span className="text-[#5C544A] tabular-nums truncate">{row.timestamp}</span>
            <span className="text-[#EA580C] truncate">{row.source}</span>
            <span className="text-[#1A1410] truncate">{row.event}</span>
            <span className="text-[#8A8073] truncate text-right">{row.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Explainer split — info text + CLI snippet
 * ------------------------------------------------------------------------ */
function ExplainerSplit({
  ingestion
}: {
  ingestion: DashboardData["snapshotIngestion"];
}) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ExplainerText ingestion={ingestion} />
      <CliSnippet />
    </div>
  );
}

function ExplainerText({ ingestion }: { ingestion: DashboardData["snapshotIngestion"] }) {
  return (
    <section
      className="flex flex-col gap-3 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF]"
      style={{ padding: 20, boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
        Por qué no se postea desde la UI
      </h2>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        El admin panel es 100% GET. La ingesta supervisada de snapshots requiere un operador con
        rol elevado corriendo el CLI fuera del panel. Esto preserva la barandilla read-only del
        norte operativo.
      </p>
      <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
        {ingestion.parserOutputs.slice(0, 4).map((output) => (
          <li
            key={output}
            className="inline-flex items-center gap-2 rounded-[6px] bg-[#F7F2EA] px-3 py-2 text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410]"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-[3px] bg-[#EA580C]" />
            {output}
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
    { tone: "success" as const, text: "✓ accepted, schema 5.10.0" }
  ];
  const colors: Record<"input" | "info" | "success" | "error", string> = {
    input: "#FFFBF5",
    info: "#FACC15",
    success: "#86EFAC",
    error: "#F87171"
  };
  return (
    <section
      className="rounded-[8px] border border-[#1A1410] bg-[#1A1410] overflow-hidden"
      style={{ boxShadow: "0 6px 18px rgba(0, 0, 0, 0.18)" }}
    >
      <header
        className="flex items-center justify-between gap-3 border-b"
        style={{ borderColor: "rgba(255, 251, 245, 0.13)", padding: "10px 14px" }}
      >
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: "rgba(255, 251, 245, 0.15)" }} />
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: "rgba(255, 251, 245, 0.15)" }} />
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: "rgba(255, 251, 245, 0.15)" }} />
          <span
            className="text-[11px] font-[family-name:var(--font-mono)] ml-2"
            style={{ color: "rgba(255, 251, 245, 0.7)" }}
          >
            delivrix-cli — captura manual
          </span>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-[4px] px-2 py-1 text-[10px] font-[family-name:var(--font-mono)]"
          style={{ background: "rgba(255, 251, 245, 0.08)", color: "#FFFBF5" }}
        >
          <Copy size={10} strokeWidth={1.75} aria-hidden="true" />
          copy
        </button>
      </header>
      <pre className="m-0 px-5 py-4 overflow-x-auto">
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
