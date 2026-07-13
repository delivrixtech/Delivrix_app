import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLanded,
  isGraceWindowClosed,
  nextPollAt,
  readPlacement,
  shouldKeepPolling,
  GRACE_WINDOW_MS,
  POLL_SCHEDULE_MS,
  TEST_ID_HEADER,
  type ImapClient,
  type ImapMessage
} from "./imap-placement-reader.ts";
import type { PlacementTest, SeedProvider } from "../domain/types.ts";

// ── Fixtures y mocks inyectables (sin red) ───────────────────────────────────
const T0 = new Date("2026-07-09T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function mkTest(over: Partial<PlacementTest> = {}): PlacementTest {
  return {
    nodeId: "n1",
    seedProvider: "gmail",
    seedInbox: "seed@gmail.com",
    testId: "tid-123",
    sentAt: T0,
    ...over
  };
}

function msg(over: Partial<ImapMessage> = {}): ImapMessage {
  return {
    folder: "INBOX",
    headers: { [TEST_ID_HEADER]: "tid-123" },
    ...over
  };
}

/** Cliente que devuelve una lista fija de mensajes. */
function clientReturning(messages: ImapMessage[]): ImapClient {
  return {
    async search() {
      return messages;
    }
  };
}

/** Cliente que siempre falla (simula caída de red/IMAP). */
const FAILING_CLIENT: ImapClient = {
  async search() {
    throw new Error("ECONNRESET imap");
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// classifyLanded — Gmail (labels)
// ═════════════════════════════════════════════════════════════════════════════

test("Gmail Primary: \\Inbox + CATEGORY_PERSONAL ⇒ primary", () => {
  const m = msg({ gmailRaw: true, gmailLabels: ["\\Inbox", "\\Important", "CATEGORY_PERSONAL"] });
  assert.equal(classifyLanded(m), "primary");
});

test("Gmail Promotions ⇒ tabs (pestaña cuenta como inbox aguas arriba)", () => {
  const m = msg({ gmailRaw: true, gmailLabels: ["\\Inbox", "CATEGORY_PROMOTIONS"] });
  assert.equal(classifyLanded(m), "tabs");
});

test("Gmail Social/Updates/Forums ⇒ tabs", () => {
  for (const cat of ["CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]) {
    const m = msg({ gmailRaw: true, gmailLabels: ["\\Inbox", cat] });
    assert.equal(classifyLanded(m), "tabs", `${cat} ⇒ tabs`);
  }
});

test("Gmail Spam: label \\Spam ⇒ spam (gana sobre \\Inbox)", () => {
  const m = msg({ gmailRaw: true, gmailLabels: ["\\Spam"] });
  assert.equal(classifyLanded(m), "spam");
});

test("Gmail: spam gana aunque coexista con una categoría de pestaña", () => {
  const m = msg({ gmailRaw: true, gmailLabels: ["\\Spam", "CATEGORY_PROMOTIONS"] });
  assert.equal(classifyLanded(m), "spam");
});

test("Gmail sin labels útiles ⇒ cae a clasificación por carpeta", () => {
  const m = msg({ gmailRaw: true, gmailLabels: [], folder: "[Gmail]/Spam" });
  assert.equal(classifyLanded(m), "spam");
});

// ═════════════════════════════════════════════════════════════════════════════
// classifyLanded — resto (carpeta)
// ═════════════════════════════════════════════════════════════════════════════

test("Outlook INBOX ⇒ primary", () => {
  const m = msg({ folder: "INBOX" });
  assert.equal(classifyLanded(m), "primary");
});

test("Outlook Junk Email ⇒ spam", () => {
  const m = msg({ folder: "Junk Email" });
  assert.equal(classifyLanded(m), "spam");
});

test("Yahoo Bulk Mail ⇒ spam", () => {
  const m = msg({ folder: "Bulk Mail" });
  assert.equal(classifyLanded(m), "spam");
});

test("carpeta 'otros'/no-inbox no-spam ⇒ tabs", () => {
  const m = msg({ folder: "Other" });
  assert.equal(classifyLanded(m), "tabs");
});

test("carpeta INBOX es case-insensitive", () => {
  assert.equal(classifyLanded(msg({ folder: "inbox" })), "primary");
});

// ═════════════════════════════════════════════════════════════════════════════
// Grace window (§9): poll t+2m/10m/30m/2h, finaliza t+6h
// ═════════════════════════════════════════════════════════════════════════════

test("POLL_SCHEDULE_MS = t+2m/10m/30m/2h", () => {
  assert.deepEqual(POLL_SCHEDULE_MS, [2 * MIN, 10 * MIN, 30 * MIN, 2 * HOUR]);
});

test("GRACE_WINDOW_MS = 6h", () => {
  assert.equal(GRACE_WINDOW_MS, 6 * HOUR);
});

test("dentro del window: no cerrado, seguir sondeando (t+2m)", () => {
  const now = new Date(T0.getTime() + 2 * MIN);
  assert.equal(isGraceWindowClosed(T0, now), false);
  assert.equal(shouldKeepPolling(T0, now), true);
});

test("borde inferior: justo antes de t+6h sigue abierto", () => {
  const now = new Date(T0.getTime() + GRACE_WINDOW_MS - 1);
  assert.equal(isGraceWindowClosed(T0, now), false);
  assert.equal(shouldKeepPolling(T0, now), true);
});

test("borde t+6h exacto: window CERRADO, dejar de sondear", () => {
  const now = new Date(T0.getTime() + GRACE_WINDOW_MS);
  assert.equal(isGraceWindowClosed(T0, now), true);
  assert.equal(shouldKeepPolling(T0, now), false);
});

test("pasado t+6h: cerrado", () => {
  const now = new Date(T0.getTime() + 8 * HOUR);
  assert.equal(isGraceWindowClosed(T0, now), true);
  assert.equal(shouldKeepPolling(T0, now), false);
});

test("nextPollAt: devuelve el primer offset futuro (t+2m recién enviado)", () => {
  const at = nextPollAt(T0, T0);
  assert.deepEqual(at, new Date(T0.getTime() + 2 * MIN));
});

test("nextPollAt: entre t+2m y t+10m ⇒ próximo es t+10m", () => {
  const now = new Date(T0.getTime() + 5 * MIN);
  assert.deepEqual(nextPollAt(T0, now), new Date(T0.getTime() + 10 * MIN));
});

test("nextPollAt: pasado el último offset (t+2h) pero abierto ⇒ sondea al cierre t+6h", () => {
  const now = new Date(T0.getTime() + 3 * HOUR);
  assert.deepEqual(nextPollAt(T0, now), new Date(T0.getTime() + GRACE_WINDOW_MS));
});

test("nextPollAt: window cerrado ⇒ null", () => {
  const now = new Date(T0.getTime() + GRACE_WINDOW_MS);
  assert.equal(nextPollAt(T0, now), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// readPlacement — encontrado
// ═════════════════════════════════════════════════════════════════════════════

test("readPlacement Gmail Primary: fila resuelta con readAt=now", async () => {
  const now = new Date(T0.getTime() + 5 * MIN);
  const client = clientReturning([msg({ gmailRaw: true, gmailLabels: ["\\Inbox", "CATEGORY_PERSONAL"] })]);
  const row = await readPlacement(client, mkTest(), now);
  assert.equal(row.landedIn, "primary");
  assert.deepEqual(row.readAt, now);
  assert.equal(row.testId, "tid-123");
  assert.equal(row.nodeId, "n1");
  assert.equal(row.seedProvider, "gmail");
});

test("readPlacement Gmail tab ⇒ tabs", async () => {
  const client = clientReturning([msg({ gmailRaw: true, gmailLabels: ["\\Inbox", "CATEGORY_PROMOTIONS"] })]);
  const row = await readPlacement(client, mkTest(), new Date(T0.getTime() + MIN));
  assert.equal(row.landedIn, "tabs");
});

test("readPlacement Gmail spam ⇒ spam (NO missing)", async () => {
  const client = clientReturning([msg({ gmailRaw: true, gmailLabels: ["\\Spam"] })]);
  const row = await readPlacement(client, mkTest(), new Date(T0.getTime() + MIN));
  assert.equal(row.landedIn, "spam");
});

test("readPlacement Outlook INBOX ⇒ primary", async () => {
  const client = clientReturning([msg({ folder: "INBOX" })]);
  const row = await readPlacement(client, mkTest({ seedProvider: "outlook" as SeedProvider }), new Date(T0.getTime() + MIN));
  assert.equal(row.landedIn, "primary");
  assert.equal(row.seedProvider, "outlook");
});

test("readPlacement Outlook Junk ⇒ spam", async () => {
  const client = clientReturning([msg({ folder: "Junk" })]);
  const row = await readPlacement(client, mkTest({ seedProvider: "outlook" as SeedProvider }), new Date(T0.getTime() + MIN));
  assert.equal(row.landedIn, "spam");
});

test("readPlacement: fallback por token de body (mensaje sin header, la búsqueda ya matcheó)", async () => {
  const client = clientReturning([{ folder: "INBOX", headers: {} }]);
  const row = await readPlacement(client, mkTest(), new Date(T0.getTime() + MIN));
  assert.equal(row.landedIn, "primary");
});

test("readPlacement: elige la fila cuyo header coincide entre varias devueltas", async () => {
  const client = clientReturning([
    msg({ folder: "Junk", headers: { [TEST_ID_HEADER]: "otro" } }),
    msg({ folder: "INBOX", headers: { [TEST_ID_HEADER]: "tid-123" } })
  ]);
  const row = await readPlacement(client, mkTest(), new Date(T0.getTime() + MIN));
  assert.equal(row.landedIn, "primary");
});

// ═════════════════════════════════════════════════════════════════════════════
// readPlacement — missing vs pendiente
// ═════════════════════════════════════════════════════════════════════════════

test("readPlacement: no encontrado DENTRO del window ⇒ pendiente (null, sin readAt)", async () => {
  const now = new Date(T0.getTime() + 30 * MIN);
  const row = await readPlacement(clientReturning([]), mkTest(), now);
  assert.equal(row.landedIn, null);
  assert.equal(row.readAt, undefined);
});

test("readPlacement: no encontrado y window CERRADO (t+6h) ⇒ missing con readAt=now", async () => {
  const now = new Date(T0.getTime() + GRACE_WINDOW_MS);
  const row = await readPlacement(clientReturning([]), mkTest(), now);
  assert.equal(row.landedIn, "missing");
  assert.deepEqual(row.readAt, now);
});

test("readPlacement: no encontrado pasado t+6h ⇒ missing (≠ spam)", async () => {
  const now = new Date(T0.getTime() + 7 * HOUR);
  const row = await readPlacement(clientReturning([]), mkTest(), now);
  assert.equal(row.landedIn, "missing");
});

// ═════════════════════════════════════════════════════════════════════════════
// readPlacement — cliente que falla
// ═════════════════════════════════════════════════════════════════════════════

test("readPlacement: cliente falla ⇒ pendiente (null), nunca lanza ni inventa", async () => {
  const now = new Date(T0.getTime() + GRACE_WINDOW_MS + HOUR); // aunque el window ya cerró
  const row = await readPlacement(FAILING_CLIENT, mkTest(), now);
  assert.equal(row.landedIn, null);
  assert.equal(row.readAt, undefined);
});
