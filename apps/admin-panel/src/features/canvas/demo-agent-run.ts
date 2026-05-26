/**
 * Demo Agent Run v2 — dataset que simula el flujo del Canvas Live v6
 * mientras Codex no entregue los eventos backend del OPS Bloque 7.
 *
 * Produce el shape final de la herramienta: tareas + acción actual +
 * artifact con bloques editables. Cuando el backend esté live, este
 * archivo se descarta y los eventos llegan via WSS al mismo shape.
 */

import { useEffect, useState } from "react";
import type { LiveTask, LiveAction, LiveArtifact } from "./live-tool-types.ts";

const TASK_ID = "auditoria-ionos-2026-05-25";

const TASKS: LiveTask[] = [
  {
    id: TASK_ID,
    title: "Auditoría dominios IONOS",
    status: "running",
    subPath: "blacklists / 14 de 64",
    createdAt: new Date(Date.now() - 14_000).toISOString(),
    actorId: "openclaw/openclaw-hostinger-prod"
  },
  {
    id: "compare-route53-porkbun-2026-05-25",
    title: "Comparar Route53/Porkbun",
    status: "idle",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    actorId: "openclaw/openclaw-hostinger-prod"
  },
  {
    id: "plan-remediacion-spf-2026-05-25",
    title: "Plan remediación SPF",
    status: "awaiting_approval",
    createdAt: new Date(Date.now() - 90_000).toISOString(),
    actorId: "openclaw/openclaw-hostinger-prod"
  },
  {
    id: "sourcing-sender-pool-2026-05-25",
    title: "Sourcing sender pool",
    status: "idle",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    actorId: "openclaw/openclaw-hostinger-prod"
  }
];

/**
 * Acciones simuladas que rotan en el centro. El hook va cambiando
 * la acción actual cada N segundos para mostrar movimiento real.
 */
const ACTIONS_CYCLE: LiveAction[] = [
  {
    kind: "api",
    taskId: TASK_ID,
    method: "GET",
    url: "https://blacklist.spamhaus.org/lookup/74.208.236.98",
    status: 200,
    durationMs: 1240,
    responseBytes: 142,
    cache: "cache miss",
    responseBody: {
      ip: "74.208.236.98",
      domain: "corpyearlyreport.com",
      listed: false,
      lists: [],
      queriedAt: "2026-05-25T17:01:23Z"
    },
    next: {
      kind: "api",
      method: "GET",
      url: "https://blacklist.spamhaus.org/lookup/74.208.236.214",
      context: "nfcfilings.com"
    },
    occurredAt: new Date(Date.now() - 2000).toISOString()
  },
  {
    kind: "api",
    taskId: TASK_ID,
    method: "GET",
    url: "https://blacklist.spamhaus.org/lookup/74.208.236.214",
    status: 200,
    durationMs: 980,
    responseBytes: 138,
    cache: "cache miss",
    responseBody: {
      ip: "74.208.236.214",
      domain: "nfcfilings.com",
      listed: false,
      lists: [],
      queriedAt: "2026-05-25T17:01:25Z"
    },
    next: {
      kind: "api",
      method: "GET",
      url: "https://b.barracudacentral.org/lookup/74.208.236.98",
      context: "corpyearlyreport.com · siguiente blacklist"
    },
    occurredAt: new Date(Date.now() - 1000).toISOString()
  },
  {
    kind: "api",
    taskId: TASK_ID,
    method: "GET",
    url: "https://b.barracudacentral.org/lookup/74.208.236.98",
    status: 200,
    durationMs: 1520,
    responseBytes: 156,
    cache: "cache miss",
    responseBody: {
      ip: "74.208.236.98",
      domain: "corpyearlyreport.com",
      listed: false,
      score: 0,
      queriedAt: "2026-05-25T17:01:27Z"
    },
    occurredAt: new Date().toISOString()
  }
];

const ARTIFACT: LiveArtifact = {
  id: "plan-remediacion-spf-1701",
  taskId: TASK_ID,
  kind: "plan",
  title: "Remediar autenticación de 5 dominios",
  editable: true,
  createdAt: new Date(Date.now() - 8000).toISOString(),
  approvalStatus: "pending",
  blocks: [
    {
      id: "step-01",
      order: 1,
      kind: "step",
      content: "Generar par de claves DKIM para cada dominio incompleto",
      editable: true,
      status: "complete"
    },
    {
      id: "step-02",
      order: 2,
      kind: "step",
      content: "Publicar registro TXT default._domainkey con la clave pública",
      editable: true,
      status: "complete"
    },
    {
      id: "step-03",
      order: 3,
      kind: "step",
      content: "Crear política DMARC en modo p=none con reportes a dmarc@delivrix.com",
      editable: true,
      status: "complete"
    },
    {
      id: "step-04",
      order: 4,
      kind: "step",
      content: "Validar con dig que el TXT ",
      editable: true,
      status: "streaming"
    }
  ]
};

/**
 * Hook que entrega el estado simulado.
 *
 * Cuando `enabled=true`: rota la `currentAction` cada 3.5s para simular
 * al agente avanzando. Devuelve tasks + artifact estáticos (el artifact
 * tiene un bloque en streaming permanente para mostrar el cursor).
 *
 * Cuando `enabled=false`: devuelve estado vacío (Live conectado al
 * backend real).
 */
export function useDemoLiveState(enabled: boolean): {
  tasks: LiveTask[];
  activeTaskId: string | null;
  currentAction: LiveAction | null;
  artifact: LiveArtifact | null;
  isConnected: boolean;
} {
  const [cursor, setCursor] = useState(0);
  const [activeId, setActiveId] = useState<string>(TASK_ID);
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => {
      setCursor((c) => (c + 1) % ACTIONS_CYCLE.length);
    }, 3500);
    return () => window.clearInterval(t);
  }, [enabled]);
  return {
    tasks: enabled ? TASKS : [],
    activeTaskId: enabled ? activeId : null,
    currentAction: enabled ? ACTIONS_CYCLE[cursor] ?? null : null,
    artifact: enabled && activeId === TASK_ID ? ARTIFACT : null,
    isConnected: enabled
  };
}

/* ============================================================
 * Re-exports temporales para no romper canvas-v4.tsx existente.
 * El demo agent run viejo era basado en cards. Mantenemos un stub
 * compatible mientras el LiveTab se reescribe.
 * ============================================================ */

export type DemoAction = unknown;

export function useDemoAgentRun(
  enabled: boolean,
  _stepMs?: number
): {
  actions: never[];
  progress: { current: number; total: number };
  isRunning: boolean;
} {
  // Stub backward-compat: el nuevo Canvas Live no usa cards apiladas.
  // Devuelve siempre vacío. El demo real ahora vive en useDemoLiveState.
  void enabled;
  void _stepMs;
  return {
    actions: [],
    progress: { current: 0, total: 0 },
    isRunning: false
  };
}
