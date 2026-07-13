// Ensamblador del contrato de auth (Fase 1 → alimenta el gate fail-closed de Fase 0).
// Corre los AuthChecker inyectados contra el contexto de un nodo, agrega los CheckResult en el
// `checks` map, y produce un AuthReadinessContract firmado con TTL corto (§8). El gate
// (runtime/auth-gate.ts) lo evalúa después; este módulo NO decide readiness, solo lo construye.

import type { AuthReadinessContract } from "../domain/types.ts";
import {
  V1_REQUIRED_CHECKS,
  type AuthCheckContext,
  type AuthCheckId,
  type AuthChecker,
  type CheckResult,
  type CheckVerdict
} from "../domain/auth-checks.ts";

export interface BuildAuthContractInput {
  nodeId: string;
  ctx: AuthCheckContext;
  checkers: readonly AuthChecker[];
  /** Firma el payload del contrato (inyectable; el HMAC/clave real vive fuera del núcleo). */
  sign: (payload: string) => string;
  now: Date;
  /** TTL corto del contrato (§8). Default 15 min. */
  ttlMs?: number;
  /** Techo de envío autorizado que CLAMPA la rampa (§8/§10). */
  sendingLimits?: { maxPerDay?: number };
  /**
   * Set de checks requeridos. Los que ningún checker produce quedan `unknown` (fail-closed): un
   * nodo NO llega a `ready` por checks que todavía no implementamos. Default: V1_REQUIRED_CHECKS.
   */
  requiredChecks?: readonly AuthCheckId[];
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Payload canónico y estable que se firma (orden determinista de checks). */
export function authContractPayload(input: {
  nodeId: string;
  checks: Record<string, CheckVerdict>;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const orderedChecks = Object.keys(input.checks)
    .sort()
    .map((id) => `${id}=${input.checks[id]}`)
    .join(",");
  return [
    input.nodeId,
    orderedChecks,
    input.issuedAt.toISOString(),
    input.expiresAt.toISOString()
  ].join("|");
}

/**
 * Corre todos los checkers y arma el contrato firmado. Un checker que lanza NO tumba el build: sus
 * checks quedan `unknown` (fail-closed). Los checks requeridos que nadie produce también quedan
 * `unknown`. Nunca marca `pass` por omisión.
 */
export async function buildAuthReadinessContract(
  input: BuildAuthContractInput
): Promise<AuthReadinessContract> {
  const required = input.requiredChecks ?? V1_REQUIRED_CHECKS;
  const checks: Record<string, CheckVerdict> = {};
  // Sembrar todos los requeridos en `unknown`: el default es fail-closed, no optimista.
  for (const id of required) checks[id] = "unknown";

  const settled = await Promise.allSettled(
    input.checkers.map((checker) => checker.run(input.ctx))
  );
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue; // checker lanzó ⇒ sus checks siguen unknown
    for (const result of outcome.value as CheckResult[]) {
      // Solo pisa si es un check que nos importa; el último gana (los checkers no se solapan).
      checks[result.id] = result.verdict;
    }
  }

  const issuedAt = input.now;
  const expiresAt = new Date(input.now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS));
  const signature = input.sign(authContractPayload({ nodeId: input.nodeId, checks, issuedAt, expiresAt }));

  return {
    nodeId: input.nodeId,
    checks,
    signature,
    issuedAt,
    expiresAt,
    ...(input.sendingLimits ? { sendingLimits: input.sendingLimits } : {})
  };
}

/**
 * Checks del §8 aún sin checker propio (fail-closed: `unknown` hasta implementarse). Vacío: los 13
 * checks de V1_REQUIRED_CHECKS tienen checker (DNS + IP/red + liveness SMTP/IMAP/tracking/unsub).
 * El default sigue siendo `unknown` para cualquier check que no llegue del set de checkers pasado.
 */
export const PENDING_V1_CHECKS: readonly AuthCheckId[] = [];
