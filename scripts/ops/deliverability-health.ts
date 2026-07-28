#!/usr/bin/env node
// Salud de entrega de la flota, leida del mail.log de cada nodo. PASIVO: no envia correo.
//
//   node --env-file=config/gateway.env scripts/ops/deliverability-health.ts
//   node --env-file=config/gateway.env scripts/ops/deliverability-health.ts --json
//   node --env-file=config/gateway.env scripts/ops/deliverability-health.ts --provider=gmail.com
//
// Existe porque el 2026-07-25 se descubrio, con envios reales, que 38 de 64 nodos estaban
// cerrados en Gmail (550-5.7.1) mientras el chequeo de listas negras decia "0 blacklist" y
// el inventario decia authComplete=true. La evidencia llevaba semanas en los logs de cada
// maquina. Esto la lee, sin gastar reputacion.
import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { createSmtpSshRunnerFromEnv } from "../../apps/gateway-api/src/routes/smtp-provisioning.ts";
import {
  readNodeDeliveryHealth,
  type DeliveryHealthVerdict
} from "../../apps/gateway-api/src/smtp-delivery-health.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const providerFilter = (args.find((a) => a.startsWith("--provider=")) ?? "").slice("--provider=".length) || null;
const concurrency = Number.parseInt((args.find((a) => a.startsWith("--concurrency=")) ?? "").slice("--concurrency=".length), 10) || 8;

interface Node { domain: string; serverSlug: string; serverIp: string }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

async function main(): Promise<void> {
  const runner = createSmtpSshRunnerFromEnv(process.env);
  if (!runner.isConfigured()) {
    console.error("runner SSH sin configurar: falta SMTP_PROVISION_SSH_KEY_PATH.");
    process.exit(1);
  }

  const workspace = new OpenClawWorkspace();
  const inventory = await workspace
    .readInventoryJson<{ servers?: Array<Partial<Node> & { status?: string }> }>("smtp-provisioning.json")
    .catch(() => null);

  const byDomain = new Map<string, Node>();
  for (const s of inventory?.servers ?? []) {
    if (s.status !== "configured" || !s.domain || !s.serverSlug || !s.serverIp) continue;
    byDomain.set(s.domain, { domain: s.domain, serverSlug: s.serverSlug, serverIp: s.serverIp });
  }
  const nodes = [...byDomain.values()];
  if (!asJson) console.log(`leyendo la salud de entrega de ${nodes.length} nodos (sin enviar nada)...\n`);

  const rows = await mapLimit(nodes, concurrency, async (node) => ({
    node,
    verdict: await readNodeDeliveryHealth({
      sshRunner: runner,
      serverSlug: node.serverSlug,
      serverIp: node.serverIp,
      selfDomain: node.domain
    })
  }));

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const groups: Array<[string, DeliveryHealthVerdict["status"]]> = [
    ["CERRADOS EN UN PROVEEDOR", "blocked_by_provider"],
    ["DEGRADADOS", "degraded"],
    ["SANOS", "healthy"],
    ["SIN TRAFICO", "no_traffic"],
    ["NO SE PUDO LEER", "unreadable"]
  ];

  for (const [title, status] of groups) {
    const sel = rows.filter((r) => r.verdict.status === status);
    if (sel.length === 0) continue;
    console.log(`\n=== ${title} (${sel.length}) ===`);
    for (const { node, verdict } of sel.sort((a, b) => a.node.domain.localeCompare(b.node.domain))) {
      if (providerFilter && status === "blocked_by_provider" && !verdict.blockedProviders.includes(providerFilter)) continue;
      const t = verdict.stats.totals;
      console.log(`  ${node.domain.padEnd(34)} ${String(t.delivered).padStart(6)} ok / ${String(t.blocked).padStart(6)} rech  ${verdict.detail.slice(0, 74)}`);
    }
  }

  const count = (s: DeliveryHealthVerdict["status"]): number => rows.filter((r) => r.verdict.status === s).length;
  console.log("\n===== RESUMEN =====");
  console.log(`  cerrados en un proveedor: ${count("blocked_by_provider")}`);
  console.log(`  degradados:               ${count("degraded")}`);
  console.log(`  sanos:                    ${count("healthy")}`);
  console.log(`  sin trafico:              ${count("no_traffic")}`);
  console.log(`  no se pudo leer:          ${count("unreadable")}`);
  console.log(`  TOTAL                     ${rows.length}`);
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
