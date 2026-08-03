// Tests de la ruta del límite físico: auth fail-closed + que distinga "nunca se corrió" de
// "el archivo está roto" (decir lo segundo como si fuera lo primero es mentirle al operador).

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { CAP_MEASUREMENT_FILE, type CapFlota } from "../node-daily-cap.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { handleSenderCapHttp } from "./sender-cap-read.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const TOKEN = "token-del-panel";
const ahora = new Date("2026-08-03T12:00:00.000Z");

function request(headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method: "GET", url: "/v1/sender-pool/cap", headers }) as unknown as IncomingMessage;
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

async function workspaceVacio(): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "cap-route-"));
  return new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
}

test("sin token: fail-closed, no sirve el estado de la flota", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderCapHttp({
    request: request(),
    response: response as unknown as ServerResponse,
    workspace: await workspaceVacio(),
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  assert.equal(response.statusCode, 401);
  assert.ok(!response.body.includes("nodos"));
});

test("con el borde sin configurar: 503, nunca abierto por defecto", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderCapHttp({
    request: request(),
    response: response as unknown as ServerResponse,
    workspace: await workspaceVacio(),
    now: () => ahora
  });
  assert.equal(response.statusCode, 503);
});

test("nunca corrido: 200 con medidoEn null (la pantalla lo declara)", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderCapHttp({
    request: request({ "x-delivrix-token": TOKEN }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceVacio(),
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as CapFlota;
  assert.equal(payload.medidoEn, null);
  assert.deepEqual(payload.nodos, []);
});

test("sirve la lectura persistida", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const ws = await workspaceVacio();
  const flota: CapFlota = {
    medidoEn: ahora.toISOString(),
    ilegibles: 0,
    omitidos: 2,
    nodos: [{ domain: "a.com", serverSlug: "n1", cap: 2000, consumidoHoy: 2000, cableado: true, motivo: null }]
  };
  await ws.updateInventoryJson(CAP_MEASUREMENT_FILE, () => flota);

  const response = captureResponse();
  await handleSenderCapHttp({
    request: request({ "x-delivrix-token": TOKEN }),
    response: response as unknown as ServerResponse,
    workspace: ws,
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as CapFlota;
  assert.equal(payload.nodos.length, 1);
  assert.equal(payload.omitidos, 2, "los que nadie capa se declaran");
});

test("un JSON con forma inesperada se DECLARA ilegible, no se sirve como 'nunca se corrió'", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const ws = await workspaceVacio();
  // Forma válida como JSON pero sin `nodos`: sin la guarda, el panel hacía [...data.nodos] y
  // reventaba en render, llevándose puesta la pestaña entera.
  await ws.updateInventoryJson(CAP_MEASUREMENT_FILE, () => ({ medidoEn: ahora.toISOString() }) as unknown as CapFlota);

  const response = captureResponse();
  await handleSenderCapHttp({
    request: request({ "x-delivrix-token": TOKEN }),
    response: response as unknown as ServerResponse,
    workspace: ws,
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as CapFlota & { ilegible?: string };
  assert.deepEqual(payload.nodos, []);
  assert.match(payload.ilegible ?? "", /forma esperada/);
});
