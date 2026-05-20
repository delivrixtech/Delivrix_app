import { createHash } from "node:crypto";
import type { AuditEvent } from "./audit-log.ts";
import { buildRealTimeMeta, type RealTimeMeta } from "./realtime-meta.ts";

/**
 * OpenClaw skills audit + evidence — contratos GET-only que alimentan
 * la "Bitácora del aprendizaje" y la tabla "Evidencia curada por OpenClaw"
 * en la sección Aprendizaje supervisado.
 *
 * Los identificadores mock (sha256:fa07…, snap-7f2a91c4) siguen como fallback
 * estable cuando el audit log no trae eventos aprovechables.
 */

export interface OpenClawSkillsAuditEvent {
  id: string;
  occurredAt: string;
  action: string;
  actor: string;
  body: string;
  skillId?: string;
  lessonId?: string;
}

export interface OpenClawSkillsAuditContract {
  events: OpenClawSkillsAuditEvent[];
  meta: RealTimeMeta;
}

export interface OpenClawLearningRealtimeInput {
  auditEvents?: AuditEvent[];
  now?: Date;
}

function isoMinusMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

export function buildOpenClawSkillsAudit(input: OpenClawLearningRealtimeInput | Date = new Date()): OpenClawSkillsAuditContract {
  const { auditEvents, now } = normalizeInput(input);
  const events = auditEvents
    ?.filter(isSkillsAuditCandidate)
    .toSorted(sortByOccurredAtDesc)
    .slice(0, 50)
    .map(toSkillsAuditEvent) ?? [];

  if (events.length === 0) {
    return {
      events: fallbackSkillsAuditEvents(now),
      meta: buildRealTimeMeta({ dataSource: "fallback", now })
    };
  }

  return {
    events,
    meta: buildRealTimeMeta({ dataSource: "live", now })
  };
}

export type OpenClawEvidenceImpact = "alto" | "medio" | "bajo";

export interface OpenClawEvidenceItem {
  snapshotId: string;
  type: string;
  description: string;
  actor: string;
  capturedAt: string;
  mode: "get-only";
  impact: OpenClawEvidenceImpact;
}

export interface OpenClawEvidenceContract {
  curated: OpenClawEvidenceItem[];
  meta: RealTimeMeta;
}

