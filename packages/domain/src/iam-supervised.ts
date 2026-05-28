import type { AuditEvent, AuditRiskLevel } from "./audit-log.ts";
import { buildRealTimeMeta, type RealTimeMeta } from "./realtime-meta.ts";

/**
 * IAM supervisado — contrato GET-only para alimentar `Roles` y `Sesiones activas`
 * en la sección Seguridad del admin panel.
 *
 * Reglas:
 *   - Solo lectura. No promociona, no autoriza, no abre sesiones.
 *   - Los datos son canónicos del MVP: 4 roles + 3 sesiones representativas.
 *   - Las marcas de tiempo se calculan relativas a `now()` para que la UI
 *     muestre etiquetas tipo "hace 7 m" en cualquier momento sin congelarse.
 */

export type IamRoleColor = "amber" | "green" | "blue" | "violet" | "neutral";

export interface IamRole {
  id: string;
  name: string;
  displayName: string;
  color: IamRoleColor;
  userCount: number;
  permissions: string[];
  countDerivedFrom?: string;
}

export interface IamRolesContract {
  roles: IamRole[];
  meta: RealTimeMeta;
}

export interface IamRolesSource {
  auditEvents?: AuditEvent[];
  now?: Date;
}

const ROLES: readonly IamRole[] = Object.freeze([
  {
    id: "operator",
    name: "Operador",
    displayName: "Operador supervisado (sólo lectura)",
    color: "amber",
    userCount: 4,
    permissions: [
      "read:admin/overview",
      "read:openclaw/canvas",
      "read:openclaw/learning-plan",
      "read:operating-north",
      "read:audit-events"
    ]
  },
  {
    id: "sre",
    name: "SRE",
    displayName: "SRE",
    color: "green",
    userCount: 2,
    permissions: [
      "read:hardware/telemetry/latest",
      "read:hardware/telemetry/history",
      "read:devops/collector/status",
      "read:devops/collector/supervised-plan",
      "read:kill-switch"
    ]
  },
  {
    id: "external-auditor",
    name: "Auditor externo",
    displayName: "Auditor externo",
    color: "blue",
    userCount: 1,
    permissions: ["read:audit-events", "read:compliance/status"]
  },
  {
    id: "read-only",
    name: "Sólo lectura",
    displayName: "Sólo lectura",
    color: "violet",
    userCount: 5,
    permissions: ["read:admin/overview"]
  }
] as const);

export function buildIamRoles(source: IamRolesSource = {}): IamRolesContract {
  const now = source.now ?? new Date();
  const events = source.auditEvents;

  if (!events?.length) {
    return fallbackIamRoles(now);
  }

  const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const events30d = events.filter((event) => occurredAtMs(event) >= thirtyDaysAgo);
  const operatorIds = distinctActorIds(events30d, (event) =>
    event.actorType === "operator" &&
    (event.action.startsWith("oc.proposal.approved") || /^oc\.runbook\.[a-z0-9_]+\.executed$/.test(event.action))
  );
  const sreIds = distinctActorIds(events30d, (event) =>
    event.actorType === "system" &&
    (event.action.startsWith("oc.skill.") || event.evidenceRefs?.some((ref) => ref.includes("/v1/hardware/")) === true)
  );
  const externalAuditorIds = externalAuditors(events30d);

  return {
    roles: cloneRoles(ROLES).map((role) => {
      if (role.id === "operator") {
        return {
          ...role,
          userCount: operatorIds.size,
          countDerivedFrom: "audit log 30d, oc.proposal.approved + oc.runbook.*.executed"
        };
      }
      if (role.id === "sre") {
        return {
          ...role,
          userCount: sreIds.size,
          countDerivedFrom: "audit log 30d, actorType=system, oc.skill.* + /v1/hardware/* evidence"
        };
      }
      if (role.id === "external-auditor") {
        return {
          ...role,
          userCount: externalAuditorIds.size,
          countDerivedFrom: "audit log 30d, operator actors whose only action is read:audit-events"
        };
      }
      return {
        ...role,
        userCount: 5,
        countDerivedFrom: "fixed MVP placeholder until IdP integration"
      };
    }),
    meta: buildRealTimeMeta({ dataSource: "live", now })
  };
}

export type IamSessionTransport = "vpn" | "internal" | "mfa";
export type IamSessionRisk = "low" | "medium" | "high";

export interface IamSession {
  actor: string;
  location: string;
  transport: IamSessionTransport;
  startedAt: string;
  lastSeenAt: string;
  risk: IamSessionRisk;
}

export interface IamSessionsContract {
  sessions: IamSession[];
  meta: RealTimeMeta;
}

export interface IamSessionsSource {
  auditEvents?: AuditEvent[];
  now?: Date;
}

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

