#!/usr/bin/env node
// EL MAESTRO: junta material verificado para que el modelo propio aprenda de Delivrix.
//
//   node --env-file=config/gateway.env --experimental-strip-types scripts/ops/maestro-destilacion.ts
//   ... --loop            corre cada N minutos junto con el agente
//   ... --dataset         exporta lo juntado a JSONL listo para mlx-tune
//
// LA IDEA. Kimi K3 (2,8B de parámetros, 1M de contexto) mira los MISMOS hechos que el modelo local
// y responde. Su respuesta pasa por `verificarLectura`, la misma verificación que hoy le bloquea
// las manos al agente cuando dice algo falso. SOLO lo que sale con cero reparos entra al dataset.
//
// O sea: no se le enseña al modelo propio "lo que dijo el modelo grande", sino "lo que dijo el
// modelo grande Y RESULTÓ CIERTO contra los datos reales". El maestro también se equivoca; el
// filtro no lo deja pasar. Sin ese filtro, destilar es copiar los errores del grande con más
// confianza — que es peor que no destilar.
//
// Por qué importa: cada ejemplo cuesta centavos de API HOY y vale para siempre. El modelo propio
// no paga por token, así que todo lo que aprenda es costo que no se repite nunca más.

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { construirPrompt, pedirLectura, SISTEMA, verificarLectura, type HechosWarmup } from "../../apps/gateway-api/src/agents/warmup-monitor.ts";

const CORPUS = "warmup-destilacion.json";
const DATASET_DIR = resolve(process.cwd(), "runtime/destilacion");

/** Un ejemplo de entrenamiento: los hechos que vio, y una respuesta que PASÓ la verificación. */
export interface Ejemplo {
  id: string;
  cuando: string;
  /** Qué maestro lo produjo. Sirve para medir después cuál enseña mejor. */
  maestro: string;
  /** El prompt exacto que se le dio (los hechos ya renderizados). */
  entrada: string;
  /** La respuesta buena. Verificada: cero reparos contra los hechos. */
  salida: string;
  /** Cuántos reparos tuvo (siempre 0 en los guardados; se deja por si se relaja el criterio). */
  reparos: number;
}

export interface Corpus {
  version: 1;
  ejemplos: Ejemplo[];
  /** Cuántos se descartaron por no pasar la verificación. Es el número que dice si el filtro sirve. */
  descartados: number;
}

/**
 * Convierte el corpus al formato que mlx-tune espera para SFT: una línea JSON por ejemplo, con
 * `messages` estilo chat. Es puro: se puede probar sin llamar a ningún modelo.
 */
export function aJsonl(corpus: Corpus, sistema: string): string {
  return corpus.ejemplos
    .map((e) =>
      JSON.stringify({
        messages: [
          { role: "system", content: sistema },
          { role: "user", content: e.entrada },
          { role: "assistant", content: e.salida }
        ]
      })
    )
    .join("\n");
}

/**
 * Parte el corpus en entrenamiento y validación. La validación NO se entrena: es contra lo que se
 * mide si el modelo mejoró de verdad o solo memorizó. Se corta por FECHA y no al azar: los
 * ejemplos de un mismo día se parecen mucho entre sí, y mezclarlos infla el resultado.
 */
export function partir(corpus: Corpus, fraccionValidacion = 0.15): { train: Corpus; valid: Corpus } {
  const orden = [...corpus.ejemplos].sort((a, b) => a.cuando.localeCompare(b.cuando));
  const corte = Math.max(1, Math.floor(orden.length * (1 - fraccionValidacion)));
  return {
    train: { version: 1, ejemplos: orden.slice(0, corte), descartados: corpus.descartados },
    valid: { version: 1, ejemplos: orden.slice(corte), descartados: 0 }
  };
}

async function reunirHechosDelUltimoRegistro(workspace: OpenClawWorkspace): Promise<HechosWarmup | null> {
  // Se reusan los hechos que el agente YA juntó en su última corrida, en vez de recolectarlos de
  // nuevo: así el maestro y el alumno miran EXACTAMENTE lo mismo, que es la única forma de que la
  // comparación signifique algo.
  const lectura = await workspace
    .readInventoryJson<{ hechos?: HechosWarmup }>("warmup-monitor.json")
    .catch(() => null);
  return lectura?.hechos ?? null;
}

