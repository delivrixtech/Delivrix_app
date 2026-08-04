// Orquestador de UNA vuelta real de warmup (LIVE). Ejecuta las 4 etapas probadas —
// ① SEND → ② MEASURE → ③ ENGAGE → ④ REPLY — y persiste cada una como evento de actividad
// (el panel las muestra en vivo). Todo el I/O es INYECTABLE (mailer, gmail, recorder), así que se
// testea con fakes sin tocar red ni credenciales. Fail-soft por etapa: si una falla, registra un
// evento 'error' con la etapa y corta la vuelta (no revienta el daemon). NUNCA loguea secretos.

import type { WarmupConversation } from "./warmup-content-bank.ts";

/**
 * Dónde terminó el correo. `MISSING` es un resultado LEGÍTIMO, no un error: el proveedor lo aceptó
 * y no apareció en ninguna carpeta dentro de la ventana de medición — o sea, se lo tragó en
 * silencio. Es el peor desenlace posible para la reputación y hasta hoy era el único invisible.
 */
export type Placement = "INBOX" | "SPAM" | "PROMOTIONS" | "OTHER" | "MISSING";
export type CycleStage = "sent" | "measured" | "engaged" | "replied" | "error";

/** Clasifica el placement a partir de los labelIds de Gmail. Puro. */
export function classifyPlacement(labelIds: readonly string[]): Placement {
  if (labelIds.includes("SPAM")) return "SPAM";
  if (labelIds.includes("CATEGORY_PROMOTIONS")) return "PROMOTIONS";
  if (labelIds.includes("INBOX")) return "INBOX";
  return "OTHER";
}

export interface SentMail {
  messageId: string;
  response: string;
}

export interface WarmupMailer {
  /** Manda el correo real desde el box (SMTP). Estampa el header X-Delivrix-Test-Id. */
  send(input: { from: string; to: string; subject: string; text: string; testId: string }): Promise<SentMail>;
}

export interface FoundMessage {
  gmailId: string;
  threadId: string;
  labelIds: string[];
}

export interface GmailOps {
  /** Busca el mensaje recién enviado por rfc822msgid/subject. null si aún no aparece. */
  findMessage(input: { rfc822MessageId: string; subject: string }): Promise<FoundMessage | null>;
  /** Aplica/saca labels (engage). */
  modifyLabels(gmailId: string, change: { add: string[]; remove: string[] }): Promise<void>;
  /** Responde el hilo desde el seed inbox (señal bidireccional). Devuelve el id de la respuesta. */
  sendReply(input: {
    from: string;
    to: string;
    subject: string;
    inReplyTo: string;
    references: string;
    body: string;
    threadId: string;
  }): Promise<{ id: string }>;
}

export interface ActivityEvent {
  cycleId: string;
  boxDomain: string;
  seedInbox: string;
  kind: CycleStage;
  placement?: Placement | null;
  subject?: string | null;
  detail?: Record<string, unknown>;
  testId?: string | null;
}

export interface ActivityRecorder {
  record(event: ActivityEvent): Promise<void>;
}

