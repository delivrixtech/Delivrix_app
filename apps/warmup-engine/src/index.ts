// Superficie pública del warmup-engine v1 (Postfix-only, Track A).
// Núcleo determinista (domain/) + runtime de Fase 0 (runtime/): auth-gate fail-closed, transporte
// pluggable y send worker. El mesh/pair-matcher es v2 (diferido) — NO se exporta acá.

// --- Núcleo determinista (dominio puro, sin I/O) ---
// Re-export amplio: estos módulos los afinan otros agentes en paralelo; `export *` evita fijar
// nombres que aún se mueven (no hay colisión con los tipos de types.ts).
export * from "./domain/types.ts";
export * from "./domain/ramp.ts";
export * from "./domain/placement.ts";
export * from "./domain/node-state.ts";

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
