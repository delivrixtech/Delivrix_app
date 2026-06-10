import { randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditEvent, AuditEventInput } from "../../../../packages/domain/src/index.ts";
import type { SkillParamSchema, SkillSafeParseResult } from "../skill-schemas.ts";
import {
  DOMAIN_CANDIDATE_PATTERNS,
  PROHIBITED_DOMAIN_WORDS,
  generateCandidates,
  validateDomainNaming
} from "../services/naming-validator.ts";
import { readRequestBody } from "../request-body.ts";

export type SafeDomainIntent = "smtp" | "reporting" | "filing" | "saas" | "ops" | "general";
export type SpamhausDblResult = "clean" | "listed" | "error" | "skipped";

export interface SuggestSafeDomainParams extends Record<string, unknown> {
  brand: string;
  intent: SafeDomainIntent;
  tlds: string[];
  count: number;
  actorId?: string;
}

export interface RegistrarAvailability {
  available: boolean | "unknown";
  priceUsd: number | null;
}

export interface DomainCandidate {
  domain: string;
  available: boolean | "unknown";
  priceUsd: number | null;
  namingScore: number;
  blockedReasons: string[];
  spamhausDBL: SpamhausDblResult;
  registrarOptions: Array<{ registrar: "route53" | "porkbun"; priceUsd: number; available: boolean }>;
  rationale: string;
}

export interface SuggestSafeDomainResult {
  candidates: DomainCandidate[];
  patternsUsed: string[];
  prohibitedWordsFiltered: string[];
  eventId: string;
  durationMs: number;
}

export interface DomainAvailabilityAdapter {
  checkAvailability(domainName: string): Promise<{
    canRegister: boolean;
    registrationPrice?: { amount: number; currency: string };
  }>;
  listPrices(tlds?: string[]): Promise<Array<{
    tld: string;
    registration?: { amount: number; currency: string };
  }>>;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface SuggestSafeDomainDeps {
  auditLog: AuditSink;
  route53Availability: (domain: string) => Promise<RegistrarAvailability>;
  porkbunAvailability: (domain: string) => Promise<RegistrarAvailability>;
  spamhausDBL?: (domain: string) => Promise<Exclude<SpamhausDblResult, "skipped">>;
  now?: () => Date;
}

type ValidationDetails = Record<string, { _errors: string[] }> | { _errors: string[] };

const allowedIntents = ["smtp", "reporting", "filing", "saas", "ops", "general"] as const;
const defaultTlds = ["com", "net", "io", "app"];

export const suggestSafeDomainParamSchema: SkillParamSchema<SuggestSafeDomainParams> = {
  safeParse(value: unknown): SkillSafeParseResult<SuggestSafeDomainParams> {
    try {
      return { success: true, data: parseSuggestSafeDomainParams(value) };
    } catch (error) {
      const details = error instanceof SuggestSafeDomainSchemaError
        ? error.details
        : { _errors: ["schema_mismatch"] };
      return {
        success: false,
        error: {
          issues: flattenDetails(details),
          format: () => details
        }
      };
    }
  }
};

export async function handleSuggestSafeDomainHttp(input: {
  request: IncomingMessage;
  response: ServerResponse;
  deps: SuggestSafeDomainDeps;
}): Promise<void> {
  const startedAt = Date.now();
  let body: unknown;
  try {
    body = await readJsonBody(input.request);
  } catch {
    sendJson(input.response, 400, {
      error: "invalid_json",
      details: { _errors: ["Request body must be valid JSON."] }
    });
    return;
  }

  const parsed = suggestSafeDomainParamSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(input.response, 400, {
      error: "invalid_params",
      details: parsed.error.format()
    });
    return;
  }

  const params = parsed.data;
  if (!params.actorId) {
    sendJson(input.response, 400, {
      error: "invalid_params",
      details: { actorId: { _errors: ["actorId must be a non-empty string"] } }
    });
    return;
  }

  const rawCandidates = generateCandidates({
    brand: params.brand,
    intent: params.intent,
    tlds: params.tlds,
    count: params.count * 4
  });

  const scored = rawCandidates.map((domain) => ({
    domain,
    validation: validateDomainNaming(domain)
  }));

  const passing = scored
    .filter((candidate) => candidate.validation.passes)
    .sort((left, right) => {
      const scoreDiff = right.validation.score - left.validation.score;
      return scoreDiff === 0 ? left.domain.localeCompare(right.domain) : scoreDiff;
    })
    .slice(0, params.count * 2);

