import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53DomainsInventoryResult,
  AwsRoute53DomainSummary,
  IonosDnsInventoryResult,
  IonosDnsRecord,
  IonosDnsZone,
  IonosDomainsInventoryResult,
  IonosDomainItem,
  PorkbunInventoryResult,
  PorkbunOwnedDomain,
  WebdockInventoryResult,
  WebdockServer
} from "../../../../packages/adapters/src/index.ts";
import {
  buildInfrastructureInventoryResponse,
  type AuditEventInput,
  type InfrastructureInventoryResponse,
  type InventoryItem,
  type Provider,
  type ProviderStatus
} from "../../../../packages/domain/src/index.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

const infrastructureInventorySkillInvocationHeader = "x-openclaw-skill-invocation";
const auditedSkillInvocations = new Set([
  "delivrix-infra-inventory",
  "infrastructure-inventory",
  "fleet-ops",
  "delivrix-fleet-ops"
]);

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface InfrastructureInventoryRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  readBoundaryToken?: string;
  webdockListServers: () => Promise<WebdockAccountInventoryResult[]>;
  vpsProviderListServers?: () => Promise<VpsProviderInventoryResult[]>;
  awsRoute53DomainsListInventory?: () => Promise<AwsRoute53DomainsInventoryResult>;
  porkbunListInventory?: () => Promise<PorkbunInventoryResult>;
  ionosListDnsInventory?: () => Promise<IonosDnsInventoryResult>;
  ionosListDomainsInventory?: () => Promise<IonosDomainsInventoryResult>;
  awsBedrockSetupLogPath?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface WebdockAccountInventoryResult {
  accountId: string;
  accountLabel: string;
  result: WebdockInventoryResult;
}

export interface VpsProviderInventoryResult {
  providerId: string;
  providerLabel: string;
  result: WebdockInventoryResult;
}

export interface BuildInfrastructureInventoryPayloadInput {
  webdockAccounts?: WebdockAccountInventoryResult[] | null;
  /** Compat legacy para tests/consumidores internos previos a multi-cuenta. */
  webdock?: WebdockInventoryResult | null;
  vpsProviders?: VpsProviderInventoryResult[] | null;
  awsRoute53Domains?: AwsRoute53DomainsInventoryResult | null;
  porkbun?: PorkbunInventoryResult | null;
  ionosDns?: IonosDnsInventoryResult | null;
  ionosDomains?: IonosDomainsInventoryResult | null;
  awsBedrockSetupLogPath?: string | null;
  env?: Record<string, string | undefined>;
  includeStaticProviders?: boolean;
  now?: Date;
}

interface AwsBedrockSetupSummary {
  occurredAt: string;
  region: string;
  model: string;
  budgetConfigured: boolean;
}

