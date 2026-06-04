import { createHash, createHmac, randomUUID } from "node:crypto";

export type AwsRoute53DnsRecordType = "A" | "MX" | "TXT" | "CNAME";

export interface AwsRoute53DnsRecordInput {
  name: string;
  type: AwsRoute53DnsRecordType;
  ttl: number;
  values: string[];
}

export interface AwsRoute53HostedZoneResult {
  zoneId: string;
  nameServers: string[];
}

export interface AwsRoute53HostedZoneSummary {
  zoneId: string;
  name: string;
  nameServers: string[];
}

export interface AwsRoute53DnsChangeResult {
  changeId: string;
}

export interface AwsRoute53ResourceRecordSet {
  name: string;
  type: string;
  ttl: number;
  values: string[];
}

interface AwsRoute53ResourceRecordSetPage {
  records: AwsRoute53ResourceRecordSet[];
  isTruncated: boolean;
  nextRecordName?: string;
  nextRecordType?: string;
  nextRecordIdentifier?: string;
}

export interface AwsRoute53DeleteHostedZoneResult {
  zoneId: string;
  deletedRecords: Array<AwsRoute53DnsRecordInput & AwsRoute53DnsChangeResult>;
  deleteChangeId?: string;
}

export interface AwsRoute53DnsSource {
  kind: "live" | "mock";
  region: string;
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  errorMessage?: string;
  writeEnabled: boolean;
}

export interface AwsRoute53DnsAdapterOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  writeEnabled?: boolean;
}

const DEFAULT_REGION = "us-east-1";
const DEFAULT_API_BASE = "https://route53.amazonaws.com";
const API_VERSION = "2013-04-01";
const SERVICE = "route53";
const XMLNS = "https://route53.amazonaws.com/doc/2013-04-01/";

export class AwsRoute53DnsAdapter {
  private readonly accessKeyId: string | undefined;
  private readonly secretAccessKey: string | undefined;
  private readonly sessionToken: string | undefined;
  private readonly region: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly writeEnabled: boolean;

  constructor(options: AwsRoute53DnsAdapterOptions = {}) {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    this.accessKeyId =
      normalizeEnvValue(options.accessKeyId) ??
      normalizeEnvValue(env.AWS_ROUTE53_DNS_ACCESS_KEY_ID) ??
      normalizeEnvValue(env.AWS_ROUTE53_ACCESS_KEY_ID) ??
      normalizeEnvValue(env.AWS_ACCESS_KEY_ID);
    this.secretAccessKey =
      normalizeEnvValue(options.secretAccessKey) ??
      normalizeEnvValue(env.AWS_ROUTE53_DNS_SECRET_ACCESS_KEY) ??
      normalizeEnvValue(env.AWS_ROUTE53_SECRET_ACCESS_KEY) ??
      normalizeEnvValue(env.AWS_SECRET_ACCESS_KEY);
    this.sessionToken =
      normalizeEnvValue(options.sessionToken) ??
      normalizeEnvValue(env.AWS_ROUTE53_DNS_SESSION_TOKEN) ??
      normalizeEnvValue(env.AWS_ROUTE53_SESSION_TOKEN) ??
      normalizeEnvValue(env.AWS_SESSION_TOKEN);
    this.region =
      normalizeEnvValue(options.region) ??
      normalizeEnvValue(env.AWS_ROUTE53_DNS_REGION) ??
      normalizeEnvValue(env.AWS_ROUTE53_REGION) ??
      DEFAULT_REGION;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.writeEnabled =
      options.writeEnabled ??
      (
        normalizeEnvValue(env.AWS_ROUTE53_DNS_ENABLE_WRITES) === "true" ||
        normalizeEnvValue(env.AWS_ROUTE53_ENABLE_DNS_WRITES) === "true"
      );
  }

  isLive(): boolean {
    return Boolean(this.accessKeyId && this.secretAccessKey);
  }

  isWriteEnabled(): boolean {
    return this.writeEnabled;
  }

