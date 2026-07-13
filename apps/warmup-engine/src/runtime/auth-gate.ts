// Auth-gate client — el CORAZÓN de la Fase 0 (§8 del Diseño-v1, "fail-closed").
// El servicio de auth externo es la fuente de verdad y devuelve un contrato de readiness firmado y
// de TTL corto. Este módulo es PURO (sin red real): recibe un verificador de firma inyectable y
// decide, con default-deny, si un nodo puede enviar. Regla no-negociable (§14): "ningún nodo envía
// sin contrato `ready`". Todo lo que no sea un contrato vigente, firmado y con TODOS los checks
// bloqueantes en `pass` ⇒ el nodo NO envía.

import type { AuthReadinessContract, WarmupNode } from "../domain/types.ts";

/** Opciones de evaluación del contrato de auth. */
export interface EvaluateAuthOptions {
  /** Reloj inyectado (para TTL); nunca `Date.now()` interno, así el test es determinista. */
  now: Date;
  /** Checks bloqueantes que deben estar en `pass` (§8: SPF_PASS, DKIM_ALIGN, PTR_FCRDNS, …). */
  requiredChecks: readonly string[];
  /** Verificador de firma inyectable (sin cripto real acá: la costura queda lista). */
  verifySignature: (contract: AuthReadinessContract) => boolean;
}

/** Decisión del gate: `ready` + un motivo estable (para trazas/DLQ). */
export interface AuthGateDecision {
  ready: boolean;
  /** "ready" | "contract_missing" | "contract_expired" | "signature_invalid" | "check_failed:<name>" */
  reason: string;
}

/**
 * Evalúa un contrato de readiness de forma FAIL-CLOSED (§8). Orden de rechazo (default-deny):
 *   1. contrato null/ausente        ⇒ "contract_missing"
 *   2. expirado (expiresAt <= now)  ⇒ "contract_expired"
 *   3. firma inválida               ⇒ "signature_invalid"
 *   4. algún requiredCheck != "pass"⇒ "check_failed:<name>"
 * Solo si TODO pasa ⇒ { ready: true, reason: "ready" }.
 */
export function evaluateAuthContract(
  contract: AuthReadinessContract | null | undefined,
  opts: EvaluateAuthOptions
): AuthGateDecision {
  if (contract == null) {
    return { ready: false, reason: "contract_missing" };
  }
  // TTL corto: vencido en el instante mismo de expiración también bloquea (<=).
  if (contract.expiresAt.getTime() <= opts.now.getTime()) {
    return { ready: false, reason: "contract_expired" };
  }
  if (!opts.verifySignature(contract)) {
    return { ready: false, reason: "signature_invalid" };
  }
  for (const check of opts.requiredChecks) {
    if (contract.checks[check] !== "pass") {
      return { ready: false, reason: `check_failed:${check}` };
    }
  }
  return { ready: true, reason: "ready" };
}

/** Resultado detallado del guard de nodo: `canSend` + el motivo del bloqueo. */
export interface CanSendDecision {
  canSend: boolean;
  /** "ok" | "auth_not_ready" | "node_blocked" | "node_quarantined" | "node_paused" | "contract_expired" */
  reason: string;
}

/**
 * Guard que consulta el Send Worker antes de cada envío (§8 + §13). Es la materialización del gate
 * de salida de la Fase 0: un nodo solo envía si su contrato de auth está `ready` y vigente y su
 * estado no lo tiene pausado/bloqueado/en cuarentena. Versión detallada (con motivo).
 */
export function canNodeSendDetailed(node: WarmupNode, now: Date): CanSendDecision {
  if (!node.authReady) {
    return { canSend: false, reason: "auth_not_ready" };
  }
  if (node.state === "blocked") {
    return { canSend: false, reason: "node_blocked" };
  }
  if (node.state === "quarantined") {
    return { canSend: false, reason: "node_quarantined" };
  }
  if (node.state === "paused") {
    return { canSend: false, reason: "node_paused" };
  }
  // El contrato pudo expirar aunque authReady siga en true (TTL corto): tratamos vencido como no-ready.
  if (node.contractExpiresAt != null && node.contractExpiresAt.getTime() <= now.getTime()) {
    return { canSend: false, reason: "contract_expired" };
  }
  return { canSend: true, reason: "ok" };
}

/**
 * Guard booleano (§8): `canNodeSend` =
 *   authReady && state ∉ {blocked, quarantined, paused} && (contractExpiresAt == null || > now).
 * Este es el guard que el send-worker consulta antes de tocar el transporte.
 */
export function canNodeSend(node: WarmupNode, now: Date): boolean {
  return canNodeSendDetailed(node, now).canSend;
}
