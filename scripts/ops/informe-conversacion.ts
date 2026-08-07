#!/usr/bin/env node
// LOS NÚMEROS DE LA MEMORIA DE LA CONVERSACIÓN, cada uno con su baseline al lado.
//
// Por qué existe: este paquete tiene CRITERIO DE MUERTE con fecha —a los 14 días la tasa de
// `insiste` baja de 19% a ≤10% y las respuestas repetidas de 5 a 0, o se saca— y un criterio que
// hay que reconstruir a mano no se evalúa nunca. Antes de esto los mismos números salían de
// grepear el log (`grep -c "tardó demasiado" warmup-monitor.log`), y un grep sobre un archivo que
// rota no es una medición: cuando el log se corte, el baseline desaparece con él.
//
// El baseline va PEGADO a cada número y con su fecha, en vez de vivir en un documento aparte. Un
// informe que dice "insiste: 22%" sin decir contra qué, no dice nada; y un número escrito a mano
// en el texto envejece sin avisar — ese modo de falla ya pasó acá, con el log que anunciaba "leo
// cada 20s" meses después de haber bajado a 6.
//
//   node --experimental-strip-types scripts/ops/informe-conversacion.ts <ruta-al-json-copiado>
//
// Sin flags y sin subcomandos: imprime y sale. NO escribe nada, no toca producción, no llama a
// ningún modelo. Contra producción, SOBRE UNA COPIA (ver `rutaPermitida`):
//   scp studio:/Users/Shared/delivrix/runtime/openclaw-workspace/inventory/warmup-conversacion.json /tmp/
//   node --experimental-strip-types scripts/ops/informe-conversacion.ts /tmp/warmup-conversacion.json
//
// ── EL BASELINE, PEGADO Y CON SU sha ────────────────────────────────────────────────────────────
//
//   archivo:  runtime/openclaw-workspace/inventory/warmup-conversacion.json de la Mac Studio,
//             copiado el 2026-08-07
//   sha256:   c73203fb8c33fd2924d36e2f18133320e24b812fe20a5a992f0def8351a12938
//   ventana:  2026-08-06T20:53:33Z .. 2026-08-07T18:36:18Z
//   18 intercambios · 0 insiste · 8 conforme · 1 corrige · 9 sin reacción
//   4 repetidas (22%) · 0 inventadas · 0 fallos · latencia mediana 16 s
//
// Reproducible sin este repo, sobre el JSON copiado:
//   python3 -c "import json,collections;m=json.load(open('warmup-conversacion.json'));\
//     e=m['intercambios'];print(len(e),collections.Counter(x['reaccion'] for x in e),\
//     sum(1 for x in e if x['repetida']),sum(x['inventadas'] for x in e))"
//
// ── EL ÍNDICE, Y POR QUÉ ES DE TRES CONTADORES ──────────────────────────────────────────────────
//
// Sin un número compuesto, "mejoró" se discute mirando seis columnas y gana el que habla más
// fuerte. El índice suma lo único que BAJA cuando la conversación mejora de verdad:
//
//   · tasaInsiste          — volvió a preguntar lo mismo. Evidencia DURA: escribió otra vez.
//   · repetidas / n        — el agente dijo dos veces casi lo mismo. Es la queja textual del jefe.
//   · sinRespuesta / n     — después de ese intercambio el jefe NO VOLVIÓ A ESCRIBIR. Silencio duro.
//
// `conforme` NO ENTRA, y esa exclusión es el corazón del anti-gaming: es evidencia débil ("Ok!"
// tanto puede ser "entendí" como "ya fue, dejalo") y un índice que la premia se gana escribiendo
// mensajes que cierren la charla. Se reporta aparte y con su etiqueta.
//
// EL TERCER COMPONENTE ERA `sinReacción` Y SE PODÍA GANAR CON "Ok!", que es la misma puerta con el
// signo invertido: `sinReacción` es `reaccion === null`, así que cada conforme SACA un intercambio
// de ese balde y BAJA el índice. Medido sobre el archivo real duplicado para pasar el piso (n=36):
// 24,1 ⇒ 7,4 (−69%) convirtiendo los nulos en conformes, sin que la conversación mejorara en nada.
// Ahora el componente no mira etiquetas: mira si hubo un mensaje POSTERIOR del jefe.
//
// Y eso destapó que `sinReacción` nunca midió silencio: de los 9 nulos del baseline, OCHO tienen un
// mensaje posterior del jefe. Medía al etiquetador (`anotarReaccion` pone una etiqueta por mensaje),
// no al jefe. Se sigue reportando abajo, con ese nombre y sin entrar al número.
//
// CON MENOS DE 30 INTERCAMBIOS NO SE IMPRIME UN NÚMERO, se imprime `no sé`. Es la lección del
// `placement-pause`, donde 4 muestras sueltas frenaron al único dominio que estaba calentando bien:
// una tasa sobre 18 registros no es una tasa, es una anécdota con decimales.
//
// ── CRITERIO DE MUERTE, CON FECHA ───────────────────────────────────────────────────────────────
//
// Escrito el 2026-08-07. Se evalúa el 2026-08-21 corriendo este mismo comando sobre una copia del
// archivo de esa fecha. Si a los 14 días `repetidas` no bajó de 22% a ≤5%, o si no hay AL MENOS UN
// mensaje con respuesta del jefe en el hilo, el diseño se revisa entero en vez de parcharse. La
// segunda mitad manda sobre la primera: el ratio lo puede optimizar el código; que él conteste, no.

