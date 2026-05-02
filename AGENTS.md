# Delivrix Project Instructions

## Source of truth

Before planning, coding, reviewing, or changing architecture, read the project documentation first:

- `DOCUMENTACION/Tesis_Delivrix_v3.4_BUSINESS_PLAN_MVP.pdf`
- `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md`

Use the PDF as the primary source of truth and the summary as the fast working map. If they disagree, trust the PDF and update the summary.

## Working rule

Every task should be interpreted through the project route:

1. Preserve operational continuity with the current Webdock bridge.
2. Build the MVP in layers: Gateway, Worker, data model, sender-node registry, monitoring, admin panel, then OpenClaw autonomy.
3. Treat infrastructure, reputation, compliance, auditability, rollback, and kill-switch behavior as first-class requirements.
4. Verify current external facts before purchase or production decisions: provider pricing, API/model availability, legal/compliance requirements, ISP restrictions, ARIN/IP leasing details.
5. Support only compliant, authorized mailing workflows. Product work must include opt-out handling, suppression lists, bounce/complaint processing, truthful headers, rate limits, audit logs, and human escalation for high-impact actions.

## Technical direction from documentation

- Backend: NestJS, Node 20, TypeScript.
- Queues: Redis + BullMQ.
- Database: PostgreSQL.
- Frontend: React + Tailwind CSS.
- Sender layer: Postfix + OpenDKIM on virtualized VPS/LXC nodes.
- Host infrastructure: Ubuntu Server 24.04 LTS + Proxmox VE 8.
- Support services: AWS Route 53, Secrets Manager, S3. AWS does not send mail.
- AI operations: OpenClaw agent with scheduler, skills, LLM router, action executor, immutable audit log, dry-run, verification, rollback, and kill switch.

## Default delivery posture

Prefer small, verifiable increments. For each implemented slice, include tests or operational checks proportional to risk, and keep the implementation aligned with the 30-day MVP route.

## Engineering standards

Work as a senior full-stack engineer:

- Design before scaling: keep clear module boundaries, stable contracts, and replaceable adapters.
- Prefer boring, proven architecture over clever shortcuts.
- Keep compliance, security, observability, auditability, and rollback in the core path.
- Do not hide complexity inside vague helpers; make domain rules explicit and testable.
- Add tests for policy, queue, persistence, and high-risk behavior before expanding volume.
- Avoid hardcoded secrets, production credentials, or irreversible automation in code.
- Keep development modes safe by default: dry-run first, real side effects only behind explicit adapters and gates.
- Document every milestone with what changed, how to run it, and what remains intentionally mocked.
