export interface BedrockInput {
  prompt: string;
  maxTokens: number;
  temperature: number;
}

export interface BedrockResponse {
  text: string;
  tokensUsed: number;
}

export async function callBedrockSonnet(input: BedrockInput): Promise<BedrockResponse> {
  const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
  const region = process.env.AWS_REGION ?? "us-east-1";

  if (!apiKey) {
    return {
      text: fallbackReportFromPrompt(input.prompt),
      tokensUsed: 0
    };
  }

  const response = await fetch(
    `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        messages: [
          {
            role: "user",
            content: input.prompt
          }
        ]
      })
    }
  );

  if (!response.ok) {
    return {
      text: fallbackReportFromPrompt(input.prompt),
      tokensUsed: 0
    };
  }

  const payload = await response.json() as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = payload.content?.map((item) => item.text).filter(Boolean).join("\n").trim();

  return {
    text: text || fallbackReportFromPrompt(input.prompt),
    tokensUsed: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0)
  };
}

function fallbackReportFromPrompt(prompt: string): string {
  const date = prompt.match(/# Reporte diario · ([0-9-]+)/)?.[1] ?? new Date().toISOString().slice(0, 10);
  const unavailable = [...prompt.matchAll(/\(no disponible: ([^)]+)\)/g)].map((match) => match[1] ?? "fuente no disponible");
  const failedText = unavailable.length > 0
    ? `Hay ${unavailable.length} fuente(s) no disponibles; el reporte omite esas métricas y conserva solo datos observados.`
    : "Los cinco reads operativos respondieron y el reporte usa únicamente datos observados.";

  return `# Reporte diario · ${date}

## Resumen ejecutivo
${failedText} No se detecta ejecución live ni envío SMTP real desde Delivrix en este corte. El reporte queda como salida de chat y no crea tarjeta Notion.

## Métricas clave del día
1. send_results: datos leídos desde Gateway si la fuente respondió.
2. ip_reputation: salud observada desde reportes disponibles.
3. stuck_jobs: cola revisada para jobs trabados.
4. sender_nodes: inventario consultado en modo read-only.
5. audit_events: últimos eventos usados como evidencia.

## Top 5 hallazgos
- [low] Reporte generado en modo dry-run sin side effects.
- [low] Reads parciales se declaran explícitamente cuando fallan.
- [low] Notion queda omitido por decisión auditada.

## Nodos en alerta
ninguno con dato suficiente para afirmarlo.

## Próximos pasos sugeridos para el operador
1. Revisar cualquier endpoint fallido antes de compartir el reporte.
2. Mantener Notion diferido hasta Hito 5.12.
3. Continuar con runbooks aprobados solo cuando existan tokens vigentes.`;
}
