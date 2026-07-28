import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  authorizeSensitiveRead,
  resetSensitiveReadAuthBucketsForTests,
  resolveReadBoundaryToken
} from "./sensitive-read-auth.ts";

test("authorizeSensitiveRead rate-limits an authenticated sensitive read", () => {
  resetSensitiveReadAuthBucketsForTests();
  const request = makeRequest({ "x-delivrix-token": "read-token" });
  const deps = {
    readBoundaryToken: "read-token",
    rateLimitPerMinute: 1,
    now: () => new Date("2026-06-02T12:00:00.000Z")
  };

  assert.deepEqual(authorizeSensitiveRead(request, deps, "route53_domain_detail"), { ok: true });
  assert.deepEqual(authorizeSensitiveRead(request, deps, "route53_domain_detail"), {
    ok: false,
    statusCode: 429,
    error: "read_boundary_rate_limited"
  });
});

function makeRequest(headers: Record<string, string>): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url: "/",
    headers,
    socket: { remoteAddress: "127.0.0.1" }
  }) as IncomingMessage;
}

// --- resolucion del token del borde de lectura -----------------------------
//
// Este borde entrega las credenciales SMTP de la flota entera. La cascada hacia los tokens de
// mutacion se mantiene para no dejar sin panel a un despliegue viejo, pero no puede ser silenciosa.

test("resolveReadBoundaryToken prefiere la variable dedicada y no avisa nada", () => {
  const out = resolveReadBoundaryToken({
    DELIVRIX_READ_BOUNDARY_TOKEN: "solo-lectura",
    DELIVRIX_OPENCLAW_TOKEN: "muta",
    OPENCLAW_GATEWAY_TOKEN: "muta-tambien"
  });

  assert.equal(out.token, "solo-lectura");
  assert.equal(out.source, "DELIVRIX_READ_BOUNDARY_TOKEN");
  assert.equal(out.sharesMutationToken, false);
  assert.equal(out.warning, undefined);
});

test("resolveReadBoundaryToken avisa cuando cae en cascada al token de mutaciones", () => {
  // El escenario real: alguien vacia la dedicada en una rotacion de secretos.
  const out = resolveReadBoundaryToken({
    DELIVRIX_READ_BOUNDARY_TOKEN: "   ",
    OPENCLAW_GATEWAY_TOKEN: "muta"
  });

  assert.equal(out.token, "muta");
  assert.equal(out.source, "OPENCLAW_GATEWAY_TOKEN");
  assert.equal(out.sharesMutationToken, true);
  assert.match(out.warning ?? "", /cascada/);
  assert.match(out.warning ?? "", /OPENCLAW_GATEWAY_TOKEN/);
});

test("resolveReadBoundaryToken tambien avisa si la dedicada repite el valor de la de mutaciones", () => {
  // La cascada no se dispara, pero el riesgo es identico: mismo secreto, dos permisos.
  const out = resolveReadBoundaryToken({
    DELIVRIX_READ_BOUNDARY_TOKEN: "el-mismo",
    OPENCLAW_GATEWAY_TOKEN: "el-mismo"
  });

  assert.equal(out.source, "DELIVRIX_READ_BOUNDARY_TOKEN");
  assert.equal(out.sharesMutationToken, true);
  assert.match(out.warning ?? "", /mismo valor/);
});

test("resolveReadBoundaryToken avisa cuando no hay ningun token configurado", () => {
  const out = resolveReadBoundaryToken({});

  assert.equal(out.token, undefined);
  assert.equal(out.sharesMutationToken, false);
  assert.match(out.warning ?? "", /503/);
});
