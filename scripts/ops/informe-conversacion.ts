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
//   node --experimental-strip-types scripts/ops/informe-conversacion.ts
//   node --experimental-strip-types scripts/ops/informe-conversacion.ts <ruta-al-json>
//
// Sin flags y sin subcomandos: imprime y sale. NO escribe nada, no toca producción, no llama a
// ningún modelo. Los seis números salen de `resumen()`, que es aritmética sobre los registros
// guardados — por eso no hay test acá: lo que hay que probar está probado en memoria-conversacion.
// Contra producción, sin tocarla:
//   scp studio:/Users/Shared/delivrix/runtime/openclaw-workspace/inventory/warmup-conversacion.json /tmp/
//   node --experimental-strip-types scripts/ops/informe-conversacion.ts /tmp/warmup-conversacion.json

import { readFile } from "node:fs/promises";

import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { resumen, type MemoriaConversacion } from "../../apps/gateway-api/src/agents/memoria-conversacion.ts";

/** El mismo nombre que escribe el daemon en su tick de chat. */
const MEMORIA_FILE = "warmup-conversacion.json";

const pct = (parte: number, total: number): string => (total === 0 ? "—" : `${Math.round((parte / total) * 100)}%`);

async function main(): Promise<void> {
  const ruta = process.argv[2];
  // Sin `.catch(() => null)` a propósito: readInventoryJson YA devuelve null si el archivo no
  // existe (que es el caso normal antes del primer intercambio). Un catch acá taparía un JSON
  // corrupto y lo mostraría como "0 intercambios", que es la peor lectura posible de un informe
  // que existe para decidir si algo se saca o se deja.
  const mem = ruta
    ? (JSON.parse(await readFile(ruta, "utf8")) as MemoriaConversacion)
    : await new OpenClawWorkspace().readInventoryJson<MemoriaConversacion>(MEMORIA_FILE);

  if (!mem) {
    console.log(`todavía no hay memoria de conversación (falta inventory/${MEMORIA_FILE}).`);
    return;
  }

  const r = resumen(mem, new Date().toISOString());
  const n = r.intercambios;

  console.log(`intercambios contestados: ${n}`);
  console.log(
    `insiste: ${r.insiste}/${n} = ${pct(r.insiste, n)}` +
      `   (baseline 2026-08-06: 6/32 = 19% · ES LA ÚNICA que la memoria debería mover: con n≥50 en 14 días, ≤10%)`
  );
  console.log(
    `respuestas repetidas <10 min en el mismo hilo: ${r.repetidas}` +
      `   (baseline: 5, tres de ellas en el hilo ...393 entre 03:28 y 03:31 — tiene que dar 0)`
  );
  console.log(
    `invenciones (revisarRespuesta): ${r.inventadas}` +
      `   (baseline: 3 en el log · MÉTRICA DE NO-DAÑO: si sube, se revierte AUNQUE insiste haya bajado)`
  );
  // UN CERO QUE NADIE MIDIÓ ES PEOR QUE UN RENGLÓN VACÍO, y acá el cero es estructural: el único
  // `anotarConversacion(` del sistema (scripts/ops/warmup-monitor.ts) está en el camino feliz y
  // pasa `fallo: null` literal; la rama de fallo hace `continue` sin anotar nada. O sea que un turno
  // muerto no entra ni al numerador ni al denominador, y esto imprimía "turnos fallidos: 0/6 = 0%"
  // al lado de un baseline de 66%, sobre una jornada en la que el log tenía 65 turnos muertos. A los
  // 14 días eso se lee como "la memoria bajó los fallos de 66% a 0%" — el instrumento fabricando
  // exactamente el dato que este módulo existe para no fabricar.
  //
  // Se AUTOCORRIGE: apenas el orquestador anote el primer fallo, el número aparece solo. Un 0 con el
  // instrumento cableado se lee igual como "sin instrumentar", y esa es la dirección correcta de
  // error: subestimar la memoria no le regala nada.
  console.log(
    r.fallos > 0
      ? `turnos fallidos: ${r.fallos}/${n} = ${pct(r.fallos, n)}` +
          `   (baseline: 65 de 98 = 66% — es presupuesto de tokens y timeout, NO se le atribuye a la memoria)`
      : `turnos fallidos: SIN INSTRUMENTAR — nadie escribe todavía el campo "fallo" (el único anotarConversacion` +
          ` del sistema está en el camino feliz), así que un 0 acá no mide nada.` +
          `   (baseline: 65 de 98 = 66%)`
  );
  console.log(
    `latencia jefe→respuesta: mediana ${r.latencia.mediana} · p90 ${r.latencia.p90} · máx ${r.latencia.max} min` +
      `   (baseline: 1,8 / 108 / 126 — tampoco es de la memoria; está acá para poder descontarla)`
  );
  // EL NÚMERO CON EL QUE SE ELIGE EL TIMEOUT DEL CHAT, y hasta hoy no existía: se estaba eligiendo a
  // ojo. Ojo con confundirlo con el de arriba — ese incluye la espera de lectura de Slack y las
  // horas en que el agente estuvo sordo (máximo 126 MINUTOS), este es el fetch al modelo. Nunca se
  // promedian.
  //
  // Con menos de 20 muestras no se imprime percentil: un p95 sobre 3 turnos es un número redondo que
  // parece medido, y este informe existe justamente para no fabricar eso. Se dice cuántas van.
  console.log(
    r.modelo.n >= 20
      ? `latencia DEL MODELO: p50 ${r.modelo.p50} · p95 ${r.modelo.p95} · máx ${r.modelo.max} s sobre ${r.modelo.n} turnos` +
          `   (con esto se elige TIMEOUT_PRIMER_INTENTO, hoy 120 s. Referencia sin instrumento: p50 declarado 52 s, máx observado 171 s)`
      : `latencia DEL MODELO: ${r.modelo.n} turno(s) con tardoMs — MUESTRA INSUFICIENTE para un percentil (hacen falta 20).` +
          `   Hasta que llegue, TIMEOUT_PRIMER_INTENTO=120 s se sostiene en el máximo observado de 171 s, no en un p95 medido.`
  );
  // Los conformes van como contador de contexto y nunca solos como "esta respuesta estuvo bien":
  // "Ok!" tanto puede ser "entendí" como "ya fue, dejalo". Un `insiste` es evidencia dura porque
  // el jefe volvió a escribir; un `conforme` es débil. Y `sin evidencia` no es aprobación: es que
  // no contestó nada, igual que `sin_evidencia` en bitacora-acciones.ts.
  console.log(`reacciones: conforme ${r.conforme} · corrige ${r.corrige} · sin evidencia ${r.sinReaccion}`);

  console.log("");
  console.log(`lo que más pregunta (últimos 14 días, piso de 3 veces para llegar al prompt):`);
  if (r.temas.length === 0) console.log("  ninguno todavía");
  for (const t of r.temas) console.log(`  ${String(t.veces).padStart(3)}× · "${t.cita}" · última ${t.ultimaVez}`);
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
