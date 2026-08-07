/**
 * v5 Warmup — la pestaña de calentamiento (read-only).
 *
 * Estructura real, después de la limpieza del 2026-08-06:
 *   1. WarmupLive  — la consola: las vueltas que están pasando, desde warmup_activity (tráfico
 *      NUESTRO y solo nuestro).
 *   2. WarmupPlan  — la decisión del día por dominio: día, placement medido con su muestra, cupo
 *      y motivo. Sale de `planDelDia`, la MISMA función que consulta el daemon antes de actuar.
 *   3. Banners de /v1/warmup/status (engine off / nota de degradación).
 *   4. Tendencias de /v1/warmup/trends.
 *
 * La cabecera anterior describía secciones 1 y 2 —"WarmupLoop" y "KPI strip + Recorrido del
 * nodo"— que ya no existían: quedaban los bloques de comentario huérfanos y ~15 identificadores
 * declarados y nunca usados. Peor, WarmupActivityFeed.test.ts hacía SSR de este archivo para
 * testear `groupActivityByCycle`, código que la pantalla no renderizaba: tests verdes sobre nada.
 *
 * Advertencia sobre la mitad de abajo: las tendencias cuelgan de las tablas del motor v1
 * (warmup_placement_rollups, warmup_signals) que NADIE escribe en producción — su único escritor
 * es runWarmupTick, y a eso solo lo llama el dryrun-daemon. Por eso las "señales de daño" no
 * muestran número (los que había eran del backfill de fixtures) y la curva de rampa está rotulada
 * "referencia teórica · no medido" en pantalla, no solo en un comentario.
 *
 * Anti-mock: cada cifra sale del backend; no hay conteos ni series inventadas. Si un dato no
 * existe se dice "no medido", nunca un número falso.
 */

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  AlertCircle,
  BarChart3,
  LineChart,
  PauseCircle,
  ShieldCheck,
  TrendingUp
} from "lucide-react";
import WarmupLive from "./WarmupLive";
import WarmupPlan from "./WarmupPlan";
import { getJson } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import { staggerContainer, staggerItem } from "../lib/motion";
import { Caption, Card, Heading, Pill, SectionHead, StateBadge } from "../../shared/ui/aivora";

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

/* ============================================================
 * Vista principal.
 * ============================================================ */

// El selector de buzón se fue con NodesTable: su única entrada era un clic en una fila de esa
// tabla, que en producción nunca renderizaba (warmup_nodes está vacía para el warmup vivo). El
// componente WarmupMailboxLog y su test siguen en el repo, listos para cuando haya una entrada
// real; lo que se borró es el estado muerto que lo hacía parecer alcanzable.
export function WarmupV5() {
  const state = useWarmupStatus();
  // El loop combina agregados de AMBOS endpoints. react-query deduplica por queryKey,
  // así que WarmupTrendsPanel reusa esta misma lectura sin un fetch extra.
  const trends = useWarmupTrends();
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
          title="Calentamiento"
          subtitle="Lo que está pasando ahora."
          right={
            <LivePollSide
              lastUpdateAt={state.status === "ok" ? state.lastUpdateAt : null}
              isError={state.status === "error"}
            />
          }
        />
      </motion.div>

      {/* LA CONSOLA. Lo que está pasando ahora, moviéndose. Todo lo demás es detalle. */}
      <motion.section variants={staggerItem}>
        <WarmupLive />
      </motion.section>

      {/* EL PLAN. Por qué el agente manda lo que manda: día, placement medido, cupo y decisión.
          Va justo debajo de la consola porque responde la pregunta que la consola provoca. */}
      <motion.section variants={staggerItem}>
        <WarmupPlan />
      </motion.section>

      <Body state={state} trends={trends} />

      <motion.section variants={staggerItem}>
        <WarmupTrendsPanel />
      </motion.section>
    </motion.div>
  );
}

function Body({ state, trends }: { state: FetchState; trends: TrendsState }) {
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
  return <Loaded payload={state.payload} trends={trends} />;
}

function LivePollSide({
  lastUpdateAt,
  isError,
  pollMs = POLL_MS
}: {
  lastUpdateAt: number | null;
  isError: boolean;
  pollMs?: number;
}) {
  const relative = lastUpdateAt
    ? formatRelative(new Date(lastUpdateAt).toISOString())
    : "sin datos";
  return (
    <div className="flex flex-col items-end gap-1.5">
      <StateBadge status={isError ? "quarantined" : "active"} label={isError ? "fallo" : "en vivo"} />
      <Caption style={{ fontSize: 11 }}>
        poll {pollMs / 1000}s · {relative}
      </Caption>
    </div>
  );
}

