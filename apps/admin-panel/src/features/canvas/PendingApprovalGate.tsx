/**
 * PendingApprovalGate — gate de firma de propuestas OpenClaw para Canvas Live.
 *
 * Portado 1:1 del patrón que ya vive en canvas-v4.tsx (usePendingOpenClawProposals
 * + PendingOpenClawApprovalPanel). Se extrajo a un módulo propio para que el
 * preview v5 (CanvasV5Preview) pueda ofrecer la firma del operador SIN duplicar
 * lógica ni tocar el backend: reusa el endpoint GET /v1/openclaw/proposals (poll),
 * el endpoint POST /v1/openclaw/proposals/<id>/sign (vía ApprovalGate) y
 * /v1/openclaw/proposals/<id>/reject — todos ya allowlisted en el proxy.
 *
 * Firmar una propuesta pendiente dispara el run real (proposals-sign -> dispatcher
 * -> orquestador configure_complete_smtp). Sin esta UI el operador no tenía cómo
 * firmar desde v5 y el run nunca arrancaba.
 *
 * canvas-v4.tsx queda intacto (mantiene su copia inline) para no arriesgar v4.
 */
import { useCallback, useEffect, useState } from "react";

import { useToast } from "../../shared/ui/v2/index.ts";
import { ApprovalGate } from "../../v5/components/ApprovalGate.tsx";

export interface OpenClawPendingProposal {
  id: string;
  category?: string;
  severity?: string;
  headline?: string;
  body?: string;
  runbookRef?: string;
  targetRef?: unknown;
  targetType?: string;
  skillSlug?: string;
  params?: unknown;
  evidenceRefs?: string[];
  delivrixActionsRequired?: string[];
  receivedAt?: string;
  expiresAt?: string;
  requiredApprovals?: number;
  currentApprovals?: number;
}

interface OpenClawProposalsPayload {
  proposals?: OpenClawPendingProposal[];
}

export function usePendingOpenClawProposals(enabled: boolean, pollMs = 3_000): {
  proposals: OpenClawPendingProposal[];
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [proposals, setProposals] = useState<OpenClawPendingProposal[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setProposals([]);
      setError(null);
      return;
    }
    try {
      const response = await fetch("/v1/openclaw/proposals", {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json().catch(() => ({}))) as OpenClawProposalsPayload;
      setProposals(Array.isArray(payload.proposals) ? payload.proposals : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo leer propuestas pendientes");
    }
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      if (!cancelled) {
        await refresh();
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, pollMs);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pollMs, refresh]);

  return { proposals, error, refresh };
}

