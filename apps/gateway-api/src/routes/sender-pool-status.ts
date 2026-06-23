/**
 * Sender Pool Status — endpoint que sirve el panel /sender-pool del admin.
 *
 * Lee el inventory `domains.json` del workspace de OpenClaw y, para cada
 * dominio, cruza con los ramps activos (`warmup-progress.json`) para devolver
 * los flags que los paneles WarmupRampPanel + PlacementLivePanel del
 * frontend necesitan.
 *
 * Sin este wiring, los paneles que armaron los Ejecutores C (warmup ramp)
 * y D (Gmail IMAP placement) quedan invisibles en el frontend incluso
 * cuando hay ramps corriendo.
 *
 * Contrato del response (sincronizado con
 * `apps/admin-panel/src/v5/views/SenderPool.tsx`):
 *
 *   {
 *     domains: Array<{
 *       domain: string;
 *       status: string;
 *       registrar?: string;
 *       serverIp?: string | null;
 *       warmupRampActive?: boolean;
 *       ramp?: { rampId; subjectMatcher; status? } | null;
 *       ...
 *     }>;
 *     capacity?: { activeDomains; totalDomains; plannedDomains };
 *     source?: { kind: "live" | "mock" };
 *   }
 *
 * El `subjectMatcher` se deriva del rampId con el shape literal
 * `[delivrix-<rampId-12chars>]` — debe coincidir con el subject que el
 * adapter sendmail inyecta cuando ejecuta cada batch del ramp. Si en el
 * futuro el subject se vuelve configurable por dominio, mover este derivado
 * a un campo del WarmupRampRecord.
 *
 * Ref: REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md §14
 * (warm-up con monitoreo de placement entre batches).
 */

import { getActiveRamps, type WarmupRampRecord } from "../openclaw-workspace.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  listSmtpCredentialPublicMetadata,
  type SmtpCredentialPublicMetadata
} from "../smtp-credentials.ts";

export interface DomainsInventoryRecord {
  domain: string;
  registrar?: string;
  status?: string;
  serverSlug?: string | null;
  serverIp?: string | null;
  registeredAt?: string;
  costUsd?: number;
}

export interface DomainsInventory {
  domains?: DomainsInventoryRecord[];
  dnsZones?: unknown[];
  emailAuth?: Array<{
    domain?: string;
    selector?: string;
    dkimPrivateKeyPath?: string;
  }>;
  binds?: Array<{
    domain: string;
    serverSlug?: string | null;
    serverIp?: string | null;
    serverIpV4?: string | null;
    boundAt?: string;
  }>;
  bindings?: Array<{
    domain: string;
    serverSlug?: string | null;
    serverIp?: string | null;
    serverIpV4?: string | null;
    boundAt?: string;
  }>;
}

export interface SenderPoolDomainSummary {
  domain: string;
  status: string;
  registrar?: string;
  serverSlug?: string | null;
  serverIp?: string | null;
  hasCredential?: boolean;
  smtpCredential?: SmtpCredentialPublicMetadata | null;
  warmupDayN?: number | null;
  warmupTargetDays?: number;
  emailsSentToday?: number;
  blacklistsClean?: boolean;
  authComplete?: boolean;
  ramp?: {
    rampId: string;
    subjectMatcher: string;
    status?: WarmupRampRecord["state"];
  } | null;
  warmupRampActive?: boolean;
}

export interface SenderPoolStatusResponse {
  domains: SenderPoolDomainSummary[];
  capacity: {
    activeDomains: number;
    totalDomains: number;
    plannedDomains: number;
  };
  source: { kind: "live" | "mock" };
  generatedAt: string;
}

const SUBJECT_MATCHER_PREFIX = "[delivrix-";
const RAMP_ID_VISIBLE_LENGTH = 12;

/**
 * Deriva el subjectMatcher canónico para un ramp dado.
 * El adapter sendmail inyecta este mismo subject en cada batch para que el
 * placement-check de Gmail IMAP pueda buscarlos con gmraw.
 *
 * Formato: `[delivrix-<primeros 12 chars del rampId>]`.
 */
export function deriveRampSubjectMatcher(rampId: string): string {
  const short = rampId.slice(0, RAMP_ID_VISIBLE_LENGTH);
  return `${SUBJECT_MATCHER_PREFIX}${short}]`;
}

/**
 * Build de la summary de un dominio combinando inventory + ramp opcional.
 */
function buildDomainSummary(
  inventory: DomainsInventoryRecord,
  ramp: WarmupRampRecord | null,
  bind: { serverIp?: string | null; serverIpV4?: string | null; serverSlug?: string | null } | undefined,
  smtpCredential: SmtpCredentialPublicMetadata | null,
  authComplete: boolean
): SenderPoolDomainSummary {
  const serverIp =
    inventory.serverIp ??
    bind?.serverIpV4 ??
    bind?.serverIp ??
    ramp?.serverIp ??
    null;
  const serverSlug =
    inventory.serverSlug ??
    bind?.serverSlug ??
    smtpCredential?.serverSlug ??
    ramp?.serverSlug ??
    null;
  const rampActive =
    ramp !== null &&
    (ramp.state === "running" || ramp.state === "paused" || ramp.state === "auto_paused");

  const summary: SenderPoolDomainSummary = {
    domain: inventory.domain,
    status: inventory.status ?? "owned",
    registrar: inventory.registrar,
    serverSlug,
    serverIp,
    hasCredential: smtpCredential?.hasCredential === true,
    smtpCredential,
    authComplete,
    blacklistsClean: undefined,
    emailsSentToday: 0,
    warmupDayN: undefined,
    warmupTargetDays: undefined,
    ramp: rampActive
      ? {
          rampId: ramp!.rampId,
          subjectMatcher: deriveRampSubjectMatcher(ramp!.rampId),
          status: ramp!.state
        }
      : null,
    warmupRampActive: rampActive
  };

  return summary;
}

