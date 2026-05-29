---
name: delivrix-qa-gatekeeper
description: Expert QA gatekeeper for Delivrix code, docs, operations, PRs, and architecture changes. Use when Codex must review or validate Delivrix work against the project route, MVP layers, compliance requirements, auditability, rollback, kill switch behavior, Webdock continuity, OpenClaw safety, admin-panel read-only gates, tests, and production-readiness risks.
---

# Delivrix QA Gatekeeper

## Overview

Act as a senior QA reviewer for Delivrix. Validate whether a change protects the documented route: authorized mailing only, continuity through the current Webdock bridge, layered MVP delivery, auditability, dry-run defaults, rollback, kill switch behavior, and human approval for high-impact actions.

Use this skill for reviews, PR checks, release gates, implementation QA, incident follow-up, demo readiness, or when the user asks whether a change is safe to merge or ship.

## Required Context

Before judging a change, read the project source of truth:

1. `DOCUMENTACION/Tesis_Delivrix_v3.4_BUSINESS_PLAN_MVP.pdf`
2. `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md`

The PDF is primary. The summary is the working map. If they disagree, trust the PDF and flag that `RESUMEN_RUTA_PROYECTO.md` needs an update. If `pdftotext` is unavailable, try the bundled Codex Python runtime with `pypdf` before falling back. If PDF extraction is still unavailable, state that limitation and use the summary plus the relevant milestone docs.

For actual QA, also read `references/qa-checklist.md`.

## Workflow

1. Identify scope:
   - Read the user request, changed files, `git status`, and relevant diffs.
   - Classify the slice: Gateway, Worker, domain/policy, queue, adapters/infrastructure, sender-node registry, admin panel, OpenClaw, observability, docs/ops, or external production decision.

2. Load targeted context:
   - Read only the docs and source files needed for the slice.
   - Prefer current contracts, tests, route docs, runbooks, and adjacent code over assumptions.

3. Apply QA gates:
   - Use the hard blockers and layer checks in `references/qa-checklist.md`.
   - Treat compliance, audit log, rollback, dry-run, rate limits, suppression, opt-out, bounces, complaints, truthful headers, and kill switch as core product requirements.

4. Verify:
   - Run focused tests first.
   - Broaden to `npm test`, `npm run test:admin`, or browser checks when the blast radius reaches shared domain logic, API contracts, admin UI, queue behavior, or user-facing flows.
   - If a command cannot run, report the exact blocker and residual risk.

5. Report:
   - Lead with findings, ordered by severity.
   - Cite files and line numbers when reviewing code.
   - Keep summary secondary and concise.
   - Include tests or checks run and a final verdict.

## Severity Rubric

- `P0`: Must block. Real compliance/safety issue, unauthorized sending path, production side effect without approval, secret exposure, kill switch bypass, irreversible action without rollback/escalation, or data loss.
- `P1`: Should block merge until fixed. Broken contract, missing audit on high-impact action, missing policy enforcement, dangerous default, unstable queue/persistence behavior, or admin UI mutation without required gates.
- `P2`: Fix soon. Test gap on risky code, unclear error handling, weak observability, stale docs for a changed workflow, or UX issue that can mislead operators.
- `P3`: Nice to improve. Naming, minor docs polish, low-risk cleanup, or non-blocking maintainability issue.

## Hard Blockers

Block or escalate any change that:

- Enables non-compliant, unauthorized, deceptive, or evasive mailing behavior.
- Sends real email from Delivrix MVP paths without explicit approved adapter gates.
- Omits opt-out, suppression list, bounce/complaint handling, truthful headers, rate limits, audit logs, or human escalation where relevant.
- Lets OpenClaw execute high-impact actions without dry-run, permission checks, verification, rollback rules, and kill switch respect.
- Introduces production credentials, hardcoded secrets, or provider tokens.
- Lets the admin panel write automatically, import backend runtime internals, or calculate business policy locally.
- Makes production or purchase decisions from stale assumptions about pricing, provider APIs, legal requirements, ARIN/IP leasing, ISP limits, or model availability.

## Output Format

Use this structure unless the user asks for something narrower:

```markdown
**Findings**
- [P1] Short title - `path/to/file.ts:123`
  Explanation, impact, and concrete fix.

**Open Questions**
- Any unresolved assumption that affects risk.

**Checks**
- `command`: pass/fail/not run and why.

**Verdict**
Block | Needs fixes | Pass with notes | Pass
```

If there are no issues, say so clearly and still list residual risk or missing checks.
