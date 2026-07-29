// Ensayo del abanico: recorre las tools reales sin llamar a ningun modelo.
//
// Por que existe. El camino executor -> processor -> tools NUNCA corrio en produccion: el
// abanico siempre uso MockAgentModelClient, que devuelve end_turn en la primera llamada y cierra
// la sesion en la iteracion 0 con cero tools ejecutadas. Enchufar el cliente real seria estrenar
// ese camino en caliente, sobre ~59 dominios, con SSH reales, cuota de MXToolbox y DNS por
// dominio — y pagando el modelo mientras se descubre cada error de cableado.
//
// Esto separa las dos preguntas. "¿El cableado de tools funciona?" se contesta gratis y
// determinista. "¿El modelo diagnostica bien?" se contesta despues, ya sabiendo que lo de abajo
// anda. No reemplaza al modelo: no razona, no cruza evidencia y no emite veredicto. Recorre.

import type {
  AgentModelClient,
  AgentModelInvokeInput,
  AgentModelInvokeResult,
  AgentModelPricing,
  AgentModelToolUse
} from "./bedrock-agent-session.ts";

export const REHEARSAL_MODEL_ID = "rehearsal/sin-modelo";

/**
 * Datos del nodo, leidos de las instrucciones.
 *
 * buildDiagnosticInstructions los emite como lineas `  clave: valor` justamente para que se
 * puedan volver a leer. Las dos puntas estan en el repo, asi que el formato no puede cambiar
 * de un lado sin que el test del otro se ponga rojo.
 */
export interface DiagnosticFacts {
  domain?: string;
  serverSlug?: string;
  serverIp?: string;
  messageId?: string;
}

export function parseDiagnosticFacts(instructions: string): DiagnosticFacts {
  const facts: DiagnosticFacts = {};
  for (const line of instructions.split("\n")) {
    const match = /^\s{2}([a-zA-Z ]+?):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, rawKey, value] = match;
    if (value === "NO HAY" || value === "NO") continue;
    switch (rawKey!.trim()) {
      case "domain": facts.domain = value; break;
      case "serverSlug": facts.serverSlug = value; break;
      case "serverIp": facts.serverIp = value; break;
      case "messageId de un envio reciente": facts.messageId = value; break;
      default: break;
    }
  }
  return facts;
}

/**
 * Arma los parametros de una tool con los datos del nodo.
 *
 * Devuelve null si falta un campo requerido. Eso NO es un error: es exactamente lo que hace un
 * agente honesto cuando no hay messageId — se saltea read_delivery_reason en vez de inventarse
 * uno. Sondear con un parametro inventado devuelve un resultado correcto de la maquina
 * equivocada, que es peor que no tener dato.
 */
export function argsForTool(
  schema: { properties?: Record<string, unknown>; required?: readonly string[] } | undefined,
  facts: DiagnosticFacts
): Record<string, unknown> | null {
  const properties = Object.keys(schema?.properties ?? {});
  const required = schema?.required ?? [];
  const args: Record<string, unknown> = {};

  for (const property of properties) {
    const value = valueForProperty(property, facts);
    if (value !== undefined) args[property] = value;
  }
  for (const property of required) {
    if (args[property] === undefined) return null;
  }
  return args;
}

function valueForProperty(property: string, facts: DiagnosticFacts): string | undefined {
  switch (property) {
    case "domain": return facts.domain;
    case "serverSlug": return facts.serverSlug;
    case "serverIp": return facts.serverIp;
    case "messageId": return facts.messageId;
    // MXToolbox recibe el objetivo a chequear, que para un dominio de la flota es el dominio.
    case "target": return facts.domain;
    default: return undefined;
  }
}

/**
 * Cliente de ensayo: una tool por turno, en el orden en que vienen declaradas.
 *
 * Una por turno y no todas juntas a proposito: asi el loop de la sesion da varias vueltas y se
 * ejercita el ida y vuelta completo — tool_use, despacho, tool_result, siguiente turno — que es
 * donde vive el cableado que nunca corrio.
 */
export class RehearsalAgentModelClient implements AgentModelClient {
  readonly modelId = REHEARSAL_MODEL_ID;
  /** Sin modelo no hay gasto. El 0 aca es un hecho medido, no un desconocido. */
  readonly pricing: AgentModelPricing = { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };

  private cursor = 0;
  private readonly executed: string[] = [];
  private readonly skipped: string[] = [];

  async invoke(input: AgentModelInvokeInput): Promise<AgentModelInvokeResult> {
    const instructions = input.messages.find((turn) => turn.role === "user")?.content ?? "";
    const facts = parseDiagnosticFacts(instructions);

    while (this.cursor < input.tools.length) {
      const tool = input.tools[this.cursor];
      this.cursor += 1;
      if (!tool) continue;

      const args = argsForTool(tool.input_schema as { properties?: Record<string, unknown>; required?: readonly string[] }, facts);
      if (args === null) {
        this.skipped.push(tool.name);
        continue;
      }

      this.executed.push(tool.name);
      const toolUse: AgentModelToolUse = {
        toolUseId: `rehearsal-${this.cursor}-${tool.name}`,
        toolName: tool.name,
        toolInput: args
      };
      return {
        text: "",
        toolUses: [toolUse],
        // Cero tokens porque cero modelo. Es el dato honesto: el costo estimado de la sesion
        // tiene que dar 0, no un numero de mentira con precio de Sonnet.
        inputTokens: 0,
        outputTokens: 0,
        stopReason: "tool_use"
      };
    }

    return {
      text: this.summary(input.tools.length),
      toolUses: [],
      inputTokens: 0,
      outputTokens: 0,
      stopReason: "end_turn"
    };
  }

  private summary(declared: number): string {
    return [
      "ENSAYO — sin modelo. Esto no es un diagnostico: nadie razono sobre la evidencia.",
      `Tools declaradas: ${declared}.`,
      `Ejecutadas: ${this.executed.length > 0 ? this.executed.join(", ") : "ninguna"}.`,
      `Salteadas por falta de datos del nodo: ${this.skipped.length > 0 ? this.skipped.join(", ") : "ninguna"}.`
    ].join("\n");
  }
}
