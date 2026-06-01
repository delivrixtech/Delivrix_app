/**
 * canvas-live-client — conecta el LiveTool al backend Bloque 7 (commit 91d3643).
 *
 * Responsabilidades:
 *   1. Cargar snapshot inicial via GET /v1/canvas/live/state.
 *   2. Abrir WSS /v1/canvas/live/stream y aplicar eventos incrementales.
 *   3. Exponer approve/reject/patchBlock que llaman al gateway.
 *   4. Adaptar el shape del contract canónico (packages/domain/src/canvas-live.ts)
 *      al shape interno del LiveTool (live-tool-types.ts).
 *
 * El LiveTool permanece desacoplado: si el contract de Codex cambia, solo
 * tocamos los adapters acá.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CanvasLiveActionNowEventWire,
  CanvasLiveArtifactSnapshotWire,
  CanvasLiveEventWire,
  CanvasLiveStateSnapshotWire,
  CanvasLiveTaskSnapshotWire,
  LiveAction,
  LiveArtifact,
  LiveArtifactBlock,
  LiveTask
} from "./live-tool-types.ts";

const STATE_ENDPOINT = "/v1/canvas/live/state";
const STREAM_PATH = "/v1/canvas/live/stream";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const SNAPSHOT_POLL_MS = 5_000;

export type LiveConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface UseLiveCanvasStreamResult {
  tasks: LiveTask[];
  activeTaskId: string | null;
  setActiveTaskId: (id: string) => void;
  currentAction: LiveAction | null;
  artifact: LiveArtifact | null;
  connection: LiveConnectionStatus;
  lastError: string | null;
  approveArtifact: () => Promise<void>;
  rejectArtifact: (reason?: string) => Promise<void>;
  patchBlock: (blockId: string, content: string) => Promise<void>;
}

interface InternalState {
  tasks: Map<string, LiveTask>;
  /** lastAction por task. */
  lastAction: Map<string, LiveAction>;
  artifacts: Map<string, LiveArtifact>;
  /** índice artifactId → taskId para resolver active artifact. */
  artifactToTask: Map<string, string>;
}

function emptyState(): InternalState {
  return {
    tasks: new Map(),
    lastAction: new Map(),
    artifacts: new Map(),
    artifactToTask: new Map()
  };
}

