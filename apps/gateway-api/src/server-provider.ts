export type ServerProviderId = "contabo" | "webdock" | "unknown";

/**
 * Server slugs are canonicalized at route boundaries. Provider classification
 * intentionally matches only canonical lowercase provider prefixes.
 */
export function getProviderFromServerSlug(serverSlug: string | null | undefined): ServerProviderId {
  if (typeof serverSlug !== "string") return "unknown";
  if (serverSlug.startsWith("contabo-")) return "contabo";
  return "unknown";
}

export function getProviderFromServerIdentity(input: {
  accountId?: string | null;
  slug?: string | null;
}): ServerProviderId {
  // Familia Contabo: accountId "contabo" (flat) o "contabo-N" (indexadas) clasifica como contabo,
  // igual que el prefijo de slug "contabo-".
  const accountId = typeof input.accountId === "string" ? input.accountId : "";
  if (accountId === "contabo" || /^contabo-\d+$/.test(accountId) || getProviderFromServerSlug(input.slug) === "contabo") {
    return "contabo";
  }
  if (input.accountId === "webdock" || input.accountId === "ops" || input.accountId === "default") {
    return "webdock";
  }
  return "unknown";
}