export interface RunLiveCycleDeps {
  cycleId: string;
  testId: string;
  boxDomain: string;
  /** Dirección remitente del box (p.ej. mailer@<boxDomain>). */
  fromAddress: string;
  seedInbox: string;
  conversation: WarmupConversation;
  /** Asunto final (ya con el sufijo del test-id, para trazar). */
  subject: string;
  mailer: WarmupMailer;
  /**
   * `null` = esta semilla NO se puede medir (las Gmail ops están atadas a la cuenta del refresh
   * token; buscar ahí un correo que fue a OTRA casilla devolvería "no encontrado" sobre un mensaje
   * que sí llegó). En ese caso el ciclo envía y se detiene: enviado-sin-medir, no medido-mal.
   */
  gmail: GmailOps | null;
  recorder: ActivityRecorder;
  sleep: (ms: number) => Promise<void>;
  /** Intentos de polling de la medición (default 12) y espera entre intentos (default 5000ms). */
  pollAttempts?: number;
  pollDelayMs?: number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface RunLiveCycleResult {
  cycleId: string;
  placement: Placement | null;
  completed: boolean;
  brokeAt?: CycleStage;
}

/** Corre una vuelta completa. Devuelve el resultado; nunca lanza (los errores quedan como evento). */
export async function runLiveCycle(deps: RunLiveCycleDeps): Promise<RunLiveCycleResult> {
  const {
    cycleId, testId, boxDomain, fromAddress, seedInbox, conversation, subject,
    mailer, gmail, recorder, sleep
  } = deps;
  const pollAttempts = deps.pollAttempts ?? 12;
  const pollDelayMs = deps.pollDelayMs ?? 5000;
  const base = { cycleId, boxDomain, seedInbox } as const;

  // ① SEND
  let sent: SentMail;
  try {
    sent = await mailer.send({ from: fromAddress, to: seedInbox, subject, text: conversation.body, testId });
    await recorder.record({ ...base, kind: "sent", subject, testId, detail: { smtp: sent.response, topic: conversation.topic } });
    deps.logger?.info?.(`live-cycle ${cycleId} sent (${boxDomain} → ${seedInbox})`);
  } catch (err) {
    await recorder.record({ ...base, kind: "error", subject, testId, detail: { stage: "sent", note: errMsg(err) } });
    return { cycleId, placement: null, completed: false, brokeAt: "sent" };
  }

  // Semilla sin capacidad de medición: el envío ya quedó registrado y ahí termina la vuelta. NO se
  // devuelve placement: `null` significa "no sé", y quien gatea la rampa tiene que verlo así.
  if (!gmail) {
    deps.logger?.info?.(`live-cycle ${cycleId} enviado sin medición (${seedInbox} no tiene lector)`);
    return { cycleId, placement: null, completed: false, brokeAt: "measured" };
  }

  // ② MEASURE (polling — Gmail puede demorar el indexado)
  let found: FoundMessage | null = null;
  const rfc822 = sent.messageId.replace(/[<>]/g, "");
  try {
    for (let i = 0; i < pollAttempts && !found; i++) {
      await sleep(pollDelayMs);
      found = await gmail.findMessage({ rfc822MessageId: rfc822, subject });
    }
  } catch (err) {
    await recorder.record({ ...base, kind: "error", subject, testId, detail: { stage: "measured", note: errMsg(err) } });
    return { cycleId, placement: null, completed: false, brokeAt: "measured" };
  }
  if (!found) {
    // MEDICIÓN, no error. Grabarlo como `error` lo dejaba FUERA de las ventanas de placement (que
    // filtran `kind='measured'`), y ese silencio se leía como éxito:
    //
    //   un dominio en día 20 manda 40, Gmail se traga 36 y 4 llegan a INBOX
    //     → antes: la muestra eran esos 4 INBOX, tasa 100%, acción "subir", cupo 40
    //     → ahora: 40 mediciones, 4 inbox, tasa 10% ⇒ "frenar"
    //
    // Era el único camino del sistema hacia MÁS volumen sobre evidencia falsa, y el más peligroso
    // de todos porque el correo tragado en silencio es justamente la señal de peor reputación.
    // El diseño v1 ya contaba el missing dentro de `samples` (placement.ts): esto alinea el
    // camino en vivo con la regla que ya estaba escrita.
    await recorder.record({
      ...base, kind: "measured", placement: "MISSING", subject, testId,
      detail: { note: "no_indexado_en_ventana: el proveedor lo aceptó y no apareció en ninguna carpeta" }
    });
    return { cycleId, placement: "MISSING", completed: false, brokeAt: "measured" };
  }
  const placement = classifyPlacement(found.labelIds);
  await recorder.record({ ...base, kind: "measured", placement, subject, testId, detail: { labels: found.labelIds } });

  // ③ ENGAGE
  let afterPlacement: Placement = placement;
  try {
    if (placement === "SPAM" || placement === "PROMOTIONS") {
      await gmail.modifyLabels(found.gmailId, { add: ["INBOX", "IMPORTANT"], remove: ["SPAM", "CATEGORY_PROMOTIONS"] });
      afterPlacement = "INBOX";
      await recorder.record({ ...base, kind: "engaged", placement: afterPlacement, subject, testId, detail: { action: "not_spam+important" } });
    } else {
      await gmail.modifyLabels(found.gmailId, { add: ["IMPORTANT"], remove: [] });
      await recorder.record({ ...base, kind: "engaged", placement: afterPlacement, subject, testId, detail: { action: "important" } });
    }
  } catch (err) {
    await recorder.record({ ...base, kind: "error", placement, subject, testId, detail: { stage: "engaged", note: errMsg(err) } });
    return { cycleId, placement, completed: false, brokeAt: "engaged" };
  }

  // ④ REPLY
  try {
    const reply = await gmail.sendReply({
      from: seedInbox, to: fromAddress, subject: `Re: ${subject}`,
      inReplyTo: sent.messageId, references: sent.messageId, body: conversation.reply, threadId: found.threadId
    });
    await recorder.record({ ...base, kind: "replied", placement: afterPlacement, subject, testId, detail: { replyId: reply.id.slice(0, 10) } });
  } catch (err) {
    await recorder.record({ ...base, kind: "error", placement: afterPlacement, subject, testId, detail: { stage: "replied", note: errMsg(err) } });
    return { cycleId, placement: afterPlacement, completed: false, brokeAt: "replied" };
  }

  return { cycleId, placement: afterPlacement, completed: true };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
