import {
  createHash,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

export interface DkimKeyPairRef {
  domain: string;
  selector: string;
  privateKeyPath: string;
  publicKeyB64: string;
  publicKeyHash: string;
  generated: boolean;
}

interface DomainsInventory {
  emailAuth?: Array<Record<string, unknown> & {
    domain?: string;
    selector?: string;
    dkimPrivateKeyPath?: string;
  }>;
}

export async function ensureDkimKeyPair(input: {
  workspace: OpenClawWorkspace;
  domain: string;
  selector: string;
  now?: () => Date;
}): Promise<DkimKeyPairRef> {
  const domain = normalizeDomain(input.domain);
  const selector = normalizeSelector(input.selector);
  const existingPath = await findExistingDkimPrivateKeyPath(input.workspace, domain, selector);
  const privateKeyPath = existingPath ?? `inventory/dkim-keys/${domain}/${selector}.private`;

  const existingPrivate = await readWorkspaceTextIfPresent(input.workspace, privateKeyPath);
  if (existingPrivate) {
    const publicKeyB64 = publicKeyB64FromPrivateKey(existingPrivate);
    const ref = {
      domain,
      selector,
      privateKeyPath,
      publicKeyB64,
      publicKeyHash: hashText(publicKeyB64),
      generated: false
    };
    await upsertDkimInventory(input.workspace, ref, input.now);
    return ref;
  }

  const keyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  await writeWorkspacePrivateKey(input.workspace, privateKeyPath, keyPair.privateKey);
  const publicKeyB64 = publicKeyB64FromPem(keyPair.publicKey);
  const ref = {
    domain,
    selector,
    privateKeyPath,
    publicKeyB64,
    publicKeyHash: hashText(publicKeyB64),
    generated: true
  };
  await upsertDkimInventory(input.workspace, ref, input.now);
  return ref;
}

export async function findExistingDkimPrivateKeyPath(
  workspace: OpenClawWorkspace,
  domainInput: string,
  selectorInput: string
): Promise<string | null> {
  const domain = normalizeDomain(domainInput);
  const selector = normalizeSelector(selectorInput);
  const inventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  const match = inventory?.emailAuth?.find((entry) =>
    entry.domain === domain &&
    entry.selector === selector &&
    typeof entry.dkimPrivateKeyPath === "string" &&
    entry.dkimPrivateKeyPath.trim()
  );
  if (match?.dkimPrivateKeyPath) {
    return normalizeWorkspacePrivateKeyPath(match.dkimPrivateKeyPath);
  }

  const defaultPath = `inventory/dkim-keys/${domain}/${selector}.private`;
  return await readWorkspaceTextIfPresent(workspace, defaultPath) ? defaultPath : null;
}

function publicKeyB64FromPrivateKey(privateKeyPem: string): string {
  const publicKey = createPublicKey(privateKeyPem).export({
    type: "spki",
    format: "pem"
  });
  return publicKeyB64FromPem(String(publicKey));
}

function publicKeyB64FromPem(publicKeyPem: string): string {
  return publicKeyPem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, "");
}

async function upsertDkimInventory(
  workspace: OpenClawWorkspace,
  ref: DkimKeyPairRef,
  now: (() => Date) | undefined
): Promise<void> {
  await workspace.updateInventoryJson<DomainsInventory>("domains.json", (current) => {
    const emailAuth = [...(current?.emailAuth ?? [])];
    const index = emailAuth.findIndex((entry) => entry.domain === ref.domain && entry.selector === ref.selector);
    const existing = index >= 0 ? emailAuth[index] : {};
    const updated = {
      ...existing,
      domain: ref.domain,
      selector: ref.selector,
      dkimPrivateKeyPath: ref.privateKeyPath,
      dkimPublicKeyHash: ref.publicKeyHash,
      dkimKeyUpdatedAt: (now?.() ?? new Date()).toISOString()
    };
    if (index >= 0) {
      emailAuth[index] = updated;
    } else {
      emailAuth.push(updated);
    }
    return {
      ...(current ?? {}),
      emailAuth
    };
  });
}

async function readWorkspaceTextIfPresent(workspace: OpenClawWorkspace, path: string): Promise<string | null> {
  try {
    const value = await workspace.readWorkspaceFile(path);
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}

async function writeWorkspacePrivateKey(
  workspace: OpenClawWorkspace,
  path: string,
  content: string
): Promise<void> {
  const root = workspace.getRootDir();
  const absolutePath = resolve(root, path);
  const rel = relative(root, absolutePath);
  if (rel.startsWith("..") || rel === "" || !rel.split(/[\\/]/g).at(0)?.match(/^inventory$/)) {
    throw new Error(`DKIM private key path escapes OpenClaw inventory: ${path}`);
  }
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(absolutePath, 0o600);
}

function normalizeWorkspacePrivateKeyPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!/^inventory\/dkim-keys\/[a-z0-9.-]+\/[a-z0-9_-]+\.private$/.test(normalized)) {
    throw new Error("dkimPrivateKeyPath must point to inventory/dkim-keys/<domain>/<selector>.private");
  }
  return normalized;
}

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(normalized)) {
    throw new Error("domain must be a DNS-safe domain.");
  }
  return normalized;
}

function normalizeSelector(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error("selector must be a DNS-safe DKIM selector.");
  }
  return normalized;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