/* ============================================================
 * Actividad en vivo: BORRADA de este archivo.
 *
 * `groupActivityByCycle` + sus tipos (WarmupActivityEvent/WarmupCycle/ACTIVITY_STAGES/…) eran un
 * export que la pantalla no renderizaba: quien muestra el feed es WarmupLive.tsx con
 * `agruparVueltas`. Peor, WarmupActivityFeed.test.ts hacía SSR de este archivo para testear la
 * función muerta — cobertura verde sobre código que nunca se ejecuta. El test se reapuntó a
 * `agruparVueltas`, que es la función que sí corre.
 * ============================================================ */

/* ============================================================
 * Loaded — estructura principal.
 * ============================================================ */

function Loaded({ payload }: { payload: WarmupStatusSnapshot; trends: TrendsState }) {
  const { enabled, note } = payload;
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

    </>
  );
}

/* ============================================================
 * NodesTable / NodesEmpty: BORRADOS.
 *
 * Colgaban de `warmup_nodes`, una tabla que el warmup vivo NO escribe (su único escritor es
 * runWarmupTick, y a eso solo lo llama el dryrun-daemon). En producción el endpoint devolvía
 * `nodes: []` y la pantalla decía "Sin nodos en warmup" mientras 6 dominios estaban calentando
 * según /v1/warmup/plan. No inventaba datos —eso estaba bien— pero AFIRMABA un vacío falso, y su
 * mensaje ("Cuando se registre un ramp, sus nodos aparecen acá") prometía un mecanismo que no es
 * el que corre.
 *
 * No se reescribió contra /v1/warmup/plan porque esa pantalla YA existe y va más arriba en esta
 * misma vista: WarmupPlan.tsx muestra, por dominio del pool real, el día, el placement medido con
 * su tamaño de muestra, el cupo y la decisión con su motivo. Dos tablas de lo mismo se
 * desincronizan; la que se queda es la que sale de la función que consulta el daemon.
 * ============================================================ */

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

