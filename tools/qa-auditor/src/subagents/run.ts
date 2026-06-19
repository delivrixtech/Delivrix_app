// Runner de subagentes. Cada subagente es una invocacion aislada al modelo con
// su system prompt especializado y salida forzada via tool_use. Se ejecutan en
// paralelo desde el orquestador. Un fallo de un subagente NO tumba la auditoria:
// se reporta en modo degradado y los otros dos siguen.

import type { AnthropicClient, AnthropicUsage } from "../anthropic/client.ts";
import type { AuditContext } from "../context/collect.ts";
import { systemPromptFor, buildUserContent } from "./prompts.ts";
import {
  DIMENSIONS,
  REPORT_TOOL_NAME,
  REPORT_TOOL_SCHEMA,
  normalizeSubagentResult,
  type Dimension,
  type SubagentResult
} from "./schema.ts";

export type SubagentRun = {
  dimension: Dimension;
  ok: boolean;
  result: SubagentResult;
  error?: string;
  usage?: AnthropicUsage;
};

export async function runSubagent(
  client: AnthropicClient,
  dimension: Dimension,
  context: AuditContext,
  maxTokens: number,
  qaContext?: string
): Promise<SubagentRun> {
  const response = await client.invokeStructured({
    system: systemPromptFor(dimension),
    userContent: buildUserContent(context, qaContext),
    toolName: REPORT_TOOL_NAME,
    toolDescription: "Reporta los hallazgos de auditoria de esta dimension.",
    toolSchema: REPORT_TOOL_SCHEMA as unknown as Record<string, unknown>,
    maxTokens
  });

  if (!response.ok) {
    return {
      dimension,
      ok: false,
      result: { summary: "", findings: [] },
      error: response.error
    };
  }

  return {
    dimension,
    ok: true,
    result: normalizeSubagentResult(response.data, dimension),
    usage: response.usage
  };
}

export function runAllSubagents(
  client: AnthropicClient,
  context: AuditContext,
  maxTokens: number,
  qaContext?: string,
  dimensions: readonly Dimension[] = DIMENSIONS
): Promise<SubagentRun[]> {
  return Promise.all(
    dimensions.map((dimension) => runSubagent(client, dimension, context, maxTokens, qaContext))
  );
}
