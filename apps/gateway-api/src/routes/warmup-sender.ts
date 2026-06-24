export const WARMUP_FROM_LOCALPART = "hello";

export function warmupFromAddress(domain: string): string {
  return `${WARMUP_FROM_LOCALPART}@${domain}`;
}
