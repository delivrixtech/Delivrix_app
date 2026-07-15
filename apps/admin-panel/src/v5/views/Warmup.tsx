/**
 * v5 Warmup — visibilidad read-only del warmup-engine.
 *
 * Observabilidad pura: consume GET /v1/warmup/status y muestra el estado del
 * motor de calentamiento (activeNodes, queuedSends, desglose por estado y la
 * tabla de nodos). NO dispara nada — cada arranque/pausa de ramp vive en otras
 * superficies gated. Esta vista solo lee.
 *
 * Diseño: molde oficial "Aivora" (shared/ui/aivora) — Card radius 18 + hairline,
 * KpiCard tile+número tabular, StateBadge dot+icono, SectionHead eyebrow+h1 light.
 * Color SOLO por tokens var(--color-*). PROHIBIDO v5/components/primitives (B/N):
 * los textos que el molde no expone (body/mono) se resuelven con helpers locales
 * token-aware, no con los primitivos B/N. Los 3 gráficos SVG conservan su SERIE
 * REAL (GET /v1/warmup/trends) y ya se pintan con acento/tokens (cero hex).
 *
 * Anti-mock: cada dato sale del backend; no hay conteos ni series inventadas. Los
 * TOPES de config (PLACEMENT_FLOOR, RAMP_CLAMP) se muestran etiquetados "config"
 * (declarados, no medidos). isLoading/isError/vacío se distinguen honestamente.
 *
 * Wiring: la vista hace su propia query. No requiere props del shell.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Flame,
  LineChart,
  Layers,
  PauseCircle,
  Plus,
  TrendingUp
} from "lucide-react";
import { getJson } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import {
  postWarmupMailbox,
  type WarmupMailboxCreateResult
} from "../../shared/api/warmup-mailboxes-client";
import { WarmupMailboxLog } from "./WarmupMailboxLog";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Button,
  Caption,
  Card,
  Heading,
  KpiCard,
  Pill,
  SectionHead,
  StateBadge,
  stateColor,
  stateNeedsLeftBorder
} from "../../shared/ui/aivora";

/* ============================================================
 * Texto del molde — helpers locales token-aware.
 *
 * El molde Aivora expone Heading/Caption/Pill pero NO un body ni un mono (datos/
 * código/IDs). Estos helpers cubren ese hueco SIN volver a v5/components/primitives
 * (B/N): color/tipografía salen de tokens (text-fg/-muted/-subtle, font-mono). Así
 * la vista queda 100% en el sistema de tokens del demo, sin hex ni clases viejas.
 * ============================================================ */

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function BodyText({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cx("m-0 font-sans text-[13px] leading-[1.5] text-fg-muted", className)}>{children}</p>;
}

function Mono({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cx("font-mono text-[11px] leading-[1.5] text-fg-muted", className)}>{children}</span>;
}

function MonoStrong({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cx("font-mono text-[12px] font-medium leading-[1.4] tabular-nums text-fg", className)}>
      {children}
    </span>
  );
}

/* ============================================================
 * Contrato del endpoint — mirror local.
 * ============================================================ */

type WarmupNodeState = "blocked" | "fresh" | "warm" | "paused" | "quarantined";

interface WarmupNode {
  id: string;
  mailbox: string;
  domain: string;
  state: WarmupNodeState;
  dayIndex: number;
  authReady: boolean;
  placementScore?: number;
}

interface WarmupStatusSnapshot {
  generatedAt: string;
  enabled: boolean;
  totals: { activeNodes: number; queuedSends: number };
  byState: Record<string, number>;
  nodes: WarmupNode[];
  note?: string; // "postgres_unavailable" | "warmup_tables_unavailable" cuando aplica
}

/**
 * Contrato de GET /v1/warmup/trends — mirror local del shape del backend.
 * Observabilidad pura: series de placement, colocación por proveedor, curva
 * de rampa y señales de daño (bounces/complaints). Read-only.
 */
interface WarmupPlacementPoint {
  windowEnd: string;
  inboxWilsonLb?: number;
  inboxEwma?: number;
  spamRate?: number;
  samples: number;
}

interface WarmupProviderRow {
  provider: string;
  inbox: number;
  tabs: number;
  spam: number;
  missing: number;
  total: number;
  inboxRate?: number;
}

interface WarmupRampPoint {
  dayIndex: number;
  quota: number;
}

interface WarmupTrends {
  generatedAt: string;
  placementSeries: WarmupPlacementPoint[];
  perProvider: WarmupProviderRow[];
  ramp: WarmupRampPoint[];
  signals: { bounces: number; complaints: number };
  note?: string; // cuando Postgres/tablas no disponibles
}

/* ============================================================
 * Hook react-query.
 * ============================================================ */

const POLL_MS = 30_000;

type FetchState =
  | { status: "loading" }
  | { status: "ok"; payload: WarmupStatusSnapshot; lastUpdateAt: number }
  | { status: "error"; message: string };

function useWarmupStatus(): FetchState {
  const query = useQuery({
    queryKey: ["v5", "warmup", "status"],
    queryFn: () => getJson<WarmupStatusSnapshot>(READ_ENDPOINTS.warmupStatus),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS / 2
  });

  if (query.isLoading) return { status: "loading" };
  if (query.isError) {
    return {
      status: "error",
      message:
        query.error instanceof Error
          ? query.error.message
          : "no se pudo obtener el estado del warmup"
    };
  }
  if (query.data) {
    return { status: "ok", payload: query.data, lastUpdateAt: query.dataUpdatedAt };
  }
  return { status: "loading" };
}

