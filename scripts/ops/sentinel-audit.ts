#!/usr/bin/env node
// EL COMANDO QUE EVITA EL PRÓXIMO CÍRCULO: auditar el canal de Slack con una sola línea.
//
// La queja textual del jefe es "más de avanzar, estamos entrando a un círculo vicioso infinito, que
// no estoy viendo avances". Sin un instrumento, dentro de dos semanas nadie va a poder decir si
// mejoró o si construimos otro círculo — que es exactamente lo que pasó las últimas tres veces.
// Por eso esto va en el MISMO lote que el criterio y no después: sin el replay, la lista cerrada de
// `REGLAS` es una opinión.
//
// Modelo: scripts/ops/informe-conversacion.ts, que hace lo mismo para la memoria de conversación.
//
//   node --experimental-strip-types scripts/ops/sentinel-audit.ts <ruta-al-log-copiado>
//   node --experimental-strip-types scripts/ops/sentinel-audit.ts <log> <warmup-relevancia.json>
//
// NO escribe nada, NO llama a ningún modelo, NO toca producción. Corre contra una COPIA del log:
//   scp studio:/Users/Shared/delivrix/runtime/logs/warmup-monitor.log /tmp/
//   node --experimental-strip-types scripts/ops/sentinel-audit.ts /tmp/warmup-monitor.log
//
// ── EL BASELINE, PEGADO Y CON SU sha ────────────────────────────────────────────────────────────
//
// Un baseline sin un conteo reproducible atrás no sirve. Circulaban TRES números distintos para lo
// mismo (55%, 53%, y un log que una auditoría encontró truncado a 10 líneas), y la primera versión
// de ESTE archivo agregó un cuarto —11 proactivos, 91% de huella— que era el más equivocado de
// todos: el parser exigía `motivo=` y tiraba en silencio los 38 renglones del formato crudo, así
// que medía las últimas 7 horas de una ventana de 39 y lo declaraba como el total. El "49/26/53%"
// que se había descartado por irreproducible era, salvo un renglón, EXACTO.
//
// Recontado con el parser que ya no descarta nada:
//
//   log:      runtime/logs/warmup-monitor.log de la Mac Studio, copiado el 2026-08-07
//   sha256:   49f09a10da061998e89d5293f40d0773a3294ae70b8e5f25401e545607587a94
//   ventana:  2026-08-05T20:42:05Z .. 2026-08-07T11:53:14Z  (39 h, 194 vueltas con renglón [slack])
//   proactivos: 50    ·    clase huella: 34 (68%)    ·    silencios: 144    ·    no clasificadas: 0
//   desglose:  22 `hice esto: <mano pasiva>` — ir a MIRAR, anunciado como si fuera actuar
//              10 `me trabé / no pude leer el estado` de UNA sola vuelta
//               6 huella pura del panel (placement, plan.accion, plan.diaN)
//               4 `dec5` de manos que SÍ tocaron la infraestructura
//               3 errores del propio modelo · 2 "Sigo acá" sin un dato adentro · 1 emisor arrancó
//   con el criterio nuevo: 6 de los 50 saldrían (4 dec5 + 2 dec3). Los 34 de huella quedan
//              `tapado=clase-huella`, los 10 de ceguera `tapado=una-sola-vuelta` (c1 exige DOS
//              vueltas seguidas y el log no muestra la segunda) y 3 `tapado=error-propio`.
//   respuestas del jefe en el hilo: SIN DATO (el log no guarda el `ts`; ese cable se agrega en
//              este mismo lote, con `mandarASlack` devolviendo el ts)
//
// Reproducible en una línea:
//   grep -c '^\[slack\]' <log>            → 194        (vueltas)
//   grep -c '^\[slack\] silencio' <log>   → 144        (silencios; 194 - 144 = 50 proactivos)
//   grep '^\[slack\]' <log> | grep -ci 'hice esto'  → 26   (22 pasivas + 4 que tocaron infra)
//
// ── CRITERIO DE MUERTE, CON FECHA ───────────────────────────────────────────────────────────────
//
// Escrito el 2026-08-07. Se evalúa el 2026-08-21 corriendo este mismo comando sobre el log de esa
// fecha. Si a los 14 días la huella NO bajó de 68% a ≤10%, o si `no clasificadas` no es 0, o si no
// hay al menos UN mensaje con respuesta del jefe en el hilo, el diseño de las `REGLAS` se revisa
// entero en vez de parcharse. La última mitad manda sobre las otras: el ratio de huella lo puede
// optimizar el código; que él conteste, no.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { REGLAS, TOCAN, type Clase } from "../../apps/gateway-api/src/agents/slack.ts";
import type { TablaRelevancia } from "../../apps/gateway-api/src/agents/slack.ts";