  currentSource(responseOk = true, errorMessage?: string): AwsRoute53DnsSource {
    return {
      kind: this.isLive() ? "live" : "mock",
      region: this.region,
      apiBase: this.apiBase,
      fetchedAt: this.now().toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {}),
      writeEnabled: this.writeEnabled
    };
  }

  async createHostedZone(domain: string): Promise<AwsRoute53HostedZoneResult> {
    this.assertWritable();
    const domainName = normalizeDomainName(domain);
    const response = await this.awsXml("POST", `/${API_VERSION}/hostedzone`, createHostedZoneXml(domainName));
    const zoneId = normalizeHostedZoneId(firstXmlValue(response, "Id"));
    if (!zoneId) {
      throw new Error("AWS Route53 CreateHostedZone response did not include hosted zone id.");
    }
    return {
      zoneId,
      nameServers: xmlValues(response, "NameServer")
    };
  }

  async listHostedZones(): Promise<AwsRoute53HostedZoneSummary[]> {
    this.assertLive("AWS Route53 hosted zone listing requires live credentials.");
    const zones: AwsRoute53HostedZoneSummary[] = [];
    let marker: string | undefined;

    while (true) {
      const query = new URLSearchParams();
      query.set("maxitems", "100");
      if (marker) query.set("marker", marker);
      const response = await this.awsXml("GET", `/${API_VERSION}/hostedzone?${query.toString()}`);
      const page = parseHostedZonesPage(response);
      zones.push(...page.zones);

      if (!page.isTruncated) {
        return zones;
      }
      if (!page.nextMarker) {
        throw new Error("AWS Route53 ListHostedZones response was truncated without NextMarker.");
      }
      marker = page.nextMarker;
    }
  }

  async upsertRecord(
    zoneId: string,
    opts: AwsRoute53DnsRecordInput
  ): Promise<AwsRoute53DnsChangeResult> {
    this.assertWritable();
    const normalizedZoneId = normalizeHostedZoneId(zoneId);
    if (!normalizedZoneId) {
      throw new Error(`Invalid Route53 hosted zone id: ${zoneId}`);
    }
    const record = normalizeRecord(opts);
    const response = await this.awsXml(
      "POST",
      `/${API_VERSION}/hostedzone/${encodeURIComponent(normalizedZoneId)}/rrset`,
      changeRecordXml("UPSERT", record)
    );
    const changeId = normalizeChangeId(firstXmlValue(response, "Id"));
    if (!changeId) {
      throw new Error("AWS Route53 ChangeResourceRecordSets response did not include change id.");
    }
    return { changeId };
  }

  async deleteRecord(zoneId: string, opts: AwsRoute53DnsRecordInput): Promise<AwsRoute53DnsChangeResult> {
    this.assertWritable();
    const normalizedZoneId = normalizeHostedZoneId(zoneId);
    if (!normalizedZoneId) {
      throw new Error(`Invalid Route53 hosted zone id: ${zoneId}`);
    }
    const response = await this.awsXml(
      "POST",
      `/${API_VERSION}/hostedzone/${encodeURIComponent(normalizedZoneId)}/rrset`,
      changeRecordXml("DELETE", normalizeRecord(opts))
    );
    const changeId = normalizeChangeId(firstXmlValue(response, "Id"));
    if (!changeId) {
      throw new Error("AWS Route53 ChangeResourceRecordSets delete response did not include change id.");
    }
    return { changeId };
  }

  async listResourceRecordSets(zoneId: string): Promise<AwsRoute53ResourceRecordSet[]> {
    this.assertLive("AWS Route53 resource record listing requires live credentials.");
    const normalizedZoneId = normalizeHostedZoneId(zoneId);
    if (!normalizedZoneId) {
      throw new Error(`Invalid Route53 hosted zone id: ${zoneId}`);
    }
    const records: AwsRoute53ResourceRecordSet[] = [];
    let startRecordName: string | undefined;
    let startRecordType: string | undefined;
    let startRecordIdentifier: string | undefined;

    while (true) {
      const query = new URLSearchParams();
      query.set("maxitems", "100");
      if (startRecordName) query.set("name", startRecordName);
      if (startRecordType) query.set("type", startRecordType);
      if (startRecordIdentifier) query.set("identifier", startRecordIdentifier);
      const response = await this.awsXml(
        "GET",
        `/${API_VERSION}/hostedzone/${encodeURIComponent(normalizedZoneId)}/rrset?${query.toString()}`
      );
      const page = parseResourceRecordSetsPage(response);
      records.push(...page.records);

      if (!page.isTruncated) {
        return records;
      }
      if (!page.nextRecordName || !page.nextRecordType) {
        throw new Error("AWS Route53 ListResourceRecordSets response was truncated without next record cursor.");
      }
      startRecordName = page.nextRecordName;
      startRecordType = page.nextRecordType;
      startRecordIdentifier = page.nextRecordIdentifier;
    }
  }

  async deleteHostedZone(
    zoneId: string,
    opts: { deleteRecords?: boolean } = {}
  ): Promise<AwsRoute53DeleteHostedZoneResult> {
    this.assertWritable();
    const normalizedZoneId = normalizeHostedZoneId(zoneId);
    if (!normalizedZoneId) {
      throw new Error(`Invalid Route53 hosted zone id: ${zoneId}`);
    }

    const deletedRecords: Array<AwsRoute53DnsRecordInput & AwsRoute53DnsChangeResult> = [];
    if (opts.deleteRecords !== false) {
      const records = await this.listResourceRecordSets(normalizedZoneId);
      for (const record of records) {
        if (!isDeletableRecord(record)) continue;
        const change = await this.deleteRecord(normalizedZoneId, record);
        deletedRecords.push({ ...record, ...change });
      }
    }

    const response = await this.awsXml(
      "DELETE",
      `/${API_VERSION}/hostedzone/${encodeURIComponent(normalizedZoneId)}`
    );
    const deleteChangeId = normalizeChangeId(firstXmlValue(response, "Id"));
    return {
      zoneId: normalizedZoneId,
      deletedRecords,
      ...(deleteChangeId ? { deleteChangeId } : {})
    };
  }

  private assertWritable(): void {
    if (!this.writeEnabled) {
      throw new Error("AWS Route53 DNS writes are disabled by AWS_ROUTE53_DNS_ENABLE_WRITES.");
    }
    this.assertLive("AWS Route53 DNS writes require live credentials.");
  }

  private assertLive(message: string): void {
    if (!this.isLive()) {
      throw new Error(message);
    }
  }

  private async awsXml(method: "GET" | "POST" | "DELETE", path: string, body = ""): Promise<string> {
    const url = new URL(path, this.apiBase);
    const headers = signAwsRestRequest({
      accessKeyId: this.accessKeyId ?? "",
      secretAccessKey: this.secretAccessKey ?? "",
      sessionToken: this.sessionToken,
      region: this.region,
      service: SERVICE,
      method,
      url,
      body,
      contentType: "text/xml; charset=utf-8",
      now: this.now()
    });
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: method === "GET" ? undefined : body
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`AWS Route53 API returned ${response.status} ${response.statusText}: ${safePreview(responseBody)}`);
    }
    return responseBody;
  }
}