async function main(): Promise<void> {
  const exportar = process.argv.includes("--dataset");
  const workspace = new OpenClawWorkspace();

  if (exportar) {
    const corpus = (await workspace.readInventoryJson<Corpus>(CORPUS).catch(() => null)) ?? {
      version: 1 as const,
      ejemplos: [],
      descartados: 0
    };
    if (corpus.ejemplos.length === 0) {
      console.error("el corpus está vacío: todavía no hay material verificado que exportar.");
      process.exitCode = 1;
      return;
    }
    const sistema = await leerSistema();
    const { train, valid } = partir(corpus);
    await mkdir(DATASET_DIR, { recursive: true });
    await writeFile(resolve(DATASET_DIR, "train.jsonl"), `${aJsonl(train, sistema)}\n`, "utf8");
    await writeFile(resolve(DATASET_DIR, "valid.jsonl"), `${aJsonl(valid, sistema)}\n`, "utf8");
    console.log(`exportado a ${DATASET_DIR}`);
    console.log(`  train: ${train.ejemplos.length} ejemplos`);
    console.log(`  valid: ${valid.ejemplos.length} ejemplos (NO se entrenan: son para medir)`);
    console.log(`  descartados por no pasar la verificación: ${corpus.descartados}`);
    return;
  }

  const apiKey = process.env.KIMI_API_KEY?.trim();
  const baseUrl = process.env.KIMI_BASE_URL?.trim() || "https://api.moonshot.ai/v1";
  const modelo = process.env.KIMI_MODEL?.trim() || "kimi-k3";
  if (!apiKey) {
    console.error("falta KIMI_API_KEY en el entorno. Sin maestro no hay material que juntar.");
    process.exitCode = 1;
    return;
  }

  const hechos = await reunirHechosDelUltimoRegistro(workspace);
  if (!hechos) {
    console.error("no hay hechos de la última corrida del agente: corré primero warmup-monitor.ts");
    process.exitCode = 1;
    return;
  }

  // El maestro razona MUCHO (K3 es un modelo de razonamiento y eso sale del mismo presupuesto).
  // Medido con 10 tokens: 7 se fueron en razonar y la respuesta salió vacía.
  const lectura = await pedirLectura({ hechos, baseUrl, modelo, apiKey, maxTokens: 8000, timeoutMs: 300_000 });

  if (!lectura.lectura) {
    console.log(`[maestro] sin respuesta: ${lectura.motivo}`);
    return;
  }

  // EL FILTRO. La misma verificación que le bloquea las manos al agente. Un maestro que se
  // equivoca no enseña: se descarta.
  const v = verificarLectura(lectura.lectura, hechos);
  const paso = v.reparos.length === 0;

  await workspace.updateInventoryJson<Corpus>(CORPUS, (actual) => {
    const c = actual ?? { version: 1 as const, ejemplos: [], descartados: 0 };
    if (!paso) return { ...c, descartados: c.descartados + 1 };
    const entrada = construirPrompt(hechos, [], []);
    return {
      ...c,
      ejemplos: [
        ...c.ejemplos,
        {
          id: `${modelo}-${lectura.generadoEn}`,
          cuando: lectura.generadoEn,
          maestro: lectura.modelo,
          entrada,
          salida: lectura.lectura as string,
          reparos: 0
        }
      ]
    };
  });

  const c = await workspace.readInventoryJson<Corpus>(CORPUS).catch(() => null);
  console.log(
    paso
      ? `[maestro] ✓ ejemplo guardado (${lectura.modelo}, ${lectura.tokens?.completion ?? 0} tokens) · corpus: ${c?.ejemplos.length ?? 0} · descartados: ${c?.descartados ?? 0}`
      : `[maestro] ✗ DESCARTADO, el maestro se equivocó: ${v.reparos.join(" · ")} · corpus: ${c?.ejemplos.length ?? 0} · descartados: ${c?.descartados ?? 0}`
  );
}

/** El system prompt real del agente: el dataset se entrena con el MISMO, importado, no copiado. */
async function leerSistema(): Promise<string> {
  return SISTEMA;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main().catch((e) => {
    console.error(`[maestro] error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