import { readFile } from "node:fs/promises";

import { resumen, type MemoriaConversacion } from "../../apps/gateway-api/src/agents/memoria-conversacion.ts";
import { ARBOL_DE_PRODUCCION, rutaPermitida } from "./sentinel-audit.ts";

const pct = (parte: number, total: number): string => (total === 0 ? "—" : `${Math.round((parte / total) * 100)}%`);

/**
 * Muestra mínima para que el índice sea un número y no una anécdota.
 *
 * 30 y no 18: con los 18 que hay hoy, UN intercambio mueve cada tasa 5,6 puntos, así que el informe
 * "mejoraría" o "empeoraría" un 5% por el ruido de una sola conversación.
 */
export const MINIMO_PARA_INDICE = 30;

/**
 * El índice, PURO y sobre los tres contadores que solo bajan si la conversación mejoró.
 *
 * `null` = muestra insuficiente. No hay un número de reemplazo, ni un 0, ni un "provisorio": este
 * informe existe para no fabricar exactamente eso.
 */
export function indice(r: ReturnType<typeof resumen>): { valor: number; partes: [number, number, number] } | null {
  const n = r.intercambios;
  if (n < MINIMO_PARA_INDICE) return null;
  const partes: [number, number, number] = [r.tasaInsiste, r.repetidas / n, r.sinRespuesta / n];
  // Promedio simple: los tres pesan igual porque no hay ninguna medición que justifique otra cosa,
  // y ponderar a ojo sería elegir el número que da lindo. Si alguna vez hay evidencia de que uno
  // duele más, se pondera ACÁ y con el dato al lado.
  return { valor: Math.round(((partes[0] + partes[1] + partes[2]) / 3) * 1000) / 10, partes };
}

