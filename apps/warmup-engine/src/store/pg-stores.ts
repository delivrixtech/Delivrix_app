// Implementación Postgres de los puertos de persistencia (§12 del Diseño-v1).
// Este archivo es la ÚNICA capa que conoce SQL: mapea snake_case (DB) ↔ camelCase (dominio) y
// devuelve las 5 stores detrás de las interfaces de ports.ts. El scheduler/servicio nunca ve pg.
//
// Reglas duras:
//  - TODO valor de usuario viaja como parámetro ($1,$2…). NUNCA se interpola en el string SQL
//    (anti-inyección). Los únicos `${…}` en un template son índices numéricos de placeholder que
//    ESTA capa genera (p.ej. `$${i}`), jamás datos.
//  - No se importa 'pg' aquí: se recibe un `PgClient` inyectable (Pool.query-compatible). Los tests
//    usan un PgClient fake; ningún test toca una DB real.
//  - Idempotencia exactly-once por slot: la maneja la unicidad (node_id, slot_key) de warmup_sends
//    vía `ON CONFLICT DO NOTHING` — enqueue devuelve true sólo si insertó (rowCount>0).

import type { LandedIn, NodeState, SeedProvider, WarmupNode } from "../domain/types.ts";
import type {
  EngagedRecipient,
  PlacementTrendPoint,
  ProviderPlacement
} from "../domain/trends.ts";
import type {
  EngagedRecipientStore,
  NodeStore,
  PlacementStore,
  SeedStore,
  SendStore,
  SignalStore,
  StoredPlacementTest,
  StoredSeed,
  StoredSend,
  WarmupStores
} from "./ports.ts";

/**
 * Interface mínima inyectable, compatible con `pg` (Pool/Client).query. La lógica depende SÓLO de
 * esto; el driver real (node-postgres) o un fake de test lo satisfacen por igual.
 */
export interface PgClient {
  query<T = any>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

// ── Criterio de "nodo activo" (listActiveNodes) ──────────────────────────────────────────────────
// Activo = el scheduler puede programarle envíos/seeds: state ∈ {fresh, warm, paused}. Se EXCLUYEN
// `blocked` (default-deny, sin auth ready, §8) y `quarantined` (un check continuo regresó, §8). Nota:
// `paused` se incluye a propósito — un auto-pause (§9) es reversible y el nodo sigue vivo; el gate de
// salida real lo aplica el auth-gate/FSM aguas arriba, no esta consulta.
const ACTIVE_NODE_STATES: readonly NodeState[] = ["fresh", "warm", "paused"];

// ── Helpers de mapeo (DB → dominio) ──────────────────────────────────────────────────────────────

/** numeric/inet nullable → number|undefined. node-postgres devuelve numeric como string. */
function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" ? value : Number(value);
}

/** timestamptz nullable → Date|undefined. */
function dateOrUndefined(value: unknown): Date | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value as string | number);
}

/** text/inet nullable → string|undefined. */
function stringOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

/** date/timestamptz → ISO string. node-postgres devuelve `date` como Date o string según el parser. */
function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string | number).toISOString();
}

interface NodeRow {
  id: string;
  mailbox: string;
  domain: string;
  infra_type: string;
  state: string;
  auth_ready: boolean;
  contract_expires_at: unknown;
  sending_ip: unknown;
  helo_fqdn: unknown;
  daily_limit: number | string;
  increase_by_day: number | string;
  day_index: number | string;
  weekdays_only: boolean;
  health_score: unknown;
  placement_score: unknown;
}

