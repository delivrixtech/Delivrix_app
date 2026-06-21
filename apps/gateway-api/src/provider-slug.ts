export function isContaboLikeServerSlug(serverSlug: string | null | undefined): boolean {
  return typeof serverSlug === "string" && serverSlug.trim().toLowerCase().startsWith("contabo-");
}

export function isContaboLikeServerIdentity(input: {
  accountId?: string | null;
  slug?: string | null;
}): boolean {
  return input.accountId === "contabo" || isContaboLikeServerSlug(input.slug);
}
