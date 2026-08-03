#!/usr/bin/env node
// PRUEBA DE ACEPTACIÓN del límite físico, por el camino EXACTO de producción.
//
//   node --env-file=config/gateway.env scripts/ops/probar-limite.ts <dominio>
//   node --env-file=config/gateway.env scripts/ops/probar-limite.ts <dominio> --ciclo-completo
//
// Por qué existe: el status (`limite-fisico.ts --status`) lee la CONFIGURACIÓN del nodo; esto
// prueba el COMPORTAMIENTO. Son cosas distintas — un nodo puede tener todo bien cableado y aun así
// no aplicar el cap si smtpd no consulta el policy service. La única forma honesta de saberlo es
// hablarle por 587 como le habla NFC.
//
// NO ENVÍA CORREO: corta con QUIT antes de DATA, así que la conversación llega hasta RCPT (que es
// donde el policy service decide) y termina. Nada entra a la cola.
//
// La credencial se descifra EN MEMORIA y nunca se imprime, ni se pasa por argv (quedaría visible
// en `ps`). La salida son códigos SMTP.
//
// `--ciclo-completo` además prueba el freno: baja el cap al valor del contador (nodo al tope),
// verifica que difiera, y RESTAURA el cap anterior. Cambia estado del nodo por unos segundos.

import net from "node:net";
import tls from "node:tls";

import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { createSmtpSshRunnerFromEnv } from "../../apps/gateway-api/src/routes/smtp-provisioning.ts";
import { decryptSmtpCredentialForDownload } from "../../apps/gateway-api/src/smtp-credentials.ts";
import { leerInventarioFabrica } from "../../apps/gateway-api/src/sender-inventory.ts";
import { CAP_FILE, COUNT_DIR } from "../../apps/gateway-api/src/node-daily-cap.ts";

const DOMINIO = process.argv[2];
const CICLO_COMPLETO = process.argv.includes("--ciclo-completo");
const DESTINO = "probe@example.com";

if (!DOMINIO || DOMINIO.startsWith("--")) {
  console.error("uso: probar-limite.ts <dominio> [--ciclo-completo]");
  process.exit(1);
}

/** Lee hasta la línea FINAL de una respuesta SMTP ("NNN " con espacio; "NNN-" es continuación). */
function leerRespuesta(sock: NodeJS.ReadWriteStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const ultima = buf.split("\r\n").filter(Boolean).at(-1) ?? "";
      if (/^\d{3} /.test(ultima)) {
        sock.removeListener("data", onData);
        resolve(ultima);
      }
    };
    sock.on("data", onData);
    sock.once("error", reject);
    setTimeout(() => reject(new Error("timeout esperando respuesta SMTP")), 20_000);
  });
}

async function decir(sock: NodeJS.ReadWriteStream, linea: string): Promise<string> {
  sock.write(`${linea}\r\n`);
  return leerRespuesta(sock);
}

/** Una conversación completa hasta RCPT. Devuelve la respuesta al RCPT. Nunca manda DATA. */
async function probarRcpt(input: { ip: string; host: string; username: string; password: string }): Promise<string> {
  const plano = net.connect(587, input.ip);
  try {
    await new Promise((r, j) => {
      plano.once("connect", r);
      plano.once("error", j);
    });
    await leerRespuesta(plano);
    await decir(plano, "EHLO probe.delivrix");
    const starttls = await decir(plano, "STARTTLS");
    if (!starttls.startsWith("220")) throw new Error(`STARTTLS rechazado: ${starttls}`);

    const seguro = tls.connect({ socket: plano, servername: input.host, rejectUnauthorized: false });
    await new Promise((r, j) => {
      seguro.once("secure", r);
      seguro.once("error", j);
    });
    await decir(seguro, "EHLO probe.delivrix");
    const auth = await decir(
      seguro,
      `AUTH PLAIN ${Buffer.from(`\0${input.username}\0${input.password}`).toString("base64")}`
    );
    if (!auth.startsWith("235")) throw new Error(`autenticación fallida: ${auth.slice(0, 3)}`);
    await decir(seguro, `MAIL FROM:<${input.username}>`);
    const rcpt = await decir(seguro, `RCPT TO:<${DESTINO}>`);
    await decir(seguro, "QUIT"); // ← antes de DATA: no se envía nada
    seguro.end();
    return rcpt;
  } finally {
    plano.destroy();
  }
}

