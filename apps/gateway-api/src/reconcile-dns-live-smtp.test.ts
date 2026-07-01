import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AwsRoute53DnsChangeResult,
  AwsRoute53DnsRecordInput,
  AwsRoute53DnsSource,
  AwsRoute53HostedZoneResult,
  AwsRoute53HostedZoneSummary,
  AwsRoute53ResourceRecordSet
} from "../../../packages/adapters/src/index.ts";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import type { Route53DnsAdapter } from "./routes/domains-dns.ts";
import { reconcileDnsToLiveSmtp } from "./reconcile-dns-live-smtp.ts";
import type { SmtpProvisioningInventory } from "./smtp-inventory-management.ts";

const fixedNow = new Date("2026-07-01T12:00:00.000Z");

test("reconcileDnsToLiveSmtp plans a dry-run against the authoritative duplicate Route53 zone", async () => {
  const workspace = await workspaceWithInventory();
  const adapter = new FakeRoute53DnsAdapter({
    zones: [
      {
        zoneId: "ZSTALE123456",
        name: "controlcorpfiling.com.",
        nameServers: ["ns-stale-1.awsdns-01.com", "ns-stale-2.awsdns-02.net"]
      },
      {
        zoneId: "Z01313019Q8DEA3UGP8G",
        name: "controlcorpfiling.com.",
        nameServers: ["ns-real-1.awsdns-11.com.", "ns-real-2.awsdns-12.net."]
      }
    ],
    recordsByZone: {
      Z01313019Q8DEA3UGP8G: [
        ns("controlcorpfiling.com", ["ns-real-1.awsdns-11.com.", "ns-real-2.awsdns-12.net."]),
        txt("s2026a._domainkey.controlcorpfiling.com", "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A")
      ]
    },
    writeEnabled: true
  });
  const auditEvents: unknown[] = [];
  const result = await reconcileDnsToLiveSmtp({
    workspace,
    route53DnsAdapter: adapter,
    auditLog: { append: async (event) => { auditEvents.push(event); } },
    liveServers: [{ serverSlug: "server60", ipv4: "193.180.211.182", status: "running", accountId: "quinary" }],
    domain: "controlcorpfiling.com",
    serverSlug: "server60",
    actorId: "openclaw",
    dryRun: true,
    getDomainNameservers: async () => ["ns-real-2.awsdns-12.net", "ns-real-1.awsdns-11.com"],
    now: () => fixedNow
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.zoneId, "Z01313019Q8DEA3UGP8G");
  assert.equal(result.plan.zoneResolution?.source, "aws-authoritative-ns");
  assert.deepEqual(result.plan.desiredRecords, [
    { name: "smtp.controlcorpfiling.com", type: "A", ttl: 300, values: ["193.180.211.182"] },
    { name: "controlcorpfiling.com", type: "TXT", ttl: 300, values: ["v=spf1 ip4:193.180.211.182 -all"] },
    { name: "controlcorpfiling.com", type: "MX", ttl: 300, values: ["10 smtp.controlcorpfiling.com."] }
  ]);
  assert.equal(adapter.upserts.length, 0);
  assert.equal(auditEvents.length, 1);
});

test("reconcileDnsToLiveSmtp blocks DNS writes when DKIM selector is missing", async () => {
  const workspace = await workspaceWithInventory();
  const adapter = new FakeRoute53DnsAdapter({
    zones: [{
      zoneId: "Z01313019Q8DEA3UGP8G",
      name: "controlcorpfiling.com.",
      nameServers: ["ns-real-1.awsdns-11.com.", "ns-real-2.awsdns-12.net."]
    }],
    recordsByZone: {
      Z01313019Q8DEA3UGP8G: [ns("controlcorpfiling.com", ["ns-real-1.awsdns-11.com.", "ns-real-2.awsdns-12.net."])]
    },
    writeEnabled: true
  });

  const result = await reconcileDnsToLiveSmtp({
    workspace,
    route53DnsAdapter: adapter,
    auditLog: { append: async () => undefined },
    liveServers: [{ serverSlug: "server60", ipv4: "193.180.211.182", status: "running" }],
    domain: "controlcorpfiling.com",
    serverSlug: "server60",
    actorId: "openclaw",
    dryRun: false,
    getDomainNameservers: async () => ["ns-real-1.awsdns-11.com", "ns-real-2.awsdns-12.net"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "dkim_regenerate_required");
  assert.deepEqual(result.plan.blockers, ["dkim_record_missing"]);
  assert.equal(adapter.upserts.length, 0);
});

test("reconcileDnsToLiveSmtp refuses to repoint DNS to a stopped live server", async () => {
  const workspace = await workspaceWithInventory();
  const adapter = new FakeRoute53DnsAdapter({ zones: [], recordsByZone: {}, writeEnabled: true });

  const result = await reconcileDnsToLiveSmtp({
    workspace,
    route53DnsAdapter: adapter,
    auditLog: { append: async () => undefined },
    liveServers: [{ serverSlug: "server60", ipv4: "193.180.211.182", status: "stopped" }],
    domain: "controlcorpfiling.com",
    serverSlug: "server60",
    actorId: "openclaw",
    dryRun: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "live_server_not_running");
  assert.equal(adapter.listHostedZonesByNameCalls.length, 0);
  assert.equal(adapter.upserts.length, 0);
});

async function workspaceWithInventory(): Promise<OpenClawWorkspace> {
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "reconcile-dns-live-smtp-")),
    now: () => fixedNow
  });
  await workspace.updateInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json", () => ({
    servers: [{
      domain: "controlcorpfiling.com",
      serverSlug: "server60",
      serverIp: "193.180.211.182",
      selector: "s2026a",
      status: "configured"
    }]
  }));
  return workspace;
}

