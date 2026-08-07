import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPlacement,
  runLiveCycle,
  type WarmupMailer,
  type GmailOps,
  type ActivityRecorder,
  type ActivityEvent,
  type FoundMessage
} from "./warmup-live-cycle.ts";
import type { WarmupConversation } from "./warmup-content-bank.ts";

const convo: WarmupConversation = { topic: "reunion", subject: "Asunto", body: "cuerpo natural", reply: "respuesta natural" };
const SECRET_PASS = "SUPER-SECRET-PASS";

function recorder(): { rec: ActivityRecorder; events: ActivityEvent[] } {
  const events: ActivityEvent[] = [];
  return { events, rec: { async record(e) { events.push(e); } } };
}

function fakeMailer(): WarmupMailer {
  return {
    async send() {
      // el mailer real usaría el pass; acá NO debe filtrarse a ningún evento
      return { messageId: "<abc@box>", response: "250 Ok" };
    }
  };
}

function fakeGmail(found: FoundMessage | null, sink?: { modified?: any; replied?: any }): GmailOps {
  return {
    async findMessage() { return found; },
    async modifyLabels(id, change) { if (sink) sink.modified = { id, change }; },
    async sendReply(input) { if (sink) sink.replied = input; return { id: "reply-123456789" }; }
  };
}

const noSleep = async (): Promise<void> => {};

test("classifyPlacement mapea labels a placement", () => {
  assert.equal(classifyPlacement(["INBOX"]), "INBOX");
  assert.equal(classifyPlacement(["SPAM", "INBOX"]), "SPAM");
  assert.equal(classifyPlacement(["CATEGORY_PROMOTIONS"]), "PROMOTIONS");
  assert.equal(classifyPlacement(["UNREAD"]), "OTHER");
});

test("vuelta completa (INBOX): registra sent→measured→engaged→replied", async () => {
  const { rec, events } = recorder();
  const sink: any = {};
  const res = await runLiveCycle({
    cycleId: "c1", testId: "t1", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t1]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "g1", threadId: "th1", labelIds: ["INBOX"] }, sink),
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.equal(res.completed, true);
  assert.equal(res.placement, "INBOX");
  assert.deepEqual(events.map((e) => e.kind), ["sent", "measured", "engaged", "replied"]);
  // engage en INBOX ⇒ sólo IMPORTANT (no toca SPAM)
  assert.deepEqual(sink.modified.change, { add: ["IMPORTANT"], remove: [] });
  assert.equal(sink.replied.body, "respuesta natural");
});

test("vuelta con spam: engage mueve a Principal (not-spam + important)", async () => {
  const { rec, events } = recorder();
  const sink: any = {};
  const res = await runLiveCycle({
    cycleId: "c2", testId: "t2", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t2]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "g2", threadId: "th2", labelIds: ["SPAM"] }, sink),
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.equal(res.completed, true);
  const measured = events.find((e) => e.kind === "measured");
  assert.equal(measured?.placement, "SPAM");
  const engaged = events.find((e) => e.kind === "engaged");
  assert.equal(engaged?.placement, "INBOX");
  assert.deepEqual(sink.modified.change, { add: ["INBOX", "IMPORTANT"], remove: ["SPAM", "CATEGORY_PROMOTIONS"] });
});

test("no aparece en la ventana ⇒ MEDICIÓN 'MISSING', no un error invisible", async () => {
  const { rec, events } = recorder();
  const res = await runLiveCycle({
    cycleId: "c3", testId: "t3", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t3]",
    mailer: fakeMailer(), gmail: fakeGmail(null),
    recorder: rec, sleep: noSleep, pollAttempts: 3, pollDelayMs: 0
  });
  assert.equal(res.completed, false);
  assert.equal(res.brokeAt, "measured");
  // Antes esto grababa `kind: "error"`, y ese es el punto: las ventanas de placement filtran
  // `kind='measured'`, así que el correo que el proveedor SE TRAGA EN SILENCIO quedaba fuera de la
  // muestra. Un dominio con 36 de 40 tragados y 4 en INBOX mostraba tasa 100% y SUBÍA de volumen.
  // Era el único camino del sistema hacia más volumen sobre evidencia falsa.
  assert.deepEqual(events.map((e) => e.kind), ["sent", "measured"]);
  assert.equal(events[1]!.placement, "MISSING");
  assert.equal(res.placement, "MISSING");
});

test("falla el envío ⇒ error 'sent', no sigue", async () => {
  const { rec, events } = recorder();
  const res = await runLiveCycle({
    cycleId: "c4", testId: "t4", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t4]",
    mailer: { async send() { throw new Error("smtp_down"); } },
    gmail: fakeGmail({ gmailId: "x", threadId: "y", labelIds: ["INBOX"] }),
    recorder: rec, sleep: noSleep
  });
  assert.equal(res.brokeAt, "sent");
  assert.deepEqual(events.map((e) => e.kind), ["error"]);
});

test("ningún evento persistido filtra el password del box", async () => {
  const { rec, events } = recorder();
  await runLiveCycle({
    cycleId: "c5", testId: "t5", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t5]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "g5", threadId: "th5", labelIds: ["INBOX"] }),
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(SECRET_PASS), "el password nunca aparece en la actividad");
});