  const spamhausCheck = input.deps.spamhausDBL ?? checkSpamhausDBL;
  const spamhausResults = await Promise.all(
    passing.map(async (candidate) => ({
      domain: candidate.domain,
      result: await spamhausCheck(candidate.domain)
    }))
  );
  const spamhausByDomain = new Map(spamhausResults.map((result) => [result.domain, result.result]));
  const stillPassing = passing.filter((candidate) => spamhausByDomain.get(candidate.domain) !== "listed");

  const availabilityPairs = await Promise.all(
    stillPassing.slice(0, params.count).map(async (candidate) => {
      const [route53, porkbun] = await Promise.all([
        input.deps.route53Availability(candidate.domain).catch(() => unknownAvailability()),
        input.deps.porkbunAvailability(candidate.domain).catch(() => unknownAvailability())
      ]);
      return { domain: candidate.domain, route53, porkbun };
    })
  );
  const availabilityByDomain = new Map(availabilityPairs.map((entry) => [entry.domain, entry]));

  const candidates: DomainCandidate[] = stillPassing.slice(0, params.count).map((candidate) => {
    const availability = availabilityByDomain.get(candidate.domain) ?? {
      route53: unknownAvailability(),
      porkbun: unknownAvailability()
    };
    const registrarOptions: DomainCandidate["registrarOptions"] = [];

    if (availability.route53.priceUsd !== null) {
      registrarOptions.push({
        registrar: "route53",
        priceUsd: availability.route53.priceUsd,
        available: availability.route53.available === true
      });
    }

    if (availability.porkbun.priceUsd !== null) {
      registrarOptions.push({
        registrar: "porkbun",
        priceUsd: availability.porkbun.priceUsd,
        available: availability.porkbun.available === true
      });
    }

    const cheapest = registrarOptions.reduce<DomainCandidate["registrarOptions"][number] | null>(
      (current, option) => option.available && (!current || option.priceUsd < current.priceUsd) ? option : current,
      null
    );

    const available = cheapest
      ? true
      : availability.route53.available === false && availability.porkbun.available === false ? false : "unknown";

    return {
      domain: candidate.domain,
      available,
      priceUsd: cheapest?.priceUsd ?? null,
      namingScore: candidate.validation.score,
      blockedReasons: candidate.validation.blockedReasons,
      spamhausDBL: spamhausByDomain.get(candidate.domain) ?? "skipped",
      registrarOptions,
      rationale: buildRationale(candidate.domain, candidate.validation.score, cheapest)
    };
  });

  const event = await input.deps.auditLog.append({
    actorType: "operator",
    actorId: params.actorId,
    action: "oc.naming.candidates_suggested",
    targetType: "domain_naming",
    targetId: params.brand,
    riskLevel: "low",
    decision: "n/a",
    humanApproved: false,
    metadata: {
      brand: params.brand,
      intent: params.intent,
      tlds: params.tlds,
      countRequested: params.count,
      countReturned: candidates.length,
      candidatesReturned: candidates.map((candidate) => candidate.domain),
      blockedReasonsBreakdown: blockedReasonsBreakdown(scored),
      readOnly: true
    }
  });

  sendJson(input.response, 200, {
    candidates,
    patternsUsed: [...DOMAIN_CANDIDATE_PATTERNS],
    prohibitedWordsFiltered: PROHIBITED_DOMAIN_WORDS,
    eventId: eventId(event),
    durationMs: Date.now() - startedAt
  } satisfies SuggestSafeDomainResult);
}

export function createDomainAvailabilityCheck(adapter: DomainAvailabilityAdapter): (domain: string) => Promise<RegistrarAvailability> {
  return async (domain: string) => {
    const tld = domain.split(".").at(-1) ?? "";
    const [candidate, prices] = await Promise.all([
      adapter.checkAvailability(domain),
      adapter.listPrices([tld])
    ]);
    const price = prices.find((entry) => entry.tld === tld);
    return {
      available: candidate.canRegister,
      priceUsd: candidate.registrationPrice?.amount ?? price?.registration?.amount ?? null
    };
  };
}

export async function checkSpamhausDBL(domain: string): Promise<"clean" | "listed" | "error"> {
  try {
    const result = await withTimeout(dns.resolve4(`${domain}.dbl.spamhaus.org`), 2_000);
    return result.length > 0 ? "listed" : "clean";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return "clean";
    }
    return "error";
  }
}

