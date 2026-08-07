#!/usr/bin/env node
// ¿EL CAMPO QUE PROMETIMOS EXISTE DE VERDAD EN PRODUCCIÓN? — un archivo y una regla.
//
// Este repo cometió SEIS veces la misma falla, y no son seis bugs distintos: es una costumbre que
// faltaba. El test prueba que la función anda cuando la llaman; NADIE probaba que el artefacto
// exista en el árbol vivo. Las seis, medidas:
//
//   1. `pausar_warmup` fue un no-op durante semanas: la mano estaba en la lista blanca y el
//      orquestador nunca pasó la capacidad.
//   2. `frenar_dominio` anunciada plana en el prompt y cableada detrás de un flag apagado: 26
//      rechazos de "no está habilitado" en 5 horas sobre 31 pedidos del mismo dominio.
//   3. `revisar_reputacion` con módulo escrito, testeado y sin productor en runtime.
//   4. El barrido de reputación: escrito, testeado y sin correr durante horas.
//   5. `bitacora-acciones`: 54 entradas, 0 veredictos y 0 con `antes`, porque `juzgar` filtra
//      `frenar_dominio` y de esa acción no hay UNA sola entrada.
//   6. `tls` en los 66 dominios: el chequeo existía, `authRota` YA excluía por `tls === "mal"`, y
//      el llamador nunca pasaba la sonda — o sea una válvula conectada a un dato imposible.
//
// LA REGLA, que es lo que hace valer a este archivo: un campo nuevo en un JSON de runtime NO está
// terminado por tener test verde. Está terminado cuando `artefactos.ts` lo ve NO NULO sobre una
// copia de producción 24 h después del despliegue. Un campo en FALTA a las 24 h significa que el
// lote no está terminado, aunque el gate esté en verde.
//
//   scp -r studio:/Users/Shared/delivrix/runtime/openclaw-workspace/inventory /tmp/inv
//   node --experimental-strip-types scripts/ops/artefactos.ts /tmp/inv
//
// NO escribe nada, no llama a ningún modelo, y RECHAZA el árbol de producción con el mismo guard
// que ya usa sentinel-audit.ts. Sin flags, sin subcomandos: imprime FALTA/OK y sale.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ARBOL_DE_PRODUCCION, rutaPermitida } from "./sentinel-audit.ts";

/**
 * Una fila: qué campo, en qué archivo, quién lo prometió y desde cuándo.
 *
 * `donde` es una ruta con puntos desde la raíz del JSON; `[]` significa "en cada elemento de este
 * array". `warmup-acciones.json → entradas[].veredicto` se escribe `entradas[].veredicto`.
 */
export interface Fila {
  archivo: string;
  donde: string;
  promete: string;
  desde: string;
  /**
   * Valores que están PRESENTES y no miden nada. Sin esto, la barrera miente exactamente igual que
   * el sistema que vigila: verificado contra la copia real, `dominios[].tls.estado` daba OK 66/66
   * — con los 66 en `"no-se"`, que es el 6º incidente intacto (el chequeo existía y el llamador
   * nunca pasaba la sonda). "Presente" y "medido" no son lo mismo.
   */
  noVale?: readonly string[];
}

export const FILAS: readonly Fila[] = [
  // D — la bitácora aprende, o se saca. 54 entradas, 0 veredictos, 0 con `antes`.
  { archivo: "warmup-acciones.json", donde: "entradas[].antes", promete: "lote 2 · las manos que MIRAN dejan su foto del antes", desde: "2026-08-07" },
  { archivo: "warmup-acciones.json", donde: "entradas[].veredicto", promete: "lote 2 · juzgar sobre cualquier acción con antes", desde: "2026-08-07" },
  // A.1/A.2 — la reacción del jefe, que ya se guardaba y volvía mal medida.
  { archivo: "warmup-conversacion.json", donde: "intercambios[].reaccion", promete: "lote 2 · sin ventana de 15 min y sin conformes contaminados", desde: "2026-08-07" },
  // G.1/G.2 — las dos señales que se leían y nadie escribía.
  { archivo: "warmup-reputacion.json", donde: "dominios[].tls.estado", promete: "lote 2 · sonda STARTTLS por el 587 (sondaTlsDelNodo)", desde: "2026-08-07", noVale: ["no-se"] },
  { archivo: "warmup-reputacion.json", donde: "dominios[].receptor", promete: "lote 2 · receptorDe desde sender-measurement", desde: "2026-08-07" },
  // B3 — la propuesta que argumenta y no ejecuta. Consume los dos campos del lote 3.
  { archivo: "warmup-monitor.json", donde: "hechos.plan[].placementProveedor", promete: "lote 3 · el placement dice de qué proveedor es", desde: "2026-08-07" },
  { archivo: "warmup-monitor.json", donde: "hechos.plan[].gate", promete: "lote 3 · el veredicto de la receta, ya evaluado", desde: "2026-08-07" }
];