export async function handleInfrastructureInventoryHttp(
  deps: InfrastructureInventoryRouteDependencies
): Promise<void> {
  const isSkillInvocation = shouldAuditInfrastructureInventoryFetch(deps.request.headers);
  if (isSkillInvocation) {
    const auth = authorizeSensitiveRead(deps.request, { readBoundaryToken: deps.readBoundaryToken }, "infrastructure_inventory");
    if (!auth.ok) {
      json(deps.response, auth.statusCode, {
        error: auth.error,
        message: "Missing or invalid read-boundary token for OpenClaw infrastructure inventory read."
      });
      return;
    }
  }

  const [
    webdockAccountsResult,
    vpsProvidersResult,
    ionosDnsResult,
    ionosDomainsResult,
    awsRoute53DomainsResult,
    porkbunResult
  ] = await Promise.allSettled([
    deps.webdockListServers(),
    deps.vpsProviderListServers ? deps.vpsProviderListServers() : Promise.resolve([]),
    deps.ionosListDnsInventory ? deps.ionosListDnsInventory() : Promise.resolve(null),
    deps.ionosListDomainsInventory ? deps.ionosListDomainsInventory() : Promise.resolve(null),
    deps.awsRoute53DomainsListInventory ? deps.awsRoute53DomainsListInventory() : Promise.resolve(null),
    deps.porkbunListInventory ? deps.porkbunListInventory() : Promise.resolve(null)
  ]);
  const payload = await buildInfrastructureInventoryPayload({
    webdockAccounts: settledValue(webdockAccountsResult, []),
    vpsProviders: settledValue(vpsProvidersResult, []),
    ionosDns: settledValue(ionosDnsResult, null),
    ionosDomains: settledValue(ionosDomainsResult, null),
    awsRoute53Domains: settledValue(awsRoute53DomainsResult, null),
    porkbun: settledValue(porkbunResult, null),
    awsBedrockSetupLogPath: deps.awsBedrockSetupLogPath,
    env: deps.env,
    now: deps.now?.() ?? new Date()
  });

  if (isSkillInvocation) {
    await auditInfrastructureInventoryFetch(deps.auditLog, payload);
  }

  json(deps.response, 200, payload);
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

export async function buildInfrastructureInventoryPayload(
  input: BuildInfrastructureInventoryPayloadInput = {}
): Promise<InfrastructureInventoryResponse> {
  const providers: Provider[] = [];
  const webdockAccounts = dedupeWebdockInventoryAccounts(
    input.webdockAccounts ??
    (input.webdock
      ? [{
          accountId: input.webdock.source.accountId ?? "default",
          accountLabel: input.webdock.source.accountLabel ?? "Webdock",
          result: input.webdock
        }]
      : [])
  );

  for (const account of webdockAccounts) {
    providers.push(buildWebdockProvider(account));
  }

  const vpsProviders = input.vpsProviders ?? [];
  for (const provider of vpsProviders) {
    providers.push(buildExternalVpsProvider(provider));
  }

  if (input.includeStaticProviders ?? true) {
    providers.push(await buildAwsBedrockProvider(input.awsBedrockSetupLogPath ?? ".audit/openclaw-bedrock-setup.jsonl"));
    providers.push(buildAwsRoute53DomainsProvider(input.env ?? process.env, input.awsRoute53Domains));
    providers.push(buildPorkbunDomainsProvider(input.env ?? process.env, input.porkbun));
    providers.push(buildIonosCloudDnsProvider(input.env ?? process.env, input.ionosDns));
    providers.push(buildIonosDomainsProvider(input.env ?? process.env, input.ionosDomains));
    providers.push(buildPhysicalServerProvider());
  }

  return buildInfrastructureInventoryResponse({
    providers,
    now: input.now
  });
}

const cuenta1WebdockRoleIds = new Set(["primary", "ops", "account", "default"]);
const cuenta1WebdockRolePriority = ["primary", "ops", "account", "default"];

function dedupeWebdockInventoryAccounts(accounts: WebdockAccountInventoryResult[]): WebdockAccountInventoryResult[] {
  const cuenta1Accounts = accounts.filter((account) => cuenta1WebdockRoleIds.has(account.accountId.toLowerCase()));
  if (cuenta1Accounts.length <= 1) {
    return accounts;
  }

  const otherAccounts = accounts.filter((account) => !cuenta1WebdockRoleIds.has(account.accountId.toLowerCase()));
  const selected = [...cuenta1Accounts].sort(compareCuenta1WebdockAccounts)[0];
  return [selected, ...otherAccounts];
}

function compareCuenta1WebdockAccounts(a: WebdockAccountInventoryResult, b: WebdockAccountInventoryResult): number {
  const aHealthy = a.result.source.responseOk ? 0 : 1;
  const bHealthy = b.result.source.responseOk ? 0 : 1;
  if (aHealthy !== bHealthy) return aHealthy - bHealthy;
  return cuenta1WebdockRolePriority.indexOf(a.accountId.toLowerCase()) -
    cuenta1WebdockRolePriority.indexOf(b.accountId.toLowerCase());
}

export function shouldAuditInfrastructureInventoryFetch(headers: IncomingHttpHeaders): boolean {
  const rawHeader = headers[infrastructureInventorySkillInvocationHeader];
  const skillInvocation = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return typeof skillInvocation === "string" && auditedSkillInvocations.has(skillInvocation);
}

export async function auditInfrastructureInventoryFetch(
  auditLog: AuditSink,
  payload: InfrastructureInventoryResponse
): Promise<void> {
  const itemTotal = payload.itemTotal;
  const providerStatuses = summarizeBy(payload.providers, (provider) => provider.status);
  const providerKinds = summarizeBy(payload.providers, (provider) => provider.kind);
  const sourceKinds = summarizeBy(payload.providers, (provider) => provider.fetchSourceKind ?? "none");
  const errorProviderCount = payload.providers.filter((provider) => provider.status === "error").length;

  await auditLog.append({
    actorType: "openclaw",
    actorId: "delivrix-infra-inventory",
    action: "oc.infrastructure.inventory.fetch",
    targetType: "infrastructure_inventory",
    targetId: "all",
    riskLevel: errorProviderCount > 0 ? "medium" : "low",
    decision: "n/a",
    metadata: {
      providerCount: payload.providers.length,
      itemTotal,
      providerStatuses,
      providerKinds,
      sourceKinds,
      errorProviderCount
    }
  });
}

function buildWebdockProvider(account: WebdockAccountInventoryResult): Provider {
  const webdock = account.result;
  const status = resolveWebdockProviderStatus(webdock);
  const visibleServers = webdock.source.responseOk ? webdock.servers : [];
  const errorReason = webdock.source.responseOk ? undefined : webdock.source.errorMessage ?? "webdock_unavailable";
  return {
    id: `webdock-${sanitizeProviderId(account.accountId)}`,
    displayName: account.accountLabel,
    kind: "compute",
    status,
    itemCount: visibleServers.length,
    lastFetched: webdock.source.fetchedAt,
    fetchSourceKind: webdock.source.kind,
    ...(errorReason ? { errorReason } : {}),
    capabilities: ["list_compute_servers", "get_compute_server_detail"],
    items: visibleServers.map(webdockServerToInventoryItem)
  };
}

function buildExternalVpsProvider(provider: VpsProviderInventoryResult): Provider {
  const inventory = provider.result;
  const status = resolveExternalVpsProviderStatus(inventory);
  const visibleServers = inventory.source.responseOk ? inventory.servers : [];
  const hasServers = visibleServers.length > 0;
  const errorReason = inventory.source.responseOk
    ? undefined
    : inventory.source.errorMessage ?? `${provider.providerId}_unavailable`;
  return {
    id: sanitizeProviderId(provider.providerId),
    displayName: provider.providerLabel,
    kind: "compute",
    status,
    ...(status === "active" && !hasServers ? { statusLabel: "Conectado sin VPS" } : {}),
    itemCount: visibleServers.length,
    lastFetched: inventory.source.fetchedAt,
    fetchSourceKind: inventory.source.kind,
    ...(errorReason ? { errorReason } : {}),
    capabilities: [
      "list_compute_servers",
      "get_compute_server_detail",
      "provision_vps_requires_approval"
    ],
    items: visibleServers.map((server) => externalVpsServerToInventoryItem(provider.providerId, server))
  };
}

async function buildAwsBedrockProvider(setupLogPath: string): Promise<Provider> {
  const setup = await readAwsBedrockSetupSummary(setupLogPath);
  if (!setup) {
    return {
      id: "aws-bedrock-us-east-1",
      displayName: "AWS Bedrock us-east-1",
      kind: "compute",
      status: "planned",
      itemCount: 0,
      lastFetched: null,
      fetchSourceKind: "mock",
      errorReason: "creds_not_configured",
      capabilities: ["read_model_config", "read_budget_gate"],
      items: []
    };
  }

  return {
    id: "aws-bedrock-us-east-1",
    displayName: `AWS Bedrock ${setup.region}`,
    kind: "compute",
    status: "active",
    itemCount: 1,
    lastFetched: setup.occurredAt,
    fetchSourceKind: "live",
    capabilities: ["read_model_config", "read_budget_gate"],
    items: [{
      id: setup.model,
      kind: "bedrock_model",
      displayName: setup.model,
      status: "active",
      detail: {
        region: setup.region,
        budgetConfigured: setup.budgetConfigured
      }
    }]
  };
}

function buildAwsRoute53DomainsProvider(
  env: Record<string, string | undefined>,
  awsRoute53Domains?: AwsRoute53DomainsInventoryResult | null
): Provider {
  if (awsRoute53Domains) {
    const status = resolveAwsRoute53DomainsStatus(awsRoute53Domains);
    const errorReason = awsRoute53Domains.source.responseOk
      ? undefined
      : awsRoute53Domains.source.errorMessage ?? "aws_route53_domains_unavailable";
    return {
      id: "aws-route53-domains",
      displayName: "AWS Route 53 Domains",
      kind: "domain-registrar",
      status,
      itemCount: awsRoute53Domains.domains.length,
      lastFetched: awsRoute53Domains.source.fetchedAt,
      fetchSourceKind: awsRoute53Domains.source.kind,
      ...(errorReason ? { errorReason } : {}),
      capabilities: awsRoute53DomainsCapabilities(env),
      items: awsRoute53Domains.domains.map(awsRoute53DomainToInventoryItem)
    };
  }

  const hasCreds = hasAwsRoute53DomainsCreds(env);
  return {
    id: "aws-route53-domains",
    displayName: "AWS Route 53 Domains",
    kind: "domain-registrar",
    status: hasCreds ? "error" : "planned",
    itemCount: 0,
    lastFetched: null,
    fetchSourceKind: "mock",
    errorReason: hasCreds ? "adapter_pending" : "creds_not_configured",
    capabilities: awsRoute53DomainsCapabilities(env),
    items: []
  };
}

function buildIonosCloudDnsProvider(
  env: Record<string, string | undefined>,
  ionosDns?: IonosDnsInventoryResult | null
): Provider {
  if (ionosDns) {
    const status = resolveIonosProviderStatus(ionosDns);
    const errorReason = ionosDns.source.responseOk
      ? undefined
      : ionosDns.source.errorMessage ?? "ionos_dns_unavailable";
    return {
      id: "ionos-cloud-dns",
      displayName: "IONOS Cloud DNS",
      kind: "dns",
      status,
      itemCount: ionosDns.zones.length,
      lastFetched: ionosDns.source.fetchedAt,
      fetchSourceKind: ionosDns.source.kind,
      ...(errorReason ? { errorReason } : {}),
      capabilities: [
        "list_dns_zones",
        "list_dns_records",
        "propose_dns_record_change_requires_approval"
      ],
      items: ionosDns.zones.map(ionosZoneToInventoryItem)
    };
  }

  const hasToken = Boolean(env.IONOS_API_TOKEN || env.IONOS_CLOUD_DNS_TOKEN);
  return {
    id: "ionos-cloud-dns",
    displayName: "IONOS Cloud DNS",
    kind: "dns",
    status: hasToken ? "error" : "planned",
    itemCount: 0,
    lastFetched: null,
    fetchSourceKind: "mock",
    errorReason: hasToken ? "adapter_pending" : "creds_not_configured",
    capabilities: [
      "list_dns_zones",
      "list_dns_records",
      "propose_dns_record_change_requires_approval"
    ],
    items: []
  };
}

function hasAwsRoute53DomainsCreds(env: Record<string, string | undefined>): boolean {
  return Boolean(
    (env.AWS_ROUTE53_DOMAINS_ACCESS_KEY_ID || env.AWS_ROUTE53_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID) &&
    (env.AWS_ROUTE53_DOMAINS_SECRET_ACCESS_KEY || env.AWS_ROUTE53_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY)
  );
}

function awsRoute53DomainsCapabilities(env: Record<string, string | undefined>): string[] {
  const capabilities = [
    "list_registered_domains",
    "check_domain_availability",
    "get_domain_suggestions",
    "list_domain_prices",
    "draft_domain_purchase_proposal"
  ];
  if (env.AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE === "true" || env.AWS_ROUTE53_ENABLE_PURCHASE === "true") {
    capabilities.push("register_domain_requires_approval");
  }
  return capabilities;
}

function buildPorkbunDomainsProvider(
  env: Record<string, string | undefined>,
  porkbun?: PorkbunInventoryResult | null
): Provider {
  if (porkbun) {
    const status = resolvePorkbunDomainsProviderStatus(porkbun);
    const errorReason = porkbun.source.responseOk
      ? undefined
      : porkbun.source.errorMessage ?? "porkbun_domains_unavailable";
    return {
      id: "porkbun-domains",
      displayName: "Porkbun Domains",
      kind: "domain-registrar",
      status,
      itemCount: porkbun.domains.length,
      lastFetched: porkbun.source.fetchedAt,
      fetchSourceKind: porkbun.source.kind,
      ...(errorReason ? { errorReason } : {}),
      capabilities: porkbunDomainsCapabilities(env, porkbun.source.purchaseEnabled),
      items: porkbun.domains.map(porkbunDomainToInventoryItem)
    };
  }

  const hasCreds = hasPorkbunCreds(env);
  return {
    id: "porkbun-domains",
    displayName: "Porkbun Domains",
    kind: "domain-registrar",
    status: hasCreds ? "error" : "planned",
    itemCount: 0,
    lastFetched: null,
    fetchSourceKind: "mock",
    errorReason: hasCreds ? "adapter_pending" : "creds_not_configured",
    capabilities: porkbunDomainsCapabilities(env, false),
    items: []
  };
}

function hasPorkbunCreds(env: Record<string, string | undefined>): boolean {
  return Boolean(env.PORKBUN_API_KEY && (env.PORKBUN_SECRET_API_KEY || env.PORKBUN_SECRETAPIKEY));
}

function porkbunDomainsCapabilities(
  env: Record<string, string | undefined>,
  purchaseEnabled: boolean
): string[] {
  const capabilities = [
    "list_registered_domains",
    "check_domain_availability",
    "list_domain_prices",
    "draft_domain_purchase_proposal",
    "compare_registrar_prices"
  ];
  if (purchaseEnabled || env.PORKBUN_ENABLE_PURCHASE === "true") {
    capabilities.push("register_domain_requires_approval");
  }
  return capabilities;
}

function buildIonosDomainsProvider(
  env: Record<string, string | undefined>,
  ionosDomains?: IonosDomainsInventoryResult | null
): Provider {
  if (ionosDomains) {
    const status = resolveIonosDomainsProviderStatus(ionosDomains);
    const errorReason = ionosDomains.source.responseOk
      ? undefined
      : ionosDomains.source.errorMessage ?? "ionos_domains_unavailable";
    return {
      id: "ionos-domains",
      displayName: "IONOS Domains",
      kind: "domain-registrar",
      status,
      itemCount: ionosDomains.domains.length,
      lastFetched: ionosDomains.source.fetchedAt,
      fetchSourceKind: ionosDomains.source.kind,
      ...(errorReason ? { errorReason } : {}),
      capabilities: [
        "list_domains",
        "read_domain_nameservers",
        "read_domain_statuses",
        "propose_domain_change_requires_approval",
        "propose_nameserver_change_requires_approval"
      ],
      items: ionosDomains.domains.map(ionosDomainToInventoryItem)
    };
  }

  const hasApiKey = hasIonosDomainsApiKey(env);
  const hasTenant = Boolean(env.IONOS_DOMAINS_TENANT_ID || env.IONOS_TENANT_ID);
  return {
    id: "ionos-domains",
    displayName: "IONOS Domains",
    kind: "domain-registrar",
    status: hasApiKey ? "error" : "planned",
    itemCount: 0,
    lastFetched: null,
    fetchSourceKind: "mock",
    errorReason: hasApiKey && !hasTenant ? "adapter_pending" : "creds_not_configured",
    capabilities: [
      "list_domains",
      "read_domain_nameservers",
      "read_domain_statuses",
      "propose_domain_change_requires_approval",
      "propose_nameserver_change_requires_approval"
    ],
    items: []
  };
}

function hasIonosDomainsApiKey(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.IONOS_DNS_API_KEY ||
    env.IONOS_DOMAINS_API_KEY ||
    env.IONOS_HOSTING_API_KEY ||
    env.IONOS_DEVELOPER_API_KEY
  );
}

