export const sensitiveAssignmentKeyPattern = [
  "smtp[_-]?password",
  "sasl[_-]?password",
  "dovecot[_-]?password",
  "approval[_-]?token",
  "password",
  "passwd",
  "secret",
  "token",
  "session[_-]?token",
  "api[_-]?key",
  "access[_-]?key",
  "private[_-]?key",
  "signature",
  "hmac"
].join("|");
export const chatSensitiveAssignmentKeyPattern = [
  "smtp[_ -]?password",
  "smtp[_ -]?credential",
  "smtp",
  "sasl",
  "dovecot",
  "password",
  "passwd",
  "secret",
  "token",
  "api[_ -]?key",
  "authorization",
  "approval[_ -]?token"
].join("|");

export function looksLikeSecretLiteral(rawValue: string): boolean {
  const value = rawValue.replace(/^["']|["']$/g, "");
  if (/^(?:hash|regexp|texthash):/i.test(value) || value.includes("/") || value.includes(".")) {
    return false;
  }
  if (/^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value)) {
    return true;
  }
  return value.length >= 20
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /[0-9]/.test(value);
}

export function sensitiveAssignmentRegex(keyPattern: string, separatorPattern = "[:=]"): RegExp {
  return new RegExp(
    `(["']?)\\b(${keyPattern})\\b\\1(\\s*(?:${separatorPattern})\\s*)("[^"]*"|'[^']*'|\\[REDACTED\\]|[^\\s,;}\\]]+)`,
    "gi"
  );
}

export function redactAssignmentValue(rawValue: string): string {
  const quote = rawValue.startsWith("\"") || rawValue.startsWith("'") ? rawValue[0] : "";
  return quote ? `${quote}[REDACTED]${quote}` : "[REDACTED]";
}

export function isAlwaysSensitiveChatKey(key: string): boolean {
  return !/^(smtp|sasl|dovecot)$/i.test(key);
}

export function isSensitiveKeyName(key: string): boolean {
  return /token|secret|password|private[_-]?key|access[_-]?key|api[_-]?key|authorization|signature|hmac|nonce/i.test(key);
}
