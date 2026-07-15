/**
 * Recolector y captura manual — port LITERAL desde Pencil frame `k70xK` / `SqPKX`.
 *
 * Estructura literal:
 *   Hero (Dl3tb)
 *   Tabs (yKT6P): Fuentes (activa) + Captura manual + help
 *   SourcesRow (KFzUx): 4 source cards (Archivo local / Proxmox / Prometheus / IPMI)
 *   OpenClaw Prompt thin gradient (a6nRY)
 *   AcceptedFieldsSection (t0dbV): tabla del contrato (solo campos reales)
 *   AuditSection (lCgdH)
 *   ExplainerSplit (W763AC)
 */

import {
  ArrowRight,
  CircleCheck,
  Cpu,
  Database,
  FileText,
  Folder,
  Info,
  Server,
  Sparkles,
  TriangleAlert,
  Upload
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DashboardData } from "../../shared/api/client.ts";
import { filterAuditEvents, formatTimeOnly, shortAuditHash } from "../../shared/lib/formatters.ts";
import { useOpenClawIntent, useToast } from "../../shared/ui/v2/index.ts";
import {
  AdvisorCard,
  aivoraGradient,
  Button,
  Card,
  KpiCard,
  Pill,
  SectionHead,
  StateBadge,
  stateColor,
  stateNeedsLeftBorder
} from "../../shared/ui/aivora/index.tsx";

export function CollectorSection({ data }: { data: DashboardData }) {
  const [activeTab, setActiveTab] = useState<"sources" | "manual">("sources");
  return (
    <section className="flex flex-col" style={{ gap: 24 }}>
      <Hero />
      <Tabs
        activeTab={activeTab}
        onChange={setActiveTab}
        sourcesCount={data.supervisedCollector.sources.length}
      />
      {activeTab === "sources" ? (
        <>
          {/* Región OSCURA agrupada (marco): banda de KPIs + Advisor, juntos y pegados
              al tope del contenido. Nunca una card negra suelta entre las claras. */}
          <CollectorKpis data={data} />
          <OpenClawPromptWrap data={data} />
          {/* CENTRO CLARO: fuentes, contrato, bitácora, detalle — el trabajo que se escanea. */}
          <SourcesRow data={data} />
          <AcceptedFieldsSection data={data} />
          <AuditSection data={data} />
          <ExplainerSplit data={data} />
        </>
      ) : (
        <ManualCaptureTab />
      )}
    </section>
  );
}

/* ============================================================
 * Hero (Dl3tb) — molde Aivora: eyebrow + h1 light + subtítulo
 * ============================================================ */
function Hero() {
  return (
    <SectionHead
      eyebrow="Evidencia supervisada"
      title="Recolector y captura manual"
      subtitle="El panel es solo lectura. La evidencia entra desde fuentes supervisadas o desde un endpoint manual auditado fuera del panel."
    />
  );
}

/* ============================================================
 * CardHead — encabezado interno de card estilo demo (título 15/500 +
 * subtítulo dim + slot derecho). Subcomponente propio; el molde solo exporta
 * el SectionHead grande (page-level), no el header chico de sub-sección.
 * ============================================================ */
function CardHead({
  title,
  subtitle,
  right
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 12.5, color: "var(--color-text-tertiary)", marginTop: 2 }}>{subtitle}</div>
        ) : null}
      </div>
      {right ? <div style={{ flex: "0 1 auto", minWidth: 0 }}>{right}</div> : null}
    </div>
  );
}

/* ============================================================
 * CollectorKpis — KPI row con DATOS REALES derivados del contrato.
 * Solo conteos verificables (sin delta ni serie inventada → KpiCard los omite).
 * ============================================================ */
function CollectorKpis({ data }: { data: DashboardData }) {
  const sources = data.supervisedCollector.sources ?? [];
  const ready = sources.filter((s) => {
    if (s.freshness.stale) return false;
    const t = s.status.toLowerCase();
    return t === "ready" || t === "ok" || t === "fresh";
  }).length;
  const attention = sources.filter((s) => {
    const t = s.status.toLowerCase();
    return t === "needs_review" || t === "stale" || t === "blocked" || t === "critical" || t === "unknown" || s.freshness.stale;
  }).length;
  const fields = data.snapshotIngestion.acceptedFieldPaths ?? [];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4" style={{ gap: 20 }}>
      <KpiCard label="Fuentes supervisadas" value={sources.length} icon={Database} />
      <KpiCard label="Dentro del umbral" value={ready} icon={CircleCheck} />
      <KpiCard label="Requieren atención" value={attention} icon={TriangleAlert} />
      <KpiCard label="Campos del contrato" value={fields.length} icon={FileText} />
    </div>
  );
}

