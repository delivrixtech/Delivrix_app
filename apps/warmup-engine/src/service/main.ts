// Entrypoint del daemon del warmup-engine. INERTE por default: si WARMUP_ENGINE_ENABLE no está
// activo, loguea y sale 0 sin conectar nada. Con el flag activo, el deployment debe proveer la
// configuración real (Postgres, SecretResolver, providers de schedule/unsub, seeds) — este shell
// documenta el cableado y lo compone; no fabrica secretos ni credenciales.
//
// El loop se ejecuta SOLO si este archivo se corre como entrypoint directo (no al importarse), para
// que los tests puedan importar el módulo sin arrancar el daemon.

import { warmupEngineEnabled } from "../runtime/config.ts";

/**
 * Arranca el daemon. Requiere `deps` reales ya compuestas (pg stores + live compose). Se deja como
 * función explícita para que el composition-root de deployment la invoque tras cablear todo; NO se
 * autoconstruye la infra acá (Postgres/secretos son config de deployment).
 */
export async function startWarmupDaemon(
  runTick: () => Promise<unknown>,
  opts: { intervalMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<void> {
  if (!warmupEngineEnabled(opts.env ?? process.env)) {
    // eslint-disable-next-line no-console
    console.log("[warmup-engine] WARMUP_ENGINE_ENABLE no está activo — daemon inerte, no se conecta nada.");
    return;
  }
  // eslint-disable-next-line no-console
  console.log("[warmup-engine] daemon iniciado.");
  while (!opts.signal?.aborted) {
    try {
      await runTick();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[warmup-engine] tick falló:", error instanceof Error ? error.message : error);
    }
    await delay(opts.intervalMs, opts.signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Ejecutado como entrypoint directo: solo reporta el estado del flag. El cableado real de deps
// (pg + compose live + providers) es responsabilidad del deployment, que llamará startWarmupDaemon.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (!warmupEngineEnabled()) {
    // eslint-disable-next-line no-console
    console.log("[warmup-engine] inerte: WARMUP_ENGINE_ENABLE no está activo. Nada que hacer.");
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.log("[warmup-engine] flag activo, pero este entrypoint requiere deps compuestas por el deployment (Postgres + compose live). Usa startWarmupDaemon(runTick, ...).");
    process.exit(0);
  }
}
