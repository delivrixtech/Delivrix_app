import type {
  AwsRoute53DnsChangeResult,
  AwsRoute53DnsRecordInput,
  AwsRoute53ResourceRecordSet
} from "../../../packages/adapters/src/index.ts";
import type { AuditEventInput } from "../../../packages/domain/src/index.ts";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";
import type { Route53DnsAdapter } from "./routes/domains-dns.ts";
import {
  resolveRoute53HostedZone,
  Route53ZonePolicyError
} from "./routes/route53-zone-policy.ts";
import type {
  SmtpInventoryLiveServer,
  SmtpProvisioningInventory,
  SmtpProvisioningServer
} from "./smtp-inventory-management.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface ReconcileDnsToLiveSmtpInput {
  workspace: OpenClawWorkspace;
  route53DnsAdapter: Route53DnsAdapter;
  auditLog: AuditSink;
  liveServers: SmtpInventoryLiveServer[];
  domain: string;
  serverSlug: string;
  serverIp?: string;
  selector?: string;
  actorId: string;
  dryRun?: boolean;
  taskId?: string;
  reason?: string;
  getDomainNameservers?: (domain: string) => Promise<string[]>;
  now?: () => Date;
}

export interface ReconcileDnsToLiveSmtpResult {
  ok: boolean;
  status: string;
  dryRun: boolean;
  changed: boolean;
  domain: string;
  serverSlug: string;
  serverIp?: string;
  selector: string;
  zoneId?: string;
  error?: string;
  plan: {
    action: "reconcile_dns_to_live_smtp";
    desiredRecords: AwsRoute53DnsRecordInput[];
    dkimRecordName: string;
    existingRecords?: AwsRoute53ResourceRecordSet[];
    zoneResolution?: Record<string, unknown>;
    appliedChanges?: Array<AwsRoute53DnsRecordInput & AwsRoute53DnsChangeResult>;
    blockers?: string[];
  };
}

const defaultSelector = "s2026a";
const recordTtlSeconds = 300;

