// Tests de la lectura de la ultima medicion (el sentido de read_sender_measurement).
//
// Lo que protegen: que "nunca se midio" se declare en vez de parecer una flota sin problemas,
// y que el filtro por dominio no invente una bandeja que no estuvo en la corrida.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { MEASUREMENT_FILE } from "../sender-measurement.ts";
import { handleSenderMeasurementHttp } from "./sender-measurement-read.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const TOKEN = "token-del-panel";
const ahora = new Date("2026-07-31T12:00:00.000Z");

function request(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method: "GET", url, headers }) as unknown as IncomingMessage;
}

function captureResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}

async function workspaceMedido(): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "medicion-read-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  await ws.updateInventoryJson(MEASUREMENT_FILE, () => ({
    medidoEn: ahora.toISOString(),
    duracionMs: 1000,
    pedidas: 3,
    leidas: 3,
    bandejas: [
      { domain: "sana.com", serverSlug: "n1", estado: "healthy", detalle: "ok", ventana: "24h", entregados: 100, rechazados: 1, diferidos: 2, cerradoEn: [], picos: [], cruzados: [], cerca: [] },
      { domain: "atascada.com", serverSlug: "n2", estado: "stalled", detalle: "920 diferidos", ventana: "24h", entregados: 0, rechazados: 0, diferidos: 920, cerradoEn: ["comcast.net"], picos: [], cruzados: [], cerca: [] },
      // El estado que INVENTA este despliegue, con los números reales que annualcorp-control.com
      // traía en la foto del 2026-08-08 (18 entregados / 1 rechazado): hoy sale `healthy` y con el
      // sensor nuevo cae en `insufficient_sample`, porque 19 intentos no alcanzan para absolver a
      // nadie. Ver el test de abajo para qué se rompía sin él.
      { domain: "annualcorp-control.com", serverSlug: "n3", estado: "insufficient_sample", detalle: "18 entregados, 1 rechazados", ventana: "24h", entregados: 18, rechazados: 1, diferidos: 17, cerradoEn: [], picos: [], cruzados: [], cerca: [] }
    ]
  }));
  return ws;
}

async function llamar(ws: OpenClawWorkspace, url: string) {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderMeasurementHttp({
    request: request(url, { "x-delivrix-token": TOKEN }),
    response: response as unknown as ServerResponse,
    workspace: ws,
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test("sin token la lectura se rechaza", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderMeasurementHttp({
    request: request("/v1/sender-pool/measurement"),
    response: response as unknown as ServerResponse,
    workspace: await workspaceMedido(),
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  assert.equal(response.statusCode, 401);
});

test("nunca medida, la respuesta lo DECLARA en vez de parecer flota sin problemas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "medicion-read-v-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  const { statusCode, body } = await llamar(ws, "/v1/sender-pool/measurement");
  assert.equal(statusCode, 200);
  assert.equal(body.medidoEn, null);
  assert.match(body.motivo, /nunca se midió/);
});

test("la corrida completa viaja con su medidoEn", async () => {
  const { body } = await llamar(await workspaceMedido(), "/v1/sender-pool/measurement");
  assert.equal(body.medidoEn, ahora.toISOString());
  assert.equal(body.bandejas.length, 3);
  assert.equal(body.leidas, 3);
});

test("?view=agent NOMBRA a las bandejas sin muestra: es la señal por la que se despliega", async () => {
  // EL INCIDENTE. El sensor se absolvía solo por el calendario: lee el mail.log con ventana de 5
  // días, y un nodo bloqueado deja de mandar PORQUE está bloqueado, así que a los 5 días la
  // evidencia se le cae de la ventana y salía `healthy`. Medido en vivo el 2026-08-07: 20:05 UTC la
  // flota tenía 35 bloqueados y 02:08 tenía 1; el pool saltó de 6 a 29 y el warmup mandó desde
  // nodos quemados (vueltas #21/#22/#23, ninguna cerró COMPLETA).
  //
  // El sensor nuevo devuelve `insufficient_sample` en vez de `healthy`. Pero al agente le llegaba
  // sólo el CONTEO por estado, nunca los NOMBRES: sabía que había N nodos sin juzgar y no podía
  // nombrar uno solo para hablarle al jefe. O sea que la señal por la que se hace todo el
  // despliegue no llegaba a quien tiene que contarla.
  const { body } = await llamar(await workspaceMedido(), "/v1/sender-pool/measurement?view=agent");
  const nombres = body.accionables.map((a: { dom: string }) => a.dom);
  assert.ok(nombres.includes("annualcorp-control.com"), `la bandeja sin muestra no llegó al agente: ${nombres.join(", ")}`);
  assert.equal(body.conteos.insufficient_sample, 1, "el conteo sigue estando, además del nombre");

  // Y LA PUERTA NO SE ABRE DE MÁS: una bandeja sana sin cruzados sigue afuera. Con las 58 adentro
  // el resumen vuelve a pasarse de los 4096 chars del límite de tool y se trunca — que es el
  // problema que `accionables` vino a resolver.
  assert.ok(!nombres.includes("sana.com"), "una bandeja sana no es accionable");
  assert.equal(body.accionablesOmitidas, 0, "lo omitido se cuenta, no se oculta");
});

test("el filtro por dominio devuelve solo esa bandeja, con su detalle por receptor", async () => {
  const { body } = await llamar(await workspaceMedido(), "/v1/sender-pool/measurement?domain=Atascada.COM.");
  assert.equal(body.domain, "atascada.com");
  assert.equal(body.bandeja.estado, "stalled");
  assert.deepEqual(body.bandeja.cerradoEn, ["comcast.net"]);
});

test("un dominio que no estuvo en la corrida sale null con motivo, no inventado", async () => {
  const { body } = await llamar(await workspaceMedido(), "/v1/sender-pool/measurement?domain=ajena.com");
  assert.equal(body.bandeja, null);
  assert.match(body.motivo, /no estuvo en la última corrida/);
});
