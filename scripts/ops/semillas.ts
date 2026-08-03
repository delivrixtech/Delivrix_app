#!/usr/bin/env node
// Las SEMILLAS del warmup: las bandejas nuestras en Gmail/Outlook/Yahoo contra las que la fábrica
// calienta sus dominios. Se agregan A MANO — sin tocar código, sin deploy.
//
//   node --env-file=config/gateway.env scripts/ops/semillas.ts --list
//   node --env-file=config/gateway.env scripts/ops/semillas.ts --add --address=x@gmail.com --provider=gmail
//   node --env-file=config/gateway.env scripts/ops/semillas.ts --probe            (todas)
//   node --env-file=config/gateway.env scripts/ops/semillas.ts --probe --address=x@gmail.com
//   node --env-file=config/gateway.env scripts/ops/semillas.ts --disable --address=x@gmail.com
//   node --env-file=config/gateway.env scripts/ops/semillas.ts --enable  --address=x@gmail.com
//
// El app password se pide por STDIN, nunca por argumento: en argv quedaría visible en `ps` y en el
// historial del shell. Tampoco se imprime ni se escribe en claro: va cifrado al registro.
//
// Proveedores: gmail, workspace, outlook (también Hotmail/Live), m365, yahoo, gmx, webde.
// Cada uno necesita su APP PASSWORD (no la contraseña de la cuenta) con IMAP habilitado.

import { createInterface } from "node:readline";

import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import {
  agregarSemilla,
  coberturaPorProveedor,
  descifrarSemilla,
  leerSemillas,
  marcarSemilla,
  marcarVerificada,
  semillasActivas,
  semillasMedibles,
  SEED_PROVIDERS,
  type WarmupSeed
} from "../../apps/gateway-api/src/warmup-seeds.ts";

const args = process.argv.slice(2);
const BANDERAS = new Set(["--list", "--add", "--probe", "--disable", "--enable", "--solo-destino"]);
const CON_VALOR = new Set(["address", "provider", "imap-host", "imap-port", "notes"]);

for (const a of args) {
  const conValor = a.startsWith("--") && a.includes("=") && CON_VALOR.has(a.slice(2, a.indexOf("=")));
  if (!BANDERAS.has(a) && !conValor) {
    console.error(
      `argumento no reconocido: ${a}\n` +
        "esperados: --list --add --probe --disable --enable · --address= --provider= --imap-host= --imap-port= --notes=\n" +
        "No se hizo nada."
    );
    process.exit(1);
  }
}

const flag = (n: string): string | null => {
  const f = args.find((a) => a.startsWith(`--${n}=`));
  return f ? f.slice(n.length + 3) : null;
};

async function leerSecretoPorStdin(direccion: string): Promise<string> {
  if (process.stdin.isTTY) {
    console.log(`\nPegá el APP PASSWORD de ${direccion} y Enter (no se muestra ni se guarda en claro):`);
  }
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const linea of rl) {
    rl.close();
    return linea.trim();
  }
  return "";
}

/** El papel importa más que el estado: una semilla solo-destino no mide nada, y hay que verlo. */
const PAPEL: Record<string, string> = {
  none: "solo destino",
  imap_password: "mide (IMAP)",
  gmail_oauth: "mide (OAuth)"
};

function filaSemilla(s: WarmupSeed): string {
  const estado = s.enabled ? "activa " : "APAGADA";
  const papel = (PAPEL[s.auth] ?? s.auth).padEnd(13);
  // "SIN VERIFICAR" solo tiene sentido para las que pueden autenticar; una solo-destino no se
  // verifica nunca, y marcarla así sería una alarma falsa permanente.
  const verificada =
    s.auth === "none" ? "" : s.verifiedAt ? `verificada ${new Date(s.verifiedAt).toLocaleDateString("es")}` : "SIN VERIFICAR";
  return `  ${estado} ${s.address.padEnd(30)} ${s.provider.padEnd(10)} ${papel} ${verificada}${s.notes ? ` · ${s.notes}` : ""}`;
}

/** Login IMAP real. Es la única prueba de que la semilla sirve: el registro solo guarda intención. */
async function probarSemilla(seed: WarmupSeed): Promise<{ ok: boolean; detalle: string }> {
  let ImapFlow: new (opciones: Record<string, unknown>) => {
    connect(): Promise<void>;
    logout(): Promise<void>;
    mailboxOpen(nombre: string): Promise<{ exists: number }>;
  };
  try {
    ({ ImapFlow } = await import("imapflow"));
  } catch {
    return { ok: false, detalle: "imapflow no está instalado: no puedo probar el login" };
  }

  const cliente = new ImapFlow({
    host: seed.imap.host,
    port: seed.imap.port,
    secure: true,
    auth: { user: seed.address, pass: descifrarSemilla(seed, process.env) },
    logger: false
  });
  try {
    await cliente.connect();
    const bandeja = await cliente.mailboxOpen("INBOX");
    await cliente.logout();
    return { ok: true, detalle: `INBOX con ${bandeja.exists} mensajes` };
  } catch (error) {
    // El mensaje del proveedor se muestra tal cual: "AUTHENTICATIONFAILED" suele significar que
    // falta el app password o que IMAP está deshabilitado en la cuenta.
    return { ok: false, detalle: (error instanceof Error ? error.message : String(error)).split("\n")[0]! };
  }
}

