#!/usr/bin/env node
// Backfill del acceso SSH ops sobre la flota SMTP existente.
//
//   node --env-file=config/gateway.env scripts/ops/ops-ssh-fleet-backfill.ts            # dry-run (default)
//   node --env-file=config/gateway.env scripts/ops/ops-ssh-fleet-backfill.ts --apply
//
// Reemplaza al script suelto que vivía en runtime/ (gitignored). Aquel traía su propia
// verificación de propiedad con `root@<ip>` hardcodeado y descartó 14 nodos vivos como
// ajenos: los boxes Webdock entran como delivrixops + sudo, no como root. Por eso este
// script NO tiene lógica de verificación — la hace backfillOpsSshForFleet con el mismo
// runner que provisiona, y está cubierta por tests.
//
// No imprime claves privadas ni contraseñas.
import { resolve4 } from "node:dns/promises";
import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { LocalFileAuditLog } from "../../packages/local-store/src/index.ts";
import {
  backfillOpsSshForFleet,
  createSmtpSshRunnerFromEnv,
  type OpsSshBackfillNodeResult
} from "../../apps/gateway-api/src/routes/smtp-provisioning.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const allowDnsIp = args.includes("--allow-dns-ip");
const noDnsCheck = args.includes("--no-dns-check");
const asJson = args.includes("--json");
const limit = Number.parseInt(argValue("--limit") ?? "", 10);
const onlyDomains = args
  .filter((a) => a.startsWith("--domain="))
  .map((a) => a.slice("--domain=".length).trim().toLowerCase())
  .filter(Boolean);
const actorId = argValue("--actor") ?? "operator/juanes";
const opsUser = process.env.SMTP_OPS_SSH_USER?.trim() || "delivrix-ops";

function argValue(flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

interface InventoryServer {
  serverSlug?: string;
  domain?: string;
  serverIp?: string;
  status?: string;
}

async function main(): Promise<void> {
  if (process.env.SMTP_OPS_SSH_ENABLE !== "true") {
    console.error("SMTP_OPS_SSH_ENABLE != true — el acceso ops está apagado. Nada que hacer.");
    process.exit(1);
  }

  const runner = createSmtpSshRunnerFromEnv(process.env);
  if (!runner.isConfigured()) {
    console.error("runner SSH sin configurar: falta SMTP_PROVISION_SSH_KEY_PATH.");
    process.exit(1);
  }

  const workspace = new OpenClawWorkspace();
  const inventory = await workspace
    .readInventoryJson<{ servers?: InventoryServer[] }>("smtp-provisioning.json")
    .catch(() => null);

  // Nodos configured, dedup por dominio (la última entrada gana).
  const byDomain = new Map<string, { domain: string; serverSlug: string; serverIp: string }>();
  for (const server of inventory?.servers ?? []) {
    if (server.status !== "configured" || !server.domain || !server.serverSlug || !server.serverIp) continue;
    byDomain.set(server.domain, {
      domain: server.domain,
      serverSlug: server.serverSlug,
      serverIp: server.serverIp
    });
  }

  let nodes = [...byDomain.values()];
  if (onlyDomains.length > 0) nodes = nodes.filter((n) => onlyDomains.includes(n.domain));
  if (Number.isInteger(limit) && limit > 0) nodes = nodes.slice(0, limit);

  console.log(`modo: ${apply ? "APPLY (efectos reales)" : "dry-run (sin efectos)"}`);
  console.log(`nodos a evaluar: ${nodes.length}${allowDnsIp ? " | --allow-dns-ip activo" : ""}`);
  if (nodes.length === 0) {
    console.log("nada que hacer.");
    return;
  }

  const summary = await backfillOpsSshForFleet({
    workspace,
    sshRunner: runner,
    auditLog: new LocalFileAuditLog(),
    env: process.env,
    actorId,
    opsUser,
    nodes,
    dryRun: !apply,
    resolve4: noDnsCheck ? undefined : (host) => resolve4(host),
    allowDnsIpFallback: allowDnsIp
  });

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const groups: Array<[string, OpsSshBackfillNodeResult["status"]]> = [
    ["PROVISIONADOS", "provisioned"],
    ["SE PROVISIONARÍAN", "would_provision"],
    ["YA TENÍAN ACCESO", "skipped_already"],
    ["NO SON TUYOS", "skipped_not_owned"],
    ["NO VERIFICABLES", "skipped_unverifiable"],
    ["IP DEL INVENTARIO DESACTUALIZADA", "skipped_ip_mismatch"],
    ["FALLARON", "failed"]
  ];

  for (const [title, status] of groups) {
    const rows = summary.results.filter((r) => r.status === status);
    if (rows.length === 0) continue;
    console.log(`\n=== ${title} (${rows.length}) ===`);
    for (const row of rows) {
      const detail = row.error
        ?? (row.status === "skipped_ip_mismatch"
          ? `inventario ${row.inventoryIp} vs DNS ${row.ipReconciliation?.dnsIps.join(",") ?? "—"}`
          : row.ownership?.detail ?? "");
      console.log(`  ${row.domain.padEnd(34)} ${row.effectiveIp.padEnd(16)} ${detail}`);
      if (row.ownership?.hint) console.log(`    ↳ ${row.ownership.hint}`);
    }
  }

  console.log("\n===== RESUMEN =====");
  console.log(`  provisionados:        ${summary.provisioned.length}`);
  console.log(`  se provisionarían:    ${summary.wouldProvision.length}`);
  console.log(`  ya tenían acceso:     ${summary.skippedAlready.length}`);
  console.log(`  no son tuyos:         ${summary.skippedNotOwned.length}`);
  console.log(`  no verificables:      ${summary.skippedUnverifiable.length}`);
  console.log(`  IP desactualizada:    ${summary.skippedIpMismatch.length}`);
  console.log(`  fallaron:             ${summary.failed.length}`);
  if (!apply) console.log("\n(dry-run: no se tocó ningún nodo — agregá --apply para ejecutar)");
  else console.log("\nEsau descarga cada uno: GET /v1/sender-pool/credentials/<dominio>/download");
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
