// Superficie pública del warmup-engine v1 (Postfix-only, Track A).
// Núcleo determinista (domain/) + runtime de Fase 0 (runtime/): auth-gate fail-closed, transporte
// pluggable y send worker. El mesh/pair-matcher es v2 (diferido) — NO se exporta acá.

// --- Núcleo determinista (dominio puro, sin I/O) ---
export * from "./domain/types.ts";
export * from "./domain/ramp.ts";
export * from "./domain/placement.ts";
export * from "./domain/node-state.ts";
export * from "./domain/auth-checks.ts";

// --- Checks de auth de Fase 1 (§8): puros, con resolvers/probes inyectables (mocks en tests) ---
export * from "./checks/dns-auth-checks.ts";
export * from "./checks/ip-network-checks.ts";
export * from "./checks/liveness-checks.ts";

// --- Inbox Reader de placement (§9): clasifica LandedIn desde los seed inboxes externos por IMAP ---
export * from "./reader/imap-placement-reader.ts";

// --- Adapters de I/O EN VIVO (DNS/RBL/TLS + SMTP/IMAP) + composition root guarded por el flag ---
export * from "./live/dns-adapters.ts";
export * from "./live/mail-adapters.ts";
export * from "./live/compose.ts";

// --- Runtime de la Fase 0 (§7/§8/§13): el gate "ningún nodo envía sin contrato ready" ---
export {
  evaluateAuthContract,
  canNodeSend,
  canNodeSendDetailed,
  type EvaluateAuthOptions,
  type AuthGateDecision,
  type CanSendDecision
} from "./runtime/auth-gate.ts";
export {
  PostfixTransport,
  MockTransport,
  type WarmupTransport,
  type WarmupMessage,
  type WarmupSendResult,
  type SmtpClient,
  type SmtpSendInfo,
  type MockTransportOptions,
  type MockBehavior
} from "./runtime/transport.ts";
export {
  processSend,
  buildDefaultMessage,
  DEFAULT_MAX_ATTEMPTS,
  type ProcessSendInput,
  type ProcessSendResult
} from "./runtime/send-worker.ts";

// --- Fase 1: ensamblador del contrato de auth firmado (corre checkers → AuthReadinessContract) ---
export {
  buildAuthReadinessContract,
  authContractPayload,
  PENDING_V1_CHECKS,
  type BuildAuthContractInput
} from "./runtime/auth-contract-builder.ts";

// --- Feature flag de seguridad: el engine no arranca ni envía en deploy sin WARMUP_ENGINE_ENABLE ---
export { warmupEngineEnabled, assertWarmupEngineEnabled, type WarmupEnv } from "./runtime/config.ts";
