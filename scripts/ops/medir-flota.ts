#!/usr/bin/env node
// La corrida de medicion de la fabrica. PASIVA: lee el mail.log de cada nodo, no envia nada.
//
//   node --env-file=config/gateway.env scripts/ops/medir-flota.ts
//   node --env-file=config/gateway.env scripts/ops/medir-flota.ts --concurrency=4
//
// Persiste sender-measurement.json en el workspace: es lo que enciende el semaforo de
// GET /v1/sender-pool/quota y de la pantalla Envio > Bandejas. Sin una corrida, la lista entera
// queda en gris "sin medir" y la fabrica vende 0 — honesto, pero inutil. Se mide SOLO lo que el
// inventario puede medir: con binding y sin conflicto; el resto ya sale rotulado en el pie.

import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { createSmtpSshRunnerFromEnv } from "../../apps/gateway-api/src/routes/smtp-provisioning.ts";
import { leerInventarioFabrica } from "../../apps/gateway-api/src/sender-inventory.ts";
import { medirFlota, MEASUREMENT_CONCURRENCY } from "../../apps/gateway-api/src/sender-measurement.ts";

const args = process.argv.slice(2);
const concurrency =
  Number.parseInt((args.find((a) => a.startsWith("--concurrency=")) ?? "").slice("--concurrency=".length), 10) ||
  MEASUREMENT_CONCURRENCY;

/**
 * `--cada=<horas>`: repite la medición para siempre, igual que `limite-fisico --status --cada`.
 *
 * Por qué existe: sender-measurement.json decide QUÉ DOMINIOS ENTRAN AL POOL del warmup (saca los
 * cerrados por el receptor, los de cola atascada y los que cruzaron el umbral) y también la lista
 * de dominios que el agente puede frenar y nunca soltar. Todo eso salía de una corrida MANUAL, así
 * que nadie la corría: el 2026-08-06 a las 06:18 UTC el archivo tenía 35 horas, y el propio agente
 * lo levantó como su queja principal — "operamos con datos de la flota que tienen más de treinta
 * horas". Tenía razón.
 *
 * El agujero no se ve desde afuera: el sistema sigue andando, solo que eligiendo el pool con una
 * foto de anteayer. Un dominio que se destrabó ayer sigue excluido, y uno que se cerró ayer sigue
 * recibiendo calentamiento que no llega a ninguna parte.
 *
 * Es PASIVA —lee el mail.log de cada nodo por SSH, no manda un solo correo— así que repetirla no
 * tiene costo de reputación. Lo único que cuesta es tiempo de SSH contra la flota.
 */
const cadaHoras = (() => {
  const crudo = (args.find((a) => a.startsWith("--cada=")) ?? "").slice("--cada=".length);
  if (!crudo) return null;
  const n = Number.parseInt(crudo, 10);
  if (!/^\d+$/.test(crudo) || !Number.isInteger(n) || n <= 0 || n > 24) {
    console.error(`--cada=${crudo} inválido: se espera un entero entre 1 y 24. No se hizo nada.`);
    process.exit(1);
  }
  return n;
})();

async function main(): Promise<void> {
  const runner = createSmtpSshRunnerFromEnv(process.env);
  if (!runner.isConfigured()) {
    console.error("runner SSH sin configurar: falta SMTP_PROVISION_SSH_KEY_PATH.");
    process.exit(1);
  }

  const workspace = new OpenClawWorkspace();
  const inventario = await leerInventarioFabrica({ workspace });

  const medibles = inventario.bandejas
    .filter((b) => b.serverSlug && b.serverIp && !b.conflicto)
    .map((b) => ({ domain: b.domain, serverSlug: b.serverSlug!, serverIp: b.serverIp! }));

  console.log(
    `midiendo ${medibles.length} de ${inventario.totalBandejas} bandejas ` +
      `(${inventario.sinBinding.length} sin binding, ${inventario.enConflicto.length} en conflicto quedan fuera) ` +
      `con concurrencia ${concurrency}...`
  );

  const flota = await medirFlota({ workspace, sshRunner: runner, bandejas: medibles, concurrency });

  const porEstado = new Map<string, number>();
  for (const b of flota.bandejas) porEstado.set(b.estado, (porEstado.get(b.estado) ?? 0) + 1);

  console.log(`\nmedido ${flota.medidoEn} en ${Math.round(flota.duracionMs / 1000)}s`);
  console.log(`cobertura: ${flota.leidas}/${flota.pedidas} leidas`);
  for (const [estado, n] of [...porEstado.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${estado.padEnd(20)} ${n}`);
  }

  const cruzadas = flota.bandejas.filter((b) => b.cruzados.length > 0);
  if (cruzadas.length > 0) {
    console.log(`\nUMBRAL PERMANENTE CRUZADO (${cruzadas.length}):`);
    for (const b of cruzadas) console.log(`  ${b.domain} en ${b.cruzados.join(", ")}`);
  }
  const cerca = flota.bandejas.filter((b) => b.cerca.length > 0);
  if (cerca.length > 0) {
    console.log(`\ncerca del umbral (${cerca.length}):`);
    for (const b of cerca) console.log(`  ${b.domain} en ${b.cerca.join(", ")}`);
  }
}

if (cadaHoras === null) {
  main().catch((error) => {
    console.error("ERROR:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else {
  // En bucle, un error NO mata el proceso: la flota tiene 58 nodos por SSH y que uno falle es
  // normal. Salir dejaría el archivo congelado hasta que alguien lo note — que es exactamente el
  // modo de falla que este bucle vino a eliminar. Se loguea y se reintenta en el próximo turno.
  const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  void (async () => {
    console.log(`midiendo la flota cada ${cadaHoras}h. Ctrl-C para parar.`);
    for (;;) {
      try {
        await main();
      } catch (error) {
        console.error("ERROR en esta corrida (sigo vivo):", error instanceof Error ? error.message : String(error));
      }
      await dormir(cadaHoras * 3_600_000);
    }
  })();
}
