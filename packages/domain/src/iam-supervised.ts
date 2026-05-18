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
  color: IamRoleColor;
  userCount: number;
  permissions: string[];
}

export interface IamRolesContract {
  roles: IamRole[];
}

const ROLES: readonly IamRole[] = Object.freeze([
  {
    id: "operator",
    name: "Operador",
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
    color: "blue",
    userCount: 1,
    permissions: ["read:audit-events", "read:compliance/status"]
  },
  {
    id: "read-only",
    name: "Sólo lectura",
    color: "violet",
    userCount: 5,
    permissions: ["read:admin/overview"]
  }
] as const);

export function buildIamRoles(): IamRolesContract {
  return { roles: ROLES.map((r) => ({ ...r, permissions: [...r.permissions] })) };
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
}

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

export function buildIamSessions(now: Date = new Date()): IamSessionsContract {
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
    ]
  };
}
