import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

/* Contrato local del evento (mirror del backend) para armar fixtures tipados. */
interface WarmupActivityEvent {
  id: string;
  occurredAt: string;
  cycleId: string;
  nodeDomain: string;
  seedInbox: string;
  kind: "sent" | "measured" | "engaged" | "replied" | "error";
  placement: string | null;
  subject: string | null;
  detail: Record<string, unknown>;
  testId: string | null;
}

type StageKey = "sent" | "measured" | "engaged" | "replied";

interface WarmupCycle {
  cycleId: string;
  subject: string | null;
  nodeDomain: string;
  seedInbox: string;
  occurredAt: string;
  stages: Record<StageKey, boolean>;
  placement: string | null;
  hasError: boolean;
  brokeAtStage: StageKey | null;
  eventCount: number;
}

interface WarmupModule {
  groupActivityByCycle: (
    events: WarmupActivityEvent[] | null | undefined,
    limit?: number
  ) => WarmupCycle[];
}

let server: ViteDevServer | null = null;

async function boot(): Promise<ViteDevServer> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server;
}

async function loadWarmup(): Promise<WarmupModule> {
  return (await boot()).ssrLoadModule("/src/v5/views/Warmup.tsx") as Promise<WarmupModule>;
}

after(async () => {
  await server?.close();
});

/* Helper: evento con defaults sanos, sobreescribibles por test. */
function ev(over: Partial<WarmupActivityEvent>): WarmupActivityEvent {
  return {
    id: over.id ?? "e",
    occurredAt: over.occurredAt ?? "2026-07-20T10:00:00Z",
    cycleId: over.cycleId ?? "c1",
    nodeDomain: over.nodeDomain ?? "infranationalcorp.com",
    seedInbox: over.seedInbox ?? "infradelivrixdemo@gmail.com",
    kind: over.kind ?? "sent",
    placement: over.placement ?? null,
    subject: over.subject ?? null,
    detail: over.detail ?? {},
    testId: over.testId ?? null
  };
}

/* ---------------- entrada vacía / basura ---------------- */

test("groupActivityByCycle: entrada vacía o basura ⇒ []", async () => {
  const { groupActivityByCycle } = await loadWarmup();
  assert.deepEqual(groupActivityByCycle([]), []);
  assert.deepEqual(groupActivityByCycle(null), []);
  assert.deepEqual(groupActivityByCycle(undefined), []);
  assert.deepEqual(groupActivityByCycle(42 as unknown as WarmupActivityEvent[]), []);
});

/* ---------------- agrupación + etapas + placement + asunto ---------------- */

test("groupActivityByCycle: agrupa por cycleId, detecta las 4 etapas y levanta placement/asunto/caja→semilla", async () => {
  const { groupActivityByCycle } = await loadWarmup();
  const cycles = groupActivityByCycle([
    ev({ id: "1", cycleId: "c1", kind: "sent", subject: "¿seguimos mañana?", occurredAt: "2026-07-20T10:00:00Z" }),
    ev({ id: "2", cycleId: "c1", kind: "measured", placement: "INBOX", occurredAt: "2026-07-20T10:01:00Z" }),
    ev({ id: "3", cycleId: "c1", kind: "engaged", occurredAt: "2026-07-20T10:02:00Z" }),
    ev({ id: "4", cycleId: "c1", kind: "replied", occurredAt: "2026-07-20T10:03:00Z" })
  ]);
  assert.equal(cycles.length, 1);
  const c = cycles[0];
  assert.equal(c.cycleId, "c1");
  assert.deepEqual(c.stages, { sent: true, measured: true, engaged: true, replied: true });
  assert.equal(c.placement, "INBOX");
  assert.equal(c.subject, "¿seguimos mañana?");
  assert.equal(c.nodeDomain, "infranationalcorp.com");
  assert.equal(c.seedInbox, "infradelivrixdemo@gmail.com");
  assert.equal(c.occurredAt, "2026-07-20T10:03:00Z"); // etapa más reciente del ciclo
  assert.equal(c.eventCount, 4);
  assert.equal(c.hasError, false);
  assert.equal(c.brokeAtStage, null);
});

test("groupActivityByCycle: placement prefiere la etapa de medición sobre otras", async () => {
  const { groupActivityByCycle } = await loadWarmup();
  const [c] = groupActivityByCycle([
    ev({ id: "1", cycleId: "c1", kind: "sent", placement: "OTHER" }),
    ev({ id: "2", cycleId: "c1", kind: "measured", placement: "SPAM" })
  ]);
  assert.equal(c.placement, "SPAM");
});

/* ---------------- orden + cap ---------------- */

test("groupActivityByCycle: ordena vueltas más-reciente-primero y capa en `limit`", async () => {
  const { groupActivityByCycle } = await loadWarmup();
  const events: WarmupActivityEvent[] = [];
  for (let i = 0; i < 15; i += 1) {
    events.push(
      ev({
        id: `s${i}`,
        cycleId: `c${i}`,
        kind: "sent",
        occurredAt: `2026-07-20T${String(i).padStart(2, "0")}:00:00Z`
      })
    );
  }
  const cycles = groupActivityByCycle(events); // limit por defecto = 12
  assert.equal(cycles.length, 12);
  assert.equal(cycles[0].cycleId, "c14"); // el más reciente primero
  assert.equal(cycles[11].cycleId, "c3");
  assert.equal(groupActivityByCycle(events, 3).length, 3); // limit explícito
});

/* ---------------- error: se cortó en <etapa> ---------------- */

test("groupActivityByCycle: error ⇒ hasError y brokeAtStage = primera etapa faltante", async () => {
  const { groupActivityByCycle } = await loadWarmup();
  const [c] = groupActivityByCycle([
    ev({ id: "1", cycleId: "c1", kind: "sent" }),
    ev({ id: "2", cycleId: "c1", kind: "measured", placement: "INBOX" }),
    ev({ id: "3", cycleId: "c1", kind: "error" })
  ]);
  assert.equal(c.hasError, true);
  assert.equal(c.brokeAtStage, "engaged"); // sent+measured OK ⇒ se cortó en engaged
  assert.deepEqual(c.stages, { sent: true, measured: true, engaged: false, replied: false });
});

test("groupActivityByCycle: error con detail.stage explícito usa esa etapa", async () => {
  const { groupActivityByCycle } = await loadWarmup();
  const [c] = groupActivityByCycle([
    ev({ id: "1", cycleId: "c1", kind: "sent" }),
    ev({ id: "2", cycleId: "c1", kind: "error", detail: { stage: "sent" } })
  ]);
  assert.equal(c.hasError, true);
  assert.equal(c.brokeAtStage, "sent");
});

/* ---------------- defensa: eventos sin cycleId ---------------- */

test("groupActivityByCycle: descarta eventos sin cycleId sin lanzar", async () => {
  const { groupActivityByCycle } = await loadWarmup();
  const cycles = groupActivityByCycle([
    ev({ id: "1", cycleId: "", kind: "sent" }),
    ev({ id: "2", cycleId: "c1", kind: "sent" })
  ]);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].cycleId, "c1");
});