type TrendsState =
  | { status: "loading" }
  | { status: "ok"; payload: WarmupTrends }
  | { status: "error"; message: string };

function useWarmupTrends(): TrendsState {
  const query = useQuery({
    queryKey: ["v5", "warmup", "trends"],
    queryFn: () => getJson<WarmupTrends>(READ_ENDPOINTS.warmupTrends),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS / 2
  });

  if (query.isLoading) return { status: "loading" };
  if (query.isError) {
    return {
      status: "error",
      message:
        query.error instanceof Error
          ? query.error.message
          : "no se pudo obtener las tendencias del warmup"
    };
  }
  if (query.data) return { status: "ok", payload: query.data };
  return { status: "loading" };
}

/* ============================================================
 * Estado helpers — mapeo al StateBadge del molde + copy por estado.
 *
 * StateBadge (aivora) resuelve icono/color/soft desde su STATE_MAP. Los estados
 * del warmup-engine llegan en minúscula; los mapeamos a las claves canónicas del
 * molde para heredar el mismo tratamiento visual (dot + icono + token semántico).
 * ============================================================ */

const AIV_STATE: Record<WarmupNodeState, string> = {
  fresh: "FRESH",
  warm: "WARM",
  paused: "PAUSED",
  blocked: "BLOCKED",
  quarantined: "QUARANTINED"
};

const STATE_LABEL: Record<WarmupNodeState, string> = {
  fresh: "fresh",
  warm: "warm",
  paused: "paused",
  blocked: "blocked",
  quarantined: "quarantined"
};

// Orden canónico para los chips de desglose: de "sano" a "crítico".
const STATE_ORDER: WarmupNodeState[] = [
  "warm",
  "fresh",
  "paused",
  "blocked",
  "quarantined"
];

function aivStatus(state: string): string {
  return AIV_STATE[state as WarmupNodeState] ?? state;
}

function stateLabel(state: string): string {
  return STATE_LABEL[state as WarmupNodeState] ?? state;
}

/* ============================================================
 * Placement score — umbral de color: verde ≥0.80, amarillo 0.70–0.80,
 * rojo <0.70. Coincide con los thresholds de deliverability del engine.
 * ============================================================ */

function placementTone(score: number): "success" | "warning" | "critical" {
  if (score >= 0.8) return "success";
  if (score >= 0.7) return "warning";
  return "critical";
}

function placementColor(score: number): string {
  const tone = placementTone(score);
  if (tone === "success") return "var(--color-success)";
  if (tone === "warning") return "var(--color-warning)";
  return "var(--color-critical)";
}

function formatPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/* ============================================================
 * Copy legible para el `note` del backend.
 * ============================================================ */

function noteCopy(note: string): { title: string; body: string } {
  switch (note) {
    case "postgres_unavailable":
      return {
        title: "Postgres no disponible",
        body: "El gateway no pudo leer el estado del warmup desde Postgres. Los conteos y la tabla de nodos pueden estar vacíos hasta que la base responda."
      };
    case "warmup_tables_unavailable":
      return {
        title: "Tablas de warmup no inicializadas",
        body: "Las tablas del warmup-engine todavía no existen en esta base. La vista se llena sola cuando el motor las cree, sin redeploy."
      };
    default:
      return {
        title: "Motor con aviso",
        body: note
      };
  }
}

/* ============================================================
 * Tiempo relativo.
 * ============================================================ */

function formatRelative(iso: string | null): string {
  if (!iso) return "sin datos";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return new Date(iso).toLocaleString("es-CO");
  if (diffMs < 60_000) return `hace ${Math.round(diffMs / 1000)}s`;
  if (diffMs < 3_600_000) return `hace ${Math.round(diffMs / 60_000)} min`;
  if (diffMs < 86_400_000) return `hace ${Math.round(diffMs / 3_600_000)} h`;
  return new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}

/* ============================================================
 * Superficie del molde — constantes + header interno de card.
 *
 * El molde Aivora usa una sola geometría de card (radius 18 + hairline, vía el
 * primitivo Card). El padding va por style; el título interno de cada panel
 * replica el patrón del demo (15px/500 + subtítulo tertiary), que no existe como
 * primitivo propio (SectionHead es el header de PÁGINA, 30px light).
 * ============================================================ */

const PAD_RELAXED = 20;
const PAD_DEFAULT = 16;

function PanelHead({
  title,
  sub,
  right
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
          {title}
        </div>
        {sub ? (
          <div style={{ fontSize: 12.5, color: "var(--color-text-tertiary)", marginTop: 2 }}>
            {sub}
          </div>
        ) : null}
      </div>
      {right ? <div style={{ flex: "none" }}>{right}</div> : null}
    </div>
  );
}

/** Tile de icono neutro del molde (misma geometría que el KpiCard/banner del demo). */
function IconTile({ children }: { children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 38,
        height: 38,
        borderRadius: 12,
        flex: "none",
        background: "color-mix(in srgb, var(--color-text-primary) 5%, transparent)",
        border: "1px solid var(--color-border)",
        display: "grid",
        placeItems: "center",
        color: "var(--color-text-secondary)"
      }}
    >
      {children}
    </div>
  );
}