export function lineas(mem: MemoriaConversacion, ahoraISO: string): string[] {
  const r = resumen(mem, ahoraISO);
  const n = r.intercambios;
  const l: string[] = [];

  const i = indice(r);
  l.push("ÍNDICE DE LA CONVERSACIÓN (más bajo es mejor; 0 = ni insiste, ni repite, ni queda sin respuesta)");
  l.push(
    i === null
      ? `  no sé — ${n} intercambios y hacen falta ${MINIMO_PARA_INDICE}. Una tasa sobre ${n} registros no es una tasa.` +
          `   (baseline 2026-08-07: 18 intercambios, o sea que el día que se escribió esto TAMPOCO había número)`
      : `  ${i.valor}%   = insiste ${pct(r.insiste, n)} + repetidas ${pct(r.repetidas, n)} + sin respuesta ${pct(r.sinRespuesta, n)}, promediados` +
          `   (baseline 2026-08-07: sin dato, n=18)`
  );
  l.push("");

  l.push(`intercambios contestados: ${n}`);
  l.push(
    `insiste: ${r.insiste}/${n} = ${pct(r.insiste, n)}` +
      `   (baseline: 0/18 = 0% · evidencia DURA: volvió a preguntar lo mismo)`
  );
  l.push(
    `respuestas repetidas: ${r.repetidas}/${n} = ${pct(r.repetidas, n)}` +
      `   (baseline: 4/18 = 22% · CRITERIO DE MUERTE 2026-08-21: ≤5% o se revisa el diseño entero)`
  );
  l.push(
    `sin respuesta (no volvió a escribir después): ${r.sinRespuesta}/${n} = ${pct(r.sinRespuesta, n)}` +
      `   (ENTRA AL ÍNDICE · no mira etiquetas: un "Ok!" no lo puede mover)`
  );
  // SE REPORTA Y NO ENTRA AL NÚMERO, y el baseline de 50% queda acá con su corrección: de esos 9
  // nulos, 8 tienen un mensaje POSTERIOR del jefe. Este contador mide al etiquetador —
  // `anotarReaccion` pone una etiqueta por mensaje del jefe— no a una persona callada.
  l.push(
    `sin etiqueta de reacción: ${r.sinReaccion}/${n} = ${pct(r.sinReaccion, n)}` +
      `   (baseline: 9/18 = 50%, de los cuales 8 SÍ tenían mensaje posterior: mide al etiquetador)`
  );
  l.push(
    `invenciones (revisarRespuesta): ${r.inventadas}` +
      `   (baseline: 0 · MÉTRICA DE NO-DAÑO: si sube, se revierte AUNQUE el índice haya bajado)`
  );
  // UN CERO QUE NADIE MIDIÓ ES PEOR QUE UN RENGLÓN VACÍO, y acá el cero es estructural: el único
  // `anotarConversacion(` del sistema (scripts/ops/warmup-monitor.ts) está en el camino feliz y
  // pasa `fallo: null` literal; la rama de fallo hace `continue` sin anotar nada. O sea que un turno
  // muerto no entra ni al numerador ni al denominador. Se AUTOCORRIGE: apenas el orquestador anote
  // el primer fallo, el número aparece solo.
  l.push(
    r.fallos > 0
      ? `turnos fallidos: ${r.fallos}/${n} = ${pct(r.fallos, n)}` +
          `   (baseline: 65 de 98 = 66% — es presupuesto de tokens y timeout, NO se le atribuye a la memoria)`
      : `turnos fallidos: SIN INSTRUMENTAR — nadie escribe todavía el campo "fallo" (el único anotarConversacion` +
          ` del sistema está en el camino feliz), así que un 0 acá no mide nada.   (baseline: 65 de 98 = 66%)`
  );
  l.push(
    `latencia jefe→respuesta: mediana ${r.latencia.mediana} · p90 ${r.latencia.p90} · máx ${r.latencia.max} min` +
      `   (baseline: 0,3 / 1,1 / 1,1 min — NO es de la memoria; está acá para poder descontarla)`
  );
  // EL NÚMERO CON EL QUE SE ELIGE EL TIMEOUT DEL CHAT. Ojo con confundirlo con el de arriba: ese
  // incluye la espera de lectura de Slack y las horas en que el agente estuvo sordo (máximo medido
  // 126 MINUTOS), este es el fetch al modelo. Nunca se promedian.
  l.push(
    r.modelo.n >= 20
      ? `latencia DEL MODELO: p50 ${r.modelo.p50} · p95 ${r.modelo.p95} · máx ${r.modelo.max} s sobre ${r.modelo.n} turnos` +
          `   (con esto se elige TIMEOUT_PRIMER_INTENTO, hoy 120 s)`
      : `latencia DEL MODELO: ${r.modelo.n} turno(s) con tardoMs — MUESTRA INSUFICIENTE para un percentil (hacen falta 20).` +
          `   Hasta que llegue, TIMEOUT_PRIMER_INTENTO=120 s se sostiene en el máximo observado de 171 s, no en un p95 medido.`
  );
  // FUERA DEL ÍNDICE Y CON SU ETIQUETA. Un índice que premia conformes se gana diciendo cosas que
  // cierren la charla; y desde el arreglo de `clasificarReaccion` sabemos que además venía
  // contaminado con pedidos nuevos que arrancaban corteses ("Ok me avisas. También tú mismo…").
  l.push(
    `conforme: ${r.conforme} · corrige: ${r.corrige}   (FUERA DEL ÍNDICE: "conforme" es evidencia DÉBIL —` +
      ` "Ok!" tanto puede ser "entendí" como "ya fue, dejalo" — y premiarlo se puede ganar cerrando la charla)`
  );

  l.push("");
  l.push("lo que más pregunta (últimos 14 días · YA NO ENTRA AL PROMPT: el bloque se sacó por inalcanzable):");
  if (r.temas.length === 0) l.push("  ninguno todavía");
  for (const t of r.temas) l.push(`  ${String(t.veces).padStart(3)}× · "${t.cita}" · última ${t.ultimaVez}`);
  return l;
}

async function main(): Promise<void> {
  const ruta = process.argv[2];
  if (!ruta) {
    console.error("uso: informe-conversacion.ts <ruta-al-json-copiado>");
    process.exitCode = 2;
    return;
  }
  // PRODUCCIÓN ES SOLO LECTURA Y LO HACE CUMPLIR EL CÓDIGO, igual que en sentinel-audit.ts. Este
  // script leía el árbol vivo por defecto (sin argumento abría el workspace de producción), que es
  // la forma más fácil de que el próximo agregado "que solo escribe un cachito" toque el archivo
  // que el daemon está reescribiendo bajo lock cada 6 segundos.
  if (!rutaPermitida(ruta)) {
    console.error(`ese archivo vive en producción (${ARBOL_DE_PRODUCCION}). Copialo con scp y corré esto sobre la copia.`);
    process.exitCode = 2;
    return;
  }
  // Sin `.catch(() => null)` a propósito: un catch acá taparía un JSON corrupto y lo mostraría como
  // "0 intercambios", que es la peor lectura posible de un informe que existe para decidir si algo
  // se saca o se deja.
  const mem = JSON.parse(await readFile(ruta, "utf8")) as MemoriaConversacion;
  for (const linea of lineas(mem, new Date().toISOString())) console.log(linea);
}

// Solo corre como comando. Importado desde el test, no hace nada.
if (process.argv[1] && process.argv[1].endsWith("informe-conversacion.ts")) await main();
