# Delivrix QA Checklist

Use this reference when `delivrix-qa-gatekeeper` performs a real review or release gate.

## Project Route

Validate every change against this route:

1. Preserve operational continuity with the current Webdock bridge.
2. Build the MVP in layers: Gateway, Worker, data model, sender-node registry, monitoring, admin panel, then OpenClaw autonomy.
3. Treat infrastructure, reputation, compliance, auditability, rollback, and kill-switch behavior as first-class requirements.
4. Verify current external facts before purchases or production decisions.
5. Support only compliant, authorized mailing workflows.

## Global Gates

- Source of truth: read the PDF and route summary before approving architecture or high-impact changes.
- Safety by default: dry-run first, real side effects only behind explicit adapters, permissions, and approvals.
- Auditability: high-impact actions must write append-only audit events with actor, target, reason, outcome, and correlation id.
- Rollback: reversible actions need rollback paths; irreversible actions need escalation and explicit human approval.
- Secrets: no hardcoded credentials, tokens, production host keys, private keys, or live provider secrets.
- Tests: risky domain rules, queues, persistence, contracts, and UI workflows need tests proportional to blast radius.
- Docs: each milestone slice should state what changed, how to run it, and what remains mocked.

## Gateway API

- Validate DTOs at the boundary. Reject malformed, unsafe, or unauthorized inputs before queueing work.
- Keep `/v1/...` contracts stable and versioned when UI/OpenClaw consumes them.
- Separate read-only endpoints from mutating endpoints.
- Enforce policy engine, budgets, rate limits, authorization, kill switch, and compliance gates server-side.
- Return typed errors with actionable reasons; do not leak secrets or internal stack traces.
- Emit audit events for approvals, rejections, kill-switch changes, proposal submissions, adapter calls, and policy denials.

## Worker And Queues

- Use idempotent job handlers with deterministic dedupe keys where repeats are plausible.
- Model retries, backoff, dead-letter behavior, stuck-job recovery, and partial failure reporting.
- Never hide real side effects in generic helpers. Use explicit adapters and gates.
- Preserve job correlation through audit logs, result tracking, and UI/API responses.
- Do not send real mail from MVP worker paths unless the approved phase and adapter gates explicitly allow it.

## Domain And Mail Policy

- Require authorized mailing context. No deceptive, evasive, or non-consensual flows.
- Enforce opt-out, suppression list, bounce and complaint processing, truthful headers, physical address where required, and traceability.
- Apply per-domain, per-IP, per-campaign, warmup, budget, and reputation rate limits.
- Pause, degrade, or quarantine when metrics cross configured thresholds.
- Escalate high-impact policy changes to a human.

## Sender Nodes And Adapters

- Keep sender-node state explicit: planned, warming, active, degraded, paused, quarantined, retired.
- Cross-check Webdock bridge reality against local registry and report drift.
- DNS, Proxmox, Postfix, OpenDKIM, TLS, PTR, SPF, DKIM, and DMARC changes must support dry-run or clear approval gates.
- IP/domain reputation, blacklist checks, bounce rates, complaints, and warming day must govern capacity.
- External provider/API/price/ISP/ARIN facts must be freshly verified before production or purchase decisions.

## OpenClaw

- Default to no live side effects. LLM use should be routed, scoped, and optional.
- Enforce scheduler, skills, LLM router, action executor, immutable audit log, dry-run, verification, rollback, and kill switch.
- High-impact actions need human approval and permission checks.
- Proposed actions should be typed, deduped, rate-limited, and backed by evidence.
- A failed kill-switch read is critical until proven otherwise.
- Do not allow autonomous SSH, provider, DNS, Proxmox, or mail-sending actions without explicit gates.

## Admin Panel

- Frontend consumes Gateway contracts. It must not import backend runtime, stores, adapters, or local `runtime/` data directly.
- First MVP screens are `GET`-only until auth, authorization, approval, audit, and mutating contracts exist.
- No `POST`, `PUT`, `PATCH`, or `DELETE` should run automatically on page load.
- Business decisions, permissions, policy, and kill-switch state are backend-owned.
- UI must show source freshness, mock/live source markers, degraded states, pending approval, and kill-switch status.
- Significant frontend changes need responsive checks and, when practical, browser verification.

## Observability And Operations

- Health checks should cover gateway, worker, Redis/BullMQ, PostgreSQL, adapters, Webdock bridge, and admin-panel contract availability.
- Metrics should expose queues, failures, bounces, complaints, reputation state, sender-node capacity, stale telemetry, and proposal/action outcomes.
- Alerts must distinguish expected MVP gates from urgent failures.
- Backups, S3 usage, Secrets Manager, and Route 53 operations require audit and recovery notes.

## Docs And Milestones

- Keep milestone docs aligned with implemented behavior.
- Record what is mocked, simulated, read-only, or future-gated.
- Update runbooks when an operational path, approval flow, rollback, kill switch, or incident response changes.
- Do not present demo capacity as production readiness unless the gates and evidence support it.

## External Or Production Decisions

Before recommending purchase, production rollout, provider migration, model choice, API availability, legal interpretation, ISP restriction, ARIN/IP leasing step, or pricing assumption:

- Verify with current official/provider sources.
- Include the date of verification.
- Distinguish facts from assumptions.
- Keep AWS role clear: support services only; AWS does not send mail in this architecture.
