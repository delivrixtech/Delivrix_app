// Servicio del warmup-engine: el tick orquestador (guarded por el flag) + el snapshot de estado
// read-only (base para exponerlo en el panel de Delivrix — "verlo en delivrix").
//
// runWarmupTick es UNA iteración del engine: plan del día por nodo → procesar cola de envíos →
// reconciliar placement (leer seeds, rollup, transición FSM). Está guarded por WARMUP_ENGINE_ENABLE:
// con el flag OFF lanza y nada real corre. getWarmupStatusSnapshot NO envía nada: solo lee estado.

import { assertWarmupEngineEnabled, type WarmupEnv } from "../runtime/config.ts";
import type { WarmupPolicy } from "../domain/types.ts";
import { DEFAULT_WARMUP_POLICY } from "../domain/types.ts";
import type { WarmupTransport } from "../runtime/transport.ts";
import type { ImapClient } from "../reader/imap-placement-reader.ts";
import type { WarmupStores } from "../store/ports.ts";
import {
  planNodeDay,
  processQueuedSends,
  reconcilePlacement,
  type PlanQuotaOptions,
  type NodeTransitionSignals,
  type PlacementTransition
} from "../scheduler/scheduler.ts";

export interface WarmupTickDeps {
  stores: WarmupStores;
  transport: WarmupTransport;
  imapClient: ImapClient;
  now: Date;
  policy?: WarmupPolicy;
  /** Destinatario transaccional real por (nodo, índice). Deployment lo provee. */
  pickRecipient: (node: import("../domain/types.ts").WarmupNode, index: number) => string;
  /** testId determinista por (nodo, seed). */
  newTestId: (node: import("../domain/types.ts").WarmupNode, seedId: string) => string;
  /** Contadores temporales de la FSM por nodo (días sostenidos, etc.) — deployment/estado los deriva. */
  nodeSignals?: (nodeId: string, rollup: import("../domain/types.ts").PlacementRollup) => NodeTransitionSignals;
  quotaOptions?: PlanQuotaOptions;
  /** Cuántos envíos encolados procesar por tick. */
  processLimit?: number;
}

export interface WarmupTickResult {
  planned: { nodes: number; enqueuedSends: number; enqueuedTests: number; skipped: number };
  processed: { processed: number; sent: number; bounced: number; deadLettered: number };
  placement: { read: number; rolledUp: number; transitions: PlacementTransition[] };
}

/**
 * Una iteración del engine. GUARDED por el flag: OFF ⇒ lanza (nada corre). Determinista respecto a
 * `now` y a las deps inyectadas (stores/transport/imapClient); en tests se pasan fakes.
 */
export async function runWarmupTick(deps: WarmupTickDeps, env: WarmupEnv = process.env): Promise<WarmupTickResult> {
  assertWarmupEngineEnabled(env);
  const policy = deps.policy ?? DEFAULT_WARMUP_POLICY;

  const activeNodes = await deps.stores.nodes.listActiveNodes();
  let enqueuedSends = 0;
  let enqueuedTests = 0;
  let skipped = 0;
  for (const node of activeNodes) {
    const plan = await planNodeDay({
      node,
      now: deps.now,
      stores: deps.stores,
      policy,
      pickRecipient: deps.pickRecipient,
      newTestId: deps.newTestId,
      ...(deps.quotaOptions ? { quotaOptions: deps.quotaOptions } : {})
    });
    enqueuedSends += plan.enqueuedSends;
    enqueuedTests += plan.enqueuedTests;
    if (plan.skippedReason) skipped += 1;
  }

  const processed = await processQueuedSends({
    stores: deps.stores,
    transport: deps.transport,
    now: deps.now,
    limit: deps.processLimit ?? 100
  });

  const placement = await reconcilePlacement({
    stores: deps.stores,
    imapClient: deps.imapClient,
    now: deps.now,
    policy,
    ...(deps.nodeSignals ? { nodeSignals: deps.nodeSignals } : {})
  });

  return {
    planned: { nodes: activeNodes.length, enqueuedSends, enqueuedTests, skipped },
    processed,
    placement
  };
}

// --- Snapshot read-only para el panel de Delivrix (no envía nada; solo lee estado) ---

export interface WarmupNodeStatus {
  id: string;
  mailbox: string;
  domain: string;
  state: import("../domain/types.ts").NodeState;
  dayIndex: number;
  authReady: boolean;
  placementScore?: number;
}

export interface WarmupStatusSnapshot {
  generatedAt: string;
  enabled: boolean;
  totals: { activeNodes: number; queuedSends: number };
  byState: Record<string, number>;
  nodes: WarmupNodeStatus[];
}

/**
 * Estado del engine para observabilidad (panel). Read-only: NO depende del flag (leer siempre se
 * puede). `enabled` refleja si el engine está habilitado, para que el panel lo muestre.
 */
export async function getWarmupStatusSnapshot(
  stores: Pick<WarmupStores, "nodes" | "sends">,
  opts: { now: Date; env?: WarmupEnv; queuedSampleLimit?: number }
): Promise<WarmupStatusSnapshot> {
  const active = await stores.nodes.listActiveNodes();
  const queued = await stores.sends.listQueued(opts.queuedSampleLimit ?? 1000);
  const byState: Record<string, number> = {};
  for (const node of active) byState[node.state] = (byState[node.state] ?? 0) + 1;

  return {
    generatedAt: opts.now.toISOString(),
    enabled: warmupEnabledFrom(opts.env),
    totals: { activeNodes: active.length, queuedSends: queued.length },
    byState,
    nodes: active.map((node) => ({
      id: node.id,
      mailbox: node.mailbox,
      domain: node.domain,
      state: node.state,
      dayIndex: node.dayIndex,
      authReady: node.authReady,
      ...(node.placementScore !== undefined ? { placementScore: node.placementScore } : {})
    }))
  };
}

function warmupEnabledFrom(env: WarmupEnv | undefined): boolean {
  const raw = (env ?? process.env).WARMUP_ENGINE_ENABLE?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}
