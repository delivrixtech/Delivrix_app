/**
 * LiveTool — Canvas Live v6, 3 zonas con disciplina herramienta funcional.
 *
 * Layout:
 *   - Sidebar izquierda (200px): tareas activas del agente (Cursor pattern).
 *   - Centro (1fr): Postman view de la API call actual + tabs Archivos / Audit (Manus).
 *   - Derecha (280px): plan/artifact click-to-edit (Lovable).
 *
 * Sin métricas decorativas, sin conclusiones narrativas, sin cards de eventos.
 * Eso vive en chat / Files / audit. Live es herramienta.
 *
 * Backend emite via WSS `/v1/canvas/live/stream` (OPS Codex Bloque 7):
 *   - oc.task.declare / oc.task.update → pueblan sidebar
 *   - oc.action.now → puebla centro (kind: api | file | command)
 *   - oc.artifact.declare + oc.artifact.block + oc.artifact.streaming → pueblan derecha
 *
 * Mientras Codex no entregue el backend, este componente usa un dataset
 * demo importable que simula el flujo de auditoría de los 16 dominios IONOS.
 */

import { useEffect, useState, useCallback } from "react";
import type { LiveTask, LiveAction, LiveArtifact, LiveArtifactBlock } from "./live-tool-types.ts";
import { WorkspaceBrowser } from "./workspace-browser.tsx";

/* ============================================================
 * <LiveTool> — root del 3-pane
 * ============================================================ */

export function LiveTool({
  tasks,
  activeTaskId,
  onSelectTask,
  currentAction,
  artifact,
  onEditBlock,
  onApprove,
  onReject,
  isConnected,
  actionPending
}: {
  tasks: LiveTask[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  currentAction: LiveAction | null;
  artifact: LiveArtifact | null;
  onEditBlock: (blockId: string, content: string) => void;
  onApprove: () => Promise<void> | void;
  onReject: () => Promise<void> | void;
  isConnected: boolean;
  actionPending?: "approve" | "reject" | null;
}) {
  const activeTask = tasks.find((t) => t.id === activeTaskId) ?? null;
  return (
    <div
      className="flex flex-col"
      style={{ flex: 1, minHeight: 0, background: "var(--color-bg)" }}
    >
      <LiveToolHeader task={activeTask} isConnected={isConnected} />
      <div
        className="flex flex-1 min-w-0 min-h-0"
        style={{ borderTop: "1px solid var(--color-border)" }}
      >
        <TasksColumn tasks={tasks} activeTaskId={activeTaskId} onSelect={onSelectTask} />
        <ActionColumn action={currentAction} activeTask={activeTask} />
        <ArtifactColumn
          artifact={artifact}
          onEditBlock={onEditBlock}
          onApprove={onApprove}
          onReject={onReject}
          actionPending={actionPending ?? null}
        />
      </div>
    </div>
  );
}

/* ============================================================
 * Header — breadcrumb + status live/offline
 * ============================================================ */

function LiveToolHeader({ task, isConnected }: { task: LiveTask | null; isConnected: boolean }) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: 10,
        padding: "10px 16px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)"
      }}
    >
      <span
        className="inline-flex items-center"
        style={{
          gap: 6,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: isConnected ? "var(--color-success)" : "var(--color-text-tertiary)",
          fontWeight: 500
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: isConnected ? "var(--color-success)" : "var(--color-text-tertiary)",
            animation: isConnected ? "live-pip 1.4s ease-in-out infinite" : "none"
          }}
        />
        {isConnected ? "live" : "offline"}
      </span>
      <span style={{ fontSize: 13, color: "var(--color-text-primary)", fontWeight: 500 }}>
        {task?.title ?? "Sin tarea activa"}
      </span>
      {task?.subPath ? (
        <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
          / {task.subPath}
        </span>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Sidebar de tareas
 * ============================================================ */

/**
 * Estructura jerárquica de tareas para renderizar padres con sub-tareas
 * anidadas debajo. Soporta el caso multi-agent (Bloque 10 T7C): un task
 * supervisor padre con N sub-tasks corriendo en paralelo.
 */
interface TaskNode extends LiveTask {
  repeatCount: number;
  children: TaskNode[];
}

/**
 * Construye el árbol de tareas: agrupa por parentTaskId, dedup por title
 * dentro de cada nivel, ordena descendente por createdAt.
 *
 * 1) Las tareas raíz (sin parentTaskId) son el nivel 0.
 * 2) Cada una puede tener N children (tareas con parentTaskId apuntando
 *    a la raíz).
 * 3) Dentro de cada nivel, dedupTitle agrupa duplicados consecutivos.
 *    Esto evita el caso "Inventario IONOS ×6" cuando el operador pregunta
 *    lo mismo varias veces.
 */
export function buildTaskTree(tasks: LiveTask[]): TaskNode[] {
  // Index por id para resolver parents rápido
  const byId = new Map<string, LiveTask>();
  for (const t of tasks) byId.set(t.id, t);

  // Agrupar por parentTaskId
  const childrenByParent = new Map<string | null, LiveTask[]>();
  for (const t of tasks) {
    const rawParent = t.parentTaskId ?? null;
    // Re-root orphans: si el padre fue evictado (no está en byId), tratar como raíz.
    const parent = rawParent !== null && byId.has(rawParent) ? rawParent : null;
    const arr = childrenByParent.get(parent);
    if (arr) arr.push(t);
    else childrenByParent.set(parent, [t]);
  }

  function dedupAndSort(list: LiveTask[]): Array<{ task: LiveTask; repeatCount: number }> {
    const groups = new Map<string, LiveTask[]>();
    for (const t of list) {
      const arr = groups.get(t.title);
      if (arr) arr.push(t);
      else groups.set(t.title, [t]);
    }
    const out: Array<{ task: LiveTask; repeatCount: number }> = [];
    for (const items of groups.values()) {
      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      out.push({ task: items[0], repeatCount: items.length });
    }
    out.sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt));
    return out;
  }

  function buildNode(taskId: string, repeatCount: number): TaskNode {
    const task = byId.get(taskId);
    if (!task) {
      // No debería pasar; defensivo.
      return {
        id: taskId,
        title: "(desconocida)",
        status: "idle",
        createdAt: new Date(0).toISOString(),
        actorId: "",
        repeatCount,
        children: []
      };
    }
    const rawChildren = childrenByParent.get(taskId) ?? [];
    const dedupedChildren = dedupAndSort(rawChildren);
    return {
      ...task,
      repeatCount,
      children: dedupedChildren.map((c) => buildNode(c.task.id, c.repeatCount))
    };
  }

  const roots = dedupAndSort(childrenByParent.get(null) ?? []);
  return roots.map((r) => buildNode(r.task.id, r.repeatCount));
}

