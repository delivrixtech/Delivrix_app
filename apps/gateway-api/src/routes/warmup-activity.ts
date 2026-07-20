// Read-only HTTP route exposing the warmup ACTIVITY FEED for the Delivrix panel.
// The panel asks "what is warmup doing RIGHT NOW?"; the gateway reads the append-only
// `warmup_activity` log (one row per loop stage: sent → measured → engaged → replied) and
// returns the most recent events so the panel can render the loop in near-real-time.
//
// Purely observational: it NEVER runs the engine, NEVER sends mail, NEVER writes. It only reads.
// It also never surfaces secrets — the table only holds observable metadata by construction.
// Degraded-never-500: if the table isn't migrated yet, it returns an empty feed with a note so
// the panel shows an honest "sin actividad aún" instead of an error.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";
import type { PgClient } from "../../../warmup-engine/src/store/pg-stores.ts";

export interface WarmupActivityEvent {
  id: string;
  occurredAt: string;
  cycleId: string;
  nodeDomain: string;
  seedInbox: string;
  kind: "sent" | "measured" | "engaged" | "replied" | "error";
  placement: string | null;
  subject: string | null;
  detail: Record<string, unknown>;
  testId: string | null;
}

export interface WarmupActivitySnapshot {
  generatedAt: string;
  events: WarmupActivityEvent[];
  note?: string;
}

export interface WarmupActivityDeps {
  pgClient: PgClient | null;
  readBoundaryToken?: string;
  now?: () => Date;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  /** Máximo de eventos devueltos (default 60, tope duro 200). */
  limit?: number;
}

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

function empty(now: Date, note: string): WarmupActivitySnapshot {
  return { generatedAt: now.toISOString(), events: [], note };
}

export async function handleWarmupActivity(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupActivityDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(
    request,
    { readBoundaryToken: deps.readBoundaryToken },
    "warmup_activity"
  );
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const now = (deps.now ?? (() => new Date()))();

  if (!deps.pgClient) {
    json(response, 200, empty(now, "postgres_unavailable"));
    return;
  }

  const limit = clampLimit(deps.limit);

  try {
    const { rows } = await deps.pgClient.query<ActivityRow>(
      "SELECT id, occurred_at, cycle_id, node_domain, seed_inbox, kind, placement, subject, detail, test_id" +
        " FROM warmup_activity ORDER BY occurred_at DESC, id DESC LIMIT $1",
      [limit]
    );
    json(response, 200, {
      generatedAt: now.toISOString(),
      events: rows.map(toEvent)
    } satisfies WarmupActivitySnapshot);
  } catch (error) {
    // Tabla no migrada / query rota: feed vacío en vez de romper el panel. Read-only: nada que revertir.
    void deps.logger?.warn(
      "warmup.activity_read_failed",
      "Warmup activity read failed; returning empty feed.",
      { message: errorMessage(error) }
    );
    json(response, 200, empty(now, "warmup_activity_unavailable"));
  }
}

interface ActivityRow {
  id: string;
  occurred_at: string | Date;
  cycle_id: string;
  node_domain: string;
  seed_inbox: string;
  kind: string;
  placement: string | null;
  subject: string | null;
  detail: unknown;
  test_id: string | null;
}

function toEvent(row: ActivityRow): WarmupActivityEvent {
  const occurred = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at);
  return {
    id: String(row.id),
    occurredAt: occurred,
    cycleId: String(row.cycle_id),
    nodeDomain: String(row.node_domain),
    seedInbox: String(row.seed_inbox),
    kind: normalizeKind(row.kind),
    placement: row.placement ?? null,
    subject: row.subject ?? null,
    detail: isRecord(row.detail) ? row.detail : {},
    testId: row.test_id ?? null
  };
}

function normalizeKind(kind: string): WarmupActivityEvent["kind"] {
  return kind === "sent" || kind === "measured" || kind === "engaged" || kind === "replied" || kind === "error"
    ? kind
    : "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampLimit(raw: number | undefined): number {
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  const n = Math.floor(raw as number);
  if (n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
