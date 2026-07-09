// Scheduler + loops de tick del warmup v1 (§7 arquitectura · §9 placement · §10 rampa).
// Source of truth: Delivrix-Warmup-Diseno-v1.md.
//
// Este módulo COMPONE el dominio ya testeado (ramp/node-state/placement), el runtime (send-worker +
// auth-gate) y el reader IMAP sobre los puertos de persistencia (store/ports.ts). Es PURO respecto a
// I/O: stores, transport e imapClient se INYECTAN, así el composition root cablea Postgres/SMTP/imapflow
// reales y los tests corren con fakes en memoria. No hay daemon/entrypoint aquí: se exponen tres
// funciones de tick idempotentes que el composition root agenda.
//
// Garantías de diseño que este módulo materializa:
//  - Idempotencia por slot (§7/§12): cada send lleva un `slotKey` determinista derivado de
//    (nodeId, fecha UTC, índice). El enqueue es exactly-once por (node_id, slot_key) en el store, así
//    re-correr planNodeDay el mismo día NO duplica ni sends ni placement tests.
//  - Auth-gate fail-closed (§8): planNodeDay no encola NADA (ni seeds) si el nodo no puede enviar.
//  - Cap de seeds ≤10% del volumen del día (§9): maxSeeds = floor(cupo × seedsCapFraction).

import { dailyQuota } from "../domain/ramp.ts";
import type { IsoWeekday } from "../domain/ramp.ts";
import { nextNodeState } from "../domain/node-state.ts";
import type { TransitionInput } from "../domain/node-state.ts";
import { computeRollup } from "../domain/placement.ts";
import type {
  NodeState,
  PlacementRollup,
  PlacementTest,
  WarmupNode,
  WarmupPolicy,
  WarmupSend
} from "../domain/types.ts";
import { processSend } from "../runtime/send-worker.ts";
import { canNodeSend } from "../runtime/auth-gate.ts";
import type { WarmupMessage, WarmupTransport } from "../runtime/transport.ts";
import { readPlacement } from "../reader/imap-placement-reader.ts";
import type { ImapClient } from "../reader/imap-placement-reader.ts";
import type { StoredSend, WarmupStores } from "../store/ports.ts";

/** Fracción máxima del volumen del día que pueden representar los seeds (§9: ≤10%). */
export const DEFAULT_SEEDS_CAP_FRACTION = 0.1;

/** Ventana móvil de placement por defecto para el rollup (§9: 7 días). */
export const DEFAULT_ROLLUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── Helpers deterministas de tiempo ─────────────────────────────────────────────────────────────

/** ISO weekday (1=lun…7=dom) derivado de `now` en UTC (getUTCDay: 0=dom → 7). */
export function isoWeekdayOf(now: Date): IsoWeekday {
  const dow = now.getUTCDay(); // 0..6, 0 = domingo
  return (dow === 0 ? 7 : dow) as IsoWeekday;
}

/** Fecha UTC YYYY-MM-DD de `now` (ancla estable del slotKey del día). */
export function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** slotKey determinista de un send de tráfico del día: `${nodeId}:${YYYY-MM-DD}:${i}`. */
export function sendSlotKey(nodeId: string, now: Date, index: number): string {
  return `${nodeId}:${utcDateKey(now)}:${index}`;
}

/** slotKey determinista de un seed de placement del día (extra dentro de la rotación, §9). */
export function seedSlotKey(nodeId: string, now: Date, seedId: string): string {
  return `${nodeId}:${utcDateKey(now)}:seed:${seedId}`;
}

// ── 1) planNodeDay: encola el cupo del día + seeds (idempotente, gateado por auth) ──────────────

/** Opciones de cupo que el caller pasa a `dailyQuota` (clamps del §10). */
export interface PlanQuotaOptions {
  /** Techo del contrato de auth (`sendingLimits.maxPerDay`, §8). */
  contractMaxPerDay?: number;
  /** Cap duro para cuenta Gmail nueva (§10). Su presencia marca al nodo como Gmail nueva. */
  gmailNewAccountCap?: number;
  /** Cupo de hace 2 días para el clamp 3×/48h (§10). */
  quotaTwoDaysAgo?: number;
  /** Multiplicador máximo 48h (default en dailyQuota: 3). */
  maxRampMultiplier48h?: number;
}