function pickPreferredTaskId(state: InternalState, currentTaskId: string | null): string | null {
  if (currentTaskId && state.tasks.has(currentTaskId)) {
    return currentTaskId;
  }

  const tasks = [...state.tasks.values()];
  const latestByCreatedAt = (items: LiveTask[]) =>
    [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;

  const running = latestByCreatedAt(tasks.filter((task) => task.status === "running"));
  if (running) return running.id;

  const taskIdsWithArtifacts = new Set([...state.artifacts.values()].map((artifact) => artifact.taskId));
  const withArtifact = latestByCreatedAt(tasks.filter((task) => taskIdsWithArtifacts.has(task.id)));
  if (withArtifact) return withArtifact.id;

  const taskIdsWithActions = new Set(state.lastAction.keys());
  const withAction = latestByCreatedAt(tasks.filter((task) => taskIdsWithActions.has(task.id)));
  if (withAction) return withAction.id;

  return latestByCreatedAt(tasks)?.id ?? null;
}

function firstDefined<T>(items: Array<T | null | undefined>): T | null {
  for (const item of items) {
    if (item != null) return item;
  }
  return null;
}

export function useLiveCanvasStream(enabled: boolean): UseLiveCanvasStreamResult {
  const [tick, setTick] = useState(0);
  const stateRef = useRef<InternalState>(emptyState());
  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const [connection, setConnection] = useState<LiveConnectionStatus>("offline");
  const [lastError, setLastError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const snapshotPollTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const cancelledRef = useRef(false);

  const forceRender = useCallback(() => setTick((n) => (n + 1) % 1_000_000), []);

  /* -------- Conexión + snapshot inicial -------- */
  useEffect(() => {
    if (!enabled) {
      cancelledRef.current = true;
      cleanup();
      stateRef.current = emptyState();
      setConnection("offline");
      activeTaskIdRef.current = null;
      setActiveTaskIdState(null);
      forceRender();
      return;
    }
    cancelledRef.current = false;
    void loadSnapshotThenStream();
    snapshotPollTimerRef.current = window.setInterval(() => {
      void pollSnapshot();
    }, SNAPSHOT_POLL_MS);
    return () => {
      cancelledRef.current = true;
      cleanup();
    };

    function cleanup() {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (snapshotPollTimerRef.current != null) {
        window.clearInterval(snapshotPollTimerRef.current);
        snapshotPollTimerRef.current = null;
      }
      if (socketRef.current) {
        try {
          socketRef.current.close();
        } catch {
          // noop
        }
        socketRef.current = null;
      }
    }

    async function loadSnapshotThenStream() {
      try {
        setConnection("connecting");
        const payload = await fetchSnapshot();
        if (cancelledRef.current) return;
        applySnapshot(payload);
      } catch (err) {
        if (cancelledRef.current) return;
        setLastError(err instanceof Error ? err.message : "snapshot fetch error");
        setConnection("reconnecting");
        scheduleReconnect();
        return;
      }
      openSocket();
    }

    async function pollSnapshot() {
      try {
        const payload = await fetchSnapshot();
        if (cancelledRef.current) return;
        applySnapshot(payload);
        setLastError(null);
      } catch (err) {
        if (cancelledRef.current) return;
        setLastError(err instanceof Error ? err.message : "snapshot poll error");
      }
    }

    async function fetchSnapshot(): Promise<CanvasLiveStateSnapshotWire> {
      const res = await fetch(STATE_ENDPOINT, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!res.ok) {
        throw new Error(`GET ${STATE_ENDPOINT} failed (${res.status})`);
      }
      return (await res.json()) as CanvasLiveStateSnapshotWire;
    }

    function applySnapshot(snapshot: CanvasLiveStateSnapshotWire) {
      const next = emptyState();
      for (const t of snapshot.tasks) {
        next.tasks.set(t.taskId, taskFromSnapshot(t));
        if (t.lastAction) {
          const action = adaptAction(t.lastAction);
          if (action) next.lastAction.set(t.taskId, action);
        }
      }
      for (const a of snapshot.artifacts) {
        next.artifacts.set(a.artifactId, artifactFromSnapshot(a));
        next.artifactToTask.set(a.artifactId, a.taskId);
      }
      stateRef.current = next;
      const preferredTaskId = pickPreferredTaskId(next, activeTaskIdRef.current);
      if (preferredTaskId !== activeTaskIdRef.current) {
        activeTaskIdRef.current = preferredTaskId;
        setActiveTaskIdState(preferredTaskId);
      }
      forceRender();
    }

    function openSocket() {
      try {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${protocol}//${window.location.host}${STREAM_PATH}`;
        const ws = new WebSocket(url);
        socketRef.current = ws;
        ws.addEventListener("open", () => {
          if (cancelledRef.current) return;
          setConnection("connected");
          setLastError(null);
          reconnectAttemptsRef.current = 0;
        });
        ws.addEventListener("message", (ev) => {
          if (cancelledRef.current) return;
          try {
            const event = JSON.parse(typeof ev.data === "string" ? ev.data : "{}") as CanvasLiveEventWire;
            applyEvent(event);
          } catch {
            // ignore malformed frame
          }
        });
        ws.addEventListener("close", () => {
          if (cancelledRef.current) return;
          setConnection("reconnecting");
          scheduleReconnect();
        });
        ws.addEventListener("error", () => {
          if (cancelledRef.current) return;
          setLastError("WSS error");
        });
      } catch (err) {
        setLastError(err instanceof Error ? err.message : "WSS open error");
        setConnection("reconnecting");
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (cancelledRef.current) return;
      const attempt = (reconnectAttemptsRef.current += 1);
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      reconnectTimerRef.current = window.setTimeout(() => {
        if (cancelledRef.current) return;
        void loadSnapshotThenStream();
      }, delay);
    }

    function applyEvent(event: CanvasLiveEventWire) {
      const s = stateRef.current;
      switch (event.type) {
        case "oc.task.declare": {
          s.tasks.set(event.taskId, {
            id: event.taskId,
            title: event.title,
            status: event.status,
            createdAt: event.createdAt,
            actorId: event.actorId,
            // Bloque 10 T7C/T8: si viene del supervisor multi-agent, parentTaskId
            // apunta al supervisor padre; el sidebar lo renderea anidado.
            parentTaskId: event.parentTaskId ?? null
          });
          const activeTask = activeTaskIdRef.current ? s.tasks.get(activeTaskIdRef.current) ?? null : null;
          if (event.status === "running" && (!activeTask || activeTask.status !== "running")) {
            activeTaskIdRef.current = event.taskId;
            setActiveTaskIdState(event.taskId);
          }
          break;
        }
        case "oc.task.update": {
          const existing = s.tasks.get(event.taskId);
          if (existing) {
            s.tasks.set(event.taskId, { ...existing, status: event.status });
          }
          if (activeTaskIdRef.current === event.taskId && event.status !== "running") {
            const preferredTaskId = pickPreferredTaskId(s, null);
            if (preferredTaskId !== activeTaskIdRef.current) {
              activeTaskIdRef.current = preferredTaskId;
              setActiveTaskIdState(preferredTaskId);
            }
          }
          break;
        }
        case "oc.action.now": {
          const action = adaptAction(event);
          if (action) s.lastAction.set(event.taskId, action);
          break;
        }
        case "oc.artifact.declare": {
          s.artifacts.set(event.artifactId, {
            id: event.artifactId,
            taskId: event.taskId,
            kind: event.kind,
            title: event.title,
            editable: event.editable,
            createdAt: event.createdAt,
            approvalStatus: "pending",
            blocks: []
          });
          s.artifactToTask.set(event.artifactId, event.taskId);
          break;
        }
        case "oc.artifact.block": {
          const art = s.artifacts.get(event.artifactId);
          if (!art) break;
          const idx = art.blocks.findIndex((b) => b.id === event.blockId);
          const block: LiveArtifactBlock = {
            id: event.blockId,
            order: event.order,
            kind: event.kind,
            content: event.content,
            editable: event.editable,
            status: event.status
          };
          if (idx === -1) art.blocks = [...art.blocks, block];
          else {
            art.blocks = [...art.blocks];
            art.blocks[idx] = block;
          }
          art.blocks.sort((a, b) => a.order - b.order);
          break;
        }
        case "oc.artifact.streaming": {
          const art = s.artifacts.get(event.artifactId);
          if (!art) break;
          const idx = art.blocks.findIndex((b) => b.id === event.blockId);
          if (idx === -1) break;
          const prev = art.blocks[idx];
          art.blocks = [...art.blocks];
          art.blocks[idx] = {
            ...prev,
            content: prev.content + event.chunk,
            status: "streaming"
          };
          break;
        }
        default:
          break;
      }
      forceRender();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  /* -------- Lectura derivada -------- */
  const tasks = [...stateRef.current.tasks.values()];
  const activeTask = activeTaskId ? stateRef.current.tasks.get(activeTaskId) ?? null : null;
  const relatedTaskIds = activeTask
    ? [
        activeTask.id,
        ...tasks
          .filter((task) => task.title === activeTask.title && task.id !== activeTask.id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((task) => task.id)
      ]
    : activeTaskId
      ? [activeTaskId]
      : [];
  const currentAction = firstDefined(
    relatedTaskIds.map((taskId) => stateRef.current.lastAction.get(taskId) ?? null)
  );
  // Artifact activo: el último artifact del task activo o de su grupo visual.
  const artifact = activeTaskId
    ? ([...stateRef.current.artifacts.values()]
        .filter((a) => relatedTaskIds.includes(a.taskId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null)
    : null;

  // Importante: leemos `tick` para que React re-renderee cuando cambia.
  void tick;

  /* -------- Acciones -------- */
  const approveArtifact = useCallback(async () => {
    if (!artifact) return;
    const body = {
      actorId: getActorId(),
      blocks: artifact.blocks.map((b) => ({ blockId: b.id, content: b.content }))
    };
    const res = await fetch(`/v1/canvas/artifact/${artifact.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`approve failed (${res.status}) ${msg}`);
    }
    const payload = (await res.json().catch(() => ({}))) as { executionId?: string };
    const existing = stateRef.current.artifacts.get(artifact.id) ?? artifact;
    stateRef.current.artifacts.set(artifact.id, {
      ...existing,
      approvalStatus: "approved",
      approvedBy: body.actorId,
      approvedAt: new Date().toISOString(),
      executionId: payload.executionId
    });
    setLastError(null);
    forceRender();
  }, [artifact, forceRender]);

  const rejectArtifact = useCallback(
    async (reason?: string) => {
      if (!artifact) return;
      const body = { actorId: getActorId(), reason: reason ?? "operador rechazó" };
      const res = await fetch(`/v1/canvas/artifact/${artifact.id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(`reject failed (${res.status}) ${msg}`);
      }
      const existing = stateRef.current.artifacts.get(artifact.id) ?? artifact;
      stateRef.current.artifacts.set(artifact.id, {
        ...existing,
        approvalStatus: "rejected",
        rejectedBy: body.actorId,
        rejectedAt: new Date().toISOString(),
        rejectionReason: body.reason
      });
      setLastError(null);
      forceRender();
    },
    [artifact, forceRender]
  );

  const patchBlock = useCallback(
    async (blockId: string, content: string) => {
      if (!artifact) return;
      const body = { actorId: getActorId(), content };
      const res = await fetch(`/v1/canvas/artifact/${artifact.id}/block/${blockId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(`patch block failed (${res.status}) ${msg}`);
      }
    },
    [artifact]
  );

  const setActiveTaskId = useCallback((id: string) => {
    activeTaskIdRef.current = id;
    setActiveTaskIdState(id);
  }, []);

  return {
    tasks,
    activeTaskId,
    setActiveTaskId,
    currentAction,
    artifact,
    connection,
    lastError,
    approveArtifact,
    rejectArtifact,
    patchBlock
  };
}

/* ============================================================
 * Adapters: Codex shape → LiveTool shape
 * ============================================================ */

function taskFromSnapshot(t: CanvasLiveTaskSnapshotWire): LiveTask {
  return {
    id: t.taskId,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    actorId: t.actorId,
    parentTaskId: t.parentTaskId ?? null
  };
}

function artifactFromSnapshot(a: CanvasLiveArtifactSnapshotWire): LiveArtifact {
  return {
    id: a.artifactId,
    taskId: a.taskId,
    kind: a.kind,
    title: a.title,
    editable: a.editable,
    createdAt: a.createdAt,
    approvalStatus: a.approvalStatus,
    approvedBy: a.approvedBy,
    approvedAt: a.approvedAt,
    rejectedBy: a.rejectedBy,
    rejectedAt: a.rejectedAt,
    rejectionReason: a.rejectionReason,
    executionId: a.executionId,
    blocks: a.blocks
      .slice()
      .sort((x, y) => x.order - y.order)
      .map((b) => ({
        id: b.blockId,
        order: b.order,
        kind: b.kind,
        content: b.content,
        editable: b.editable,
        status: b.status
      }))
  };
}

function adaptAction(ev: CanvasLiveActionNowEventWire): LiveAction | null {
  switch (ev.kind) {
    case "api":
      return {
        kind: "api",
        taskId: ev.taskId,
        method: normalizeMethod(ev.method),
        url: ev.url,
        status: ev.status,
        durationMs: ev.durationMs,
        responseBytes: ev.responseBytes,
        responseBody: ev.responseBody,
        next: ev.next
          ? {
              kind: "api",
              method: normalizeMethod(ev.next.method ?? "GET"),
              url: ev.next.url ?? "",
              context: ev.next.context
            }
          : undefined,
        occurredAt: ev.occurredAt
      };
    case "file":
      return {
        kind: "file",
        taskId: ev.taskId,
        operation: (ev.operation as "read" | "write" | "delete" | "rename") ?? "read",
        path: ev.path,
        diffSummary: ev.diffSummary,
        preview: ev.preview,
        occurredAt: ev.occurredAt
      };
    case "command":
      return {
        kind: "command",
        taskId: ev.taskId,
        cmd: ev.cmd,
        exitCode: ev.exitCode,
        stdout: ev.stdout,
        stderr: ev.stderr,
        durationMs: ev.durationMs,
        occurredAt: ev.occurredAt
      };
    case "audit":
      return {
        kind: "audit",
        taskId: ev.taskId,
        eventName: ev.action,
        summary: `${ev.targetType}:${ev.targetId} · risk ${ev.riskLevel}`,
        occurredAt: ev.occurredAt
      };
    default:
      return null;
  }
}

function getActorId(): string {
  // Por ahora hardcodeamos el operador local. Cuando exista una sesión real
  // (Hito futuro de auth), leemos el actor desde el contexto.
  return "operator/juanes";
}

function normalizeMethod(m: string): "GET" | "POST" | "PUT" | "DELETE" | "PATCH" {
  const up = m.toUpperCase();
  if (up === "GET" || up === "POST" || up === "PUT" || up === "DELETE" || up === "PATCH") return up;
  return "GET";
}
