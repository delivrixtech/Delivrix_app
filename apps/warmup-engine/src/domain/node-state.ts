// Máquina de estados por nodo (§102 del doc):
//   FRESH ──(seed pairing)──▶ WARMING ──(health>90 + placement ok, 3–4 sem)──▶ WARM
//     ▲                                                                          │
//     └──────────────────(placement cae bajo umbral)◀── PAUSED ◀── auto-pause ──┘
// Función PURA: dado el nodo + su placement medido, decide el próximo estado y el motivo.

import type { NodeState, WarmupNode, WarmupPolicy } from "./types.ts";
import { computePlacement, placementMeetsBar, shouldAutoPause, type PlacementResult } from "./placement.ts";
import type { SeedCheck } from "./types.ts";

export type TransitionReason =
  | "unchanged"
  | "started_warming"          // FRESH → WARMING (arrancó a recibir pairings)
  | "graduated_to_warm"        // WARMING → WARM (health + placement + días)
  | "auto_paused_low_placement"// WARMING/WARM → PAUSED (placement bajo umbral)
  | "resumed_from_pause";      // PAUSED → WARMING (placement recuperado)

export interface TransitionResult {
  nextState: NodeState;
  reason: TransitionReason;
  placement: PlacementResult;
}

export interface TransitionInput {
  node: Pick<WarmupNode, "state" | "dayIndex" | "healthScore">;
  seedChecks: readonly SeedCheck[];
  policy: WarmupPolicy;
  /** true si el nodo ya tiene al menos un pairing de seed (necesario para FRESH→WARMING). */
  hasSeedPairing: boolean;
}

export function nextNodeState(input: TransitionInput): TransitionResult {
  const { node, policy } = input;
  const placement = computePlacement(input.seedChecks);

  // Auto-pause tiene prioridad: si hay evidencia de placement malo, se pausa desde cualquier
  // estado activo (warming/warm). fresh/paused no se auto-pausan (fresh aún no envía en serio).
  if ((node.state === "warming" || node.state === "warm") && shouldAutoPause(placement, policy)) {
    return { nextState: "paused", reason: "auto_paused_low_placement", placement };
  }

  switch (node.state) {
    case "fresh":
      return input.hasSeedPairing
        ? { nextState: "warming", reason: "started_warming", placement }
        : { nextState: "fresh", reason: "unchanged", placement };

    case "warming": {
      const healthOk = (node.healthScore ?? 0) >= policy.minHealthScore;
      const daysOk = node.dayIndex >= policy.minWarmingDays;
      if (healthOk && daysOk && placementMeetsBar(placement, policy)) {
        return { nextState: "warm", reason: "graduated_to_warm", placement };
      }
      return { nextState: "warming", reason: "unchanged", placement };
    }

    case "warm":
      return { nextState: "warm", reason: "unchanged", placement };

    case "paused":
      // Sale de pausa solo con evidencia fresca de que el placement volvió a la barra.
      return placementMeetsBar(placement, policy)
        ? { nextState: "warming", reason: "resumed_from_pause", placement }
        : { nextState: "paused", reason: "unchanged", placement };

    default:
      return { nextState: node.state, reason: "unchanged", placement };
  }
}
