// Superficie pública del núcleo determinista del warmup-engine.
// Los adapters de I/O (SMTP/IMAP), el AI Engine y el runtime se agregan sobre este núcleo.

export * from "./domain/types.ts";
export { dailyQuota, type IsoWeekday } from "./domain/ramp.ts";
export {
  computePlacement,
  placementMeetsBar,
  shouldAutoPause,
  type PlacementResult
} from "./domain/placement.ts";
export {
  nextNodeState,
  type TransitionInput,
  type TransitionResult,
  type TransitionReason
} from "./domain/node-state.ts";
export {
  matchPairs,
  type MatchInput,
  type MatchResult,
  type ProposedPair
} from "./domain/pair-matcher.ts";
