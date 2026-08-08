#!/usr/bin/env node
// El límite físico de la fábrica, aplicado sobre la flota. DRY-RUN POR DEFECTO.
//
//   node --env-file=config/gateway.env scripts/ops/limite-fisico.ts --status
//   node --env-file=config/gateway.env scripts/ops/limite-fisico.ts --status --cada=6   (se queda midiendo)
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
import { resolverTecho } from "../../apps/gateway-api/src/sender-quota.ts";
import { TECHO_DURO_POR_DOMINIO } from "../../apps/warmup-engine/src/domain/decision-diaria.ts";
import {
  buildDailyCapInstallPlan,
  buildDailyCapRollbackPlan,
  buildFrenoPlan,
  buildDailyCapStatusCommand,
  CAP_MEASUREMENT_FILE,
  lineaDeUso,
  parseDailyCapStatus,
  type CapFlota,
  type CapNodo,
  type NodeCapStep
} from "../../apps/gateway-api/src/node-daily-cap.ts";

const args = process.argv.slice(2);

// Un argumento que no se reconoce ABORTA. Sin esto, `--domain foo.com` (espacio en vez de `=`) se
// ignoraba en silencio: el filtro no se aplicaba y `--apply` salía a los 58 nodos. Y `--rolback`
// instalaba en vez de desinstalar. El typo tiene que doler antes, no después.
const BANDERAS_SIMPLES = new Set(["--apply", "--rollback", "--status", "--frenar"]);
const BANDERAS_CON_VALOR = new Set(["domain", "cap", "limit", "excepto", "cap-excepto", "cada"]);
for (const a of args) {
  const conValor = a.startsWith("--") && a.includes("=") && BANDERAS_CON_VALOR.has(a.slice(2, a.indexOf("=")));
  if (!BANDERAS_SIMPLES.has(a) && !conValor) {
    console.error(
      `argumento no reconocido: ${a}\n` +
        `esperados: --apply --rollback --status --frenar --domain=<dominio> --cap=<n> --limit=<n> --excepto=<dom,dom> --cap-excepto=<n> --cada=<horas>\n` +
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
/**
 * FRENO: escribe cap 0 en la flota, que en el policy service significa diferir TODO el correo
 * autenticado. Sirve para cortar a un emisor externo sin tocar credenciales ni desmontar nada — y
 * se revierte con un `--apply` normal.
 *
 * `--excepto` es imprescindible y no cosmético: NUESTRO warmup sale por el MISMO 587 con la misma
 * credencial que el emisor externo, así que un freno parejo nos frenaría a nosotros. Los dominios
 * exceptuados quedan con un cupo chico (`--cap-excepto`, default 20/día) que cubre las 3 vueltas
 * diarias del calentamiento y sigue matando cualquier volumen de producción.
 */
const FRENAR = args.includes("--frenar");
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
// EL MISMO TECHO QUE INSTALA `buildDailyCapInstallPlan`, y por eso se importa de ahí en vez de
// tener su propia copia. Con TECHO_ABSOLUTO (4000) acá, el operador que escribía `--cap=3000` leía
// "se espera un entero entre 1 y 4000", pasaba la validación, y recién después el instalador tiraba
// una excepción cruda: el mensaje que lo guía le decía un número y el que decide era otro. Igual con
// `SENDER_QUOTA_DAILY_MAX` puesto arriba de 2000, que hacía morir al script en vez de instalar el
// freno. Se rechaza (no se recorta) para no mentirle al operador sobre lo instalado.
const CAP = enteroFlag("cap", TECHO_DURO_POR_DOMINIO) ?? Math.min(resolverTecho(), TECHO_DURO_POR_DOMINIO);
const EXCEPTO = new Set(
  (flag("excepto") ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
);
const CAP_EXCEPTO = enteroFlag("cap-excepto", TECHO_DURO_POR_DOMINIO) ?? 20;

/**
 * `--cada=<horas>`: repite el `--status` para siempre, refrescando la medición.
 *
 * Por qué existe: la medición del cupo VENCE a las 12h (`plan-diario.ts`), y con razón — un cap
 * viejo puede ser un 2000 que ya no está. Pero nadie la refrescaba, así que todos los días el
 * motor de decisión del warmup se quedaba sin base para el volumen y caía a "cupo desconocido".
 * El agujero no se veía: el sistema seguía andando, solo que decidiendo con menos información.
 *
 * Solo tiene sentido con `--status`: repetir un `--apply` en loop sería reinstalar el cap cada N
 * horas sin que nadie lo pida, y eso no lo decide un flag.
 */
const CADA_HORAS = enteroFlag("cada", 24);
if (CADA_HORAS !== null && !SOLO_STATUS) {
  console.error("--cada solo se usa con --status: repetir un cambio en loop no lo decide un flag. No se hizo nada.");
  process.exit(1);
}

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

  const planDe = (dominio: string): NodeCapStep[] => {
    if (ROLLBACK) return buildDailyCapRollbackPlan();
    if (!FRENAR) return buildDailyCapInstallPlan({ cap: CAP });
    // Freno: 0 para todos, cupo chico para los que estamos calentando.
    return EXCEPTO.has(dominio.toLowerCase())
      ? buildDailyCapInstallPlan({ cap: CAP_EXCEPTO })
      : buildFrenoPlan();
  };
  const plan: NodeCapStep[] = planDe(nodos[0]!.domain);

  if (!APLICAR) {
    console.log(
      `DRY-RUN — ${
        ROLLBACK
          ? "QUITARÍA el límite físico de"
          : FRENAR
            ? `FRENARÍA (cap 0) ${nodos.length - [...EXCEPTO].filter((d) => nodos.some((n) => n.domain.toLowerCase() === d)).length} nodo(s), dejando cap ${CAP_EXCEPTO}/día en ${[...EXCEPTO].join(", ") || "ninguno"} —`
            : `pondría cap ${CAP}/día en`
      } ${nodos.length} nodo(s).\n` +
        "Nada se ejecutó. Agregá --apply para hacerlo de verdad.\n"
    );
    for (const n of nodos.slice(0, 5)) console.log(`  ${n.domain.padEnd(32)} ${n.serverSlug} ${n.serverIp}`);
    if (nodos.length > 5) console.log(`  … y ${nodos.length - 5} más`);
    console.log(`\nPlan por nodo (${plan.length} pasos):`);
    for (const p of plan) console.log(`  ${p.label.padEnd(32)} ${p.auditCommand}`);
    return;
  }

  console.log(
    `${ROLLBACK ? "QUITANDO" : FRENAR ? `FRENANDO (cap 0, excepto ${[...EXCEPTO].join(", ") || "ninguno"} con ${CAP_EXCEPTO}/día)` : `aplicando cap ${CAP}/día`} en ${nodos.length} nodo(s)…\n`
  );
  let ok = 0;
  const fallados: Array<{ domain: string; paso: string; error: string }> = [];

  // Secuencial a propósito: cada nodo hace `postfix reload`. Un fallo se REPORTA y se sigue; no se
  // aborta la flota por un nodo caído, pero tampoco se declara éxito global.
  for (const nodo of nodos) {
    let pasoActual = "";
    const planNodo = planDe(nodo.domain);
    try {
      for (const paso of planNodo) {
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
      // EL RENGLÓN LO ARMA `lineaDeUso`, en node-daily-cap.ts, al lado del parser. Acá vivía inline
      // y la rama con contador del día tiraba el prefijo del cupo (`12800/15000`), que es lo que
      // `leerCupoDelNodo` no sabe leer: el agente quedó ciego al cupo de los 9 nodos por encima del
      // techo. Formato y parseo tienen que poder testearse JUNTOS o el contrato no lo cuida nadie.
      const uso = lineaDeUso(s);
      console.log(`  ${s.cableado ? "CAP " : "ABIERTO"} ${nodo.domain.padEnd(32)} ${uso}${s.motivo ? ` — ${s.motivo}` : ""}`);
      // EL FRENO QUE SE DESHIZO, en renglón aparte y SOLO cuando pasó.
      //
      // Va en su propia línea a propósito: `leerCupoDelNodo` (scripts/ops/warmup-monitor.ts) parsea
      // la línea de arriba con regex (`FRENADO \(cap 0\)`, `cap N/día`, `N/M`) y toma la PRIMERA que
      // contenga el dominio. Meterle texto adentro rompería la lectura viva del agente, que es la
      // que arreglaron el 2026-08-07 para que dejara de creerle a una foto de 6 horas.
      //
      // Y solo aparece en `reescrito`: `sin_sello` es el estado de los 58 nodos hasta que alguno se
      // frene por primera vez, y llenar 58 renglones con "no se sabe" sería ruido, no información.
      if (s.freno?.estado === "reescrito") {
        console.log(`         ↳ ${nodo.domain}: el cap se REESCRIBIÓ después del freno (última escritura ${s.freno.capEscritoEn ?? "?"})`);
      }
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

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Hace cuánto se midió, según el archivo. `null` = no hay medición o no se pudo leer. */
async function edadDeLaMedicion(): Promise<number | null> {
  try {
    const previa = await new OpenClawWorkspace().readInventoryJson<CapFlota>(CAP_MEASUREMENT_FILE);
    const t = Date.parse(previa?.medidoEn ?? "");
    return Number.isFinite(t) ? Date.now() - t : null;
  } catch {
    return null;
  }
}

async function correr(): Promise<void> {
  if (CADA_HORAS === null) {
    await main();
    return;
  }
  console.log(`midiendo la flota cada ${CADA_HORAS}h (Ctrl-C para salir).`);
  // RELOJ DE PARED, no `setTimeout` de 6 horas. En macOS los timers NO corren mientras la máquina
  // duerme, y esto vive en la Mac del operador: medido el 2026-08-05, durmió toda la madrugada
  // (varios "Entering Sleep state" en pmset) y la medición quedó vencida 14,6 h con el proceso
  // vivo. Un `setTimeout(6h)` que arranca antes de dormir se despierta tarde y encima recién ahí
  // empieza a contar de nuevo.
  //
  // Con un chequeo corto que compara contra la EDAD REAL del archivo, al volver de dormir la
  // primera vuelta detecta que venció y remide enseguida.
  const CHEQUEO_MS = 5 * 60 * 1000;
  for (;;) {
    const edadMs = await edadDeLaMedicion();
    if (edadMs === null || edadMs >= CADA_HORAS * 60 * 60 * 1000) {
      try {
        await main();
      } catch (error) {
        // Una vuelta que falla NO mata el loop: la medición anterior sigue en disco con su fecha, y
        // quien la lea ya sabe interpretar una medición vieja. Cortar acá sería peor — dejaría de
        // haber mediciones nuevas para siempre por un error transitorio de red.
        console.error(`vuelta fallida: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await dormir(CHEQUEO_MS);
  }
}

correr().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
