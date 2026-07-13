// Configuración/guardas del runtime del warmup-engine.
//
// FEATURE FLAG DE SEGURIDAD: el engine NO debe arrancar ni enviar correo por sí solo en un deploy.
// Todo entrypoint/daemon/scheduler futuro DEBE chequear `warmupEngineEnabled(env)` y abstenerse si
// es false. Default = OFF: en ausencia de la var, el engine está inerte (no manda nada sin querer).
// El cableado de resolvers/transporte REALES (DNS/RBL/SMTP/IMAP en vivo) solo se conecta bajo este
// flag; los tests y la lógica pura no lo necesitan (usan mocks inyectados).

export interface WarmupEnv {
  WARMUP_ENGINE_ENABLE?: string;
}

/** true solo si WARMUP_ENGINE_ENABLE está explícitamente en "true"/"1". Default OFF (fail-safe). */
export function warmupEngineEnabled(env: WarmupEnv = process.env): boolean {
  const raw = env.WARMUP_ENGINE_ENABLE?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

/** Lanza si el engine no está habilitado — guard para todo camino que toque red/transporte en vivo. */
export function assertWarmupEngineEnabled(env: WarmupEnv = process.env): void {
  if (!warmupEngineEnabled(env)) {
    throw new Error(
      "warmup_engine_disabled: set WARMUP_ENGINE_ENABLE=true to run live paths (send/IMAP/RBL). " +
      "Default is OFF so the engine never sends on deploy."
    );
  }
}
