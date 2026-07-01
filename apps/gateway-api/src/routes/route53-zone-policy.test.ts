import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AwsRoute53HostedZoneResult,
  AwsRoute53HostedZoneSummary,
  AwsRoute53ResourceRecordSet
} from "../../../../packages/adapters/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  resolveRoute53HostedZone,
  Route53ZonePolicyError,
  type Route53ZonePolicyAdapter
} from "./route53-zone-policy.ts";

test("resolveRoute53HostedZone rejects stale preferredZoneId when registrar NS points to another duplicate zone", async () => {
  const workspace = await makeWorkspace();
  const adapter = new FakePolicyAdapter({
    zones: duplicateZones(),
    recordsByZone: {}
  });

  await assert.rejects(
    () => resolveRoute53HostedZone({
      workspace,
      adapter,
      domain: "controlcorpfiling.com",
      mode: "reuse-only",
      preferredZoneId: "ZSTALE123456",
      getDomainNameservers: async () => ["ns-real-1.awsdns-11.com", "ns-real-2.awsdns-12.net"]
    }),
    (error) => error instanceof Route53ZonePolicyError &&
      error.code === "zone_not_authoritative_nameservers_mismatch" &&
      error.details.authoritativeZoneId === "Z01313019Q8DEA3UGP8G"
  );
});

test("resolveRoute53HostedZone fails closed when registrar NS do not match any duplicate zone", async () => {
  const workspace = await makeWorkspace();
  const adapter = new FakePolicyAdapter({
    zones: duplicateZones(),
    recordsByZone: {
      ZSTALE123456: [
        { name: "smtp.controlcorpfiling.com.", type: "A", ttl: 300, values: ["193.180.211.182"] },
        { name: "controlcorpfiling.com.", type: "MX", ttl: 300, values: ["10 smtp.controlcorpfiling.com."] }
      ]
    }
  });

  await assert.rejects(
    () => resolveRoute53HostedZone({
      workspace,
      adapter,
      domain: "controlcorpfiling.com",
      mode: "reuse-only",
      getDomainNameservers: async () => ["ns-external-1.example.net", "ns-external-2.example.net"]
    }),
    (error) => error instanceof Route53ZonePolicyError &&
      error.code === "zone_not_authoritative_nameservers_mismatch"
  );
});

test("resolveRoute53HostedZone falls back to SMTP setup when registrar NS are empty", async () => {
  const workspace = await makeWorkspace();
  const adapter = new FakePolicyAdapter({
    zones: duplicateZones(),
    recordsByZone: {
      Z01313019Q8DEA3UGP8G: [
        { name: "smtp.controlcorpfiling.com.", type: "A", ttl: 300, values: ["193.180.211.182"] },
        { name: "controlcorpfiling.com.", type: "MX", ttl: 300, values: ["10 smtp.controlcorpfiling.com."] }
      ]
    }
  });

  const result = await resolveRoute53HostedZone({
    workspace,
    adapter,
    domain: "controlcorpfiling.com",
    mode: "reuse-only",
    getDomainNameservers: async () => []
  });

  assert.equal(result.zone.zoneId, "Z01313019Q8DEA3UGP8G");
  assert.equal(result.source, "aws-disambiguated");
  assert.equal(result.smtpSetup, "canonical");
});

async function makeWorkspace(): Promise<OpenClawWorkspace> {
  return new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "route53-zone-policy-")),
    now: () => new Date("2026-07-01T12:00:00.000Z")
  });
}

function duplicateZones(): AwsRoute53HostedZoneSummary[] {
  return [
    {
      zoneId: "ZSTALE123456",
      name: "controlcorpfiling.com.",
      nameServers: ["ns-stale-1.awsdns-01.com", "ns-stale-2.awsdns-02.net"]
    },
    {
      zoneId: "Z01313019Q8DEA3UGP8G",
      name: "controlcorpfiling.com.",
      nameServers: ["ns-real-1.awsdns-11.com", "ns-real-2.awsdns-12.net"]
    }
  ];
}

class FakePolicyAdapter implements Route53ZonePolicyAdapter {
  private readonly zones: AwsRoute53HostedZoneSummary[];
  private readonly recordsByZone: Record<string, AwsRoute53ResourceRecordSet[]>;

  constructor(input: {
    zones: AwsRoute53HostedZoneSummary[];
    recordsByZone: Record<string, AwsRoute53ResourceRecordSet[]>;
  }) {
    this.zones = input.zones;
    this.recordsByZone = input.recordsByZone;
  }

  async createHostedZone(): Promise<AwsRoute53HostedZoneResult> {
    throw new Error("unexpected createHostedZone");
  }

  async listHostedZones(): Promise<AwsRoute53HostedZoneSummary[]> {
    return this.zones;
  }

  async listHostedZonesByName(): Promise<AwsRoute53HostedZoneSummary[]> {
    return this.zones;
  }

  async listResourceRecordSets(zoneId: string): Promise<AwsRoute53ResourceRecordSet[]> {
    return this.recordsByZone[zoneId] ?? [];
  }
}
