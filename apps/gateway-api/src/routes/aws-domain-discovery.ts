import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53DomainDiscoveryResult,
  AwsRoute53DomainsInventorySource
} from "../../../../packages/adapters/src/index.ts";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";

const skillInvocationHeader = "x-openclaw-skill-invocation";
const auditedSkillInvocations = new Set([
  "aws-domain-discovery",
  "delivrix-domain-discovery",
  "delivrix-infra-inventory",
  "infrastructure-inventory"
]);
const defaultTlds = ["com", "net", "app", "io", "co"];
const maxCandidates = 20;

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface AwsDomainDiscoveryRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  discoverDomains: (input: AwsDomainDiscoveryAdapterInput) => Promise<AwsRoute53DomainDiscoveryResult>;
  now?: () => Date;
}

export interface AwsDomainDiscoveryAdapterInput {
  domainNames: string[];
  suggestionSeed?: string;
  suggestionsLimit?: number;
}

export interface AwsDomainDiscoveryResponse {
  schemaVersion: "2026-05-25.aws-domain-discovery.v1";
  generatedAt: string;
  query: {
    rawName: string;
    candidateNames: string[];
    tlds: string[];
    suggestionsLimit: number;
  };
  source: AwsRoute53DomainDiscoveryResult["source"];
  summary: {
    mode: "discovery_only";
    candidateCount: number;
    availableCount: number;
    suggestionCount: number;
    purchaseEnabled: boolean;
  };
  candidates: AwsRoute53DomainDiscoveryResult["candidates"];
  suggestions: AwsRoute53DomainDiscoveryResult["suggestions"];
  proposal: {
    allowedActions: string[];
    blockedActions: string[];
    requiresApprovalFor: string[];
    recommendedNextStep: string;
  };
}

export async function handleAwsDomainDiscoveryHttp(
  deps: AwsDomainDiscoveryRouteDependencies
): Promise<void> {
  const url = new URL(deps.request.url ?? "/", "http://127.0.0.1");
  const query = parseAwsDomainDiscoveryQuery(url.searchParams);
  const result = await deps.discoverDomains({
    domainNames: query.candidateNames,
    suggestionSeed: query.candidateNames[0],
    suggestionsLimit: query.suggestionsLimit
  });
  const payload = buildAwsDomainDiscoveryResponse({
    query,
    result,
    now: deps.now?.() ?? new Date()
  });

  if (shouldAuditAwsDomainDiscovery(deps.request.headers)) {
    await auditAwsDomainDiscovery(deps.auditLog, payload);
  }

  json(deps.response, 200, payload);
}

export function buildAwsDomainDiscoveryResponse(input: {
  query: ParsedAwsDomainDiscoveryQuery;
  result: AwsRoute53DomainDiscoveryResult;
  now: Date;
}): AwsDomainDiscoveryResponse {
  const availableCount = input.result.candidates.filter((candidate) => candidate.canRegister).length;
  return {
    schemaVersion: "2026-05-25.aws-domain-discovery.v1",
    generatedAt: input.now.toISOString(),
    query: {
      rawName: input.query.rawName,
      candidateNames: input.query.candidateNames,
      tlds: input.query.tlds,
      suggestionsLimit: input.query.suggestionsLimit
    },
    source: input.result.source,
    summary: {
      mode: "discovery_only",
      candidateCount: input.result.candidates.length,
      availableCount,
      suggestionCount: input.result.suggestions.length,
      purchaseEnabled: input.result.source.purchaseEnabled
    },
    candidates: input.result.candidates,
    suggestions: input.result.suggestions,
    proposal: {
      allowedActions: [
        "check_domain_availability",
        "list_domain_prices",
        "get_domain_suggestions",
        "draft_purchase_proposal"
      ],
      blockedActions: input.result.source.purchaseEnabled
        ? ["register_domain_without_approval", "change_dns_without_approval"]
        : ["register_domain", "create_hosted_zone", "change_dns_records"],
      requiresApprovalFor: [
        "register_domain",
        "create_hosted_zone",
        "change_dns_records",
        "update_domain_nameservers"
      ],
      recommendedNextStep: availableCount > 0
        ? "Draft an OpenClaw proposal with selected domain, annual price, allowed TLD, and DNS bootstrap plan."
        : "Review suggestions or adjust TLD list before proposing any purchase."
    }
  };
}

export interface ParsedAwsDomainDiscoveryQuery {
  rawName: string;
  candidateNames: string[];
  tlds: string[];
  suggestionsLimit: number;
}

export function parseAwsDomainDiscoveryQuery(
  params: URLSearchParams
): ParsedAwsDomainDiscoveryQuery {
  const rawName = normalizeDomainInput(params.get("name") ?? params.get("domain") ?? "");
  if (!rawName) {
    throw new AwsDomainDiscoveryInputError("Missing domain name. Use ?name=example or ?name=example.com");
  }

  const requestedTlds = parseTlds(params.get("tlds"));
  const tlds = rawName.includes(".") ? [domainTld(rawName) ?? requestedTlds[0] ?? "com"] : requestedTlds;
  const candidateNames = rawName.includes(".")
    ? [rawName]
    : tlds.map((tld) => `${rawName}.${tld}`);
  const suggestionsLimit = clampNumber(Number(params.get("suggestions") ?? 5), 0, 20);

  if (candidateNames.length === 0 || candidateNames.length > maxCandidates) {
    throw new AwsDomainDiscoveryInputError(`Candidate count must be between 1 and ${maxCandidates}`);
  }

  return {
    rawName,
    candidateNames,
    tlds,
    suggestionsLimit
  };
}

export class AwsDomainDiscoveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsDomainDiscoveryInputError";
  }
}

export function shouldAuditAwsDomainDiscovery(headers: IncomingHttpHeaders): boolean {
  const rawHeader = headers[skillInvocationHeader];
  const skillInvocation = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return typeof skillInvocation === "string" && auditedSkillInvocations.has(skillInvocation);
}

async function auditAwsDomainDiscovery(
  auditLog: AuditSink,
  payload: AwsDomainDiscoveryResponse
): Promise<void> {
  await auditLog.append({
    actorType: "openclaw",
    actorId: "aws-domain-discovery",
    action: "oc.aws.route53domains.discovery",
    targetType: "domain_discovery",
    targetId: payload.query.rawName,
    riskLevel: payload.summary.purchaseEnabled ? "medium" : "low",
    decision: "n/a",
    metadata: {
      candidateCount: payload.summary.candidateCount,
      availableCount: payload.summary.availableCount,
      suggestionCount: payload.summary.suggestionCount,
      sourceKind: payload.source.kind,
      responseOk: payload.source.responseOk,
      purchaseEnabled: payload.summary.purchaseEnabled
    }
  });
}

export function handleAwsDomainDiscoveryError(
  error: unknown,
  response: ServerResponse
): boolean {
  if (!(error instanceof AwsDomainDiscoveryInputError)) {
    return false;
  }
  json(response, 400, {
    error: "invalid_domain_discovery_query",
    message: error.message
  });
  return true;
}

function parseTlds(raw: string | null): string[] {
  const values = (raw ?? defaultTlds.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/^\./, ""))
    .filter((value) => /^[a-z][a-z0-9-]{1,62}$/.test(value));
  return [...new Set(values)].slice(0, maxCandidates);
}

function normalizeDomainInput(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(normalized)) {
    return "";
  }
  if (normalized.split(".").some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) {
    return "";
  }
  return normalized;
}

function domainTld(domainName: string): string | undefined {
  return domainName.split(".").filter(Boolean).at(-1);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}
