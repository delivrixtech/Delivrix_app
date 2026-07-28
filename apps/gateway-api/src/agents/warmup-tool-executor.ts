// Ejecutor de tools para los agentes del abanico.
//
// NO reimplementa nada: envuelve `processToolUse`, el mismo camino que ya usa el chat de
// OpenClaw. Eso trae gratis, y verificado en produccion:
//   - kill switch leido FAIL-CLOSED antes de cada tool (si no se puede leer, rechaza)
//   - validacion de params contra el Zod paramSchema de cada tool
//   - chequeo de enabled(env): una tool apagada por flag no llega a la red
//   - el carril de ApprovalGate para las de escritura
//
// Reescribir cualquiera de esas cuatro seria abrir un segundo camino con otras reglas. La
// leccion de esta semana fue exactamente esa: la verificacion que corre por fuera del camino
// de produccion diverge y miente.

import type { AgentRole } from "../../../../packages/domain/src/index.ts";
import type { AgentToolExecutor } from "./bedrock-agent-session.ts";

/** Firma de lo que devuelve `createHttpToolUseProcessor`. */
export type HttpToolUseProcessor = (input: {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  chatSession: { id: string; msgId?: string };
  timeoutMs?: number;
}) => Promise<
  | { ok: true; status: "executed"; result: unknown; durationMs?: number }
  | { ok: false; error: string; [key: string]: unknown }
>;

export interface CreateAgentToolExecutorInput {
  processor: HttpToolUseProcessor;
  /**
   * Tools que este rol puede ejecutar. Es una segunda barrera, no la primera: la sesion ya
   * corta lo que no esta en su spec (`tool_out_of_scope`). Se repite aca a proposito, porque
   * el spec sale de la config y esto sale del codigo — si divergen, gana el mas restrictivo.
   */
  allowedTools: readonly string[];
  timeoutMs?: number;
}

/** Timeout por tool. Las de lectura hacen SSH contra un nodo: 90s cubre un nodo lento sin colgar el abanico. */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

/**
 * Construye el `AgentToolExecutor` de un rol.
 *
 * IMPORTANTE: el manager comparte UNA instancia entre los N agentes del abanico
 * (`agent-session-manager.ts:133`), asi que esto tiene que ser stateless. El unico
 * discriminador por agente es `session.sessionId`, que viaja como `chatSession.id` para que
 * el audit trail pueda separar quien hizo que.
 */
export function createAgentToolExecutor(input: CreateAgentToolExecutorInput): AgentToolExecutor {
  const allowed = new Set(input.allowedTools);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  return async ({ session, toolUseId, toolName, toolInput }) => {
    if (!allowed.has(toolName)) {
      return {
        success: false,
        content: "",
        error: `tool_not_allowed_for_role: ${toolName} no esta en el alcance de ${session.definition.role}.`
      };
    }

    let outcome: Awaited<ReturnType<HttpToolUseProcessor>>;
    try {
      outcome = await input.processor({
        toolUseId,
        toolName,
        toolInput,
        // El sessionId del agente, no el del chat: cada agente del abanico es su propio actor.
        chatSession: { id: session.sessionId },
        timeoutMs
      });
    } catch (error) {
      // Una excepcion del processor NO puede tumbar la sesion del agente: se devuelve como
      // tool_result de error para que el modelo pueda reaccionar o cerrar con evidencia parcial.
      return {
        success: false,
        content: "",
        error: `tool_execution_threw: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (!outcome.ok) {
      return { success: false, content: "", error: outcome.error };
    }

    return { success: true, content: stringifyToolResult(outcome.result) };
  };
}

/**
 * El modelo recibe texto. Un objeto se serializa; un string se pasa tal cual (serializarlo lo
 * dejaria con comillas escapadas adentro y el modelo lo lee peor).
 */
function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Las 5 tools del Warmup Senior en el abanico de diagnostico.
 *
 * Todas de LECTURA, todas habilitadas en el env canonico, ninguna pasa por ApprovalGate.
 * Deliberadamente NO estan `send_real_email` (apagada por SMTP_SEND_REAL_EMAIL_ENABLE=false)
 * ni `seed_warmup_pool` (no-op permanente: el tipo solo admite status "started" y la flota
 * entera ya lo tiene). Declarar tools que devuelven tool_disabled o idempotent_already_started
 * le enseña al modelo a llamar cosas que no hacen nada.
 */
export const WARMUP_DIAGNOSTIC_TOOLS = [
  "read_smtp_reachability",
  "read_delivery_reason",
  "read_dkim_status",
  "read_mxtoolbox_health",
  "inspect_smtp_inventory"
] as const;

export function warmupDiagnosticToolExecutor(
  processor: HttpToolUseProcessor,
  timeoutMs?: number
): AgentToolExecutor {
  return createAgentToolExecutor({
    processor,
    allowedTools: WARMUP_DIAGNOSTIC_TOOLS,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
}

/** Alcance por rol. Hoy solo warmup: los otros 4 siguen con nombres inventados y sin handler. */
export function diagnosticToolsForRole(role: AgentRole): readonly string[] {
  return role === "warmup" ? WARMUP_DIAGNOSTIC_TOOLS : [];
}