export function signAwsRestRequest(input: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  method: "GET" | "POST" | "DELETE";
  url: URL;
  body: string;
  contentType: string;
  now: Date;
}): Record<string, string> {
  const amzDate = awsTimestamp(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    "content-type": input.contentType,
    host: input.url.host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amzDate
  };
  if (input.sessionToken) {
    headers["x-amz-security-token"] = input.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const canonicalRequest = [
    input.method,
    input.url.pathname || "/",
    input.url.searchParams.toString(),
    canonicalHeaders,
    signedHeaderNames.join(";"),
    bodyHash
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = awsSigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
  const signature = hmacHex(signingKey, stringToSign);

  return {
    ...headers,
    authorization: [
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}`,
      `SignedHeaders=${signedHeaderNames.join(";")}`,
      `Signature=${signature}`
    ].join(", ")
  };
}

function createHostedZoneXml(domain: string): string {
  return [
    `<CreateHostedZoneRequest xmlns="${XMLNS}">`,
    `<Name>${xmlEscape(absoluteDnsName(domain))}</Name>`,
    `<CallerReference>delivrix-${Date.now()}-${randomUUID()}</CallerReference>`,
    "</CreateHostedZoneRequest>"
  ].join("");
}

function changeRecordXml(action: "UPSERT" | "DELETE", record: AwsRoute53DnsRecordInput): string {
  return [
    `<ChangeResourceRecordSetsRequest xmlns="${XMLNS}">`,
    "<ChangeBatch><Changes><Change>",
    `<Action>${action}</Action>`,
    "<ResourceRecordSet>",
    `<Name>${xmlEscape(record.name)}</Name>`,
    `<Type>${record.type}</Type>`,
    `<TTL>${record.ttl}</TTL>`,
    "<ResourceRecords>",
    ...record.values.map((value) => `<ResourceRecord><Value>${xmlEscape(route53RecordValue(record.type, value))}</Value></ResourceRecord>`),
    "</ResourceRecords>",
    "</ResourceRecordSet>",
    "</Change></Changes></ChangeBatch>",
    "</ChangeResourceRecordSetsRequest>"
  ].join("");
}

function normalizeRecord(input: AwsRoute53DnsRecordInput): AwsRoute53DnsRecordInput {
  const type = input.type;
  if (type !== "A" && type !== "MX" && type !== "TXT" && type !== "CNAME") {
    throw new Error(`Unsupported Route53 DNS record type: ${String(type)}`);
  }
  const ttl = Math.trunc(input.ttl);
  if (!Number.isFinite(ttl) || ttl < 30 || ttl > 172800) {
    throw new Error("Route53 DNS record ttl must be between 30 and 172800 seconds.");
  }
  const name = absoluteDnsName(input.name);
  const values = input.values.map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error("Route53 DNS record values are required.");
  }
  return { name, type, ttl, values };
}

function route53RecordValue(type: AwsRoute53DnsRecordType, value: string): string {
  if (type === "TXT") {
    const trimmed = value.trim();
    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
      return trimmed;
    }
    return chunkTxtValue(trimmed).map((chunk) => `"${chunk.replace(/"/g, "\\\"")}"`).join(" ");
  }
  return value.trim();
}

