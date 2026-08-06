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

test("porReceptor SOBREVIVE a la persistencia y esta ACOTADO", async () => {
  // INCIDENTE QUE FIJA (2026-08-06): 36 de 58 bandejas cerradas por el receptor, y el archivo solo
  // guardaba QUIEN cierra (`cerradoEn`) mas los totales globales. El clasificador YA calculaba
  // `byProvider` y el persistidor lo tiraba entero. Dos cosas quedaban sin respuesta:
  //   · cuanto correo seguia entregando cada bandeja por las OTRAS puertas, que es lo unico que
  //     dice si frenarla cuesta correo de cliente. La decision se tomaba a ciegas sobre 36 nodos.
  //   · si Yahoo o Apple estaban difiriendo: el bloqueo se detecta SOLO por rebotes 5xx y Yahoo
  //     tipicamente DIFIERE con 4xx, que no alimenta `cerradoEn`. Asi "Yahoo no aparece en ninguna
  //     de las 58" se leyo como "Yahoo no nos bloquea" — ausencia de instrumento, no evidencia.
  // La forma real de una de las 36: cerrada en Google (195 rechazos sobre 200 intentos = 97%) pero
  // entregando 400 por Comcast. Ese 400 es el numero que decide si frenarla cuesta correo o no.
  const SALIDA = `## DELIVERED
      5 gmail.com
    400 comcast.net
      1 diminuto.com
## BLOCKED
    195 gmail.com
      2 diminuto.com
## DEFERRED
    300 yahoo.com
## END`;

  const m = await medirBandeja({
    sshRunner: runner((c) => (c.includes("## VOLUME") ? VOLUMEN : SALIDA)),
    domain: "x.com",
    serverSlug: "n1",
    serverIp: "1.2.3.4"
  });

  const gmail = m.porReceptor?.find((p) => p.receptor === "gmail.com");
  assert.deepEqual(gmail, { receptor: "gmail.com", entregados: 5, rechazados: 195, diferidos: 0 });
  // La pregunta que antes no se podia contestar sobre ninguna de las 36: cuanto sigue entregando
  // por las OTRAS puertas. `cerradoEn` decia "gmail.com" y los totales decian 405 entregados, pero
  // nada decia que esos 405 eran casi todos de Comcast.
  assert.deepEqual(
    m.porReceptor?.find((p) => p.receptor === "comcast.net"),
    { receptor: "comcast.net", entregados: 400, rechazados: 0, diferidos: 0 }
  );

  // EL CASO YAHOO, el que motiva todo el campo: rechazados 0 y aun asi tiene que estar. Un receptor
  // que solo difiere es invisible para `cerradoEn` por definicion.
  const yahoo = m.porReceptor?.find((p) => p.receptor === "yahoo.com");
  assert.deepEqual(yahoo, { receptor: "yahoo.com", entregados: 0, rechazados: 0, diferidos: 300 });
  assert.deepEqual(m.cerradoEn, ["gmail.com"], "yahoo difiere: NO figura como cerrado, y esa es la trampa");

  // El filtro por BLOCKED_MIN_ATTEMPTS (20) no es cosmetico: `byProvider` no tiene techo de filas y
  // 58 bandejas por cientos de receptores inflarian el JSON que el panel sirve entero. Abajo de 20
  // intentos el propio clasificador se niega a emitir veredicto, asi que no hay decision que tomar.
  assert.equal(m.porReceptor?.find((p) => p.receptor === "diminuto.com"), undefined, "3 intentos no entran");
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
