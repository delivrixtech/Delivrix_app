// Tests de la corrida de medicion.
//
// Lo que protegen: que ninguna forma de fallar termine pareciendose a un nodo sano.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import { leerUltimaMedicion, medirBandeja, medirFlota } from "./sender-measurement.ts";

const ahora = new Date("2026-07-30T18:00:00.000Z");

/** Salida real de un nodo con la cola atascada: el caso que el modulo viejo leia como sano. */
const NODO_ATASCADO = `## DELIVERED
## BLOCKED
## DEFERRED
    920 comcast.net
## END`;

const NODO_SANO = `## DELIVERED
   1500 gmail.com
## BLOCKED
      5 comcast.net
## DEFERRED
     30 gmail.com
## END`;

const VOLUMEN = `## VOLUME
   3651 Jul 30\tgmail.com
## END`;

function runner(porComando: (command: string) => string | Error) {
  return {
    async run(input: { command: string }) {
      const out = porComando(input.command);
      if (out instanceof Error) throw out;
      return { stdout: out, exitCode: 0 };
    }
  };
}

test("una bandeja con la cola atascada NO se mide como sana", async () => {
  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_ATASCADO)),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4"
  });

  assert.equal(m.estado, "stalled");
  assert.equal(m.diferidos, 920);
  assert.match(m.detalle, /la cola se acumula/);
});

test("si no se puede leer el nodo, los contadores son null y NO cero", async () => {
  const m = await medirBandeja({
    sshRunner: runner(() => new Error("ssh caido")),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4"
  });

  assert.equal(m.estado, "unreadable");
  assert.equal(m.entregados, null);
  assert.equal(m.rechazados, null);
  assert.equal(m.diferidos, null, "un cero aca se leeria como 'no rebota nada'");
});

test("el pico contra el umbral permanente viaja con la medicion", async () => {
  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_SANO)),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4"
  });

  const google = m.picos.find((p) => p.familia === "google");
  assert.equal(google?.mensajes, 3_651);
  assert.equal(google?.umbral, 5_000);
  assert.equal(google?.ratio, 0.73);
  assert.deepEqual(m.cerca, ["google"], "73% ya avisa");
  assert.deepEqual(m.cruzados, []);
});

test("la medicion declara su cobertura: pedidas vs leidas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "medicion-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  let n = 0;

  const flota = await medirFlota({
    workspace: ws,
    // La segunda bandeja no se puede leer: la cobertura tiene que delatarlo.
    sshRunner: runner(() => (++n > 2 ? new Error("nodo caido") : NODO_SANO)),
    bandejas: [
      { domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" },
      { domain: "b.com", serverSlug: "n2", serverIp: "2.2.2.2" }
    ],
    concurrency: 1,
    now: () => ahora
  });

  assert.equal(flota.pedidas, 2);
  assert.equal(flota.leidas, 1, "la cobertura no se infla");
  assert.equal(flota.bandejas.length, 2, "la que fallo igual aparece, marcada");
});

test("la medicion se persiste y se puede releer sin volver a la flota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "medicion-p-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });

  assert.equal(await leerUltimaMedicion(ws), null, "nunca medido NO es todo en cero");

  await medirFlota({
    workspace: ws,
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : NODO_SANO)),
    bandejas: [{ domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" }],
    now: () => ahora
  });

  const leida = await leerUltimaMedicion(ws);
  assert.equal(leida?.medidoEn, ahora.toISOString());
  assert.equal(leida?.bandejas[0]?.domain, "a.com");
});

test("una bandeja que revienta no tumba la corrida ni cuenta como sana", async () => {
  const dir = await mkdtemp(join(tmpdir(), "medicion-e-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });

  const flota = await medirFlota({
    workspace: ws,
    sshRunner: { async run() { throw new Error("boom"); } },
    bandejas: [
      { domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" },
      { domain: "b.com", serverSlug: "n2", serverIp: "2.2.2.2" }
    ],
    now: () => ahora
  });

  assert.equal(flota.leidas, 0);
  assert.ok(flota.bandejas.every((b) => b.estado === "unreadable"));
});
