// Provisioning run-state integrity (#6 / O5): "no hay servers que envían sin run".
//
// Runs are stored per provisioning flow keyed by chosenDomain + status. But a
// domain can end up SENDING with no run registered at all (the audited case:
// `annualcorpfilings` sent 10/10 without a run). That breaks observability: the
// operator/agent can't tell whether a sending domain was provisioned through the
// audited flow. It also leaves failed/cancelled runs lying around.
//
// This pure function cross-references the sending domains (from real-send audit
// events) against the registered runs and reports orphans + failed/cancelled
// runs, so the gap is surfaced instead of silently ignored.
//
// "Fallos fantasma": un run `failed` cuyo dominio tiene evidencia POSTERIOR de
// entrega (send ok) o un run más nuevo completed/running no es deuda real — se
// reporta aparte en `supersededFailedRuns` y no bloquea `ok`.

export interface RunStateRun {
  runId: string;
  /** running | completed | failed | cancelled_by_operator | unknown */
  status: string;
  chosenDomain?: string;
  /** ISO timestamp de la última escritura del run-state. */
  updatedAt?: string;
}

export interface RunStateSend {
  /** Sending domain (e.g. from the From address of a real send). */
  domain: string;
  serverSlug?: string;
  occurredAt?: string;
  /** true si el audit event tiene decision allow (envío que realmente salió). */
  ok?: boolean;
}

export interface RunStateIntegrityReport {
  /** Domains that sent mail but have NO run of any status — the core defect. */
  domainsWithoutRun: string[];
  failedRuns: Array<{ runId: string; chosenDomain?: string }>;
  /** Runs failed cuyo dominio ya entregó después (o tiene un run más nuevo): no son deuda real. */
  supersededFailedRuns: Array<{
    runId: string;
    chosenDomain?: string;
    reason: "delivered_after_failure" | "newer_completed_run";
  }>;
  cancelledRuns: Array<{ runId: string; chosenDomain?: string }>;
  totals: {
    runs: number;
    sendingDomains: number;
    domainsWithoutRun: number;
    failedRuns: number;
  };
  /** true when every sending domain has a run and no run is failed. */
  ok: boolean;
  summary: string;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function checkRunStateIntegrity(input: {
  runs: RunStateRun[];
  sends: RunStateSend[];
}): RunStateIntegrityReport {
  const runDomains = new Set<string>();
  for (const run of input.runs) {
    if (run.chosenDomain && run.chosenDomain.trim()) {
      runDomains.add(normalizeDomain(run.chosenDomain));
    }
  }

  const sendingDomains = new Set<string>();
  for (const send of input.sends) {
    // ok === false (decision reject) no es evidencia de envío; ok undefined = legacy, cuenta.
    if (send.ok === false) continue;
    if (send.domain && send.domain.trim()) {
      sendingDomains.add(normalizeDomain(send.domain));
    }
  }

  const domainsWithoutRun = [...sendingDomains].filter((domain) => !runDomains.has(domain)).sort();

  const supersededReason = (run: RunStateRun): "delivered_after_failure" | "newer_completed_run" | null => {
    const domain = run.chosenDomain ? normalizeDomain(run.chosenDomain) : "";
    if (!domain) return null;
    const failedAt = run.updatedAt ?? "";
    if (failedAt) {
      const deliveredAfter = input.sends.some((send) =>
        send.ok === true &&
        send.domain &&
        normalizeDomain(send.domain) === domain &&
        (send.occurredAt ?? "") >= failedAt
      );
      if (deliveredAfter) return "delivered_after_failure";
    }
    const newerRun = input.runs.some((other) =>
      other.runId !== run.runId &&
      (other.status === "completed" || other.status === "running") &&
      other.chosenDomain &&
      normalizeDomain(other.chosenDomain) === domain &&
      (other.updatedAt ?? "") > failedAt
    );
    if (newerRun) return "newer_completed_run";
    return null;
  };

  const failedRuns: RunStateIntegrityReport["failedRuns"] = [];
  const supersededFailedRuns: RunStateIntegrityReport["supersededFailedRuns"] = [];
  for (const run of input.runs) {
    if (run.status !== "failed") continue;
    const reason = supersededReason(run);
    const entry = { runId: run.runId, ...(run.chosenDomain ? { chosenDomain: run.chosenDomain } : {}) };
    if (reason) {
      supersededFailedRuns.push({ ...entry, reason });
    } else {
      failedRuns.push(entry);
    }
  }

  const cancelledRuns = input.runs
    .filter((run) => run.status === "cancelled_by_operator")
    .map((run) => ({ runId: run.runId, ...(run.chosenDomain ? { chosenDomain: run.chosenDomain } : {}) }));

  const ok = domainsWithoutRun.length === 0 && failedRuns.length === 0;

  return {
    domainsWithoutRun,
    failedRuns,
    supersededFailedRuns,
    cancelledRuns,
    totals: {
      runs: input.runs.length,
      sendingDomains: sendingDomains.size,
      domainsWithoutRun: domainsWithoutRun.length,
      failedRuns: failedRuns.length
    },
    ok,
    summary: buildSummary(domainsWithoutRun, failedRuns.length, cancelledRuns.length, supersededFailedRuns.length)
  };
}

function buildSummary(domainsWithoutRun: string[], failed: number, cancelled: number, superseded: number): string {
  const supersededNote = superseded > 0
    ? ` (${superseded} run(s) failed superseded por entrega/run posterior, no bloqueante.)`
    : "";
  if (domainsWithoutRun.length === 0 && failed === 0) {
    const base = cancelled > 0
      ? `Run-state íntegro: cada dominio que envía tiene run. (${cancelled} run(s) cancelado(s) por operador, no bloqueante.)`
      : "Run-state íntegro: cada dominio que envía tiene run y ningún run falló.";
    return `${base}${supersededNote}`;
  }
  const parts: string[] = [];
  if (domainsWithoutRun.length > 0) {
    parts.push(`${domainsWithoutRun.length} dominio(s) ENVÍAN SIN RUN: ${domainsWithoutRun.join(", ")}`);
  }
  if (failed > 0) parts.push(`${failed} run(s) en estado failed (limpiar/reintentar)`);
  return `${parts.join(" · ")}${supersededNote}`;
}