/**
 * PRODUCCIÓN ES SOLO LECTURA, Y ESTO LO HACE CUMPLIR EL CÓDIGO.
 *
 * Apuntar el script al árbol vivo es la forma más fácil de que un `open` con la bandera equivocada,
 * o el próximo agregado que "solo escribe un cachito", toque producción. Se rechaza la ruta entera,
 * no el modo de apertura: es un chequeo que no se puede olvidar de aplicar.
 */
export const ARBOL_DE_PRODUCCION = "/Users/Shared/delivrix";

export function rutaPermitida(ruta: string): boolean {
  const abs = resolve(ruta);
  return abs !== ARBOL_DE_PRODUCCION && !abs.startsWith(`${ARBOL_DE_PRODUCCION}/`);
}

// ── EL PARSER ────────────────────────────────────────────────────────────────────────────────────
//
// Lee las TRES formas del renglón, y tiene que seguir leyendo las tres:
//   nuevo:     [slack] clase=<c> regla=<id> decision=<llave> motivo=<motivo> · <texto>
//   con motivo:[slack] motivo=<motivo> · <texto>
//   crudo:     [slack] Juanes, hice esto: frenar_dominio X. Juanes, …
//
// LA TERCERA FORMA NO ESTABA, Y SE COMÍA EL 78% DEL LOG. El regex exigía `motivo=` y las 39 líneas
// crudas caían en un `if (!partes) continue` sin dejar rastro: sobre el log de producción
// (sha256 49f09a10…) hay 50 proactivos reales y el informe declaraba 11, todos de las últimas 7 h
// de una ventana de 39. El "49 mensajes / 26 con huella / 53%" que el lote anterior declaró
// irreproducible y sobreescribió estaba, salvo un renglón, bien.
//
// Un parser de auditoría no puede fallar abierto: es el instrumento que hace falsificable todo lo
// demás, y fallaba justo en lo que él mismo prohíbe — "un canal donde no se puede saber cuánto se
// calló no se puede calibrar". Por eso ahora ninguna línea `[slack]` se descarta en silencio: la que
// ningún regex entiende se cuenta en `noClasificadas` y sale impresa en el informe.

export interface Mensaje {
  clase: Clase;
  regla: string;
  decision: string | null;
  motivo: string;
  texto: string;
  /** true si la línea ya venía etiquetada (formato nuevo). Separa lo medido de lo reconstruido. */
  etiquetado: boolean;
  /** Bajo el criterio nuevo, ¿saldría? `false` ⇒ queda contado como tapado. */
  saldria: boolean;
  /** Por qué no saldría, cuando no sale. */
  tapado: string | null;
}

export interface Silencio {
  motivo: string;
  clave: string;
}

const IDS = new Set(REGLAS.map((r) => r.id));
const LLAVE_DE = new Map(REGLAS.map((r) => [r.id, r.decision] as const));
const CLASE_DE = new Map(REGLAS.map((r) => [r.id, r.clase] as const));

