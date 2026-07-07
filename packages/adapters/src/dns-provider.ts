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
import {
  NamecheapDomainsAdapter,
  createNamecheapAdaptersFromEnv,
  type NamecheapHostRecord
} from "./namecheap-domains-adapter.ts";

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
  /**
   * Returns the neutral DNS types supported by this seam only: A, MX, TXT and CNAME.
   * Provider-native records outside that set, such as NS/SOA/AAAA/SRV, are filtered
   * by design until a later stage widens the shared contract.
   */
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

export interface NamecheapDnsProviderOptions {
  env?: Record<string, string | undefined>;
}

const defaultTtl = 300;

// Nameservers por default de Namecheap BasicDNS (Namecheap autoritativo del dominio).
const NAMECHEAP_BASIC_DNS_NAMESERVERS = ["dns1.registrar-servers.com", "dns2.registrar-servers.com"];

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
    const normalizedRecords = records.map((record, index) => ionosRecordInput(record, index));
    const result = await this.adapter.upsertRecords(zoneId, normalizedRecords);
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

/**
 * Namecheap como proveedor DNS AUTORITATIVO e INDEPENDIENTE (espejo de IonosDnsProvider).
 * NO hay zoneId: la zona es el propio dominio. `setHosts` es full-set replace, así que
 * upsertRecords hace getHosts + merge (preserva records ajenos, reemplaza los del SMTP) + setHosts.
 * ensureZone reestablece BasicDNS (setDefault) para que Namecheap sea autoritativo. Sin dependencia
 * de Route53 ni de ningún otro proveedor.
 */
export class NamecheapDnsProvider implements DnsProvider {
  readonly providerId = "namecheap";
  private readonly adapter: NamecheapDomainsAdapter;

  constructor(adapter: NamecheapDomainsAdapter) {
    this.adapter = adapter;
  }

  isLive(): boolean {
    return this.adapter.isLive();
  }

  isWriteEnabled(): boolean {
    return this.adapter.isWriteEnabled();
  }

  async ensureZone(domainOrZoneName: string): Promise<DnsZoneResult> {
    const domain = normalizeNamecheapDomain(domainOrZoneName);
    await this.adapter.setDefaultNameservers(domain);
    return { zoneId: domain, nameServers: [...NAMECHEAP_BASIC_DNS_NAMESERVERS] };
  }

  async upsertRecords(zoneId: string, records: DnsRecordSpec[]): Promise<DnsUpsertResult> {
    const domain = normalizeNamecheapDomain(zoneId);
    const current = await this.adapter.getHosts(domain);
    const incoming = records.flatMap((record) => specToNamecheapHosts(record, domain));
    const merged = mergeNamecheapHosts(current.hosts, incoming);
    const idempotent = sameHostSet(current.hosts, merged);
    if (!idempotent) {
      await this.adapter.setHosts(domain, merged);
    }
    return { changeIds: [domain], idempotent };
  }

  async listRecords(zoneId: string): Promise<DnsRecordSpec[]> {
    const domain = normalizeNamecheapDomain(zoneId);
    const current = await this.adapter.getHosts(domain);
    return current.hosts
      .filter((host): host is NamecheapHostRecord & { recordType: DnsRecordType } => isDnsRecordType(host.recordType))
      .map((host) => ({
        name: namecheapHostToFqdn(host.hostName, domain),
        type: host.recordType,
        ...(typeof host.ttl === "number" ? { ttl: host.ttl } : {}),
        values: [host.address],
        ...(host.recordType === "MX" && typeof host.mxPref === "number" ? { prio: host.mxPref } : {})
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

/**
 * Una entry por cuenta Namecheap (id propio: "namecheap-1", etc.), NUNCA "default/cuenta 1/2":
 * el agente y el dispatcher direccionan por id/label. Espejo de createNamecheapAdaptersFromEnv,
 * pero sólo incluye cuentas write-capable con DNS (isLive). El DNS de un dominio vive en la MISMA
 * cuenta Namecheap que lo posee, de modo independiente por cuenta.
 */
export function createNamecheapDnsProviderFromEnv(
  env: Record<string, string | undefined> = defaultEnv(),
  options: NamecheapDnsProviderOptions = {}
): DnsProviderEntry[] {
  const accountEnv = options.env ?? env;
  return createNamecheapAdaptersFromEnv(accountEnv)
    .filter((entry) => entry.adapter.isLive())
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      adapter: new NamecheapDnsProvider(entry.adapter)
    }));
}

function normalizeNamecheapDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * FQDN -> hostName relativo de Namecheap. apex -> "@"; "smtp.<domain>" -> "smtp".
 * Un nombre ya relativo (sin el dominio) se conserva. "@"/"" -> "@".
 */
function fqdnToNamecheapHost(name: string, domain: string): string {
  const normalized = name.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "@" || normalized === domain) return "@";
  if (normalized.endsWith(`.${domain}`)) {
    const host = normalized.slice(0, normalized.length - domain.length - 1);
    return host || "@";
  }
  return normalized;
}

function namecheapHostToFqdn(hostName: string, domain: string): string {
  const host = hostName.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host === "@") return domain;
  if (host === domain || host.endsWith(`.${domain}`)) return host;
  return `${host}.${domain}`;
}