function ns(domain: string, values: string[]): AwsRoute53ResourceRecordSet {
  return {
    name: `${domain}.`,
    type: "NS",
    ttl: 172800,
    values
  };
}

function txt(name: string, value: string): AwsRoute53ResourceRecordSet {
  return {
    name: `${name}.`,
    type: "TXT",
    ttl: 300,
    values: [value]
  };
}

class FakeRoute53DnsAdapter implements Route53DnsAdapter {
  readonly upserts: Array<{ zoneId: string; record: AwsRoute53DnsRecordInput }> = [];
  readonly listHostedZonesByNameCalls: string[] = [];
  private readonly zones: AwsRoute53HostedZoneSummary[];
  private readonly recordsByZone: Record<string, AwsRoute53ResourceRecordSet[]>;
  private readonly writeEnabled: boolean;

  constructor(input: {
    zones: AwsRoute53HostedZoneSummary[];
    recordsByZone: Record<string, AwsRoute53ResourceRecordSet[]>;
    writeEnabled: boolean;
  }) {
    this.zones = input.zones;
    this.recordsByZone = input.recordsByZone;
    this.writeEnabled = input.writeEnabled;
  }

  isLive(): boolean {
    return true;
  }

  isWriteEnabled(): boolean {
    return this.writeEnabled;
  }

  currentSource(): AwsRoute53DnsSource {
    return {
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53.amazonaws.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk: true,
      writeEnabled: this.writeEnabled
    };
  }

  async createHostedZone(): Promise<AwsRoute53HostedZoneResult> {
    throw new Error("unexpected createHostedZone");
  }

  async listHostedZones(): Promise<AwsRoute53HostedZoneSummary[]> {
    return this.zones;
  }

  async listHostedZonesByName(domain: string): Promise<AwsRoute53HostedZoneSummary[]> {
    this.listHostedZonesByNameCalls.push(domain);
    return this.zones;
  }

  async upsertRecord(zoneId: string, record: AwsRoute53DnsRecordInput): Promise<AwsRoute53DnsChangeResult> {
    this.upserts.push({ zoneId, record });
    return { changeId: `change-${this.upserts.length}` };
  }

  async listResourceRecordSets(zoneId: string): Promise<AwsRoute53ResourceRecordSet[]> {
    return this.recordsByZone[zoneId] ?? [];
  }
}
