/**
 * Esqueleto del Orchestrator multi-agente (Fase 2, día 1).
 *
 * El operador humano habla SOLO con el orquestador. El orquestador corre como
 * sesión Bedrock propia (mock por defecto) y sus tools locales de coordinación
 * (delegate_to_*, register_task, escalate_to_operator, pause_all_agents) se
 * ejecutan aquí, contra el AgentSessionManager — no contra endpoints HTTP.
 *
 * Los tools de lectura (read_admin_overview, read_kill_switch, …) y
 * request_signature se cablean a los endpoints reales el día 2-4; hoy
 * responden dry-run explícito para que el loop sea honesto.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentInvokeInput,
  AgentRole,
  AgentSessionSnapshot
} from "../../../../packages/domain/src/index.ts";
import type { AgentSessionManager } from "./agent-session-manager.ts";
import type { AgentSessionResult, AgentToolExecutor } from "./bedrock-agent-session.ts";

export interface OrchestratorTaskRecord {
  taskId: string;
  title: string;
  priority: string;
  status: string;
  dependencies: string[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OperatorEscalation {
  severity: string;
  message: string;
  evidenceRefs: string[];
  occurredAt: string;
}

export interface OrchestratorRunOutcome {
  taskId: string;
  sessionId: string;
  result: AgentSessionResult;
  delegations: Array<{
    role: AgentRole;
    taskId: string;
    sessionId: string;
    status: AgentSessionResult["status"];
    resultSummary: string;
  }>;
  escalations: OperatorEscalation[];
}

export interface MultiAgentOrchestratorOptions {
  sessionManager: AgentSessionManager;
  now?: () => Date;
  generateTaskId?: () => string;
}

const delegateToolToRole: Record<string, AgentRole> = {
  delegate_to_dns: "dns",
  delegate_to_smtp: "smtp",
  delegate_to_warmup: "warmup",
  delegate_to_qa_security: "qa-security"
};

export class MultiAgentOrchestrator {
  private readonly sessionManager: AgentSessionManager;
  private readonly now: () => Date;
  private readonly generateTaskId: () => string;
  private readonly tasks = new Map<string, OrchestratorTaskRecord>();
  private readonly delegationsByTask = new Map<string, OrchestratorRunOutcome["delegations"]>();
  private readonly escalationsByTask = new Map<string, OperatorEscalation[]>();

  constructor(options: MultiAgentOrchestratorOptions) {
    this.sessionManager = options.sessionManager;
    this.now = options.now ?? (() => new Date());
    this.generateTaskId = options.generateTaskId ?? (() => `task-${randomUUID()}`);
  }

  listTasks(): OrchestratorTaskRecord[] {
    return [...this.tasks.values()];
  }

  listSessions(): AgentSessionSnapshot[] {
    return this.sessionManager.listSessions();
  }

  /**
   * Punto de entrada del operador: crea la tarea raíz y corre la sesión del
   * orquestador con el tool executor de coordinación.
   */
  async handleOperatorInstruction(
    instructions: string,
    options: { operatorId?: string; taskId?: string } = {}
  ): Promise<OrchestratorRunOutcome> {
    const taskId = options.taskId ?? this.generateTaskId();
    const operatorId = options.operatorId ?? "operator/juanes";
    this.delegationsByTask.set(taskId, []);
    this.escalationsByTask.set(taskId, []);

    this.registerTask({
      taskId,
      title: truncate(instructions, 60),
      priority: "normal",
      dependencies: []
    });

    const input: AgentInvokeInput = {
      taskId,
      delegatedBy: operatorId,
      instructions
    };

    const { sessionId, result } = await this.sessionManager.invokeAgent("orchestrator", input, {
      invokedByRole: "operator",
      taskChain: []
    });

    this.updateTaskStatus(taskId, result.status === "completed" ? "completed" : result.status, result.resultSummary);

    return {
      taskId,
      sessionId,
      result,
      delegations: this.delegationsByTask.get(taskId) ?? [],
      escalations: this.escalationsByTask.get(taskId) ?? []
    };
  }

  /**
   * Tool executor para la sesión del orquestador. Se inyecta en el
   * AgentSessionManager vía toolExecutorFactory("orchestrator").
   */
  createOrchestratorToolExecutor(): AgentToolExecutor {
    return async ({ session, toolName, toolInput }) => {
      const args = isRecord(toolInput) ? toolInput : {};

      const delegateRole = delegateToolToRole[toolName];
      if (delegateRole) {
        return this.executeDelegation(delegateRole, session.taskId, args);
      }

      switch (toolName) {
        case "register_task": {
          const record = this.registerTask({
            taskId: typeof args.taskId === "string" && args.taskId ? args.taskId : this.generateTaskId(),
            title: stringOr(args.title, "(sin título)"),
            priority: stringOr(args.priority, "normal"),
            dependencies: stringArray(args.dependencies)
          });
          return ok({ taskId: record.taskId, status: record.status });
        }
        case "update_task_status": {
          const updated = this.updateTaskStatus(
            stringOr(args.taskId, ""),
            stringOr(args.status, "running"),
            stringOr(args.note, "")
          );
          return updated
            ? ok({ taskId: updated.taskId, status: updated.status })
            : failure(`task_not_found: ${stringOr(args.taskId, "")}`);
        }
        case "pause_all_agents": {
          this.sessionManager.pauseAll();
          return ok({ paused: true });
        }
        case "escalate_to_operator": {
          const escalation: OperatorEscalation = {
            severity: stringOr(args.severity, "medium"),
            message: stringOr(args.message, ""),
            evidenceRefs: stringArray(args.evidenceRefs),
            occurredAt: this.now().toISOString()
          };
          this.escalationsFor(session.taskId).push(escalation);
          return ok({ escalated: true, severity: escalation.severity });
        }
        case "summarize_for_operator":
          return ok({ summary: truncate(stringOr(args.content, ""), 1_000) });
        case "ask_operator_clarification":
          // Día 2: viaja al panel vía WSS y bloquea hasta respuesta. Hoy: dry-run.
          return failure("operator_clarification_not_wired: se cablea con el WSS del día 2.");
        case "request_signature":
          return failure("request_signature_not_wired: el gate de firma se cablea el día 4 (requiere qa.signed_off).");
        case "read_admin_overview":
        case "read_kill_switch":
        case "read_canvas_state":
        case "read_audit_events":
        case "read_workspace_executions":
          return failure(`${toolName}_not_wired: lectura real contra el gateway se cablea el día 2.`);
        default:
          return failure(`tool_not_wired: ${toolName} declarada pero sin dispatcher (Fase 2 día 4).`);
      }
    };
  }

  private delegationsFor(taskId: string): OrchestratorRunOutcome["delegations"] {
    let list = this.delegationsByTask.get(taskId);
    if (!list) {
      list = [];
      this.delegationsByTask.set(taskId, list);
    }
    return list;
  }

  private escalationsFor(taskId: string): OperatorEscalation[] {
    let list = this.escalationsByTask.get(taskId);
    if (!list) {
      list = [];
      this.escalationsByTask.set(taskId, list);
    }
    return list;
  }

  private async executeDelegation(
    role: AgentRole,
    parentTaskId: string,
    args: Record<string, unknown>
  ): Promise<{ success: boolean; content: string; error?: string }> {
    const subTaskId = `${parentTaskId}--${role}-${randomUUID().slice(0, 8)}`;
    const instructions = stringOr(args.task ?? args.instructions ?? args.target_audit_id, "");
    if (!instructions) {
      return failure(`delegation_instructions_required: delegate_to_${role} requiere "task".`);
    }

    const input: AgentInvokeInput = {
      taskId: subTaskId,
      delegatedBy: "openclaw-orchestrator",
      instructions,
      context: {
        parentTaskId,
        ...(isRecord(args.context) && typeof args.context.deadline === "string"
          ? { deadline: args.context.deadline }
          : {})
      }
    };

    try {
      const { sessionId, result } = await this.sessionManager.invokeAgent(role, input, {
        invokedByRole: "orchestrator",
        taskChain: [parentTaskId]
      });
      this.delegationsFor(parentTaskId).push({
        role,
        taskId: subTaskId,
        sessionId,
        status: result.status,
        resultSummary: result.resultSummary
      });
      return ok({
        delegatedTo: role,
        taskId: subTaskId,
        sessionId,
        status: result.status,
        resultSummary: truncate(result.resultSummary, 1_500)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`delegation_failed: ${message}`);
    }
  }

  private registerTask(input: {
    taskId: string;
    title: string;
    priority: string;
    dependencies: string[];
  }): OrchestratorTaskRecord {
    const timestamp = this.now().toISOString();
    const record: OrchestratorTaskRecord = {
      taskId: input.taskId,
      title: input.title,
      priority: input.priority,
      status: "running",
      dependencies: input.dependencies,
      notes: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.tasks.set(record.taskId, record);
    return record;
  }

  private updateTaskStatus(taskId: string, status: string, note: string): OrchestratorTaskRecord | undefined {
    const record = this.tasks.get(taskId);
    if (!record) return undefined;
    record.status = status;
    record.updatedAt = this.now().toISOString();
    if (note) record.notes.push(note);
    return record;
  }
}

function ok(payload: Record<string, unknown>): { success: true; content: string } {
  return { success: true, content: JSON.stringify({ ok: true, ...payload }) };
}

function failure(error: string): { success: false; content: string; error: string } {
  return { success: false, content: JSON.stringify({ ok: false, error }), error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
