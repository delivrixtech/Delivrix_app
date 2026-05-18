/**
 * OpenClaw rules engine — Hito 5.11.A.
 *
 * Primer cerebro real de OpenClaw. NO usa LLM todavía. Compara el inventario
 * de Webdock contra el registry local de sender_node y detecta drift. Cada
 * drift emite una propuesta GET-only que el operador aprueba (o rechaza)
 * afuera del panel siguiendo la regla de dos personas firmada.
 *
 * Reglas iniciales (orden de severidad descendente):
 *   1. Webdock `running` + sender_node `paused/retired` → "Reactivar nodo
 *      en envío" (medium severity).
 *   2. Webdock `stopped/suspended` + sender_node `active/warming` →
 *      "Pausar nodo: el servidor ya no responde" (high severity).
 *   3. Webdock server sin backing en sender_node registry → "Registrar
 *      nodo nuevo" (low severity, informativo).
 *   4. sender_node provider=webdock sin server en Webdock → "Verificar
 *      sender_node huérfano" (medium severity).
 *
 * Cada propuesta tiene runbookRef apuntando al .md correspondiente.
 */

import type { SenderNode } from "./types.ts";
import type { WebdockInventoryServer } from "./webdock-inventory.ts";

export type OpenClawDriftSeverity = "low" | "medium" | "high";
export type OpenClawDriftCategory =
  | "node_resume_proposed"
  | "node_pause_proposed"
  | "node_register_proposed"
  | "node_orphan_warning";

export interface OpenClawDriftProposal {
  id: string;
  category: OpenClawDriftCategory;
  severity: OpenClawDriftSeverity;
  headline: string;
  body: string;
  evidenceRefs: string[];
  runbookRef: string;
  /** ID del sender_node o slug del Webdock server al que aplica. */
  targetRef: string;
}

export interface EvaluateWebdockDriftInput {
  webdockServers: WebdockInventoryServer[];
  senderNodes: SenderNode[];
}

export interface EvaluateWebdockDriftResult {
  proposals: OpenClawDriftProposal[];
  /** Slugs/IDs sin match en el lado contrario, para visibilidad. */
  unmatchedWebdockSlugs: string[];
  unmatchedSenderNodeIds: string[];
}

export function evaluateWebdockDrift(
  input: EvaluateWebdockDriftInput
): EvaluateWebdockDriftResult {
  const webdockBySlug = new Map(
    input.webdockServers.map((s) => [s.slug, s] as const)
  );
  const senderNodeByProviderId = new Map<string, SenderNode>();
  for (const node of input.senderNodes) {
    if (node.provider === "webdock") {
      // En el MVP usamos el `id` del sender_node como referencia al slug de
      // Webdock cuando se registra desde el adapter. Si en producción se
      // separa, ajustar aquí.
      senderNodeByProviderId.set(node.id, node);
    }
  }

  const proposals: OpenClawDriftProposal[] = [];
  const unmatchedWebdockSlugs: string[] = [];
  const unmatchedSenderNodeIds: string[] = [];

  // Pass 1: por cada server Webdock, ver si hay sender_node y comparar status.
  for (const server of input.webdockServers) {
    const senderNode = senderNodeByProviderId.get(server.slug);

    if (!senderNode) {
      unmatchedWebdockSlugs.push(server.slug);
      proposals.push({
        id: `register-${server.slug}`,
        category: "node_register_proposed",
        severity: "low",
        headline: `Servidor Webdock "${server.slug}" sin registro local`,
        body: `El servidor ${server.name} (${server.ipv4 || "sin IP"}) existe en tu cuenta Webdock con status "${server.status}" pero todavía no está registrado como sender_node en Delivrix. Considera registrarlo para que entre al pipeline supervisado.`,
        evidenceRefs: [
          `webdock://servers/${server.slug}`,
          server.lastDataReceived ? `webdock://lastDataReceived/${server.lastDataReceived}` : ""
        ].filter((ref) => ref.length > 0),
        runbookRef: "sender-node-register-runbook.md",
        targetRef: server.slug
      });
      continue;
    }

    // Server running pero nodo paused/retired → proponer reanudar.
    if (
      server.status === "running" &&
      (senderNode.status === "paused" ||
        senderNode.status === "retired" ||
        senderNode.status === "retired_pending_approval")
    ) {
      proposals.push({
        id: `resume-${server.slug}`,
        category: "node_resume_proposed",
        severity: "medium",
        headline: `Reactivar "${senderNode.label}": Webdock reporta running`,
        body: `El servidor está corriendo en Webdock (${server.ipv4 || "sin IP"}) pero el nodo está marcado como "${senderNode.status}" en Delivrix. Revisa si el operador puede reanudarlo en envío supervisado.`,
        evidenceRefs: [
          `webdock://servers/${server.slug}`,
          `senderNode://${senderNode.id}`
        ],
        runbookRef: "sender-node-resume-runbook.md",
        targetRef: senderNode.id
      });
      continue;
    }

    // Server stopped/suspended pero nodo activo/warming → proponer pausar.
    if (
      (server.status === "stopped" ||
        server.status === "suspended" ||
        server.status === "error") &&
      (senderNode.status === "active" || senderNode.status === "warming")
    ) {
      proposals.push({
        id: `pause-${server.slug}`,
        category: "node_pause_proposed",
        severity: "high",
        headline: `Pausar "${senderNode.label}": Webdock reporta ${server.status}`,
        body: `El nodo está marcado como "${senderNode.status}" en Delivrix pero Webdock reporta que el servidor está "${server.status}". Los envíos podrían fallar. Considera pausarlo hasta que el servidor vuelva a estar disponible.`,
        evidenceRefs: [
          `webdock://servers/${server.slug}`,
          `senderNode://${senderNode.id}`
        ],
        runbookRef: "sender-node-pause-runbook.md",
        targetRef: senderNode.id
      });
      continue;
    }
  }

  // Pass 2: sender_node provider=webdock sin server real en Webdock → huérfano.
  for (const [id, senderNode] of senderNodeByProviderId.entries()) {
    if (!webdockBySlug.has(senderNode.id)) {
      unmatchedSenderNodeIds.push(id);
      proposals.push({
        id: `orphan-${senderNode.id}`,
        category: "node_orphan_warning",
        severity: "medium",
        headline: `Sender_node "${senderNode.label}" sin server en Webdock`,
        body: `El nodo está registrado con provider=webdock e id "${senderNode.id}" pero no aparece en la cuenta Webdock actual. Pudo haber sido eliminado afuera del panel. Verifica la referencia antes de seguir enviando.`,
        evidenceRefs: [`senderNode://${senderNode.id}`],
        runbookRef: "sender-node-orphan-runbook.md",
        targetRef: senderNode.id
      });
    }
  }

  // Ordenar por severidad: high > medium > low, y luego alfabético por id.
  proposals.sort(compareProposals);

  return {
    proposals,
    unmatchedWebdockSlugs,
    unmatchedSenderNodeIds
  };
}

function severityWeight(s: OpenClawDriftSeverity): number {
  if (s === "high") return 3;
  if (s === "medium") return 2;
  return 1;
}

function compareProposals(a: OpenClawDriftProposal, b: OpenClawDriftProposal): number {
  const bySeverity = severityWeight(b.severity) - severityWeight(a.severity);
  if (bySeverity !== 0) return bySeverity;
  return a.id.localeCompare(b.id);
}