export function buildIamSessions(input: Date | IamSessionsSource = new Date()): IamSessionsContract {
  if (input instanceof Date) {
    return fallbackIamSessions(input);
  }

  const now = input.now ?? new Date();
  const events = input.auditEvents;

  if (!events?.length) {
    return fallbackIamSessions(now);
  }

  const sessionsByKey = new Map<string, SessionAccumulator>();
  const fifteenMinutesAgo = now.getTime() - 15 * 60 * 1000;

  for (const event of events) {
    const eventMs = occurredAtMs(event);
    const metadata = event.metadata;
    const expiresAt = typeof metadata.expiresAt === "string" ? Date.parse(metadata.expiresAt) : Number.NaN;

    if (event.action === "oc.approval_token.issued" && Number.isFinite(expiresAt) && expiresAt > now.getTime()) {
      const actor = typeof metadata.approverId === "string" ? metadata.approverId : event.actorId;
      addSessionEvent(sessionsByKey, `token:${event.targetId}`, actor, "mfa", event, eventMs);
      continue;
    }

    if (eventMs < fifteenMinutesAgo) {
      continue;
    }

    if (event.actorType === "operator") {
      addSessionEvent(sessionsByKey, `operator:${event.actorId}`, event.actorId, "vpn", event, eventMs);
    }

    const sessionKey = typeof metadata.sessionKey === "string" ? metadata.sessionKey : null;
    if (sessionKey) {
      addSessionEvent(sessionsByKey, `session:${sessionKey}`, event.actorId, "internal", event, eventMs);
    }
  }

  const sessions = [...sessionsByKey.values()]
    .map((session) => ({
      actor: session.actor,
      location: session.location ?? "-",
      transport: session.transport,
      startedAt: new Date(session.startedAtMs).toISOString(),
      lastSeenAt: new Date(session.lastSeenAtMs).toISOString(),
      risk: riskFromScore(session.riskScoreTotal / session.riskScoreCount)
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

  return {
    sessions,
    meta: buildRealTimeMeta({ dataSource: "live", now })
  };
}

function fallbackIamRoles(now: Date): IamRolesContract {
  return {
    roles: cloneRoles(ROLES),
    meta: buildRealTimeMeta({ dataSource: "fallback", now })
  };
}

function cloneRoles(roles: readonly IamRole[]): IamRole[] {
  return roles.map((role) => ({ ...role, permissions: [...role.permissions] }));
}

function fallbackIamSessions(now: Date): IamSessionsContract {
  return {
    sessions: [
      {
        actor: "operador@delivrix",
        location: "Popayán · CO",
        transport: "vpn",
        startedAt: minutesAgo(now, 124),
        lastSeenAt: minutesAgo(now, 7),
        risk: "low"
      },
      {
        actor: "sre-01@delivrix",
        location: "Bogotá · CO",
        transport: "internal",
        startedAt: minutesAgo(now, 96),
        lastSeenAt: minutesAgo(now, 23),
        risk: "low"
      },
      {
        actor: "auditor-ext@delivrix",
        location: "Madrid · ES",
        transport: "mfa",
        startedAt: minutesAgo(now, 58),
        lastSeenAt: minutesAgo(now, 58),
        risk: "medium"
      }
    ],
    meta: buildRealTimeMeta({ dataSource: "fallback", now })
  };
}

interface SessionAccumulator {
  actor: string;
  location: string | null;
  transport: IamSessionTransport;
  startedAtMs: number;
  lastSeenAtMs: number;
  riskScoreTotal: number;
  riskScoreCount: number;
}

function addSessionEvent(
  sessionsByKey: Map<string, SessionAccumulator>,
  key: string,
  actor: string,
  transport: IamSessionTransport,
  event: AuditEvent,
  occurredAt: number
): void {
  const safeOccurredAt = Number.isFinite(occurredAt) ? occurredAt : Date.parse(event.occurredAt);
  const existing = sessionsByKey.get(key);
  const location = locationFromMetadata(event.metadata);
  const riskScore = riskScoreFor(event.riskLevel);

  if (!existing) {
    sessionsByKey.set(key, {
      actor,
      location,
      transport,
      startedAtMs: safeOccurredAt,
      lastSeenAtMs: safeOccurredAt,
      riskScoreTotal: riskScore,
      riskScoreCount: 1
    });
    return;
  }

  existing.startedAtMs = Math.min(existing.startedAtMs, safeOccurredAt);
  existing.lastSeenAtMs = Math.max(existing.lastSeenAtMs, safeOccurredAt);
  existing.location ??= location;
  existing.riskScoreTotal += riskScore;
  existing.riskScoreCount += 1;
}

function distinctActorIds(events: AuditEvent[], predicate: (event: AuditEvent) => boolean): Set<string> {
  const actorIds = new Set<string>();
  for (const event of events) {
    if (predicate(event)) {
      actorIds.add(event.actorId);
    }
  }
  return actorIds;
}

function externalAuditors(events30d: AuditEvent[]): Set<string> {
  const actionsByActor = new Map<string, Set<string>>();

  for (const event of events30d) {
    if (event.actorType !== "operator") {
      continue;
    }
    const actions = actionsByActor.get(event.actorId) ?? new Set<string>();
    actions.add(event.action);
    actionsByActor.set(event.actorId, actions);
  }

  const actorIds = new Set<string>();
  for (const [actorId, actions] of actionsByActor) {
    if (actions.size === 1 && actions.has("read:audit-events")) {
      actorIds.add(actorId);
    }
  }
  return actorIds;
}

function locationFromMetadata(metadata: Record<string, unknown>): string | null {
  const candidates = [metadata.location, metadata.region, metadata.ipRegion, metadata.ipAddress];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function riskScoreFor(riskLevel: AuditRiskLevel): number {
  if (riskLevel === "high" || riskLevel === "critical") {
    return 3;
  }
  if (riskLevel === "medium") {
    return 2;
  }
  return 1;
}

function riskFromScore(score: number): IamSessionRisk {
  if (score <= 1.5) {
    return "low";
  }
  if (score <= 2.3) {
    return "medium";
  }
  return "high";
}

function occurredAtMs(event: AuditEvent): number {
  const parsed = Date.parse(event.occurredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