export async function reconcileDnsToLiveSmtp(
  input: ReconcileDnsToLiveSmtpInput
): Promise<ReconcileDnsToLiveSmtpResult> {
  const domain = normalizeDomain(input.domain);
  const serverSlug = input.serverSlug;
  const selector = normalizeSelector(input.selector ?? defaultSelector);
  const dryRun = input.dryRun === true;
  const inventory = await input.workspace.readInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json").catch(() => null);
  const inventoryEntry = findInventoryEntry(inventory, domain, serverSlug);
  const liveServer = input.liveServers.find((server) => server.serverSlug === serverSlug);
  const serverIp = input.serverIp ?? liveServer?.ipv4 ?? inventoryEntry?.serverIp;
  const desiredRecords = serverIp ? desiredSmtpRecords(domain, serverIp) : [];
  const dkimRecordName = `${selector}._domainkey.${domain}.`;

  if (!inventoryEntry) {
    return appendAndReturn(input, blockedResult({
      domain,
      serverSlug,
      serverIp,
      selector,
      dryRun,
      desiredRecords,
      dkimRecordName,
      status: "smtp_inventory_entry_missing",
      error: "configured SMTP inventory entry not found for domain/serverSlug"
    }));
  }
  if (!liveServer) {
    return appendAndReturn(input, blockedResult({
      domain,
      serverSlug,
      serverIp,
      selector,
      dryRun,
      desiredRecords,
      dkimRecordName,
      status: "live_server_missing",
      error: "serverSlug not present in live provider inventory"
    }));
  }
  if (!isLiveServerUsable(liveServer)) {
    return appendAndReturn(input, blockedResult({
      domain,
      serverSlug,
      serverIp,
      selector,
      dryRun,
      desiredRecords,
      dkimRecordName,
      status: "live_server_not_running",
      error: `live server status is ${liveServer.status ?? "unknown"}`
    }));
  }
  if (!serverIp) {
    return appendAndReturn(input, blockedResult({
      domain,
      serverSlug,
      selector,
      dryRun,
      desiredRecords,
      dkimRecordName,
      status: "server_ip_missing",
      error: "server IPv4 missing from request, live inventory and SMTP inventory"
    }));
  }
  if (input.serverIp && liveServer.ipv4 && input.serverIp !== liveServer.ipv4) {
    return appendAndReturn(input, blockedResult({
      domain,
      serverSlug,
      serverIp,
      selector,
      dryRun,
      desiredRecords,
      dkimRecordName,
      status: "server_ip_mismatch",
      error: "requested serverIp does not match live inventory IPv4"
    }));
  }
  if (normalizeDomain(inventoryEntry.domain) !== domain || inventoryEntry.serverSlug !== serverSlug || inventoryEntry.status !== "configured") {
    return appendAndReturn(input, blockedResult({
      domain,
      serverSlug,
      serverIp,
      selector,
      dryRun,
      desiredRecords,
      dkimRecordName,
      status: "smtp_inventory_entry_not_configured",
      error: "SMTP inventory entry must be configured before DNS cutover"
    }));
  }
  if (inventoryEntry.serverIp && inventoryEntry.serverIp !== serverIp) {
    return appendAndReturn(input, blockedResult({
      domain,
      serverSlug,
      serverIp,
      selector,
      dryRun,
      desiredRecords,
      dkimRecordName,
      status: "smtp_inventory_ip_mismatch",
      error: "SMTP inventory serverIp does not match live target IPv4"
    }));
  }

  try {
    const resolved = await resolveRoute53HostedZone({
      workspace: input.workspace,
      adapter: input.route53DnsAdapter,
      domain,
      mode: "reuse-only",
      getDomainNameservers: input.getDomainNameservers
    });
    const existingRecords = await input.route53DnsAdapter.listResourceRecordSets(resolved.zone.zoneId);
    const dkimStatus = classifyDkimRecord(existingRecords, dkimRecordName);
    const plan = {
      action: "reconcile_dns_to_live_smtp" as const,
      desiredRecords,
      dkimRecordName,
      existingRecords: relevantRecords(existingRecords, domain, selector),
      zoneResolution: {
        status: resolved.status,
        source: resolved.source,
        zoneId: resolved.zone.zoneId,
        authoritativeNameserverMatch: resolved.authoritativeNameserverMatch === true,
        cleanupSuggested: resolved.cleanupSuggested
      },
      ...(dkimStatus.ok ? {} : { blockers: [dkimStatus.status] })
    };

    if (!dkimStatus.ok) {
      return appendAndReturn(input, {
        ok: false,
        status: "dkim_regenerate_required",
        dryRun,
        changed: false,
        domain,
        serverSlug,
        serverIp,
        selector,
        zoneId: resolved.zone.zoneId,
        error: "DKIM record for selector is missing or revoked; run the DKIM/email-auth repair flow before DNS-only cutover.",
        plan
      });
    }
    if (dryRun) {
      return appendAndReturn(input, {
        ok: true,
        status: "dry_run",
        dryRun: true,
        changed: false,
        domain,
        serverSlug,
        serverIp,
        selector,
        zoneId: resolved.zone.zoneId,
        plan
      });
    }
    if (!input.route53DnsAdapter.isLive()) {
      return appendAndReturn(input, {
        ok: false,
        status: "route53_dns_not_live",
        dryRun,
        changed: false,
        domain,
        serverSlug,
        serverIp,
        selector,
        zoneId: resolved.zone.zoneId,
        error: "Route53 DNS adapter is not live.",
        plan
      });
    }
    if (!input.route53DnsAdapter.isWriteEnabled()) {
      return appendAndReturn(input, {
        ok: false,
        status: "route53_dns_writes_disabled",
        dryRun,
        changed: false,
        domain,
        serverSlug,
        serverIp,
        selector,
        zoneId: resolved.zone.zoneId,
        error: "Route53 DNS writes are disabled.",
        plan
      });
    }

    const appliedChanges: Array<AwsRoute53DnsRecordInput & AwsRoute53DnsChangeResult> = [];
    for (const record of desiredRecords) {
      const change = await input.route53DnsAdapter.upsertRecord(resolved.zone.zoneId, record);
      appliedChanges.push({ ...record, ...change });
    }

    return appendAndReturn(input, {
      ok: true,
      status: "reconciled",
      dryRun: false,
      changed: appliedChanges.length > 0,
      domain,
      serverSlug,
      serverIp,
      selector,
      zoneId: resolved.zone.zoneId,
      plan: {
        ...plan,
        appliedChanges
      }
    });
  } catch (error) {
    if (error instanceof Route53ZonePolicyError) {
      return appendAndReturn(input, {
        ok: false,
        status: error.code,
        dryRun,
        changed: false,
        domain,
        serverSlug,
        serverIp,
        selector,
        error: error.message,
        plan: {
          action: "reconcile_dns_to_live_smtp",
          desiredRecords,
          dkimRecordName,
          blockers: [error.code],
          zoneResolution: error.details
        }
      });
    }
    return appendAndReturn(input, {
      ok: false,
      status: "route53_dns_reconcile_failed",
      dryRun,
      changed: false,
      domain,
      serverSlug,
      serverIp,
      selector,
      error: error instanceof Error ? error.message : String(error),
      plan: {
        action: "reconcile_dns_to_live_smtp",
        desiredRecords,
        dkimRecordName,
        blockers: ["route53_dns_reconcile_failed"]
      }
    });
  }
}

