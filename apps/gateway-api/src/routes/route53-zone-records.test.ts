import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import {
  handleReadRoute53ZoneRecords,
  route53ZoneRecordsClientConfigFromEnv
} from "./route53-zone-records.ts";

const fixedNow = new Date("2026-06-01T18:15:00.000Z");
const validZoneId = "Z03595092JW2AXJBZGN4E";

test("GET /v1/route53/zone-records normalizes NS, SOA, A, MX and TXT records", async () => {
  const auditEvents: Array<Record<string, unknown>> = [];
  const calls: unknown[] = [];
  const response = await route(`/v1/route53/zone-records?zoneId=${validZoneId}`, {
    client: mockClient({ ResourceRecordSets: sampleRecords(), IsTruncated: false }, calls),
    emitAudit: async (event) => {
      auditEvents.push(event);
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.zoneId, validZoneId);
  assert.equal(response.body.totalRecords, 5);
  assert.equal(response.body.isTruncated, false);
  assert.deepEqual(response.body.records.map((record: { type: string }) => record.type), ["NS", "SOA", "A", "MX", "TXT"]);
  assert.equal(response.body.records[0].values[0], "ns-1.awsdns-01.com.");
  assert.equal((calls[0] as { input: { HostedZoneId: string; MaxItems: number } }).input.HostedZoneId, validZoneId);
  assert.equal((calls[0] as { input: { HostedZoneId: string; MaxItems: number } }).input.MaxItems, 300);
  assert.deepEqual(auditEvents, [{
    type: "oc.route53.zone_records_read",
    zoneId: validZoneId,
    recordCount: 5,
    isTruncated: false,
    timestamp: fixedNow.toISOString()
  }]);
});

test("GET /v1/route53/zone-records filters recordType=A", async () => {
  const response = await route(`/v1/route53/zone-records?zoneId=${validZoneId}&recordType=A`, {
    client: mockClient({ ResourceRecordSets: sampleRecords(), IsTruncated: false })
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.records.map((record: { type: string }) => record.type), ["A"]);
});

test("GET /v1/route53/zone-records filters recordName=smtp.controldelivrix.app", async () => {
  const response = await route(`/v1/route53/zone-records?zoneId=${validZoneId}&recordName=smtp.controldelivrix.app`, {
    client: mockClient({
      ResourceRecordSets: [
        ...sampleRecords(),
        { Name: "smtp.controldelivrix.app.", Type: "A", TTL: 300, ResourceRecords: [{ Value: "45.136.70.47" }] }
      ],
      IsTruncated: false
    })
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.records, [{
    name: "smtp.controldelivrix.app.",
    type: "A",
    ttl: 300,
    values: ["45.136.70.47"]
  }]);
});

test("GET /v1/route53/zone-records preserves Route53 truncation state", async () => {
  const response = await route(`/v1/route53/zone-records?zoneId=${validZoneId}`, {
    client: mockClient({ ResourceRecordSets: sampleRecords(), IsTruncated: true })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.isTruncated, true);
});

test("GET /v1/route53/zone-records rejects invalid zone id", async () => {
  const response = await route("/v1/route53/zone-records?zoneId=bad-zone");

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_zone_id");
});

test("GET /v1/route53/zone-records rejects unsupported record type", async () => {
  const response = await route(`/v1/route53/zone-records?zoneId=${validZoneId}&recordType=SPF`);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_record_type");
});

test("GET /v1/route53/zone-records maps NoSuchHostedZone to 404", async () => {
  const error = new Error("NoSuchHostedZone: hosted zone does not exist");
  error.name = "NoSuchHostedZone";
  const response = await route(`/v1/route53/zone-records?zoneId=${validZoneId}`, {
    client: mockClient(error)
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "hosted_zone_not_found");
});

test("GET /v1/route53/zone-records maps other AWS errors to 502", async () => {
  const response = await route(`/v1/route53/zone-records?zoneId=${validZoneId}`, {
    client: mockClient(new Error("route53 unavailable"))
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "route53_zone_read_failed");
  assert.equal(response.body.message, "route53 unavailable");
  assert.equal(response.body.zoneId, validZoneId);
});

test("route53ZoneRecordsClientConfigFromEnv uses Route53 DNS credentials", () => {
  const config = route53ZoneRecordsClientConfigFromEnv({
    AWS_ROUTE53_DNS_ACCESS_KEY_ID: "dns-access",
    AWS_ROUTE53_DNS_SECRET_ACCESS_KEY: "dns-secret",
    AWS_ROUTE53_DNS_SESSION_TOKEN: "dns-session",
    AWS_ROUTE53_DNS_REGION: "us-east-1"
  });

  assert.deepEqual(config, {
    region: "us-east-1",
    credentials: {
      accessKeyId: "dns-access",
      secretAccessKey: "dns-secret",
      sessionToken: "dns-session"
    }
  });
});

test("route53ZoneRecordsClientConfigFromEnv falls back to shared Route53 credentials", () => {
  const config = route53ZoneRecordsClientConfigFromEnv({
    AWS_ROUTE53_ACCESS_KEY_ID: "route53-access",
    AWS_ROUTE53_SECRET_ACCESS_KEY: "route53-secret",
    AWS_ROUTE53_REGION: "us-east-2"
  });

  assert.deepEqual(config, {
    region: "us-east-2",
    credentials: {
      accessKeyId: "route53-access",
      secretAccessKey: "route53-secret"
    }
  });
});

async function route(
  url: string,
  deps: {
    client?: { send(command: unknown): Promise<unknown> };
    emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
  } = {}
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  await handleReadRoute53ZoneRecords(
    request(url),
    response as unknown as ServerResponse,
    {
      client: deps.client as any,
      emitAudit: deps.emitAudit,
      now: () => fixedNow
    }
  );
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

function mockClient(output: unknown, calls: unknown[] = []): { send(command: unknown): Promise<unknown> } {
  return {
    async send(command: unknown): Promise<unknown> {
      calls.push(command);
      if (output instanceof Error) {
        throw output;
      }
      return output;
    }
  };
}

function sampleRecords(): unknown[] {
  return [
    {
      Name: "controldelivrix.app.",
      Type: "NS",
      TTL: 172800,
      ResourceRecords: [{ Value: "ns-1.awsdns-01.com." }, { Value: "ns-2.awsdns-02.net." }]
    },
    {
      Name: "controldelivrix.app.",
      Type: "SOA",
      TTL: 900,
      ResourceRecords: [{ Value: "ns-1.awsdns-01.com. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400" }]
    },
    {
      Name: "controldelivrix.app.",
      Type: "A",
      TTL: 300,
      ResourceRecords: [{ Value: "45.136.70.47" }]
    },
    {
      Name: "controldelivrix.app.",
      Type: "MX",
      TTL: 300,
      ResourceRecords: [{ Value: "10 smtp.controldelivrix.app." }]
    },
    {
      Name: "controldelivrix.app.",
      Type: "TXT",
      TTL: 300,
      ResourceRecords: [{ Value: "\"v=spf1 ip4:45.136.70.47 -all\"" }]
    }
  ];
}

function request(url: string): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, {
    method: "GET",
    url,
    headers: {}
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
