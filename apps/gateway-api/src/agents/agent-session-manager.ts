/**
 * Registry de sesiones vivas del runtime multi-agente + reglas de autoridad.
 *
 * Invariantes de la spec (sección "Seguridad multi-agente"):
 *  - Solo el Orquestador puede invocar especialistas (canDelegate).
 *  - Un sub-agente NO puede invocar a otro sub-agente.
 *  - Ciclos detectados vía cadena parentTaskId + max depth.
 *  - `pauseAll()` marca el runtime en pausa: ninguna delegación nueva arranca.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentInvokeInput,
  AgentRole,
  AgentSessionSnapshot
} from "../../../../packages/domain/src/index.ts";
import { isAgentRole } from "../../../../packages/domain/src/index.ts";
import type { BedrockToolSpec } from "../openclaw-tools-builder.ts";
import {
  AGENT_DEFINITIONS,
  assertAgentRegistryIntegrity,
  type AgentDefinition
} from "./agent-registry.ts";
import type { AgentEventBus } from "./agent-event-bus.ts";
import {
  AgentSessionError,
  BedrockAgentSession,
  type AgentModelClient,
  type AgentSessionResult,
  type AgentToolExecutor
} from "./bedrock-agent-session.ts";

const defaultMaxDelegationDepth = 3;

export interface AgentSessionManagerOptions {
  eventBus: AgentEventBus;
  /** Factory por rol: permite un mock guionado distinto por agente en tests/dry-run. */
  modelClientFactory: (role: AgentRole) => AgentModelClient;
  toolExecutorFactory?: (role: AgentRole) => AgentToolExecutor | undefined;
  toolSpecsForRole?: (role: AgentRole) => BedrockToolSpec[];
  /**
   * Definicion efectiva del agente. Default: `AGENT_DEFINITIONS[role]`.
   *
   * Existe porque `BedrockAgentSession` filtra cada tool_use contra
   * `definition.toolNames` (bedrock-agent-session.ts:363), y el registry declara los nombres
   * del diseño original — que para warmup son 8 inventados sin handler. Un modo de operacion
   * que use las tools REALES (el abanico de diagnostico) necesita que la sesion filtre contra
   * SU lista, o rechaza todas sus tools con `tool_out_of_scope` y reporta la sesion como
   * completada: cero lecturas y un "todo ok" falso.
   *
   * Se inyecta en vez de cambiar el registry a proposito: `assertAgentRegistryIntegrity` valida
   * conteos por rol en el constructor, y el camino conversacional del orquestador sigue usando
   * la definicion original sin enterarse.
   */
  definitionForRole?: (role: AgentRole) => AgentDefinition;
  maxDelegationDepth?: number;
  now?: () => Date;
}

export interface InvokeAgentOptions {
  /** Rol del actor que pide la invocación ("operator" para el humano). */
  invokedByRole: AgentRole | "operator";
  /** Cadena de taskIds ancestros para detección de ciclos. */
  taskChain?: string[];
}

export class AgentSessionManager {
  private readonly eventBus: AgentEventBus;
  private readonly modelClientFactory: (role: AgentRole) => AgentModelClient;
  private readonly toolExecutorFactory: (role: AgentRole) => AgentToolExecutor | undefined;
  private readonly toolSpecsForRole: (role: AgentRole) => BedrockToolSpec[];
  private readonly definitionForRole: (role: AgentRole) => AgentDefinition;
  private readonly maxDelegationDepth: number;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, BedrockAgentSession>();
  private paused = false;

  constructor(options: AgentSessionManagerOptions) {
    assertAgentRegistryIntegrity();
    this.eventBus = options.eventBus;
    this.modelClientFactory = options.modelClientFactory;
    this.toolExecutorFactory = options.toolExecutorFactory ?? (() => undefined);
    this.toolSpecsForRole = options.toolSpecsForRole ?? (() => []);
    this.definitionForRole = options.definitionForRole ?? ((role) => AGENT_DEFINITIONS[role]);
    this.maxDelegationDepth = options.maxDelegationDepth ?? defaultMaxDelegationDepth;
    this.now = options.now ?? (() => new Date());
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Kill switch suave: bloquea nuevas sesiones. Las que corren terminan su turno. */
  pauseAll(): void {
    this.paused = true;
  }

  resumeAll(): void {
    this.paused = false;
  }

  listSessions(): AgentSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  getSession(sessionId: string): BedrockAgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Crea y ejecuta la sesión de un agente. Toda invocación (operador →
   * orquestador, orquestador → especialista) pasa por aquí.
   */
  async invokeAgent(
    role: AgentRole | string,
    input: AgentInvokeInput,
    options: InvokeAgentOptions
  ): Promise<{ sessionId: string; result: AgentSessionResult }> {
    if (!isAgentRole(role)) {
      throw new AgentSessionError("agent_role_unknown", `Rol de agente desconocido: ${String(role)}.`);
    }
    if (this.paused) {
      throw new AgentSessionError(
        "multi_agent_runtime_paused",
        "El runtime multi-agente está pausado (pause_all_agents). Reanuda antes de delegar."
      );
    }

    this.assertAuthority(role, options.invokedByRole);

    const taskChain = options.taskChain ?? [];
    if (taskChain.includes(input.taskId)) {
      throw new AgentSessionError(
        "agent_delegation_cycle",
        `Ciclo de delegación detectado: taskId ${input.taskId} ya está en la cadena [${taskChain.join(" → ")}].`
      );
    }
    if (taskChain.length >= this.maxDelegationDepth) {
      throw new AgentSessionError(
        "agent_delegation_too_deep",
        `Profundidad de delegación ${taskChain.length} supera el máximo ${this.maxDelegationDepth}.`
      );
    }

    const definition = this.definitionForRole(role);
    const session = new BedrockAgentSession({
      definition,
      taskId: input.taskId,
      parentTaskId: input.context?.parentTaskId,
      delegatedBy: input.delegatedBy,
      modelClient: this.modelClientFactory(role),
      eventBus: this.eventBus,
      tools: this.toolSpecsForRole(role),
      toolExecutor: this.toolExecutorFactory(role),
      now: this.now,
      sessionId: randomUUID()
    });
    this.sessions.set(session.sessionId, session);

    const result = await session.run(input.instructions);
    return { sessionId: session.sessionId, result };
  }

  private assertAuthority(target: AgentRole, invokedBy: AgentRole | "operator"): void {
    if (invokedBy === "operator") {
      // El operador humano solo interactúa con el Orquestador (spec, modelo mental).
      if (target !== "orchestrator") {
        throw new AgentSessionError(
          "agent_invoke_forbidden",
          `El operador solo puede invocar al orquestador; ${target} se invoca por delegación.`
        );
      }
      return;
    }
    if (invokedBy === "orchestrator") {
      if (target === "orchestrator") {
        throw new AgentSessionError(
          "agent_invoke_forbidden",
          "El orquestador no puede delegarse a sí mismo."
        );
      }
      return;
    }
    // Especialistas: prohibido invocar a cualquier agente (incluido QA).
    throw new AgentSessionError(
      "agent_invoke_forbidden",
      `El rol ${invokedBy} no tiene autoridad para invocar agentes (solo el orquestador delega).`
    );
  }
}