function mapNode(row: NodeRow): WarmupNode {
  const node: WarmupNode = {
    id: row.id,
    mailbox: row.mailbox,
    domain: row.domain,
    infraType: row.infra_type as WarmupNode["infraType"],
    state: row.state as NodeState,
    authReady: row.auth_ready === true,
    dailyLimit: Number(row.daily_limit),
    increaseByDay: Number(row.increase_by_day),
    dayIndex: Number(row.day_index),
    weekdaysOnly: row.weekdays_only === true
  };
  const contractExpiresAt = dateOrUndefined(row.contract_expires_at);
  if (contractExpiresAt !== undefined) node.contractExpiresAt = contractExpiresAt;
  const sendingIp = stringOrUndefined(row.sending_ip);
  if (sendingIp !== undefined) node.sendingIp = sendingIp;
  const heloFqdn = stringOrUndefined(row.helo_fqdn);
  if (heloFqdn !== undefined) node.heloFqdn = heloFqdn;
  const healthScore = numberOrUndefined(row.health_score);
  if (healthScore !== undefined) node.healthScore = healthScore;
  const placementScore = numberOrUndefined(row.placement_score);
  if (placementScore !== undefined) node.placementScore = placementScore;
  return node;
}

// Columnas del nodo (una sola fuente de verdad para los SELECT, evita `SELECT *`).
const NODE_COLUMNS =
  "id, mailbox, domain, infra_type, state, auth_ready, contract_expires_at, sending_ip, " +
  "helo_fqdn, daily_limit, increase_by_day, day_index, weekdays_only, health_score, placement_score";

interface SendRow {
  id: string;
  node_id: string;
  slot_key: string;
  to_address: string;
  status: string;
  attempts: number | string;
}

function mapSend(row: SendRow): StoredSend {
  return {
    id: row.id,
    nodeId: row.node_id,
    slotKey: row.slot_key,
    toAddress: row.to_address,
    status: row.status as StoredSend["status"],
    attempts: Number(row.attempts)
  };
}

// ── NodeStore ────────────────────────────────────────────────────────────────────────────────────

function createNodeStore(client: PgClient): NodeStore {
  return {
    async listActiveNodes(): Promise<WarmupNode[]> {
      const { rows } = await client.query<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM warmup_nodes WHERE state = ANY($1) ORDER BY created_at`,
        [ACTIVE_NODE_STATES]
      );
      return rows.map(mapNode);
    },

    async getNode(id: string): Promise<WarmupNode | null> {
      const { rows } = await client.query<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM warmup_nodes WHERE id = $1`,
        [id]
      );
      return rows.length > 0 ? mapNode(rows[0]) : null;
    },

    async updateState(id: string, state: NodeState, placementScore?: number): Promise<void> {
      if (placementScore !== undefined) {
        await client.query(
          "UPDATE warmup_nodes SET state = $1, placement_score = $2, updated_at = now() WHERE id = $3",
          [state, placementScore, id]
        );
        return;
      }
      await client.query(
        "UPDATE warmup_nodes SET state = $1, updated_at = now() WHERE id = $2",
        [state, id]
      );
    },

    async setDayIndex(id: string, dayIndex: number): Promise<void> {
      await client.query(
        "UPDATE warmup_nodes SET day_index = $1, updated_at = now() WHERE id = $2",
        [dayIndex, id]
      );
    },

    async setAuthReady(id: string, authReady: boolean, contractExpiresAt?: Date): Promise<void> {
      if (contractExpiresAt !== undefined) {
        await client.query(
          "UPDATE warmup_nodes SET auth_ready = $1, contract_expires_at = $2, updated_at = now() WHERE id = $3",
          [authReady, contractExpiresAt, id]
        );
        return;
      }
      await client.query(
        "UPDATE warmup_nodes SET auth_ready = $1, updated_at = now() WHERE id = $2",
        [authReady, id]
      );
    }
  };
}

// ── SendStore ────────────────────────────────────────────────────────────────────────────────────