export function buildOpenClawEvidence(input: OpenClawLearningRealtimeInput | Date = new Date()): OpenClawEvidenceContract {
  const { auditEvents, now } = normalizeInput(input);
  const seen = new Set<string>();
  const curated = auditEvents
    ?.filter((event) => (event.evidenceRefs?.length ?? 0) > 0)
    .toSorted(sortByOccurredAtDesc)
    .filter((event) => {
      const key = evidenceDedupKey(event);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 20)
    .map(toEvidenceItem) ?? [];

  if (curated.length === 0) {
    return {
      curated: fallbackEvidenceItems(),
      meta: buildRealTimeMeta({ dataSource: "fallback", now })
    };
  }

  return {
    curated,
    meta: buildRealTimeMeta({ dataSource: "live", now })
  };
}

function normalizeInput(input: OpenClawLearningRealtimeInput | Date): Required<OpenClawLearningRealtimeInput> {
  if (input instanceof Date) {
    return {
      auditEvents: [],
      now: input
    };
  }

  return {
    auditEvents: input.auditEvents ?? [],
    now: input.now ?? new Date()
  };
}

function fallbackSkillsAuditEvents(now: Date): OpenClawSkillsAuditEvent[] {
  return [
    {
      id: "sha256:fa07b3c2",
      occurredAt: isoMinusMinutes(now, 4),
      action: "lesson.review.queued",
      actor: "openclaw",
      body: "Curated lesson 'IP transactional EU' lista para revisión humana",
      lessonId: "lesson-2026-05-14-04",
      skillId: "skill.curate"
    },
    {
      id: "sha256:33de44ef",
      occurredAt: isoMinusMinutes(now, 18),
      action: "skill.evaluation.scheduled",
      actor: "openclaw-eval",
      body: "Habilidad 'Pausar IP caliente' programada para panel humano",
      skillId: "skill.pause-ip"
    },
    {
      id: "sha256:7d419f1a",
      occurredAt: isoMinusMinutes(now, 42),
      action: "skill.dry-run.completed",
      actor: "openclaw",
      body: "10 ejecuciones sintéticas estables · escenario clúster A",
      skillId: "skill.pause-ip"
    },
    {
      id: "sha256:1c92cd03",
      occurredAt: isoMinusMinutes(now, 96),
      action: "skill.threshold.updated",
      actor: "openclaw-auto",
      body: "Detectar drift DNS actualiza umbral a 87% (con aval humano)",
      skillId: "skill.dns-drift"
    },
    {
      id: "sha256:b0f1ad12",
      occurredAt: isoMinusMinutes(now, 184),
      action: "evidence.curated",
      actor: "operador@delivrix",
      body: "Operador marca DNS delivrix.io como 'pendiente de propagación'",
      skillId: "skill.curate"
    }
  ];
}

function fallbackEvidenceItems(): OpenClawEvidenceItem[] {
  return [
    {
      snapshotId: "snap-7f2a91c4",
      type: "DNS drift",
      description: "Zona delivrix.io con SPF/DKIM en derivación",
      actor: "operador@delivrix",
      capturedAt: "2026-05-14",
      mode: "get-only",
      impact: "alto"
    },
    {
      snapshotId: "snap-7e44ab21",
      type: "Promo skill",
      description: "Habilidad 'Recomendar degradación' propone reducir warming",
      actor: "openclaw-eval",
      capturedAt: "2026-05-14",
      mode: "get-only",
      impact: "alto"
    },
    {
      snapshotId: "snap-b0f1ad12",
      type: "Evidencia humana",
      description: "Operador marca DNS como 'pendiente de propagación'",
      actor: "operador@delivrix",
      capturedAt: "2026-05-14",
      mode: "get-only",
      impact: "medio"
    },
    {
      snapshotId: "snap-1c92cd03",
      type: "Promoción",
      description: "Detectar drift DNS actualiza umbral a 87%",
      actor: "openclaw-auto",
      capturedAt: "2026-05-13",
      mode: "get-only",
      impact: "medio"
    },
    {
      snapshotId: "snap-33de44ef",
      type: "Evaluación",
      description: "Regla de pausa enviada a panel de revisión humana",
      actor: "openclaw-eval",
      capturedAt: "2026-05-13",
      mode: "get-only",
      impact: "bajo"
    },
    {
      snapshotId: "snap-fa07b3c2",
      type: "Curated lesson",
      description: "IP 185.243.12.031 etiquetada como transactional EU",
      actor: "operador@delivrix",
      capturedAt: "2026-05-12",
      mode: "get-only",
      impact: "bajo"
    }
  ];
}

function isSkillsAuditCandidate(event: AuditEvent): boolean {
  return event.actorType === "openclaw"
    || event.action.startsWith("oc.skill.")
    || event.action === "oc.proposal.submitted"
    || event.action === "oc.proposal.approved"
    || event.action === "oc.proposal.resolved";
}

function toSkillsAuditEvent(event: AuditEvent): OpenClawSkillsAuditEvent {
  const skillId = metadataString(event.metadata, "skillSlug") ?? extractSkillFromAction(event.action);
  const lessonId = metadataString(event.metadata, "lessonId");

  return {
    id: event.id,
    occurredAt: event.occurredAt,
    action: event.action,
    actor: event.actorId,
    body: deriveBody(event),
    ...(skillId ? { skillId } : {}),
    ...(lessonId ? { lessonId } : {})
  };
}

function toEvidenceItem(event: AuditEvent): OpenClawEvidenceItem {
  const evidenceRef = event.evidenceRefs?.[0];

  return {
    snapshotId: evidenceRef ? shortHash(evidenceRef) : `snap-${event.id.slice(0, 8)}`,
    type: deriveType(event),
    description: deriveBody(event),
    actor: event.actorId,
    capturedAt: event.occurredAt.slice(0, 10),
    mode: "get-only",
    impact: deriveImpact(event)
  };
}

function deriveBody(event: AuditEvent): string {
  const meta = event.metadata;

  switch (event.action) {
    case "oc.skill.fleet_ops.invoke":
      return `Skill fleet_ops invocada · ${metadataNumber(meta, "endpointsOk")}/${metadataNumber(meta, "endpointsTotal")} endpoints OK · ${metadataNumber(meta, "driftCount")} drift`;
    case "oc.skill.fleet_ops.proposal":
      return "Skill fleet_ops emitió propuesta de runbook";
    case "oc.skill.publish_proposal.invoke":
      return `Skill publish_proposal invocada para ${metadataString(meta, "runbookId", "unknown")} sobre ${metadataString(meta, "targetRef", "unknown")}`;
    case "oc.skill.publish_proposal.completed": {
      const proposalId = metadataString(meta, "proposalId", "unknown");
      return `Propuesta inyectada en Canvas · proposalId=${proposalId.slice(-16)}`;
    }
    case "oc.proposal.submitted":
      return `OpenClaw propuso ${metadataString(meta, "category", "unknown")} sobre ${metadataString(meta, "targetRef", "unknown")} · severity ${metadataString(meta, "severity", "unknown")}`;
    case "oc.proposal.approved":
      return `${event.actorId} aprobó propuesta · target ${metadataString(meta, "targetRef", "unknown")}`;
    case "oc.proposal.resolved":
      return `Propuesta resuelta: ${metadataString(meta, "decision", "unknown")}`;
    default:
      return `${event.action} · ${event.actorId}`;
  }
}

function deriveType(event: AuditEvent): string {
  const category = metadataString(event.metadata, "category", "");
  const endpointsOk = metadataNumber(event.metadata, "endpointsOk");
  const endpointsTotal = metadataNumber(event.metadata, "endpointsTotal");

  if (event.action === "oc.proposal.submitted" && (category === "node_pause_proposed" || category.includes("quarantine"))) {
    return "Promo skill";
  }

  if (event.action === "oc.skill.fleet_ops.invoke" && metadataNumber(event.metadata, "driftCount") > 0) {
    return event.evidenceRefs?.some((ref) => ref.toLowerCase().includes("webdock")) ? "Webdock drift" : "DNS drift";
  }

  if (event.action === "oc.proposal.approved") {
    return "Evidencia humana";
  }

  if (/^oc\.runbook\..+\.executed$/.test(event.action)) {
    return "Promoción";
  }

  if (event.action.startsWith("oc.skill.") && endpointsTotal > 0 && endpointsOk < endpointsTotal) {
    return "Evaluación";
  }

  return "Curated lesson";
}

function deriveImpact(event: AuditEvent): OpenClawEvidenceImpact {
  const severity = metadataString(event.metadata, "severity", "");

  if (event.riskLevel === "high" || event.riskLevel === "critical" || severity === "critical") {
    return "alto";
  }

  if (severity === "high") {
    return "medio";
  }

  return "bajo";
}

function extractSkillFromAction(action: string): string | undefined {
  if (!action.startsWith("oc.skill.")) {
    return undefined;
  }

  const [, , skill] = action.split(".");
  return skill ? `skill.${skill}` : undefined;
}

function evidenceDedupKey(event: AuditEvent): string {
  return metadataString(event.metadata, "proposalHash") ?? event.evidenceRefs?.[0] ?? event.id;
}

function shortHash(value: string): string {
  return `snap-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

function sortByOccurredAtDesc(a: AuditEvent, b: AuditEvent): number {
  return timestampOf(b.occurredAt) - timestampOf(a.occurredAt);
}

function timestampOf(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined;
function metadataString(metadata: Record<string, unknown>, key: string, fallback: string): string;
function metadataString(metadata: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}
