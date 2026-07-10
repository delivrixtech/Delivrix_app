/**
 * v5 Warmup — visibilidad read-only del warmup-engine.
 *
 * Observabilidad pura: consume GET /v1/warmup/status y muestra el estado del
 * motor de calentamiento (activeNodes, queuedSends, desglose por estado y la
 * tabla de nodos). NO dispara nada — cada arranque/pausa de ramp vive en otras
 * superficies gated. Esta vista solo lee.
 *
 * Replica 1:1 el patrón de Infrastructure.tsx:
 *   - fetch con getJson(READ_ENDPOINTS.warmupStatus) dentro del read boundary.
 *   - useQuery con polling + estados loading/error/ok.
 *   - PageHead + staggerContainer/staggerItem + primitivos v5 (Card, Stat, Pill).
 *
 * Wiring: la vista hace su propia query. No requiere props del shell.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { AlertCircle, Flame, PauseCircle } from "lucide-react";
import { getJson } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Badge,
  BodySm,
  Caption,
  Card,
  Eyebrow,
  H3,
  MonoCode,
  MonoData,
  Pill,
  SectionHead,
  Stat
} from "../components/primitives";
import { PageHead } from "./_PageHead";

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

/* ============================================================
 * Estado helpers — tono + copy por estado de nodo.
 * ============================================================ */

const STATE_TONE: Record<
  WarmupNodeState,
  "success" | "warning" | "critical" | "info" | "neutral"
> = {
  fresh: "info",
  warm: "success",
  paused: "warning",
  blocked: "critical",
  quarantined: "critical"
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

function stateTone(state: string): "success" | "warning" | "critical" | "info" | "neutral" {
  return STATE_TONE[state as WarmupNodeState] ?? "neutral";
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
 * Vista principal.
 * ============================================================ */

export function WarmupV5() {
  const state = useWarmupStatus();
  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow="Warmup engine"
          meta="Solo lectura"
          title="Estado del calentamiento de nodos de envío."
          body="Observabilidad del warmup-engine: nodos activos, envíos encolados, desglose por estado y rampa por mailbox. Solo lectura — esta vista no dispara envíos ni pausas."
          trailing={
            <LivePollSide
              lastUpdateAt={state.status === "ok" ? state.lastUpdateAt : null}
              isError={state.status === "error"}
            />
          }
        />
      </motion.div>

      <Body state={state} />
    </motion.div>
  );
}

function Body({ state }: { state: FetchState }) {
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
  return <Loaded payload={state.payload} />;
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
      <Pill tone={isError ? "critical" : "success"} size="sm">
        {isError ? "fallo" : "en vivo"}
      </Pill>
      <Caption className="text-[11px]">
        poll {POLL_MS / 1000}s · {relative}
      </Caption>
    </div>
  );
}

/* ============================================================
 * Loaded — estructura principal.
 * ============================================================ */

function Loaded({ payload }: { payload: WarmupStatusSnapshot }) {
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

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Distribución"
          title="Nodos por estado"
          caption="Cómo se reparte el pool de nodos entre las etapas del calentamiento."
          count={Object.values(byState).reduce((a, b) => a + b, 0)}
          countTone="neutral"
        />
        <StateBreakdown byState={byState} />
      </motion.section>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Nodos"
          title="Nodos en warmup"
          caption="Mailbox, dominio, etapa, día de rampa, readiness de auth y placement score."
          count={nodes.length}
          countTone="neutral"
        />
        {nodes.length > 0 ? <NodesTable nodes={nodes} /> : <NodesEmpty />}
      </motion.section>

      <motion.div variants={staggerItem}>
        <FooterMeta generatedAt={payload.generatedAt} />
      </motion.div>
    </>
  );
}

/* ============================================================
 * KPI Strip — engine ON/OFF + totales.
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
    <Card padding="relaxed">
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-md"
              style={{
                background: enabled ? "var(--color-success-soft)" : "var(--color-surface-sunken)",
                color: enabled ? "var(--color-success)" : "var(--color-text-tertiary)"
              }}
            >
              <Flame size={16} strokeWidth={1.75} />
            </div>
            <div className="flex flex-col gap-0.5">
              <Eyebrow>Engine</Eyebrow>
              <span className="font-sans text-[14px] font-semibold leading-none text-fg">
                {enabled ? "Motor activo" : "Motor inactivo"}
              </span>
            </div>
          </div>
          <Pill tone={enabled ? "success" : "neutral"} size="lg">
            {enabled ? "ON" : "OFF"}
          </Pill>
        </div>
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-3">
          <Stat
            label="Nodos activos"
            value={totals.activeNodes}
            unit={totals.activeNodes === 1 ? "nodo" : "nodos"}
            tone={totals.activeNodes > 0 ? "success" : "default"}
            hint={`${nodeCount} en el pool`}
          />
          <Stat
            label="Envíos encolados"
            value={totals.queuedSends}
            unit={totals.queuedSends === 1 ? "envío" : "envíos"}
            tone={totals.queuedSends > 0 ? "warning" : "default"}
            hint="pendientes de despacho"
          />
          <Stat
            label="Nodos en pool"
            value={nodeCount}
            unit={nodeCount === 1 ? "nodo" : "nodos"}
            hint="incluye pausados y bloqueados"
          />
        </div>
      </div>
    </Card>
  );
}

/* ============================================================
 * StateBreakdown — chips de color por estado.
 * ============================================================ */