/** Etiqueta "config" — marca un tope declarado (no un valor medido). Molde: Pill neutro. */
function ConfigCaption({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Caption style={{ fontSize: 11 }}>{children}</Caption>
      <Pill tone="neutral" style={{ fontSize: 10, padding: "2px 7px" }}>
        config
      </Pill>
    </span>
  );
}

/* ============================================================
 * Vista principal.
 * ============================================================ */

/** Buzón seleccionado para ver su historial (carril C). */
interface SelectedMailbox {
  id: string;
  mailbox: string;
}

export function WarmupV5() {
  const state = useWarmupStatus();
  const [selected, setSelected] = useState<SelectedMailbox | null>(null);
  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <SectionHead
          eyebrow="Warmup engine · solo lectura"
          title="Estado del calentamiento de nodos de envío"
          subtitle="Observabilidad del warmup-engine: nodos activos, envíos encolados, desglose por estado y rampa por mailbox. Esta vista no dispara envíos ni pausas."
          right={
            <LivePollSide
              lastUpdateAt={state.status === "ok" ? state.lastUpdateAt : null}
              isError={state.status === "error"}
            />
          }
        />
      </motion.div>

      <Body state={state} onSelectMailbox={setSelected} selectedId={selected?.id ?? null} />

      {selected ? (
        <motion.section variants={staggerItem}>
          <WarmupMailboxLog
            mailboxId={selected.id}
            mailbox={selected.mailbox}
            onClose={() => setSelected(null)}
          />
        </motion.section>
      ) : null}

      <motion.section variants={staggerItem}>
        <ManualMailboxForm />
      </motion.section>

      <motion.section variants={staggerItem}>
        <WarmupTrendsPanel />
      </motion.section>
    </motion.div>
  );
}

function Body({
  state,
  onSelectMailbox,
  selectedId
}: {
  state: FetchState;
  onSelectMailbox: (mailbox: SelectedMailbox) => void;
  selectedId: string | null;
}) {
  if (state.status === "loading") {
    return (
      <motion.div variants={staggerItem}>
        <LoadingBlock />
      </motion.div>
    );
  }
  if (state.status === "error") {
    return (
      <motion.div variants={staggerItem}>
        <BackendUnavailable message={state.message} />
      </motion.div>
    );
  }
  return <Loaded payload={state.payload} onSelectMailbox={onSelectMailbox} selectedId={selectedId} />;
}

function LivePollSide({
  lastUpdateAt,
  isError
}: {
  lastUpdateAt: number | null;
  isError: boolean;
}) {
  const relative = lastUpdateAt
    ? formatRelative(new Date(lastUpdateAt).toISOString())
    : "sin datos";
  return (
    <div className="flex flex-col items-end gap-1.5">
      <StateBadge status={isError ? "quarantined" : "active"} label={isError ? "fallo" : "en vivo"} />
      <Caption style={{ fontSize: 11 }}>
        poll {POLL_MS / 1000}s · {relative}
      </Caption>
    </div>
  );
}

/* ============================================================
 * Loaded — estructura principal.
 * ============================================================ */

function Loaded({
  payload,
  onSelectMailbox,
  selectedId
}: {
  payload: WarmupStatusSnapshot;
  onSelectMailbox: (mailbox: SelectedMailbox) => void;
  selectedId: string | null;
}) {
  const { enabled, totals, byState, nodes, note } = payload;
  return (
    <>
      {!enabled ? (
        <motion.div variants={staggerItem}>
          <EngineOffBanner />
        </motion.div>
      ) : null}

      {note ? (
        <motion.div variants={staggerItem}>
          <NoteBanner note={note} />
        </motion.div>
      ) : null}

      <motion.section variants={staggerItem}>
        <KpiStrip enabled={enabled} totals={totals} nodeCount={nodes.length} />
      </motion.section>

      <motion.section variants={staggerItem}>
        <StateBreakdown byState={byState} />
      </motion.section>

      <motion.section variants={staggerItem}>
        {nodes.length > 0 ? (
          <NodesTable nodes={nodes} onSelectMailbox={onSelectMailbox} selectedId={selectedId} />
        ) : (
          <NodesEmpty />
        )}
      </motion.section>

      <motion.div variants={staggerItem}>
        <FooterMeta generatedAt={payload.generatedAt} />
      </motion.div>
    </>
  );
}

/* ============================================================
 * Carga manual — form mínimo → POST /v1/mailboxes (Warmup API).
 *
 * UI mínima (el grueso vive en warmup-mailboxes-client). Idempotente del lado
 * del backend: reintentar el mismo email no duplica ni resetea el estado. La
 * referencia SMTP (vault) la deriva el backend del id del nodo; no se carga a mano
 * ni viaja la credencial. Tolera exists/error con gracia.
 * ============================================================ */

type ManualSubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "done"; result: WarmupMailboxCreateResult }
  | { status: "error"; message: string };