export interface PlanNodeDayDeps {
  node: WarmupNode;
  now: Date;
  stores: WarmupStores;
  policy: WarmupPolicy;
  /** Provee el destinatario transaccional real del i-ésimo send del día (inyectado, §9). */
  pickRecipient: (node: WarmupNode, index: number) => string;
  /** Genera un testId único por seed. Inyectado para tests deterministas. */
  newTestId: (node: WarmupNode, seedId: string) => string;
  /** Fracción de cap de seeds (default 0.1 = 10%). */
  seedsCapFraction?: number;
  /** Opciones de cupo (clamps §10) — "pásale lo que tengas". */
  quotaOptions?: PlanQuotaOptions;
}

export interface PlanNodeDayResult {
  enqueuedSends: number;
  enqueuedTests: number;
  skippedReason?: string;
}

/**
 * Planifica el día de un nodo (§9/§10): calcula el cupo lineal, encola ese nº de sends de tráfico real
 * con slotKey determinista (idempotente) y añade seeds de placement como destinatarios EXTRA (cap
 * ≤10% del volumen). Fail-closed: si el nodo no puede enviar (§8), no encola nada.
 *
 * Idempotencia: `enqueuedSends`/`enqueuedTests` cuentan solo las inserciones NUEVAS (enqueue=true);
 * re-correr el mismo día devuelve 0/0 porque el store hace no-op sobre (node_id, slot_key) repetido.
 */
export async function planNodeDay(deps: PlanNodeDayDeps): Promise<PlanNodeDayResult> {
  const { node, now, stores, policy } = deps;

  // §8 auth-gate fail-closed: sin poder enviar no se encola NADA (ni seeds).
  if (!canNodeSend(node, now)) {
    return { enqueuedSends: 0, enqueuedTests: 0, skippedReason: "auth_gate" };
  }

  const opts = deps.quotaOptions ?? {};
  const quota = dailyQuota(node, isoWeekdayOf(now), {
    contractMaxPerDay: opts.contractMaxPerDay,
    gmailNewAccountCap: opts.gmailNewAccountCap ?? gmailCapFor(node, policy),
    quotaTwoDaysAgo: opts.quotaTwoDaysAgo,
    maxRampMultiplier48h: opts.maxRampMultiplier48h ?? policy.maxRampMultiplier48h
  });

  // Tráfico transaccional real del día (§9: los seeds viajan DENTRO de esta rotación).
  let enqueuedSends = 0;
  for (let i = 0; i < quota; i += 1) {
    const slotKey = sendSlotKey(node.id, now, i);
    const toAddress = deps.pickRecipient(node, i);
    const inserted = await stores.sends.enqueue({ nodeId: node.id, slotKey, toAddress });
    if (inserted) enqueuedSends += 1;
  }

  // Placement tests: seeds como destinatarios extra, cap ≤10% del volumen del día (§9).
  const enqueuedTests = await enqueueSeeds(deps, quota);

  return { enqueuedSends, enqueuedTests };
}

/** Si el nodo es Postfix (v1) no forzamos el cap Gmail; el caller lo pasa vía quotaOptions si aplica. */
function gmailCapFor(_node: WarmupNode, _policy: WarmupPolicy): number | undefined {
  // v1 Postfix-only: el cap Gmail para cuenta nueva se pasa explícito por quotaOptions cuando el nodo
  // sea una cuenta Gmail nueva; por defecto no aplica (undefined = sin cap).
  return undefined;
}

/**
 * Encola seeds como destinatarios extra dentro de la rotación (§9), respetando el cap ≤10%.
 * Idempotencia: el placement test solo se crea si el seed-send se insertó nuevo (enqueue=true), así
 * re-correr el día no duplica ni el send ni el test.
 */
