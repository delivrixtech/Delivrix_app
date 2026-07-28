// Fan-out determinista sobre items independientes.
//
// El orquestador NO sirve para esto: `handleOperatorInstruction` toma UN string y los
// sub-agentes solo nacen si el MODELO emite `delegate_to_*`. Ademas el despacho de tools es
// secuencial y `maxIterations` corta la sesion al octavo turno. Eso es delegacion
// conversacional; el abanico es otra cosa.
//
// Aca el reparto lo decide el codigo, no el modelo: una sesion por item, N en paralelo,
// resultado POR ITEM. Es correcto solo mientras los items sean independientes — si compiten
// por un recurso compartido (cuota de proveedor, zona DNS, un archivo de estado), esto los
// hace chocar mas rapido, no los coordina.

import type { AgentRole } from "../../../../packages/domain/src/index.ts";
import type { AgentInvokeInput } from "../../../../packages/domain/src/index.ts";
import type { AgentSessionManager } from "./agent-session-manager.ts";
import type { AgentSessionResult } from "./bedrock-agent-session.ts";

/**
 * Tope por defecto de agentes en vuelo.
 *
 * Deliberadamente bajo. Las tools de lectura del diagnostico abren sesiones SSH contra los
 * nodos de la flota y NO hay pool ni cap en ninguna capa de abajo: N agentes en paralelo son
 * N procesos ssh simultaneos. Subir esto es una decision operativa que se mide, no un default.
 */
export const DEFAULT_FAN_OUT_CONCURRENCY = 4;

/** Tope duro. Por encima de esto el cuello de botella deja de ser el modelo y pasa a ser la flota. */
export const MAX_FAN_OUT_CONCURRENCY = 12;

export interface FanOutItemResult<T> {
  item: T;
  /** Presente aunque el agente falle: la sesion se crea antes de correr. */
  sessionId?: string;
  result?: AgentSessionResult;
  /** Mensaje de error si la invocacion tiro. Excluyente con `result`. */
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface FanOutSummary<T> {
  /** Uno por item, en el ORDEN DE ENTRADA (no en el de finalizacion). */
  results: FanOutItemResult<T>[];
  ok: number;
  failed: number;
  /** Concurrencia maxima efectivamente observada. Sirve para verificar el semaforo. */
  peakInFlight: number;
}

export interface RunFanOutInput<T> {
  sessionManager: AgentSessionManager;
  role: AgentRole;
  items: readonly T[];
  /** Construye las instrucciones de UN item. El taskId debe ser unico por item. */
  buildInput: (item: T, index: number) => AgentInvokeInput;
  /** Quien pide el abanico. Ver nota de autoridad abajo. */
  invokedByRole: Parameters<AgentSessionManager["invokeAgent"]>[2]["invokedByRole"];
  concurrency?: number;
  now?: () => Date;
  /** Se llama al cerrar cada item. Para progreso en vivo sin esperar al final. */
  onItemSettled?: (result: FanOutItemResult<T>) => void;
}

/**
 * Corre un agente por item con concurrencia acotada.
 *
 * NUNCA agrega el estado: devuelve el resultado de cada item por separado. Es a proposito —
 * el camino de delegacion del orquestador devuelve `ok` aunque la sesion hija haya fallado, y
 * un abanico que reporta "completado" con 12 dominios caidos adentro es peor que uno que falla.
 *
 * Un item que tira NO cancela a los demas.
 */
export async function runFanOut<T>(input: RunFanOutInput<T>): Promise<FanOutSummary<T>> {
  const now = input.now ?? (() => new Date());
  const concurrency = normalizeConcurrency(input.concurrency);
  const results = new Array<FanOutItemResult<T>>(input.items.length);

  let cursor = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= input.items.length) return;
      const item = input.items[index] as T;

      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      const startedAt = now().toISOString();

      let settled: FanOutItemResult<T>;
      try {
        const invoked = await input.sessionManager.invokeAgent(
          input.role,
          input.buildInput(item, index),
          { invokedByRole: input.invokedByRole }
        );
        settled = {
          item,
          sessionId: invoked.sessionId,
          result: invoked.result,
          startedAt,
          finishedAt: now().toISOString()
        };
      } catch (error) {
        settled = {
          item,
          error: error instanceof Error ? error.message : String(error),
          startedAt,
          finishedAt: now().toISOString()
        };
      } finally {
        inFlight -= 1;
      }

      results[index] = settled;
      input.onItemSettled?.(settled);
    }
  }

  // `allSettled` y no `all`: un worker no deberia poder tumbar al resto. Los errores por item
  // ya se capturan arriba, asi que esto cubre solo fallas del propio worker.
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, input.items.length) }, () => worker())
  );

  const settledResults = results.filter(Boolean);
  return {
    results: settledResults,
    ok: settledResults.filter((entry) => entry.result !== undefined).length,
    failed: settledResults.filter((entry) => entry.error !== undefined).length,
    peakInFlight
  };
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FAN_OUT_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`fan_out_concurrency_invalid: ${String(value)} (entero >= 1).`);
  }
  return Math.min(value, MAX_FAN_OUT_CONCURRENCY);
}
