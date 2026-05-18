/**
 * OpenClaw skills audit + evidence — contratos GET-only que alimentan
 * la "Bitácora del aprendizaje" y la tabla "Evidencia curada por OpenClaw"
 * en la sección Aprendizaje supervisado.
 *
 * Los identificadores (sha256:fa07…, snap-7f2a91c4) son representaciones
 * estables tomadas de las decisiones humanas del MVP, no son aleatorios:
 * mantenerlos permite enlazar evidencia con el plan dry-run sin tocar el
 * panel.
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
}

function isoMinusMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

export function buildOpenClawSkillsAudit(now: Date = new Date()): OpenClawSkillsAuditContract {
  return {
    events: [
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
    ]
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
}

export function buildOpenClawEvidence(): OpenClawEvidenceContract {
  return {
    curated: [
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
    ]
  };
}
