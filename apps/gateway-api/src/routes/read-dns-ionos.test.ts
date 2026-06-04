import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type { IonosDnsInventoryResult } from "../../../../packages/adapters/src/index.ts";
import { handleReadIonosDns } from "./read-dns-ionos.ts";

const fixedNow = new Date("2026-06-04T12:00:00.000Z");
const readToken = "ionos-read-token";

test("GET /v1/dns/ionos/records resolves zone by domain and filters records", async () => {
  const auditEvents: Array<Record<string, unknown>> = [];
  const response = await route("/v1/dns/ionos/records?domain=mail.nationalcorphub.app&recordType=TXT", {
    emitAudit: async (event) => {
      auditEvents.push(event);
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.zoneId, "ionos-zone-1");
  assert.equal(response.body.zoneName, "nationalcorphub.app");
  assert.deepEqual(response.body.records, [{
    id: "rec-dmarc",
    zoneId: "ionos-zone-1",
    name: "_dmarc.nationalcorphub.app",
    type: "TXT",
    content: "v=DMARC1; p=quarantine",
    ttl: 300
  }]);
  assert.deepEqual(auditEvents, [{
    type: "oc.ionos.dns_records_read",
    zoneId: "ionos-zone-1",
    zoneName: "nationalcorphub.app",
    recordCount: 1,
    timestamp: fixedNow.toISOString()
  }]);
});

test("GET /v1/dns/ionos/records resolves zone by zoneId", async () => {
  const response = await route("/v1/dns/ionos/records?zoneId=ionos-zone-1&recordName=nationalcorphub.app");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.totalRecords, 1);
  assert.equal(response.body.records[0].name, "nationalcorphub.app");
  assert.equal(response.body.records[0].type, "A");
});

test("GET /v1/dns/ionos/records fails closed when read token is unconfigured", async () => {
  const response = await route("/v1/dns/ionos/records?domain=nationalcorphub.app", {
    readBoundaryToken: null
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "read_boundary_token_unconfigured");
});

test("GET /v1/dns/ionos/records rejects missing token", async () => {
  const response = await route("/v1/dns/ionos/records?domain=nationalcorphub.app", {
    headers: {}
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, "read_boundary_token_invalid");
});

test("GET /v1/dns/ionos/records requires domain or zoneId", async () => {
  const response = await route("/v1/dns/ionos/records");

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "domain_or_zone_id_required");
});

test("GET /v1/dns/ionos/records maps inventory failures to 502", async () => {
  const response = await route("/v1/dns/ionos/records?domain=nationalcorphub.app", {
    inventory: {
      zones: [],
      source: {
        kind: "live",
        apiKind: "cloud-dns",
        apiBase: "https://dns.de-fra.ionos.com",
        fetchedAt: fixedNow.toISOString(),
        responseOk: false,
        errorMessage: "IONOS unavailable"
      }
    }
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "ionos_dns_read_failed");
});

async function route(
  url: string,
  deps: {
    headers?: Record<string, string>;
    readBoundaryToken?: string | null;
    emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
    inventory?: IonosDnsInventoryResult;
  } = {}
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  await handleReadIonosDns(
    request(url, deps.headers ?? { "x-delivrix-token": readToken }),
    response as unknown as ServerResponse,
    {
      adapter: {
        async listInventory() {
          return deps.inventory ?? sampleInventory();
        }
      },
      emitAudit: deps.emitAudit,
      now: () => fixedNow,
      readBoundaryToken: deps.readBoundaryToken === null ? undefined : deps.readBoundaryToken ?? readToken
    }
  );
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

function sampleInventory(): IonosDnsInventoryResult {
  return {
    zones: [{
      id: "ionos-zone-1",
      name: "nationalcorphub.app",
      records: [
        {
          id: "rec-a",
          zoneId: "ionos-zone-1",
          name: "nationalcorphub.app",
          type: "A",
          content: "203.0.113.10",
          ttl: 300
        },
        {
          id: "rec-dmarc",
          zoneId: "ionos-zone-1",
          name: "_dmarc.nationalcorphub.app",
          type: "TXT",
          content: "v=DMARC1; p=quarantine",
          ttl: 300
        }
      ]
    }],
    source: {
      kind: "live",
      apiKind: "cloud-dns",
      apiBase: "https://dns.de-fra.ionos.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk: true
    }
  };
}

function request(url: string, headers: Record<string, string>): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url,
    headers
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
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