function StateBreakdown({ byState }: { byState: Record<string, number> }) {
  const entries = useMemo(() => {
    const known = STATE_ORDER.filter((s) => s in byState).map((s) => [s, byState[s]] as const);
    const extra = Object.entries(byState).filter(
      ([key]) => !STATE_ORDER.includes(key as WarmupNodeState)
    );
    return [...known, ...extra];
  }, [byState]);

  if (entries.length === 0) {
    return (
      <Card padding="default">
        <Caption>Sin nodos reportados en este snapshot.</Caption>
      </Card>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([state, count]) => (
        <Pill key={state} tone={stateTone(state)} size="lg">
          {stateLabel(state)}
          <span className="font-mono font-semibold tabular-nums">{count}</span>
        </Pill>
      ))}
    </div>
  );
}

/* ============================================================
 * NodesTable — tabla densa de nodos.
 * ============================================================ */

function NodesTable({ nodes }: { nodes: WarmupNode[] }) {
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border">
              <Th>Mailbox</Th>
              <Th>Dominio</Th>
              <Th>Estado</Th>
              <Th align="right">Día rampa</Th>
              <Th>Auth</Th>
              <Th align="right">Placement</Th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node, index) => (
              <tr
                key={node.id}
                style={{ borderTop: index === 0 ? "none" : "1px solid var(--color-border)" }}
              >
                <Td>
                  <MonoData className="text-[12px] text-fg">{node.mailbox}</MonoData>
                </Td>
                <Td>
                  <span className="font-sans text-[12.5px] text-fg-muted">{node.domain}</span>
                </Td>
                <Td>
                  <Pill tone={stateTone(node.state)} size="sm">
                    {stateLabel(node.state)}
                  </Pill>
                </Td>
                <Td align="right">
                  <Badge>día {node.dayIndex}</Badge>
                </Td>
                <Td>
                  {node.authReady ? (
                    <Pill tone="success" size="sm">
                      lista
                    </Pill>
                  ) : (
                    <Pill tone="warning" size="sm">
                      pendiente
                    </Pill>
                  )}
                </Td>
                <Td align="right">
                  {typeof node.placementScore === "number" ? (
                    <span
                      className="font-mono text-[12.5px] font-semibold tabular-nums"
                      style={{ color: placementColor(node.placementScore) }}
                      title={`placement score ${node.placementScore.toFixed(2)}`}
                    >
                      {formatPercent(node.placementScore)}
                    </span>
                  ) : (
                    <MonoCode className="text-fg-subtle">sin dato</MonoCode>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Th({
  children,
  align = "left"
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className="px-4 py-2.5 font-mono text-[10px] font-semibold uppercase text-fg-subtle"
      style={{ letterSpacing: "0.12em", textAlign: align }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left"
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className="px-4 py-2.5 align-middle"
      style={{ textAlign: align }}
    >
      {children}
    </td>
  );
}

/* ============================================================
 * Banners — engine off / note.
 * ============================================================ */

function EngineOffBanner() {
  return (
    <Card
      padding="default"
      className="flex items-start gap-4"
      style={{ borderColor: "var(--color-border-strong)" }}
    >
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted"
      >
        <PauseCircle size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <H3>Warmup engine inactivo</H3>
        <BodySm>
          El flag <MonoCode>WARMUP_ENGINE_ENABLE</MonoCode> está apagado. El motor
          no procesa rampas; los conteos abajo reflejan el último estado
          persistido, sin actividad nueva.
        </BodySm>
      </div>
    </Card>
  );
}

function NoteBanner({ note }: { note: string }) {
  const copy = noteCopy(note);
  return (
    <Card
      padding="default"
      className="flex items-start gap-4"
      style={{ borderColor: "var(--color-warning-border)" }}
    >
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning"
      >
        <AlertCircle size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <H3>{copy.title}</H3>
        <BodySm>{copy.body}</BodySm>
        <MonoCode className="break-all">note: {note}</MonoCode>
      </div>
    </Card>
  );
}

/* ============================================================
 * Estados de carga / error / vacío.
 * ============================================================ */

function LoadingBlock() {
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <Eyebrow>Cargando</Eyebrow>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
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
    <Card padding="relaxed" className="flex items-start gap-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning"
      >
        <AlertCircle size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <H3>Endpoint /v1/warmup/status no responde</H3>
        <BodySm>
          El backend todavía no expuso el estado del warmup engine. Cuando esté
          disponible, esta vista se llena sin redeploy.
        </BodySm>
        <MonoCode className="break-all">{message}</MonoCode>
      </div>
    </Card>
  );
}

function NodesEmpty() {
  return (
    <Card padding="relaxed" className="flex items-start gap-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted"
      >
        <Flame size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <H3>Sin nodos en warmup</H3>
        <BodySm>
          El engine no reporta nodos en calentamiento en este snapshot. Cuando se
          registre un ramp, sus nodos aparecen acá.
        </BodySm>
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
        <MonoCode>GET /v1/warmup/status</MonoCode>
        <span
          aria-hidden="true"
          className="inline-block size-[3px] rounded-full bg-border-strong"
        />
        <Caption>snapshot {formatRelative(generatedAt)}</Caption>
      </div>
    </div>
  );
}
