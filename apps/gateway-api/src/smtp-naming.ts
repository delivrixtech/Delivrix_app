export function smtpHostForDomain(domain: string): string {
  const normalized = normalizeDomainName(domain);
  return `smtp.${normalized}`;
}

function normalizeDomainName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}