/** Las manos PASIVAS: ir a mirar. Anunciarlas era 3 de los 11 mensajes del baseline. */
const MIRAR = /\b(medir_dominio|diagnosticar_dominio|leer_cupo_nodo|revisar_reputacion|anotar_pendiente|resolver_pendiente)\b/;

/**
 * A qué regla del criterio NUEVO corresponde una línea VIEJA. Es el corazón del replay: reconstruye
 * la decisión que se habría tomado hoy, sobre los mensajes que de verdad salieron.
 *
 * Es una aproximación DECLARADA: el log no guarda el estado completo de la vuelta, así que dos
 * reglas que dependen de contadores (c1 necesita dos vueltas seguidas, dec1 dos vueltas de emisor)
 * se resuelven por lo que la línea dice y se marcan como no-salida cuando la evidencia de la
 * segunda vuelta no está. Un "no sé" contado como tapado es honesto; contarlo como salida no.
 */
export function reclasificar(motivo: string, texto: string): Pick<Mensaje, "clase" | "regla" | "decision" | "saldria" | "tapado"> {
  const huella = (par: string): Pick<Mensaje, "clase" | "regla" | "decision" | "saldria" | "tapado"> => ({
    clase: "huella",
    regla: `huella:${par}`,
    decision: null,
    saldria: false,
    tapado: "clase-huella"
  });
  const regla = (id: string, saldria: boolean, tapado: string | null) => ({
    clase: (CLASE_DE.get(id) ?? "huella") as Clase,
    regla: id,
    decision: LLAVE_DE.get(id) ?? null,
    saldria,
    tapado
  });

  // `motivo=novedad <campo> [objeto] a→b` — la huella pura que el panel ya pinta.
  const nov = /^novedad ([a-z]+(?:\.[a-zA-Z]+)?)/.exec(motivo);
  if (nov) return huella(nov[1] ?? "?");

  // "Hice esto: <accion>" — el texto de máquina grapado al final de una frase humana. Entra por el
  // motivo (formato con etiqueta) o por el propio texto (formato crudo, que es el 78% del log).
  if (/^ejecutó una acción/.test(motivo) || /\bhice esto\b/i.test(texto)) {
    // Si la mano TOCÓ la infraestructura, sigue saliendo (dec5). Si solo MIRÓ, calla.
    const toco = [...TOCAN].some((a) => new RegExp(`\\b${a}\\b`).test(texto));
    if (toco) return regla("dec5-toque-de-infra", true, null);
    if (MIRAR.test(texto)) return huella("accion-pasiva");
    return huella("accion-desconocida");
  }

  // LAS MISMAS RAMAS, LEÍDAS DEL TEXTO CRUDO. El log viejo no traía `motivo=` y estas frases son las
  // que de verdad salieron a Slack; sin ellas el 78% del archivo no se podía clasificar.
  if (motivo === "") {
    if (/quise\b.*\by no pude|no me deja|acción trabada/i.test(texto)) {
      if (/no es una acción permitida|no está en el inventario|toda acción exige un motivo|ya estaba anotado/i.test(texto)) {
        return { clase: "huella", regla: "huella:error-propio", decision: null, saldria: false, tapado: "error-propio" };
      }
      if (/\bsoltar_dominio\b|\bsoltar\b/.test(texto)) return regla("dec2-soltar-trabado", true, null);
      return regla("dec3-mano-fallo", true, null);
    }
    // "Me trabé: dije algo que no cuadra con los datos" son los REPAROS: la vuelta quedó igual de
    // ciega que sin lectura (con reparos el agente no ejecuta nada), y c1 las trata juntas.
    if (/no pude leer el estado|no puedo leer el estado|vigilando a ciegas|me trabé|no cuadra con los datos/i.test(texto)) {
      return regla("c1-sin-lectura-2", false, "una-sola-vuelta");
    }
    // Pasar a `send` es una buena noticia, no una llave. Y "Sigo acá. Ya los estoy evaluando…" es la
    // regresión textual del mensaje sin un solo dato para agarrar: huella pura, no interrumpe.
    if (/el emisor arrancó/i.test(texto)) return huella("emisor-arranco");
    if (/^sigo acá/i.test(texto)) return huella("sin-novedad");
  }

  if (/^acción trabada/.test(motivo)) {
    // Un desliz del propio modelo no es una decisión del jefe: no hay nada que resolver del otro lado.
    if (/no es una acción permitida|no está en el inventario|toda acción exige un motivo/i.test(texto)) {
      return { clase: "huella", regla: "huella:error-propio", decision: null, saldria: false, tapado: "error-propio" };
    }
    if (/\bsoltar_dominio\b|\bsoltar\b/.test(texto)) return regla("dec2-soltar-trabado", true, null);
    return regla("dec3-mano-fallo", true, null);
  }

  // Una sola vuelta ciega no interrumpe: c1 exige DOS seguidas. El log no dice si la siguiente
  // también lo fue, así que se cuenta como tapado y se dice por qué.
  if (/^sin lectura|^reparos/.test(motivo)) return regla("c1-sin-lectura-2", false, "una-sola-vuelta");

  if (/^el emisor pasó/.test(motivo)) {
    // Pasar a `send` es una buena noticia, no una llave: dec1 solo habla del emisor FRENADO.
    if (/a send$/.test(motivo)) return huella("emisor-arranco");
    return regla("dec1-emisor-pausado", false, "una-sola-vuelta");
  }

  return { clase: "huella", regla: "huella:sin-clasificar", decision: null, saldria: false, tapado: "sin-plantilla" };
}

