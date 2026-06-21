import { createHash } from "node:crypto";
import { conformOutcomeData, machineErrorCode } from "../../../packages/storage/src/index.ts";
import {
  tryNormalizeServerSlug,
  tryNormalizeStrictDomainName
} from "./entity-guard.ts";

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
  repairReason?: string;
  explicitRepairScope?: string;
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
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface Route53DomainDetailParams extends Record<string, unknown> {
  domain: string;
}

export interface Route53ZoneRecordsParams extends Record<string, unknown> {
  zoneId: string;
  recordType?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SOA" | "PTR" | "SRV" | "CAA";
  recordName?: string;
}

export interface Route53NameserverUpdateParams extends Record<string, unknown> {
  domain: string;
  zoneId?: string;
  nameservers?: string[];
  taskId?: string;
}

export interface IonosDnsReadParams extends Record<string, unknown> {
  domain?: string;
  zoneId?: string;
  recordType?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SOA" | "PTR" | "SRV" | "CAA";
  recordName?: string;
}

export interface MxtoolboxHealthParams extends Record<string, unknown> {
  target: string;
  type?: "blacklist" | "smtp" | "mx" | "spf" | "dkim" | "dmarc" | "ptr" | "a" | "txt" | "dns" | "bimi" | "mta-sts";
  selector?: string;
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
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface WebdockCreateParams extends Record<string, unknown> {
  profile: "bit" | "nibble" | "byte" | "kilobyte";
  locationId: string;
  hostname: string;
  imageSlug: "ubuntu-2404" | "debian-12";
  publicKey?: string;
  callbackUrl?: string;
  runId?: string;
  taskId?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface ReadWebdockServersParams extends Record<string, unknown> {
  serverSlug?: string;
  ipv4?: string;
}

export interface SmtpProvisionParams extends Record<string, unknown> {
  serverSlug: string;
  domain: string;
  serverIp?: string;
  dkimPrivateKeyPath?: string;
  selector?: string;
  taskId?: string;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface EmailAuthParams extends Record<string, unknown> {
  domain: string;
  mxServerIp: string;
  zoneId?: string;
  selector?: string;
  dmarcPolicy?: "none" | "quarantine" | "reject";
  taskId?: string;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface DomainBindParams extends Record<string, unknown> {
  domain: string;
  serverSlug?: string;
  serverIp?: string;
  zoneId?: string;
  taskId?: string;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface WarmupSeedParams extends Record<string, unknown> {
  domain: string;
  serverSlug?: string;
  serverIp?: string;
  seedInboxes: string[];
  taskId?: string;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface WarmupRampParams extends Record<string, unknown> {
  domain: string;
  serverSlug?: string;
  serverIp?: string;
  schedule: "demo-fast" | "production-14d";
  recipientPool: string[];
}

export interface ConfigureCompleteSmtpParams extends Record<string, unknown> {
  runId?: string;
  domain?: string;
  provider?: string;
  /**
   * Proveedor DNS del run. Canal PARALELO HERMANO: el orquestador lo enruta fuera de los
   * `params` de cada step (NO toca hashInput/plan-signature). undefined/"route53" => Route53.
   */
  dnsProviderId?: string;
  /**
   * Proveedor de VPS (Webdock=default, "contabo"=segundo). Canal PARALELO HERMANO de runId/provider:
   * el orquestador lo saca de aqui y lo enruta por providerId FUERA de los `params` del step 4 (NO toca
   * el hashInput/plan-signature). NO es el `provider` (registrar DNS route53). undefined => Webdock.
   */
  vpsProviderId?: string;
  requireExistingDomain?: boolean;
  brand: string;
  intent?: string;
  budgetUsdMax: number;
  testEmailRecipient: string;
  testEmailSubject: string;
  testEmailBody: string;
  actorId: string;
  seedInboxes?: string[];
}

export interface ConfigureCompleteSmtpSkillParams extends Record<string, unknown> {
  runId?: string;
  domain?: string;
  provider?: string;
  /** Proveedor DNS (Route53=default, "ionos"=adopcion IONOS). Canal paralelo; NO entra a step params. */
  dnsProviderId?: string;
  /** Proveedor de VPS (Webdock=default, "contabo"=segundo). Canal paralelo; NO es el registrar DNS. */
  vpsProviderId?: string;
  requireExistingDomain?: boolean;
  brand: string;
  intent?: string;
  budgetUsdMax: number;
  testEmailRecipient: string;
  testEmailSubject: string;
  testEmailBody: string;
  seedInboxes?: string[];
}

export interface ReadEpisodicScratchParams extends Record<string, unknown> {
  intentId?: string;
  inputHash?: string;
  tool?: string;
  outcome?: "success" | "failed" | "rolled_back" | "rollback_failed" | "cancelled_by_operator" | "timeout" | "partial";
  limit?: number;
  sinceDays?: number;
  weighted?: boolean;
  grounded?: boolean;
  query?: string;
  keywords?: string[];
}

export interface CompactIntentParams extends Record<string, unknown> {
  intentId: string;
  finalStatus: "completed" | "failed" | "cancelled" | "rolled_back";
  decision: string;
  ttlDays?: number;
  steps: Array<{
    step: number;
    tool: string;
    inputHash: string;
    outcome: "success" | "failed" | "rolled_back" | "rollback_failed" | "cancelled_by_operator" | "timeout" | "partial";
    outcomeData?: Record<string, unknown>;
    errorClass?: string;
    errorMessage?: string;
    durationMs?: number;
    proposalId?: string;
    signatureId?: string;
    toolUseId?: string;
    toolCallId?: string;
    auditEventId?: string;
  }>;
}

export const route53RegisterParamSchema = schema<Route53RegisterParams>((value) => {
  const input = object(value);
  const years = integer(input.years ?? input.durationYears, "years", 1, 10);
  return withOptionalRepairScope({
    domain: domain(input.domain, "domain"),
    years,
    autoRenew: input.autoRenew === undefined ? false : boolean(input.autoRenew, "autoRenew")
  }, input);
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
  return withOptionalRepairScope(withOptionalTaskId({
    domain: domain(input.domain ?? input.zoneName, "domain"),
    records: route53Records
  }, input), input);
});

export const route53DomainDetailParamSchema = schema<Route53DomainDetailParams>((value) => {
  const input = object(value);
  return {
    domain: domain(input.domain, "domain")
  };
});

export const route53ZoneRecordsParamSchema = schema<Route53ZoneRecordsParams>((value) => {
  const input = object(value);
  return {
    zoneId: route53ZoneId(input.zoneId, "zoneId"),
    ...(input.recordType === undefined || input.recordType === null || input.recordType === ""
      ? {}
      : { recordType: oneOf(String(input.recordType).toUpperCase(), "recordType", route53ReadRecordTypes) }),
    ...(input.recordName === undefined || input.recordName === null || input.recordName === ""
      ? {}
      : { recordName: dnsRecordName(input.recordName, "recordName") })
  };
});

export const route53NameserverUpdateParamSchema = schema<Route53NameserverUpdateParams>((value) => {
  const input = object(value);
  return withOptionalTaskId({
    domain: domain(input.domain, "domain"),
    ...(input.zoneId === undefined || input.zoneId === null || input.zoneId === "" ? {} : { zoneId: route53ZoneId(input.zoneId, "zoneId") }),
    ...(input.nameservers === undefined || input.nameservers === null
      ? {}
      : { nameservers: array(input.nameservers, "nameservers", 2, 13).map((entry, index) => nameserver(entry, `nameservers[${index}]`)) })
  }, input);
});

export const ionosDnsReadParamSchema = schema<IonosDnsReadParams>((value) => {
  const input = object(value);
  const hasDomain = input.domain !== undefined && input.domain !== null && input.domain !== "";
  const hasZoneId = input.zoneId !== undefined && input.zoneId !== null && input.zoneId !== "";
  if (!hasDomain && !hasZoneId) {
    throw new SkillSchemaError("domain or zoneId is required");
  }
  return {
    ...(hasDomain ? { domain: domain(input.domain, "domain") } : {}),
    ...(hasZoneId ? { zoneId: boundedId(input.zoneId, "zoneId", 128) } : {}),
    ...(input.recordType === undefined || input.recordType === null || input.recordType === ""
      ? {}
      : { recordType: oneOf(String(input.recordType).toUpperCase(), "recordType", route53ReadRecordTypes) }),
    ...(input.recordName === undefined || input.recordName === null || input.recordName === ""
      ? {}
      : { recordName: dnsRecordName(input.recordName, "recordName") })
  };
});

export const mxtoolboxHealthParamSchema = schema<MxtoolboxHealthParams>((value) => {
  const input = object(value);
  return {
    target: mxtoolboxTarget(input.target, "target"),
    ...(input.type === undefined || input.type === null || input.type === ""
      ? { type: "blacklist" as const }
      : { type: oneOf(String(input.type).toLowerCase(), "type", mxtoolboxCommands) }),
    ...(input.selector === undefined || input.selector === null || input.selector === ""
      ? {}
      : { selector: selector(input.selector, "selector") })
  };
});

export const readWebdockServersParamSchema = schema<ReadWebdockServersParams>((value) => {
  const input = object(value);
  return {
    ...(input.serverSlug === undefined || input.serverSlug === null || input.serverSlug === ""
      ? {}
      : { serverSlug: slug(input.serverSlug, "serverSlug") }),
    ...(input.ipv4 === undefined || input.ipv4 === null || input.ipv4 === ""
      ? {}
      : { ipv4: ipv4(input.ipv4, "ipv4") })
  };
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
  return withOptionalRepairScope({
    zone: domain(input.zone ?? input.zoneName ?? input.domain, "zone"),
    records
  }, input);
});

export const webdockCreateParamSchema = schema<WebdockCreateParams>((value) => {
  const input = object(value);
  return withOptionalRepairScope(withOptionalTaskId({
    profile: oneOf(input.profile, "profile", ["bit", "nibble", "byte", "kilobyte"] as const),
    locationId: providerId(input.locationId, "locationId"),
    hostname: domain(input.hostname, "hostname"),
    imageSlug: oneOf(input.imageSlug, "imageSlug", ["ubuntu-2404", "debian-12"] as const),
    ...(input.publicKey === undefined || input.publicKey === null || input.publicKey === "" ? {} : { publicKey: publicKey(input.publicKey, "publicKey") }),
    ...(input.callbackUrl === undefined || input.callbackUrl === null || input.callbackUrl === "" ? {} : { callbackUrl: httpsUrl(input.callbackUrl, "callbackUrl") }),
    ...(input.runId === undefined || input.runId === null || input.runId === "" ? {} : { runId: boundedId(input.runId, "runId", 64) }),
    ...(input.pollIntervalMs === undefined || input.pollIntervalMs === null ? {} : { pollIntervalMs: integer(input.pollIntervalMs, "pollIntervalMs", 0, 60000) }),
    ...(input.maxPolls === undefined || input.maxPolls === null ? {} : { maxPolls: integer(input.maxPolls, "maxPolls", 0, 60) })
  }, input), input);
});

export const smtpProvisionParamSchema = schema<SmtpProvisionParams>((value) => {
  const input = object(value);
  return withOptionalRepairScope(withOptionalTaskId({
    serverSlug: slug(input.serverSlug, "serverSlug"),
    domain: domain(input.domain, "domain"),
    ...(input.serverIp === undefined || input.serverIp === null || input.serverIp === "" ? {} : { serverIp: ipv4(input.serverIp, "serverIp") }),
    ...(input.dkimPrivateKeyPath === undefined || input.dkimPrivateKeyPath === null || input.dkimPrivateKeyPath === "" ? {} : { dkimPrivateKeyPath: dkimPrivateKeyPath(input.dkimPrivateKeyPath, "dkimPrivateKeyPath") }),
    ...(input.selector === undefined || input.selector === null || input.selector === "" ? {} : { selector: selector(input.selector, "selector") })
  }, input), input);
});

export const emailAuthParamSchema = schema<EmailAuthParams>((value) => {
  const input = object(value);
  return withOptionalRepairScope(withOptionalTaskId({
    domain: domain(input.domain, "domain"),
    mxServerIp: ipv4(input.mxServerIp, "mxServerIp"),
    ...(input.zoneId === undefined || input.zoneId === null || input.zoneId === "" ? {} : { zoneId: string(input.zoneId, "zoneId") }),
    ...(input.selector === undefined || input.selector === null || input.selector === "" ? {} : { selector: selector(input.selector, "selector") }),
    ...(input.dmarcPolicy === undefined || input.dmarcPolicy === null || input.dmarcPolicy === "" ? {} : { dmarcPolicy: oneOf(input.dmarcPolicy, "dmarcPolicy", ["none", "quarantine", "reject"] as const) })
  }, input), input);
});

export const bindDomainParamSchema = schema<DomainBindParams>((value) => {
  const input = object(value);
  const hasServerSlug = input.serverSlug !== undefined && input.serverSlug !== null && input.serverSlug !== "";
  const hasServerIp = input.serverIp !== undefined && input.serverIp !== null && input.serverIp !== "";
  if (!hasServerSlug && !hasServerIp) {
    throw new SkillSchemaError("serverSlug or serverIp is required");
  }
  return withOptionalRepairScope(withOptionalTaskId({
    domain: domain(input.domain, "domain"),
    ...(hasServerSlug ? { serverSlug: slug(input.serverSlug, "serverSlug") } : {}),
    ...(hasServerIp ? { serverIp: ipv4(input.serverIp, "serverIp") } : {}),
    ...(input.zoneId === undefined || input.zoneId === null || input.zoneId === "" ? {} : { zoneId: string(input.zoneId, "zoneId") })
  }, input), input);
});

export const warmupSeedParamSchema = schema<WarmupSeedParams>((value) => {
  const input = object(value);
  const seeds = input.seedInboxes ?? input.seedAddresses;
  return withOptionalRepairScope(withOptionalTaskId({
    domain: domain(input.domain, "domain"),
    ...(input.serverSlug === undefined || input.serverSlug === null || input.serverSlug === "" ? {} : { serverSlug: slug(input.serverSlug, "serverSlug") }),
    ...(input.serverIp === undefined || input.serverIp === null || input.serverIp === "" ? {} : { serverIp: ipv4(input.serverIp, "serverIp") }),
    seedInboxes: array(seeds, "seedInboxes", 3, 3).map((entry, index) => email(entry, `seedInboxes[${index}]`))
  }, input), input);
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

export const configureCompleteSmtpSkillParamSchema = schema<ConfigureCompleteSmtpSkillParams>((value) => {
  const input = object(value);
  return {
    ...(input.runId === undefined || input.runId === null || input.runId === "" ? {} : { runId: boundedId(input.runId, "runId", 64) }),
    ...(input.domain === undefined || input.domain === null || input.domain === "" ? {} : { domain: domain(input.domain, "domain") }),
    ...(input.provider === undefined || input.provider === null || input.provider === "" ? {} : { provider: providerId(input.provider, "provider") }),
    // Canal PARALELO HERMANO (DNS multiproveedor): NUNCA va dentro de un step `params:{}`.
    // undefined/"route53" preserva el camino Route53 byte-identico.
    ...(input.dnsProviderId === undefined || input.dnsProviderId === null || input.dnsProviderId === "" ? {} : { dnsProviderId: dnsProviderId(input.dnsProviderId, "dnsProviderId") }),
    // Canal PARALELO HERMANO (5.12 provider): sibling top-level con guarda undefined -> {} (igual que
    // provider/runId). NUNCA va dentro de un step `params:{}`; el orquestador lo enruta por providerId.
    ...(input.vpsProviderId === undefined || input.vpsProviderId === null || input.vpsProviderId === "" ? {} : { vpsProviderId: vpsProviderId(input.vpsProviderId, "vpsProviderId") }),
    ...(input.requireExistingDomain === undefined || input.requireExistingDomain === null ? {} : { requireExistingDomain: boolean(input.requireExistingDomain, "requireExistingDomain") }),
    brand: string(input.brand, "brand"),
    ...(input.intent === undefined || input.intent === null || input.intent === "" ? {} : { intent: string(input.intent, "intent") }),
    budgetUsdMax: input.budgetUsdMax === undefined || input.budgetUsdMax === null
      ? 25
      : integer(input.budgetUsdMax, "budgetUsdMax", 1, 10_000),
    testEmailRecipient: email(input.testEmailRecipient, "testEmailRecipient"),
    testEmailSubject: string(input.testEmailSubject, "testEmailSubject"),
    testEmailBody: string(input.testEmailBody, "testEmailBody"),
    ...(input.seedInboxes === undefined || input.seedInboxes === null
      ? {}
      : { seedInboxes: array(input.seedInboxes, "seedInboxes", 3, 3).map((entry, index) => email(entry, `seedInboxes[${index}]`)) })
  };
});

export const configureCompleteSmtpParamSchema = schema<ConfigureCompleteSmtpParams>((value) => {
  const input = object(value);
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse(input);
  if (!parsed.success) {
    throw new SkillSchemaError(parsed.error.issues[0] ?? "schema_mismatch");
  }
  return {
    ...parsed.data,
    actorId: string(input.actorId, "actorId")
  };
});

export const readEpisodicScratchParamSchema = schema<ReadEpisodicScratchParams>((value) => {
  const input = object(value);
  const output: ReadEpisodicScratchParams = {};
  if (input.intentId !== undefined && input.intentId !== null && input.intentId !== "") {
    output.intentId = boundedId(input.intentId, "intentId", 64);
  }
  if (input.inputHash !== undefined && input.inputHash !== null && input.inputHash !== "") {
    output.inputHash = inputHash(input.inputHash, "inputHash");
  }
  if (input.tool !== undefined && input.tool !== null && input.tool !== "") {
    output.tool = string(input.tool, "tool");
  }
  if (input.outcome !== undefined && input.outcome !== null && input.outcome !== "") {
    output.outcome = scratchOutcome(input.outcome, "outcome");
  }
  if (input.limit !== undefined && input.limit !== null) {
    output.limit = integer(input.limit, "limit", 1, 100);
  }
  if (input.sinceDays !== undefined && input.sinceDays !== null) {
    output.sinceDays = integer(input.sinceDays, "sinceDays", 1, 3650);
  }
  if (input.weighted !== undefined && input.weighted !== null) {
    output.weighted = boolean(input.weighted, "weighted");
  }
  if (input.grounded !== undefined && input.grounded !== null) {
    output.grounded = boolean(input.grounded, "grounded");
  }
  if (input.query !== undefined && input.query !== null && input.query !== "") {
    output.query = boundedText(input.query, "query", 3, 512);
    output.grounded = output.grounded !== false;
  }
  if (input.keywords !== undefined && input.keywords !== null) {
    if (!Array.isArray(input.keywords)) {
      throw new SkillSchemaError("keywords must be an array");
    }
    output.keywords = input.keywords.map((keyword, index) =>
      boundedText(keyword, `keywords[${index}]`, 1, 64)
    ).slice(0, 16);
    if (output.keywords.length > 0) {
      output.grounded = output.grounded !== false;
    }
  }
  if (output.grounded === true && !output.query && !(output.keywords && output.keywords.length > 0)) {
    throw new SkillSchemaError("grounded retrieval requires query or keywords");
  }
  if (!output.intentId && !output.inputHash && !output.tool && !(output.grounded && output.query)) {
    throw new SkillSchemaError("intentId, inputHash, tool or grounded query is required");
  }
  if (output.tool && !output.outcome && output.weighted !== true && output.grounded !== true) {
    throw new SkillSchemaError("tool queries require outcome or weighted=true");
  }
  return output;
});

export const compactIntentParamSchema = schema<CompactIntentParams>((value) => {
  const input = object(value);
  return {
    intentId: boundedId(input.intentId, "intentId", 64),
    finalStatus: oneOf(input.finalStatus, "finalStatus", ["completed", "failed", "cancelled", "rolled_back"] as const),
    decision: compactIntentDecisionText(input.decision, "decision"),
    ...(input.ttlDays === undefined || input.ttlDays === null ? {} : { ttlDays: integer(input.ttlDays, "ttlDays", 1, 365) }),
    steps: array(input.steps, "steps", 1, 50).map((step, index) => {
      const item = object(step, `steps[${index}]`);
      return {
        step: integer(item.step, `steps[${index}].step`, 1, 10_000),
        tool: string(item.tool, `steps[${index}].tool`),
        inputHash: inputHash(item.inputHash, `steps[${index}].inputHash`),
        outcome: scratchOutcome(item.outcome, `steps[${index}].outcome`),
        ...(item.outcomeData === undefined || item.outcomeData === null ? {} : { outcomeData: conformOutcomeData(object(item.outcomeData, `steps[${index}].outcomeData`)) as Record<string, unknown> }),
        ...(item.errorClass === undefined || item.errorClass === null ? {} : { errorClass: boundedText(item.errorClass, `steps[${index}].errorClass`, 1, 128) }),
        ...(item.errorMessage === undefined || item.errorMessage === null ? {} : { errorMessage: machineErrorCode(boundedText(item.errorMessage, `steps[${index}].errorMessage`, 1, 2000)) }),
        ...(item.durationMs === undefined || item.durationMs === null ? {} : { durationMs: integer(item.durationMs, `steps[${index}].durationMs`, 0, 86_400_000) }),
        ...(item.proposalId === undefined || item.proposalId === null ? {} : { proposalId: boundedText(item.proposalId, `steps[${index}].proposalId`, 1, 128) }),
        ...(item.signatureId === undefined || item.signatureId === null ? {} : { signatureId: boundedText(item.signatureId, `steps[${index}].signatureId`, 1, 128) }),
        ...(item.toolUseId === undefined || item.toolUseId === null ? {} : { toolUseId: boundedText(item.toolUseId, `steps[${index}].toolUseId`, 1, 128) }),
        ...(item.toolCallId === undefined || item.toolCallId === null ? {} : { toolCallId: boundedText(item.toolCallId, `steps[${index}].toolCallId`, 1, 128) }),
        ...(item.auditEventId === undefined || item.auditEventId === null ? {} : { auditEventId: boundedText(item.auditEventId, `steps[${index}].auditEventId`, 1, 128) })
      };
    })
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
  const normalized = tryNormalizeStrictDomainName(string(value, field));
  if (!normalized.ok) {
    throw new SkillSchemaError(`${field} must be a valid domain`);
  }
  return normalized.value;
}

const route53ReadRecordTypes = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"] as const;
const mxtoolboxCommands = ["blacklist", "smtp", "mx", "spf", "dkim", "dmarc", "ptr", "a", "txt", "dns", "bimi", "mta-sts"] as const;

function route53ZoneId(value: unknown, field: string): string {
  const normalized = string(value, field).replace(/^\/hostedzone\//, "").toUpperCase();
  if (!/^Z[A-Z0-9]{10,32}$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be a Route53 hosted zone id`);
  }
  return normalized;
}

function dnsRecordName(value: unknown, field: string): string {
  const normalized = string(value, field).toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?)*$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be a valid DNS record name`);
  }
  return normalized;
}

function nameserver(value: unknown, field: string): string {
  const normalized = string(value, field).toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z0-9-]{2,63}$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be a valid nameserver`);
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

function mxtoolboxTarget(value: unknown, field: string): string {
  const raw = string(value, field).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const parts = raw.split(".");
  const maybeIpv4 = parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
  if (maybeIpv4) return parts.map((part) => String(Number(part))).join(".");
  return domain(raw, field);
}

function email(value: unknown, field: string): string {
  const normalized = string(value, field).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be a valid email`);
  }
  return normalized;
}

function slug(value: unknown, field: string): string {
  const normalized = tryNormalizeServerSlug(string(value, field), "serverSlug");
  if (!normalized.ok) {
    throw new SkillSchemaError(`${field} is invalid`);
  }
  return normalized.value;
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

function vpsProviderId(value: unknown, field: string): "webdock" | "contabo" {
  return oneOf(providerId(value, field), field, ["webdock", "contabo"] as const);
}

function dnsProviderId(value: unknown, field: string): "route53" | "ionos" {
  return oneOf(providerId(value, field), field, ["route53", "ionos"] as const);
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

function boundedId(value: unknown, field: string, max: number): string {
  const normalized = string(value, field);
  if (normalized.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) {
    throw new SkillSchemaError(`${field} is invalid`);
  }
  return normalized;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  const normalized = string(value, field);
  if (normalized.length < min || normalized.length > max) {
    throw new SkillSchemaError(`${field} length is invalid`);
  }
  return normalized;
}

function compactIntentDecisionText(value: unknown, field: string): string {
  const normalized = string(value, field);
  if (normalized.length <= 280) {
    return normalized;
  }
  const truncated = normalized.slice(0, 280);
  console.warn("[compact-intent] decision truncated", {
    channel: "tool_schema",
    field,
    originalLength: normalized.length,
    storedLength: truncated.length,
    originalHash: hashText(normalized),
    storedHash: hashText(truncated)
  });
  return truncated;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inputHash(value: unknown, field: string): string {
  const normalized = string(value, field).toLowerCase();
  if (!/^[a-f0-9]{8,64}$/.test(normalized)) {
    throw new SkillSchemaError(`${field} must be 8-64 hex chars`);
  }
  return normalized;
}

function scratchOutcome(value: unknown, field: string) {
  return oneOf(value, field, [
    "success",
    "failed",
    "rolled_back",
    "rollback_failed",
    "cancelled_by_operator",
    "timeout",
    "partial"
  ] as const);
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

function withOptionalRepairScope<T extends Record<string, unknown>>(
  output: T,
  input: Record<string, unknown>
): T {
  const repairReason = optionalBoundedText(input.repairReason, "repairReason", 10, 500);
  const explicitRepairScope = optionalBoundedText(input.explicitRepairScope, "explicitRepairScope", 3, 300);
  return {
    ...output,
    ...(repairReason ? { repairReason } : {}),
    ...(explicitRepairScope ? { explicitRepairScope } : {})
  };
}

function optionalBoundedText(
  value: unknown,
  field: string,
  min: number,
  max: number
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, field, min, max);
}
