/**
 * v5 Recolector — fuentes de evidencia supervisadas + captura manual auditada.
 *
 * Brief inference (TasteSkill §0):
 *   El Recolector es el ingreso de evidencia al control plane. Lecturas
 *   supervisadas (read-only) o ingesta manual con contrato firmado. Para
 *   CTOs/operadores: necesitan entender qué fuentes alimentan al sistema,
 *   cuáles están bloqueadas, y cómo capturar manualmente sin romper el
 *   contrato.
 *
 * Three Dials:
 *   VARIANCE 2/5 · MOTION 1/5 · DENSITY 4/5.
 *
 * Design lead Linear · secondary Vercel/Datadog · CTAs Stripe.
 *
 * Layout:
 *   PageHead (eyebrow + title + body + meta schema)
 *   Tab strip: Fuentes (n) / Captura manual
 *   Tab "Fuentes":
 *     BannerOpenClawV2 (si hay bloqueos) — una sola HumanNote NO en banner
 *     SourceCard grid · 4 cols
 *     AcceptedFields table colapsable
 *   Tab "Captura manual":
 *     DarkCliSnippet (always-dark) + endpoint mono + textarea + CTA primary
 *   Footer hairline · link runbook + schema version
 */

import { motion } from "framer-motion";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Cpu,
  Database,
  FileText,
  Folder,
  Server,
  Upload
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DashboardData } from "../../shared/api/client";
import { BannerOpenClawV2, useToast } from "../../shared/ui/v2/index.ts";
import { DarkCliSnippet, type CliLine } from "../../shared/ui/dark-cli-snippet.tsx";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Badge,
  Body,
  BodySm,
  Button,
  Caption,
  Card,
  Chip,
  Eyebrow,
  H3,
  HumanNote,
  MonoCode,
  MonoData,
  Pill,
  SectionHead
} from "../components/primitives";
import { cn } from "../lib/cn";
import { PageHead } from "./_PageHead";

type CollectorTab = "sources" | "manual";

export function CollectorV5({ data }: { data: DashboardData }) {
  const [tab, setTab] = useState<CollectorTab>("sources");
  const sources = data.supervisedCollector.sources ?? [];
  const schemaVersion =
    data.snapshotIngestion.snapshotSchemaVersion ??
    data.supervisedCollector.ingestionPolicy.snapshotSchemaVersion;
  const manualEndpoint = data.snapshotIngestion.manualEndpoint;
  const fields = data.snapshotIngestion.acceptedFieldPaths ?? [];

  const blockedCount = sources.filter((s) => s.status === "blocked").length;
  const staleCount = sources.filter(
    (s) => s.status === "needs_review" || s.freshness.stale
  ).length;

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow="Evidencia supervisada"
          meta={
            <span className="inline-flex items-center gap-2">
              <MonoCode>schema {schemaVersion}</MonoCode>
              <span aria-hidden="true" className="inline-block size-[3px] rounded-full bg-border-strong" />
              <MonoCode>{sources.length} fuentes</MonoCode>
            </span>
          }
          title="Recolector y captura manual."
          body="El panel es solo lectura. La evidencia entra desde fuentes supervisadas o desde el endpoint manual auditado fuera del panel. Cada snapshot pasa por el contrato firmado antes de tocar la base."
        />
      </motion.div>

      <motion.div variants={staggerItem}>
        <TabStrip
          tab={tab}
          onChange={setTab}
          sourcesCount={sources.length}
        />
      </motion.div>

      {tab === "sources" ? (
        <SourcesTab
          data={data}
          blockedCount={blockedCount}
          staleCount={staleCount}
        />
      ) : (
        <ManualTab
          schemaVersion={schemaVersion}
          endpointPath={manualEndpoint.path}
          fields={fields}
        />
      )}

      <motion.footer
        variants={staggerItem}
        className="flex items-center justify-between border-t border-border pt-4"
      >
        <Caption>
          Contrato firmado · solo el backend escribe en la base
        </Caption>
        <div className="flex items-center gap-3">
          <MonoCode>schema · {schemaVersion}</MonoCode>
          <span aria-hidden="true" className="inline-block size-[3px] rounded-full bg-border-strong" />
          <Button variant="link" size="sm">
            Abrir runbook
            <ArrowRight size={11} strokeWidth={1.75} />
          </Button>
        </div>
      </motion.footer>
    </motion.div>
  );
}

/* ============================================================
 * TabStrip — chips alternativos. Densidad alta. Sin underlines.
 * ============================================================ */