test("el resultado distingue DÓNDE CAYÓ de dónde quedó tras la señal", async () => {
  // El log resumen decía "COMPLETA · placement INBOX" sobre correos que habían caído en SPAM y que
  // NOSOTROS movimos: la lectura opuesta a la verdad, en la línea que más mira el operador. La
  // decisión siempre usó el valor medido (lee kind='measured'), así que la rampa nunca se engañó —
  // pero el log sí.
  const { rec, events } = recorder();
  const res = await runLiveCycle({
    cycleId: "c9", testId: "t9", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [t9]",
    mailer: fakeMailer(), gmail: fakeGmail({ id: "m9", labelIds: ["SPAM"], threadId: "th9" }),
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.equal(res.placementMedido, "SPAM", "cayó en spam: eso es lo que dice la reputación");
  assert.equal(res.placement, "INBOX", "y nuestra señal lo movió, que es lo que calienta");
  assert.equal(events.find((e) => e.kind === "measured")?.placement, "SPAM");
});

// ══ EL INSTRUMENTO NO SE ENTRENA A SÍ MISMO (R-02) ═══════════════════════════════════════════════

test("la semilla que MIDIÓ no recibe señal: `modifyLabels` no se llama", async () => {
  // EL DEFECTO QUE CIERRA (R-02, §0/§4 del doc de auditoría): cada vuelta medía el placement y acto
  // seguido hacía `not_spam+important` SOBRE LA MISMA SEMILLA que acababa de medir, con la misma
  // conexión. Gmail aprende POR DESTINATARIO: medido en producción, 32 engaged sobre 51 enviados y
  // 7 de las 34 mediciones eran un SPAM rescatado a mano. Con ~25 rescates por semilla, la bandeja
  // deja de reportar dónde caería nuestro correo en una bandeja FRESCA — que es exactamente
  // convertirse en el "health score interno del pool" que §6 pone como ventaja de Instantly y
  // desventaja nuestra.
  const { rec, events } = recorder();
  const sink: any = {};
  const res = await runLiveCycle({
    cycleId: "ci1", testId: "ti1", boxDomain: "box.com", fromAddress: "mailer@box.com",
    seedInbox: "instrumento@g.com", conversation: convo, subject: "Asunto [ti1]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "gi1", threadId: "thi1", labelIds: ["SPAM"] }, sink),
    engagear: false,
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.equal(sink.modified, undefined, "a la que mide NO se le tocan las etiquetas");
  // La medición queda intacta: no hubo señal, así que no hay nada que mover. Antes esta misma
  // vuelta terminaba reportando INBOX sobre un correo que había caído en SPAM.
  assert.equal(res.placementMedido, "SPAM");
  assert.equal(res.placement, "SPAM");
  // El evento se graba igual: sin la fila, "no engageé a propósito" se vería idéntico a "el engage
  // falló" y el feed del panel perdería un paso de la vuelta.
  const engaged = events.find((e) => e.kind === "engaged")!;
  assert.equal(engaged.detail!.action, "ninguna");
  assert.match(String(engaged.detail!.motivo), /instrumento/);
  // Y la vuelta SIGUE: la respuesta desde la semilla es señal bidireccional, no manipulación de
  // etiquetas. Lo que R-02 manda retirar es lo segundo.
  assert.deepEqual(events.map((e) => e.kind), ["sent", "measured", "engaged", "replied"]);
  assert.equal(res.completed, true);
});

test("la OTRA semilla sí conserva el lift: con dos, una mide limpio y la otra entrena", async () => {
  // Es lo que hace que esto se pueda encender hoy: producción tiene DOS semillas que miden. Con una
  // sola, `instrumentoDeMedicion` la elige a ella y esto degrada a no engagear nunca — el techo
  // está marcado con `ponytail:` en el daemon.
  const sink: any = {};
  await runLiveCycle({
    cycleId: "ci2", testId: "ti2", boxDomain: "box.com", fromAddress: "mailer@box.com",
    seedInbox: "laotra@g.com", conversation: convo, subject: "Asunto [ti2]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "gi2", threadId: "thi2", labelIds: ["SPAM"] }, sink),
    engagear: true,
    recorder: recorder().rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.deepEqual(sink.modified.change, { add: ["INBOX", "IMPORTANT"], remove: ["SPAM", "CATEGORY_PROMOTIONS"] });
});

// ══ LA ENTRADA DEL CLAMP ANTI-FIRMA ══════════════════════════════════════════════════════════════

test("el `sent` graba el CUPO AUTORIZADO del día: sin esto el clamp del §10 no tiene dato", async () => {
  // `dailyQuota` implementa el clamp 3×/48h desde el diseño v1 y nunca tuvo entrada: el cupo
  // autorizado de hace dos días no se persistía en ningún lado. `detail` ya es JSONB y ya se
  // escribe en cada envío, así que esto no cuesta migración ni tabla nueva.
  const { rec, events } = recorder();
  await runLiveCycle({
    cycleId: "cc1", testId: "tc1", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [tc1]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "gc1", threadId: "thc1", labelIds: ["INBOX"] }),
    cupoDelDia: 6,
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.equal(events.find((e) => e.kind === "sent")!.detail!.cupoDelDia, 6);
});

test("sin cupo declarado la clave NO se escribe — ausente y 0 no son lo mismo", async () => {
  // Un `cupoDelDia: 0` escrito por defecto haría que `cupoAutorizadoVigente` devolviera 0 para ese
  // día, y `dailyQuota` NO clampea con 0. O sea: la ausencia se leería como "no clampear", igual
  // que hoy — pero encima habría una fila afirmando un cupo que nadie autorizó.
  const { rec, events } = recorder();
  await runLiveCycle({
    cycleId: "cc2", testId: "tc2", boxDomain: "box.com", fromAddress: "mailer@box.com", seedInbox: "seed@g.com",
    conversation: convo, subject: "Asunto [tc2]",
    mailer: fakeMailer(), gmail: fakeGmail({ gmailId: "gc2", threadId: "thc2", labelIds: ["INBOX"] }),
    recorder: rec, sleep: noSleep, pollAttempts: 1, pollDelayMs: 0
  });
  assert.equal("cupoDelDia" in events.find((e) => e.kind === "sent")!.detail!, false);
});
