import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { WebdockInventoryResult, WebdockServer } from "../../../../packages/adapters/src/index.ts";
import {
  buildInfrastructureInventoryResponse,
  type AuditEventInput,
  type InfrastructureInventoryResponse,
  type InventoryItem,
  type Provider,
  type ProviderStatus
} from "../../../../packages/domain/src/index.ts";

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
  webdockListServers: () => Promise<WebdockInventoryResult>;
  awsBedrockSetupLogPath?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface BuildInfrastructureInventoryPayloadInput {
  webdock?: WebdockInventoryResult | null;
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
  const webdock = await deps.webdockListServers();
  const payload = await buildInfrastructureInventoryPayload({
    webdock,
    awsBedrockSetupLogPath: deps.awsBedrockSetupLogPath,
    env: deps.env,
    now: deps.now?.() ?? new Date()
  });

  if (shouldAuditInfrastructureInventoryFetch(deps.request.headers)) {
    await auditInfrastructureInventoryFetch(deps.auditLog, payload);
  }

  json(deps.response, 200, payload);
}

export async function buildInfrastructureInventoryPayload(
  input: BuildInfrastructureInventoryPayloadInput = {}
): Promise<InfrastructureInventoryResponse> {
  const providers: Provider[] = [];

  if (input.webdock) {
    providers.push(buildWebdockProvider(input.webdock));
  }

  if (input.includeStaticProviders ?? true) {
    providers.push(await buildAwsBedrockProvider(input.awsBedrockSetupLogPath ?? ".audit/openclaw-bedrock-setup.jsonl"));
    providers.push(buildIonosCloudDnsProvider(input.env ?? process.env));
    providers.push(buildPhysicalServerProvider());
  }

  return buildInfrastructureInventoryResponse({
    providers,
    now: input.now
  });
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
  const itemTotal = payload.providers.reduce((sum, provider) => sum + provider.itemCount, 0);
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

function buildWebdockProvider(webdock: WebdockInventoryResult): Provider {
  const status = resolveWebdockProviderStatus(webdock);
  const errorReason = webdock.source.responseOk ? undefined : webdock.source.errorMessage ?? "webdock_unavailable";
  return {
    id: "webdock-bridge",
    displayName: "Webdock bridge",
    kind: "compute",
    status,
    itemCount: webdock.servers.length,
    lastFetched: webdock.source.fetchedAt,
    fetchSourceKind: webdock.source.kind,
    ...(errorReason ? { errorReason } : {}),
    capabilities: ["list_compute_servers", "get_compute_server_detail"],
    items: webdock.servers.map(webdockServerToInventoryItem)
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

function buildIonosCloudDnsProvider(env: Record<string, string | undefined>): Provider {
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
    capabilities: ["list_dns_zones", "list_dns_records"],
    items: []
  };
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
      createdAt: server.creationDate ?? null,
      lastDataReceived: server.lastDataReceived ?? null,
      snapshotRunTime: server.snapshotRunTime ?? null
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
