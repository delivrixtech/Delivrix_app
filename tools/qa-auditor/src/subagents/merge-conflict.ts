// Deteccion determinista (no-LLM) de conflicto de merge para un PR. GitHub
// expone mergeable (bool|null) y mergeable_state; "dirty" o mergeable=false
// significan conflicto real con la rama base. Se emite como hallazgo blocker.

import type { Finding } from "./schema.ts";

export type PullRequestMergeInfo = {
  mergeable: boolean | null;
  mergeableState: string;
  number: number;
};

export function buildMergeConflictFinding(pr: PullRequestMergeInfo): Finding | null {
  const hasConflict = pr.mergeable === false || pr.mergeableState === "dirty";
  if (!hasConflict) {
    return null;
  }
  return {
    dimension: "qa_deploy",
    severity: "blocker",
    category: "merge-conflict",
    title: "Conflicto de merge con la rama base",
    detail:
      "El PR tiene conflictos de merge (mergeable_state=dirty). No se puede integrar de forma limpia hasta resolverlos.",
    evidence: { path: `PR #${pr.number}` },
    recommendation: "Hacer rebase o merge de la rama base en la rama del PR y resolver los conflictos.",
    confidence: "high"
  };
}
