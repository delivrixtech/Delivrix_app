/**
 * ApprovalGate — 1 firma del operador para acciones supervised_local_state o más críticas.
 *
 * Filosofía: el agente OpenClaw propone vía dry-run con audit ID + categoría matrix + gates.
 * El operador (humano) LEE el dry-run completo, espera 5s mínimo (forzando lectura), y
 * firma con 1 click. La firma queda en audit chain SHA-256 + broadcast al equipo.
 *
 * Reemplaza la "regla de 2 personas" antigua. Detalle:
 * `CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md`.
 *
 * Three Dials (TasteSkill §1):
 *   VARIANCE 2/5 · MOTION 1/5 · DENSITY 4/5.
 *
 * Anti-patterns evitados:
 *   - Sin hover-lift / transform.
 *   - Sin shadow en la Card (border-2 hairline doble = warning structural).
 *   - Sin gradients en el CTA primario.
 *   - Sin em-dashes en UI text.
 *   - Sin Sparkles 26px centrados.
 *   - Card-in-card evitado: el dry-run usa un panel sunken con border-border, no Card anidada.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, X, AlertCircle, Clock, ShieldCheck } from "lucide-react";
import {
  Button,
  Caption,
  Card,
  Eyebrow,
  H3,
  MonoCode,
  Pill
} from "./primitives";

export type ApprovalCategory =
  | "allowed_read_only"
  | "allowed_dry_run"
  | "supervised_local_state"
  | "future_live_requires_new_phase";

export interface Gate {
  id: string;
  label: string;
  status: "ok" | "pending" | "blocked";
  responsable?: string;
}

export interface ApprovalGateProps {
  auditId: string;
  category: ApprovalCategory;
  agentRole: string; // "openclaw-orchestrator" | "dns-senior" | etc.
  dryRunSummary: string; // markdown / texto plano
  gates: Gate[];
  proposedAt: string; // ISO
  actorId?: string; // operador firmante, default "operator/juanes"
  /** Tiempo mínimo de lectura antes de habilitar el botón firma. Default 5s. */
  minReadSeconds?: number;
  onSigned?: (result: { signatureId: string; signedAt: string }) => void;
  onRejected?: (reason?: string) => void;
  onClose?: () => void;
  /** Override para tests: permite inyectar un fetch mock. Default: global fetch. */
  fetchImpl?: typeof fetch;
}

interface SignResponse {
  ok: boolean;
  signatureId?: string;
  signedAt?: string;
  message?: string;
  blockers?: string[];
}

const categoryTone: Record<
  ApprovalCategory,
  "success" | "warning" | "critical" | "neutral"
> = {
  allowed_read_only: "neutral",
  allowed_dry_run: "neutral",
  supervised_local_state: "warning",
  future_live_requires_new_phase: "critical"
};

const categoryLabel: Record<ApprovalCategory, string> = {
  allowed_read_only: "Lectura",
  allowed_dry_run: "Dry-run",
  supervised_local_state: "Supervised, requiere firma",
  future_live_requires_new_phase: "Bloqueada, requiere hito posterior"
};

export async function signProposal(
  input: {
    auditId: string;
    actorId: string;
    signature: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<SignResponse> {
  const url = `/v1/openclaw/proposals/${encodeURIComponent(input.auditId)}/sign`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: input.actorId, signature: input.signature })
  });
  const raw: unknown = await response.json().catch(() => ({}));
  const payload = (raw ?? {}) as Partial<SignResponse>;
  if (!response.ok) {
    throw new Error(payload.message ?? `Sign failed (HTTP ${response.status})`);
  }
  return {
    ok: payload.ok ?? true,
    signatureId: payload.signatureId,
    signedAt: payload.signedAt,
    message: payload.message
  };
}

