import {
  AwsRoute53DnsAdapter,
  type AwsRoute53DnsRecordInput,
  type AwsRoute53DnsRecordType
} from "./aws-route53-dns-adapter.ts";
import {
  IonosDnsActuator,
  type IonosDnsRecordSnapshot,
  type IonosDnsRecordWriteInput
} from "./ionos-dns-actuator.ts";

export type DnsRecordType = "A" | "MX" | "TXT" | "CNAME";

export interface DnsRecordSpec {
  name: string;
  type: DnsRecordType;
  ttl?: number;
  values: string[];
  prio?: number;
}

export interface DnsZoneResult {
  zoneId: string;
  nameServers: string[];
}

export interface DnsUpsertResult {
  changeIds: string[];
  idempotent?: boolean;
}

export interface DnsProvider {
  readonly providerId: string;
  isLive(): boolean;
  isWriteEnabled(): boolean;
  ensureZone(domainOrZoneName: string): Promise<DnsZoneResult>;
  upsertRecords(zoneId: string, records: DnsRecordSpec[]): Promise<DnsUpsertResult>;
  listRecords(zoneId: string): Promise<DnsRecordSpec[]>;
}

export interface DnsProviderEntry {
  id: string;
  label: string;
  adapter: DnsProvider;
}

export interface Route53DnsProviderOptions {
  adapter?: AwsRoute53DnsAdapter;
  env?: Record<string, string | undefined>;
}

export interface IonosDnsProviderOptions {
  adapter?: IonosDnsActuator;
  env?: Record<string, string | undefined>;
}

const defaultTtl = 300;

export class Route53DnsProvider implements DnsProvider {
  readonly providerId = "route53";
  private readonly adapter: AwsRoute53DnsAdapter;

  constructor(adapter: AwsRoute53DnsAdapter) {
    this.adapter = adapter;
  }

  isLive(): boolean {
    return this.adapter.isLive();
  }

  isWriteEnabled(): boolean {
    return this.adapter.isWriteEnabled();
  }

  async ensureZone(domainOrZoneName: string): Promise<DnsZoneResult> {
    return this.adapter.createHostedZone(domainOrZoneName);
  }

  async upsertRecords(zoneId: string, records: DnsRecordSpec[]): Promise<DnsUpsertResult> {
    const changeIds: string[] = [];
    for (const record of records) {
      const result = await this.adapter.upsertRecord(zoneId, route53RecordInput(record));
      changeIds.push(result.changeId);
    }
    return { changeIds };
  }

  async listRecords(zoneId: string): Promise<DnsRecordSpec[]> {
    const records = await this.adapter.listResourceRecordSets(zoneId);
    return records
      .filter((record): record is typeof record & { type: DnsRecordType } => isDnsRecordType(record.type))
      .map((record) => ({
        name: record.name,
        type: record.type,
        ttl: record.ttl,
        values: record.values
      }));
  }
}

export class IonosDnsProvider implements DnsProvider {
  readonly providerId = "ionos";
  private readonly adapter: IonosDnsActuator;

  constructor(adapter: IonosDnsActuator) {
    this.adapter = adapter;
  }

  isLive(): boolean {
    return this.adapter.isLive();
  }

  isWriteEnabled(): boolean {
    return this.adapter.isWriteEnabled();
  }

  async ensureZone(domainOrZoneName: string): Promise<DnsZoneResult> {
    const result = await this.adapter.createZone(domainOrZoneName);
    return {
      zoneId: result.zoneId,
      nameServers: result.nameservers
    };
  }

  async upsertRecords(zoneId: string, records: DnsRecordSpec[]): Promise<DnsUpsertResult> {
    const result = await this.adapter.upsertRecords(zoneId, records.map(ionosRecordInput));
    return {
      changeIds: result.rrsetIds,
      idempotent: result.idempotent
    };
  }

  async listRecords(zoneId: string): Promise<DnsRecordSpec[]> {
    const records = await this.adapter.listRecords(zoneId);
    return records
      .filter((record): record is IonosDnsRecordSnapshot & { type: DnsRecordType; content: string } =>
        isDnsRecordType(record.type) && typeof record.content === "string" && record.content.length > 0
      )
      .map((record) => ({
        name: record.name,
        type: record.type,
        ...(typeof record.ttl === "number" ? { ttl: record.ttl } : {}),
        values: [record.content],
        ...(typeof record.prio === "number" ? { prio: record.prio } : {})
      }));
  }
}

export function createRoute53DnsProviderFromEnv(
  env: Record<string, string | undefined> = defaultEnv(),
  options: Route53DnsProviderOptions = {}
): DnsProviderEntry[] {
  const provider = new Route53DnsProvider(options.adapter ?? new AwsRoute53DnsAdapter({ env }));
  if (!provider.isLive()) {
    return [];
  }
  return [{
    id: provider.providerId,
    label: "AWS Route53",
    adapter: provider
  }];
}

export function createIonosDnsProviderFromEnv(
  env: Record<string, string | undefined> = defaultEnv(),
  options: IonosDnsProviderOptions = {}
): DnsProviderEntry[] {
  const provider = new IonosDnsProvider(options.adapter ?? new IonosDnsActuator({ env }));
  if (!provider.isLive()) {
    return [];
  }
  return [{
    id: provider.providerId,
    label: "IONOS DNS",
    adapter: provider
  }];
}

function route53RecordInput(record: DnsRecordSpec): AwsRoute53DnsRecordInput {
  return {
    name: record.name,
    type: record.type as AwsRoute53DnsRecordType,
    ttl: record.ttl ?? defaultTtl,
    values: route53Values(record)
  };
}

function route53Values(record: DnsRecordSpec): string[] {
  if (record.type !== "MX" || typeof record.prio !== "number") {
    return record.values;
  }
  return record.values.map((value) => /^\d+\s+/.test(value) ? value : `${record.prio} ${value}`);
}

function ionosRecordInput(record: DnsRecordSpec): IonosDnsRecordWriteInput {
  const content = record.values[0];
  if (!content) {
    throw new Error(`DNS record ${record.name} ${record.type} must include at least one value.`);
  }
  return {
    name: record.name,
    type: record.type,
    content,
    ...(typeof record.ttl === "number" ? { ttl: record.ttl } : {}),
    ...(typeof record.prio === "number" ? { prio: record.prio } : {})
  };
}

function isDnsRecordType(value: string): value is DnsRecordType {
  return value === "A" || value === "MX" || value === "TXT" || value === "CNAME";
}

function defaultEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" ? process.env : {};
}
