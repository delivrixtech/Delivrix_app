// Tests de la ruta de cuota.
//
// Lo que protegen: que la escritura sea fail-closed (la llave de lectura de NFC NO puede
// subirse su propia cuota) y que cada cambio quede en el audit log con antes/despues.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AuditEvent, AuditEventInput } from "../../../../packages/domain/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { handleSenderQuotaHttp, handleSenderQuotaUpdateHttp } from "./sender-quota.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const ahora = new Date("2026-07-31T12:00:00.000Z");
const TOKEN_OPERADOR = "token-del-emisor";
const LLAVE_NFC = "llave-de-nfc";
const TOKEN_LECTURA = "token-del-panel";

function request(input: {
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const stream = Readable.from(input.body === undefined ? [] : [JSON.stringify(input.body)]);
  return Object.assign(stream, {
    method: input.method,
    url: "/v1/sender-pool/quota",
    headers: input.headers ?? {}
  }) as unknown as IncomingMessage;
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

function auditCapture() {
  const events: AuditEventInput[] = [];
  return {
    events,
    async append(event: AuditEventInput): Promise<AuditEvent> {
      events.push(event);
      return event as AuditEvent;
    }
  };
}

async function workspaceMinimo(): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "cuota-ruta-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  await ws.updateInventoryJson("domains.json", () => ({
    bindings: [{ domain: "sana.com", serverSlug: "n1", serverIp: "1.1.1.1" }]
  }));
  await ws.updateInventoryJson("smtp-credentials.json", () => ({
    smtpCredentials: [{ domain: "sana.com", serverSlug: "n1", status: "configured" }]
  }));
  return ws;
}

test("la lectura acepta la llave de NFC sin el token del panel", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderQuotaHttp({
    request: request({ method: "GET", headers: { "x-sender-quota-key": LLAVE_NFC } }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceMinimo(),
    auditLog: auditCapture(),
    quotaApiKey: LLAVE_NFC,
    readBoundaryToken: TOKEN_LECTURA,
    now: () => ahora
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.medidoEn, null);
  assert.equal(payload.bandejas[0]?.domain, "sana.com");
});

test("sin llave ni token de lectura, la lectura se rechaza", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  await handleSenderQuotaHttp({
    request: request({ method: "GET" }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceMinimo(),
    auditLog: auditCapture(),
    quotaApiKey: LLAVE_NFC,
    readBoundaryToken: TOKEN_LECTURA,
    now: () => ahora
  });
  assert.equal(response.statusCode, 401);
});

test("la escritura es fail-closed: sin token del emisor configurado, 503", async () => {
  const response = captureResponse();
  await handleSenderQuotaUpdateHttp({
    request: request({ method: "PATCH", body: { hoyPuede: 100 } }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceMinimo(),
    auditLog: auditCapture(),
    domain: "sana.com",
    now: () => ahora
  });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error, "operator_token_not_configured");
});

test("la llave de lectura de NFC NO alcanza para escribir cuota", async () => {
  const response = captureResponse();
  await handleSenderQuotaUpdateHttp({
    request: request({
      method: "PATCH",
      headers: { "x-sender-quota-key": LLAVE_NFC },
      body: { hoyPuede: 4000 }
    }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceMinimo(),
    auditLog: auditCapture(),
    domain: "sana.com",
    quotaApiKey: LLAVE_NFC,
    operatorToken: TOKEN_OPERADOR,
    now: () => ahora
  });
  assert.equal(response.statusCode, 401, "quien consume la cuota no puede fijarsela");
});

test("un token de operador INCORRECTO se rechaza (safeEqual fallido, no solo header ausente)", async () => {
  const response = captureResponse();
  await handleSenderQuotaUpdateHttp({
    request: request({
      method: "PATCH",
      headers: { "x-openclaw-gateway-token": "token-equivocado" },
      body: { hoyPuede: 100 }
    }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceMinimo(),
    auditLog: auditCapture(),
    domain: "sana.com",
    operatorToken: TOKEN_OPERADOR,
    now: () => ahora
  });
  assert.equal(response.statusCode, 401, "un token presente pero incorrecto no alcanza");
});

test("una escritura valida persiste y deja el antes/despues en el audit log", async () => {
  const ws = await workspaceMinimo();
  const audit = auditCapture();
  const response = captureResponse();
  await handleSenderQuotaUpdateHttp({
    request: request({
      method: "PATCH",
      headers: { "x-openclaw-gateway-token": TOKEN_OPERADOR },
      body: { hoyPuede: 800 }
    }),
    response: response as unknown as ServerResponse,
    workspace: ws,
    auditLog: audit,
    domain: "sana.com",
    operatorToken: TOKEN_OPERADOR,
    now: () => ahora
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    domain: "sana.com",
    asignada: 800,
    antes: null,
    actualizadoEn: ahora.toISOString()
  });
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0]?.action, "senderpool.quota.updated");
  assert.equal(audit.events[0]?.riskLevel, "high");
  assert.deepEqual(audit.events[0]?.metadata, { antes: null, asignada: 800, techo: 2000 });
});

test("superar el techo se rechaza con el techo en la respuesta, y NO se audita", async () => {
  const audit = auditCapture();
  const response = captureResponse();
  await handleSenderQuotaUpdateHttp({
    request: request({
      method: "PATCH",
      headers: { "x-openclaw-gateway-token": TOKEN_OPERADOR },
      body: { hoyPuede: 3964 }
    }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceMinimo(),
    auditLog: audit,
    domain: "sana.com",
    operatorToken: TOKEN_OPERADOR,
    now: () => ahora
  });

  assert.equal(response.statusCode, 422);
  assert.deepEqual(JSON.parse(response.body), { error: "cuota_supera_techo", techo: 2000 });
  assert.equal(audit.events.length, 0, "lo rechazado no cambio estado: no hay evento");
});

test("un dominio fuera del inventario es 404, no una cuota fantasma", async () => {
  const response = captureResponse();
  await handleSenderQuotaUpdateHttp({
    request: request({
      method: "PATCH",
      headers: { "x-openclaw-gateway-token": TOKEN_OPERADOR },
      body: { hoyPuede: 100 }
    }),
    response: response as unknown as ServerResponse,
    workspace: await workspaceMinimo(),
    auditLog: auditCapture(),
    domain: "ajena.com",
    operatorToken: TOKEN_OPERADOR,
    now: () => ahora
  });
  assert.equal(response.statusCode, 404);
});
