import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type { PgClient } from "../../../warmup-engine/src/store/pg-stores.ts";
import {
  handleWarmupMailboxOnboard,
  handleWarmupMailboxesWarm,
  handleWarmupMailboxGet,
  handleWarmupMailboxesHealth,
  handleWarmupMailboxesList,
  handleWarmupMailboxEvents,
  type WarmupMailboxesDeps
} from "./warmup-mailboxes.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const API_KEY = "warmup-secret-key";

// ── Fake PgClient: filas canned en orden. Ninguna DB real. ────────────────────────────────────────
function fakePgClient(responses: Array<{ rows: any[]; rowCount: number | null }> = []): PgClient {
  let idx = 0;
  return {
    async query<T = any>(_text: string, _params?: readonly unknown[]) {
      const r = responses[idx] ?? { rows: [], rowCount: 0 };
      idx += 1;
      return r as { rows: T[]; rowCount: number | null };
    }
  };
}

function getRequest(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method: "GET", url, headers } as unknown as IncomingMessage;
}

function postRequest(url: string, body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...headers }
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
    },
    json(): any {
      return JSON.parse(this.body);
    }
  };
}

function baseDeps(overrides: Partial<WarmupMailboxesDeps> = {}): WarmupMailboxesDeps {
  return {
    pgClient: fakePgClient(),
    warmupApiKey: API_KEY,
    now: () => new Date("2026-07-13T00:00:00Z"),
    ...overrides
  };
}

test.beforeEach(() => resetSensitiveReadAuthBucketsForTests());

// ================== Auth ==================

test("auth: sin x-warmup-api-key ⇒ 401 cuando WARMUP_API_KEY está seteada", async () => {
  const response = captureResponse();
  await handleWarmupMailboxesHealth(
    getRequest("/v1/warmup/mailboxes-health"),
    response as unknown as ServerResponse,
    baseDeps()
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "warmup_api_key_invalid");
});

test("auth: header correcto ⇒ pasa", async () => {
  const response = captureResponse();
  await handleWarmupMailboxesHealth(
    getRequest("/v1/warmup/mailboxes-health", { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: fakePgClient([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }]) })
  );
  assert.equal(response.statusCode, 200);
});

test("auth: sin WARMUP_API_KEY ⇒ fallback read-boundary (token válido pasa)", async () => {
  const response = captureResponse();
  await handleWarmupMailboxesHealth(
    getRequest("/v1/warmup/mailboxes-health", { "x-delivrix-token": "rb-token" }),
    response as unknown as ServerResponse,
    baseDeps({
      warmupApiKey: undefined,
      readBoundaryToken: "rb-token",
      pgClient: fakePgClient([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }])
    })
  );
  assert.equal(response.statusCode, 200);
});

// ================== Onboard ==================

test("onboard: body válido ⇒ 201 created con mailbox", async () => {
  const response = captureResponse();
  const pg = fakePgClient([
    { rows: [], rowCount: 1 },
    {
      rows: [
        {
          id: "m1",
          mailbox: "new@delivrix.io",
          domain: "delivrix.io",
          infra_type: "postfix",
          state: "blocked",
          auth_ready: false,
          contract_expires_at: null,
          sending_ip: null,
          helo_fqdn: null,
          daily_limit: 10,
          increase_by_day: 1,
          day_index: 0,
          weekdays_only: false,
          health_score: null,
          placement_score: null,
          created_at: new Date("2026-07-13T00:00:00Z"),
          updated_at: new Date("2026-07-13T00:00:00Z")
        }
      ],
      rowCount: 1
    }
  ]);
  await handleWarmupMailboxOnboard(
    postRequest("/v1/mailboxes:onboard", { email: "new@delivrix.io" }, { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: pg })
  );
  assert.equal(response.statusCode, 201);
  const payload = response.json();
  assert.equal(payload.created, true);
  assert.equal(payload.source, "handoff");
  assert.equal(payload.mailbox.email, "new@delivrix.io");
  assert.equal(payload.mailbox.state, "blocked");
  assert.equal(payload.mailbox.smtpRef, "vault:warmup/smtp/m1");
});