function taskStatusLabel(status: LiveTask["status"]): string {
  switch (status) {
    case "running":
      return "en curso";
    case "awaiting_approval":
      return "esperando";
    case "completed":
      return "completada";
    case "failed":
      return "fallida";
    case "idle":
    default:
      return "inactiva";
  }
}

function relativeTimeShort(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function TasksColumn({
  tasks,
  activeTaskId,
  onSelect
}: {
  tasks: LiveTask[];
  activeTaskId: string | null;
  onSelect: (id: string) => void;
}) {
  const tree = buildTaskTree(tasks);
  const totalShown = tree.length + tree.reduce((acc, n) => acc + countDescendants(n), 0);
  return (
    <aside
      className="flex flex-col"
      style={{
        width: 240,
        flexShrink: 0,
        borderRight: "1px solid var(--color-border)",
        background: "var(--color-surface)"
      }}
    >
      <ColHead label={`Tareas · ${totalShown}`} />
      <div className="flex flex-col" style={{ padding: 8, gap: 4, overflowY: "auto" }}>
        {tree.length === 0 ? (
          <span
            className="font-[family-name:var(--font-caption)]"
            style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "8px 10px", lineHeight: 1.5 }}
          >
            Sin tareas activas. Cuando el agente arranque, aparece acá.
          </span>
        ) : null}
        {tree.map((node) => (
          <TaskNodeRow
            key={node.id}
            node={node}
            level={0}
            activeTaskId={activeTaskId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}

function countDescendants(node: TaskNode): number {
  let count = node.children.length;
  for (const child of node.children) {
    count += countDescendants(child);
  }
  return count;
}

/**
 * Renderer recursivo de un nodo de tarea + sus hijos anidados.
 * Indent visual 14px por nivel + línea vertical conectando padre con hijos.
 */
function TaskNodeRow({
  node,
  level,
  activeTaskId,
  onSelect
}: {
  node: TaskNode;
  level: number;
  activeTaskId: string | null;
  onSelect: (id: string) => void;
}) {
  const isActive = node.id === activeTaskId;
  const isRunning = node.status === "running";
  const isIdle = node.status === "idle";
  const hasChildren = node.children.length > 0;
  const indentLeft = level * 14;
  return (
    <div className="flex flex-col" style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className="flex flex-col transition-colors"
        style={{
          gap: 4,
          padding: "9px 10px",
          paddingLeft: 10 + indentLeft,
          borderRadius: 8,
          background: isActive ? "var(--color-surface-sunken)" : "transparent",
          border: "0.5px solid",
          borderColor: isActive ? "var(--color-border-strong, var(--color-border))" : "transparent",
          cursor: "pointer",
          textAlign: "left",
          position: "relative"
        }}
      >
        {/* Línea vertical conectora del padre al hijo */}
        {level > 0 ? (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: indentLeft - 6,
              top: 0,
              bottom: "50%",
              width: 1,
              background: "var(--color-border)"
            }}
          />
        ) : null}
        {level > 0 ? (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: indentLeft - 6,
              top: "50%",
              width: 8,
              height: 1,
              background: "var(--color-border)"
            }}
          />
        ) : null}
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: pipColor(node.status),
              flexShrink: 0,
              animation: isRunning ? "live-pip 1.3s ease-in-out infinite" : "none"
            }}
          />
          <span
            className="font-[family-name:var(--font-sans)] truncate"
            style={{
              fontSize: level === 0 ? 12.5 : 11.5,
              fontWeight: isActive ? 500 : 400,
              lineHeight: 1.3,
              color: isIdle ? "var(--color-text-tertiary)" : "var(--color-text-primary)",
              flex: 1,
              minWidth: 0
            }}
          >
            {node.title}
          </span>
          {hasChildren ? (
            <span
              className="font-[family-name:var(--font-mono)]"
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 999,
                background: "var(--color-info-soft)",
                color: "var(--color-info)",
                fontWeight: 500
              }}
              title={`${node.children.length} sub-tareas en paralelo`}
            >
              {node.children.length} sub
            </span>
          ) : null}
          {node.repeatCount > 1 ? (
            <span
              className="font-[family-name:var(--font-mono)]"
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 999,
                background: "var(--color-surface-sunken)",
                color: "var(--color-text-tertiary)",
                fontWeight: 500
              }}
            >
              ×{node.repeatCount}
            </span>
          ) : null}
        </div>
        <div
          className="flex items-center font-[family-name:var(--font-mono)]"
          style={{
            gap: 6,
            fontSize: 10,
            color: "var(--color-text-tertiary)",
            paddingLeft: 14
          }}
        >
          <span style={{ color: pipColor(node.status), fontWeight: 500 }}>{taskStatusLabel(node.status)}</span>
          <span aria-hidden="true">·</span>
          <span>hace {relativeTimeShort(node.createdAt)}</span>
        </div>
      </button>
      {hasChildren ? (
        <div className="flex flex-col" style={{ gap: 4, marginTop: 4, position: "relative" }}>
          {node.children.map((child) => (
            <TaskNodeRow
              key={child.id}
              node={child}
              level={level + 1}
              activeTaskId={activeTaskId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function pipColor(status: LiveTask["status"]): string {
  switch (status) {
    case "running":
      return "var(--color-success)";
    case "awaiting_approval":
      return "var(--color-warning)";
    case "failed":
      return "var(--color-critical)";
    case "completed":
      return "var(--color-accent-tertiary)";
    case "idle":
    default:
      return "var(--color-text-tertiary)";
  }
}

/* ============================================================
 * Postman view — centro
 * ============================================================ */

type ActionTab = "api" | "files" | "commands" | "audit";

function ActionColumn({ action, activeTask }: { action: LiveAction | null; activeTask: LiveTask | null }) {
  const [tab, setTab] = useState<ActionTab>("api");
  return (
    <section
      className="flex flex-col"
      style={{ flex: 1, minWidth: 0, background: "var(--color-bg)" }}
    >
      <div
        className="flex items-center"
        style={{
          padding: "0 14px",
          background: "var(--color-surface)",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        {(["api", "files", "commands", "audit"] as const).map((t) => {
          const isActive = tab === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="font-[family-name:var(--font-mono)]"
              style={{
                fontSize: 11,
                padding: "10px 14px",
                color: isActive ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
                borderBottom: isActive ? "1.5px solid var(--color-text-primary)" : "1.5px solid transparent",
                background: "transparent",
                fontWeight: isActive ? 500 : 400,
                cursor: "pointer"
              }}
            >
              {t === "api" ? "API" : t === "files" ? "Archivos" : t === "commands" ? "Comandos" : "Audit"}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {tab === "files" ? (
          <FilesTabView action={action} />
        ) : action == null ? (
          <ActionEmpty tab={tab} activeTask={activeTask} />
        ) : tab === "api" && action.kind === "api" ? (
          <ApiActionView action={action} />
        ) : tab === "commands" && action.kind === "command" ? (
          <CommandActionView action={action} />
        ) : tab === "audit" && action.kind === "audit" ? (
          <AuditActionView action={action} />
        ) : (
          <ActionEmpty tab={tab} activeTask={activeTask} />
        )}
      </div>
    </section>
  );
}

function ActionEmpty({ tab, activeTask }: { tab: ActionTab; activeTask: LiveTask | null }) {
  const isRunning = activeTask?.status === "running";
  const taskTitle = activeTask?.title ?? null;

  let label: string;
  if (!activeTask) {
    label = "Selecciona una tarea en el panel izquierdo para ver lo que el agente está haciendo.";
  } else if (!isRunning) {
    label =
      taskTitle != null
        ? `La tarea "${taskTitle}" está en estado ${activeTask.status}. No hay actividad en curso.`
        : `Esta tarea está en estado ${activeTask.status}. No hay actividad en curso.`;
  } else {
    label =
      tab === "api"
        ? "El agente está activo pero todavía no hizo ningún GET/POST a un servicio externo. Aparece acá apenas haga una request."
        : tab === "files"
          ? "El agente no ha leído ni escrito archivos en esta tarea todavía."
          : tab === "commands"
            ? "El agente no ha ejecutado comandos para esta tarea todavía."
            : "Sin eventos de audit emitidos por esta tarea aún.";
  }
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ flex: 1, padding: 40, gap: 10, color: "var(--color-text-tertiary)", textAlign: "center" }}
    >
      <span
        className="font-[family-name:var(--font-sans)]"
        style={{ fontSize: 13, maxWidth: 380, lineHeight: 1.55 }}
      >
        {label}
      </span>
    </div>
  );
}

export function CommandActionView({ action }: { action: Extract<LiveAction, { kind: "command" }> }) {
  const isSuccess = action.exitCode === 0;
  return (
    <div className="flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="flex items-center"
        style={{ padding: "16px 18px 12px", gap: 10 }}
      >
        <span
          className="font-[family-name:var(--font-mono)] font-semibold"
          style={{
            padding: "3px 10px",
            borderRadius: 4,
            background: isSuccess ? "var(--color-success-soft)" : "var(--color-critical-soft)",
            color: isSuccess ? "var(--color-success)" : "var(--color-critical)",
            fontSize: 11
          }}
        >
          exit {action.exitCode}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] truncate"
          style={{ fontSize: 13, color: "var(--color-text-primary)", flex: 1, minWidth: 0 }}
          title={action.cmd}
        >
          {action.cmd}
        </span>
      </div>
      <div
        className="flex items-center"
        style={{
          padding: "0 18px 14px",
          gap: 18,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-secondary)",
          borderBottom: "1px solid var(--color-border)",
          marginBottom: 14,
          paddingBottom: 14
        }}
      >
        <span style={{ color: isSuccess ? "var(--color-success)" : "var(--color-critical)", fontWeight: 500 }}>
          {isSuccess ? "completado" : "falló"}
        </span>
        <span>{(action.durationMs / 1000).toFixed(2)}s</span>
        <span>hace {relativeTimeShort(action.occurredAt)}</span>
      </div>
      <div className="flex flex-col" style={{ padding: "0 18px 18px", gap: 10 }}>
        <CommandOutputBlock label="stdout" value={action.stdout} />
        <CommandOutputBlock label="stderr" value={action.stderr} tone="critical" />
      </div>
    </div>
  );
}

function CommandOutputBlock({
  label,
  value,
  tone = "neutral"
}: {
  label: string;
  value?: string;
  tone?: "neutral" | "critical";
}) {
  if (!value) return null;
  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <span
        className="font-[family-name:var(--font-caption)] font-semibold uppercase"
        style={{
          fontSize: 9.5,
          letterSpacing: "0.6px",
          color: tone === "critical" ? "var(--color-critical)" : "var(--color-text-tertiary)"
        }}
      >
        {label}
      </span>
      <pre
        className="font-[family-name:var(--font-mono)]"
        style={{
          fontSize: 12,
          lineHeight: 1.7,
          color: "var(--color-text-primary)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-sm)",
          padding: "12px 14px",
          margin: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowX: "auto"
        }}
      >
        {value}
      </pre>
    </div>
  );
}

function ApiActionView({ action }: { action: Extract<LiveAction, { kind: "api" }> }) {
  const methodColor = methodTone(action.method);
  return (
    <div className="flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="flex items-center"
        style={{ padding: "16px 18px 12px", gap: 10 }}
      >
        <span
          className="font-[family-name:var(--font-mono)] font-semibold"
          style={{
            padding: "3px 10px",
            borderRadius: 4,
            background: methodColor.bg,
            color: methodColor.fg,
            fontSize: 11
          }}
        >
          {action.method}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] truncate"
          style={{ fontSize: 13, color: "var(--color-text-primary)", flex: 1, minWidth: 0 }}
        >
          {action.url}
        </span>
      </div>
      <div
        className="flex items-center"
        style={{
          padding: "0 18px 14px",
          gap: 18,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-secondary)",
          borderBottom: "1px solid var(--color-border)",
          marginBottom: 14,
          paddingBottom: 14
        }}
      >
        <span style={{ color: statusColor(action.status), fontWeight: 500 }}>
          {action.status} {statusLabel(action.status)}
        </span>
        <span>{(action.durationMs / 1000).toFixed(2)}s</span>
        {action.cache ? <span>{action.cache}</span> : null}
        {action.responseBytes != null ? <span>response {formatBytes(action.responseBytes)}</span> : null}
      </div>
      <div style={{ padding: "0 18px 18px" }}>
        <pre
          className="font-[family-name:var(--font-mono)]"
          style={{
            fontSize: 12,
            lineHeight: 1.7,
            color: "var(--color-text-primary)",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            padding: "12px 14px",
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowX: "auto"
          }}
        >
          {renderJson(action.responseBody)}
        </pre>
      </div>
      {action.next ? (
        <div
          className="flex items-center"
          style={{
            margin: "0 18px 18px",
            padding: "10px 14px",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            gap: 8,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--color-text-tertiary)"
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: "var(--color-info)",
              animation: "live-pip 1.3s ease-in-out infinite"
            }}
          />
          siguiente: {action.next.method} {action.next.url}
          {action.next.context ? ` · ${action.next.context}` : ""}
        </div>
      ) : null}
    </div>
  );
}

/**
 * FilesTabView — tab Archivos del centro.
 *
 * Composición:
 *   - Strip superior con la última file action del agente (si la hay).
 *   - WorkspaceBrowser ocupando el resto del alto: árbol persistente
 *     /data/.openclaw/workspace + preview de archivo seleccionado.
 *
 * Acto 2 de la demo viernes: el operador abre este tab y muestra que el
 * agente RECUERDA — cada ejecución dejó rastro, cada falla generó lesson,
 * el inventory tiene el estado actual del mundo según OpenClaw.
 */
function FilesTabView({ action }: { action: LiveAction | null }) {
  const fileAction = action?.kind === "file" ? action : null;
  return (
    <div className="flex flex-col" style={{ flex: 1, minHeight: 0 }}>
      {fileAction ? (
        <div
          style={{
            padding: "8px 14px",
            background: "var(--color-surface)",
            borderBottom: "1px solid var(--color-border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0
          }}
        >
          <span
            className="font-[family-name:var(--font-caption)] font-semibold uppercase"
            style={{
              fontSize: 9.5,
              letterSpacing: "0.6px",
              color: "var(--color-text-tertiary)"
            }}
          >
            Actividad reciente
          </span>
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{
              fontSize: 10.5,
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--color-accent-tertiary-soft, var(--color-surface-sunken))",
              color: "var(--color-accent-tertiary)",
              fontWeight: 500
            }}
          >
            {fileAction.operation.toUpperCase()}
          </span>
          <span
            className="font-[family-name:var(--font-mono)] truncate"
            style={{ fontSize: 11, color: "var(--color-text-secondary)", flex: 1, minWidth: 0 }}
            title={fileAction.path}
          >
            {fileAction.path}
          </span>
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            hace {relativeTimeShort(fileAction.occurredAt)}
          </span>
        </div>
      ) : null}
      <WorkspaceBrowser />
    </div>
  );
}