function ManualMailboxForm() {
  const [email, setEmail] = useState("");
  const [domain, setDomain] = useState("");
  const [submit, setSubmit] = useState<ManualSubmitState>({ status: "idle" });

  const derivedDomain = domain.trim() || email.split("@")[1]?.trim() || "";
  const canSubmit = email.includes("@") && derivedDomain.length > 0 && submit.status !== "submitting";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmit({ status: "submitting" });
    try {
      const result = await postWarmupMailbox({
        email: email.trim(),
        domain: derivedDomain
      });
      setSubmit({ status: "done", result });
      if (result.ok) {
        setEmail("");
        setDomain("");
      }
    } catch (err) {
      setSubmit({
        status: "error",
        message: err instanceof Error ? err.message : "no se pudo agregar el buzón"
      });
    }
  }

  return (
    <Card style={{ padding: PAD_RELAXED }} className="flex flex-col gap-4">
      <PanelHead
        title="Agregar un buzón al warmup"
        sub="Alta manual mínima contra POST /v1/mailboxes. El calentamiento real por envío lo hace el cliente con sus campañas."
        right={<Mono>POST /v1/mailboxes</Mono>}
      />
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ManualField label="Email del buzón" htmlFor="wm-email">
            <input
              id="wm-email"
              type="email"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              placeholder="warm@delivrix.io"
              autoComplete="off"
              className="h-8 w-full rounded-md border border-border bg-surface px-2.5 font-mono text-[16px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none sm:text-[12.5px]"
            />
          </ManualField>
          <ManualField label="Dominio" htmlFor="wm-domain" hint="se infiere del email si se deja vacío">
            <input
              id="wm-domain"
              type="text"
              value={domain}
              onChange={(ev) => setDomain(ev.target.value)}
              placeholder={email.split("@")[1] ?? "delivrix.io"}
              autoComplete="off"
              className="h-8 w-full rounded-md border border-border bg-surface px-2.5 font-mono text-[16px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none sm:text-[12.5px]"
            />
          </ManualField>
        </div>
        <Caption style={{ fontSize: 10.5 }}>
          La referencia SMTP (vault) la deriva el backend del id del nodo — no se carga a mano ni viaja la
          credencial. El nodo nace <span className="font-mono">blocked</span> hasta tener contrato de auth vigente (§8).
        </Caption>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={!canSubmit}>
            <Plus size={14} strokeWidth={1.75} />
            {submit.status === "submitting" ? "Agregando…" : "Agregar al warmup"}
          </Button>
        </div>
      </form>

      <ManualResult submit={submit} />
    </Card>
  );
}

function ManualField({
  label,
  htmlFor,
  hint,
  children
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">
        {label}
      </span>
      {children}
      {hint ? <Caption style={{ fontSize: 10.5 }}>{hint}</Caption> : null}
    </label>
  );
}

function ManualResult({ submit }: { submit: ManualSubmitState }) {
  if (submit.status === "idle" || submit.status === "submitting") return null;
  if (submit.status === "error") {
    return (
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Pill tone="critical">error</Pill>
        <Mono className="break-all">{submit.message}</Mono>
      </div>
    );
  }
  const { result } = submit;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Pill tone="success">{result.status === "exists" ? "ya existía" : "agregado"}</Pill>
      {result.id ? <MonoStrong className="text-[12px]">{result.id}</MonoStrong> : null}
      {result.state ? <Pill tone="neutral">estado {result.state}</Pill> : null}
      {result.message ? <BodyText className="text-fg-muted">{result.message}</BodyText> : null}
    </div>
  );
}

/* ============================================================
 * KPI Strip — engine ON/OFF + totales (grid de KpiCards del molde).
 *
 * DATOS REALES: los KPIs no traen serie histórica ni baseline, así que van sin
 * sparkline ni delta (nada decorativo). El estado del motor va como StateBadge.
 * ============================================================ */

function KpiStrip({
  enabled,
  totals,
  nodeCount
}: {
  enabled: boolean;
  totals: { activeNodes: number; queuedSends: number };
  nodeCount: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <IconTile>
          <Flame size={18} strokeWidth={1.7} color="var(--color-text-secondary)" />
        </IconTile>
        <span className="font-sans text-[14px] font-medium text-fg">
          {enabled ? "Motor activo" : "Motor inactivo"}
        </span>
        <StateBadge
          status={enabled ? "active" : "paused"}
          label={enabled ? "engine ON" : "engine OFF"}
        />
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <KpiCard
          label="Nodos activos"
          value={totals.activeNodes}
          icon={Activity}
        />
        <KpiCard
          label="Envíos encolados"
          value={totals.queuedSends}
          icon={LineChart}
        />
        <KpiCard
          label="Nodos en pool"
          value={nodeCount}
          icon={Layers}
        />
      </div>
    </div>
  );
}

/* ============================================================
 * StateBreakdown — StateBadge del molde + conteo por estado.
 * ============================================================ */