export type Estado = "OK" | "FALTA" | "SIN ARCHIVO" | "SIN FILAS";

/**
 * ¿El campo está NO NULO en al menos un elemento? PURA, así el veredicto se puede fijar con un test.
 *
 * "Al menos uno" y no "todos" a propósito: un `null` legítimo existe (un dominio sin IP no tiene
 * PTR), pero si NINGUNO tiene el campo, no lo está escribiendo nadie — que es exactamente la falla
 * que este archivo caza. Con el array vacío devuelve `SIN FILAS`: no hay con qué contestar, y eso
 * no es lo mismo que "falta". "No medido" y "cero" no son lo mismo, otra vez.
 */
export function mirar(json: unknown, donde: string, noVale: readonly string[] = []): { estado: Estado; vistos: number; total: number } {
  const pasos = donde.split(".");
  // Se camina hasta los PADRES del último tramo y ahí se cuenta. Contar sobre los valores
  // encontrados daba "SIN FILAS" cuando el campo no existía en ninguno —verificado contra la copia
  // real con `dominios[].receptor`, 66 dominios y 0 con el campo— y eso se lee como "no había nada
  // que mirar" cuando lo que pasa es que nadie lo escribe. Son dos cegueras distintas.
  let padres: unknown[] = [json];
  for (let i = 0; i < pasos.length - 1; i++) {
    const paso = pasos[i] as string;
    const arreglo = paso.endsWith("[]");
    const clave = arreglo ? paso.slice(0, -2) : paso;
    const siguientes: unknown[] = [];
    for (const x of padres) {
      const v = x && typeof x === "object" ? (x as Record<string, unknown>)[clave] : undefined;
      if (arreglo) {
        if (Array.isArray(v)) siguientes.push(...v);
      } else if (v !== undefined && v !== null) {
        siguientes.push(v);
      }
    }
    padres = siguientes;
  }
  const ultimo = pasos[pasos.length - 1] as string;
  const arreglo = ultimo.endsWith("[]");
  const clave = arreglo ? ultimo.slice(0, -2) : ultimo;
  const valores = padres.map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>)[clave] : undefined));
  if (padres.length === 0) return { estado: "SIN FILAS", vistos: 0, total: 0 };
  const vistos = valores.filter((v) => v !== null && v !== undefined && !noVale.includes(String(v))).length;
  return { estado: vistos > 0 ? "OK" : "FALTA", vistos, total: valores.length };
}

export async function informe(dir: string, leer: (ruta: string) => Promise<string>): Promise<string[]> {
  const l: string[] = ["ARTEFACTOS EN RUNTIME — un campo con test verde no está terminado; está terminado cuando se ve acá", ""];
  const cache = new Map<string, unknown | null>();
  let faltan = 0;

  for (const f of FILAS) {
    if (!cache.has(f.archivo)) {
      cache.set(
        f.archivo,
        await leer(join(dir, f.archivo))
          .then((t) => JSON.parse(t) as unknown)
          // Un archivo que no está NO es un campo que falta: es una ceguera distinta y se dice
          // distinta. Colapsarlas manda a buscar el bug al lugar equivocado.
          .catch(() => null)
      );
    }
    const json = cache.get(f.archivo) ?? null;
    const r = json === null ? { estado: "SIN ARCHIVO" as const, vistos: 0, total: 0 } : mirar(json, f.donde, f.noVale ?? []);
    if (r.estado === "FALTA" || r.estado === "SIN ARCHIVO") faltan += 1;
    const detalle =
      r.estado === "OK"
        ? `${r.vistos}/${r.total} con dato`
        : r.estado === "FALTA"
          ? `0 de ${r.total}${(f.noVale ?? []).length > 0 ? ` (presente pero en ${(f.noVale ?? []).join("/")} no cuenta)` : ""}`
          : "";
    l.push(`  ${r.estado.padEnd(12)} ${`${f.archivo} → ${f.donde}`.padEnd(52)} ${detalle}`);
    l.push(`               ${f.promete} · desde ${f.desde}`);
  }

  l.push("");
  l.push(
    faltan === 0
      ? `las ${FILAS.length} filas están escritas en runtime.`
      : `${faltan} de ${FILAS.length} en FALTA. A las 24 h de un despliegue, eso significa que ese lote NO está terminado.`
  );
  return l;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error("uso: artefactos.ts <directorio-inventory-copiado>");
    process.exitCode = 2;
    return;
  }
  if (!rutaPermitida(dir)) {
    console.error(`ese directorio vive en producción (${ARBOL_DE_PRODUCCION}). Copialo con scp y corré esto sobre la copia.`);
    process.exitCode = 2;
    return;
  }
  for (const linea of await informe(dir, (r) => readFile(r, "utf8"))) console.log(linea);
}

if (process.argv[1] && process.argv[1].endsWith("artefactos.ts")) await main();
