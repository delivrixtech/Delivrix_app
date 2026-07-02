import { createHash } from "node:crypto";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

export const entityNotResolvedBlocker = "entity_not_resolved";

export type EntityField = "domain" | "serverSlug" | "serverIp" | "ip";

export interface EntityResolutionFailure {
  blocker: typeof entityNotResolvedBlocker;
  field: EntityField;
  value: string;
  valueClass: "domain" | "webdock_server" | "ip";
  reason: string;
  rawValueHash: string;
  normalized?: string;
  /** Tool a invocar para desbloquear, machine-coded (evita que el agente improvise). */
  nextStep?: string;
  hint?: string;
}

export type EntityResolution<T> =
  | { ok: true; value: T }
  | { ok: false; failure: EntityResolutionFailure };

export interface ResolvedWorkspaceServer {
  serverSlug: string;
  serverIp: string;
}

interface WebdockServersInventory {
  servers?: Array<{
    slug?: string | null;
    hostname?: string | null;
    ipv4?: string | null;
    status?: string | null;
  }>;
}

export function tryNormalizeStrictDomainName(
  value: string,
  field: EntityField = "domain"
): EntityResolution<string> {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253) {
    return unresolved(field, value, "domain", "domain_empty_or_too_long", normalized);
  }
  if (looksLikeTimestampFragment(normalized)) {
    return unresolved(field, value, "domain", "timestamp_fragment_is_not_domain", normalized);
  }
  if (/[/:@\s]/.test(normalized)) {
    return unresolved(field, value, "domain", "domain_contains_invalid_separator", normalized);
  }

  const labels = normalized.split(".");
  if (labels.length < 2) {
    return unresolved(field, value, "domain", "domain_requires_public_suffix", normalized);
  }
  if (!/^[a-z]{2,63}$/.test(labels.at(-1) ?? "")) {
    return unresolved(field, value, "domain", "domain_tld_must_be_alpha", normalized);
  }
  if (!labels.every(isDnsLabel)) {
    return unresolved(field, value, "domain", "domain_label_invalid", normalized);
  }

  return { ok: true, value: normalized };
}

export function tryNormalizeServerSlug(
  value: string,
  field: EntityField = "serverSlug"
): EntityResolution<string> {
  const normalized = decodeURIComponent(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    return unresolved(field, value, "webdock_server", "server_slug_invalid", normalized);
  }
  if (looksLikeTimestampFragment(normalized)) {
    return unresolved(field, value, "webdock_server", "timestamp_fragment_is_not_server_slug", normalized);
  }
  return { ok: true, value: normalized };
}

export function tryNormalizeIpv4Address(value: string, field: EntityField = "ip"): EntityResolution<string> {
  const normalized = value.trim();
  const parts = normalized.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)
  ) {
    return unresolved(field, value, "ip", "ipv4_invalid", normalized);
  }
  return { ok: true, value: parts.map((part) => String(Number(part))).join(".") };
}

export async function resolveWorkspaceServer(
  workspace: Pick<OpenClawWorkspace, "readInventoryJson">,
  rawServerSlug: string
): Promise<EntityResolution<ResolvedWorkspaceServer>> {
  const slug = tryNormalizeServerSlug(rawServerSlug, "serverSlug");
  if (!slug.ok) return slug;

  const inventory = await workspace.readInventoryJson<WebdockServersInventory>("webdock-servers.json").catch(() => null);
  const match = inventory?.servers?.find((server) => server.slug === slug.value);
  if (!match) {
    return {
      ok: false,
      failure: unresolved("serverSlug", rawServerSlug, "webdock_server", "server_slug_not_in_inventory", slug.value, {
        nextStep: "adopt_webdock_server",
        hint: "El server no está en el inventario local (webdock-servers.json), aunque puede ser un huérfano vivo en read_infrastructure_inventory. Antes de provisionar/SSH: adopt_webdock_server y luego ensure_server_ssh_access. No inventes el slug ni saltees esos pasos."
      }).failure
    };
  }

  const ip = typeof match.ipv4 === "string" ? tryNormalizeIpv4Address(match.ipv4, "serverIp") : null;
  if (!ip?.ok) {
    return {
      ok: false,
      failure: unresolved("serverSlug", rawServerSlug, "webdock_server", "server_ip_missing_in_inventory", slug.value).failure
    };
  }

  return {
    ok: true,
    value: {
      serverSlug: slug.value,
      serverIp: ip.value
    }
  };
}

export async function resolveWorkspaceServerIp(
  workspace: Pick<OpenClawWorkspace, "readInventoryJson">,
  rawServerIp: string,
  expectedServerSlug?: string | null
): Promise<EntityResolution<string>> {
  const ip = tryNormalizeIpv4Address(rawServerIp, "serverIp");
  if (!ip.ok) return ip;

  const inventory = await workspace.readInventoryJson<WebdockServersInventory>("webdock-servers.json").catch(() => null);
  const matches: NonNullable<WebdockServersInventory["servers"]> = [];
  for (const server of inventory?.servers ?? []) {
    if (!server.ipv4) continue;
    const serverIp = tryNormalizeIpv4Address(server.ipv4);
    if (serverIp.ok && serverIp.value === ip.value) {
      matches.push(server);
    }
  }
  if (matches.length === 0) {
    return {
      ok: false,
      failure: unresolved("serverIp", rawServerIp, "ip", "server_ip_not_in_inventory", ip.value).failure
    };
  }
  if (expectedServerSlug && !matches.some((server) => server.slug === expectedServerSlug)) {
    return {
      ok: false,
      failure: unresolved("serverIp", rawServerIp, "ip", "server_ip_does_not_match_server_slug", ip.value).failure
    };
  }

  return { ok: true, value: ip.value };
}

export function entityFailureMetadata(failures: EntityResolutionFailure[]): Record<string, unknown> {
  return {
    blocker: entityNotResolvedBlocker,
    failures: failures.map((failure) => ({
      field: failure.field,
      valueClass: failure.valueClass,
      reason: failure.reason,
      rawValueHash: failure.rawValueHash,
      ...(failure.normalized ? { normalized: failure.normalized } : {}),
      ...(failure.nextStep ? { nextStep: failure.nextStep } : {}),
      ...(failure.hint ? { hint: failure.hint } : {})
    }))
  };
}

function unresolved(
  field: EntityField,
  rawValue: string,
  valueClass: EntityResolutionFailure["valueClass"],
  reason: string,
  normalized?: string,
  remediation?: { nextStep: string; hint: string }
): Extract<EntityResolution<never>, { ok: false }> {
  return {
    ok: false,
    failure: {
      blocker: entityNotResolvedBlocker,
      field,
      value: rawValue.slice(0, 160),
      valueClass,
      reason,
      rawValueHash: createHash("sha256").update(rawValue).digest("hex"),
      ...(normalized ? { normalized } : {}),
      ...(remediation ? { nextStep: remediation.nextStep, hint: remediation.hint } : {})
    }
  };
}

function isDnsLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

function looksLikeTimestampFragment(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}t/i.test(value) ||
    /^\d{2,}\.\d{2,}z$/i.test(value) ||
    /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?z?$/i.test(value);
}