async function enqueueSeeds(deps: PlanNodeDayDeps, quota: number): Promise<number> {
  const { node, now, stores } = deps;
  const fraction = deps.seedsCapFraction ?? DEFAULT_SEEDS_CAP_FRACTION;
  const maxSeeds = Math.floor(quota * fraction);
  if (maxSeeds <= 0) return 0;

  const seeds = await stores.seeds.listEnabled();
  const chosen = seeds.slice(0, maxSeeds);

  let enqueuedTests = 0;
  for (const seed of chosen) {
    const slotKey = seedSlotKey(node.id, now, seed.id);
    const inserted = await stores.sends.enqueue({ nodeId: node.id, slotKey, toAddress: seed.address });
    if (!inserted) continue; // ya existía ⇒ el test ya se creó en una corrida previa (idempotente)
    const testId = deps.newTestId(node, seed.id);
    await stores.placement.createTest({
      nodeId: node.id,
      seedId: seed.id,
      testId,
      seedProvider: seed.provider,
      seedInbox: seed.address,
      sentAt: now
    });
    enqueuedTests += 1;
  }
  return enqueuedTests;
}

// ── 2) processQueuedSends: drena la cola vía el send-worker + mapea estados ──────────────────────

export interface ProcessQueuedDeps {
  stores: WarmupStores;
  transport: WarmupTransport;
  now: Date;
  limit: number;
  /** Constructor de mensaje opcional; si se omite, el send-worker arma el mínimo con el slotKey. */
  buildMessage?: (node: WarmupNode, stored: StoredSend) => WarmupMessage;
}

export interface ProcessQueuedResult {
  processed: number;
  sent: number;
  bounced: number;
  deadLettered: number;
}

/**
 * Drena hasta `limit` sends encolados (§7 Send Worker + §12 idempotencia/DLQ). Por cada uno trae su
 * nodo, llama al send-worker (que aplica el gate fail-closed) y persiste el estado resultante. Un
 * bounce permanente además registra una señal (§12).
 */
export async function processQueuedSends(deps: ProcessQueuedDeps): Promise<ProcessQueuedResult> {
  const { stores, transport, now } = deps;
  const queued = await stores.sends.listQueued(deps.limit);

  let processed = 0;
  let sent = 0;
  let bounced = 0;
  let deadLettered = 0;

  for (const stored of queued) {
    processed += 1;
    const node = await stores.nodes.getNode(stored.nodeId);
    if (node == null) {
      // Nodo desaparecido: no reintable, a la DLQ (nunca reenvía a ciegas).
      await stores.sends.markStatus(stored.id, "dead_lettered", {
        attempts: stored.attempts + 1,
        error: "node_not_found"
      });
      deadLettered += 1;
      continue;
    }

    const send: WarmupSend = {
      nodeId: stored.nodeId,
      slotKey: stored.slotKey,
      toAddress: stored.toAddress,
      status: stored.status
    };
    const message = deps.buildMessage?.(node, stored);

    const result = await processSend({
      node,
      send,
      transport,
      now,
      message,
      attempt: stored.attempts + 1
    });

    await stores.sends.markStatus(stored.id, result.status, {
      attempts: stored.attempts + 1,
      error: result.reason,
      sentAt: result.status === "sent" ? now : undefined
    });

    if (result.status === "sent") sent += 1;
    if (result.status === "bounced") {
      bounced += 1;
      await stores.signals.record({ nodeId: node.id, kind: "bounce", detail: result.reason });
    }
    if (result.status === "dead_lettered") deadLettered += 1;
  }

  return { processed, sent, bounced, deadLettered };
}

// ── 3) reconcilePlacement: lee seeds, hace rollup y dispara transiciones de estado ───────────────

/** Señales temporales por nodo que la FSM (§9) necesita y que no viven en el rollup de una ventana. */
export type NodeTransitionSignals = Omit<TransitionInput, "node" | "rollup" | "authReady" | "policy">;

