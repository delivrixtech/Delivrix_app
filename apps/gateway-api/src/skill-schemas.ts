export type SkillSafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: string[]; format: () => Record<string, unknown> } };

export interface SkillParamSchema<T extends Record<string, unknown> = Record<string, unknown>> {
  safeParse(value: unknown): SkillSafeParseResult<T>;
}

export interface Route53RegisterParams extends Record<string, unknown> {
  domain: string;
  years: number;
  autoRenew: boolean;
}

export interface Route53UpsertParams extends Record<string, unknown> {
  domain: string;
  records: Array<{
    name: string;
    type: "A" | "MX" | "TXT" | "CNAME";
    ttl: number;
    values: string[];
  }>;
  taskId?: string;
}

export interface IonosUpsertParams extends Record<string, unknown> {
  zone: string;
  records: Array<{
    name: string;
    type: "A" | "AAAA" | "MX" | "TXT" | "CNAME" | "NS" | "CAA" | "SRV";
    content: string;
    ttl?: number;
    prio?: number;
  }>;
}

export interface WebdockCreateParams extends Record<string, unknown> {
  profile: "bit" | "nibble" | "byte" | "kilobyte";
  locationId: string;
  hostname: string;
  imageSlug: "ubuntu-2404" | "debian-12";
  publicKey?: string;
  callbackUrl?: string;
  taskId?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface SmtpProvisionParams extends Record<string, unknown> {
  serverSlug: string;
  domain: string;
  serverIp?: string;
  dkimPrivateKeyPath?: string;
  selector?: string;
  taskId?: string;
}

export interface EmailAuthParams extends Record<string, unknown> {
  domain: string;
  mxServerIp: string;
  zoneId?: string;
  selector?: string;
  dmarcPolicy?: "none" | "quarantine" | "reject";
  taskId?: string;
}

export interface DomainBindParams extends Record<string, unknown> {
  domain: string;
  serverSlug?: string;
  serverIp?: string;
  zoneId?: string;
  taskId?: string;
}

export interface WarmupSeedParams extends Record<string, unknown> {
  domain: string;
  serverSlug?: string;
  serverIp?: string;
  seedInboxes: string[];
  taskId?: string;
}

export interface WarmupRampParams extends Record<string, unknown> {
  domain: string;
  serverSlug?: string;
  serverIp?: string;
  schedule: "demo-fast" | "production-14d";
  recipientPool: string[];
}

export const route53RegisterParamSchema = schema<Route53RegisterParams>((value) => {
  const input = object(value);
  const years = integer(input.years ?? input.durationYears, "years", 1, 10);
  return {
    domain: domain(input.domain, "domain"),
    years,
    autoRenew: input.autoRenew === undefined ? false : boolean(input.autoRenew, "autoRenew")
  };
});

export const route53UpsertParamSchema = schema<Route53UpsertParams>((value) => {
  const input = object(value);
  const route53Records = array(input.records, "records", 1, 50).map((record, index) => {
    const item = object(record, `records[${index}]`);
    return {
      name: string(item.name, `records[${index}].name`),
      type: oneOf(item.type, `records[${index}].type`, ["A", "MX", "TXT", "CNAME"] as const),
      ttl: integer(item.ttl, `records[${index}].ttl`, 30, 172800),
      values: array(item.values, `records[${index}].values`, 1, 50).map((entry, valueIndex) =>
        string(entry, `records[${index}].values[${valueIndex}]`)
      )
    };
  });
  return withOptionalTaskId({
    domain: domain(input.domain ?? input.zoneName, "domain"),
    records: route53Records
  }, input);
});

export const ionosUpsertParamSchema = schema<IonosUpsertParams>((value) => {
  const input = object(value);
  const records = array(input.records, "records", 1, 50).map((record, index) => {
    const item = object(record, `records[${index}]`);
    return {
      name: string(item.name, `records[${index}].name`),
      type: oneOf(item.type, `records[${index}].type`, ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "CAA", "SRV"] as const),
      content: string(item.content, `records[${index}].content`),
      ...(item.ttl === undefined || item.ttl === null ? {} : { ttl: integer(item.ttl, `records[${index}].ttl`, 30, 604800) }),
      ...(item.prio === undefined || item.prio === null ? {} : { prio: integer(item.prio, `records[${index}].prio`, 0, 65535) })
    };
  });
  return {
    zone: domain(input.zone ?? input.zoneName ?? input.domain, "zone"),
    records
  };
});