async function main(): Promise<void> {
  const workspace = new OpenClawWorkspace();
  const { seeds, existeRegistro } = await leerSemillas(workspace);

  if (args.includes("--add")) {
    const address = flag("address");
    const provider = flag("provider");
    if (!address || !provider) {
      console.error(`--add necesita --address= y --provider= (proveedores: ${SEED_PROVIDERS.join(", ")})`);
      process.exit(1);
    }
    const puerto = flag("imap-port");
    // --solo-destino: la semilla recibe correo pero NO mide placement. Sirve para arrancar con
    // direcciones que todavia no tienen app password, sin bloquear las pruebas.
    const soloDestino = args.includes("--solo-destino");
    const secret = soloDestino ? "" : await leerSecretoPorStdin(address);
    if (!soloDestino && !secret) {
      console.error("no llegó ningún app password por stdin. No se agregó nada.");
      console.error("Si la querés solo como destino (sin medir placement), agregá --solo-destino.");
      process.exit(1);
    }
    const seed = await agregarSemilla({
      workspace,
      env: process.env,
      address,
      provider,
      ...(secret ? { secret } : {}),
      ...(flag("imap-host") ? { imapHost: flag("imap-host")! } : {}),
      ...(puerto ? { imapPort: Number.parseInt(puerto, 10) } : {}),
      ...(flag("notes") ? { notes: flag("notes")! } : {})
    });
    console.log(`\nagregada: ${seed.address} (${seed.provider}) · IMAP ${seed.imap.host}:${seed.imap.port}`);
    if (seed.auth === "none") {
      console.log("Queda como SOLO DESTINO: recibe correo, pero no puede decir dónde cayó ni rescatarlo de spam.");
      return;
    }

    const r = await probarSemilla(seed);
    console.log(r.ok ? `probe IMAP OK — ${r.detalle}` : `probe IMAP FALLÓ — ${r.detalle}`);
    if (r.ok) await marcarVerificada({ workspace, address: seed.address });
    else {
      console.log("Queda en el registro pero SIN VERIFICAR: revisá el app password y volvé a correr --probe.");
      process.exitCode = 2;
    }
    return;
  }

  if (args.includes("--disable") || args.includes("--enable")) {
    const address = flag("address");
    if (!address) {
      console.error("--disable/--enable necesitan --address=");
      process.exit(1);
    }
    const enabled = args.includes("--enable");
    const encontrada = await marcarSemilla({ workspace, address, enabled });
    if (!encontrada) {
      console.error(`${address} no está en el registro.`);
      process.exit(1);
    }
    console.log(`${address} ahora está ${enabled ? "ACTIVA" : "APAGADA"}.`);
    return;
  }

  if (args.includes("--probe")) {
    const soloUna = flag("address");
    // Solo se prueban las de app password. Las solo-destino no tienen con qué autenticar, y la
    // de OAuth usa un refresh token que vive en config/warmup-oauth.local.json — probarlas por
    // este camino daría un FALLA falso sobre semillas sanas.
    const conAuth = seeds.filter((s) => s.auth === "imap_password");
    const oauth = seeds.filter((s) => s.auth === "gmail_oauth");
    if (oauth.length > 0) {
      console.log(
        `(${oauth.length} semilla(s) OAuth omitidas: su token está en config/warmup-oauth.local.json, ` +
          "lo valida el daemon al arrancar, no este probe)"
      );
    }
    const objetivo = soloUna ? conAuth.filter((s) => s.address === soloUna.trim().toLowerCase()) : conAuth;
    const omitidas = seeds.filter((s) => s.auth === "none").length;
    if (omitidas > 0) console.log(`(${omitidas} semilla(s) solo-destino omitidas: no tienen credencial que probar)`);
    if (objetivo.length === 0) {
      console.log(
        soloUna
          ? `${soloUna} no es una semilla con app password (o no está en el registro).`
          : "no hay semillas con app password para probar. Agregá una con --add."
      );
      return;
    }
    console.log(`probando ${objetivo.length} semilla(s) por IMAP…\n`);
    let ok = 0;
    for (const seed of objetivo) {
      const r = await probarSemilla(seed);
      console.log(`  ${r.ok ? "OK    " : "FALLA "} ${seed.address.padEnd(34)} ${r.detalle}`);
      if (r.ok) {
        ok += 1;
        await marcarVerificada({ workspace, address: seed.address });
      }
    }
    console.log(`\n${ok}/${objetivo.length} semillas autentican.`);
    if (ok < objetivo.length) process.exitCode = 2;
    return;
  }

  // --list (y default)
  if (!existeRegistro) {
    console.log(
      "No hay registro de semillas todavía.\n" +
        "Agregá la primera:\n" +
        "  node --env-file=config/gateway.env scripts/ops/semillas.ts --add --address=tu@gmail.com --provider=gmail"
    );
    return;
  }
  console.log(`${seeds.length} semilla(s) en el registro:\n`);
  for (const s of seeds) console.log(filaSemilla(s));

  const activas = semillasActivas(seeds);
  const miden = semillasMedibles(seeds);
  const cobertura = coberturaPorProveedor(seeds);
  console.log(
    `\n${activas.length} activas como destino · ${miden.length} pueden MEDIR placement · ` +
      `cobertura de medición: ${Object.entries(cobertura).map(([p, n]) => `${p} ${n}`).join(", ") || "ninguna"}`
  );
  const sinVerificar = miden.filter((s) => !s.verifiedAt).length;
  if (sinVerificar > 0) console.log(`${sinVerificar} activa(s) SIN VERIFICAR — corré --probe antes de confiar en ellas.`);

  // Sin varios proveedores no se puede saber dónde cae el correo: el punto ciego se declara.
  const faltantes = ["gmail", "outlook", "yahoo"].filter((p) => !cobertura[p]);
  if (faltantes.length > 0) {
    console.log(`PUNTO CIEGO: sin semillas en ${faltantes.join(", ")} no se puede medir placement ahí.`);
  }
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