function specToNamecheapHosts(record: DnsRecordSpec, domain: string): NamecheapHostRecord[] {
  if (!isNamecheapHostType(record.type)) return [];
  const hostName = fqdnToNamecheapHost(record.name, domain);
  return record.values.map((value) => ({
    hostName,
    recordType: record.type as NamecheapHostRecord["recordType"],
    address: namecheapAddressForValue(record.type, value),
    ...(record.type === "MX" ? { mxPref: record.prio ?? 10 } : {}),
    ...(typeof record.ttl === "number" ? { ttl: record.ttl } : {})
  }));
}

// Para MX, el spec neutro puede traer el valor con prioridad embebida ("10 mail.dom.");
// Namecheap separa la prioridad (mxPref), así que el address es sólo el host de correo.
function namecheapAddressForValue(type: DnsRecordType, value: string): string {
  const trimmed = value.trim();
  if (type !== "MX") return trimmed;
  const withPriority = trimmed.match(/^(\d+)\s+(.+)$/);
  return withPriority ? withPriority[2].trim() : trimmed;
}

/** Clasifica un TXT para no pisar TXT ajenos (SPF/DKIM/DMARC vs otros). */
function namecheapTxtClass(host: NamecheapHostRecord): string {
  const hostName = host.hostName.toLowerCase();
  if (hostName === "_dmarc") return "dmarc";
  if (hostName.endsWith("_domainkey")) return "dkim";
  if (host.address.toLowerCase().startsWith("v=spf1")) return "spf";
  return `txt:${hostName}:${host.address.toLowerCase()}`;
}

function namecheapConflictKey(host: NamecheapHostRecord): string {
  const hostName = host.hostName.toLowerCase();
  if (host.recordType === "TXT") return `TXT|${hostName}|${namecheapTxtClass(host)}`;
  return `${host.recordType}|${hostName}`;
}

/**
 * Merge full-set: conserva los host records existentes que NO colisionan con los entrantes
 * (por hostName+type, y para TXT por clase SPF/DKIM/DMARC), y agrega los entrantes. Así el SMTP
 * escribe/actualiza sus records de forma idempotente sin borrar records ajenos del dominio.
 */
function mergeNamecheapHosts(existing: NamecheapHostRecord[], incoming: NamecheapHostRecord[]): NamecheapHostRecord[] {
  const incomingKeys = new Set(incoming.map(namecheapConflictKey));
  const preserved = existing.filter((host) => !incomingKeys.has(namecheapConflictKey(host)));
  return [...preserved, ...incoming];
}

function sameHostSet(left: NamecheapHostRecord[], right: NamecheapHostRecord[]): boolean {
  const encode = (hosts: NamecheapHostRecord[]): string =>
    hosts
      .map((host) => `${host.hostName.toLowerCase()}|${host.recordType}|${host.address.toLowerCase()}|${host.mxPref ?? ""}`)
      .sort()
      .join("\n");
  return encode(left) === encode(right);
}

function isNamecheapHostType(type: DnsRecordType): boolean {
  return type === "A" || type === "MX" || type === "TXT" || type === "CNAME";
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
  return record.values.map((value, index) => route53MxValue(record, value, index));
}

function route53MxValue(record: DnsRecordSpec, value: string, index: number): string {
  const existingPriority = value.match(/^(\d+)\s+(.+)$/);
  if (!existingPriority) {
    return `${record.prio} ${value}`;
  }
  const priority = Number(existingPriority[1]);
  if (priority !== record.prio) {
    throw new Error(
      `DNS record ${record.name} MX value at index ${index} already includes priority ${priority}; expected ${record.prio}.`
    );
  }
  return `${record.prio} ${existingPriority[2]}`;
}

function ionosRecordInput(record: DnsRecordSpec, index: number): IonosDnsRecordWriteInput {
  const content = record.values[0];
  if (!content) {
    throw new Error(`DNS record ${record.name} ${record.type} at index ${index} must include at least one value.`);
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