function buildPhysicalServerProvider(): Provider {
  return {
    id: "physical-medellin",
    displayName: "Servidor fisico Medellin",
    kind: "physical",
    status: "planned",
    itemCount: 0,
    lastFetched: null,
    fetchSourceKind: null,
    errorReason: "not_online_yet",
    capabilities: ["plan_physical_host"],
    items: []
  };
}

async function readAwsBedrockSetupSummary(filePath: string): Promise<AwsBedrockSetupSummary | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    const parsed = parseJson(line);
    if (!isRecord(parsed) || parsed.action !== "oc.provider.switched") {
      continue;
    }
    const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
    if (metadata.toProvider !== "amazon-bedrock") {
      continue;
    }
    return {
      occurredAt: stringValue(parsed.occurredAt) ?? new Date(0).toISOString(),
      region: stringValue(metadata.awsRegion) ?? "us-east-1",
      model: stringValue(metadata.toModel) ?? "amazon-bedrock-model",
      budgetConfigured: metadata.budgetActionConfigured === true
    };
  }

  return null;
}

function webdockServerToInventoryItem(server: WebdockServer): InventoryItem {
  return {
    id: server.slug,
    kind: "webdock_server",
    displayName: server.name || server.slug,
    status: server.status,
    detail: {
      location: server.location ?? null,
      profileSlug: server.profileSlug ?? null,
      imageSlug: server.imageSlug ?? null,
      ipv4: server.ipv4?.trim() || null,
      accountId: server.accountId ?? null,
      accountLabel: server.accountLabel ?? null,
      createdAt: server.creationDate ?? null,
      lastDataReceived: server.lastDataReceived ?? null,
      snapshotRunTime: server.snapshotRunTime ?? null
    }
  };
}

