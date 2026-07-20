// Orquestador de UNA vuelta real de warmup (LIVE). Ejecuta las 4 etapas probadas —
// ① SEND → ② MEASURE → ③ ENGAGE → ④ REPLY — y persiste cada una como evento de actividad
// (el panel las muestra en vivo). Todo el I/O es INYECTABLE (mailer, gmail, recorder), así que se
// testea con fakes sin tocar red ni credenciales. Fail-soft por etapa: si una falla, registra un
// evento 'error' con la etapa y corta la vuelta (no revienta el daemon). NUNCA loguea secretos.

import type { WarmupConversation } from "./warmup-content-bank.ts";

export type Placement = "INBOX" | "SPAM" | "PROMOTIONS" | "OTHER";
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
  gmail: GmailOps;
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
    await recorder.record({ ...base, kind: "error", subject, testId, detail: { stage: "measured", note: "no_indexado_en_ventana" } });
    return { cycleId, placement: null, completed: false, brokeAt: "measured" };
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