function chunkTxtValue(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += 250) {
    chunks.push(value.slice(index, index + 250));
  }
  return chunks.length > 0 ? chunks : [""];
}

function parseResourceRecordSets(xml: string): AwsRoute53ResourceRecordSet[] {
  return xmlBlocks(xml, "ResourceRecordSet").map((block) => {
    const name = firstXmlValue(block, "Name") ?? "";
    const type = firstXmlValue(block, "Type") ?? "";
    const ttl = Number(firstXmlValue(block, "TTL") ?? "0");
    return {
      name,
      type,
      ttl: Number.isFinite(ttl) ? ttl : 0,
      values: xmlValues(block, "Value")
    };
  }).filter((record) => record.name && record.type);
}

function parseResourceRecordSetsPage(xml: string): AwsRoute53ResourceRecordSetPage {
  return {
    records: parseResourceRecordSets(xml),
    isTruncated: (firstXmlValue(xml, "IsTruncated") ?? "false").toLowerCase() === "true",
    nextRecordName: firstXmlValue(xml, "NextRecordName"),
    nextRecordType: firstXmlValue(xml, "NextRecordType"),
    nextRecordIdentifier: firstXmlValue(xml, "NextRecordIdentifier")
  };
}

function parseHostedZonesPage(xml: string): {
  zones: AwsRoute53HostedZoneSummary[];
  isTruncated: boolean;
  nextMarker?: string;
} {
  const hostedZonesSection = firstXmlBlock(xml, "HostedZones") ?? "";
  return {
    zones: xmlBlocks(hostedZonesSection, "HostedZone").map((block) => ({
      zoneId: normalizeHostedZoneId(firstXmlValue(block, "Id")) ?? "",
      name: firstXmlValue(block, "Name") ?? "",
      nameServers: xmlValues(block, "NameServer")
    })).filter((zone) => zone.zoneId && zone.name),
    isTruncated: (firstXmlValue(xml, "IsTruncated") ?? "false").toLowerCase() === "true",
    nextMarker: firstXmlValue(xml, "NextMarker")
  };
}

function isDeletableRecord(record: AwsRoute53ResourceRecordSet): record is AwsRoute53DnsRecordInput {
  if (
    record.type !== "A" &&
    record.type !== "MX" &&
    record.type !== "TXT" &&
    record.type !== "CNAME"
  ) {
    return false;
  }
  return record.ttl >= 30 && record.values.length > 0;
}

function absoluteDnsName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "@") {
    throw new Error("Route53 DNS record name cannot be @ without the domain context.");
  }
  if (!/^[a-z0-9_*](?:[a-z0-9_*.-]{0,251}[a-z0-9_*])?$/.test(normalized)) {
    throw new Error(`Invalid DNS name: ${value}`);
  }
  return `${normalized}.`;
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new Error(`Invalid domain name: ${value}`);
  }
  return normalized;
}

function firstXmlValue(xml: string, tag: string): string | undefined {
  return xmlValues(xml, tag)[0];
}

function xmlValues(xml: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}>([^<]+)</${tag}>`, "g");
  let match = pattern.exec(xml);
  while (match) {
    values.push(xmlUnescape(match[1]));
    match = pattern.exec(xml);
  }
  return values;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let match = pattern.exec(xml);
  while (match) {
    values.push(match[1]);
    match = pattern.exec(xml);
  }
  return values;
}

function firstXmlBlock(xml: string, tag: string): string | undefined {
  return xmlBlocks(xml, tag)[0];
}

function normalizeHostedZoneId(value: string | undefined): string | undefined {
  const normalized = value?.replace(/^\/hostedzone\//, "").trim();
  return normalized && /^[A-Z0-9]+$/.test(normalized) ? normalized : undefined;
}

function normalizeChangeId(value: string | undefined): string | undefined {
  const normalized = value?.replace(/^\/change\//, "").trim();
  return normalized && /^[A-Z0-9]+$/.test(normalized) ? normalized : undefined;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function awsSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function awsTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safePreview(value: string): string {
  return value.replace(/[A-Za-z0-9/+=_-]{24,}/g, "[redacted]").slice(0, 240);
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