function externalVpsServerToInventoryItem(providerId: string, server: WebdockServer): InventoryItem {
  const item = webdockServerToInventoryItem(server);
  return {
    ...item,
    kind: `${sanitizeProviderId(providerId)}_server`,
    detail: {
      ...item.detail,
      providerId
    }
  };
}

function awsRoute53DomainToInventoryItem(domain: AwsRoute53DomainSummary): InventoryItem {
  return {
    id: domain.domainName,
    kind: "aws_route53_domain",
    displayName: domain.domainName,
    status: "active",
    detail: {
      autoRenew: domain.autoRenew ?? null,
      transferLock: domain.transferLock ?? null,
      expiry: domain.expiry ?? null
    }
  };
}

function porkbunDomainToInventoryItem(domain: PorkbunOwnedDomain): InventoryItem {
  return {
    id: domain.domainName,
    kind: "porkbun_domain",
    displayName: domain.domainName,
    status: normalizePorkbunDomainStatus(domain),
    detail: {
      tld: domain.tld,
      status: domain.status ?? null,
      createdAt: domain.createdAt ?? null,
      expiry: domain.expiry ?? null,
      autoRenew: domain.autoRenew ?? null,
      whoisPrivacy: domain.whoisPrivacy ?? null
    }
  };
}

function ionosZoneToInventoryItem(zone: IonosDnsZone): InventoryItem {
  const status = normalizeIonosState(zone.state, zone.enabled);
  return {
    id: zone.id,
    kind: "ionos_dns_zone",
    displayName: zone.name,
    status,
    detail: {
      zoneType: zone.type ?? null,
      enabled: zone.enabled ?? null,
      state: zone.state ?? null,
      recordCount: zone.records.length,
      records: zone.records.map(ionosRecordToPublicDetail)
    }
  };
}

