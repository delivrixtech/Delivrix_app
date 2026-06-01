/**
 * PendingApprovalsPanel — sticky-bottom panel del Canvas Live que muestra
 * propuestas del agente esperando firma del operador.
 *
 * Filosofía (cambio norte 2026-05-29): 1 firma del operador reemplaza la
 * "regla de 2 personas". Mientras Bedrock direct + tool calling (Fase 1)
 * `GET /v1/openclaw/proposals` expone solo proposals vivas del gateway.
 * No derivamos esta cola desde el audit chain porque ese log conserva
 * propuestas históricas que ya no existen en memoria luego de reiniciar.
 *
 * El panel:
 *   - Polling cada 5s vía useQuery refetchInterval.
 *   - Sticky-bottom flotante sobre el Canvas Live, max-h con scroll interno.
 *   - Por proposal renderiza un <ApprovalGate /> con su categoría + gates.
 *   - onSigned / onRejected: invalida la query → refresca panel en próximo tick.
 *
 * Three Dials:
 *   VARIANCE 2/5 — solo borde + un Eyebrow.
 *   MOTION 1/5 — sin animaciones; React Query maneja el fade del slot.
 *   DENSITY 4/5 — compacto, padding minimal.
 */
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { getJson } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import { ApprovalGate, type ApprovalCategory, type Gate } from "./ApprovalGate";
import { Caption, Eyebrow } from "./primitives";

const REFETCH_MS = 5_000;
const QUERY_KEY = ["openclaw-proposals", "pending"] as const;

const VALID_CATEGORIES: ReadonlySet<ApprovalCategory> = new Set<ApprovalCategory>([
  "allowed_read_only",
  "allowed_dry_run",
  "supervised_local_state",
  "future_live_requires_new_phase"
]);

interface DerivedProposal {
  auditId: string;
  category: ApprovalCategory;
  agentRole: string;
  dryRunSummary: string;
  gates: Gate[];
  proposedAt: string;
}

interface OpenClawProposal {
  id: string;
  category: string;
  severity: string;
  headline?: string;
  body?: string;
  runbookRef?: string;
  targetRef: string;
  targetType?: string;
  skillSlug?: string;
  params?: unknown;
  evidenceRefs?: string[];
  delivrixActionsRequired?: string[];
  receivedAt: string;
  expiresAt: string;
  requiredApprovals: number;
  currentApprovals: number;
}

interface OpenClawProposalsPayload {
  schemaVersion: string;
  generatedAt: string;
  proposals: OpenClawProposal[];
}

function deriveProposals(items: OpenClawProposal[]): DerivedProposal[] {
  const proposals: DerivedProposal[] = [];

  for (const proposal of items) {
    const rawCategory = proposal.category || "supervised_local_state";
    const category: ApprovalCategory = VALID_CATEGORIES.has(rawCategory as ApprovalCategory)
      ? (rawCategory as ApprovalCategory)
      : "supervised_local_state";

    const dryRunSummary = formatDryRunSummary({
      auditId: proposal.id,
      targetRef: proposal.targetRef,
      runbookRef: proposal.runbookRef ?? "",
      severity: proposal.severity,
      skillSlug: proposal.skillSlug ?? "",
      category,
      headline: proposal.headline ?? "",
      body: proposal.body ?? "",
      params: proposal.params
    });

    const gates: Gate[] = [
      {
        id: "operator-signature",
        label: "Firma del operador",
        status: "pending",
        responsable: "operator/juanes"
      }
    ];

    proposals.push({
      auditId: proposal.id,
      category,
      agentRole: "openclaw-hostinger-prod",
      dryRunSummary,
      gates,
      proposedAt: proposal.receivedAt
    });
  }

  // Más reciente primero (al backend devuelve desc por occurredAt, pero
  // forzamos por si llega en otro orden).
  proposals.sort((a, b) => Date.parse(b.proposedAt) - Date.parse(a.proposedAt));
  return proposals;
}

function formatDryRunSummary(input: {
  auditId: string;
  targetRef: string;
  runbookRef: string;
  severity: string;
  skillSlug: string;
  category: ApprovalCategory;
  headline: string;
  body: string;
  params: unknown;
}): string {
  const lines: string[] = [];
  lines.push(`# Propuesta ${input.auditId}`);
  lines.push("");
  if (input.headline) lines.push(`título       ${input.headline}`);
  lines.push(`categoría    ${input.category}`);
  lines.push(`target       ${input.targetRef}`);
  if (input.runbookRef) lines.push(`runbook      ${input.runbookRef}`);
  if (input.skillSlug) lines.push(`skill        ${input.skillSlug}`);
  lines.push(`severidad    ${input.severity}`);
  if (input.params !== null && input.params !== undefined) {
    lines.push(`params       ${JSON.stringify(input.params)}`);
  }
  lines.push("");
  if (input.body) {
    lines.push(input.body);
    lines.push("");
  }
  lines.push("Esta propuesta está viva en el gateway y pendiente de firma.");
  lines.push("Antes de firmar, revisa el target, runbook, skill y params.");
  return lines.join("\n");
}

export interface PendingApprovalsPanelProps {
  /** Override polling interval — útil para tests. */
  refetchMs?: number;
}

export function PendingApprovalsPanel({ refetchMs = REFETCH_MS }: PendingApprovalsPanelProps = {}) {
  const queryClient = useQueryClient();
  const query = useQuery<OpenClawProposalsPayload>({
    queryKey: QUERY_KEY,
    queryFn: () => getJson<OpenClawProposalsPayload>(READ_ENDPOINTS.openClawProposals),
    refetchInterval: refetchMs,
    staleTime: refetchMs / 2,
    retry: 1
  });

  const proposals = useMemo(
    () => deriveProposals(query.data?.proposals ?? []),
    [query.data]
  );

  // Sin proposals pendientes → no rendereamos nada (no ruido visual en idle).
  if (proposals.length === 0) {
    return null;
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  };

  return (
    <aside
      data-testid="pending-approvals-panel"
      className="pointer-events-auto flex flex-col gap-2"
      style={{
        position: "absolute",
        left: 24,
        right: 24,
        bottom: 16,
        zIndex: 40,
        maxHeight: "60vh",
        background: "var(--color-surface)",
        border: "1px solid var(--color-warning)",
        borderRadius: 12,
        padding: 12,
        boxShadow: "var(--shadow-md)"
      }}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Eyebrow>Pendiente de firma</Eyebrow>
          <Caption>
            {proposals.length === 1
              ? "1 propuesta esperando aprobación del operador"
              : `${proposals.length} propuestas esperando aprobación del operador`}
          </Caption>
        </div>
        <Inbox
          size={14}
          strokeWidth={1.75}
          style={{ color: "var(--color-warning)" }}
          aria-hidden="true"
        />
      </header>

      <div
        className="flex flex-col gap-3 overflow-y-auto"
        style={{ paddingRight: 4 }}
      >
        {proposals.map((p) => (
          <ApprovalGate
            key={p.auditId}
            auditId={p.auditId}
            category={p.category}
            agentRole={p.agentRole}
            dryRunSummary={p.dryRunSummary}
            gates={p.gates}
            proposedAt={p.proposedAt}
            onSigned={refresh}
            onRejected={refresh}
            onClose={refresh}
          />
        ))}
      </div>
    </aside>
  );
}
