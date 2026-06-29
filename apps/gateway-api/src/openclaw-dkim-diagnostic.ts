// DKIM/selector diagnostic — the second half of "endurecer el diagnóstico" (#4).
//
// Two audited false-alarm modes in the send-path preflight (validateEmailAuth):
//   1. The selector defaults to "default", but Delivrix's orchestrator signs with
//      "s2026a" (s<year>a). Querying the wrong selector reports a FALSE "DKIM
//      missing" and blocks a send whose DKIM is actually fine under s2026a.
//   2. It only tests for the text "v=DKIM1", so a REVOKED key (p= empty) reads as
//      present — a false "DKIM OK".
//
// This module probes the real Delivrix convention + common selectors, validates
// the record properly (valid vs revoked vs absent), and — to avoid the very
// false-red #4 is about — reports "unknown" instead of "absent" when DNS could
// not answer at all. Pure: the DNS resolver is injected, so it is fully testable.

export type DkimStatus = "valid" | "revoked" | "absent" | "unknown";

export interface DkimRecordParse {
  /** A v=DKIM1 record exists at this name. */
  present: boolean;
  /** Present AND carries a non-empty public key (p=…). */
  valid: boolean;
  /** Present but p= is empty → key revoked. */
  revoked: boolean;
  keyType: string;
  detail: string;
}

export interface DkimSelectorResult extends DkimRecordParse {
  selector: string;
  fqdn: string;
  resolved: boolean;
}

export interface DkimDiagnosis {
  domain: string;
  status: DkimStatus;
  validSelectors: string[];
  checked: DkimSelectorResult[];
  summary: string;
}

const SELECTOR_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const COMMON_SELECTORS = ["default", "mail", "smtp", "s1", "dkim", "google", "k1", "selector1"];

export function parseDkimTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key) tags[key] = part.slice(eq + 1).trim();
  }
  return tags;
}

/** Interpret the (flattened) TXT records at a _domainkey name as a DKIM verdict. */
export function parseDkimRecord(entries: string[]): DkimRecordParse {
  const record = entries
    .map((entry) => entry.trim())
    .find((entry) => /(^|;|\s)v\s*=\s*dkim1\b/i.test(entry) || entry.toLowerCase().includes("v=dkim1"));
  if (!record) {
    return { present: false, valid: false, revoked: false, keyType: "", detail: "no v=DKIM1 record" };
  }
  const tags = parseDkimTags(record);
  const keyType = (tags.k || "rsa").toLowerCase();
  const publicKey = (tags.p ?? "").replace(/\s+/g, "");
  if (publicKey === "") {
    return { present: true, valid: false, revoked: true, keyType, detail: "DKIM record present but p= is empty (key REVOKED)" };
  }
  return { present: true, valid: true, revoked: false, keyType, detail: `DKIM ${keyType} key present` };
}

function candidateSelectors(expected: string | undefined, extra: string[] | undefined, now: Date): string[] {
  const year = now.getUTCFullYear();
  // Delivrix's signing convention first, then the generic "default", then common ones.
  const delivrix = [`s${year}a`, "s2026a"];
  const ordered = [
    ...(expected ? [expected] : []),
    ...(extra ?? []),
    ...delivrix,
    ...COMMON_SELECTORS
  ]
    .map((selector) => selector.trim().toLowerCase())
    .filter((selector) => SELECTOR_RE.test(selector));
  return [...new Set(ordered)].slice(0, 12);
}

function flattenTxt(records: string[][]): string[] {
  return records.map((chunks) => chunks.join(""));
}

/**
 * Probes DKIM across the likely selectors for a domain and returns a structured,
 * clearly-labeled verdict. Pure + best-effort: a resolver throw at a selector is
 * treated as "no record here"; if NO selector resolved at all, status is
 * "unknown" (never a false "absent").
 */
export async function diagnoseDkim(input: {
  resolveTxt: (fqdn: string) => Promise<string[][]>;
  domain: string;
  expectedSelector?: string;
  extraSelectors?: string[];
  now?: () => Date;
}): Promise<DkimDiagnosis> {
  const selectors = candidateSelectors(input.expectedSelector, input.extraSelectors, (input.now ?? (() => new Date()))());
  const checked: DkimSelectorResult[] = [];
  let resolvedCount = 0;

  for (const selector of selectors) {
    const fqdn = `${selector}._domainkey.${input.domain}`;
    try {
      const txt = await input.resolveTxt(fqdn);
      resolvedCount += 1;
      checked.push({ selector, fqdn, resolved: true, ...parseDkimRecord(flattenTxt(txt)) });
    } catch {
      checked.push({
        selector,
        fqdn,
        resolved: false,
        present: false,
        valid: false,
        revoked: false,
        keyType: "",
        detail: "lookup failed / NXDOMAIN"
      });
    }
  }

  const valid = checked.filter((entry) => entry.valid);
  const revoked = checked.filter((entry) => entry.revoked);

  let status: DkimStatus;
  let summary: string;
  if (valid.length > 0) {
    status = "valid";
    summary = `DKIM válido en selector(es): ${valid.map((entry) => entry.selector).join(", ")}.`;
  } else if (revoked.length > 0) {
    status = "revoked";
    summary = `DKIM presente pero REVOCADO (p= vacío) en: ${revoked.map((entry) => entry.selector).join(", ")}. No es "missing": hay registro, falta la clave.`;
  } else if (resolvedCount === 0) {
    status = "unknown";
    summary = `No se pudo resolver DKIM en ninguno de los ${selectors.length} selectores (¿DNS caído?). NO asumir "missing": reintentar.`;
  } else {
    status = "absent";
    summary = `Sin DKIM en ${selectors.length} selectores probados (incluida la convención Delivrix s${(input.now ?? (() => new Date()))().getUTCFullYear()}a/s2026a y "default"). Si esperabas otro selector, pásalo en expectedSelector.`;
  }

  return { domain: input.domain, status, validSelectors: valid.map((entry) => entry.selector), checked, summary };
}