function TabStrip({
  tab,
  onChange,
  sourcesCount
}: {
  tab: CollectorTab;
  onChange: (next: CollectorTab) => void;
  sourcesCount: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="Vistas del recolector"
      className="flex items-center gap-2 border-b border-border pb-3"
    >
      <Chip
        role="tab"
        aria-selected={tab === "sources"}
        active={tab === "sources"}
        onClick={() => onChange("sources")}
      >
        <Database size={12} strokeWidth={1.75} aria-hidden="true" />
        Fuentes del recolector
        <Badge>{sourcesCount}</Badge>
      </Chip>
      <Chip
        role="tab"
        aria-selected={tab === "manual"}
        active={tab === "manual"}
        onClick={() => onChange("manual")}
      >
        <Upload size={12} strokeWidth={1.75} aria-hidden="true" />
        Captura manual
        <Badge>externo</Badge>
      </Chip>
    </div>
  );
}

/* ============================================================
 * Tab 1 · Fuentes
 * ============================================================ */

function SourcesTab({
  data,
  blockedCount,
  staleCount
}: {
  data: DashboardData;
  blockedCount: number;
  staleCount: number;
}) {
  const sources = data.supervisedCollector.sources ?? [];
  const fields = data.snapshotIngestion.acceptedFieldPaths ?? [];

  const banner = pickBannerCopy({ blockedCount, staleCount, totalSources: sources.length });

  return (
    <>
      {banner ? (
        <motion.div variants={staggerItem}>
          <BannerOpenClawV2
            title={banner.title}
            body={banner.body}
            primaryCta={banner.primaryCta}
            secondaryCta="Ver runbook"
          />
        </motion.div>
      ) : null}

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Fuentes"
          title="Lecturas supervisadas"
          caption={
            <>
              Cada fuente es <MonoCode>read-only</MonoCode>. El backend valida
              freshness y firma el snapshot.
            </>
          }
          count={sources.length}
          countTone={blockedCount > 0 ? "warning" : "success"}
          trailing={
            <div className="flex items-center gap-2">
              {blockedCount > 0 ? (
                <Pill tone="warning" size="sm">
                  {blockedCount} bloqueadas
                </Pill>
              ) : null}
              {staleCount > 0 ? (
                <Pill tone="warning" size="sm">
                  {staleCount} stale
                </Pill>
              ) : null}
            </div>
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {sources.map((s) => (
            <SourceCard key={s.id} source={s} />
          ))}
        </div>
      </motion.section>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <AcceptedFieldsTable
          fields={fields}
          sources={sources}
          schemaVersion={
            data.snapshotIngestion.snapshotSchemaVersion ??
            data.supervisedCollector.ingestionPolicy.snapshotSchemaVersion
          }
        />
      </motion.section>
    </>
  );
}

/* ----- SourceCard -------------------------------------------- */

interface CollectorSource {
  id: string;
  kind: string;
  label: string;
  purpose: string;
  status: string;
  readOnly: boolean;
  safeCollection: {
    transport: string;
    commandPreview: string | null;
    endpoint: string | null;
  };
  freshness: {
    lastCollectedAt: string | null;
    stale: boolean;
  };
  blockedBy: string[];
}

type SourceUiState = "ok" | "stale" | "blocked" | "unknown";

function classifyStatus(s: CollectorSource): {
  state: SourceUiState;
  pill: "success" | "warning" | "critical" | "neutral";
  label: string;
  confidence: number;
} {
  const status = s.status.toLowerCase();
  if (status === "ready" || status === "ok" || status === "fresh") {
    return { state: "ok", pill: "success", label: "Validado", confidence: 95 };
  }
  if (status === "needs_review" || status === "stale" || s.freshness.stale) {
    return { state: "stale", pill: "warning", label: "Desactualizado", confidence: 45 };
  }
  if (status === "blocked" || status === "critical") {
    return { state: "blocked", pill: "critical", label: "Bloqueado", confidence: 15 };
  }
  if (status === "unknown") {
    return { state: "unknown", pill: "neutral", label: "Sin datos", confidence: 0 };
  }
  return { state: "unknown", pill: "neutral", label: status.toUpperCase() || "Sin estado", confidence: 50 };
}

function iconForKind(kind: string): ReactNode {
  const t = kind.toLowerCase();
  if (t.includes("file") || t.includes("local")) {
    return <Folder size={13} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (t.includes("proxmox") || t.includes("api")) {
    return <Server size={13} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (t.includes("prometheus") || t.includes("metric")) {
    return <Cpu size={13} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (t.includes("ipmi") || t.includes("sensor") || t.includes("redfish")) {
    return <Cpu size={13} strokeWidth={1.75} aria-hidden="true" />;
  }
  return <Database size={13} strokeWidth={1.75} aria-hidden="true" />;
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

function resolveEndpoint(s: CollectorSource): string {
  const ext = s as unknown as { url?: string | null };
  if (s.safeCollection.endpoint) {
    return `${s.safeCollection.transport.toUpperCase()} · ${s.safeCollection.endpoint}`;
  }
  if (ext.url) {
    return `${s.safeCollection.transport.toUpperCase()} · ${ext.url}`;
  }
  return s.safeCollection.commandPreview ?? `${s.safeCollection.transport} · sin endpoint`;
}

function SourceCard({ source }: { source: CollectorSource }) {
  const cls = classifyStatus(source);
  const lastSeen = relativeAge(source.freshness.lastCollectedAt);
  const endpoint = resolveEndpoint(source);
  const blockedReason =
    (source as unknown as { blockedReasonOperator?: string }).blockedReasonOperator ??
    source.blockedBy[0] ??
    null;

  return (
    <Card padding="relaxed" className="flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface-sunken text-fg-muted"
          >
            {iconForKind(source.kind)}
          </span>
          <div className="flex min-w-0 flex-col">
            <H3 className="truncate">{source.label}</H3>
            <Caption className="truncate">{source.kind}</Caption>
          </div>
        </div>
        <Pill tone={cls.pill} size="sm">
          {cls.label}
        </Pill>
      </div>

      <div className="flex items-end gap-2">
        <span
          className={cn(
            "font-mono text-[26px] font-semibold leading-none tabular-nums",
            cls.pill === "success"
              ? "text-success"
              : cls.pill === "warning"
              ? "text-warning"
              : cls.pill === "critical"
              ? "text-critical"
              : "text-fg-muted"
          )}
          style={{ letterSpacing: "-0.015em" }}
        >
          {cls.confidence === 0 ? "—" : `${cls.confidence}`}
        </span>
        <Caption className="pb-[3px]">confianza</Caption>
      </div>

      <div
        className="relative h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
        aria-hidden="true"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${Math.max(2, cls.confidence)}%`,
            background:
              cls.pill === "success"
                ? "var(--color-success)"
                : cls.pill === "warning"
                ? "var(--color-warning)"
                : cls.pill === "critical"
                ? "var(--color-critical)"
                : "var(--color-fg-subtle)",
            opacity: cls.confidence === 0 ? 0.35 : 1
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <MonoCode className="truncate" title={endpoint}>
          {endpoint}
        </MonoCode>
        <div className="flex items-center gap-2">
          <Badge>{source.readOnly ? "solo lectura" : "rw"}</Badge>
          <span className="flex-1" aria-hidden="true" />
          <Caption className="font-mono text-[10px]">{lastSeen}</Caption>
        </div>
        {blockedReason && cls.state === "blocked" ? (
          <Caption className="leading-[1.45]">{blockedReason}</Caption>
        ) : null}
      </div>
    </Card>
  );
}

/* ----- Banner copy derivation -------------------------------- */

function pickBannerCopy({
  blockedCount,
  staleCount,
  totalSources
}: {
  blockedCount: number;
  staleCount: number;
  totalSources: number;
}): { title: string; body: string; primaryCta: string } | null {
  if (blockedCount > 0) {
    return {
      title: `${blockedCount} de ${totalSources} fuentes bloqueadas`,
      body: "Una o más fuentes no están reportando. Puedo investigar la causa, identificar credenciales o permisos faltantes y proponer el siguiente paso.",
      primaryCta: "Investigar fuente"
    };
  }
  if (staleCount > 0) {
    return {
      title: `${staleCount} fuentes fuera del umbral de frescura`,
      body: "Las lecturas se atrasaron del umbral de frescura. Reviso el último snapshot y propongo cuándo refrescar sin perder evidencia.",
      primaryCta: "Revisar frescura"
    };
  }
  return null;
}

/* ============================================================
 * AcceptedFieldsTable — contrato firmado.
 * Colapsable si hay más de 8 campos.
 * ============================================================ */

interface AcceptedField {
  path: string;
  type: string;
  mapsTo: string;
  requiredFor: string;
}

function AcceptedFieldsTable({
  fields,
  sources,
  schemaVersion
}: {
  fields: AcceptedField[];
  sources: CollectorSource[];
  schemaVersion: string;
}) {
  const PREVIEW_COUNT = 8;
  const collapsible = fields.length > PREVIEW_COUNT;
  const [expanded, setExpanded] = useState(!collapsible);
  const visible = expanded ? fields : fields.slice(0, PREVIEW_COUNT);

  const requiredCount = fields.filter((f) => f.requiredFor !== "optional").length;

  const rows = useMemo(
    () =>
      visible.map((f) => {
        const match = sources.find((s) =>
          f.path.toLowerCase().includes(s.kind.toLowerCase())
        );
        const sourceLabel = match?.label ?? "contrato";
        const status = match ? classifyStatus(match).state : "ok";
        const rowState: "validado" | "desactualizado" | "sin valor" =
          status === "blocked" || status === "unknown"
            ? "sin valor"
            : status === "stale"
            ? "desactualizado"
            : "validado";
        return { field: f, sourceLabel, rowState };
      }),
    [visible, sources]
  );

  return (
    <>
      <SectionHead
        eyebrow="Contrato firmado"
        title="Campos aceptados"
        caption="Cada snapshot se valida contra estos paths antes de ingresar a la base"
        count={fields.length}
        countTone="neutral"
        trailing={
          <div className="flex items-center gap-2">
            <Badge>schema · {schemaVersion}</Badge>
            <Badge>
              {requiredCount} / {fields.length} requeridos
            </Badge>
          </div>
        }
      />
      <Card padding="none" className="overflow-hidden">
        <div className="overflow-x-auto">
          <div
            className="grid items-center border-b border-border bg-surface-sunken"
            style={{
              gridTemplateColumns: "minmax(260px,1.5fr) 130px 160px minmax(200px,1.4fr) 130px 130px",
              gap: 16,
              padding: "10px 16px",
              minWidth: 1050
            }}
          >
            {["PATH", "TIPO", "FUENTE", "MAPEO INTERNO", "REQUERIDO", "ESTADO"].map((h) => (
              <Eyebrow key={h}>{h}</Eyebrow>
            ))}
          </div>

          <ul className="m-0 list-none p-0">
            {rows.map(({ field, sourceLabel, rowState }, i) => (
              <li
                key={field.path}
                className="grid items-center"
                style={{
                  gridTemplateColumns: "minmax(260px,1.5fr) 130px 160px minmax(200px,1.4fr) 130px 130px",
                  gap: 16,
                  padding: "12px 16px",
                  borderTop: i > 0 ? "1px solid var(--color-border)" : "none",
                  minWidth: 1050
                }}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <MonoData className="truncate text-[12px]" title={field.path}>
                    {field.path}
                  </MonoData>
                  <Caption className="text-[10px]">vía contrato</Caption>
                </div>
                <MonoCode className="truncate">{field.type}</MonoCode>
                <Badge>{sourceLabel}</Badge>
                <MonoCode className="truncate" title={field.mapsTo}>
                  {field.mapsTo}
                </MonoCode>
                <BodySm className="text-[12px]">{field.requiredFor}</BodySm>
                <Pill
                  size="sm"
                  tone={
                    rowState === "validado"
                      ? "success"
                      : rowState === "desactualizado"
                      ? "warning"
                      : "neutral"
                  }
                >
                  {rowState}
                </Pill>
              </li>
            ))}
          </ul>
        </div>

        {collapsible ? (
          <div className="flex items-center justify-between border-t border-border bg-surface-sunken px-4 py-2.5">
            <Caption>
              Mostrando {visible.length} de {fields.length} campos
            </Caption>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <>
                  Ocultar campos
                  <ChevronUp size={11} strokeWidth={1.75} />
                </>
              ) : (
                <>
                  Ver los {fields.length} campos
                  <ChevronDown size={11} strokeWidth={1.75} />
                </>
              )}
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}

/* ============================================================
 * Tab 2 · Captura manual
 * ============================================================ */

const SNIPPET_LINES: CliLine[] = [
  { tone: "input", text: "$ delivrix collector capture --source proxmox" },
  { tone: "info", text: ">> autenticando con rol de operador" },
  { tone: "success", text: "ok  snapshot firmado sha256:a3f1bd" },
  { tone: "info", text: ">> POST /v1/devops/collector/manual-snapshots/ingest" },
  { tone: "success", text: "ok  aceptado · schema 5.10.0" },
  { tone: "info", text: ">> hash registrado en audit chain" }
];

function ManualTab({
  schemaVersion,
  endpointPath,
  fields
}: {
  schemaVersion: string;
  endpointPath: string;
  fields: AcceptedField[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [actorId, setActorId] = useState("");
  const [rawJson, setRawJson] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (payload: { actorId: string; snapshot: unknown }) => {
      const res = await fetch(endpointPath, {
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
      setParseError("Identificador del operador requerido.");
      return;
    }
    if (rawJson.trim().length < 2) {
      setParseError("Pega el JSON del snapshot generado por el CLI.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      setParseError(
        `JSON inválido: ${e instanceof Error ? e.message : "parse error"}`
      );
      return;
    }
    mutation.mutate({ actorId: actorId.trim(), snapshot: parsed });
  }, [actorId, rawJson, mutation]);

  return (
    <>
      <motion.section variants={staggerItem} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <DarkCliSnippet
          title="delivrix-cli · captura manual"
          lines={SNIPPET_LINES}
        />
        <Card padding="relaxed" className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface-sunken text-fg-muted"
            >
              <Upload size={15} strokeWidth={1.75} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <H3>Por qué la ingesta vive fuera del panel</H3>
              <BodySm>
                El admin panel es 100% GET. La ingesta de snapshots la corre
                un operador con rol elevado desde el CLI. Esto preserva la
                barandilla solo-lectura y evita un POST cliente que pudiera
                ser comprometido.
              </BodySm>
            </div>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {[
              "Operador firma con su id auditado",
              "Backend valida contra contrato",
              "Audit chain registra el hash",
              "Hardware refresca sin tocar producción"
            ].map((line, i) => (
              <li key={line} className="flex items-center gap-2">
                <span className="grid size-4 shrink-0 place-items-center rounded bg-surface-sunken font-mono text-[10px] font-semibold tabular-nums text-fg-muted ring-1 ring-border">
                  {i + 1}
                </span>
                <BodySm className="text-[12px]">{line}</BodySm>
              </li>
            ))}
          </ul>
          <HumanNote className="mt-1 max-w-[480px]">
            Si necesitás que te guíe paso a paso, abrime el chat y firmamos el snapshot juntos.
          </HumanNote>
        </Card>
      </motion.section>

      <motion.section variants={staggerItem}>
        <Card padding="relaxed" className="flex flex-col gap-4">
          <SectionHead
            eyebrow="Endpoint auditado"
            title="Ingestar snapshot"
            caption={
              <>
                Envía el JSON al endpoint <MonoCode>{endpointPath}</MonoCode> con
                firma del operador. El backend valida y descarta si el contrato no se cumple.
              </>
            }
            trailing={<Badge>schema · {schemaVersion}</Badge>}
          />

          <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
            <label className="flex flex-col gap-1.5">
              <Eyebrow>
                Operador <span style={{ color: "var(--color-critical)" }}>*</span>
              </Eyebrow>
              <input
                type="text"
                value={actorId}
                onChange={(e) => setActorId(e.target.value)}
                placeholder="op-juanes-a"
                disabled={mutation.isPending}
                className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-[12px] text-fg outline-none transition-colors focus:border-border-strong focus-visible:ring-2 focus-visible:ring-border-focus"
              />
              <Caption>Queda firmado en el audit chain.</Caption>
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
                className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] leading-[1.55] text-fg outline-none transition-colors focus:border-border-strong focus-visible:ring-2 focus-visible:ring-border-focus"
                style={{ resize: "vertical", minHeight: 200 }}
              />
              <Caption>
                Tip: pasa el JSON por <MonoCode>jq .</MonoCode> antes de pegarlo. El backend devuelve <MonoCode>422</MonoCode> si falta algún campo del contrato.
              </Caption>
            </label>
          </div>

          {parseError ? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-critical/40 bg-critical-soft px-3 py-2"
            >
              <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-critical" />
              <BodySm className="text-critical-fg">{parseError}</BodySm>
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <Badge>POST</Badge>
              <MonoCode>{endpointPath}</MonoCode>
            </div>
            <Button
              variant="primary"
              size="md"
              onClick={handleSubmit}
              disabled={mutation.isPending}
            >
              <Upload size={12} strokeWidth={1.75} />
              {mutation.isPending ? "Ingestando" : "Ingestar snapshot"}
            </Button>
          </div>
        </Card>
      </motion.section>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Referencia"
          title="Campos aceptados por el contrato"
          caption="El backend acepta exclusivamente estos paths. Cualquier otro key se descarta."
          count={fields.length}
        />
        <Card padding="default" className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {fields.slice(0, 24).map((f) => (
              <Badge key={f.path} className="text-[10.5px]">
                {f.path}
              </Badge>
            ))}
            {fields.length > 24 ? (
              <Badge className="text-[10.5px]">+{fields.length - 24}</Badge>
            ) : null}
          </div>
          {fields.length === 0 ? (
            <Body className="text-[13px]">
              El contrato aún no expone campos aceptados. Revisa el endpoint del schema.
            </Body>
          ) : null}
        </Card>
      </motion.section>
    </>
  );
}