/* ============================================================
 * Tabs (yKT6P)
 * ============================================================ */
/**
 * Tabs reales (antes solo etiquetas estáticas). Click cambia entre vista
 * "Fuentes" (live del recolector supervisado) y "Captura manual" (formulario
 * para ingestar JSON manual via /v1/devops/collector/manual-snapshots/ingest).
 */
function Tabs({
  activeTab,
  onChange,
  sourcesCount
}: {
  activeTab: "sources" | "manual";
  onChange: (tab: "sources" | "manual") => void;
  sourcesCount: number;
}) {
  const tabBase =
    "inline-flex items-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] cursor-pointer bg-transparent border-0";
  return (
    <div
      className="flex items-end overflow-x-auto"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <button
        type="button"
        onClick={() => onChange("sources")}
        className={tabBase}
        style={{
          gap: 8,
          padding: "14px 4px",
          marginRight: 14,
          borderBottom: activeTab === "sources" ? "2px solid var(--color-accent-tertiary)" : "2px solid transparent",
          marginBottom: -1
        }}
      >
        <Database
          size={14}
          strokeWidth={1.75}
          className={activeTab === "sources" ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}
          aria-hidden="true"
        />
        <span
          className="text-[13px] font-[family-name:var(--font-sans)]"
          style={{
            fontWeight: activeTab === "sources" ? 600 : 500,
            color: activeTab === "sources" ? "var(--color-text-primary)" : "var(--color-text-secondary)"
          }}
        >
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
      </button>
      <button
        type="button"
        onClick={() => onChange("manual")}
        className={tabBase}
        style={{
          gap: 8,
          padding: "14px 4px",
          borderBottom: activeTab === "manual" ? "2px solid var(--color-accent-tertiary)" : "2px solid transparent",
          marginBottom: -1
        }}
      >
        <Upload
          size={14}
          strokeWidth={1.75}
          className={activeTab === "manual" ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}
          aria-hidden="true"
        />
        <span
          className="text-[13px] font-[family-name:var(--font-sans)]"
          style={{
            fontWeight: activeTab === "manual" ? 600 : 500,
            color: activeTab === "manual" ? "var(--color-text-primary)" : "var(--color-text-secondary)"
          }}
        >
          Captura manual
        </span>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]"
          style={{ letterSpacing: "var(--tracking-wider)" }}
        >
          externo
        </span>
      </button>
      <span className="flex-1" aria-hidden="true" />
      <div className="hidden md:inline-flex items-center" style={{ gap: 6, padding: "10px 4px" }}>
        <Info size={12} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          Documentación de contratos
        </span>
      </div>
    </div>
  );
}

/**
 * ManualCaptureTab — formulario inline para ingestar snapshots manuales.
 *
 * Vive en el tab "Captura manual". Permite al operador pegar el JSON producido
 * por `delivrix-cli capture` y enviarlo al endpoint protegido del backend.
 * Mismo contrato que el modal de Hardware "Solicitar snapshot manual" pero
 * inline (sin modal) porque aquí el contexto es operación dedicada.
 */
function ManualCaptureTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [actorId, setActorId] = useState("");
  const [rawJson, setRawJson] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

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
        description: "Backend procesó el snapshot. Hardware refrescando…"
      });
      void queryClient.invalidateQueries({ queryKey: ["admin-panel", "dashboard"] });
      setRawJson("");
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
  }, [actorId, rawJson, mutation]);

  return (
    <Card className="flex flex-col" style={{ gap: 16, padding: 20 }}>
      <header className="flex items-start" style={{ gap: 12 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{ width: 36, height: 36, borderRadius: 8, background: "var(--color-info-soft)", color: "var(--color-info)" }}
        >
          <Upload size={18} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col" style={{ gap: 4 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            Captura manual auditada
          </h2>
          <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]" style={{ maxWidth: 640 }}>
            Ejecuta <code className="font-[family-name:var(--font-mono)]">delivrix-cli capture</code> en el servidor target,
            copia el JSON resultante aquí y firma la captura con tu identificador. El backend valida estructura, escribe
            audit event y descarta si el contrato no se cumple.
          </p>
        </div>
      </header>

      <label className="flex flex-col" style={{ gap: 6, maxWidth: 360 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{ letterSpacing: "var(--tracking-widest)", color: "var(--color-text-tertiary)" }}
        >
          Operador <span style={{ color: "var(--color-critical)" }}>*</span>
        </span>
        <input
          type="text"
          value={actorId}
          onChange={(e) => setActorId(e.target.value)}
          placeholder="op-juanes-a / op-mariana-b"
          disabled={mutation.isPending}
          className="text-[16px] sm:text-[14px]"
        />
      </label>

      <label className="flex flex-col" style={{ gap: 6 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{ letterSpacing: "var(--tracking-widest)", color: "var(--color-text-tertiary)" }}
        >
          JSON del snapshot <span style={{ color: "var(--color-critical)" }}>*</span>
        </span>
        <textarea
          value={rawJson}
          onChange={(e) => setRawJson(e.target.value)}
          placeholder='{ "hostId": "...", "identity": {...}, "capacity": {...}, ... }'
          rows={14}
          disabled={mutation.isPending}
          className="text-[16px] sm:text-[11px]"
          style={{
            resize: "vertical",
            minHeight: 240,
            fontFamily: "var(--font-mono)",
            lineHeight: 1.55
          }}
        />
        <span className="text-[10px] font-[family-name:var(--font-caption)]" style={{ color: "var(--color-text-tertiary)" }}>
          El backend devuelve HTTP 422 si falta algún campo del schema. Tip: pasa el JSON por <code className="font-[family-name:var(--font-mono)]">jq .</code> antes de pegarlo para validar formato.
        </span>
      </label>

      {parseError ? (
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold" style={{ color: "var(--color-critical)" }}>
          {parseError}
        </span>
      ) : null}

      <div className="flex items-center" style={{ gap: 10 }}>
        <Button type="button" onClick={handleSubmit} disabled={mutation.isPending} size="md">
          <Upload size={14} strokeWidth={2} aria-hidden="true" />
          {mutation.isPending ? "Ingestando…" : "Ingestar snapshot"}
        </Button>
        <span className="text-[11px] font-[family-name:var(--font-caption)]" style={{ color: "var(--color-text-tertiary)" }}>
          Endpoint <code className="font-[family-name:var(--font-mono)]">/v1/devops/collector/manual-snapshots/ingest</code>
        </span>
      </div>
    </Card>
  );
}

/* ============================================================
 * SourcesRow (KFzUx) — 4 source cards
 * ============================================================ */
/** Mapea el status real de una fuente al enum del StateBadge del molde (dot+icono
 * coloreado por token) con label en español. Sin fabricar datos: solo re-etiqueta. */
function sourceBadge(status: string): { status: string; label: string } {
  const t = status.toLowerCase();
  if (t === "ready" || t === "ok" || t === "fresh") return { status: "active", label: "Listo" };
  if (t === "needs_review" || t === "stale") return { status: "degraded", label: "Desactualizado" };
  if (t === "blocked" || t === "critical") return { status: "BLOCKED", label: "Bloqueado" };
  if (t === "unknown") return { status: "unknown", label: "Sin datos" };
  return { status, label: status.toUpperCase() };
}

// Ícono por TIPO de fuente (identidad, no estado): neutro. El color de estado lo
// carga el StateBadge; los íconos van finos en text-secondary (§3/§4, sin semántico decorativo).
function sourceIcon(kind: string): React.ReactNode {
  const t = kind.toLowerCase();
  const props = { size: 16, strokeWidth: 1.75, "aria-hidden": true as const, style: { color: "var(--color-text-secondary)" } };
  if (t.includes("file") || t.includes("local")) return <Folder {...props} />;
  if (t.includes("proxmox") || t.includes("api")) return <Server {...props} />;
  if (t.includes("prometheus") || t.includes("metric") || t.includes("ipmi") || t.includes("sensor"))
    return <Cpu {...props} />;
  return <Database {...props} />;
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
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 20 }}>
      {sources.map((s) => {
        const badge = sourceBadge(s.status);
        return (
          <SourceCard
            key={s.id}
            name={s.label}
            icon={sourceIcon(s.kind)}
            badgeStatus={badge.status}
            badgeLabel={badge.label}
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
  badgeStatus,
  badgeLabel,
  endpoint,
  mode,
  lastSeen
}: {
  name: string;
  icon: React.ReactNode;
  badgeStatus: string;
  badgeLabel: string;
  endpoint: string;
  mode: string;
  lastSeen: string;
}) {
  return (
    <Card
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 20,
        ...(stateNeedsLeftBorder(badgeStatus)
          ? { borderLeft: `2px solid ${stateColor(badgeStatus)}` }
          : {})
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
        <StateBadge status={badgeStatus} label={badgeLabel} />
      </header>

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
    </Card>
  );
}

/* ============================================================
 * OpenClawPromptWrap — Advisor OpenClaw sobre el MOLDE aivora (AdvisorCard: única
 * superficie con gradiente + sparkle). Reemplaza al banner visual de v2 (montaje).
 * Mantiene la derivación real del mensaje por estado de fuente (blocked > stale >
 * unknown > ok) y los CTAs conservan función: pre-llenan el chat OpenClaw vía
 * useOpenClawIntent (SSH bridge ya cableado), no son botones muertos.
 * Va en la región OSCURA (ink) junto a la banda de KPIs: forma el marco cohesivo.
 * ============================================================ */
function OpenClawPromptWrap({ data }: { data: DashboardData }) {
  const { sendIntent } = useOpenClawIntent();
  const { toast } = useToast();

  const stale = data.supervisedCollector.sources.find(
    (s) => s.status === "needs_review" || s.freshness.stale
  );
  const blocked = data.supervisedCollector.sources.find((s) => s.status === "blocked");
  const unknown = data.supervisedCollector.sources.find((s) => s.status === "unknown");

  let title = "Fuentes dentro del umbral";
  let body = "Todas las fuentes están dentro del umbral de frescura. Puedo proponer el próximo ciclo de captura.";
  let tone: "critical" | "warning" | "info" | "success" = "success";
  let toneLabel = "todo al día";
  if (blocked) {
    title = `${blocked.label} bloqueado`;
    body = `${blocked.label} está bloqueado: ${blocked.blockedBy[0] ?? "sin contexto"}. Frescura ${relativeAge(blocked.freshness.lastCollectedAt)}.`;
    tone = "critical";
    toneLabel = "fuente bloqueada";
  } else if (stale) {
    title = `${stale.label} desactualizado`;
    body = `${stale.label} no se ha refrescado en ${relativeAge(stale.freshness.lastCollectedAt)}. ¿Quieres que investigue?`;
    tone = "warning";
    toneLabel = "fuera de umbral";
  } else if (unknown) {
    title = `${unknown.label} sin datos`;
    body = `${unknown.label} aún sin datos. Coordina con el operador para activar el snapshot inicial.`;
    tone = "info";
    toneLabel = "sin snapshot inicial";
  }

  const send = (label: string) => {
    const prompt = `Acción del operador: ${label}.\n\nContexto del recolector: ${title} · ${body}\n\nTráeme la evidencia o la recomendación ordenada por impacto y dime qué decisión humana necesitas. Cita los snapshots y eventos del audit chain.`;
    sendIntent(prompt, `collector:${label}`);
    toast.info(`Enviando a OpenClaw · ${label}`, {
      description: "Prompt pre-llenado en el chat. Revisa y presiona Enter para ejecutar.",
      duration: 2500
    });
  };

  return (
    <AdvisorCard>
      <div style={{ padding: 18 }}>
        <div className="flex items-center" style={{ gap: 9 }}>
          <div
            aria-hidden="true"
            className="grid place-items-center"
            style={{ width: 30, height: 30, borderRadius: 9, background: aivoraGradient }}
          >
            <Sparkles size={16} color="var(--color-accent-fg)" />
          </div>
          <div className="text-[14.5px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)]">
            Advisor · OpenClaw
          </div>
        </div>

        <div style={{ marginTop: 14, borderLeft: "2px solid var(--color-accent)", paddingLeft: 12 }}>
          <div className="text-[13.5px] font-[family-name:var(--font-sans)] font-semibold leading-snug text-[var(--color-text-primary)]">
            {title}
          </div>
          <div
            className="text-[13px] font-[family-name:var(--font-body)] text-[var(--color-text-secondary)]"
            style={{ marginTop: 4, lineHeight: 1.5 }}
          >
            {body}
          </div>
          <div className="flex flex-wrap items-center" style={{ gap: 6, marginTop: 10 }}>
            <Pill tone={tone}>{toneLabel}</Pill>
          </div>
        </div>

        <div className="flex flex-wrap items-center" style={{ gap: 8, marginTop: 14 }}>
          <button
            type="button"
            onClick={() => send("Investigar fuente")}
            className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              gap: 6,
              padding: "8px 14px",
              borderRadius: 10,
              background: aivoraGradient,
              color: "var(--color-accent-fg)",
              fontSize: 13,
              border: "none",
              cursor: "pointer"
            }}
          >
            Investigar fuente
            <ArrowRight size={13} strokeWidth={2.25} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => send("Ver runbook")}
            className="inline-flex items-center font-[family-name:var(--font-caption)] font-medium leading-none transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              fontSize: 13,
              cursor: "pointer"
            }}
          >
            Ver runbook
          </button>
        </div>
      </div>
    </AdvisorCard>
  );
}

