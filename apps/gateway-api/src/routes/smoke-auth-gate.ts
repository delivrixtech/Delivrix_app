import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export type SmokeAuthGateCheckName = "smtp_a" | "spf" | "dkim" | "dmarc" | "ptr" | "fcrdns";
export type SmokeAuthGateFailureName = SmokeAuthGateCheckName | "invalid_precondition";

export interface SmokeAuthDnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolveTxt(hostname: string): Promise<string[][]>;
  reverse(ip: string): Promise<string[]>;
}

export interface SmokeAuthGateCheck {
  ok: boolean;
  expected?: unknown;
  observed?: unknown;
  error?: string;
}

export interface SmokeAuthGateResult {
  ok: boolean;
  missing: SmokeAuthGateFailureName[];
  checks: Record<SmokeAuthGateCheckName, SmokeAuthGateCheck>;
  error?: string;
}

export const defaultSmokeAuthDnsResolver: SmokeAuthDnsResolver = {
  resolve4: (hostname) => dns.resolve4(hostname),
  resolveTxt: (hostname) => dns.resolveTxt(hostname),
  reverse: (ip) => dns.reverse(ip)
};

export async function verifySmokeAuthGate(input: {
  domain: string;
  smtpHost: string;
  serverIpv4: string;
  selector: string;
  resolver?: SmokeAuthDnsResolver;
}): Promise<SmokeAuthGateResult> {
  const resolver = input.resolver ?? defaultSmokeAuthDnsResolver;
  const domain = normalizeDnsName(input.domain);
  const smtpHost = normalizeDnsName(input.smtpHost);
  const serverIpv4 = input.serverIpv4.trim();
  const selector = input.selector.trim().toLowerCase() || "s2026a";
  const expectedPtr = `${smtpHost}.`;
  const checks: Record<SmokeAuthGateCheckName, SmokeAuthGateCheck> = {
    smtp_a: { ok: false },
    spf: { ok: false },
    dkim: { ok: false },
    dmarc: { ok: false },
    ptr: { ok: false },
    fcrdns: { ok: false }
  };
  const preconditionError = smokeAuthPreconditionError({ domain, smtpHost, serverIpv4 });
  if (preconditionError) {
    return {
      ok: false,
      missing: ["invalid_precondition"],
      checks: smokeAuthPreconditionChecks(checks, preconditionError, { domain, smtpHost, serverIpv4 }),
      error: preconditionError
    };
  }

  let smtpA: string[] = [];
  try {
    smtpA = await resolver.resolve4(smtpHost);
    checks.smtp_a = {
      ok: smtpA.length === 1 && smtpA[0] === serverIpv4,
      expected: { host: smtpHost, ipv4: serverIpv4, mode: "exact_single_a" },
      observed: smtpA
    };
  } catch (error) {
    checks.smtp_a = {
      ok: false,
      expected: { host: smtpHost, ipv4: serverIpv4, mode: "exact_single_a" },
      error: errorMessage(error)
    };
  }

  try {
    const spfRecords = flattenTxt(await resolver.resolveTxt(domain))
      .filter((entry) => /^v=spf1\b/i.test(entry.trim()));
    checks.spf = {
      ok: spfRecords.some((record) => spfRecordIncludesIpv4(record, serverIpv4)),
      expected: `ip4:${serverIpv4}`,
      observed: spfRecords
    };
  } catch (error) {
    checks.spf = {
      ok: false,
      expected: `ip4:${serverIpv4}`,
      error: errorMessage(error)
    };
  }

  try {
    const dkimRecords = flattenTxt(await resolver.resolveTxt(`${selector}._domainkey.${domain}`))
      .filter((entry) => /(^|;|\s)v\s*=\s*dkim1\b/i.test(entry));
    const dkim = dkimRecords.find((record) => dkimRecordHasPublicKey(record));
    checks.dkim = {
      ok: Boolean(dkim),
      expected: { selector, publicKey: "non_empty_p" },
      observed: {
        recordCount: dkimRecords.length,
        hasPublicKey: Boolean(dkim)
      }
    };
  } catch (error) {
    checks.dkim = {
      ok: false,
      expected: { selector, publicKey: "non_empty_p" },
      error: errorMessage(error)
    };
  }

  try {
    const dmarcRecords = flattenTxt(await resolver.resolveTxt(`_dmarc.${domain}`))
      .filter((entry) => /^v=DMARC1\b/i.test(entry.trim()));
    checks.dmarc = {
      ok: dmarcRecords.length > 0,
      expected: `v=DMARC1 at _dmarc.${domain}`,
      observed: dmarcRecords
    };
  } catch (error) {
    checks.dmarc = {
      ok: false,
      expected: `v=DMARC1 at _dmarc.${domain}`,
      error: errorMessage(error)
    };
  }

  let ptrHostnames: string[] = [];
  try {
    ptrHostnames = (await resolver.reverse(serverIpv4)).map(normalizeDnsName);
    checks.ptr = {
      ok: ptrHostnames.includes(smtpHost),
      expected: expectedPtr,
      observed: ptrHostnames.map((value) => `${value}.`)
    };
  } catch (error) {
    checks.ptr = {
      ok: false,
      expected: expectedPtr,
      error: errorMessage(error)
    };
  }

  const ptrForwardA: Record<string, string[]> = {};
  for (const ptrHostname of ptrHostnames) {
    try {
      ptrForwardA[ptrHostname] = await resolver.resolve4(ptrHostname);
    } catch {
      ptrForwardA[ptrHostname] = [];
    }
  }
  checks.fcrdns = {
    ok: checks.ptr.ok && Boolean(ptrForwardA[smtpHost]?.includes(serverIpv4)),
    expected: { ptr: expectedPtr, forwardIp: serverIpv4 },
    observed: ptrForwardA
  };

  const missing = (Object.keys(checks) as SmokeAuthGateCheckName[])
    .filter((check) => !checks[check].ok);
  return { ok: missing.length === 0, missing, checks };
}