function ionosRecordToPublicDetail(record: IonosDnsRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    status: normalizeIonosState(record.state, record.enabled),
    state: record.state ?? null,
    enabled: record.enabled ?? null,
    ttl: record.ttl ?? null,
    priority: record.priority ?? null,
    contentPreview: dnsRecordContentPreview(record)
  };
}

function ionosDomainToInventoryItem(domain: IonosDomainItem): InventoryItem {
  return {
    id: domain.id,
    kind: "ionos_domain",
    displayName: domain.name,
    status: normalizeDomainStatus(domain),
    detail: {
      idn: domain.idn ?? null,
      type: domain.type ?? null,
      contract: domain.contract ?? null,
      status: domain.status ?? null,
      statusGroup: domain.statusGroup ?? null,
      provisioningStatus: domain.provisioningStatus ?? null,
      pendingProvisioning: domain.pendingProvisioning ?? null,
      expiresAt: domain.expiresAt ?? null,
      domainLock: domain.domainLock ?? null,
      transferLock: domain.transferLock ?? null,
      autoRenew: domain.autoRenew ?? null,
      privacyEnabled: domain.privacyEnabled ?? null,
      dnssecEnabled: domain.dnssecEnabled ?? null,
      nameservers: domain.nameservers.map((nameserver) => ({
        name: nameserver.name,
        ipV4AddressCount: nameserver.ipV4Addresses?.length ?? 0,
        ipV6AddressCount: nameserver.ipV6Addresses?.length ?? 0
      }))
    }
  };
}

