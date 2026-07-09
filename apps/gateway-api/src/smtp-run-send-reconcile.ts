// Reconciliación de run-states tras un envío real ("mata fallos fantasma").
//
// Un run puede quedar `failed` en el step 14 aunque el dominio SÍ haya terminado
// entregando (p.ej. el email se reenvió por fuera del resume del orquestador, o
// un run posterior completó el envío). Ese run-state viejo hace que el agente
// reporte deuda sobre dominios que ya entregaron.
//
// Este módulo corre best-effort después de CADA envío real exitoso: busca los
// run-states `failed` del mismo dominio y los reconcilia a `completed`, dejando
// un marcador `reconciledBy` con la evidencia (eventId del envío). Nunca toca
// runs `running` (el run activo del orquestador se autoexcluye) y nunca propaga
// errores al envío.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

export interface ReconciledSmtpRun {
  runId: string;
  previousStatus: string;
  chosenDomain: string;
}

export interface ReconcileSmtpRunStatesInput {
  workspace: OpenClawWorkspace;
  /** Dominio remitente del envío real (From address). */
  fromDomain: string;
  messageId?: string | null;
  /** deliveryStatus del handler send_real_email (sent|queued|deferred|...). */
  deliveryStatus?: string | null;
  /** eventId del audit event oc.smtp.real_email_sent que sirve de evidencia. */
  sendEventId?: string | null;
  now: Date;
}

const SMTP_RUNS_DIR = ["inventory", "smtp-runs"] as const;

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Mapea el deliveryStatus del handler a la unión del run-state; undefined si no mapea. */
function runStateDeliveryStatus(value: string | null | undefined): string | undefined {
  if (value === "sent") return "delivered";
  if (value === "queued" || value === "deferred") return value;
  return undefined;
}

export async function reconcileSmtpRunStatesAfterRealSend(
  input: ReconcileSmtpRunStatesInput
): Promise<ReconciledSmtpRun[]> {
  const fromDomain = normalizeDomain(input.fromDomain ?? "");
  if (!fromDomain) return [];

  const dir = join(input.workspace.getRootDir(), ...SMTP_RUNS_DIR);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".json"));
  const reconciled: ReconciledSmtpRun[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown>;
      if (raw.status !== "failed") continue;
      const chosenDomain = typeof raw.chosenDomain === "string" ? normalizeDomain(raw.chosenDomain) : "";
      if (!chosenDomain || chosenDomain !== fromDomain) continue;

      const previousStatus = String(raw.status);
      raw.status = "completed";
      delete raw.retryableFailure;
      delete raw.failureCategory;
      delete raw.failureRetryAfterMs;
      if (input.messageId) raw.finalEmailMessageId = input.messageId;
      const deliveryStatus = runStateDeliveryStatus(input.deliveryStatus);
      if (deliveryStatus) raw.finalDeliveryStatus = deliveryStatus;
      raw.reconciledBy = {
        source: "send_real_email",
        ...(input.sendEventId ? { sendEventId: input.sendEventId } : {}),
        occurredAt: input.now.toISOString()
      };
      raw.updatedAt = input.now.toISOString();

      await input.workspace.writeWorkspaceFileAtomic(
        `${SMTP_RUNS_DIR.join("/")}/${file}`,
        `${JSON.stringify(raw, null, 2)}\n`
      );
      reconciled.push({
        runId: typeof raw.runId === "string" ? raw.runId : file.replace(/\.json$/, ""),
        previousStatus,
        chosenDomain
      });
    } catch {
      // Best-effort: un run-state ilegible/corrupto no debe romper el envío ni la reconciliación del resto.
    }
  }

  return reconciled;
}