export function PendingOpenClawApprovalPanel({
  proposals,
  error,
  onRefresh
}: {
  proposals: OpenClawPendingProposal[];
  error: string | null;
  onRefresh: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const activeProposal = proposals.find((proposal) => !dismissedIds.has(proposal.id)) ?? null;

  useEffect(() => {
    setDismissedIds((current) => {
      if (current.size === 0) return current;
      const liveIds = new Set(proposals.map((proposal) => proposal.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (liveIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [proposals]);

  const rejectProposal = useCallback(
    async (proposal: OpenClawPendingProposal) => {
      try {
        const response = await fetch(`/v1/openclaw/proposals/${encodeURIComponent(proposal.id)}/reject`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            actorId: "operator/juanes",
            reason: "Operador rechazo la propuesta desde Canvas Live ApprovalGate."
          })
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { details?: string; rejectReason?: string };
          throw new Error(payload.details ?? payload.rejectReason ?? `HTTP ${response.status}`);
        }
        toast.success("Propuesta rechazada", {
          description: proposal.headline ?? proposal.id,
          duration: 3000
        });
      } catch (err) {
        toast.error("No se pudo rechazar la propuesta", {
          description: err instanceof Error ? err.message : "error desconocido",
          duration: 5000
        });
      } finally {
        await onRefresh();
      }
    },
    [onRefresh, toast]
  );

  if (!activeProposal && !error) return null;

  return (
    <div
      className="flex flex-col"
      style={{
        gap: 10,
        padding: "12px 16px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)",
        maxHeight: "45vh",
        overflowY: "auto"
      }}
      data-testid="pending-openclaw-approval-panel"
    >
      <div className="flex items-center" style={{ gap: 10 }}>
        <span
          className="font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{ fontSize: 10, letterSpacing: "0.6px", color: "var(--color-warning)" }}
        >
          Pendiente de firma
        </span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {proposals.length} propuesta{proposals.length === 1 ? "" : "s"} esperando aprobación del operador
        </span>
      </div>

      {activeProposal ? (
        <ApprovalGate
          auditId={activeProposal.id}
          category="supervised_local_state"
          agentRole={activeProposal.skillSlug ?? activeProposal.category ?? "openclaw-orchestrator"}
          dryRunSummary={formatPendingProposalDryRun(activeProposal)}
          gates={buildPendingProposalGates(activeProposal)}
          proposedAt={activeProposal.receivedAt ?? new Date().toISOString()}
          actorId="operator/juanes"
          minReadSeconds={5}
          onSigned={() => {
            toast.success("Firma enviada", {
              description: "El orquestador queda ejecutando y el estado se seguirá actualizando.",
              duration: 3500
            });
            void onRefresh();
          }}
          onRejected={() => {
            void rejectProposal(activeProposal);
          }}
          onClose={() => {
            setDismissedIds((current) => new Set(current).add(activeProposal.id));
          }}
        />
      ) : error ? (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--color-warning-border)",
            background: "var(--color-warning-soft)",
            color: "var(--color-warning-fg)",
            fontFamily: "var(--font-mono)",
            fontSize: 11
          }}
        >
          No se pudo leer /v1/openclaw/proposals: {error}
        </div>
      ) : null}
    </div>
  );
}

function buildPendingProposalGates(proposal: OpenClawPendingProposal) {
  const current = proposal.currentApprovals ?? 0;
  const required = proposal.requiredApprovals ?? 1;
  const budgetUsdMax = proposal.params && typeof proposal.params === "object" && "budgetUsdMax" in proposal.params
    ? (proposal.params as { budgetUsdMax?: unknown }).budgetUsdMax
    : null;
  return [
    {
      id: "operator-signature",
      label: `Firma del operador ${current}/${required}`,
      status: current >= required ? "ok" as const : "pending" as const,
      responsable: "operator/juanes"
    },
    {
      id: "audit-chain",
      label: "Audit chain SHA-256 verificada antes de ejecutar",
      status: "ok" as const,
      responsable: "gateway"
    },
    {
      id: "kill-switch",
      label: "Kill switch debe seguir OFF al momento de la firma",
      status: "ok" as const,
      responsable: "gateway"
    },
    {
      id: "budget-cap",
      label: budgetUsdMax != null ? `Budget cap USD ${String(budgetUsdMax)}` : "Budget cap definido por runbook",
      status: "ok" as const,
      responsable: "runbook"
    }
  ];
}

function formatPendingProposalDryRun(proposal: OpenClawPendingProposal): string {
  const lines = [
    proposal.body?.trim() || proposal.headline || `Propuesta ${proposal.id}`,
    "",
    `proposalId: ${proposal.id}`,
    `skill: ${proposal.skillSlug ?? proposal.category ?? "unknown"}`,
    `severity: ${proposal.severity ?? "unknown"}`,
    `runbook: ${proposal.runbookRef ?? "n/a"}`,
    `target: ${formatProposalTarget(proposal.targetRef)}`,
    `expiresAt: ${proposal.expiresAt ?? "n/a"}`
  ];
  if (Array.isArray(proposal.delivrixActionsRequired) && proposal.delivrixActionsRequired.length > 0) {
    lines.push("", "acciones:", ...proposal.delivrixActionsRequired.map((action) => `- ${action}`));
  }
  if (Array.isArray(proposal.evidenceRefs) && proposal.evidenceRefs.length > 0) {
    lines.push("", "evidence:", ...proposal.evidenceRefs.map((ref) => `- ${ref}`));
  }
  return lines.join("\n");
}

function formatProposalTarget(value: unknown): string {
  if (value == null) return "n/a";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