function resolveWebdockProviderStatus(webdock: WebdockInventoryResult): ProviderStatus {
  if (!webdock.source.responseOk) {
    return "error";
  }
  if (webdock.servers.length === 0) {
    return "planned";
  }
  if (webdock.servers.some((server) => server.status === "running")) {
    return "active";
  }
  return "paused";
}

function resolveExternalVpsProviderStatus(inventory: WebdockInventoryResult): ProviderStatus {
  if (!inventory.source.responseOk) {
    return "error";
  }
  return "active";
}

function resolveAwsRoute53DomainsStatus(
  awsRoute53Domains: AwsRoute53DomainsInventoryResult
): ProviderStatus {
  if (!awsRoute53Domains.source.responseOk) {
    return "error";
  }
  if (awsRoute53Domains.domains.length === 0) {
    return "planned";
  }
  return "active";
}

function resolvePorkbunDomainsProviderStatus(porkbun: PorkbunInventoryResult): ProviderStatus {
  if (!porkbun.source.responseOk) {
    return "error";
  }
  if (porkbun.domains.length === 0) {
    return "planned";
  }
  return "active";
}

function resolveIonosProviderStatus(ionosDns: IonosDnsInventoryResult): ProviderStatus {
  if (!ionosDns.source.responseOk) {
    return "error";
  }
  if (ionosDns.zones.length === 0) {
    return "planned";
  }
  if (ionosDns.zones.some((zone) => normalizeIonosState(zone.state, zone.enabled) === "active")) {
    return "active";
  }
  return "paused";
}

