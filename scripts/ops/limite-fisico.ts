#!/usr/bin/env node
// El límite físico de la fábrica, aplicado sobre la flota. DRY-RUN POR DEFECTO.
//
//   node --env-file=config/gateway.env scripts/ops/limite-fisico.ts --status
//   node --env-file=config/gateway.env scripts/ops/limite-fisico.ts --domain=x.com          (plan)
//   node --env-file=config/gateway.env scripts/ops/limite-fisico.ts --domain=x.com --apply
//   node --env-file=config/gateway.env scripts/ops/limite-fisico.ts --apply --limit=5
//   node --env-file=config/gateway.env scripts/ops/limite-fisico.ts --domain=x.com --rollback --apply
//
// Sin --apply NO toca ningún nodo: imprime el plan exacto que correría. El cap por defecto sale
// del mismo techo que sirve la cuota (SENDER_QUOTA_DAILY_MAX, default 2000), así que el número
// físico y el número que la fábrica publica son EL MISMO por construcción.

import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { createSmtpSshRunnerFromEnv } from "../../apps/gateway-api/src/routes/smtp-provisioning.ts";
import { leerInventarioFabrica } from "../../apps/gateway-api/src/sender-inventory.ts";
import { resolverTecho, TECHO_ABSOLUTO } from "../../apps/gateway-api/src/sender-quota.ts";
import {
  buildDailyCapInstallPlan,
  buildDailyCapRollbackPlan,
  buildDailyCapStatusCommand,
  CAP_MEASUREMENT_FILE,
  parseDailyCapStatus,
  type CapFlota,
  type CapNodo,
  type NodeCapStep
} from "../../apps/gateway-api/src/node-daily-cap.ts";

const args = process.argv.slice(2);

// Un argumento que no se reconoce ABORTA. Sin esto, `--domain foo.com` (espacio en vez de `=`) se
// ignoraba en silencio: el filtro no se aplicaba y `--apply` salía a los 58 nodos. Y `--rolback`
// instalaba en vez de desinstalar. El typo tiene que doler antes, no después.
const BANDERAS_SIMPLES = new Set(["--apply", "--rollback", "--status"]);
const BANDERAS_CON_VALOR = new Set(["domain", "cap", "limit"]);
for (const a of args) {
  const conValor = a.startsWith("--") && a.includes("=") && BANDERAS_CON_VALOR.has(a.slice(2, a.indexOf("=")));
  if (!BANDERAS_SIMPLES.has(a) && !conValor) {
    console.error(
      `argumento no reconocido: ${a}\n` +
        `esperados: --apply --rollback --status --domain=<dominio> --cap=<n> --limit=<n>\n` +
        "No se hizo nada."
    );
    process.exit(1);
  }
}

const flag = (nombre: string): string | null => {
  const encontrado = args.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.slice(nombre.length + 3) : null;
};
const APLICAR = args.includes("--apply");
const ROLLBACK = args.includes("--rollback");
const SOLO_STATUS = args.includes("--status");
const DOMINIO = flag("domain");

/**
 * Un flag numérico mal tipeado se RECHAZA, nunca se ignora. Sin esto, `--limit=abc` no filtraba
 * nada y `--apply` salía a los 58 nodos: el flag de seguridad, mal escrito, se volvía "toda la
 * flota". Y `--cap=1O00` (con O) caía al default en silencio.
 */
function enteroFlag(nombre: string, max: number): number | null {
  const crudo = flag(nombre);
  if (crudo === null) return null;
  const n = Number.parseInt(crudo, 10);
  if (!/^\d+$/.test(crudo) || !Number.isInteger(n) || n <= 0 || n > max) {
    console.error(`--${nombre}=${crudo} inválido: se espera un entero entre 1 y ${max}. No se hizo nada.`);
    process.exit(1);
  }
  return n;
}

const LIMITE = enteroFlag("limit", 10_000);
// El tope absoluto es el mismo de la cuota: arriba de eso el cap deja de proteger del umbral
// permanente de Google. Se rechaza (no se recorta) para no mentirle al operador sobre lo instalado.
const CAP = enteroFlag("cap", TECHO_ABSOLUTO) ?? resolverTecho();

interface Nodo {
  domain: string;
  serverSlug: string;
  serverIp: string;
}

