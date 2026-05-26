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

import { useEffect, useState, useMemo, useCallback } from "react";
import type { LiveTask, LiveAction, LiveArtifact, LiveArtifactBlock } from "./live-tool-types.ts";

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

function TasksColumn({
  tasks,
  activeTaskId,
  onSelect
}: {
  tasks: LiveTask[];
  activeTaskId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside
      className="flex flex-col"
      style={{
        width: 200,
        flexShrink: 0,
        borderRight: "1px solid var(--color-border)",
        background: "var(--color-surface)"
      }}
    >
      <ColHead label="Tareas" />
      <div className="flex flex-col" style={{ padding: 8, gap: 2, overflowY: "auto" }}>
        {tasks.length === 0 ? (
          <span
            className="font-[family-name:var(--font-caption)]"
            style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "8px 10px" }}
          >
            Sin tareas activas.
          </span>
        ) : null}
        {tasks.map((t) => {
          const isActive = t.id === activeTaskId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              className="flex items-center transition-colors"
              style={{
                gap: 10,
                padding: "9px 10px",
                borderRadius: 6,
                background: isActive ? "var(--color-surface-sunken)" : "transparent",
                border: "0.5px solid transparent",
                borderColor: isActive ? "var(--color-border)" : "transparent",
                color: t.status === "idle" ? "var(--color-text-tertiary)" : "var(--color-text-primary)",
                cursor: "pointer",
                textAlign: "left"
              }}
            >
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: pipColor(t.status), flexShrink: 0, animation: t.status === "running" ? "live-pip 1.3s ease-in-out infinite" : "none" }} />
              <span
                className="font-[family-name:var(--font-sans)] truncate"
                style={{ fontSize: 12, fontWeight: isActive ? 500 : 400, lineHeight: 1.3 }}
              >
                {t.title}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
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

function ActionColumn({ action, activeTask }: { action: LiveAction | null; activeTask: LiveTask | null }) {
  const [tab, setTab] = useState<"api" | "files" | "audit">("api");
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
        {(["api", "files", "audit"] as const).map((t) => {
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
              {t === "api" ? "API" : t === "files" ? "Archivos" : "Audit"}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {action == null ? (
          <ActionEmpty tab={tab} activeTask={activeTask} />
        ) : tab === "api" && action.kind === "api" ? (
          <ApiActionView action={action} />
        ) : tab === "files" && action.kind === "file" ? (
          <FileActionView action={action} />
        ) : tab === "audit" && action.kind === "audit" ? (
          <AuditActionView action={action} />
        ) : (
          <ActionEmpty tab={tab} activeTask={activeTask} />
        )}
      </div>
    </section>
  );
}

function ActionEmpty({ tab, activeTask }: { tab: "api" | "files" | "audit"; activeTask: LiveTask | null }) {
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
  return (
    <aside
      className="flex flex-col"
      style={{
        width: 280,
        flexShrink: 0,
        borderLeft: "1px solid var(--color-border)",
        background: "var(--color-surface)"
      }}
    >
      <ColHead label={artifact ? "Plan propuesto · editable" : "Sin propuesta aún"} />
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
            <EditableTitle title={artifact.title} onChange={(t) => onEditBlock("__title__", t)} />
            {artifact.blocks.map((b) => (
              <EditableBlock key={b.id} block={b} onChange={(c) => onEditBlock(b.id, c)} />
            ))}
            {artifact.approvalStatus === "approved" ? (
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

function ApprovalBadge({
  kind,
  meta,
  detail
}: {
  kind: "approved" | "rejected";
  meta: string | null;
  detail: string | null;
}) {
  const isApproved = kind === "approved";
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 6,
        padding: "10px 12px",
        borderRadius: "var(--radius-md)",
        background: isApproved ? "var(--color-success-soft)" : "var(--color-critical-soft)",
        border: `1px solid ${isApproved ? "var(--color-success)" : "var(--color-critical)"}`,
        marginTop: 10
      }}
    >
      <span
        className="font-[family-name:var(--font-sans)] font-semibold"
        style={{ fontSize: 12, color: isApproved ? "var(--color-success)" : "var(--color-critical)" }}
      >
        {isApproved ? "Plan aprobado · en ejecución" : "Plan rechazado"}
      </span>
      {meta ? (
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
        >
          {isApproved ? "por" : "rechazado por"} {meta}
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

function EditableTitle({ title, onChange }: { title: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  const commit = useCallback(() => {
    if (draft !== title) onChange(draft);
  }, [draft, title, onChange]);
  return (
    <div
      role="textbox"
      tabIndex={0}
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => {
        setDraft(e.currentTarget.textContent ?? "");
        commit();
      }}
      onInput={(e) => setDraft((e.currentTarget.textContent ?? ""))}
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