/* ============================================================
 * Footer.
 * ============================================================ */


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
  // `ramp` es una CONSTANTE de configuración (un perfil sintético que el backend arma igual para
  // cualquier flota), así que nunca puede desmentir la ausencia de mediciones: con los 30 puntos
  // que trae siempre, `isEmpty` daba false y el banner "Sin datos de tendencia todavía" era
  // inalcanzable. Verificado en producción: serie vacía + proveedores vacíos + sin nota, y el
  // operador veía gráficos sin una sola línea que dijera que no hay medición detrás.
  const isEmpty = placementSeries.length === 0 && perProvider.length === 0;

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
    // El placement es la PUERTA (gate): mientras el inbox % esté bajo el piso, la rampa
    // no escala. Contenido de trabajo CLARO en el centro. Sus internos salen de tokens.
    <Card style={{ padding: PAD_RELAXED }} className="flex flex-col gap-4">
      <PanelHead
        title={
          <span className="inline-flex items-center gap-2">
            <ShieldCheck size={15} strokeWidth={1.75} className="text-fg-subtle" />
            Placement gate
          </span>
        }
        sub="El inbox % es la puerta que habilita escalar volumen: bajo el piso, la rampa se frena."
      />

      {last !== null ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span
            className="font-sans text-[32px] font-semibold leading-none tabular-nums"
            style={{ color: placementColor(last) }}
          >
            {formatPercent(last)}
          </span>
          {delta !== null ? (
            <span
              className="inline-flex items-center gap-1 text-[12.5px] font-semibold"
              style={{ color: delta >= 0 ? "var(--color-success)" : "var(--color-critical)" }}
              title="cambio desde el inicio de la serie"
            >
              <TrendingUp
                size={13}
                strokeWidth={2}
                style={{ transform: delta >= 0 ? "none" : "scaleY(-1)" }}
              />
              {formatDeltaPp(delta)}
            </span>
          ) : null}
          {/* Se fue el pill "sobre el piso · escala habilitada / bajo el piso · escala frenada":
              declaraba un gate global de 0.80 sobre una serie de TODA la flota, con el umbral
              copiado a mano en este archivo. El freno real es POR DOMINIO y por evidencia
              (decidirCupoDeHoy exige un mínimo de mediciones en ventana temporal), y ya hubo un
              incidente por confundir un umbral global con la puerta real. La decisión que sí
              frena se muestra arriba, en el plan del día (decision.accion + decision.motivo). */}
          <Pill tone="neutral">referencia de flota · el freno se decide por dominio</Pill>
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

      {/* Las pills "señales de daño · bounces 2 · complaints 1" pintaban FIXTURES como daño real:
          las 3 filas de warmup_signals que producían esos números pertenecen a
          hello@annualfilings-infra.com, un nodo del backfill — el mismo tipo de nodo que
          listActiveNodes descarta (pg-stores.ts:153, `hello@%`) y cuyos rollups el filtro
          @panel.test descarta (pg-stores.ts:498-509). `countRecent` es la ÚNICA lectura de la
          familia que quedó sin filtro anti-fixture. Y de fondo: nada del camino en producción
          escribe warmup_signals — la fuente viva de rebotes es warmup_activity kind='error'.
          Hasta que el backend filtre y mida, acá no va un número. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Caption style={{ fontSize: 11 }}>señales de daño</Caption>
        <Pill tone="neutral">sin señales medidas</Pill>
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

/**
 * Plan de rampa por semanas: agrupa la curva de referencia (ramp) en ventanas de 7
 * días y reporta el rango de cupo por semana. DERIVADO de datos reales (no inventado):
 * refleja exactamente la curva que devuelve /trends, resumida por semana.
 */
interface RampWeek {
  week: number;
  dayFrom: number;
  dayTo: number;
  quotaFrom: number;
  quotaTo: number;
}

function rampWeeks(ramp: WarmupRampPoint[]): RampWeek[] {
  if (ramp.length === 0) return [];
  const ordered = [...ramp].sort((a, b) => a.dayIndex - b.dayIndex);
  const buckets = new Map<number, WarmupRampPoint[]>();
  for (const p of ordered) {
    const week = Math.floor((p.dayIndex - 1) / 7) + 1;
    const list = buckets.get(week) ?? [];
    list.push(p);
    buckets.set(week, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, pts]) => {
      const quotas = pts.map((p) => p.quota);
      return {
        week,
        dayFrom: pts[0].dayIndex,
        dayTo: pts[pts.length - 1].dayIndex,
        quotaFrom: Math.min(...quotas),
        quotaTo: Math.max(...quotas)
      };
    });
}

function RampCurveCard({ ramp }: { ramp: WarmupRampPoint[] }) {
  const weeks = useMemo(() => rampWeeks(ramp), [ramp]);
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
      {/* Este número gigante ("50 envíos/día") NO es de nadie: el backend arma un perfil de
          referencia sintético (dailyLimit 50, +2 por día) idéntico para cualquier flota, que no
          corresponde a ningún nodo ni a ninguna decisión. El plan real de hoy es cupo 2 u 8 por
          dominio con tope global de 14 vueltas/día, y se muestra arriba en "El plan del día". La
          palabra "referencia" aparecía solo en los comentarios del código; ahora está en pantalla. */}
      <PanelHead
        title={
          <span className="inline-flex items-center gap-2">
            <LineChart size={15} strokeWidth={1.75} className="text-fg-subtle" />
            Curva de rampa
          </span>
        }
        right={<Pill tone="neutral">referencia teórica · no medido</Pill>}
      />

      {lastQuota !== null ? (
        <div className="flex items-baseline gap-1.5">
          <span className="font-sans text-[32px] font-semibold leading-none tabular-nums text-fg-subtle">
            {lastQuota}
          </span>
          <span className="font-sans text-[12px] leading-none text-fg-subtle">
            envíos/día del perfil teórico · el cupo que se ejecuta está en el plan del día
          </span>
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

      {weeks.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          
          <div className="flex flex-wrap gap-2">
            {weeks.map((w) => (
              <div
                key={w.week}
                className="flex flex-col gap-0.5 rounded-[10px] px-2.5 py-1.5"
                style={{ border: "1px solid var(--color-border)" }}
              >
                <span className="font-sans text-[11px] font-semibold text-fg">
                  Semana {w.week}
                </span>
                <span className="font-sans text-[11px] tabular-nums text-fg-subtle">
                  días {w.dayFrom}–{w.dayTo} ·{" "}
                  {w.quotaFrom === w.quotaTo
                    ? `${w.quotaTo}/día`
                    : `${w.quotaFrom}→${w.quotaTo}/día`}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : geo ? (
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