export function parsear(log: string): {
  mensajes: Mensaje[];
  silencios: Silencio[];
  vueltas: number;
  /** Renglones `[slack]` que ningún regex entendió. Se cuentan: un parser de auditoría no falla abierto. */
  noClasificadas: number;
} {
  const mensajes: Mensaje[] = [];
  const silencios: Silencio[] = [];
  let vueltas = 0;
  let noClasificadas = 0;

  for (const linea of log.split("\n")) {
    if (!linea.startsWith("[slack]")) continue;
    vueltas++;

    const sil = /^\[slack\] silencio:\s*(.*)$/.exec(linea);
    if (sil) {
      const cuerpo = sil[1] ?? "";
      const tapados = [...cuerpo.matchAll(/tapado=([a-z-]+):([^,\s]+)/g)];
      if (tapados.length > 0) for (const t of tapados) silencios.push({ motivo: t[1] ?? "?", clave: t[2] ?? "" });
      else silencios.push({ motivo: "nada-que-decir", clave: "" });
      continue;
    }

    // El "NO enviado" es un mensaje que el criterio SÍ dejó salir y que Slack rechazó. Cuenta como
    // mensaje: lo que se audita acá es el criterio, no la red.
    const m = /^\[slack\](?: NO enviado \([^)]*\))? (.*)$/.exec(linea);
    if (!m) continue;
    const cuerpo = m[1] ?? "";
    if (cuerpo.startsWith("error al decidir")) continue;

    const partes = /^(?:clase=(\S+) )?(?:regla=(\S+) )?(?:decision=(\S+) )?motivo=(.*?)(?: · | — habría dicho: )(.*)$/.exec(cuerpo);
    if (!partes) {
      // FORMATO CRUDO: el renglón es el texto que salió a Slack, sin etiquetas. Se clasifica por el
      // texto y, si ni eso alcanza, cae en `huella:sin-clasificar` y se CUENTA. Nunca `continue`:
      // acá se perdían 38 de los 49 proactivos del log de producción sin dejar rastro.
      const r = reclasificar("", cuerpo);
      if (r.regla === "huella:sin-clasificar") noClasificadas += 1;
      mensajes.push({ motivo: "", texto: cuerpo, etiquetado: false, ...r });
      continue;
    }
    const [, clase, regla, decision, motivo = "", texto = ""] = partes;

    if (clase && regla) {
      // FORMATO NUEVO: se cuenta tal cual salió. No se reclasifica lo que ya viene etiquetado.
      mensajes.push({
        clase: clase as Clase,
        regla,
        decision: decision && decision !== "-" ? decision : null,
        motivo,
        texto,
        etiquetado: true,
        saldria: true,
        tapado: null
      });
      continue;
    }
    const r = reclasificar(motivo, texto);
    if (r.regla === "huella:sin-clasificar") noClasificadas += 1;
    mensajes.push({ motivo, texto, etiquetado: false, ...r });
  }
  return { mensajes, silencios, vueltas, noClasificadas };
}

