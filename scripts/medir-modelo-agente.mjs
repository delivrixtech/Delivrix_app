// Banco de medicion del cerebro de los agentes, POR EL CAMINO DE PRODUCCION.
//
// Cliente real, specs reales, prompt real del Warmup Senior, loop de sesion real. Lo unico
// doblado es el executor de tools: devuelve datos plausibles en vez de sondear la flota. Asi se
// aisla "¿el modelo sabe usar herramientas?" de "¿los nodos responden?" — y se puede medir un
// modelo nuevo sin tocar un solo nodo.
//
// Existe porque la pregunta que decide donde corren los agentes no se contesta leyendo
// benchmarks: se contesta midiendo ESTE prompt, con ESTOS schemas, a 6 turnos.
//
// Uso:
//   node scripts/medir-modelo-agente.mjs una        # una sesion, detalle completo
//   node scripts/medir-modelo-agente.mjs 4          # 4 en paralelo (la concurrencia del abanico)
//   node scripts/medir-modelo-agente.mjs conflicto  # el caso donde la respuesta correcta es "no se"
//
// Env: LOCAL_INFERENCE_BASE_URL, LOCAL_INFERENCE_MODEL, MAXTOK

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { AgentEventBus } = await import(`${ROOT}/apps/gateway-api/src/agents/agent-event-bus.ts`);
const { createLocalOpenAiAgentModelClient } = await import(`${ROOT}/apps/gateway-api/src/agents/local-openai-agent-model-client.ts`);
const { BedrockAgentSession } = await import(`${ROOT}/apps/gateway-api/src/agents/bedrock-agent-session.ts`);
const { diagnosticToolSpecsForRole } = await import(`${ROOT}/apps/gateway-api/src/agents/agent-tool-specs.ts`);
const { warmupAuditDefinitionForRole } = await import(`${ROOT}/apps/gateway-api/src/agents/warmup-audit-run.ts`);
const { buildDiagnosticInstructions } = await import(`${ROOT}/apps/gateway-api/src/agents/warmup-fleet-source.ts`);

const env = {};
for (const line of readFileSync(`${ROOT}/config/gateway.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
env.LOCAL_INFERENCE_BASE_URL = process.env.LOCAL_INFERENCE_BASE_URL ?? "http://100.104.216.127:1234/v1";
env.LOCAL_INFERENCE_MODEL = process.env.LOCAL_INFERENCE_MODEL ?? "qwen3-30b-a3b-mlx-4bit";
env.LOCAL_INFERENCE_MAX_TOKENS = process.env.MAXTOK ?? "8192";

const specs = diagnosticToolSpecsForRole("warmup", env);
const definition = warmupAuditDefinitionForRole("warmup");

// Respuestas plausibles: el nodo responde, DKIM valida, el ultimo envio lo rechazo Gmail.
// Es un caso REAL de la flota (el 550-5.7.1 con IP limpia), asi que el veredicto correcto es
// "reputacion interna de Google", no "nodo caido".
const FAKE = {
  read_smtp_reachability: { ok: true, port25: "open", port587: "open", tls: "ok", banner: "220 mail ESMTP Postfix" },
  read_delivery_reason: { ok: true, status: "bounced", smtpCode: "550-5.7.1", reason: "unsolicited mail originating from your IP address", destination: "gmail.com" },
  read_dkim_status: { ok: true, selector: "s2026a", published: true, valid: true },
  read_mxtoolbox_health: { ok: true, blacklists: 0, spf: "pass", dmarc: "quarantine", ptr: "ok" },
  inspect_smtp_inventory: { ok: true, status: "configured", serverSlug: "contabo-3-node-7" }
};

const modo = process.argv[2] ?? "una";

// El caso sano y el caso trampa. En el segundo el inventario se contradice sobre que nodo sirve
// al dominio: la respuesta CORRECTA es no sondear nada y cerrar en indeterminado, porque un
// resultado correcto de la maquina equivocada es peor que no tener dato.
const TARGET = modo === "conflicto"
  ? {
      domain: "filing-ops.com",
      serverSlug: "contabo-3-node-7",
      serverIp: "203.0.113.44",
      hasCredential: true,
      bindingConflict: { fromBindings: "contabo-3-node-7", fromCredentials: "webdock-node-2" }
    }
  : {
      domain: "filing-ops.com",
      serverSlug: "contabo-3-node-7",
      serverIp: "203.0.113.44",
      hasCredential: true,
      recentMessageId: "<delivrix-abc123@filing-ops.com>"
    };

async function unaSesion(etiqueta) {
  const llamadas = [];
  const t0 = Date.now();
  const degradaciones = [];

  const client = createLocalOpenAiAgentModelClient({
    env,
    onDegradation: (n) => degradaciones.push(n.kind)
  });

  const session = new BedrockAgentSession({
    definition,
    taskId: `medicion-${etiqueta}`,
    delegatedBy: "supervisor",
    modelClient: client,
    eventBus: new AgentEventBus({}),
    tools: specs.specs,
    maxIterations: 12,
    toolExecutor: async ({ toolName, toolInput }) => {
      llamadas.push({ toolName, toolInput });
      const base = FAKE[toolName];
      if (!base) return { success: false, content: "", error: `tool_desconocida:${toolName}` };
      return { success: true, content: JSON.stringify(base) };
    }
  });

  let resultado;
  let error = null;
  try {
    resultado = await session.run(buildDiagnosticInstructions(TARGET));
  } catch (e) {
    error = e instanceof Error ? `${e.code ?? e.name}: ${e.message}` : String(e);
  }
  const ms = Date.now() - t0;

  return {
    etiqueta, ms, error, degradaciones,
    status: resultado?.status,
    inputTokens: resultado?.inputTokens ?? 0,
    outputTokens: resultado?.outputTokens ?? 0,
    truncated: resultado?.truncated ?? false,
    toolsPedidas: llamadas.map((c) => c.toolName),
    paramsOk: llamadas.every((c) => c.toolInput && typeof c.toolInput === "object" && Object.keys(c.toolInput).length > 0),
    llamadas,
    veredicto: (resultado?.resultSummary ?? "").slice(0, 1200)
  };
}

console.log(`specs resueltas: ${specs.specs.length} de 5 | missing: ${JSON.stringify(specs.missing)}`);
console.log(`max_tokens: ${env.LOCAL_INFERENCE_MAX_TOKENS}\n`);

if (modo === "una" || modo === "conflicto") {
  const r = await unaSesion("solo");
  console.log(JSON.stringify(r, null, 2));
} else {
  const n = Number(modo);
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => unaSesion(`par-${i + 1}`)));
  const total = Date.now() - t0;
  console.log(`=== ${n} EN PARALELO — pared total: ${(total / 1000).toFixed(1)}s ===`);
  for (const r of rs) {
    console.log(`  ${r.etiqueta}: ${(r.ms / 1000).toFixed(1)}s | ${r.status ?? "ERROR"} | tools: ${r.toolsPedidas.length} [${[...new Set(r.toolsPedidas)].join(",")}] | out:${r.outputTokens}${r.error ? " | " + r.error : ""}`);
  }
  const oks = rs.filter((r) => r.status === "completed");
  console.log(`\ncompletadas: ${oks.length}/${n}`);
  if (oks.length) {
    const tiempos = oks.map((r) => r.ms / 1000);
    console.log(`por sesion: min ${Math.min(...tiempos).toFixed(1)}s | max ${Math.max(...tiempos).toFixed(1)}s`);
  }
}
