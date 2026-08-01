// Tests de la ruta de alertas: auth fail-closed + que sirve el rollup desde JSON local.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { MEASUREMENT_FILE, type MedicionFlota } from "../sender-measurement.ts";
import { handleSenderAlertsHttp } from "./sender-alerts-read.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const TOKEN = "token-del-panel";
const ahora = new Date("2026-07-31T12:00:00.000Z");

function request(headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method: "GET", url: "/v1/sender-pool/alerts", headers }) as unknown as IncomingMessage;
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

async function workspaceConCruce(): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "alerts-route-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  await ws.updateInventoryJson("domains.json", () => ({
    bindings: [{ domain: "quemada.com", serverSlug: "n1", serverIp: "1.1.1.1" }]
  }));
  await ws.updateInventoryJson("smtp-credentials.json", () => ({
    smtpCredentials: [{ domain: "quemada.com", serverSlug: "n1", status: "configured", createdAt: "2026-07-10T00:00:00Z" }]
  }));
  const medicion: MedicionFlota = {
    medidoEn: ahora.toISOString(),
    duracionMs: 1,
    pedidas: 1,
    leidas: 1,
    bandejas: [
      { domain: "quemada.com", serverSlug: "n1", estado: "healthy", detalle: "ok", ventana: "24h", entregados: 50, rechazados: 0, diferidos: 0, cerradoEn: [], picos: [], cruzados: ["google"], cerca: [] }
    ]
  };
  await ws.updateInventoryJson(MEASUREMENT_FILE, () => medicion);
  return ws;
}

test("sin token, la ruta de alertas se rechaza (401)", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderAlertsHttp({
    request: request(),
    response: response as unknown as ServerResponse,
    workspace: await workspaceConCruce(),
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  assert.equal(response.statusCode, 401);
});

test("con token, sirve la alerta crítica del umbral cruzado desde JSON local", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderAlertsHttp({
    request: request({ "x-delivrix-token": TOKEN }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceConCruce(),
    readBoundaryToken: TOKEN,
    now: () => ahora
  });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.conteos.critical, 1);
  assert.equal(body.alerts[0].domain, "quemada.com");
  assert.equal(body.alerts[0].kind, "umbral_cruzado");
});