function StateBreakdown({ byState }: { byState: Record<string, number> }) {
  const entries = useMemo(() => {
    const known = STATE_ORDER.filter((s) => s in byState).map((s) => [s, byState[s]] as const);
    const extra = Object.entries(byState).filter(
      ([key]) => !STATE_ORDER.includes(key as WarmupNodeState)
    );
    return [...known, ...extra];
  }, [byState]);

  const total = entries.reduce((a, [, count]) => a + count, 0);

  return (
    // ink: stat-card. Agrupada por adyacencia bajo la banda de KpiCards (también ink)
    // → forman la "banda superior" oscura del marco cohesivo (demo §1). Tablas/forms/
    // detalle quedan claros en el centro. Sus internos (StateBadge/count/Caption) salen
    // de var(--color-*), re-escalados por .ink-card a la rampa oscura sin hex.
    <Card ink style={{ padding: PAD_RELAXED }} className="flex flex-col gap-4">
      <PanelHead
        title="Nodos por estado"
        sub="Cómo se reparte el pool de nodos entre las etapas del calentamiento."
        right={<Caption style={{ fontSize: 12.5 }}>{total} en total</Caption>}
      />
      {entries.length === 0 ? (
        <Caption>Sin nodos reportados en este snapshot.</Caption>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {entries.map(([state, count]) => (
            <span key={state} className="inline-flex items-center gap-2">
              <StateBadge status={aivStatus(state)} label={stateLabel(state)} />
              <span
                className="font-sans text-[13px] font-semibold tabular-nums"
                style={{ color: "var(--color-text-primary)" }}
              >
                {count}
              </span>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ============================================================
 * NodesTable — filas grid del molde (StateBadge + left-border por estado).
 * ============================================================ */

const NODE_COLS = "minmax(0,1.6fr) auto auto auto auto";

function NodesTable({
  nodes,
  onSelectMailbox,
  selectedId
}: {
  nodes: WarmupNode[];
  onSelectMailbox: (mailbox: SelectedMailbox) => void;
  selectedId: string | null;
}) {
  return (
    <Card className="overflow-hidden">
      <div style={{ padding: `${PAD_RELAXED}px ${PAD_RELAXED}px 14px` }}>
        <PanelHead
          title="Nodos en warmup"
          sub="Mailbox, dominio, etapa, día de rampa, readiness de auth y placement. Clic en una fila para ver su historial."
          right={<Caption style={{ fontSize: 12.5 }}>{nodes.length} en el pool</Caption>}
        />
      </div>
      <div className="overflow-x-auto">
        <div style={{ minWidth: 640 }}>
          <div
            className="grid items-center gap-3 border-b border-border px-5 py-2"
            style={{
              gridTemplateColumns: NODE_COLS,
              fontSize: 11,
              letterSpacing: ".05em",
              textTransform: "uppercase",
              color: "var(--color-text-tertiary)"
            }}
          >
            <span>Mailbox</span>
            <span style={{ textAlign: "right" }}>Estado</span>
            <span style={{ textAlign: "right" }}>Día</span>
            <span style={{ textAlign: "right" }}>Auth</span>
            <span style={{ textAlign: "right" }}>Placement</span>
          </div>
          {nodes.map((node) => {
            const status = aivStatus(node.state);
            const lb = stateNeedsLeftBorder(status);
            const isSel = selectedId === node.id;
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelectMailbox({ id: node.id, mailbox: node.mailbox })}
                aria-selected={isSel}
                className="grid w-full items-center gap-3 border-b border-border px-5 py-3 text-left transition-colors hover:bg-surface-sunken aria-selected:bg-surface-sunken"
                style={{
                  gridTemplateColumns: NODE_COLS,
                  borderLeft: lb ? `2px solid ${stateColor(status)}` : "2px solid transparent"
                }}
              >
                <span className="min-w-0">
                  <MonoStrong className="block truncate text-[12.5px] text-fg">{node.mailbox}</MonoStrong>
                  <span className="block truncate font-sans text-[11.5px] text-fg-subtle">
                    {node.domain}
                  </span>
                </span>
                <span style={{ justifySelf: "end" }}>
                  <StateBadge status={status} label={stateLabel(node.state)} />
                </span>
                <span style={{ justifySelf: "end" }}>
                  <Pill tone="neutral">día {node.dayIndex}</Pill>
                </span>
                <span style={{ justifySelf: "end" }}>
                  {node.authReady ? (
                    <Pill tone="success">lista</Pill>
                  ) : (
                    <Pill tone="warning">pendiente</Pill>
                  )}
                </span>
                <span style={{ justifySelf: "end" }}>
                  {typeof node.placementScore === "number" ? (
                    <span
                      className="font-sans text-[13px] font-semibold tabular-nums"
                      style={{ color: placementColor(node.placementScore) }}
                      title={`placement score ${node.placementScore.toFixed(2)}`}
                    >
                      {formatPercent(node.placementScore)}
                    </span>
                  ) : (
                    <Mono className="text-fg-subtle">sin dato</Mono>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/* ============================================================
 * Banners — engine off / note.
 * ============================================================ */

function EngineOffBanner() {
  return (
    <Card style={{ padding: PAD_DEFAULT, borderColor: "var(--color-border-strong)" }} className="flex items-start gap-4">
      <IconTile>
        <PauseCircle size={16} strokeWidth={1.75} color="var(--color-text-secondary)" />
      </IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Heading level={2}>Warmup engine inactivo</Heading>
        <BodyText>
          El flag <Mono>WARMUP_ENGINE_ENABLE</Mono> está apagado. El motor
          no procesa rampas; los conteos abajo reflejan el último estado
          persistido, sin actividad nueva.
        </BodyText>
      </div>
    </Card>
  );
}

function NoteBanner({ note }: { note: string }) {
  const copy = noteCopy(note);
  return (
    <Card style={{ padding: PAD_DEFAULT, borderColor: "var(--color-warning-border)" }} className="flex items-start gap-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning"
      >
        <AlertCircle size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Heading level={2}>{copy.title}</Heading>
        <BodyText>{copy.body}</BodyText>
        <Mono className="break-all">note: {note}</Mono>
      </div>
    </Card>
  );
}

/* ============================================================
 * Estados de carga / error / vacío.
 * ============================================================ */

function LoadingBlock() {
  return (
    <Card style={{ padding: PAD_RELAXED }} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3">
            <div className="h-9 w-9 rounded-xl bg-surface-sunken" aria-hidden="true" />
            <div className="h-3 w-20 rounded bg-surface-sunken" aria-hidden="true" />
            <div className="h-8 w-16 rounded bg-surface-sunken" aria-hidden="true" />
          </div>
        ))}
      </div>
      <span className="sr-only">Cargando estado del warmup engine…</span>
    </Card>
  );
}

function BackendUnavailable({ message }: { message: string }) {
  return (
    <Card style={{ padding: PAD_RELAXED }} className="flex items-start gap-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning"
      >
        <AlertCircle size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Heading level={2}>Endpoint /v1/warmup/status no responde</Heading>
        <BodyText>
          El backend todavía no expuso el estado del warmup engine. Cuando esté
          disponible, esta vista se llena sin redeploy.
        </BodyText>
        <Mono className="break-all">{message}</Mono>
      </div>
    </Card>
  );
}

function NodesEmpty() {
  return (
    <Card style={{ padding: PAD_RELAXED }} className="flex items-start gap-4">
      <IconTile>
        <Flame size={16} strokeWidth={1.75} color="var(--color-text-secondary)" />
      </IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Heading level={2}>Sin nodos en warmup</Heading>
        <BodyText>
          El engine no reporta nodos en calentamiento en este snapshot. Cuando se
          registre un ramp, sus nodos aparecen acá.
        </BodyText>
      </div>
    </Card>
  );
}

/* ============================================================
 * Footer.
 * ============================================================ */

function FooterMeta({ generatedAt }: { generatedAt: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <Mono>GET /v1/warmup/status</Mono>
        <span
          aria-hidden="true"
          className="inline-block size-[3px] rounded-full bg-border-strong"
        />
        <Caption>snapshot {formatRelative(generatedAt)}</Caption>
      </div>
    </div>
  );
}

/* ============================================================
 * Trends — 3 gráficos alimentados por GET /v1/warmup/trends.
 *
 * Sin librerías de charting: los line/area son <svg> con paths a mano y
 * `vector-effect="non-scaling-stroke"` para que el trazo quede fino aunque
 * el viewBox se estire al 100% del ancho; las barras apiladas son <div> con
 * anchos en %. Todo el color sale de var(--color-*), así que los gráficos
 * siguen el tema dark/light sin hex fijos. El sparkline de placement va en
 * ACENTO (molde); los segmentos por proveedor conservan su token semántico
 * porque son categorías (inbox/tabs/spam/missing) con significado propio.
 * ============================================================ */

const PLACEMENT_FLOOR = 0.8; // umbral de inbox placement — mismo que el engine (config).
const RAMP_CLAMP = 50; // techo de quota/día (clamp de seguridad del ramp) (config).

const PROVIDER_SEGMENTS = [
  { key: "inbox", label: "inbox", color: "var(--color-success)" },
  { key: "tabs", label: "tabs", color: "var(--color-warning)" },
  { key: "spam", label: "spam", color: "var(--color-critical)" },
  { key: "missing", label: "missing", color: "var(--color-text-tertiary)" }
] as const;

// Geometría compartida de los <svg> de línea/área.
const CHART_W = 640;
const CHART_H = 140;
const CHART_PAD_Y = 14;

function scaleY(norm: number): number {
  // norm ∈ [0,1] → coordenada Y (invertida, 0 abajo).
  const usable = CHART_H - CHART_PAD_Y * 2;
  return CHART_PAD_Y + (1 - norm) * usable;
}

function scaleX(index: number, count: number): number {
  if (count <= 1) return CHART_W / 2;
  return (index / (count - 1)) * CHART_W;
}

function linePath(points: Array<{ x: number; y: number }>): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
}

function areaPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L${last.x.toFixed(1)},${CHART_H} L${first.x.toFixed(1)},${CHART_H} Z`;
}

function formatDeltaPp(delta: number): string {
  const pts = Math.round(delta * 100);
  return `${pts >= 0 ? "+" : "-"}${Math.abs(pts)} pp`;
}

function WarmupTrendsPanel() {
  const state = useWarmupTrends();
  if (state.status === "loading") return <TrendsLoading />;
  if (state.status === "error") return <TrendsUnavailable message={state.message} />;
  return <TrendsLoaded payload={state.payload} />;
}

function TrendsLoaded({ payload }: { payload: WarmupTrends }) {
  const { placementSeries, perProvider, ramp, signals, note } = payload;
  const isEmpty =
    placementSeries.length === 0 && perProvider.length === 0 && ramp.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {note || isEmpty ? <TrendsNoteBanner note={note} /> : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <PlacementTrendCard series={placementSeries} signals={signals} />
        <RampCurveCard ramp={ramp} />
      </div>

      <ProviderPlacementCard rows={perProvider} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <Mono>GET /v1/warmup/trends</Mono>
          <span
            aria-hidden="true"
            className="inline-block size-[3px] rounded-full bg-border-strong"
          />
          <Caption>snapshot {formatRelative(payload.generatedAt)}</Caption>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
 * 1) Tendencia de inbox placement — sparkline área + línea (ACENTO).
 * ------------------------------------------------------------ */

function PlacementTrendCard({
  series,
  signals
}: {
  series: WarmupPlacementPoint[];
  signals: { bounces: number; complaints: number };
}) {
  const points = useMemo(() => {
    const values = series
      .map((p) => (typeof p.inboxWilsonLb === "number" ? p.inboxWilsonLb : p.inboxEwma))
      .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
      .filter((v): v is number => v !== null);
    return values.map((v, i) => ({
      v,
      x: scaleX(i, values.length),
      y: scaleY(Math.max(0, Math.min(1, v)))
    }));
  }, [series]);

  const last = points.length > 0 ? points[points.length - 1].v : null;
  const first = points.length > 0 ? points[0].v : null;
  const delta = last !== null && first !== null ? last - first : null;
  const refY = scaleY(PLACEMENT_FLOOR);

  return (
    // Tendencia = contenido de trabajo CLARO en el centro (demo: "Línea de rampa" es
    // clara; SPEC_UXUI §1.3 lista charts/timelines como CENTRO CLARO). Solo la banda de
    // KpiCards queda ink. Sus internos salen de var(--color-*) y re-valúan al tema claro.
    <Card style={{ padding: PAD_RELAXED }} className="flex flex-col gap-4">
      <PanelHead
        title={
          <span className="inline-flex items-center gap-2">
            <TrendingUp size={15} strokeWidth={1.75} className="text-fg-subtle" />
            Inbox placement
          </span>
        }
        right={<ConfigCaption>meta ≥ {formatPercent(PLACEMENT_FLOOR)}</ConfigCaption>}
      />

      {last !== null ? (
        <div className="flex items-baseline gap-2.5">
          <span
            className="font-sans text-[32px] font-semibold leading-none tabular-nums"
            style={{ color: placementColor(last) }}
          >
            {formatPercent(last)}
          </span>
          {delta !== null ? (
            <span
              className="text-[12.5px] font-semibold"
              style={{ color: delta >= 0 ? "var(--color-success)" : "var(--color-critical)" }}
            >
              {formatDeltaPp(delta)}
            </span>
          ) : null}
        </div>
      ) : (
        <Caption>Sin serie de placement en este snapshot.</Caption>
      )}

      {points.length > 0 ? (
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          width="100%"
          height={CHART_H}
          preserveAspectRatio="none"
          role="img"
          aria-label="Tendencia de inbox placement en el tiempo"
          className="block"
        >
          {/* línea de referencia en el piso de placement (0.80) */}
          <line
            x1={0}
            x2={CHART_W}
            y1={refY}
            y2={refY}
            stroke="var(--color-border-strong)"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          <path d={areaPath(points)} fill="var(--color-accent)" fillOpacity={0.14} stroke="none" />
          <path
            d={linePath(points)}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* endpoint enfatizado */}
          <circle
            cx={points[points.length - 1].x}
            cy={points[points.length - 1].y}
            r={3}
            fill="var(--color-accent)"
            stroke="var(--color-surface)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Caption style={{ fontSize: 11 }}>señales de daño</Caption>
        <Pill tone={signals.bounces > 0 ? "critical" : "neutral"}>
          bounces <span className="font-sans font-semibold tabular-nums">{signals.bounces}</span>
        </Pill>
        <Pill tone={signals.complaints > 0 ? "critical" : "neutral"}>
          complaints{" "}
          <span className="font-sans font-semibold tabular-nums">{signals.complaints}</span>
        </Pill>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------
 * 2) Colocación por proveedor — barras apiladas (categorías semánticas).
 * ------------------------------------------------------------ */

function ProviderPlacementCard({ rows }: { rows: WarmupProviderRow[] }) {
  return (
    <Card style={{ padding: PAD_RELAXED }} className="flex flex-col gap-4">
      <PanelHead
        title={
          <span className="inline-flex items-center gap-2">
            <BarChart3 size={15} strokeWidth={1.75} className="text-fg-subtle" />
            Colocación por proveedor
          </span>
        }
        right={
          <div className="flex flex-wrap items-center gap-3">
            {PROVIDER_SEGMENTS.map((seg) => (
              <span key={seg.key} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block size-2 rounded-[2px]"
                  style={{ background: seg.color }}
                />
                <Caption style={{ fontSize: 11 }}>{seg.label}</Caption>
              </span>
            ))}
          </div>
        }
      />

      {rows.length === 0 ? (
        <Caption>Sin desglose por proveedor en este snapshot.</Caption>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <ProviderBar key={row.provider} row={row} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ProviderBar({ row }: { row: WarmupProviderRow }) {
  const total = row.total > 0 ? row.total : row.inbox + row.tabs + row.spam + row.missing;
  const inboxRate =
    typeof row.inboxRate === "number"
      ? row.inboxRate
      : total > 0
      ? row.inbox / total
      : 0;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-sans text-[12.5px] font-medium text-fg">{row.provider}</span>
        <span
          className="font-sans text-[12.5px] font-semibold tabular-nums"
          style={{ color: placementColor(inboxRate) }}
          title={`inbox rate ${inboxRate.toFixed(2)}`}
        >
          {formatPercent(inboxRate)}
        </span>
      </div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`${row.provider}: ${row.inbox} inbox, ${row.tabs} tabs, ${row.spam} spam, ${row.missing} missing`}
      >
        {PROVIDER_SEGMENTS.map((seg) => {
          const value = row[seg.key];
          const width = pct(value);
          if (width <= 0) return null;
          return (
            <span
              key={seg.key}
              style={{ width: `${width}%`, background: seg.color }}
              className="h-full"
            />
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
 * 3) Curva de rampa — line chart quota vs dayIndex (ACENTO).
 * ------------------------------------------------------------ */

function RampCurveCard({ ramp }: { ramp: WarmupRampPoint[] }) {
  const geo = useMemo(() => {
    if (ramp.length === 0) return null;
    const ordered = [...ramp].sort((a, b) => a.dayIndex - b.dayIndex);
    const quotas = ordered.map((p) => p.quota);
    const yMax = Math.max(RAMP_CLAMP, ...quotas, 1);
    const points = ordered.map((p, i) => ({
      x: scaleX(i, ordered.length),
      y: scaleY(Math.max(0, Math.min(1, p.quota / yMax))),
      day: p.dayIndex,
      quota: p.quota
    }));
    return { points, yMax, refY: scaleY(Math.min(1, RAMP_CLAMP / yMax)) };
  }, [ramp]);

  const lastQuota = ramp.length > 0 ? geo?.points[geo.points.length - 1].quota ?? null : null;

  return (
    <Card style={{ padding: PAD_RELAXED }} className="flex flex-col gap-4">
      <PanelHead
        title={
          <span className="inline-flex items-center gap-2">
            <LineChart size={15} strokeWidth={1.75} className="text-fg-subtle" />
            Curva de rampa
          </span>
        }
        right={<ConfigCaption>clamp {RAMP_CLAMP}/día</ConfigCaption>}
      />

      {lastQuota !== null ? (
        <div className="flex items-baseline gap-1.5">
          <span className="font-sans text-[32px] font-semibold leading-none tabular-nums text-fg">
            {lastQuota}
          </span>
          <span className="font-sans text-[12px] leading-none text-fg-subtle">envíos/día</span>
        </div>
      ) : (
        <Caption>Sin curva de rampa en este snapshot.</Caption>
      )}

      {geo ? (
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          width="100%"
          height={CHART_H}
          preserveAspectRatio="none"
          role="img"
          aria-label="Curva de rampa: quota por día"
          className="block"
        >
          {/* línea de referencia del clamp */}
          <line
            x1={0}
            x2={CHART_W}
            y1={geo.refY}
            y2={geo.refY}
            stroke="var(--color-warning)"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={areaPath(geo.points)}
            fill="var(--color-accent)"
            fillOpacity={0.14}
            stroke="none"
          />
          <path
            d={linePath(geo.points)}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {geo.points.map((p) => (
            <circle
              key={p.day}
              cx={p.x}
              cy={p.y}
              r={2.5}
              fill="var(--color-accent)"
              stroke="var(--color-surface)"
              strokeWidth={1.25}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      ) : null}

      {geo ? (
        <Caption style={{ fontSize: 11 }}>
          día {geo.points[0].day} → día {geo.points[geo.points.length - 1].day} ·{" "}
          {geo.points.length} {geo.points.length === 1 ? "punto" : "puntos"}
        </Caption>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------
 * Trends — estados de carga / error / vacío.
 * ------------------------------------------------------------ */

function TrendsLoading() {
  return (
    <Card style={{ padding: PAD_RELAXED }} className="flex flex-col gap-3">
      <PanelHead
        title={
          <span className="inline-flex items-center gap-2">
            <Activity size={15} strokeWidth={1.75} className="text-fg-subtle" />
            Cargando tendencias
          </span>
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[140px] w-full rounded-xl bg-surface-sunken" aria-hidden="true" />
        ))}
      </div>
      <span className="sr-only">Cargando tendencias del warmup engine…</span>
    </Card>
  );
}

function TrendsUnavailable({ message }: { message: string }) {
  return (
    <Card style={{ padding: PAD_RELAXED }} className="flex items-start gap-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning"
      >
        <AlertCircle size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Heading level={2}>Endpoint /v1/warmup/trends no responde</Heading>
        <BodyText>
          El backend todavía no expuso las tendencias del warmup engine. Cuando
          esté disponible, los gráficos se llenan sin redeploy.
        </BodyText>
        <Mono className="break-all">{message}</Mono>
      </div>
    </Card>
  );
}

function TrendsNoteBanner({ note }: { note?: string }) {
  const copy = note
    ? noteCopy(note)
    : {
        title: "Sin datos de tendencia todavía",
        body: "El engine aún no acumuló suficientes envíos para construir las series de placement, la colocación por proveedor ni la curva de rampa. Los gráficos se llenan solos a medida que llegan resultados."
      };
  return (
    <Card style={{ padding: PAD_DEFAULT, borderColor: "var(--color-border-strong)" }} className="flex items-start gap-4">
      <IconTile>
        <Activity size={16} strokeWidth={1.75} color="var(--color-text-secondary)" />
      </IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Heading level={2}>{copy.title}</Heading>
        <BodyText>{copy.body}</BodyText>
        {note ? <Mono className="break-all">note: {note}</Mono> : null}
      </div>
    </Card>
  );
}
