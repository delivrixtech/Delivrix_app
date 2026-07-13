// Puertos de persistencia (§12 del Diseño-v1). El scheduler y el servicio dependen de ESTAS
// interfaces, nunca de Postgres directo: así se testean con stores fake (en memoria) y la
// implementación pg real (store/pg-*.ts) se enchufa detrás del feature flag.
//
// Idempotencia (§7/§12): el enqueue de un send es exactly-once por slot — la unicidad
// (node_id, slot_key) de warmup_sends ES el mecanismo (ON CONFLICT DO NOTHING). No hace falta
// una cola externa en v1.

import type { LandedIn, NodeState, SeedProvider, WarmupNode } from "../domain/types.ts";

/** Fila de send tal como la ve el worker (subset de warmup_sends). */
export interface StoredSend {
  id: string;
  nodeId: string;
  slotKey: string;
  toAddress: string;
  status: "queued" | "sent" | "bounced" | "failed" | "dead_lettered";
  attempts: number;
}

export interface StoredSeed {
  id: string;
  address: string;
  provider: SeedProvider;
}

export interface StoredPlacementTest {
  testId: string;
  nodeId: string;
  seedId: string;
  seedProvider: SeedProvider;
  seedInbox: string;
  sentAt: Date;
}

/** Nodos + su ciclo de vida (§12). */
export interface NodeStore {
  listActiveNodes(): Promise<WarmupNode[]>;
  getNode(id: string): Promise<WarmupNode | null>;
  updateState(id: string, state: NodeState, placementScore?: number): Promise<void>;
  setDayIndex(id: string, dayIndex: number): Promise<void>;
  setAuthReady(id: string, authReady: boolean, contractExpiresAt?: Date): Promise<void>;
}

/** Cola durable de envíos vía la tabla warmup_sends (idempotente por slot). */
export interface SendStore {
  /** Inserta un send; si ya existe (node_id, slot_key) es no-op. Devuelve true si insertó. */
  enqueue(input: { nodeId: string; slotKey: string; toAddress: string }): Promise<boolean>;
  listQueued(limit: number): Promise<StoredSend[]>;
  markStatus(id: string, status: StoredSend["status"], opts?: { attempts?: number; error?: string; sentAt?: Date }): Promise<void>;
}

export interface SignalStore {
  record(input: { nodeId: string; kind: "bounce" | "complaint" | "deferral"; detail?: unknown }): Promise<void>;
}

export interface SeedStore {
  listEnabled(): Promise<StoredSeed[]>;
}

/** Medición de placement (§9): tests, resultados y rollups. */
export interface PlacementStore {
  createTest(input: { nodeId: string; seedId: string; testId: string; seedProvider: SeedProvider; seedInbox: string; sentAt: Date }): Promise<void>;
  /** Tests aún sin resultado (dentro o fuera del grace window). */
  listPendingTests(): Promise<StoredPlacementTest[]>;
  recordResult(input: { testId: string; nodeId: string; provider: SeedProvider; landedIn: LandedIn; readAt: Date }): Promise<void>;
  /** Resultados leídos del nodo en la ventana [since, now) para computar el rollup. */
  listResultsForRollup(nodeId: string, since: Date): Promise<Array<{ testId: string; nodeId: string; seedProvider: SeedProvider; landedIn: LandedIn | null; readAt?: Date }>>;
  /** EWMA previo del nodo (para encadenar el suavizado), si existe. */
  latestEwma(nodeId: string): Promise<number | undefined>;
  upsertRollup(input: {
    nodeId: string;
    windowStart: Date;
    windowEnd: Date;
    samples: number;
    inboxCount: number;
    spamCount: number;
    missingCount: number;
    inboxWilsonLb?: number;
    inboxEwma?: number;
  }): Promise<void>;
}

/** Bundle de stores que el scheduler/servicio recibe inyectado. */
export interface WarmupStores {
  nodes: NodeStore;
  sends: SendStore;
  signals: SignalStore;
  seeds: SeedStore;
  placement: PlacementStore;
}
