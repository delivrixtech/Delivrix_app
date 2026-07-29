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
/** Alcanza para un abanico de la flota entera sin retener transcripts. */
const defaultFinishedRetention = 200;

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
  /** Cuantos snapshots de sesiones terminadas se retienen. Default 200. */
  finishedRetention?: number;
  /**
   * Vueltas del loop modelo -> tools -> modelo antes de rendirse. Default de la sesion: 8.
   *
   * El abanico de diagnostico lo sube: son 5 tools y si el modelo las pide de a una y comenta
   * entre medio son 6 vueltas; con un reintento, 8. Al pasarse, la sesion se reporta como
   * `failed` habiendo hecho el trabajo.
   */
  maxIterations?: number;
  now?: () => Date;
}

/**
 * Quien pide una invocacion.
 *
 * - `operator`: el humano. Solo habla con el orquestador (modelo mental de la spec).
 * - `orchestrator`: delegacion conversacional, decidida por el modelo.
 * - `supervisor`: un abanico determinista. NO es un humano ni un modelo: es codigo que reparte
 *   trabajo sobre items independientes. Se distingue de los otros dos a proposito, porque el
 *   audit trail tiene que poder decir quien pidio cada sesion. Marcar un abanico como
 *   `orchestrator` seria registrar que un modelo delego cuando no hubo ningun modelo decidiendo.
 */
export type AgentInvoker = AgentRole | "operator" | "supervisor";

/**
 * La invocacion tiro, pero la sesion ya habia gastado.
 *
 * Envuelve el error original conservando lo que la sesion alcanzo a consumir. Sin esto un
 * `agent_usage_missing` o un idle-timeout en la ultima iteracion borraba de los totales todos
 * los tokens de las iteraciones anteriores, que igual se pagaron.
 */
export class AgentInvocationFailed extends Error {
  readonly sessionId: string;
  readonly snapshot: AgentSessionSnapshot;

  constructor(sessionId: string, snapshot: AgentSessionSnapshot, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AgentInvocationFailed";
    this.sessionId = sessionId;
    this.snapshot = snapshot;
  }

  /** El code del error original, para que quien discrimine por codigo siga pudiendo. */
  get code(): string | undefined {
    const original = this.cause;
    return original instanceof Error ? (original as { code?: string }).code : undefined;
  }
}

export interface InvokeAgentOptions {
  /** Rol del actor que pide la invocación. */
  invokedByRole: AgentInvoker;
  /** Cadena de taskIds ancestros para detección de ciclos. */
  taskChain?: string[];
  /** Corta la llamada al modelo en vuelo, no solo entre items. */
  abortSignal?: AbortSignal;
}

export class AgentSessionManager {
  private readonly eventBus: AgentEventBus;
  private readonly modelClientFactory: (role: AgentRole) => AgentModelClient;
  private readonly toolExecutorFactory: (role: AgentRole) => AgentToolExecutor | undefined;
  private readonly toolSpecsForRole: (role: AgentRole) => BedrockToolSpec[];
  private readonly definitionForRole: (role: AgentRole) => AgentDefinition;
  private readonly maxDelegationDepth: number;
  private readonly maxIterations: number | undefined;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, BedrockAgentSession>();
  /**
   * Snapshots de sesiones ya terminadas, acotados.
   *
   * La sesion viva retiene su transcript entero; con un abanico de 59 dominios eso es memoria
   * que nunca se libera (antes NO habia un solo delete en toda la clase). Se borra la sesion al
   * terminar y se guarda su snapshot, que es solo metadata: rol, estado, tokens, costo.
   */
  private readonly finished: AgentSessionSnapshot[] = [];
  private readonly finishedRetention: number;
  private paused = false;

  constructor(options: AgentSessionManagerOptions) {
    assertAgentRegistryIntegrity();
    this.eventBus = options.eventBus;
    this.modelClientFactory = options.modelClientFactory;
    this.toolExecutorFactory = options.toolExecutorFactory ?? (() => undefined);
    this.toolSpecsForRole = options.toolSpecsForRole ?? (() => []);
    this.definitionForRole = options.definitionForRole ?? ((role) => AGENT_DEFINITIONS[role]);
    this.maxDelegationDepth = options.maxDelegationDepth ?? defaultMaxDelegationDepth;
    this.maxIterations = options.maxIterations;
    this.finishedRetention = options.finishedRetention ?? defaultFinishedRetention;
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

  /** Sesiones vivas + las terminadas retenidas, en ese orden. */
  listSessions(): AgentSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot()).concat(this.finished);
  }

  /** Cuantas sesiones estan realmente vivas (sin contar el historial retenido). */
  get liveSessionCount(): number {
    return this.sessions.size;
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
      ...(this.maxIterations === undefined ? {} : { maxIterations: this.maxIterations }),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      now: this.now,
      sessionId: randomUUID()
    });
    this.sessions.set(session.sessionId, session);

    try {
      const result = await session.run(input.instructions);
      return { sessionId: session.sessionId, result };
    } catch (error) {
      // Los tokens que la sesion ya consumio NO desaparecen porque la invocacion tire: Bedrock
      // ya los facturo. Si el error sale pelado, el abanico no tiene de donde sacarlos y el
      // costo de la corrida sale por debajo del gasto real — justo el numero con el que se
      // decide donde corren los agentes.
      throw new AgentInvocationFailed(session.sessionId, session.snapshot(), error);
    } finally {
      // `finally` y no despues del return: si `run` tira, la sesion tambien tiene que salir del
      // Map o queda zombi reteniendo su transcript para siempre.
      this.retire(session);
    }
  }

  /**
   * Que modelo va a correr este rol, sin arrancar una sesion.
   *
   * El reporte lo necesita para no ser ambiguo: una corrida en mock y una real se leen igual si
   * el reporte no dice cual fue.
   */
  modelIdForRole(role: AgentRole): string {
    return this.modelClientFactory(role).modelId;
  }

  /** Saca la sesion del Map y conserva solo su snapshot, con retencion acotada. */
  private retire(session: BedrockAgentSession): void {
    this.sessions.delete(session.sessionId);
    this.finished.push(session.snapshot());
    if (this.finished.length > this.finishedRetention) {
      this.finished.splice(0, this.finished.length - this.finishedRetention);
    }
  }

  private assertAuthority(target: AgentRole, invokedBy: AgentInvoker): void {
    if (invokedBy === "supervisor") {
      // Un abanico reparte trabajo sobre items independientes; no conversa ni consolida.
      // Por eso NO puede invocar al orquestador: eso seria delegacion, y la delegacion la
      // decide el modelo, no el codigo.
      if (target === "orchestrator") {
        throw new AgentSessionError(
          "agent_invoke_forbidden",
          "Un abanico (supervisor) no puede invocar al orquestador: eso es delegacion conversacional."
        );
      }
      return;
    }
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
