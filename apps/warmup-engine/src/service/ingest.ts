// Ingesta de resultados de entrega (bounces/DSN) a las señales del warmup v1 (gap §9).
//
// El collector del gateway parsea el mail.log de Postfix a un resultado por mensaje
// (apps/gateway-api/src/postfix-log-parser.ts: PostfixDeliveryResult). Este módulo NO importa del
// gateway (otros seniors): replica el shape MÍNIMO que necesita y traduce ese outcome a una señal del
// dominio (bounce/complaint/deferral) que la FSM del §9 consume para auto-pausar.
//
// Función pura de mapeo + un ingest que persiste vía el puerto SignalStore. Nunca lanza por un outcome
// raro: un status que no es señal (sent/unknown) simplemente no graba.

import type { SignalStore } from "../store/ports.ts";

/** Shape mínimo del outcome de entrega (subset de PostfixDeliveryResult del gateway). */
export interface DeliveryOutcome {
  /** Estado final de la entrega: sent | bounced | deferred | expired | unknown (u otro string). */
  finalStatus: string;
  /** SMTP enhanced status code, p.ej. "5.7.1" (para distinguir queja/policy de un bounce duro). */
  dsnCode?: string;
  /** Message-Id del correo (para trazar la señal a su envío). */
  messageId?: string;
}

/** Señal del dominio que consume la FSM (§9). `null` = el outcome no es una señal. */
export type SignalKind = "bounce" | "complaint" | "deferral";

/**
 * Un DSN 5.7.x es rechazo por policy/reputación (p.ej. "5.7.1 blocked", spam, DMARC): lo tratamos como
 * QUEJA (complaint) y no como bounce duro de dirección inexistente, porque pesa distinto en el §9.
 */
function isComplaintDsn(dsnCode: string | undefined): boolean {
  return typeof dsnCode === "string" && /^5\.7\.\d+/.test(dsnCode.trim());
}

/**
 * Mapea un outcome de entrega a una señal del dominio (o `null` si no es señal):
 *  - bounced ⇒ `bounce` (o `complaint` si el DSN es 5.7.x de policy/queja).
 *  - deferred | expired ⇒ `deferral`.
 *  - sent | unknown | cualquier otro ⇒ `null` (no genera señal).
 */
export function deliveryToSignalKind(outcome: { finalStatus: string; dsnCode?: string }): SignalKind | null {
  const status = typeof outcome?.finalStatus === "string" ? outcome.finalStatus.trim().toLowerCase() : "";

  switch (status) {
    case "bounced":
      return isComplaintDsn(outcome.dsnCode) ? "complaint" : "bounce";
    case "deferred":
    case "expired":
      return "deferral";
    case "sent":
    case "unknown":
    default:
      return null;
  }
}

export interface IngestDeliveryDeps {
  stores: { signals: SignalStore };
  nodeId: string;
  outcome: DeliveryOutcome;
}

export interface IngestDeliveryResult {
  recorded: boolean;
  kind?: SignalKind;
}

/**
 * Traduce un outcome de entrega a señal y, si corresponde, la graba vía `stores.signals.record`.
 * Idempotente respecto al mapeo: un outcome que no es señal (null) devuelve `{recorded:false}` sin
 * tocar la store. Nunca lanza por un outcome raro.
 */
export async function ingestDeliveryOutcome(deps: IngestDeliveryDeps): Promise<IngestDeliveryResult> {
  const kind = deliveryToSignalKind(deps.outcome);
  if (kind == null) return { recorded: false };

  await deps.stores.signals.record({
    nodeId: deps.nodeId,
    kind,
    detail: { dsnCode: deps.outcome.dsnCode, messageId: deps.outcome.messageId }
  });

  return { recorded: true, kind };
}