export function ApprovalGate({
  auditId,
  category,
  agentRole,
  dryRunSummary,
  gates,
  proposedAt,
  actorId = "operator/juanes",
  minReadSeconds = 5,
  onSigned,
  onRejected,
  onClose,
  fetchImpl
}: ApprovalGateProps) {
  const queryClient = useQueryClient();
  const [secondsLeft, setSecondsLeft] = useState(minReadSeconds);
  const [confirmed, setConfirmed] = useState(false);

  // Timer cuenta atrás (MOTION 1/5: tick discreto cada 1s, sin animación).
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  const mutation = useMutation<SignResponse, Error>({
    mutationFn: () =>
      signProposal(
        {
          auditId,
          actorId,
          signature: `${actorId}@${new Date().toISOString()}`
        },
        fetchImpl
      ),
    onSuccess: (result) => {
      if (!result.ok) return;
      setConfirmed(true);
      queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      queryClient.invalidateQueries({ queryKey: ["sender-pool", "status"] });
      onSigned?.({
        signatureId: result.signatureId ?? auditId,
        signedAt: result.signedAt ?? new Date().toISOString()
      });
    }
  });

  const gatesOk = gates.filter((g) => g.status === "ok").length;
  const gatesBlocked = gates.filter((g) => g.status === "blocked").length;
  const gatesPending = gates.length - gatesOk - gatesBlocked;

  const canSign =
    secondsLeft === 0 && !confirmed && !mutation.isPending && gatesBlocked === 0;

  return (
    <Card
      padding="hero"
      className="flex flex-col gap-4 border-2 border-warning"
      data-testid="approval-gate"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Eyebrow>Aprobación operador · {agentRole}</Eyebrow>
          <H3>{categoryLabel[category]}</H3>
          <Caption>
            <MonoCode>{auditId}</MonoCode>
            {" · propuesto "}
            {new Date(proposedAt).toLocaleString("es-CO")}
          </Caption>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Pill tone={categoryTone[category]} size="sm">
            {category.replace(/_/g, " ")}
          </Pill>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="grid size-6 place-items-center rounded text-fg-subtle transition-colors hover:bg-surface-sunken"
              aria-label="Cerrar"
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Dry-run summary (preformatted, max-h con scroll interno) */}
      <div className="rounded-md border border-border bg-surface-sunken p-3">
        <Caption className="mb-2 block text-[10.5px] uppercase tracking-wider">
          Dry-run propuesto por el agente
        </Caption>
        <pre
          data-testid="approval-gate-dry-run"
          className="m-0 max-h-[400px] overflow-y-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-fg"
        >
          {dryRunSummary}
        </pre>
      </div>

      {/* Gates */}
      <div className="flex flex-col gap-1.5">
        <Caption className="text-[10.5px] uppercase tracking-wider">
          {`Gates (${gatesOk} ok · ${gatesBlocked} bloqueados · ${gatesPending} pendientes)`}
        </Caption>
        <ul className="m-0 list-none p-0">
          {gates.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-2 py-0.5 text-[12px]"
              data-testid={`approval-gate-row-${g.id}`}
            >
              <span
                aria-hidden="true"
                className="inline-block size-1.5 rounded-full"
                style={{
                  background:
                    g.status === "ok"
                      ? "var(--color-success)"
                      : g.status === "blocked"
                      ? "var(--color-critical)"
                      : "var(--color-warning)"
                }}
              />
              <span className="flex-1 truncate text-fg">{g.label}</span>
              {g.responsable ? (
                <Caption className="text-[10.5px]">{g.responsable}</Caption>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {/* Estado del timer / resultado */}
      {confirmed && mutation.data?.ok ? (
        <div
          className="flex items-start gap-2 rounded-md border border-success bg-success-soft px-3 py-2 text-[12px] text-success-fg"
          data-testid="approval-gate-signed"
        >
          <CheckCircle2
            size={14}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-success"
          />
          <div className="flex flex-col gap-0.5">
            <strong>Firmado y ejecutando</strong>
            <span>
              {"signatureId: "}
              <MonoCode>{mutation.data.signatureId}</MonoCode>
            </span>
          </div>
        </div>
      ) : mutation.error ? (
        <div
          className="flex items-start gap-2 rounded-md border border-critical bg-critical-soft px-3 py-2 text-[12px] text-critical-fg"
          data-testid="approval-gate-error"
        >
          <AlertCircle
            size={14}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-critical"
          />
          <span>{mutation.error.message}</span>
        </div>
      ) : (
        <div
          className="flex items-center gap-2 text-fg-subtle"
          data-testid="approval-gate-timer"
        >
          <Clock size={12} strokeWidth={1.75} />
          <Caption>
            {secondsLeft > 0
              ? `Lee el dry-run completo. Botón habilita en ${secondsLeft}s.`
              : "Lectura completa. Podés firmar y ejecutar."}
          </Caption>
        </div>
      )}

      {/* Acciones */}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={mutation.isPending || confirmed}
          onClick={() => {
            onRejected?.("operator_rejected");
            onClose?.();
          }}
          data-testid="approval-gate-reject"
        >
          <X size={11} strokeWidth={1.75} />
          Rechazar
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={!canSign}
          onClick={() => mutation.mutate()}
          data-testid="approval-gate-sign"
        >
          <ShieldCheck size={13} strokeWidth={1.75} />
          {mutation.isPending
            ? "Firmando…"
            : confirmed
            ? "Firmado"
            : "Firmar y ejecutar"}
        </Button>
      </div>
    </Card>
  );
}
