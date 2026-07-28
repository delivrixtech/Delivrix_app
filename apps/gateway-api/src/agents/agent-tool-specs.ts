// Specs de tools que el agente realmente puede ejecutar.
//
// `declaredToolSpecsForRole` (multi-agent-runtime.ts) genera `input_schema` VACIO
// (`properties:{}, required:[]`) con descripcion "Dispatch real: dia 4". Con un schema vacio el
// modelo no puede construir un tool_use valido: el abanico correria y no ejecutaria ni una tool.
//
// Aca las specs salen de `buildToolsForOpenClaw`, que es el MISMO catalogo que ya recibe el
// chat de OpenClaw en produccion — mismos schemas, mismas descripciones, mismos gates de
// `enabled(env)`. `BedrockToolSpec` es literalmente el tipo que esa funcion devuelve, asi que
// esto es un filtro, no una traduccion: no hay forma de que las specs del agente se desincronicen
// de las que ejecuta el processor.

import type { AgentRole } from "../../../../packages/domain/src/index.ts";
import { buildToolsForOpenClaw, type BedrockToolSpec } from "../openclaw-tools-builder.ts";
import { diagnosticToolsForRole } from "./warmup-tool-executor.ts";

export interface ResolvedToolSpecs {
  specs: BedrockToolSpec[];
  /**
   * Tools que el rol declara pero que NO existen en el catalogo habilitado.
   *
   * Se OMITEN, no se declaran con schema vacio. Declararlas le enseña al modelo a pedir cosas
   * que no puede ejecutar, y el error que recibe (`invalid_params` o `tool_disabled`) no le
   * explica que la tool nunca existio.
   */
  missing: string[];
}

/**
 * Resuelve las specs reales de un rol contra el catalogo habilitado por el env.
 *
 * Un rol sin ninguna tool resoluble devuelve `specs: []`. Eso es correcto y deliberado: es
 * exactamente el estado de dns, smtp y qa-security hoy, y un agente sin tools al menos falla
 * de forma legible en vez de alucinar llamadas.
 */
export function resolveToolSpecs(
  toolNames: readonly string[],
  env: Record<string, string | undefined>
): ResolvedToolSpecs {
  const catalog = new Map(buildToolsForOpenClaw(env).map((tool) => [tool.name, tool]));
  const specs: BedrockToolSpec[] = [];
  const missing: string[] = [];

  for (const name of toolNames) {
    const spec = catalog.get(name);
    if (spec) specs.push(spec);
    else missing.push(name);
  }

  return { specs, missing };
}

/**
 * Specs del abanico de diagnostico por rol.
 *
 * Usa el alcance de `warmup-tool-executor` como fuente unica: si las specs y el executor
 * declararan listas distintas, el modelo pediria tools que el executor rechaza — un
 * `tool_not_allowed_for_role` que el agente no puede interpretar.
 */
export function diagnosticToolSpecsForRole(
  role: AgentRole,
  env: Record<string, string | undefined>
): ResolvedToolSpecs {
  return resolveToolSpecs(diagnosticToolsForRole(role), env);
}