function createSendStore(client: PgClient): SendStore {
  return {
    async enqueue(input: { nodeId: string; slotKey: string; toAddress: string }): Promise<boolean> {
      const { rowCount } = await client.query(
        "INSERT INTO warmup_sends (node_id, slot_key, to_address, status) VALUES ($1, $2, $3, 'queued') " +
          "ON CONFLICT (node_id, slot_key) DO NOTHING",
        [input.nodeId, input.slotKey, input.toAddress]
      );
      return (rowCount ?? 0) > 0;
    },

    async listQueued(limit: number): Promise<StoredSend[]> {
      const { rows } = await client.query<SendRow>(
        "SELECT id, node_id, slot_key, to_address, status, attempts FROM warmup_sends " +
          "WHERE status = 'queued' ORDER BY created_at LIMIT $1",
        [limit]
      );
      return rows.map(mapSend);
    },

    async markStatus(
      id: string,
      status: StoredSend["status"],
      opts?: { attempts?: number; error?: string; sentAt?: Date }
    ): Promise<void> {
      const sets = ["status = $1"];
      const params: unknown[] = [status];
      let i = 2;
      if (opts?.attempts !== undefined) {
        sets.push(`attempts = $${i}`);
        params.push(opts.attempts);
        i++;
      }
      if (opts?.error !== undefined) {
        sets.push(`last_error = $${i}`);
        params.push(opts.error);
        i++;
      }
      if (opts?.sentAt !== undefined) {
        sets.push(`sent_at = $${i}`);
        params.push(opts.sentAt);
        i++;
      }
      params.push(id);
      await client.query(
        `UPDATE warmup_sends SET ${sets.join(", ")} WHERE id = $${i}`,
        params
      );
    }
  };
}

// ── SignalStore ──────────────────────────────────────────────────────────────────────────────────

function createSignalStore(client: PgClient): SignalStore {
  return {
    async record(input: {
      nodeId: string;
      kind: "bounce" | "complaint" | "deferral";
      detail?: unknown;
    }): Promise<void> {
      await client.query(
        "INSERT INTO warmup_signals (node_id, kind, detail) VALUES ($1, $2, $3)",
        [input.nodeId, input.kind, input.detail === undefined ? null : input.detail]
      );
    },

    async countRecent(since: Date): Promise<{ bounces: number; complaints: number }> {
      // Un solo scan de la ventana [since, now): cuenta cada kind con FILTER en vez de N queries.
      const { rows } = await client.query<{ bounces: unknown; complaints: unknown }>(
        "SELECT COUNT(*) FILTER (WHERE kind = 'bounce') AS bounces, " +
          "COUNT(*) FILTER (WHERE kind = 'complaint') AS complaints " +
          "FROM warmup_signals WHERE occurred_at >= $1",
        [since]
      );
      const row = rows[0];
      return {
        bounces: row ? Number(row.bounces ?? 0) : 0,
        complaints: row ? Number(row.complaints ?? 0) : 0
      };
    }
  };
}

// ── SeedStore ────────────────────────────────────────────────────────────────────────────────────

interface SeedRow {
  id: string;
  address: string;
  provider: string;
}

function createSeedStore(client: PgClient): SeedStore {
  return {
    async listEnabled(): Promise<StoredSeed[]> {
      const { rows } = await client.query<SeedRow>(
        "SELECT id, address, provider FROM warmup_seed_accounts WHERE enabled = true ORDER BY created_at"
      );
      return rows.map((row) => ({
        id: row.id,
        address: row.address,
        provider: row.provider as SeedProvider
      }));
    }
  };
}

// ── EngagedRecipientStore ────────────────────────────────────────────────────────────────────────

interface EngagedRow {
  address: string;
  weight: number | string;
}

function createEngagedRecipientStore(client: PgClient): EngagedRecipientStore {
  return {
    async listEnabled(): Promise<EngagedRecipient[]> {
      const { rows } = await client.query<EngagedRow>(
        "SELECT address, weight FROM warmup_engaged_recipients WHERE enabled = true ORDER BY created_at"
      );
      return rows.map((row) => ({
        address: row.address,
        source: "curated" as const,
        weight: Number(row.weight)
      }));
    }
  };
}

// ── PlacementStore ───────────────────────────────────────────────────────────────────────────────

interface PendingTestRow {
  test_id: string;
  node_id: string;
  seed_id: string;
  seed_provider: string;
  seed_inbox: string;
  sent_at: unknown;
}

interface RollupResultRow {
  test_id: string;
  node_id: string;
  seed_provider: string;
  landed_in: string | null;
  read_at: unknown;
}

interface RollupTrendRow {
  window_end: unknown;
  inbox_wilson_lb: unknown;
  inbox_ewma: unknown;
  spam_rate: unknown;
  samples: number | string;
}

interface ProviderPlacementRow {
  provider: string;
  inbox: number | string;
  tabs: number | string;
  spam: number | string;
  missing: number | string;
  total: number | string;
}