// ── EL INFORME ───────────────────────────────────────────────────────────────────────────────────

const pct = (n: number, d: number): string => (d === 0 ? "sin dato" : `${Math.round((n / d) * 100)}%`);

function cuenta<T>(xs: readonly T[], por: (x: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(por(x), (m.get(por(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

export function informe(log: string, sha: string, tabla: TablaRelevancia | null): string[] {
  const { mensajes, silencios, vueltas, noClasificadas } = parsear(log);
  const l: string[] = [];
  const salen = mensajes.filter((x) => x.saldria);
  const tapados = mensajes.filter((x) => !x.saldria);
  const huella = mensajes.filter((x) => x.clase === "huella");

  l.push("AUDITORÍA DEL CANAL DE SENTINEL");
  l.push(`  log sha256   ${sha}`);
  l.push(`  vueltas con renglón [slack]   ${vueltas}`);
  l.push("");
  l.push(`MENSAJES PROACTIVOS: ${mensajes.length}   (baseline 2026-08-05..07: 50)`);
  l.push(`  clase huella       ${huella.length} · ${pct(huella.length, mensajes.length)}   (baseline: 34 · 68%)`);
  l.push(`  criterio nuevo     ${salen.length} saldrían · ${tapados.length} quedarían tapados`);
  // NO-CLASIFICADAS SIEMPRE, incluso en cero. Es el número que dice si el instrumento está midiendo
  // todo el archivo o sólo la parte que entiende: la vez que se calló, el informe declaró 11 de 49.
  l.push(`  no clasificadas    ${noClasificadas}${noClasificadas > 0 ? "   ← el parser no las entendió (van contadas, no perdidas)" : ""}`);
  l.push("");

  l.push("POR CLASE");
  for (const [c, n] of cuenta(mensajes, (x) => x.clase)) l.push(`  ${c.padEnd(20)} ${n}`);
  l.push("");

  l.push("POR REGLA");
  for (const [r, n] of cuenta(mensajes, (x) => x.regla)) {
    const conocida = IDS.has(r) || r.startsWith("huella:");
    l.push(`  ${r.padEnd(28)} ${String(n).padStart(3)}${conocida ? "" : "   ← NO está en REGLAS"}`);
  }
  l.push("");

  const pidieron = mensajes.filter((x) => x.decision !== null);
  l.push(`PIDIERON UNA DECISIÓN: ${pidieron.length}`);
  for (const [d, n] of cuenta(pidieron, (x) => x.decision ?? "-")) l.push(`  ${d.padEnd(28)} ${n}`);
  l.push("");

  // LO QUE NO SALIÓ, CON SU MOTIVO. Un canal donde no se puede saber cuánto se calló no se calibra.
  l.push("TAPADOS (mensajes que hoy salieron y con el criterio nuevo no saldrían)");
  if (tapados.length === 0) l.push("  ninguno");
  for (const [t, n] of cuenta(tapados, (x) => x.tapado ?? "?")) l.push(`  tapado=${(t + "").padEnd(22)} ${n}`);
  l.push("");
  l.push("SILENCIOS REGISTRADOS EN EL LOG");
  if (silencios.length === 0) l.push("  ninguno");
  for (const [s, n] of cuenta(silencios, (x) => x.motivo)) l.push(`  ${s.padEnd(28)} ${n}`);
  l.push("");

  // RESPUESTAS DEL JEFE. Es el numerador que manda y el que él no puede falsear desde el código.
  // Hasta que el orquestador guarde el `ts` de cada proactivo, esto es SIN DATO — nunca 0. "No
  // medido" y "cero" no son lo mismo, y confundirlos es la confusión más cara del sistema.
  l.push("RESPUESTAS DEL JEFE EN EL HILO");
  if (!tabla) {
    l.push("  sin dato — no se pasó warmup-relevancia.json (el log no guarda el ts del mensaje)");
  } else {
    const pares = Object.entries(tabla);
    const respondio = pares.reduce((a, [, e]) => a + e.respondio, 0);
    const salieron = pares.reduce((a, [, e]) => a + e.salieron, 0);
    l.push(`  ${respondio} respuestas sobre ${salieron} salidas con el jefe despierto · ${pct(respondio, salieron)}`);
  }
  l.push("");

  l.push("TABLA DE RELEVANCIA APRENDIDA");
  if (!tabla || Object.keys(tabla).length === 0) {
    // QUE SE VEA VACÍA EN VEZ DE PARECER QUE NO HAY NADA QUE DECIR. La tabla arranca vacía por
    // diseño: no se construye exploración, así que puede tardar semanas en promover algo. Y las dos
    // puertas se imprimen al lado, porque una tabla vacía sin ellas se lee como "el aprendizaje está
    // roto" cuando lo que dice es "todavía no hay evidencia" — y ahí empieza la vuelta siguiente del
    // círculo. Medido el 2026-08-07: la memoria de conversación tenía 6 temas con UNA vista cada uno.
    l.push("  vacía: ningún par llegó al piso de 3 observaciones todavía");
    l.push("    se abre un par con 3 preguntas suyas sobre el MISMO campo en 14 días, o 3 respuestas suyas en el hilo.");
    l.push("    hasta que eso pase, el canal son las tres clases que interrumpen y NADA de huella. Es el diseño, no una falla.");
  } else {
    for (const [par, e] of Object.entries(tabla).sort((a, b) => b[1].muestra - a[1].muestra)) {
      // EL PESO NUNCA SIN SU MUESTRA AL LADO. Un peso sobre 3 muestras no es un peso, y el informe
      // tiene que poder decir "todavía no sé".
      const nota = e.muestra < 3 ? " (muestra corta: todavía no sé)" : "";
      l.push(`  ${par.padEnd(28)} peso ${e.peso} sobre ${e.muestra} observaciones · salió ${e.salieron}, contestó ${e.respondio}, se quejó ${e.quejo}${nota}`);
    }
  }
  return l;
}

async function main(): Promise<void> {
  const [ruta, rutaTabla] = process.argv.slice(2);
  if (!ruta) {
    console.error("uso: sentinel-audit.ts <ruta-al-log-copiado> [warmup-relevancia.json]");
    process.exitCode = 2;
    return;
  }
  if (!rutaPermitida(ruta)) {
    console.error(`ese log vive en producción (${ARBOL_DE_PRODUCCION}). Copialo primero con scp y corré esto sobre la copia.`);
    process.exitCode = 2;
    return;
  }
  const log = await readFile(ruta, "utf8");
  const sha = createHash("sha256").update(log).digest("hex");
  const tabla = rutaTabla ? ((JSON.parse(await readFile(rutaTabla, "utf8")) as TablaRelevancia) ?? null) : null;
  for (const linea of informe(log, sha, tabla)) console.log(linea);
}

// Solo corre como comando. Importado desde el test, no hace nada.
if (process.argv[1] && process.argv[1].endsWith("sentinel-audit.ts")) await main();