function parseSuggestSafeDomainParams(value: unknown): SuggestSafeDomainParams {
  const input = object(value);
  // El brand es un concepto de marca (lo escribe un humano o el agente), no un
  // identificador estricto. Se normaliza a [a-z0-9] -- minusculas, sin guiones,
  // espacios ni puntuacion -- para construir dominios limpios sin que un guion
  // (p.ej. "corpfiling-infra") tumbe el flujo entero con un HTTP 400. El dominio
  // final NO se deriva del brand (viene del scope firmado del plan), asi que
  // normalizar aqui es seguro: no cambia que dominio se registra.
  const brand = requiredString(input.brand, "brand").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (brand.length < 2 || brand.length > 40) {
    throw fieldError("brand", "brand_must_be_lowercase_alphanumeric");
  }

  const intent = input.intent === undefined || input.intent === null || input.intent === ""
    ? "general"
    : enumValue(input.intent, "intent", allowedIntents);

  const tlds = input.tlds === undefined || input.tlds === null
    ? defaultTlds
    : array(input.tlds, "tlds", 1, 20).map((entry, index) => {
      const tld = requiredString(entry, `tlds[${index}]`);
      if (!/^[a-z]{2,12}$/.test(tld)) {
        throw fieldError(`tlds[${index}]`, "tld_must_be_lowercase_alpha");
      }
      return tld;
    });

  const count = input.count === undefined || input.count === null
    ? 5
    : integer(input.count, "count", 1, 20);

  const actorId = input.actorId === undefined || input.actorId === null || input.actorId === ""
    ? undefined
    : boundedString(input.actorId, "actorId", 1, 120);

  return {
    brand,
    intent,
    tlds,
    count,
    ...(actorId ? { actorId } : {})
  };
}

function buildRationale(
  domain: string,
  score: number,
  cheapest: { registrar: string; priceUsd: number } | null
): string {
  if (!cheapest) {
    return `Naming OK (score ${score}/100) para ${domain}; disponibilidad no confirmada en registrars.`;
  }
  return `Naming OK (score ${score}/100) para ${domain}. Disponible en ${cheapest.registrar} a $${cheapest.priceUsd}/anio, sin palabras flag-spam ni TLD problematico.`;
}

function blockedReasonsBreakdown(
  scored: Array<{ validation: { blockedReasons: string[] } }>
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const candidate of scored) {
    for (const reason of candidate.validation.blockedReasons) {
      breakdown[reason] = (breakdown[reason] ?? 0) + 1;
    }
  }
  return breakdown;
}

function unknownAvailability(): RegistrarAvailability {
  return { available: "unknown", priceUsd: null };
}

function eventId(event: unknown): string {
  if (typeof event === "object" && event !== null && typeof (event as { id?: unknown }).id === "string") {
    return (event as { id: string }).id;
  }
  return randomUUID();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new SyntaxError("empty_json_body");
  }
  return JSON.parse(raw);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SuggestSafeDomainSchemaError({ _errors: ["params must be an object"] });
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw fieldError(field, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function boundedString(value: unknown, field: string, min: number, max: number): string {
  const output = requiredString(value, field);
  if (output.length < min || output.length > max) {
    throw fieldError(field, `${field} must be ${min}-${max} characters`);
  }
  return output;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw fieldError(field, `${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function array(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw fieldError(field, `${field} must be an array with ${min}-${max} item(s)`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw fieldError(field, `${field} must be one of ${allowed.join(", ")}`);
}

function fieldError(field: string, message: string): SuggestSafeDomainSchemaError {
  return new SuggestSafeDomainSchemaError({ [field]: { _errors: [message] } });
}

function flattenDetails(details: ValidationDetails): string[] {
  if ("_errors" in details) {
    return details._errors;
  }
  return Object.values(details).flatMap((entry) => entry._errors);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error("spamhaus_dbl_timeout") as NodeJS.ErrnoException;
          error.code = "ETIMEDOUT";
          reject(error);
        }, timeoutMs);
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class SuggestSafeDomainSchemaError extends Error {
  readonly details: ValidationDetails;

  constructor(details: ValidationDetails) {
    super(flattenDetails(details).join(", "));
    this.name = "SuggestSafeDomainSchemaError";
    this.details = details;
  }
}