test("onboard: email inválido ⇒ 422", async () => {
  const response = captureResponse();
  await handleWarmupMailboxOnboard(
    postRequest("/v1/mailboxes:onboard", { email: "no-arroba" }, { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps()
  );
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error, "email_required");
});

test("onboard: escritura fail-closed ⇒ 503 sin WARMUP_API_KEY (nunca cae al read-boundary)", async () => {
  const response = captureResponse();
  await handleWarmupMailboxOnboard(
    // Aunque venga un token de read-boundary válido, la ESCRITURA no debe autorizarse sin la llave dedicada.
    postRequest("/v1/mailboxes:onboard", { email: "x@y.io" }, { "x-delivrix-token": "rb-token" }),
    response as unknown as ServerResponse,
    baseDeps({ warmupApiKey: undefined, readBoundaryToken: "rb-token" })
  );
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, "warmup_api_key_not_configured");
});

test("onboard: pgClient null ⇒ 503", async () => {
  const response = captureResponse();
  await handleWarmupMailboxOnboard(
    postRequest("/v1/mailboxes:onboard", { email: "x@y.io" }, { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: null })
  );
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, "warmup_db_unavailable");
});

// ================== /warm ==================

test("warm: entrega sólo buzones WARM del store; placementMin con piso 0.80", async () => {
  const response = captureResponse();
  const pg = fakePgClient([
    {
      rows: [
        {
          id: "m1",
          mailbox: "warm@delivrix.io",
          domain: "delivrix.io",
          placement_score: "0.93",
          updated_at: new Date("2026-07-12T00:00:00Z")
        }
      ],
      rowCount: 1
    }
  ]);
  // placementMin 0.5 debe subir a 0.80 (piso duro)
  await handleWarmupMailboxesWarm(
    getRequest("/v1/mailboxes/warm", { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: pg, placementMin: 0.5 })
  );
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.placementMin, 0.8);
  assert.equal(payload.mailboxes.length, 1);
  assert.deepEqual(payload.mailboxes[0], {
    id: "m1",
    email: "warm@delivrix.io",
    domain: "delivrix.io",
    state: "warm",
    placementScore: 0.93,
    warmedAt: "2026-07-12T00:00:00.000Z",
    smtpRef: "vault:warmup/smtp/m1"
  });
});

test("warm: pgClient null ⇒ 200 degradado con note", async () => {
  const response = captureResponse();
  await handleWarmupMailboxesWarm(
    getRequest("/v1/mailboxes/warm", { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: null })
  );
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.deepEqual(payload.mailboxes, []);
  assert.equal(payload.note, "warmup_db_unavailable");
});

// ================== list / get / events / health ==================

test("list: aplica filtro state desde query", async () => {
  const response = captureResponse();
  const pg = fakePgClient([{ rows: [], rowCount: 0 }]);
  await handleWarmupMailboxesList(
    getRequest("/v1/mailboxes?state=warm&limit=10", { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: pg }),
    new URLSearchParams("state=warm&limit=10")
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().mailboxes, []);
});

test("get: mailbox inexistente ⇒ 404", async () => {
  const response = captureResponse();
  const pg = fakePgClient([{ rows: [], rowCount: 0 }]);
  await handleWarmupMailboxGet(
    getRequest("/v1/mailboxes/nope", { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: pg }),
    "nope"
  );
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "mailbox_not_found");
});

test("events: devuelve historial merge (send + signal)", async () => {
  const response = captureResponse();
  const pg = fakePgClient([
    {
      rows: [
        {
          id: "s1",
          to_address: "a@x.com",
          status: "sent",
          attempts: 1,
          last_error: null,
          created_at: new Date("2026-07-10T10:00:00Z"),
          sent_at: null
        }
      ],
      rowCount: 1
    },
    { rows: [], rowCount: 0 }
  ]);
  await handleWarmupMailboxEvents(
    getRequest("/v1/mailboxes/m1/events", { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: pg }),
    "m1",
    new URLSearchParams("")
  );
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.id, "m1");
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].kind, "send");
});

test("health: conteos del store", async () => {
  const response = captureResponse();
  const pg = fakePgClient([
    { rows: [{ state: "warm", n: 2 }], rowCount: 1 },
    { rows: [{ status: "queued", n: 3 }], rowCount: 1 }
  ]);
  await handleWarmupMailboxesHealth(
    getRequest("/v1/warmup/mailboxes-health", { "x-warmup-api-key": API_KEY }),
    response as unknown as ServerResponse,
    baseDeps({ pgClient: pg })
  );
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.totals.warm, 2);
  assert.equal(payload.totals.queuedSends, 3);
  assert.equal(payload.byState.warm, 2);
});