function smokeAuthPreconditionError(input: {
  domain: string;
  smtpHost: string;
  serverIpv4: string;
}): string | undefined {
  if (!input.domain) return "invalid_domain";
  if (!input.smtpHost) return "invalid_smtp_host";
  if (isIP(input.serverIpv4) !== 4) return "invalid_server_ipv4";
  const expectedSmtpHost = `smtp.${input.domain}`;
  if (input.smtpHost !== expectedSmtpHost) {
    return "smtp_host_domain_mismatch";
  }
  return undefined;
}

function smokeAuthPreconditionChecks(
  checks: Record<SmokeAuthGateCheckName, SmokeAuthGateCheck>,
  error: string,
  input: { domain: string; smtpHost: string; serverIpv4: string }
): Record<SmokeAuthGateCheckName, SmokeAuthGateCheck> {
  const expectedSmtpHost = input.domain ? `smtp.${input.domain}` : "smtp.<domain>";
  return {
    ...checks,
    smtp_a: {
      ok: false,
      expected: { host: expectedSmtpHost, ipv4: input.serverIpv4 },
      observed: { domain: input.domain, smtpHost: input.smtpHost, serverIpv4: input.serverIpv4 },
      error
    }
  };
}

function flattenTxt(records: string[][]): string[] {
  return records.map((chunks) => chunks.join(""));
}

function spfRecordIncludesIpv4(record: string, ipv4: string): boolean {
  const escaped = ipv4.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)ip4:${escaped}(\\s|$)`, "i").test(record);
}

function dkimRecordHasPublicKey(record: string): boolean {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key) tags[key] = part.slice(eq + 1).trim();
  }
  return Boolean((tags.p ?? "").replace(/\s+/g, ""));
}

function normalizeDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown DNS error";
}