function createPlacementStore(client: PgClient): PlacementStore {
  return {
    async createTest(input: {
      nodeId: string;
      seedId: string;
      testId: string;
      seedProvider: SeedProvider;
      seedInbox: string;
      sentAt: Date;
    }): Promise<void> {
      // warmup_placement_tests sólo persiste node_id/seed_id/test_id/sent_at; provider e inbox se
      // reconstruyen por JOIN con warmup_seed_accounts en listPendingTests (no se duplican aquí).
      await client.query(
        "INSERT INTO warmup_placement_tests (node_id, seed_id, test_id, sent_at) VALUES ($1, $2, $3, $4)",
        [input.nodeId, input.seedId, input.testId, input.sentAt]
      );
    },

    async listPendingTests(): Promise<StoredPlacementTest[]> {
      // Pendiente = sin fila de resultado, o con resultado aún sin clasificar (landed_in IS NULL).
      const { rows } = await client.query<PendingTestRow>(
        "SELECT t.test_id, t.node_id, t.seed_id, s.provider AS seed_provider, " +
          "s.address AS seed_inbox, t.sent_at " +
          "FROM warmup_placement_tests t " +
          "JOIN warmup_seed_accounts s ON s.id = t.seed_id " +
          "LEFT JOIN warmup_placement_results r ON r.test_id = t.test_id " +
          "WHERE r.id IS NULL OR r.landed_in IS NULL " +
          "ORDER BY t.sent_at"
      );
      return rows.map((row) => ({
        testId: row.test_id,
        nodeId: row.node_id,
        seedId: row.seed_id,
        seedProvider: row.seed_provider as SeedProvider,
        seedInbox: row.seed_inbox,
        sentAt: dateOrUndefined(row.sent_at) ?? new Date(row.sent_at as string | number)
      }));
    },

    async recordResult(input: {
      testId: string;
      nodeId: string;
      provider: SeedProvider;
      landedIn: LandedIn;
      readAt: Date;
    }): Promise<void> {
      await client.query(
        "INSERT INTO warmup_placement_results (test_id, node_id, provider, landed_in, read_at) " +
          "VALUES ($1, $2, $3, $4, $5)",
        [input.testId, input.nodeId, input.provider, input.landedIn, input.readAt]
      );
    },

    async listResultsForRollup(
      nodeId: string,
      since: Date
    ): Promise<Array<{ testId: string; nodeId: string; seedProvider: SeedProvider; landedIn: LandedIn | null; readAt?: Date }>> {
      const { rows } = await client.query<RollupResultRow>(
        "SELECT test_id, node_id, provider AS seed_provider, landed_in, read_at " +
          "FROM warmup_placement_results WHERE node_id = $1 AND read_at >= $2 ORDER BY read_at",
        [nodeId, since]
      );
      return rows.map((row) => {
        const out: { testId: string; nodeId: string; seedProvider: SeedProvider; landedIn: LandedIn | null; readAt?: Date } = {
          testId: row.test_id,
          nodeId: row.node_id,
          seedProvider: row.seed_provider as SeedProvider,
          landedIn: (row.landed_in as LandedIn | null) ?? null
        };
        const readAt = dateOrUndefined(row.read_at);
        if (readAt !== undefined) out.readAt = readAt;
        return out;
      });
    },

    async latestEwma(nodeId: string): Promise<number | undefined> {
      const { rows } = await client.query<{ inbox_ewma: unknown }>(
        "SELECT inbox_ewma FROM warmup_placement_rollups WHERE node_id = $1 ORDER BY window_end DESC LIMIT 1",
        [nodeId]
      );
      return rows.length > 0 ? numberOrUndefined(rows[0].inbox_ewma) : undefined;
    },

    async upsertRollup(input: {
      nodeId: string;
      windowStart: Date;
      windowEnd: Date;
      samples: number;
      inboxCount: number;
      spamCount: number;
      missingCount: number;
      inboxWilsonLb?: number;
      inboxEwma?: number;
    }): Promise<void> {
      await client.query(
        "INSERT INTO warmup_placement_rollups " +
          "(node_id, window_start, window_end, samples, inbox_count, spam_count, missing_count, inbox_wilson_lb, inbox_ewma) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) " +
          "ON CONFLICT (node_id, window_start, window_end) DO UPDATE SET " +
          "samples = EXCLUDED.samples, inbox_count = EXCLUDED.inbox_count, spam_count = EXCLUDED.spam_count, " +
          "missing_count = EXCLUDED.missing_count, inbox_wilson_lb = EXCLUDED.inbox_wilson_lb, " +
          "inbox_ewma = EXCLUDED.inbox_ewma",
        [
          input.nodeId,
          input.windowStart,
          input.windowEnd,
          input.samples,
          input.inboxCount,
          input.spamCount,
          input.missingCount,
          input.inboxWilsonLb === undefined ? null : input.inboxWilsonLb,
          input.inboxEwma === undefined ? null : input.inboxEwma
        ]
      );
    },

    async listRecentRollups(limit: number): Promise<PlacementTrendPoint[]> {
      // Serie global (todos los nodos), más nuevos primero. spam_rate se computa en SQL con NULLIF
      // para no dividir por cero cuando la ventana no tuvo muestras. El servicio la invierte a orden
      // cronológico para el dashboard.
      const { rows } = await client.query<RollupTrendRow>(
        "SELECT window_end, inbox_wilson_lb, inbox_ewma, " +
          "spam_count::numeric / NULLIF(samples, 0) AS spam_rate, samples " +
          "FROM warmup_placement_rollups ORDER BY window_end DESC LIMIT $1",
        [limit]
      );
      return rows.map((row) => {
        const point: PlacementTrendPoint = {
          windowEnd: isoDate(row.window_end),
          samples: Number(row.samples)
        };
        const wilson = numberOrUndefined(row.inbox_wilson_lb);
        if (wilson !== undefined) point.inboxWilsonLb = wilson;
        const ewma = numberOrUndefined(row.inbox_ewma);
        if (ewma !== undefined) point.inboxEwma = ewma;
        const spamRate = numberOrUndefined(row.spam_rate);
        if (spamRate !== undefined) point.spamRate = spamRate;
        return point;
      });
    },

    async aggregateByProvider(since: Date): Promise<ProviderPlacement[]> {
      // Desglose por proveedor sobre [since, now). `provider` ya está denormalizado en results (lo
      // escribe recordResult desde el seed), así que agrupamos directo — no hace falta JOIN. Sólo
      // resultados clasificados (landed_in NOT NULL). tabs cuenta como inbox (§9); missing ≠ spam.
      const { rows } = await client.query<ProviderPlacementRow>(
        "SELECT provider, " +
          "COUNT(*) FILTER (WHERE landed_in IN ('primary', 'tabs')) AS inbox, " +
          "COUNT(*) FILTER (WHERE landed_in = 'tabs') AS tabs, " +
          "COUNT(*) FILTER (WHERE landed_in = 'spam') AS spam, " +
          "COUNT(*) FILTER (WHERE landed_in = 'missing') AS missing, " +
          "COUNT(*) AS total " +
          "FROM warmup_placement_results " +
          "WHERE read_at >= $1 AND landed_in IS NOT NULL " +
          "GROUP BY provider ORDER BY provider",
        [since]
      );
      return rows.map((row) => {
        const total = Number(row.total);
        const inbox = Number(row.inbox);
        const out: ProviderPlacement = {
          provider: row.provider as SeedProvider,
          inbox,
          tabs: Number(row.tabs),
          spam: Number(row.spam),
          missing: Number(row.missing),
          total
        };
        if (total > 0) out.inboxRate = inbox / total;
        return out;
      });
    }
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────────────────────────

/** Construye las stores Postgres sobre un PgClient inyectado (Pool.query-compatible). */
export function createPgWarmupStores(client: PgClient): WarmupStores {
  return {
    nodes: createNodeStore(client),
    sends: createSendStore(client),
    signals: createSignalStore(client),
    seeds: createSeedStore(client),
    placement: createPlacementStore(client),
    engaged: createEngagedRecipientStore(client)
  };
}
