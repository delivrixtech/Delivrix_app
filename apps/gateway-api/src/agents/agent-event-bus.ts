/**
 * Bus interno de eventos agent.* del runtime multi-agente.
 *
 * Contrato: el runtime habla agent.* (spec ARQUITECTURA_MULTI_AGENT_RUNTIME) y
 * este bus proyecta cada evento hacia:
 *  1. Suscriptores in-process (WSS broadcaster del día 2, cost tracker del día 3).
 *  2. El emisor canvas-live existente, mapeando agent.* → oc.* para que el panel
 *     actual (schema 2026-05-25.canvas-live.v1) pinte la actividad sin migración.
 *  3. El audit sink (acciones oc.agent.*).
 *
 * Filosofía Bloque 8: fail-soft. Si el emisor canvas-live o el audit sink
 * fallan, se loguea a stderr y la conversación de los agentes NO se rompe.
 */

import type {
  AgentEvent,
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveTaskStatus
} from "../../../../packages/domain/src/index.ts";
import { AGENT_DEFINITIONS } from "./agent-registry.ts";

export interface CanvasLiveSink {
  emit(event: CanvasLiveEvent): Promise<unknown>;
}

export interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentEventBusOptions {
  canvasLive?: CanvasLiveSink;
  auditLog?: AuditSink;
  /** Actor id usado al declarar tasks canvas-live. */
  actorId?: string;
  logError?: (message: string, error: unknown) => void;
}

export class AgentEventBus {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly canvasLive: CanvasLiveSink | null;
  private readonly auditLog: AuditSink | null;
  private readonly actorId: string;
  private readonly logError: (message: string, error: unknown) => void;

  constructor(options: AgentEventBusOptions = {}) {
    this.canvasLive = options.canvasLive ?? null;
    this.auditLog = options.auditLog ?? null;
    this.actorId = options.actorId ?? "openclaw-multi-agent";
    this.logError = options.logError ?? ((message, error) => {
      console.error(`[agent-event-bus] ${message}`, error);
    });
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async publish(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logError(`listener falló para ${event.type}`, error);
      }
    }

    if (this.canvasLive) {
      for (const canvasEvent of agentEventToCanvasLiveEvents(event, this.actorId)) {
        try {
          await this.canvasLive.emit(canvasEvent);
        } catch (error) {
          this.logError(`canvas-live emit falló para ${event.type}`, error);
        }
      }
    }

    if (this.auditLog) {
      try {
        await this.auditLog.append(agentEventToAuditInput(event));
      } catch (error) {
        this.logError(`audit append falló para ${event.type}`, error);
      }
    }
  }
}

/**
 * Task canvas-live por sesión de agente. El orquestador usa el taskId raw
 * (es la tarea que ve el operador); los especialistas cuelgan como subtareas
 * `{taskId}--{role}` con parentTaskId al taskId del orquestador.
 */
export function canvasTaskIdForAgent(event: Pick<AgentEvent, "agentRole" | "taskId">): string {
  return event.agentRole === "orchestrator" ? event.taskId : `${event.taskId}--${event.agentRole}`;
}

export function agentEventToCanvasLiveEvents(event: AgentEvent, actorId: string): CanvasLiveEvent[] {
  const canvasTaskId = canvasTaskIdForAgent(event);
  const displayName = AGENT_DEFINITIONS[event.agentRole].displayName;

  switch (event.type) {
    case "agent.started":
      return [
        {
          type: "oc.task.declare",
          taskId: canvasTaskId,
          ...(event.agentRole === "orchestrator" ? {} : { parentTaskId: event.taskId }),
          title: `${displayName} — sesión ${event.sessionId.slice(0, 8)}`,
          status: "running",
          createdAt: event.occurredAt,
          actorId
        }
      ];
    case "agent.completed":
      return [taskUpdate(canvasTaskId, "completed", event.occurredAt)];
    case "agent.failed":
      return [
        auditAction(event, canvasTaskId, "high", {
          reason: event.reason,
          evidenceRefs: event.evidenceRefs
        }),
        taskUpdate(canvasTaskId, "failed", event.occurredAt)
      ];
    case "agent.awaiting_signature":
      return [
        auditAction(event, canvasTaskId, "critical", {
          auditId: event.auditId,
          expiresAt: event.expiresAt
        }),
        taskUpdate(canvasTaskId, "awaiting_approval", event.occurredAt)
      ];
    case "agent.signature_received":
      return [
        auditAction(event, canvasTaskId, "critical", {
          auditId: event.auditId,
          signedBy: event.signedBy
        }),
        taskUpdate(canvasTaskId, "running", event.occurredAt)
      ];
    case "agent.tool_use":
      return [
        auditAction(event, canvasTaskId, "medium", {
          toolName: event.toolName
        })
      ];
    case "agent.tool_result":
      return [
        auditAction(event, canvasTaskId, event.success ? "low" : "medium", {
          toolName: event.toolName,
          success: event.success,
          durationMs: event.durationMs,
          ...(event.error ? { error: event.error } : {})
        })
      ];
    case "agent.proposing":
      return [
        auditAction(event, canvasTaskId, "high", {
          auditId: event.auditId,
          summary: event.summary
        })
      ];
    case "agent.thinking":
      return [
        auditAction(event, canvasTaskId, "low", {
          progressNote: event.progressNote
        })
      ];
    case "agent.heartbeat":
      return [
        auditAction(event, canvasTaskId, "low", {
          tokensUsedSoFar: event.tokensUsedSoFar,
          estimatedCostSoFar: event.estimatedCostSoFar
        })
      ];
  }
}

function taskUpdate(taskId: string, status: CanvasLiveTaskStatus, updatedAt: string): CanvasLiveEvent {
  return {
    type: "oc.task.update",
    taskId,
    status,
    updatedAt
  };
}

function auditAction(
  event: AgentEvent,
  canvasTaskId: string,
  riskLevel: "low" | "medium" | "high" | "critical",
  metadata: Record<string, unknown>
): CanvasLiveEvent {
  return {
    type: "oc.action.now",
    taskId: canvasTaskId,
    kind: "audit",
    action: event.type,
    targetType: "openclaw_agent_session",
    targetId: event.sessionId,
    riskLevel,
    metadata: {
      agentRole: event.agentRole,
      ...metadata
    },
    occurredAt: event.occurredAt
  };
}

const auditRiskByEventType: Record<AgentEvent["type"], "low" | "medium" | "high" | "critical"> = {
  "agent.started": "low",
  "agent.thinking": "low",
  "agent.heartbeat": "low",
  "agent.tool_use": "medium",
  "agent.tool_result": "medium",
  "agent.proposing": "high",
  "agent.awaiting_signature": "critical",
  "agent.signature_received": "critical",
  "agent.completed": "medium",
  "agent.failed": "high"
};

export function agentEventToAuditInput(event: AgentEvent): AuditEventInput {
  const { type, agentRole, taskId, sessionId, occurredAt, ...rest } = event as AgentEvent & Record<string, unknown>;
  return {
    actorType: "openclaw",
    actorId: `openclaw-agent/${agentRole}`,
    action: `oc.${type}`,
    targetType: "openclaw_agent_session",
    targetId: sessionId,
    riskLevel: auditRiskByEventType[event.type],
    decision: "allow",
    metadata: {
      taskId,
      occurredAt,
      ...sanitizeMetadata(rest)
    }
  };
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (key === "toolInput") {
      // El input completo puede contener material sensible: solo se conserva el shape.
      result.toolInputKeys = entry && typeof entry === "object" ? Object.keys(entry as object) : typeof entry;
      continue;
    }
    result[key] = entry;
  }
  return result;
}
