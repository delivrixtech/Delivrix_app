// Transporte PLUGGABLE desde el día 1 (§7: "transporte pluggable"; §14: decisión con Esau).
// v1 = Postfix-only (Track A). Enchufar M365 en v2 no debe costar refactor: por eso el Send Worker
// depende de la INTERFACE `WarmupTransport`, no de Postfix ni de nodemailer. Este módulo trae:
//   - la costura (interface),
//   - `MockTransport` (simula el envío; es el único transporte cableado hoy, vía dryrun-daemon),
//   - `MockTransport` (para tests: registra mensajes y simula bounce permanente vs transitorio).

/** Mensaje de warmup a enviar (unidad mínima del transporte). */
export interface WarmupMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  headers?: Record<string, string>;
}

/**
 * Resultado normalizado de un envío. `permanent` distingue el bounce 5xx (no reintable ⇒ bounced)
 * del fallo transitorio 4xx/red (reintable ⇒ failed/DLQ). Es lo que el Send Worker interpreta.
 */
export interface WarmupSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** true = fallo PERMANENTE (5xx / rechazo definitivo). false/undefined = transitorio (reintable). */
  permanent?: boolean;
}

/** La costura pluggable. Postfix hoy, M365 en v2 — el Send Worker solo conoce esto. */
export interface WarmupTransport {
  readonly kind: string;
  send(msg: WarmupMessage): Promise<WarmupSendResult>;
}

/**
 * Cliente SMTP mínimo, con firma compatible con nodemailer. Lo consume mail-adapters.ts. El
 * `transporter.sendMail` de nodemailer (presente en el árbol, v8), así que un transporter real se
 * inyecta directo sin adaptador. No lo instanciamos acá: mantiene el módulo sin dep dura de red.
 */
export interface SmtpClient {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
  }): Promise<SmtpSendInfo>;
}

/** Info de retorno de un `sendMail` (subconjunto usado del info de nodemailer). */
export interface SmtpSendInfo {
  messageId?: string;
  response?: string;
  accepted?: unknown[];
  rejected?: unknown[];
}

/** Error SMTP con código de respuesta (nodemailer expone `responseCode` en el Error). */
interface SmtpErrorLike {
  responseCode?: number;
  message?: string;
}

/** Comportamiento por mensaje para el MockTransport (undefined ⇒ éxito por defecto). */
export type MockBehavior = (msg: WarmupMessage) => WarmupSendResult | undefined;

/** Opciones del MockTransport. */
export interface MockTransportOptions {
  /** Fuerza SIEMPRE este resultado (útil para simular un bounce fijo). Gana sobre `behavior`. */
  always?: WarmupSendResult;
  /** Resultado por-mensaje (permite simular bounce permanente vs transitorio selectivamente). */
  behavior?: MockBehavior;
}

/**
 * Transporte de pruebas. Registra cada mensaje en `sent` (para aseverar que el gate NUNCA invocó el
 * transporte) y permite simular ok / bounce permanente / fallo transitorio. Cero red.
 */
export class MockTransport implements WarmupTransport {
  readonly kind = "mock";
  /** Mensajes efectivamente entregados al transporte (assert clave del gate de Fase 0). */
  readonly sent: WarmupMessage[] = [];
  private readonly opts: MockTransportOptions;

  constructor(opts: MockTransportOptions = {}) {
    this.opts = opts;
  }

  async send(msg: WarmupMessage): Promise<WarmupSendResult> {
    this.sent.push(msg);
    if (this.opts.always) {
      return this.opts.always;
    }
    const r = this.opts.behavior?.(msg);
    if (r) {
      return r;
    }
    return { ok: true, messageId: `mock-${this.sent.length}` };
  }

  /** Fábrica: transporte que siempre simula un bounce PERMANENTE (5xx). */
  static permanentBounce(error = "hard_bounce"): MockTransport {
    return new MockTransport({ always: { ok: false, error, permanent: true } });
  }

  /** Fábrica: transporte que siempre simula un fallo TRANSITORIO (reintable). */
  static transientFailure(error = "temp_failure"): MockTransport {
    return new MockTransport({ always: { ok: false, error, permanent: false } });
  }
}
