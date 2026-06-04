import type {
  AwsRoute53DnsRecordInput,
  AwsRoute53DnsRecordType,
  AwsRoute53HostedZoneResult,
  AwsRoute53HostedZoneSummary,
  AwsRoute53ResourceRecordSet
} from "../../../../packages/adapters/src/index.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";

export interface Route53ZonePolicyAdapter {
  createHostedZone(domain: string): Promise<AwsRoute53HostedZoneResult>;
  listHostedZones(): Promise<AwsRoute53HostedZoneSummary[]>;
  listResourceRecordSets(zoneId: string): Promise<AwsRoute53ResourceRecordSet[]>;
}

export interface Route53ZonePolicyInventory {
  dnsZones?: Array<{
    domain: string;
    zoneId: string;
    nameServers?: string[];
    updatedAt?: string;
    records?: Array<{
      name: string;
      type: AwsRoute53DnsRecordType;
      ttl: number;
      values: string[];
      changeId?: string;
      updatedAt?: string;
    }>;
  }>;
}

export interface Route53ZoneResolution {
  zone: AwsRoute53HostedZoneResult;
  status: "created" | "reused";
  source: "aws-single" | "aws-disambiguated" | "workspace-verified" | "created";
  cleanupSuggested?: Array<{
    zoneId: string;
    name: string;
    reason: "duplicate_route53_hosted_zone";
  }>;
}

export type Route53ZoneResolveMode = "reuse-or-create" | "reuse-only";

