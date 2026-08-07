// Test del agrupamiento de eventos en VUELTAS del feed en vivo.
//
// Antes este archivo hacía SSR de Warmup.tsx para testear `groupActivityByCycle`, una función
// exportada que la pantalla no renderizaba desde hacía tiempo: tests verdes sobre código muerto,
// que es peor que no tener test — dan cobertura aparente sobre lo que no se ejecuta. La función
// que de verdad arma las vueltas que ve el operador es `agruparVueltas` de WarmupLive.tsx, y es la
// que se fija acá.
//
// Carga el módulo por vite: `node --test` no sabe leer .tsx, y correrlo con `cwd` dentro de
// apps/admin-panel da un falso rojo (ERR_LOAD_URL).

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

/* Contrato local del evento (mirror del backend) para armar fixtures tipados. */
interface EventoWarmup {
  id: string;
  testId?: string | null;
  occurredAt: string;
  cycleId: string;
  nodeDomain: string;
  seedInbox: string;
  kind: "sent" | "measured" | "engaged" | "replied" | "error";
  placement: string | null;
  subject: string | null;
  detail: Record<string, unknown>;
}

interface Vuelta {
  cycleId: string;
  testId: string | null;
  domain: string;
  seed: string;
  subject: string | null;
  ultimo: string;
  etapas: Record<string, EventoWarmup | undefined>;
  placement: string | null;
  error: string | null;
}

interface LiveModule {
  agruparVueltas: (events: EventoWarmup[]) => Vuelta[];
}

let server: ViteDevServer | null = null;

async function cargar(): Promise<LiveModule> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server.ssrLoadModule("/src/v5/views/WarmupLive.tsx") as Promise<LiveModule>;
}

after(async () => {
  await server?.close();
});

const ev = (over: Partial<EventoWarmup>): EventoWarmup => ({
  id: over.id ?? "e1",
  occurredAt: over.occurredAt ?? "2026-08-06T10:00:00.000Z",
  cycleId: over.cycleId ?? "c1",
  nodeDomain: over.nodeDomain ?? "corpfiling-infra.com",
  seedInbox: over.seedInbox ?? "semilla@gmail.com",
  kind: over.kind ?? "sent",
  placement: over.placement ?? null,
  subject: over.subject ?? null,
  detail: over.detail ?? {},
  ...(over.testId !== undefined ? { testId: over.testId } : {})
});

test("una vuelta junta sus etapas y se ordena por el evento más reciente", async () => {
  const { agruparVueltas } = await cargar();
  const vueltas = agruparVueltas([
    ev({ id: "a", cycleId: "vieja", occurredAt: "2026-08-06T08:00:00.000Z" }),
    ev({ id: "b", cycleId: "nueva", occurredAt: "2026-08-06T10:00:00.000Z", subject: "hola" }),
    ev({ id: "c", cycleId: "nueva", occurredAt: "2026-08-06T10:05:00.000Z", kind: "measured", placement: "INBOX" })
  ]);

  assert.deepEqual(vueltas.map((v) => v.cycleId), ["nueva", "vieja"]);
  assert.equal(vueltas[0]!.ultimo, "2026-08-06T10:05:00.000Z");
  assert.ok(vueltas[0]!.etapas.sent && vueltas[0]!.etapas.measured, "las dos etapas del ciclo entran a la misma vuelta");
  assert.equal(vueltas[0]!.placement, "INBOX");
});

test("el motivo del corte se conserva: un error sin motivo no puede verse como una vuelta sana", async () => {
  // La vista anterior tiraba el `detail` del evento de error y la vuelta quedaba idéntica a una
  // normal. El operador veía una vuelta incompleta sin saber dónde se cortó ni por qué.
  const { agruparVueltas } = await cargar();
  const [vuelta] = agruparVueltas([
    ev({ id: "a", kind: "sent" }),
    ev({ id: "b", kind: "error", occurredAt: "2026-08-06T10:01:00.000Z", detail: { stage: "envio", note: "450 daily send cap reached" } })
  ]);

  assert.equal(vuelta!.error, "envio: 450 daily send cap reached");
});

test("el testId sobrevive aunque llegue en una etapa posterior", async () => {
  // Sin testId la vuelta no se puede abrir para traer el correo real del buzón: si se perdiera al
  // fusionar las etapas, el botón "ver hilo" quedaría muerto sin decir por qué.
  const { agruparVueltas } = await cargar();
  const [vuelta] = agruparVueltas([
    ev({ id: "a", kind: "sent", testId: null }),
    ev({ id: "b", kind: "measured", occurredAt: "2026-08-06T10:02:00.000Z", testId: "t-123" })
  ]);

  assert.equal(vuelta!.testId, "t-123");
});

test("entrada vacía devuelve lista vacía, no explota", async () => {
  const { agruparVueltas } = await cargar();
  assert.deepEqual(agruparVueltas([]), []);
});
