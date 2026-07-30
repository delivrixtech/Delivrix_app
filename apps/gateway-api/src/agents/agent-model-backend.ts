// Que cerebro usa cada agente.
//
// La seleccion es POR ROL y no global a proposito. La decision del owner es que OpenClaw —el
// que crea SMTPs, donde un error cuesta un dominio y una IP— siga en Claude, y que los 59
// agentes del warmup, que solo leen, puedan correr en el modelo local. Un unico interruptor
// global obligaria a mover los dos juntos.
//
// El default es `mock`, y eso es deliberado: un despliegue sin configurar NO tiene que empezar
// a gastar plata ni a abrir SSH contra la flota por su cuenta.

import type { AgentRole } from "../../../../packages/domain/src/index.ts";
import { MOCK_AGENT_MODEL_ID, MockAgentModelClient, type AgentModelClient } from "./bedrock-agent-session.ts";
import { createBedrockAgentModelClient, type AgentModelDegradation } from "./bedrock-agent-model-client.ts";
import { createLocalOpenAiAgentModelClient } from "./local-openai-agent-model-client.ts";
import { RehearsalAgentModelClient } from "./rehearsal-agent-model-client.ts";

export const AGENT_MODEL_BACKENDS = ["mock", "rehearsal", "bedrock", "local"] as const;
export type AgentModelBackend = (typeof AGENT_MODEL_BACKENDS)[number];

export const DEFAULT_AGENT_MODEL_BACKEND: AgentModelBackend = "mock";

/** MULTI_AGENT_MODE_WARMUP, MULTI_AGENT_MODE_QA_SECURITY, ... */
export function envKeyForRole(role: AgentRole): string {
  return `MULTI_AGENT_MODE_${role.toUpperCase().replace(/-/g, "_")}`;
}

export interface ResolvedBackend {
  backend: AgentModelBackend;
  /** De donde salio: sirve para que el arranque diga por que cada rol quedo donde quedo. */
  source: "role_override" | "global" | "default";
  /** Valor ilegible que se ignoro. Se reporta en vez de tragarselo. */
  invalidValue?: string;
}

/**
 * Resuelve el backend de un rol: override por rol, si no el global, si no el default.
 *
 * Un valor invalido NO cae a bedrock ni a local: cae al default seguro y se reporta. Un typo en
 * una env var no puede ser la razon por la que 59 agentes empiezan a gastar.
 */
export function resolveBackendForRole(
  role: AgentRole,
  env: Record<string, string | undefined>
): ResolvedBackend {
  const roleRaw = env[envKeyForRole(role)]?.trim().toLowerCase();
  if (roleRaw) {
    if (isBackend(roleRaw)) return { backend: roleRaw, source: "role_override" };
    return { backend: DEFAULT_AGENT_MODEL_BACKEND, source: "default", invalidValue: roleRaw };
  }

  const globalRaw = env.MULTI_AGENT_MODE?.trim().toLowerCase();
  if (globalRaw) {
    if (isBackend(globalRaw)) return { backend: globalRaw, source: "global" };
    return { backend: DEFAULT_AGENT_MODEL_BACKEND, source: "default", invalidValue: globalRaw };
  }

  return { backend: DEFAULT_AGENT_MODEL_BACKEND, source: "default" };
}

function isBackend(value: string): value is AgentModelBackend {
  return (AGENT_MODEL_BACKENDS as readonly string[]).includes(value);
}

export interface AgentModelClientFactoryInput {
  env?: Record<string, string | undefined>;
  onDegradation?: (notice: AgentModelDegradation) => void;
  /** Se avisa una vez por rol al construir, para que el arranque no sea mudo. */
  onBackendResolved?: (notice: { role: AgentRole; resolved: ResolvedBackend; modelId: string }) => void;
}

/**
 * Devuelve la factory que el AgentSessionManager usa por sesion.
 *
 * Se construye un cliente por sesion (el manager llama a la factory en cada invokeAgent), asi
 * que tiene que ser barato. El BedrockRuntimeClient, que es lo unico pesado, se cachea por rol.
 */
export function createAgentModelClientFactory(
  input: AgentModelClientFactoryInput = {}
): (role: AgentRole) => AgentModelClient {
  const env = input.env ?? process.env;
  const cache = new Map<AgentRole, AgentModelClient>();
  const announced = new Set<AgentRole>();

  return (role: AgentRole): AgentModelClient => {
    const resolved = resolveBackendForRole(role, env);

    // El ensayo lleva cursor propio por sesion: cachearlo haria que la segunda sesion arranque
    // con las tools ya consumidas y no ejecute ninguna.
    if (resolved.backend === "rehearsal") {
      announce(role, resolved, REHEARSAL_ID);
      return new RehearsalAgentModelClient();
    }
    if (resolved.backend === "mock") {
      announce(role, resolved, "mock/dry-run");
      return new MockAgentModelClient();
    }

    const cached = cache.get(role);
    if (cached) return cached;

    const client = resolved.backend === "local"
      ? createLocalOpenAiAgentModelClient({
          env,
          ...(input.onDegradation ? { onDegradation: input.onDegradation } : {})
        })
      : createBedrockAgentModelClient({
          env,
          ...(input.onDegradation ? { onDegradation: input.onDegradation } : {})
        });
    cache.set(role, client);
    announce(role, resolved, client.modelId);
    return client;
  };

  function announce(role: AgentRole, resolved: ResolvedBackend, modelId: string): void {
    if (announced.has(role)) return;
    announced.add(role);
    input.onBackendResolved?.({ role, resolved, modelId });
  }
}

const REHEARSAL_ID = "rehearsal/sin-modelo";

/**
 * Chequeo de vida del cerebro: UNA llamada minima antes de despachar la flota.
 *
 * No alcanza con preguntarle al servidor que modelos tiene. `/v1/models` de LM Studio lista los
 * modelos DESCARGADOS, no los CARGADOS: devolvio 200 con el modelo en la lista mientras cada
 * inferencia fallaba con "No models loaded". El unico chequeo que no miente es inferir.
 */
export function createAgentModelPreflight(
  factory: (role: AgentRole) => AgentModelClient
): (role: AgentRole) => Promise<void> {
  return async (role: AgentRole): Promise<void> => {
    const client = factory(role);
    // El mock y el ensayo no tienen backend que chequear.
    if (client.modelId === MOCK_AGENT_MODEL_ID || client.modelId === REHEARSAL_ID) return;
    await client.invoke({
      system: "Chequeo de vida. Responde una sola palabra.",
      messages: [{ role: "user", content: "ok" }],
      tools: []
    });
  };
}