function resolveIonosDomainsProviderStatus(
  ionosDomains: IonosDomainsInventoryResult
): ProviderStatus {
  if (!ionosDomains.source.responseOk) {
    return "error";
  }
  if (ionosDomains.domains.length === 0) {
    return "planned";
  }
  if (ionosDomains.domains.some((domain) => normalizeDomainStatus(domain) === "active")) {
    return "active";
  }
  return "paused";
}

function normalizeDomainStatus(domain: IonosDomainItem): string {
  const status = (domain.status ?? domain.statusGroup ?? domain.provisioningStatus ?? "").toLowerCase();
  if (status.includes("fail") || status.includes("error")) return "error";
  if (status.includes("pending") || status.includes("provision")) return "provisioning";
  if (status.includes("lock") || status.includes("suspend") || status.includes("hold")) return "paused";
  if (!status || status.includes("active") || status.includes("ok")) return "active";
  return status;
}

function normalizePorkbunDomainStatus(domain: PorkbunOwnedDomain): string {
  const status = (domain.status ?? "").toLowerCase();
  if (status.includes("fail") || status.includes("error")) return "error";
  if (status.includes("hold") || status.includes("lock") || status.includes("suspend")) return "paused";
  if (!status || status.includes("active") || status.includes("ok")) return "active";
  return status;
}

function normalizeIonosState(state: string | undefined, enabled: boolean | undefined): string {
  if (state === "FAILED") return "error";
  if (state === "PROVISIONING" || state === "DESTROYING") return state.toLowerCase();
  if (enabled === false) return "paused";
  if (state === "AVAILABLE" || state === undefined) return "active";
  return state.toLowerCase();
}

function dnsRecordContentPreview(record: IonosDnsRecord): string | null {
  if (!record.content) {
    return null;
  }
  if (record.type.toUpperCase() === "TXT") {
    return `[redacted-txt:${record.content.length}]`;
  }
  return record.content;
}

function sanitizeProviderId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return normalized.length > 0 ? normalized : "default";
}

function summarizeBy<T extends string>(
  providers: Provider[],
  selector: (provider: Provider) => T
): Record<T, number> {
  const summary = {} as Record<T, number>;
  for (const provider of providers) {
    const key = selector(provider);
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
