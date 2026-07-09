// Pair Matcher (§3 "Pair Matcher", §4 bootstrap, §7 "anti-diluir mesh", §9 no-negociables).
// Decide QUIÉN escribe a QUIÉN hoy. Función PURA: recibe el mesh activo + los pairings recientes
// y produce los pares del día, respetando:
//   - no repetir el mismo par (from→to) el mismo día;
//   - los nodos frescos reciben de nodos warm (los warm pesan más como avales);
//   - un nodo no se escribe a sí mismo;
//   - anti-dilución: si los frescos ya superan maxFreshFraction del mesh activo, no se admiten
//     más frescos como receptores nuevos (regla dura del §4/§9).

import type { WarmupNode, WarmupPolicy } from "./types.ts";

export interface MatchInput {
  /** Nodos ACTIVOS del mesh (no pausados). El matcher nunca enruta hacia/desde un paused. */
  activeNodes: readonly Pick<WarmupNode, "id" | "state">[];
  /** Pares ya emitidos HOY (para no repetir from→to en el mismo día). */
  todaysPairings: readonly { fromNode: string; toNode: string }[];
  policy: WarmupPolicy;
}

export interface ProposedPair {
  fromNode: string;
  toNode: string;
}

export interface MatchResult {
  pairs: ProposedPair[];
  /** Fracción de frescos sobre el mesh activo al momento del match (observabilidad/§7). */
  freshFraction: number;
  /** true si se frenó la admisión de frescos por exceder maxFreshFraction. */
  freshCapReached: boolean;
}

const WARM_STATES = new Set(["warming", "warm"]);

/**
 * Empareja el mesh para una ronda. Determinista respecto al orden de entrada (sin RNG): el
 * scheduler/AI aplican el jitter de horario aguas arriba; el matcher solo decide la topología.
 */
export function matchPairs(input: MatchInput): MatchResult {
  const active = input.activeNodes.filter((node) => node.state !== "paused");
  const total = active.length;
  const freshNodes = active.filter((node) => node.state === "fresh");
  const warmNodes = active.filter((node) => WARM_STATES.has(node.state));
  const freshFraction = total > 0 ? freshNodes.length / total : 0;
  const freshCapReached = freshFraction > input.policy.maxFreshFraction;

  const alreadyToday = new Set(input.todaysPairings.map((p) => pairKey(p.fromNode, p.toNode)));
  const pairs: ProposedPair[] = [];
  const emit = (fromNode: string, toNode: string): void => {
    if (fromNode === toNode) return;
    const key = pairKey(fromNode, toNode);
    if (alreadyToday.has(key)) return;
    alreadyToday.add(key);
    pairs.push({ fromNode, toNode });
  };

  // 1) Frescos como RECEPTORES: reciben de nodos warm (avales reputacionales). Solo si el mesh
  //    no está ya saturado de frescos (freshCapReached protege del "frío contra frío" del §4).
  if (warmNodes.length > 0 && !freshCapReached) {
    freshNodes.forEach((fresh, index) => {
      const warm = warmNodes[index % warmNodes.length];
      emit(warm.id, fresh.id);
    });
  }

  // 2) Tráfico entre warm (mantiene la reputación viva; §4 "el mesh nunca se apaga"). Anillo:
  //    cada warm escribe al siguiente, evitando el auto-par.
  if (warmNodes.length > 1) {
    warmNodes.forEach((node, index) => {
      const next = warmNodes[(index + 1) % warmNodes.length];
      emit(node.id, next.id);
    });
  }

  return { pairs, freshFraction, freshCapReached };
}

function pairKey(fromNode: string, toNode: string): string {
  return `${fromNode}->${toNode}`;
}
