import { readFile } from "node:fs/promises";

export const runtimeFlagKeys = [
  "AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE",
  "AWS_ROUTE53_ENABLE_PURCHASE",
  "AWS_ROUTE53_DOMAINS_PURCHASE_ENABLED",
  "AWS_ROUTE53_DNS_ENABLE_WRITES",
  "AWS_ROUTE53_ENABLE_DNS_WRITES",
  "IONOS_DNS_ENABLE_WRITES",
  "WEBDOCK_SERVERS_ENABLE_CREATE",
  "WEBDOCK_SERVERS_ENABLE_DELETE",
  "WEBDOCK_MAIN_DOMAIN_BIND_ENABLE",
  "WEBDOCK_BIND_MAIN_DOMAIN_ENABLE",
  "DOMAIN_BIND_ENABLE",
  "SMTP_PROVISIONING_ENABLE_SSH",
  "EMAIL_AUTH_ENABLE_WRITES",
  "WARMUP_ENABLE_SEND",
  "WARMUP_RAMP_ENABLE",
  "SMTP_SEND_REAL_EMAIL_ENABLE",
  "SEND_REAL_EMAIL_ENABLE",
  "OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE",
  "OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE",
  "OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL",
  "OPENCLAW_MEMORY_ALLOW_UNSIGNED_LOCAL",
  "GMAIL_IMAP_ENABLE",
  "PORKBUN_ENABLE_PURCHASE",
  "NAMECHEAP_ENABLE_PURCHASE"
] as const;

export type RuntimeFlagKey = typeof runtimeFlagKeys[number];

export interface RuntimeEnvReloaderOptions {
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface RuntimeEnvReloader {
  refreshNow(): Promise<Record<RuntimeFlagKey, string | undefined>>;
  start(): void;
  stop(): void;
  snapshot(): Record<RuntimeFlagKey, string | undefined>;
}

const runtimeFlagKeySet = new Set<string>(runtimeFlagKeys);

export function createRuntimeEnvReloader(options: RuntimeEnvReloaderOptions = {}): RuntimeEnvReloader {
  const env = options.env ?? process.env;
  const envFilePath = options.envFilePath ?? ".env.local";
  const intervalMs = options.intervalMs ?? 1_000;
  const onError = options.onError ?? (() => undefined);
  const current: Record<RuntimeFlagKey, string | undefined> = emptyRuntimeFlagSnapshot();
  let timer: NodeJS.Timeout | null = null;

  async function refreshNow(): Promise<Record<RuntimeFlagKey, string | undefined>> {
    try {
      const parsed = parseRuntimeEnvFile(await readFile(envFilePath, "utf8"));
      for (const key of runtimeFlagKeys) {
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
        const value = parsed[key];
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
        current[key] = value;
      }
    } catch (error) {
      onError(error);
    }
    return snapshot();
  }

  function start(): void {
    if (timer) return;
    void refreshNow();
    timer = setInterval(() => {
      void refreshNow();
    }, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function snapshot(): Record<RuntimeFlagKey, string | undefined> {
    const next = emptyRuntimeFlagSnapshot();
    for (const key of runtimeFlagKeys) {
      next[key] = current[key] ?? env[key];
    }
    return next;
  }

  return { refreshNow, start, stop, snapshot };
}

export function parseRuntimeEnvFile(source: string): Partial<Record<RuntimeFlagKey, string>> {
  const parsed: Partial<Record<RuntimeFlagKey, string>> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!runtimeFlagKeySet.has(key)) continue;
    parsed[key as RuntimeFlagKey] = unquoteEnvValue(match[2].trim());
  }
  return parsed;
}

function emptyRuntimeFlagSnapshot(): Record<RuntimeFlagKey, string | undefined> {
  return Object.fromEntries(runtimeFlagKeys.map((key) => [key, undefined])) as Record<RuntimeFlagKey, string | undefined>;
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