export interface ReconcilePlacementDeps {
  stores: WarmupStores;
  imapClient: ImapClient;
  now: Date;
  policy: WarmupPolicy;
  /** Factor de suavizado del EWMA (default en placement: 0.3). */
  ewmaAlpha?: number;
  /** Inicio de la ventana móvil del rollup (default: now − 7 días, §9). */
  since?: Date;
  /**
   * Provee las señales temporales por nodo (días sostenidos sobre la barra, horas en pausa, etc.) que
   * la FSM del §9 consume. Inyectado para mantener reconcile puro; el composition root las deriva del
   * histórico de rollups. Default: sin señales (no promueve/pausa por criterios temporales).
   */
  nodeSignals?: (nodeId: string, rollup: PlacementRollup) => NodeTransitionSignals;
}

export interface PlacementTransition {
  nodeId: string;
  from: NodeState;
  to: NodeState;
  reason: string;
}

export interface ReconcilePlacementResult {
  read: number;
  rolledUp: number;
  transitions: PlacementTransition[];
}

/**
 * Reconcilia placement (§9): lee cada seed pendiente vía IMAP, registra los que ya aterrizaron, y por
 * cada nodo con resultados nuevos recomputa el rollup (Wilson-LB + EWMA), lo persiste y aplica la FSM
 * de estados. Devuelve las transiciones disparadas (p.ej. FRESH→WARM cuando el placement lo amerita).
 */
export async function reconcilePlacement(deps: ReconcilePlacementDeps): Promise<ReconcilePlacementResult> {
  const { stores, imapClient, now } = deps;
  const since = deps.since ?? new Date(now.getTime() - DEFAULT_ROLLUP_WINDOW_MS);

  const pending = await stores.placement.listPendingTests();

  let read = 0;
  const touchedNodes = new Set<string>();

  for (const stored of pending) {
    const test: PlacementTest = {
      nodeId: stored.nodeId,
      seedProvider: stored.seedProvider,
      seedInbox: stored.seedInbox,
      testId: stored.testId,
      sentAt: stored.sentAt
    };
    const row = await readPlacement(imapClient, test, now);
    if (row.landedIn == null) continue; // pendiente dentro del grace window: no diluye
    await stores.placement.recordResult({
      testId: stored.testId,
      nodeId: stored.nodeId,
      provider: stored.seedProvider,
      landedIn: row.landedIn,
      readAt: row.readAt ?? now
    });
    read += 1;
    touchedNodes.add(stored.nodeId);
  }

  const transitions: PlacementTransition[] = [];
  let rolledUp = 0;

  for (const nodeId of touchedNodes) {
    const results = await stores.placement.listResultsForRollup(nodeId, since);
    const prevEwma = await stores.placement.latestEwma(nodeId);
    const rollup = computeRollup(results, { prevEwma, alpha: deps.ewmaAlpha });

    await stores.placement.upsertRollup({
      nodeId,
      windowStart: since,
      windowEnd: now,
      samples: rollup.samples,
      inboxCount: rollup.inboxCount,
      spamCount: rollup.spamCount,
      missingCount: rollup.missingCount,
      inboxWilsonLb: rollup.inboxWilsonLb,
      inboxEwma: rollup.inboxEwma
    });
    rolledUp += 1;

    const node = await stores.nodes.getNode(nodeId);
    if (node == null) continue;

    // Capturamos el estado ANTES de persistir: getNode puede devolver el objeto vivo del store y
    // updateState mutarlo, lo que borraría el `from` de la transición.
    const fromState = node.state;
    const signals = deps.nodeSignals?.(nodeId, rollup) ?? {};
    const decision = nextNodeState({
      node: { state: fromState },
      rollup,
      authReady: node.authReady,
      policy: deps.policy,
      ...signals
    });

    // Persistimos el placementScore de la ventana en cada ciclo; la transición se registra solo si el
    // estado efectivamente cambia.
    const placementScore = rollup.inboxEwma ?? rollup.inboxWilsonLb;
    await stores.nodes.updateState(nodeId, decision.nextState, placementScore);

    if (decision.nextState !== fromState) {
      transitions.push({
        nodeId,
        from: fromState,
        to: decision.nextState,
        reason: decision.reason
      });
    }
  }

  return { read, rolledUp, transitions };
}
