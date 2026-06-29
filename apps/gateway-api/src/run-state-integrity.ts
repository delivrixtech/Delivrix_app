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

export interface RunStateRun {
  runId: string;
  /** running | completed | failed | cancelled_by_operator | unknown */
  status: string;
  chosenDomain?: string;
}

export interface RunStateSend {
  /** Sending domain (e.g. from the From address of a real send). */
  domain: string;
  serverSlug?: string;
  occurredAt?: string;
}

export interface RunStateIntegrityReport {
  /** Domains that sent mail but have NO run of any status — the core defect. */
  domainsWithoutRun: string[];
  failedRuns: Array<{ runId: string; chosenDomain?: string }>;
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
    if (send.domain && send.domain.trim()) {
      sendingDomains.add(normalizeDomain(send.domain));
    }
  }

  const domainsWithoutRun = [...sendingDomains].filter((domain) => !runDomains.has(domain)).sort();

  const failedRuns = input.runs
    .filter((run) => run.status === "failed")
    .map((run) => ({ runId: run.runId, ...(run.chosenDomain ? { chosenDomain: run.chosenDomain } : {}) }));

  const cancelledRuns = input.runs
    .filter((run) => run.status === "cancelled_by_operator")
    .map((run) => ({ runId: run.runId, ...(run.chosenDomain ? { chosenDomain: run.chosenDomain } : {}) }));

  const ok = domainsWithoutRun.length === 0 && failedRuns.length === 0;

  return {
    domainsWithoutRun,
    failedRuns,
    cancelledRuns,
    totals: {
      runs: input.runs.length,
      sendingDomains: sendingDomains.size,
      domainsWithoutRun: domainsWithoutRun.length,
      failedRuns: failedRuns.length
    },
    ok,
    summary: buildSummary(domainsWithoutRun, failedRuns.length, cancelledRuns.length)
  };
}

function buildSummary(domainsWithoutRun: string[], failed: number, cancelled: number): string {
  if (domainsWithoutRun.length === 0 && failed === 0) {
    return cancelled > 0
      ? `Run-state íntegro: cada dominio que envía tiene run. (${cancelled} run(s) cancelado(s) por operador, no bloqueante.)`
      : "Run-state íntegro: cada dominio que envía tiene run y ningún run falló.";
  }
  const parts: string[] = [];
  if (domainsWithoutRun.length > 0) {
    parts.push(`${domainsWithoutRun.length} dominio(s) ENVÍAN SIN RUN: ${domainsWithoutRun.join(", ")}`);
  }
  if (failed > 0) parts.push(`${failed} run(s) en estado failed (limpiar/reintentar)`);
  return parts.join(" · ");
}