function desiredSmtpRecords(domain: string, serverIp: string): AwsRoute53DnsRecordInput[] {
  return [
    {
      name: `smtp.${domain}`,
      type: "A",
      ttl: recordTtlSeconds,
      values: [serverIp]
    },
    {
      name: domain,
      type: "TXT",
      ttl: recordTtlSeconds,
      values: [`v=spf1 ip4:${serverIp} -all`]
    },
    {
      name: domain,
      type: "MX",
      ttl: recordTtlSeconds,
      values: [`10 smtp.${domain}.`]
    }
  ];
}

function findInventoryEntry(
  inventory: SmtpProvisioningInventory | null,
  domain: string,
  serverSlug: string
): SmtpProvisioningServer | undefined {
  return (inventory?.servers ?? []).find((server) =>
    normalizeDomain(server.domain) === domain &&
    server.serverSlug === serverSlug &&
    server.status === "configured"
  );
}

function isLiveServerUsable(server: SmtpInventoryLiveServer): boolean {
  const status = (server.status ?? "").toLowerCase();
  if (!status) return true;
  return ["running", "active", "online", "ready", "provisioned"].includes(status);
}

function classifyDkimRecord(records: AwsRoute53ResourceRecordSet[], dkimRecordName: string): { ok: boolean; status: string } {
  const targetName = normalizeRecordName(dkimRecordName);
  const txt = records
    .filter((record) => record.type === "TXT" && normalizeRecordName(record.name) === targetName)
    .flatMap((record) => record.values)
    .map((value) => value.replace(/^"|"$/g, ""))
    .join(" ");
  if (!txt) {
    return { ok: false, status: "dkim_record_missing" };
  }
  if (!/v=DKIM1/i.test(txt)) {
    return { ok: false, status: "dkim_record_invalid" };
  }
  const publicKeyMatch = txt.match(/\bp=([^;\s"]+)/i);
  if (!publicKeyMatch || publicKeyMatch[1].trim().length < 32) {
    return { ok: false, status: "dkim_record_revoked" };
  }
  return { ok: true, status: "dkim_record_present" };
}

function relevantRecords(records: AwsRoute53ResourceRecordSet[], domain: string, selector: string): AwsRoute53ResourceRecordSet[] {
  const relevantNames = new Set([
    normalizeRecordName(domain),
    normalizeRecordName(`smtp.${domain}`),
    normalizeRecordName(`${selector}._domainkey.${domain}`)
  ]);
  return records.filter((record) => relevantNames.has(normalizeRecordName(record.name)));
}

function blockedResult(input: {
  domain: string;
  serverSlug: string;
  serverIp?: string;
  selector: string;
  dryRun: boolean;
  desiredRecords: AwsRoute53DnsRecordInput[];
  dkimRecordName: string;
  status: string;
  error: string;
}): ReconcileDnsToLiveSmtpResult {
  return {
    ok: false,
    status: input.status,
    dryRun: input.dryRun,
    changed: false,
    domain: input.domain,
    serverSlug: input.serverSlug,
    ...(input.serverIp ? { serverIp: input.serverIp } : {}),
    selector: input.selector,
    error: input.error,
    plan: {
      action: "reconcile_dns_to_live_smtp",
      desiredRecords: input.desiredRecords,
      dkimRecordName: input.dkimRecordName,
      blockers: [input.status]
    }
  };
}

async function appendAndReturn(
  input: ReconcileDnsToLiveSmtpInput,
  result: ReconcileDnsToLiveSmtpResult
): Promise<ReconcileDnsToLiveSmtpResult> {
  await input.auditLog.append({
    actorType: "operator",
    actorId: input.actorId,
    action: result.ok
      ? (result.dryRun ? "oc.dns.smtp_reconcile_planned" : "oc.dns.smtp_reconciled")
      : "oc.dns.smtp_reconcile_blocked",
    targetType: "domain",
    targetId: result.domain,
    riskLevel: "critical",
    decision: result.ok ? "allow" : "reject",
    humanApproved: true,
    approverIds: [input.actorId],
    metadata: {
      domain: result.domain,
      serverSlug: result.serverSlug,
      serverIp: result.serverIp,
      selector: result.selector,
      zoneId: result.zoneId,
      status: result.status,
      dryRun: result.dryRun,
      changed: result.changed,
      taskId: input.taskId,
      reason: input.reason,
      error: result.error,
      rollbackPlan: {
        mode: "manual_dns_restore",
        canRollbackAutomatically: false,
        procedure: "Manual only: locate this oc.dns.smtp_reconciled audit event, copy metadata.rollbackPlan.previousRecords, and submit one signed upsert_dns_route53 ApprovalGate proposal per previous smtp A, apex SPF/MX, or DKIM TXT record. If a previous record is absent, remove the new record manually in Route53 after operator approval.",
        previousRecords: result.plan.existingRecords
      },
      plan: result.plan
    }
  });
  return result;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeSelector(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRecordName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}
