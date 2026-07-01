import { promises as dns } from "node:dns";

export type SmokeAuthGateCheckName = "smtp_a" | "spf" | "dkim" | "dmarc" | "ptr" | "fcrdns";

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
  missing: SmokeAuthGateCheckName[];
  checks: Record<SmokeAuthGateCheckName, SmokeAuthGateCheck>;
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

  let smtpA: string[] = [];
  try {
    smtpA = await resolver.resolve4(smtpHost);
    checks.smtp_a = {
      ok: smtpA.includes(input.serverIpv4),
      expected: { host: smtpHost, ipv4: input.serverIpv4 },
      observed: smtpA
    };
  } catch (error) {
    checks.smtp_a = {
      ok: false,
      expected: { host: smtpHost, ipv4: input.serverIpv4 },
      error: errorMessage(error)
    };
  }

  try {
    const spfRecords = flattenTxt(await resolver.resolveTxt(domain))
      .filter((entry) => /^v=spf1\b/i.test(entry.trim()));
    checks.spf = {
      ok: spfRecords.some((record) => spfRecordIncludesIpv4(record, input.serverIpv4)),
      expected: `ip4:${input.serverIpv4}`,
      observed: spfRecords
    };
  } catch (error) {
    checks.spf = {
      ok: false,
      expected: `ip4:${input.serverIpv4}`,
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
    ptrHostnames = (await resolver.reverse(input.serverIpv4)).map(normalizeDnsName);
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
    ok: checks.ptr.ok && Boolean(ptrForwardA[smtpHost]?.includes(input.serverIpv4)),
    expected: { ptr: expectedPtr, forwardIp: input.serverIpv4 },
    observed: ptrForwardA
  };

  const missing = (Object.keys(checks) as SmokeAuthGateCheckName[])
    .filter((check) => !checks[check].ok);
  return { ok: missing.length === 0, missing, checks };
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