function FileActionView({ action }: { action: Extract<LiveAction, { kind: "file" }> }) {
  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="flex items-baseline" style={{ gap: 8 }}>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{
            padding: "3px 10px",
            borderRadius: 4,
            background: "var(--color-accent-tertiary-soft, var(--color-surface-sunken))",
            color: "var(--color-accent-tertiary)",
            fontSize: 11,
            fontWeight: 500
          }}
        >
          {action.operation.toUpperCase()}
        </span>
        <span className="font-[family-name:var(--font-mono)]" style={{ fontSize: 12 }}>
          {action.path}
        </span>
      </div>
      {action.diffSummary ? (
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          {action.diffSummary}
        </span>
      ) : null}
      {action.preview ? (
        <pre
          className="font-[family-name:var(--font-mono)]"
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--color-text-primary)",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            padding: "12px 14px",
            margin: 0,
            whiteSpace: "pre-wrap"
          }}
        >
          {action.preview}
        </pre>
      ) : null}
    </div>
  );
}

function AuditActionView({ action }: { action: Extract<LiveAction, { kind: "audit" }> }) {
  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
      <span
        className="font-[family-name:var(--font-mono)]"
        style={{ fontSize: 13, color: "var(--color-text-primary)", fontWeight: 500 }}
      >
        {action.eventName}
      </span>
      {action.summary ? (
        <span
          className="font-[family-name:var(--font-sans)]"
          style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.55 }}
        >
          {action.summary}
        </span>
      ) : null}
      {action.hashShort ? (
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          hash {action.hashShort}
        </span>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Artifact column — derecha, click-to-edit
 * ============================================================ */

function ArtifactColumn({
  artifact,
  onEditBlock,
  onApprove,
  onReject,
  actionPending
}: {
  artifact: LiveArtifact | null;
  onEditBlock: (blockId: string, content: string) => void;
  onApprove: () => Promise<void> | void;
  onReject: () => Promise<void> | void;
  actionPending: "approve" | "reject" | null;
}) {
  const isReadOnlyArtifact = artifact?.kind === "report" || artifact?.kind === "template";
  return (
    <aside
      className="flex flex-col"
      style={{
        width: 320,
        flexShrink: 0,
        borderLeft: "1px solid var(--color-border)",
        background: "var(--color-surface)"
      }}
    >
      <ColHead label={artifact ? artifactColumnLabel(artifact) : "Sin propuesta aún"} />
      <div className="flex flex-col" style={{ flex: 1, minHeight: 0, padding: 14, gap: 8, overflowY: "auto" }}>
        {artifact == null ? (
          <span
            className="font-[family-name:var(--font-caption)]"
            style={{ fontSize: 11, color: "var(--color-text-tertiary)", textAlign: "center", padding: "20px 10px", lineHeight: 1.55 }}
          >
            Cuando el agente proponga un plan, propuesta o template, aparece aquí — editable bloque por bloque.
          </span>
        ) : (
          <>
            <ArtifactHeader artifact={artifact} />
            {isReadOnlyArtifact ? (
              <ReadOnlyTitle title={artifact.title} />
            ) : (
              <EditableTitle title={artifact.title} onChange={(t) => onEditBlock("__title__", t)} />
            )}
            {artifact.blocks.map((b) =>
              isReadOnlyArtifact ? (
                <ReadOnlyBlock key={b.id} block={b} />
              ) : (
                <EditableBlock key={b.id} block={b} onChange={(c) => onEditBlock(b.id, c)} />
              )
            )}
            {isReadOnlyArtifact ? (
              <ApprovalBadge
                kind="informational"
                meta="read-only"
                detail={
                  artifact.kind === "template"
                    ? "Template informativo; se puede copiar o exportar, no ejecuta acciones."
                    : "Reporte informativo; no requiere aprobación ni ejecuta acciones."
                }
              />
            ) : artifact.approvalStatus === "approved" ? (
              <ApprovalBadge
                kind="approved"
                meta={artifact.approvedBy ?? null}
                detail={artifact.executionId ? `ejecución ${artifact.executionId.slice(0, 12)}` : null}
              />
            ) : artifact.approvalStatus === "rejected" ? (
              <ApprovalBadge
                kind="rejected"
                meta={artifact.rejectedBy ?? null}
                detail={artifact.rejectionReason ?? null}
              />
            ) : (
              <div className="flex" style={{ gap: 6, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => void onReject()}
                  disabled={actionPending != null}
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    fontSize: 12,
                    fontWeight: 500,
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--color-border)",
                    background: "transparent",
                    color: actionPending != null ? "var(--color-text-tertiary)" : "var(--color-text-primary)",
                    cursor: actionPending != null ? "not-allowed" : "pointer",
                    opacity: actionPending === "reject" ? 0.6 : 1,
                    transition: "opacity 120ms ease"
                  }}
                >
                  {actionPending === "reject" ? "Rechazando…" : "Rechazar"}
                </button>
                <button
                  type="button"
                  onClick={() => void onApprove()}
                  disabled={actionPending != null}
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    fontSize: 12,
                    fontWeight: 500,
                    borderRadius: "var(--radius-md)",
                    border: "none",
                    background: "var(--color-text-primary)",
                    color: "var(--color-bg)",
                    cursor: actionPending != null ? "not-allowed" : "pointer",
                    opacity: actionPending != null ? 0.6 : 1,
                    transition: "opacity 120ms ease"
                  }}
                >
                  {actionPending === "approve" ? "Aprobando…" : "Aprobar"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * Header del artifact: kind pill + meta (creado hace X · acciones contextuales).
 * Para reports muestra Pin / Exportar; para plan/proposal lo dejan al footer.
 */
function ArtifactHeader({ artifact }: { artifact: LiveArtifact }) {
  const kindLabel = artifactKindLabel(artifact.kind);
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 6,
        padding: "2px 4px 10px",
        borderBottom: "0.5px solid var(--color-border)",
        marginBottom: 4
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{
            fontSize: 9.5,
            letterSpacing: "0.8px",
            padding: "2px 8px",
            borderRadius: 999,
            background: kindBackground(artifact.kind),
            color: kindForeground(artifact.kind)
          }}
        >
          {kindLabel}
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          hace {relativeTimeShort(artifact.createdAt)}
        </span>
      </div>
      {artifact.kind === "report" || artifact.kind === "template" ? (
        <div className="flex" style={{ gap: 6 }}>
          <button
            type="button"
            onClick={() => {
              try {
                navigator.clipboard.writeText(stringifyArtifact(artifact));
              } catch {
                // no-op
              }
            }}
            style={{
              flex: 1,
              padding: "5px 8px",
              fontSize: 11,
              fontWeight: 500,
              borderRadius: 6,
              border: "0.5px solid var(--color-border)",
              background: "transparent",
              color: "var(--color-text-secondary)",
              cursor: "pointer"
            }}
          >
            {artifact.kind === "template" ? "Copiar template" : "Copiar reporte"}
          </button>
          <button
            type="button"
            onClick={() => downloadArtifact(artifact)}
            style={{
              flex: 1,
              padding: "5px 8px",
              fontSize: 11,
              fontWeight: 500,
              borderRadius: 6,
              border: "0.5px solid var(--color-border)",
              background: "transparent",
              color: "var(--color-text-secondary)",
              cursor: "pointer"
            }}
          >
            Exportar .md
          </button>
        </div>
      ) : null}
    </div>
  );
}

function artifactKindLabel(kind: LiveArtifact["kind"]): string {
  if (kind === "plan") return "Plan";
  if (kind === "proposal") return "Propuesta";
  if (kind === "template") return "Template";
  if (kind === "report") return "Reporte";
  return kind;
}

function kindBackground(kind: LiveArtifact["kind"]): string {
  if (kind === "plan") return "var(--color-info-soft)";
  if (kind === "proposal") return "var(--color-warning-soft)";
  if (kind === "template") return "var(--color-surface-sunken)";
  if (kind === "report") return "var(--color-success-soft)";
  return "var(--color-surface-sunken)";
}

function kindForeground(kind: LiveArtifact["kind"]): string {
  if (kind === "plan") return "var(--color-info)";
  if (kind === "proposal") return "var(--color-warning)";
  if (kind === "template") return "var(--color-text-secondary)";
  if (kind === "report") return "var(--color-success)";
  return "var(--color-text-secondary)";
}

function stringifyArtifact(artifact: LiveArtifact): string {
  const lines = [`# ${artifact.title}`, ""];
  for (const b of artifact.blocks) {
    lines.push(b.content);
    lines.push("");
  }
  return lines.join("\n");
}

function downloadArtifact(artifact: LiveArtifact): void {
  try {
    const blob = new Blob([stringifyArtifact(artifact)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.id || "artifact"}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {
    // no-op
  }
}

function ReadOnlyTitle({ title }: { title: string }) {
  return (
    <div
      className="font-[family-name:var(--font-sans)]"
      style={{
        fontSize: 15,
        fontWeight: 500,
        color: "var(--color-text-primary)",
        padding: "4px 4px 2px",
        letterSpacing: "var(--tracking-tight)"
      }}
    >
      {title}
    </div>
  );
}

function ReadOnlyBlock({ block }: { block: LiveArtifactBlock }) {
  if (block.status === "streaming") {
    return (
      <div
        className="flex items-start"
        style={{
          gap: 10,
          padding: "8px 4px",
          fontSize: 13,
          color: "var(--color-text-tertiary)",
          fontStyle: "italic"
        }}
      >
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          {pad2(block.order)}
        </span>
        <span style={{ flex: 1 }}>
          {block.content}
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 6,
              height: 12,
              background: "var(--color-text-info)",
              verticalAlign: "-2px",
              marginLeft: 3,
              animation: "live-cursor 1s steps(1) infinite"
            }}
          />
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex items-start"
      style={{
        gap: 10,
        padding: "6px 4px",
        borderBottom: "0.5px dashed var(--color-border)"
      }}
    >
      <span
        className="font-[family-name:var(--font-mono)]"
        style={{ fontSize: 11, color: "var(--color-text-tertiary)", paddingTop: 2 }}
      >
        {pad2(block.order)}
      </span>
      <span
        className="font-[family-name:var(--font-sans)]"
        style={{
          fontSize: 13,
          color: "var(--color-text-primary)",
          lineHeight: 1.55,
          flex: 1,
          whiteSpace: "pre-wrap"
        }}
      >
        {block.content}
      </span>
    </div>
  );
}

function ApprovalBadge({
  kind,
  meta,
  detail
}: {
  kind: "approved" | "rejected" | "informational";
  meta: string | null;
  detail: string | null;
}) {
  const isApproved = kind === "approved";
  const isInfo = kind === "informational";
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 6,
        padding: "10px 12px",
        borderRadius: "var(--radius-md)",
        background: isInfo ? "var(--color-info-soft)" : isApproved ? "var(--color-success-soft)" : "var(--color-critical-soft)",
        border: `1px solid ${isInfo ? "var(--color-info)" : isApproved ? "var(--color-success)" : "var(--color-critical)"}`,
        marginTop: 10
      }}
    >
      <span
        className="font-[family-name:var(--font-sans)] font-semibold"
        style={{ fontSize: 12, color: isInfo ? "var(--color-info)" : isApproved ? "var(--color-success)" : "var(--color-critical)" }}
      >
        {isInfo ? "Reporte read-only" : isApproved ? "Plan aprobado · en ejecución" : "Plan rechazado"}
      </span>
      {meta ? (
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
        >
          {isInfo ? "modo" : isApproved ? "por" : "rechazado por"} {meta}
        </span>
      ) : null}
      {detail ? (
        <span
          className="font-[family-name:var(--font-caption)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}
        >
          {detail}
        </span>
      ) : null}
    </div>
  );
}

function artifactColumnLabel(artifact: LiveArtifact): string {
  if (artifact.kind === "report") return "Reporte · read-only";
  if (artifact.kind === "template") return "Template · read-only";
  if (artifact.kind === "proposal") return "Propuesta · editable";
  return "Plan propuesto · editable";
}

export function commitEditableTitleText(
  textContent: string | null,
  title: string,
  onChange: (v: string) => void
): string {
  const nextDraft = textContent ?? "";
  if (nextDraft !== title) onChange(nextDraft);
  return nextDraft;
}

function EditableTitle({ title, onChange }: { title: string; onChange: (v: string) => void }) {
  const [, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  const commit = useCallback((nextDraft: string | null) => {
    setDraft(commitEditableTitleText(nextDraft, title, onChange));
  }, [title, onChange]);
  return (
    <div
      role="textbox"
      tabIndex={0}
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => {
        commit(e.currentTarget.textContent);
      }}
      onInput={(e) => setDraft(e.currentTarget.textContent ?? "")}
      className="font-[family-name:var(--font-sans)]"
      style={{
        fontSize: 15,
        fontWeight: 500,
        color: "var(--color-text-primary)",
        padding: "8px 10px",
        border: "1px solid transparent",
        borderRadius: 6,
        cursor: "text",
        outline: "none"
      }}
      onFocus={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
    >
      {title}
    </div>
  );
}

function EditableBlock({ block, onChange }: { block: LiveArtifactBlock; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(block.content);
  useEffect(() => setDraft(block.content), [block.content]);
  if (block.status === "streaming") {
    return (
      <div
        className="flex items-start"
        style={{
          gap: 10,
          padding: "10px 12px",
          fontSize: 13,
          color: "var(--color-text-tertiary)",
          fontStyle: "italic",
          border: "1px solid transparent",
          borderRadius: 6
        }}
      >
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          {pad2(block.order)}
        </span>
        <span style={{ flex: 1 }}>
          {block.content}
          <span
            aria-hidden="true"
            style={{ display: "inline-block", width: 6, height: 12, background: "var(--color-text-info)", verticalAlign: "-2px", marginLeft: 3, animation: "live-cursor 1s steps(1) infinite" }}
          />
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex items-start"
      style={{
        gap: 10,
        padding: "10px 12px",
        border: "1px solid transparent",
        borderRadius: 6,
        background: "transparent",
        cursor: "text"
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
    >
      <span
        className="font-[family-name:var(--font-mono)]"
        style={{ fontSize: 11, color: "var(--color-text-tertiary)", paddingTop: 1 }}
      >
        {pad2(block.order)}
      </span>
      <span
        role="textbox"
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => {
          const next = e.currentTarget.textContent ?? "";
          setDraft(next);
          if (next !== block.content) onChange(next);
        }}
        onInput={(e) => setDraft(e.currentTarget.textContent ?? "")}
        className="font-[family-name:var(--font-sans)]"
        style={{
          fontSize: 13,
          color: "var(--color-text-primary)",
          lineHeight: 1.5,
          flex: 1,
          outline: "none"
        }}
      >
        {block.content}
      </span>
    </div>
  );
}

/* ============================================================
 * Primitives
 * ============================================================ */

function ColHead({ label }: { label: string }) {
  return (
    <div
      className="font-[family-name:var(--font-caption)]"
      style={{
        padding: "10px 14px",
        fontSize: 11,
        color: "var(--color-text-tertiary)",
        textTransform: "uppercase",
        letterSpacing: "0.6px",
        fontWeight: 500,
        borderBottom: "1px solid var(--color-border)"
      }}
    >
      {label}
    </div>
  );
}

function methodTone(method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH") {
  if (method === "GET") return { bg: "var(--color-success-soft)", fg: "var(--color-success)" };
  if (method === "POST") return { bg: "var(--color-info-soft)", fg: "var(--color-info)" };
  if (method === "PUT" || method === "PATCH") return { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" };
  return { bg: "var(--color-critical-soft)", fg: "var(--color-critical)" };
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return "var(--color-success)";
  if (status >= 400 && status < 500) return "var(--color-warning)";
  if (status >= 500) return "var(--color-critical)";
  return "var(--color-text-tertiary)";
}

function statusLabel(status: number): string {
  if (status === 200) return "OK";
  if (status === 201) return "Created";
  if (status === 204) return "No Content";
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 429) return "Too Many Requests";
  if (status >= 500) return "Server Error";
  return "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function renderJson(value: unknown, indent = 0): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = value.map((v) => "  ".repeat(indent + 1) + renderJson(v, indent + 1)).join(",\n");
    return `[\n${inner}\n${"  ".repeat(indent)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const inner = entries
      .map(([k, v]) => `${"  ".repeat(indent + 1)}"${k}": ${renderJson(v, indent + 1)}`)
      .join(",\n");
    return `{\n${inner}\n${"  ".repeat(indent)}}`;
  }
  return String(value);
}