export const webdockCreateParamSchema = schema<WebdockCreateParams>((value) => {
  const input = object(value);
  return withOptionalTaskId({
    profile: oneOf(input.profile, "profile", ["bit", "nibble", "byte", "kilobyte"] as const),
    locationId: providerId(input.locationId, "locationId"),
    hostname: domain(input.hostname, "hostname"),
    imageSlug: oneOf(input.imageSlug, "imageSlug", ["ubuntu-2404", "debian-12"] as const),
    ...(input.publicKey === undefined || input.publicKey === null || input.publicKey === "" ? {} : { publicKey: publicKey(input.publicKey, "publicKey") }),
    ...(input.callbackUrl === undefined || input.callbackUrl === null || input.callbackUrl === "" ? {} : { callbackUrl: httpsUrl(input.callbackUrl, "callbackUrl") }),
    ...(input.pollIntervalMs === undefined || input.pollIntervalMs === null ? {} : { pollIntervalMs: integer(input.pollIntervalMs, "pollIntervalMs", 0, 60000) }),
    ...(input.maxPolls === undefined || input.maxPolls === null ? {} : { maxPolls: integer(input.maxPolls, "maxPolls", 0, 60) })
  }, input);
});

export const smtpProvisionParamSchema = schema<SmtpProvisionParams>((value) => {
  const input = object(value);
  return withOptionalTaskId({
    serverSlug: slug(input.serverSlug, "serverSlug"),
    domain: domain(input.domain, "domain"),
    ...(input.serverIp === undefined || input.serverIp === null || input.serverIp === "" ? {} : { serverIp: ipv4(input.serverIp, "serverIp") }),
    ...(input.dkimPrivateKeyPath === undefined || input.dkimPrivateKeyPath === null || input.dkimPrivateKeyPath === "" ? {} : { dkimPrivateKeyPath: dkimPrivateKeyPath(input.dkimPrivateKeyPath, "dkimPrivateKeyPath") }),
    ...(input.selector === undefined || input.selector === null || input.selector === "" ? {} : { selector: selector(input.selector, "selector") })
  }, input);
});

export const emailAuthParamSchema = schema<EmailAuthParams>((value) => {
  const input = object(value);
  return withOptionalTaskId({
    domain: domain(input.domain, "domain"),
    mxServerIp: ipv4(input.mxServerIp, "mxServerIp"),
    ...(input.zoneId === undefined || input.zoneId === null || input.zoneId === "" ? {} : { zoneId: string(input.zoneId, "zoneId") }),
    ...(input.selector === undefined || input.selector === null || input.selector === "" ? {} : { selector: selector(input.selector, "selector") }),
    ...(input.dmarcPolicy === undefined || input.dmarcPolicy === null || input.dmarcPolicy === "" ? {} : { dmarcPolicy: oneOf(input.dmarcPolicy, "dmarcPolicy", ["none", "quarantine", "reject"] as const) })
  }, input);
});

export const bindDomainParamSchema = schema<DomainBindParams>((value) => {
  const input = object(value);
  const hasServerSlug = input.serverSlug !== undefined && input.serverSlug !== null && input.serverSlug !== "";
  const hasServerIp = input.serverIp !== undefined && input.serverIp !== null && input.serverIp !== "";
  if (!hasServerSlug && !hasServerIp) {
    throw new SkillSchemaError("serverSlug or serverIp is required");
  }
  return withOptionalTaskId({
    domain: domain(input.domain, "domain"),
    ...(hasServerSlug ? { serverSlug: slug(input.serverSlug, "serverSlug") } : {}),
    ...(hasServerIp ? { serverIp: ipv4(input.serverIp, "serverIp") } : {}),
    ...(input.zoneId === undefined || input.zoneId === null || input.zoneId === "" ? {} : { zoneId: string(input.zoneId, "zoneId") })
  }, input);
});

