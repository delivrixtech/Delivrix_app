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
    pedidas: 2,
    leidas: 2,
    bandejas: [
      { domain: "sana.com", serverSlug: "n1", estado: "healthy", detalle: "ok", ventana: "24h", entregados: 100, rechazados: 1, diferidos: 2, cerradoEn: [], picos: [], cruzados: [], cerca: [] },
      { domain: "atascada.com", serverSlug: "n2", estado: "stalled", detalle: "920 diferidos", ventana: "24h", entregados: 0, rechazados: 0, diferidos: 920, cerradoEn: ["comcast.net"], picos: [], cruzados: [], cerca: [] }
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
  assert.equal(body.bandejas.length, 2);
  assert.equal(body.leidas, 2);
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