export interface BuildSenderPoolStatusDeps {
  workspace: OpenClawWorkspace;
  now?: () => Date;
}

/**
 * Construye el payload sin tocar HTTP — testeable directamente.
 */
export async function buildSenderPoolStatus(
  deps: BuildSenderPoolStatusDeps
): Promise<SenderPoolStatusResponse> {
  const { workspace } = deps;
  const now = deps.now ?? (() => new Date());

  const [inventory, ramps, smtpCredentials] = await Promise.all([
    workspace
      .readInventoryJson<DomainsInventory>("domains.json")
      .catch(() => null as DomainsInventory | null),
    getActiveRamps(workspace).catch(() => [] as WarmupRampRecord[]),
    listSmtpCredentialPublicMetadata(workspace).catch(() => [] as SmtpCredentialPublicMetadata[])
  ]);

  const records = inventory?.domains ?? [];
  const binds = new Map(
    [...(inventory?.binds ?? []), ...(inventory?.bindings ?? [])]
      .map((bind) => [bind.domain.toLowerCase(), bind])
  );
  const authDomains = new Set(
    (inventory?.emailAuth ?? [])
      .map((entry) => typeof entry.domain === "string" ? entry.domain.toLowerCase() : "")
      .filter(Boolean)
  );
  const credentialsByDomain = new Map(
    smtpCredentials.map((credential) => [credential.domain.toLowerCase(), credential])
  );

  const rampsByDomain = new Map<string, WarmupRampRecord>();
  for (const ramp of ramps) {
    rampsByDomain.set(ramp.domain.toLowerCase(), ramp);
  }

  const domains: SenderPoolDomainSummary[] = records.map((rec) => {
    const key = rec.domain.toLowerCase();
    const ramp = rampsByDomain.get(key) ?? null;
    const bind = binds.get(key);
    const smtpCredential = credentialsByDomain.get(key) ?? null;
    return buildDomainSummary(rec, ramp, bind, smtpCredential, authDomains.has(key) || smtpCredential?.hasCredential === true);
  });

  const seenDomains = new Set(domains.map((domain) => domain.domain.toLowerCase()));
  for (const credential of smtpCredentials) {
    const key = credential.domain.toLowerCase();
    if (seenDomains.has(key)) continue;
    seenDomains.add(key);
    domains.push(
      buildDomainSummary(
        {
          domain: credential.domain,
          status: credential.hasCredential ? "smtp-auth-ready" : "smtp-auth-pending",
          serverSlug: credential.serverSlug,
          serverIp: null
        },
        rampsByDomain.get(key) ?? null,
        binds.get(key),
        credential,
        credential.hasCredential
      )
    );
  }

  // Dominios que tienen ramp activo pero NO aparecen en inventory (caso edge:
  // ramp arrancó con un dominio que el inventario no terminó de persistir).
  const orphanRamps = ramps.filter(
    (ramp) => !seenDomains.has(ramp.domain.toLowerCase())
  );
  for (const ramp of orphanRamps) {
    domains.push(
      buildDomainSummary(
        { domain: ramp.domain, status: "warming", registrar: undefined, serverIp: ramp.serverIp },
        ramp,
        undefined,
        credentialsByDomain.get(ramp.domain.toLowerCase()) ?? null,
        authDomains.has(ramp.domain.toLowerCase()) || credentialsByDomain.get(ramp.domain.toLowerCase())?.hasCredential === true
      )
    );
  }

  const activeDomains = domains.filter(
    (d) => d.status === "active" || d.status === "warming" || d.warmupRampActive === true
  ).length;

  return {
    domains,
    capacity: {
      activeDomains,
      totalDomains: domains.length,
      plannedDomains: 0
    },
    source: { kind: "live" },
    generatedAt: now().toISOString()
  };
}

/**
 * HTTP handler — wrap el build en JSON response.
 */
export interface HandleSenderPoolStatusDeps {
  workspace: OpenClawWorkspace;
  now?: () => Date;
}

export async function handleSenderPoolStatusHttp(
  deps: HandleSenderPoolStatusDeps
): Promise<{ status: number; body: SenderPoolStatusResponse | { error: string; message: string } }> {
  try {
    const payload = await buildSenderPoolStatus(deps);
    return { status: 200, body: payload };
  } catch (err) {
    return {
      status: 500,
      body: {
        error: "sender_pool_status_failed",
        message: err instanceof Error ? err.message : "unknown error"
      }
    };
  }
}