/* ============================================================
 * AcceptedFieldsSection (t0dbV) — tabla del contrato (PATH · TIPO · FUENTE · MAPEO · REQUERIDO)
 * ============================================================ */
// Chip de la columna FUENTE = etiqueta neutra (identifica el origen, NO un estado).
// La tabla no pinta color semántico: el contrato no expone validación por-campo, así
// que no se fabrica un StateBadge de "validado" verde (§9 do/dont). Solo dato real.
function sourceStylePill(_kind: string): { bg: string; fg: string } {
  return { bg: "var(--color-surface-sunken)", fg: "var(--color-text-secondary)" };
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
    return {
      path: f.path,
      type: f.type,
      source: sourceName,
      sourceBg: sourcePill.bg,
      sourceFg: sourcePill.fg,
      mapsTo: f.mapsTo,
      requiredFor: f.requiredFor
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
  }>;
  schemaVersion: string;
  requiredCount: number;
}) {
  const ACCEPTED_FIELDS = rows;
  const chip = {
    gap: 6,
    padding: "4px 8px",
    borderRadius: 4,
    background: "var(--color-surface-sunken)",
    border: "1px solid var(--color-border)"
  } as const;
  return (
    <Card className="flex flex-col">
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}>
        <CardHead
          title="Campos aceptados"
          subtitle="Contrato firmado · valida cada snapshot antes de aceptarlo"
          right={
            <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
              <span
                className="inline-flex items-center text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]"
                style={chip}
              >
                schema · {schemaVersion}
              </span>
              <span
                className="inline-flex items-center text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]"
                style={chip}
              >
                {requiredCount} / {ACCEPTED_FIELDS.length} requeridos
              </span>
            </div>
          }
        />
      </div>

      <div className="overflow-x-auto">
        <div
          className="grid items-center"
          style={{
            gridTemplateColumns: "260px 150px 170px minmax(0,1fr) 130px",
            minWidth: 900,
            gap: 16,
            padding: "14px 20px",
            background: "var(--color-surface-sunken)",
            borderBottom: "1px solid var(--color-border)"
          }}
        >
          {["PATH", "TIPO", "FUENTE", "MAPEO INTERNO", "REQUERIDO PARA"].map((h) => (
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
              gridTemplateColumns: "260px 150px 170px minmax(0,1fr) 130px",
              minWidth: 900,
              gap: 16,
              padding: "14px 20px",
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
          </div>
        ))}
      </div>
    </Card>
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
    <Card className="flex flex-col" style={{ gap: 12, padding: 20 }}>
      <CardHead
        title="Bitácora de ingesta"
        subtitle="Append-only · contrato /v1/devops/collector/audit"
        right={
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
        }
      />

      <div className="overflow-x-auto">
      <div
        className="grid"
        style={{
          gridTemplateColumns: "80px 180px 220px minmax(0,1fr) 80px",
          minWidth: 720,
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
              minWidth: 720,
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
      </div>
    </Card>
  );
}

/* ============================================================
 * ExplainerSplit
 * ============================================================ */
function ExplainerSplit({ data }: { data: DashboardData }) {
  return <ExplainerText data={data} />;
}

function ExplainerText({ data }: { data: DashboardData }) {
  // Solo salidas reales del contrato. Antes había un fallback fabricado de 4
  // mapeos inventados (physical_host.*, telemetry.*→series 60s, sensors.ipmi.*)
  // que se pintaban como si fueran la config real del parser cuando el backend
  // no devolvía nada. Si no hay salidas reales → estado vacío honesto.
  const outputs = data.snapshotIngestion.parserOutputs?.slice(0, 4) ?? [];
  return (
    <Card className="flex flex-col" style={{ gap: 12, padding: 20 }}>
      <CardHead title="Por qué la ingesta vive fuera del panel" />

      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
        El admin panel es 100% GET. La ingesta supervisada de snapshots requiere un operador con
        rol elevado corriendo el CLI fuera del panel. Esto preserva la barandilla read-only del
        norte operativo y evita un POST cliente que pudiera ser comprometido.
      </p>
      {outputs.length > 0 ? (
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
      ) : (
        <span
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-caption)]"
          style={{
            gap: 8,
            padding: "8px 12px",
            borderRadius: 6,
            background: "var(--color-surface-sunken)",
            color: "var(--color-text-tertiary)"
          }}
        >
          <Info size={11} strokeWidth={1.75} aria-hidden="true" />
          El contrato aún no publicó salidas del parser.
        </span>
      )}
    </Card>
  );
}