async function main(): Promise<void> {
  const workspace = new OpenClawWorkspace();
  const inventario = await leerInventarioFabrica({ workspace });
  const bandeja = inventario.bandejas.find((b) => b.domain === DOMINIO);
  if (!bandeja?.serverIp || !bandeja.serverSlug) {
    console.error(`sin nodo con IP para ${DOMINIO} en el inventario.`);
    process.exit(1);
  }

  const { record, password } = await decryptSmtpCredentialForDownload({ workspace, env: process.env, domain: DOMINIO });
  const conexion = { ip: bandeja.serverIp, host: record.host, username: record.username, password };

  console.log(`probando ${DOMINIO} en ${bandeja.serverSlug} (${bandeja.serverIp}) por 587 autenticado…\n`);

  const bajoElCap = await probarRcpt(conexion);
  console.log(`  bajo el cap    RCPT → ${bajoElCap}`);
  if (!bajoElCap.startsWith("250")) {
    console.error("\nFALLA: el nodo no acepta un RCPT legítimo. Revisá el cap y el policy service.");
    process.exit(2);
  }

  if (!CICLO_COMPLETO) {
    console.log("\nOK: el camino autenticado funciona y el RCPT pasa (no se envió ningún mensaje).");
    console.log("Para probar TAMBIÉN el freno: agregá --ciclo-completo.");
    return;
  }

  // El freno: se pone el cap en el valor del contador (nodo al tope) y se restaura al terminar.
  const runner = createSmtpSshRunnerFromEnv(process.env);
  if (!runner.isConfigured()) {
    console.error("\nno se puede probar el freno: runner SSH sin configurar.");
    process.exit(1);
  }
  const ssh = (command: string) =>
    runner.run({ serverSlug: bandeja.serverSlug!, serverIp: bandeja.serverIp!, command, timeoutMs: 30_000 });

  const capPrevio = (await ssh(`cat ${CAP_FILE}`)).stdout.trim();
  // Se valida ANTES de tocar nada: si el cap actual no es un entero limpio, restaurarlo escribiría
  // basura (o un archivo vacío), y un cap ilegible hace que el policy service difiera TODO el
  // correo del nodo, todos los días, hasta que alguien lo arregle a mano.
  if (!/^\d+$/.test(capPrevio)) {
    console.error(`\nel cap actual del nodo no es un entero legible (${JSON.stringify(capPrevio)}). No lo toco.`);
    process.exit(1);
  }
  const contadorCrudo = (await ssh(`cat ${COUNT_DIR}/count-$(date -u +%F) 2>/dev/null || echo 0`)).stdout.trim();
  if (!/^\d+$/.test(contadorCrudo)) {
    console.error(`\nel contador del día no es legible (${JSON.stringify(contadorCrudo)}). No sigo.`);
    process.exit(1);
  }
  // Tal cual, sin `|| 1`: con el contador en 0 el cap correcto para tapar el nodo es 0 (el policy
  // compara `n >= cap`). Un `|| 1` dejaba cap=1 con 0 consumido, el nodo aceptaba, y el script
  // reportaba una FALLA falsa sobre un nodo sano.
  const contador = Number.parseInt(contadorCrudo, 10);
  console.log(`  cap actual ${capPrevio}, contador ${contador} — lo pongo al tope un instante…`);

  const restaurarCap = async (): Promise<void> => {
    // Reintenta: si el restore falla, el nodo queda difiriendo TODO su correo autenticado.
    let ultimo: unknown = null;
    for (let intento = 1; intento <= 3; intento += 1) {
      try {
        await ssh(`printf '%s\\n' '${capPrevio}' > ${CAP_FILE}`);
        console.log(`  cap restaurado a ${capPrevio}`);
        return;
      } catch (error) {
        ultimo = error;
        if (intento < 3) await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    // Imposible de ignorar: el operador tiene que ver el comando exacto para arreglarlo a mano.
    console.error(
      `\n${"!".repeat(72)}\n` +
        `EL NODO QUEDÓ AL TOPE Y NO PUDE RESTAURARLO: ${bandeja.serverSlug} (${bandeja.serverIp})\n` +
        `Difiere TODO el correo autenticado hasta que se restaure. Corré a mano:\n` +
        `  ssh <usuario>@${bandeja.serverIp} "printf '%s\\n' ${capPrevio} > ${CAP_FILE}"\n` +
        `motivo: ${ultimo instanceof Error ? ultimo.message.split("\n")[0] : String(ultimo)}\n` +
        `${"!".repeat(72)}`
    );
    process.exitCode = 3;
  };

  // Un Ctrl-C mientras el nodo está tapado lo dejaría así: `finally` no corre ante señales.
  const onSignal = () => {
    console.error("\ninterrumpido — restaurando el cap antes de salir…");
    void restaurarCap().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let acepto = false;
  try {
    await ssh(`printf '%s\\n' ${contador} > ${CAP_FILE}`);
    const alTope = await probarRcpt(conexion);
    console.log(`  en el tope     RCPT → ${alTope}`);
    acepto = !/^4\d\d/.test(alTope);
  } finally {
    // El restore va SIEMPRE. Y su propia falla NO puede tapar el diagnóstico de la prueba: por eso
    // restaurarCap() no lanza, reporta.
    await restaurarCap();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  if (acepto) {
    console.error("\nFALLA: el nodo aceptó un RCPT estando en el tope. El límite NO está aplicando.");
    process.exitCode = 2;
    return;
  }

  const restaurado = await probarRcpt(conexion);
  console.log(`  restaurado     RCPT → ${restaurado}`);
  console.log(
    restaurado.startsWith("250")
      ? "\nOK: acepta bajo el cap, DIFIERE en el tope, y vuelve a aceptar sin reload. Límite verificado."
      : "\nATENCIÓN: tras restaurar el cap el nodo sigue sin aceptar. Revisalo."
  );
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
