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
import type { AgentSessionSnapshot } from "../../../../packages/domain/src/index.ts";
import { AgentInvocationFailed, type AgentSessionManager } from "./agent-session-manager.ts";
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
  /** Mensaje de error si la invocacion tiro. Excluyente con `result` y con `cancelled`. */
  error?: string;
  /**
   * El item nunca se despacho porque el abanico se corto (kill switch).
   *
   * Es un campo aparte y NO un error a proposito: si el corte se reportara como falla, el
   * operador no podria distinguir "lo pare yo" de "59 dominios estan rotos" — que es
   * exactamente la decision que va a tener que tomar leyendo el reporte.
   */
  cancelled?: true;
  /**
   * Lo que la sesion gasto antes de tirar.
   *
   * Existe solo en el camino de error: cuando hay `result`, los tokens viven ahi. Sin esto, una
   * sesion que muere en la ultima iteracion borraba de los totales todo lo que ya se pago.
   */
  spent?: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  startedAt: string;
  finishedAt: string;
}

export interface FanOutSummary<T> {
  /** Uno por item, en el ORDEN DE ENTRADA (no en el de finalizacion). */
  results: FanOutItemResult<T>[];
  ok: number;
  failed: number;
  /** Items que no se despacharon porque el abanico se corto. */
  cancelled: number;
  /** true si el abanico se corto antes de despachar todos los items. */
  aborted: boolean;
  /**
   * Por que se abrio el cortacircuitos, si se abrio.
   *
   * Distinto de `aborted` por kill switch: aca el abanico se corto SOLO, porque la misma falla
   * se repitio. El operador tiene que poder leer la diferencia.
   */
  circuitReason?: string;
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
  /**
   * Corta el abanico antes de despachar el proximo item. Default: el `isPaused` del manager.
   *
   * Sin esto el kill switch no aborta: el bucle sigue, cada invocacion tira
   * `multi_agent_runtime_paused` y los items restantes se marcan como fallidos — indistinguibles
   * de una falla real de diagnostico.
   */
  shouldAbort?: () => boolean;
  /**
   * Corta las llamadas al modelo que YA estan en vuelo.
   *
   * `shouldAbort` solo evita despachar el proximo item. Sin esto, armar el kill switch dejaba
   * corriendo hasta `concurrency` llamadas pagas hasta que terminaran solas.
   */
  abortSignal?: AbortSignal;
  now?: () => Date;
  /** Se llama al cerrar cada item. Para progreso en vivo sin esperar al final. */
  onItemSettled?: (result: FanOutItemResult<T>) => void;
  /**
   * Corta el abanico despues de N fallas consecutivas con el MISMO error.
   *
   * Existe por un caso real: el modelo local se descargo a mitad de corrida y los 49 dominios
   * restantes devolvieron el mismo HTTP 400 uno por uno. Moler 49 items para repetir 49 veces
   * "no models loaded" no informa nada que no dijera el primero, y con un backend pago cada
   * repeticion cuesta. Los items que no se despachan quedan `cancelled`, no `failed`: no son
   * dominios rotos, son dominios que nadie miro.
   *
   * 0 lo desactiva. Default: 5.
   */
  abortAfterConsecutiveFailures?: number;
}

