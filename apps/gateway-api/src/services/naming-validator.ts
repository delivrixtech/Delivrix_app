export const PROHIBITED_DOMAIN_WORDS = [
  "mail",
  "email",
  "notify",
  "noreply",
  "notification",
  "alert",
  "marketing",
  "bulk",
  "send",
  "sender",
  "inbox",
  "blast",
  "spam",
  "promo",
  "newsletter",
  "campaign",
  "broadcast"
];

export const TLD_PENALTY: Record<string, number> = {
  click: -100,
  top: -100,
  xyz: -80,
  work: -80,
  zip: -100,
  country: -70,
  bid: -90,
  tk: -100,
  ml: -100,
  ga: -100,
  cf: -100,
  com: 10,
  net: 5,
  io: 5,
  app: 5,
  co: 0
};

export const INTENT_SUFFIXES: Record<string, string[]> = {
  smtp: ["ops", "relay", "delivery", "outbound"],
  reporting: ["report", "reporting", "metrics", "stats"],
  filing: ["filing", "docs", "records", "ledger"],
  saas: ["app", "platform", "io", "cloud"],
  ops: ["ops", "infra", "control"],
  general: ["pro", "corp", "io", "app"]
};

export const DOMAIN_CANDIDATE_PATTERNS = [
  "brand+intentSuffix+tld",
  "brand-intentSuffix+tld",
  "intentSuffix+brand+tld"
] as const;

type CandidatePattern = (brand: string, intentSuffix: string, tld: string) => string;

const PATTERNS: CandidatePattern[] = [
  (brand, intentSuffix, tld) => `${brand}${intentSuffix}.${tld}`,
  (brand, intentSuffix, tld) => `${brand}-${intentSuffix}.${tld}`,
  (brand, intentSuffix, tld) => `${intentSuffix}${brand}.${tld}`
];

export interface NamingValidationResult {
  score: number;
  blockedReasons: string[];
  passes: boolean;
}

export interface GenerateCandidatesInput {
  brand: string;
  intent: string;
  tlds: string[];
  count?: number;
}

export function validateDomainNaming(domain: string): NamingValidationResult {
  const reasons: string[] = [];
  let score = 100;
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  const parts = normalized.split(".");

  if (parts.length < 2 || parts.some((part) => part.length === 0)) {
    return { score: 0, blockedReasons: ["domain_no_tld"], passes: false };
  }

  const sld = parts[0] ?? "";
  const tld = parts.slice(1).join(".");

  if (!/^[a-z0-9-]+$/.test(sld) || !/^[a-z0-9.-]+$/.test(tld)) {
    return { score: 0, blockedReasons: ["domain_invalid_chars"], passes: false };
  }

  for (const word of PROHIBITED_DOMAIN_WORDS) {
    if (sld.includes(word)) {
      reasons.push(`contains_${word}`);
      score -= 70;
    }
  }

  const tldPenalty = TLD_PENALTY[tld] ?? -30;
  score += tldPenalty;
  if (tldPenalty <= -70) {
    reasons.push("tld_problematic");
  }

  if (/^\d/.test(sld)) {
    reasons.push("starts_with_digit");
    score -= 20;
  }

  if ((sld.match(/-/g)?.length ?? 0) > 2) {
    reasons.push("excessive_hyphens");
    score -= 20;
  }

  if (/\d{3,}/.test(sld)) {
    reasons.push("contains_long_number");
    score -= 45;
  }

  if (/(\d{4}|20\d{2})/.test(sld)) {
    reasons.push("contains_year");
    score -= 30;
  }

  if (sld.length < 4) {
    reasons.push("sld_too_short");
    score -= 30;
  }

  if (sld.length > 25) {
    reasons.push("sld_too_long");
    score -= 10;
  }

  const goodSuffixes = ["ops", "report", "reporting", "filing", "pro", "corp", "io"];
  if (goodSuffixes.some((suffix) => sld.endsWith(suffix))) {
    score += 10;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    blockedReasons: reasons,
    passes: score >= 70 && reasons.length === 0
  };
}

export function validateHostnameNaming(hostname: string): NamingValidationResult {
  const reasons: string[] = [];
  let score = 100;
  const labels = hostname.trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  const firstLabel = labels[0] ?? "";

  for (const word of PROHIBITED_DOMAIN_WORDS) {
    if (firstLabel === word || firstLabel.startsWith(`${word}-`)) {
      reasons.push(`hostname_prefix_${word}`);
      score -= 60;
    }
  }

  const domainPart = labels.length > 1 ? labels.slice(1).join(".") : firstLabel;
  const domainCheck = validateDomainNaming(domainPart);
  score = Math.min(score, domainCheck.score);
  reasons.push(...domainCheck.blockedReasons);

  score = Math.max(0, score);

  return {
    score,
    blockedReasons: reasons,
    passes: score >= 70 && reasons.length === 0
  };
}

export function generateCandidates(input: GenerateCandidatesInput): string[] {
  const suffixes = INTENT_SUFFIXES[input.intent] ?? INTENT_SUFFIXES.general;
  const candidates = new Set<string>();
  const brand = input.brand.trim().toLowerCase();
  const tlds = input.tlds.map((tld) => tld.trim().toLowerCase().replace(/^\./, ""));

  for (const tld of tlds) {
    for (const suffix of suffixes) {
      for (const pattern of PATTERNS) {
        const domain = pattern(brand, suffix, tld);
        if (domain.length >= 6 && domain.length <= 40) {
          candidates.add(domain);
        }
      }
    }
  }

  return Array.from(candidates);
}