export class Route53ZonePolicyError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}, statusCode = 409) {
    super(message);
    this.name = "Route53ZonePolicyError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

export async function resolveRoute53HostedZone(input: {
  workspace: OpenClawWorkspace;
  adapter: Route53ZonePolicyAdapter;
  domain: string;
  mode: Route53ZoneResolveMode;
  preferredZoneId?: string | null;
  now?: () => Date;
}): Promise<Route53ZoneResolution> {
  const domain = normalizeDomainName(input.domain);
  const allZones = await input.adapter.listHostedZones();
  const domainZones = uniqueZones(allZones.filter((zone) => normalizeZoneName(zone.name) === domain));
  const preferredZoneId = normalizeHostedZoneId(input.preferredZoneId ?? undefined);

  if (preferredZoneId) {
    const preferred = domainZones.find((zone) => normalizeHostedZoneId(zone.zoneId) === preferredZoneId);
    if (!preferred) {
      throw new Route53ZonePolicyError("zone_not_in_route53_account", "Preferred Route53 zone was not found in this AWS account for the requested domain.", {
        domain,
        preferredZoneId,
        matchingZoneIds: domainZones.map((zone) => zone.zoneId)
      });
    }
    const zone = await zoneResultWithNameservers(input.adapter, domain, preferred);
    await rememberRoute53Zone(input.workspace, {
      domain,
      zone,
      updatedAt: (input.now?.() ?? new Date()).toISOString()
    });
    return {
      zone,
      status: "reused",
      source: "aws-single",
      cleanupSuggested: duplicateCleanup(domainZones, preferred.zoneId)
    };
  }

  const workspaceZone = await findWorkspaceZone(input.workspace, domain);
  if (workspaceZone) {
    const verified = domainZones.find((zone) => normalizeHostedZoneId(zone.zoneId) === normalizeHostedZoneId(workspaceZone.zoneId));
    if (verified) {
      const zone = await zoneResultWithNameservers(input.adapter, domain, {
        ...verified,
        nameServers: verified.nameServers.length > 0 ? verified.nameServers : workspaceZone.nameServers
      });
      await rememberRoute53Zone(input.workspace, {
        domain,
        zone,
        updatedAt: (input.now?.() ?? new Date()).toISOString()
      });
      return {
        zone,
        status: "reused",
        source: "workspace-verified",
        cleanupSuggested: duplicateCleanup(domainZones, zone.zoneId)
      };
    }
  }

  if (domainZones.length === 0) {
    if (input.mode === "reuse-only") {
      throw new Route53ZonePolicyError("route53_zone_missing", "No Route53 hosted zone exists in this AWS account for the requested domain.", { domain });
    }
    const zone = await input.adapter.createHostedZone(domain);
    await rememberRoute53Zone(input.workspace, {
      domain,
      zone,
      updatedAt: (input.now?.() ?? new Date()).toISOString()
    });
    return {
      zone,
      status: "created",
      source: "created"
    };
  }

  if (domainZones.length === 1) {
    const zone = await zoneResultWithNameservers(input.adapter, domain, domainZones[0]);
    await rememberRoute53Zone(input.workspace, {
      domain,
      zone,
      updatedAt: (input.now?.() ?? new Date()).toISOString()
    });
    return {
      zone,
      status: "reused",
      source: "aws-single"
    };
  }

  const candidates = await Promise.all(domainZones.map(async (zone) => {
    const records = await input.adapter.listResourceRecordSets(zone.zoneId);
    return {
      zone,
      hasApexMailRecords: hasApexMailRecords(records, domain),
      recordCount: records.length
    };
  }));
  const mailReady = candidates.filter((candidate) => candidate.hasApexMailRecords);
  if (mailReady.length === 1) {
    const selected = mailReady[0].zone;
    const zone = await zoneResultWithNameservers(input.adapter, domain, selected);
    await rememberRoute53Zone(input.workspace, {
      domain,
      zone,
      updatedAt: (input.now?.() ?? new Date()).toISOString()
    });
    return {
      zone,
      status: "reused",
      source: "aws-disambiguated",
      cleanupSuggested: duplicateCleanup(domainZones, zone.zoneId)
    };
  }

  throw new Route53ZonePolicyError("zone_ambiguous_manual_review", "Multiple Route53 hosted zones exist and cannot be safely disambiguated.", {
    domain,
    candidates: candidates.map((candidate) => ({
      zoneId: candidate.zone.zoneId,
      name: candidate.zone.name,
      hasApexMailRecords: candidate.hasApexMailRecords,
      recordCount: candidate.recordCount
    })),
    cleanupSuggested: duplicateCleanup(domainZones, null)
  });
}

export async function requireRoute53ZoneWithApexMailRecords(input: {
  adapter: Route53ZonePolicyAdapter;
  domain: string;
  zone: AwsRoute53HostedZoneResult;
}): Promise<AwsRoute53ResourceRecordSet[]> {
  const records = await input.adapter.listResourceRecordSets(input.zone.zoneId);
  if (!hasApexMailRecords(records, input.domain)) {
    throw new Route53ZonePolicyError("zone_missing_apex_a_mx", "Route53 destination zone is not safe for registrar realignment because A and MX records are not both present.", {
      domain: normalizeDomainName(input.domain),
      zoneId: input.zone.zoneId,
      recordTypes: records.map((record) => ({ name: record.name, type: record.type }))
    });
  }
  return records;
}

export async function rememberRoute53Zone(inputWorkspace: OpenClawWorkspace, input: {
  domain: string;
  zone: AwsRoute53HostedZoneResult;
  updatedAt: string;
  records?: Array<AwsRoute53DnsRecordInput & { changeId?: string }>;
}): Promise<void> {
  const domain = normalizeDomainName(input.domain);
  await inputWorkspace.updateInventoryJson<Route53ZonePolicyInventory>("domains.json", (current) => {
    const existing = current?.dnsZones?.find((zone) => zone.domain === domain);
    const dnsZones = (current?.dnsZones ?? []).filter((zone) => zone.domain !== domain);
    dnsZones.push({
      domain,
      zoneId: input.zone.zoneId,
      nameServers: input.zone.nameServers,
      updatedAt: input.updatedAt,
      records: input.records
        ? input.records.map((record) => ({
            name: record.name,
            type: record.type,
            ttl: record.ttl,
            values: record.values,
            changeId: record.changeId,
            updatedAt: input.updatedAt
          }))
        : existing?.records ?? []
    });
    return {
      ...(current ?? {}),
      dnsZones
    };
  });
}

export function route53NameserversFromRecords(
  records: AwsRoute53ResourceRecordSet[],
  domain: string
): string[] {
  const apex = `${normalizeDomainName(domain)}.`;
  const ns = records.find((record) => record.type === "NS" && record.name.toLowerCase() === apex);
  return ns?.values.map(normalizeNameserver).filter(Boolean) ?? [];
}

export function normalizeRoute53Nameservers(values: string[]): string[] {
  return values.map(normalizeNameserver).filter(Boolean).sort();
}

function hasApexMailRecords(records: AwsRoute53ResourceRecordSet[], domain: string): boolean {
  const apex = `${normalizeDomainName(domain)}.`;
  const mail = `mail.${normalizeDomainName(domain)}.`;
  const hasMailA = records.some((record) => record.type === "A" && record.name.toLowerCase() === mail && record.values.length > 0);
  const hasMailMx = records.some((record) =>
    record.type === "MX" &&
    record.name.toLowerCase() === apex &&
    record.values.some((value) => normalizeMxValue(value) === `10 ${mail}`)
  );
  const hasApexA = records.some((record) => record.type === "A" && record.name.toLowerCase() === apex && record.values.length > 0);
  const hasApexMx = records.some((record) =>
    record.type === "MX" &&
    record.name.toLowerCase() === apex &&
    record.values.some((value) => normalizeMxValue(value) === `10 ${apex}`)
  );
  return (hasMailA && hasMailMx) || (hasApexA && hasApexMx);
}

async function zoneResultWithNameservers(
  adapter: Route53ZonePolicyAdapter,
  domain: string,
  zone: AwsRoute53HostedZoneSummary
): Promise<AwsRoute53HostedZoneResult> {
  if (zone.nameServers.length > 0) {
    return {
      zoneId: zone.zoneId,
      nameServers: zone.nameServers.map(normalizeNameserver).filter(Boolean)
    };
  }
  const records = await adapter.listResourceRecordSets(zone.zoneId);
  return {
    zoneId: zone.zoneId,
    nameServers: route53NameserversFromRecords(records, domain)
  };
}

async function findWorkspaceZone(
  workspace: OpenClawWorkspace,
  domain: string
): Promise<AwsRoute53HostedZoneResult | null> {
  const inventory = await workspace.readInventoryJson<Route53ZonePolicyInventory>("domains.json").catch(() => null);
  const zone = inventory?.dnsZones?.find((entry) => entry.domain === domain);
  return zone ? { zoneId: zone.zoneId, nameServers: zone.nameServers ?? [] } : null;
}

function uniqueZones(zones: AwsRoute53HostedZoneSummary[]): AwsRoute53HostedZoneSummary[] {
  const byId = new Map<string, AwsRoute53HostedZoneSummary>();
  for (const zone of zones) {
    byId.set(zone.zoneId, zone);
  }
  return [...byId.values()];
}

function duplicateCleanup(zones: AwsRoute53HostedZoneSummary[], selectedZoneId: string | null) {
  return zones
    .filter((zone) => !selectedZoneId || normalizeHostedZoneId(zone.zoneId) !== normalizeHostedZoneId(selectedZoneId))
    .map((zone) => ({
      zoneId: zone.zoneId,
      name: zone.name,
      reason: "duplicate_route53_hosted_zone" as const
    }));
}

function normalizeZoneName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeNameserver(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeMxValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, ".");
}

function normalizeHostedZoneId(value: string | undefined): string | undefined {
  const normalized = value?.replace(/^\/hostedzone\//, "").trim().toUpperCase();
  return normalized && /^[A-Z0-9]+$/.test(normalized) ? normalized : undefined;
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new Route53ZonePolicyError("invalid_domain", `Invalid domain name: ${value}`, { value }, 422);
  }
  return normalized;
}