export const warmupSeedParamSchema = schema<WarmupSeedParams>((value) => {
  const input = object(value);
  const seeds = input.seedInboxes ?? input.seedAddresses;
  return withOptionalTaskId({
    domain: domain(input.domain, "domain"),
    ...(input.serverSlug === undefined || input.serverSlug === null || input.serverSlug === "" ? {} : { serverSlug: slug(input.serverSlug, "serverSlug") }),
    ...(input.serverIp === undefined || input.serverIp === null || input.serverIp === "" ? {} : { serverIp: ipv4(input.serverIp, "serverIp") }),
    seedInboxes: array(seeds, "seedInboxes", 1, 50).map((entry, index) => email(entry, `seedInboxes[${index}]`))
  }, input);
});

export const warmupRampParamSchema = schema<WarmupRampParams>((value) => {
  const input = object(value);
  return {
    domain: domain(input.domain, "domain"),
    ...(input.serverSlug === undefined || input.serverSlug === null || input.serverSlug === "" ? {} : { serverSlug: slug(input.serverSlug, "serverSlug") }),
    ...(input.serverIp === undefined || input.serverIp === null || input.serverIp === "" ? {} : { serverIp: ipv4(input.serverIp, "serverIp") }),
    schedule: oneOf(input.schedule, "schedule", ["demo-fast", "production-14d"] as const),
    recipientPool: array(input.recipientPool, "recipientPool", 1, 2000).map((entry, index) => email(entry, `recipientPool[${index}]`))
  };
});

class SkillSchemaError extends Error {}

function schema<T extends Record<string, unknown>>(parse: (value: unknown) => T): SkillParamSchema<T> {
  return {
    safeParse(value: unknown): SkillSafeParseResult<T> {
      try {
        return { success: true, data: parse(value) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "schema_mismatch";
        return {
          success: false,
          error: {
            issues: [message],
            format: () => ({ _errors: [message] })
          }
        };
      }
    }
  };
}

function object(value: unknown, field = "params"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillSchemaError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SkillSchemaError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new SkillSchemaError(`${field} must be boolean`);
  }
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SkillSchemaError(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function array(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new SkillSchemaError(`${field} must be an array with ${min}-${max} item(s)`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw new SkillSchemaError(`${field} must be one of ${allowed.join(", ")}`);
}

function domain(value: unknown, field: string): string {
  const normalized = string(value, field).toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be a valid domain`);
  }
  return normalized;
}

function ipv4(value: unknown, field: string): string {
  const parts = string(value, field).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)) {
    throw new SkillSchemaError(`${field} must be a valid IPv4 address`);
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function email(value: unknown, field: string): string {
  const normalized = string(value, field).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be a valid email`);
  }
  return normalized;
}

function slug(value: unknown, field: string): string {
  const normalized = string(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    throw new SkillSchemaError(`${field} is invalid`);
  }
  return normalized;
}

function selector(value: unknown, field: string): string {
  const normalized = string(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be DNS-safe`);
  }
  return normalized;
}

function dkimPrivateKeyPath(value: unknown, field: string): string {
  const normalized = string(value, field).replace(/^\/+/, "");
  if (!/^inventory\/dkim-keys\/[a-z0-9.-]+\/[a-z0-9_-]+\.private$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must point to inventory/dkim-keys/<domain>/<selector>.private`);
  }
  return normalized;
}

function providerId(value: unknown, field: string): string {
  const normalized = string(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be provider id-safe`);
  }
  return normalized;
}

function publicKey(value: unknown, field: string): string {
  const normalized = string(value, field);
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be an OpenSSH public key`);
  }
  return normalized;
}

function httpsUrl(value: unknown, field: string): string {
  const raw = string(value, field);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      throw new SkillSchemaError(`${field} must be https`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof SkillSchemaError) throw error;
    throw new SkillSchemaError(`${field} must be a valid URL`);
  }
}

function withOptionalTaskId<T extends Record<string, unknown>>(
  output: T,
  input: Record<string, unknown>
): T {
  if (typeof input.taskId !== "string" || !input.taskId.trim()) {
    return output;
  }
  const taskId = input.taskId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(taskId)) {
    throw new SkillSchemaError("taskId is invalid");
  }
  return { ...output, taskId };
}
