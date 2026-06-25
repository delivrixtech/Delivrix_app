export const sensitiveAssignmentKeyPattern = "password|passwd|secret|token|session[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key|signature|hmac";
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

export function isAlwaysSensitiveChatKey(key: string): boolean {
  return !/^(smtp|sasl|dovecot)$/i.test(key);
}

export function isSensitiveKeyName(key: string): boolean {
  return /token|secret|password|private[_-]?key|access[_-]?key|api[_-]?key|authorization|signature|hmac|nonce/i.test(key);
}
