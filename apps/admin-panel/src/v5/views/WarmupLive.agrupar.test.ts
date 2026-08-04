// Test del colapso de errores repetidos en el feed en vivo, y de la separación entre mensajes.
//
// El feed mostraba SEIS filas idénticas seguidas con el mismo rechazo, palabra por palabra. Seis
// copias del mismo hecho no informan seis veces: empujan fuera de la pantalla lo que sí es
// distinto, y entrenan al operador a dejar de leer el feed.
//
// Carga el módulo por vite, igual que WarmupActivityFeed.test.ts: `node --test` no sabe leer .tsx,
// y correrlo con `cwd` dentro de apps/admin-panel da un falso rojo (ERR_LOAD_URL).

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

interface Vuelta {
  cycleId: string;
  testId: string | null;
  domain: string;
  seed: string;
  subject: string | null;
  ultimo: string;
  etapas: Record<string, unknown>;
  placement: string | null;
  error: string | null;
  repetidos?: number;
}

interface LiveModule {
  agruparRepetidos: (vueltas: Vuelta[]) => Vuelta[];
  separacionEntre: (a: string, b: string) => string | null;
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

const v = (cycleId: string, domain: string, error: string | null): Vuelta => ({
  cycleId,
  domain,
  error,
  testId: null,
  seed: "s@x.com",
  subject: null,
  ultimo: "2026-08-04T00:00:00Z",
  etapas: {},
  placement: null
});

test("colapsa errores idénticos de dominios distintos y conserva la cuenta", async () => {
  const { agruparRepetidos } = await cargar();
  const r = agruparRepetidos([
    v("1", "a.com", "450 daily send cap reached"),
    v("2", "b.com", "450 daily send cap reached"),
    v("3", "c.com", "450 daily send cap reached")
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.repetidos, 3, "'pasó tres veces' SÍ informa; repetir el texto tres veces no");
});

test("NO colapsa errores distintos", async () => {
  const { agruparRepetidos } = await cargar();
  const r = agruparRepetidos([v("1", "a.com", "450 cap"), v("2", "b.com", "550 5.7.1 unsolicited")]);
  assert.equal(r.length, 2);
});

test("NO colapsa vueltas sin error: las buenas nunca se pisan entre sí", async () => {
  const { agruparRepetidos } = await cargar();
  assert.equal(agruparRepetidos([v("1", "a.com", null), v("2", "b.com", null)]).length, 2);
});

test("NO colapsa el mismo error del MISMO dominio", async () => {
  // Un dominio fallando tres veces seguidas es una señal distinta de tres dominios fallando una vez.
  const { agruparRepetidos } = await cargar();
  assert.equal(agruparRepetidos([v("1", "a.com", "450 cap"), v("2", "a.com", "450 cap")]).length, 2);
});

test("no muta las vueltas de entrada", async () => {
  const { agruparRepetidos } = await cargar();
  const entrada = [v("1", "a.com", "450 cap"), v("2", "b.com", "450 cap")];
  agruparRepetidos(entrada);
  assert.equal(entrada[0]!.repetidos, undefined);
});

// ── La separación entre mensajes del hilo ───────────────────────────────────────────────────────
// Es EL dato del calentamiento: lo que distingue una conversación de una ráfaga automática.

test("la separación se muestra en unidades legibles", async () => {
  const { separacionEntre } = await cargar();
  assert.equal(separacionEntre("2026-08-04T10:00:00Z", "2026-08-04T10:45:00Z"), "45 min");
  assert.equal(separacionEntre("2026-08-04T10:00:00Z", "2026-08-04T12:00:00Z"), "2 h");
  assert.equal(separacionEntre("2026-08-04T10:00:00Z", "2026-08-04T12:30:00Z"), "2 h 30 min");
  assert.equal(separacionEntre("2026-08-01T10:00:00Z", "2026-08-04T10:00:00Z"), "3 d");
});

test("menos de un minuto no se muestra: no aporta y ensucia", async () => {
  const { separacionEntre } = await cargar();
  assert.equal(separacionEntre("2026-08-04T10:00:00Z", "2026-08-04T10:00:30Z"), null);
});

test("una fecha ilegible devuelve null, no NaN en pantalla", async () => {
  const { separacionEntre } = await cargar();
  assert.equal(separacionEntre("no-es-fecha", "2026-08-04T10:00:00Z"), null);
  assert.equal(separacionEntre("2026-08-04T10:00:00Z", ""), null);
});
