// Send Worker (§7 "Send Worker" + §13 gate de Fase 0 + §12 idempotencia/DLQ).
// Es el único punto que toca el transporte, y solo lo toca DESPUÉS de pasar el gate de auth. La
// regla dura de la Fase 0 (§14): "ningún nodo envía sin contrato `ready`" — si el guard falla, el
// transporte NUNCA se invoca. Función PURA/inyectable: sin Redis real (la interfaz de reintentos/DLQ
// queda lista para cablear en fases siguientes).

import type { WarmupNode, WarmupSend } from "../domain/types.ts";
import { canNodeSend, canNodeSendDetailed } from "./auth-gate.ts";
import type { WarmupMessage, WarmupTransport } from "./transport.ts";

/** Intentos por defecto antes de mandar un send a la DLQ (§12). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Estados terminales: un send acá NO se reenvía (exactly-once por slot, §12). */
const TERMINAL_STATUSES: ReadonlySet<WarmupSend["status"]> = new Set<WarmupSend["status"]>([
  "sent",
  "bounced",
  "dead_lettered"
]);

export interface ProcessSendInput {
  node: WarmupNode;
  send: WarmupSend;
  transport: WarmupTransport;
  now: Date;
  /**
   * Mensaje a enviar. Si se omite, se arma uno mínimo (from = mailbox, to = send.toAddress) con el
   * slotKey como token idempotente en headers/body. El contenido real lo pone el scheduler.
   */
  message?: WarmupMessage;
  /**
   * Guard de gate inyectable (default: `canNodeSend`). Permite forzar el gate en tests. Si devuelve
   * false, el transporte NUNCA se invoca.
   */
  verifyGate?: (node: WarmupNode, now: Date) => boolean;
  /** Número de este intento (1-based). Al agotar `maxAttempts` un fallo transitorio va a la DLQ. */
  attempt?: number;
  /** Intentos máximos antes de dead-letter (default DEFAULT_MAX_ATTEMPTS). */
  maxAttempts?: number;
}

export interface ProcessSendResult {
  status: WarmupSend["status"];
  /** Motivo estable (gate, idempotencia, error del transporte) para trazas/DLQ. */
  reason?: string;
  messageId?: string;
}

/** Arma un mensaje de warmup mínimo con el slotKey como ancla idempotente (X-Delivrix-Slot). */
export function buildDefaultMessage(node: WarmupNode, send: WarmupSend): WarmupMessage {
  return {
    from: node.mailbox,
    to: send.toAddress,
    subject: "Delivrix warmup",
    body: `warmup slot ${send.slotKey}`,
    headers: { "X-Delivrix-Slot": send.slotKey }
  };
}

/**
 * Procesa un envío de warmup, en orden:
 *   1. IDEMPOTENCIA (§12): si el send ya es terminal (sent/bounced/dead_lettered) ⇒ no reenvía.
 *   2. GATE (§13/§14): si `canNodeSend` (o `verifyGate`) es false ⇒ NO envía, queda "queued" con el
 *      motivo del gate y el transporte NUNCA se invoca. <-- assert clave del gate de salida de Fase 0.
 *   3. ENVÍO: invoca el transporte pluggable e interpreta el resultado:
 *        ok               ⇒ "sent"
 *        permanente (5xx) ⇒ "bounced"
 *        transitorio      ⇒ "failed" (reintable) / "dead_lettered" al agotar `maxAttempts` (DLQ).
 */
export async function processSend(input: ProcessSendInput): Promise<ProcessSendResult> {
  const { node, send, transport, now } = input;

  // 1) Idempotencia por slot: exactly-once. Un send terminal no vuelve a tocar el transporte.
  if (TERMINAL_STATUSES.has(send.status)) {
    return { status: send.status, reason: "already_terminal" };
  }

  // 2) Gate de auth fail-closed. Si no pasa, el transporte NO se invoca y el send queda encolado.
  const gateOk = input.verifyGate ? input.verifyGate(node, now) : canNodeSend(node, now);
  if (!gateOk) {
    const reason = input.verifyGate ? "gate_blocked" : canNodeSendDetailed(node, now).reason;
    return { status: "queued", reason };
  }

  // 3) Envío real por el transporte pluggable.
  const message = input.message ?? buildDefaultMessage(node, send);
  const result = await transport.send(message);

  if (result.ok) {
    return { status: "sent", reason: "delivered", messageId: result.messageId };
  }

  if (result.permanent) {
    return { status: "bounced", reason: result.error ?? "permanent_failure", messageId: result.messageId };
  }

  // Fallo transitorio: reintable hasta agotar intentos; ahí cae a la DLQ.
  const attempt = input.attempt ?? 1;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attempt >= maxAttempts) {
    return { status: "dead_lettered", reason: result.error ?? "max_attempts_exhausted" };
  }
  return { status: "failed", reason: result.error ?? "transient_failure" };
}