/** Alcanza para distinguir un nodo puntualmente roto de una falla de infraestructura. */
export const DEFAULT_ABORT_AFTER_CONSECUTIVE_FAILURES = 5;

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

  const shouldAbort =
    input.shouldAbort ?? (() => Boolean((input.sessionManager as { isPaused?: boolean }).isPaused));

  const abortAfter = input.abortAfterConsecutiveFailures ?? DEFAULT_ABORT_AFTER_CONSECUTIVE_FAILURES;
  let cursor = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let aborted = false;
  // Racha de fallas identicas: delata una falla de infraestructura, no de nodos.
  let consecutiveFailures = 0;
  let lastFailureKey: string | undefined;
  let circuitReason: string | undefined;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= input.items.length) return;
      const item = input.items[index] as T;

      // Se chequea ANTES de despachar, no despues: el objetivo del kill switch es que no
      // arranque una sesion mas, no enterarse de que arrancaron.
      if (shouldAbort() || circuitReason !== undefined) {
        aborted = true;
        const at = now().toISOString();
        const settled: FanOutItemResult<T> = { item, cancelled: true, startedAt: at, finishedAt: at };
        results[index] = settled;
        input.onItemSettled?.(settled);
        continue;
      }

      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      const startedAt = now().toISOString();

      let settled: FanOutItemResult<T>;
      try {
        const invoked = await input.sessionManager.invokeAgent(
          input.role,
          input.buildInput(item, index),
          {
            invokedByRole: input.invokedByRole,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
          }
        );
        settled = {
          item,
          sessionId: invoked.sessionId,
          result: invoked.result,
          startedAt,
          finishedAt: now().toISOString()
        };
      } catch (error) {
        // Aunque la invocacion tire, lo que la sesion ya gasto se conserva: Bedrock lo facturo
        // igual y tiene que aparecer en el total de la corrida.
        const failed = error instanceof AgentInvocationFailed ? error : undefined;
        settled = {
          item,
          ...(failed ? { sessionId: failed.sessionId, spent: spentFrom(failed.snapshot) } : {}),
          error: error instanceof Error ? error.message : String(error),
          startedAt,
          finishedAt: now().toISOString()
        };
      } finally {
        inFlight -= 1;
      }

      // Contabilidad del corte por racha. Se agrupa por el PREFIJO del error para que dos
      // fallas de la misma causa cuenten juntas aunque el mensaje traiga un id distinto.
      if (settled.error !== undefined) {
        const key = settled.error.slice(0, 60);
        consecutiveFailures = key === lastFailureKey ? consecutiveFailures + 1 : 1;
        lastFailureKey = key;
        if (abortAfter > 0 && consecutiveFailures >= abortAfter) {
          aborted = true;
          circuitReason =
            `fan_out_circuit_open: ${consecutiveFailures} fallas consecutivas con el mismo error ` +
            `("${key}"). Parece una falla de infraestructura y no de los items; el resto queda sin despachar.`;
        }
      } else {
        consecutiveFailures = 0;
        lastFailureKey = undefined;
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

  // `filter(Boolean)` perderia silenciosamente cualquier hueco. Si lo hay es un bug del
  // worker, y el operador tiene que verlo: se completa con un resultado explicito.
  const settledResults = results.map((entry, index) =>
    entry ?? {
      item: input.items[index] as T,
      error: "fan_out_item_unsettled: el worker no dejo resultado para este item.",
      startedAt: now().toISOString(),
      finishedAt: now().toISOString()
    }
  );

  return {
    results: settledResults,
    // `ok` es "termino con un veredicto", no "devolvio algo".
    //
    // invokeAgent NO tira cuando la sesion se pausa por el cap de 50.000 tokens ni cuando muere
    // por max_iterations: devuelve normal, con status paused/failed. Contando por
    // `result !== undefined` esas sesiones —las MAS CARAS de la corrida, porque pagaron el cap
    // entero— entraban como exito, y el operador leia "59 ok, 0 failed" con N nodos sin
    // diagnosticar.
    ok: settledResults.filter((entry) => entry.result?.status === "completed").length,
    failed: settledResults.filter(
      (entry) => entry.error !== undefined || (entry.result !== undefined && entry.result.status !== "completed")
    ).length,
    cancelled: settledResults.filter((entry) => entry.cancelled === true).length,
    aborted,
    peakInFlight,
    ...(circuitReason ? { circuitReason } : {})
  };
}

function spentFrom(snapshot: AgentSessionSnapshot): {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
} {
  return {
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    estimatedCostUsd: snapshot.estimatedCostUsd
  };
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FAN_OUT_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`fan_out_concurrency_invalid: ${String(value)} (entero >= 1).`);
  }
  return Math.min(value, MAX_FAN_OUT_CONCURRENCY);
}