async function main(): Promise<void> {
  const runner = createSmtpSshRunnerFromEnv(process.env);
  if (!runner.isConfigured()) {
    console.error("runner SSH sin configurar: falta SMTP_PROVISION_SSH_KEY_PATH.");
    process.exit(1);
  }

  const inventario = await leerInventarioFabrica({ workspace: new OpenClawWorkspace() });
  let nodos: Nodo[] = inventario.bandejas
    .filter((b) => b.serverSlug && b.serverIp && !b.conflicto)
    .map((b) => ({ domain: b.domain, serverSlug: b.serverSlug!, serverIp: b.serverIp! }));

  if (DOMINIO) nodos = nodos.filter((n) => n.domain === DOMINIO);
  if (LIMITE !== null) nodos = nodos.slice(0, LIMITE);

  if (nodos.length === 0) {
    console.error(DOMINIO ? `sin nodo medible para ${DOMINIO}` : "sin nodos medibles en el inventario");
    process.exit(1);
  }

  if (SOLO_STATUS) {
    await mostrarStatus(runner, nodos, new OpenClawWorkspace(), inventario.totalBandejas - nodos.length);
    return;
  }

  const plan: NodeCapStep[] = ROLLBACK ? buildDailyCapRollbackPlan() : buildDailyCapInstallPlan({ cap: CAP });

  if (!APLICAR) {
    console.log(
      `DRY-RUN — ${ROLLBACK ? "QUITARÍA el límite físico de" : `pondría cap ${CAP}/día en`} ${nodos.length} nodo(s).\n` +
        "Nada se ejecutó. Agregá --apply para hacerlo de verdad.\n"
    );
    for (const n of nodos.slice(0, 5)) console.log(`  ${n.domain.padEnd(32)} ${n.serverSlug} ${n.serverIp}`);
    if (nodos.length > 5) console.log(`  … y ${nodos.length - 5} más`);
    console.log(`\nPlan por nodo (${plan.length} pasos):`);
    for (const p of plan) console.log(`  ${p.label.padEnd(32)} ${p.auditCommand}`);
    return;
  }

  console.log(`${ROLLBACK ? "QUITANDO" : `aplicando cap ${CAP}/día`} en ${nodos.length} nodo(s)…\n`);
  let ok = 0;
  const fallados: Array<{ domain: string; paso: string; error: string }> = [];

  // Secuencial a propósito: cada nodo hace `postfix reload`. Un fallo se REPORTA y se sigue; no se
  // aborta la flota por un nodo caído, pero tampoco se declara éxito global.
  for (const nodo of nodos) {
    let pasoActual = "";
    try {
      for (const paso of plan) {
        pasoActual = paso.label;
        await runner.run({
          serverSlug: nodo.serverSlug,
          serverIp: nodo.serverIp,
          command: paso.command,
          ...(paso.stdin ? { stdin: paso.stdin } : {}),
          timeoutMs: paso.timeoutMs ?? 60_000
        });
      }
      ok += 1;
      console.log(`  OK    ${nodo.domain} (${nodo.serverSlug})`);
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      fallados.push({ domain: nodo.domain, paso: pasoActual, error: mensaje });
      console.log(`  FALLA ${nodo.domain} en ${pasoActual}: ${mensaje.split("\n")[0]}`);
    }
  }

  console.log(`\n${ok}/${nodos.length} nodos ${ROLLBACK ? "sin límite" : "con límite físico"}.`);
  if (fallados.length > 0) {
    console.log(`\nFALLARON ${fallados.length}:`);
    for (const f of fallados) console.log(`  ${f.domain.padEnd(32)} ${f.paso}: ${f.error.split("\n")[0]}`);
    process.exitCode = 1;
  }
}

async function mostrarStatus(
  runner: ReturnType<typeof createSmtpSshRunnerFromEnv>,
  nodos: Nodo[],
  workspace: OpenClawWorkspace,
  omitidos: number
): Promise<void> {
  console.log(`leyendo el estado del límite en ${nodos.length} nodo(s)…\n`);
  const comando = buildDailyCapStatusCommand();
  const leidos: CapNodo[] = [];
  let ilegibles = 0;

  for (const nodo of nodos) {
    try {
      const r = await runner.run({
        serverSlug: nodo.serverSlug,
        serverIp: nodo.serverIp,
        command: comando,
        timeoutMs: 30_000
      });
      const s = parseDailyCapStatus(r.stdout);
      leidos.push({ ...s, domain: nodo.domain, serverSlug: nodo.serverSlug });
      const uso = s.consumidoHoy === null ? "sin contador" : `${s.consumidoHoy}/${s.cap ?? "?"}`;
      console.log(`  ${s.cableado ? "CAP " : "ABIERTO"} ${nodo.domain.padEnd(32)} ${uso}${s.motivo ? ` — ${s.motivo}` : ""}`);
    } catch (error) {
      ilegibles += 1;
      // Fail-honest: un nodo que no responde NO se cuenta como "sin límite" ni como "con límite",
      // y tampoco entra al JSON: su ausencia se declara con `ilegibles`.
      console.log(`  ?      ${nodo.domain.padEnd(32)} no se pudo leer: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
  }

  const conLimite = leidos.filter((n) => n.cableado).length;
  console.log(
    `\n${conLimite}/${nodos.length} con límite físico; ${ilegibles} sin lectura;` +
      ` ${omitidos} fuera del alcance (sin binding o en conflicto: NADIE los capa).`
  );

  // Persistir SOLO cuando se leyó la flota entera: un `--domain=x` guardaría un JSON de un nodo y
  // el panel mostraría "la flota" con una sola fila. Parcial no se disfraza de completo.
  if (!DOMINIO && LIMITE === null) {
    const flota: CapFlota = { medidoEn: new Date().toISOString(), nodos: leidos, ilegibles, omitidos };
    await workspace.updateInventoryJson(CAP_MEASUREMENT_FILE, () => flota);
    console.log(`persistido en ${CAP_MEASUREMENT_FILE} (lo consumen las alertas y el panel).`);
  }
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
