/**
 * Punto de composición del runtime multi-agente (single daemon).
 *
 * Crea: bus de eventos (→ canvas-live + audit), session manager con la matriz
 * de autoridad, y el orquestador con sus tools de coordinación. Modo mock por
 * defecto; el cliente Bedrock real entra el día 3 por `bedrockClientFactory`.
 *
 * Día 2: main.ts monta esto y expone POST /v1/openclaw/agents/{role}/invoke
 * y GET /v1/openclaw/agents/state sobre esta instancia.
 */

import type { AgentRole } from "../../../../packages/domain/src/index.ts";
import { toolNamesForRole } from "../../../../packages/domain/src/index.ts";
import type { BedrockToolSpec } from "../openclaw-tools-builder.ts";
import { AgentEventBus, type AuditSink, type CanvasLiveSink } from "./agent-event-bus.ts";
import { AgentSessionManager } from "./agent-session-manager.ts";
import {
  createAgentModelClient,
  resolveMultiAgentRuntimeMode,
  type AgentModelClient,
  type AgentToolExecutor,
  type MultiAgentRuntimeMode
} from "./bedrock-agent-session.ts";
import { MultiAgentOrchestrator } from "./orchestrator.ts";

export interface MultiAgentRuntime {
  mode: MultiAgentRuntimeMode;
  eventBus: AgentEventBus;
  sessionManager: AgentSessionManager;
  orchestrator: MultiAgentOrchestrator;
}

export interface CreateMultiAgentRuntimeOptions {
  env?: Record<string, string | undefined>;
  canvasLive?: CanvasLiveSink;
  auditLog?: AuditSink;
  /** Override por rol (tests / clientes guionados). */
  modelClientFactory?: (role: AgentRole) => AgentModelClient;
  /** Cliente Bedrock real (día 3). */
  bedrockClientFactory?: (role: AgentRole) => AgentModelClient;
  /** Dispatch real de tools de especialistas (día 4). */
  specialistToolExecutorFactory?: (role: AgentRole) => AgentToolExecutor | undefined;
  now?: () => Date;
}

export function createMultiAgentRuntime(options: CreateMultiAgentRuntimeOptions = {}): MultiAgentRuntime {
  const env = options.env ?? process.env;
  const mode = resolveMultiAgentRuntimeMode(env);

  const eventBus = new AgentEventBus({
    canvasLive: options.canvasLive,
    auditLog: options.auditLog
  });

  const modelClientFactory = options.modelClientFactory ?? ((role: AgentRole) =>
    createAgentModelClient({
      mode,
      env,
      ...(options.bedrockClientFactory
        ? { bedrockClientFactory: () => options.bedrockClientFactory!(role) }
        : {})
    }));

  // Resolución tardía: el executor del orquestador necesita el manager y viceversa.
  let orchestrator: MultiAgentOrchestrator | null = null;

  const sessionManager = new AgentSessionManager({
    eventBus,
    modelClientFactory,
    toolSpecsForRole: declaredToolSpecsForRole,
    toolExecutorFactory: (role) => {
      if (role === "orchestrator") {
        return orchestrator?.createOrchestratorToolExecutor() ?? undefined;
      }
      return options.specialistToolExecutorFactory?.(role);
    },
    now: options.now
  });

  orchestrator = new MultiAgentOrchestrator({
    sessionManager,
    now: options.now
  });

  return { mode, eventBus, sessionManager, orchestrator };
}

/**
 * Tool specs declaradas por rol. Día 1: schema abierto por tool (nombre +
 * descripción); los JSON Schemas estrictos por tool llegan con el dispatch
 * real del día 4 (reuso de openclaw-tools-builder / skill-schemas).
 */
export function declaredToolSpecsForRole(role: AgentRole): BedrockToolSpec[] {
  return toolNamesForRole(role).map((name) => ({
    name,
    description: `Tool ${name} del rol ${role} (Fase 2). Dispatch real: día 4.`,
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  }));
}
