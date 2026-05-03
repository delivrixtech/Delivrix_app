import { createId } from "./ids.ts";

export type BackupTargetKind = "local-dry-run" | "s3-compatible";
export type BackupPlanStatus = "planned";
export type BackupSimulationStatus = "simulated" | "blocked";
export type BackupResource =
  | "audit_events"
  | "sender_nodes"
  | "send_jobs"
  | "send_results"
  | "suppression_entries"
  | "rate_limit_counters"
  | "provisioning_runs"
  | "ip_reputation_reports";

export interface BackupPlanInput {
  targetKind?: BackupTargetKind;
  bucket?: string;
  prefix?: string;
  resources?: BackupResource[];
  retentionDays?: number;
  encryptionRequired?: boolean;
}

export interface BackupPlan {
  id: string;
  status: BackupPlanStatus;
  generatedAt: string;
  dryRun: true;
  sideEffects: "none";
  target: {
    kind: BackupTargetKind;
    bucket?: string;
    prefix: string;
    encryptionRequired: boolean;
  };
  resources: BackupResource[];
  retentionDays: number;
  checks: string[];
  blockedOperations: string[];
}

export interface BackupResourceSnapshot {
  resource: BackupResource;
  count: number;
  source: string;
}

export interface BackupSimulation {
  id: string;
  planId: string;
  generatedAt: string;
  status: BackupSimulationStatus;
  dryRun: true;
  sideEffects: "none";
  snapshots: BackupResourceSnapshot[];
  warnings: string[];
  plan: BackupPlan;
}

export const defaultBackupResources: BackupResource[] = [
  "audit_events",
  "sender_nodes",
  "send_jobs",
  "send_results",
  "suppression_entries",
  "rate_limit_counters",
  "provisioning_runs",
  "ip_reputation_reports"
];

export function buildBackupPlan(input: BackupPlanInput = {}, now = new Date()): BackupPlan {
  const targetKind = input.targetKind ?? "local-dry-run";
  const bucket = input.bucket?.trim() || undefined;
  const prefix = input.prefix?.trim() || "delivrix/mailops";
  const retentionDays = input.retentionDays ?? 30;
  const encryptionRequired = input.encryptionRequired ?? true;
  const resources = input.resources?.length ? uniqueResources(input.resources) : defaultBackupResources;

  if (targetKind === "s3-compatible" && !bucket) {
    throw new Error("Backup bucket is required for s3-compatible targets.");
  }

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("Backup retentionDays must be > 0.");
  }

  return {
    id: createId("backup_plan"),
    status: "planned",
    generatedAt: now.toISOString(),
    dryRun: true,
    sideEffects: "none",
    target: {
      kind: targetKind,
      bucket,
      prefix,
      encryptionRequired
    },
    resources,
    retentionDays,
    checks: [
      "backup_is_dry_run_only",
      "restore_procedure_must_be_tested_before_production",
      "secrets_are_not_exported",
      "audit_events_remain_append_only",
      "s3_credentials_not_configured_in_code"
    ],
    blockedOperations: [
      "s3-put-object",
      "s3-delete-object",
      "database-dump-live",
      "secret-export",
      "restore-overwrite"
    ]
  };
}

export function simulateBackup(
  plan: BackupPlan,
  snapshots: BackupResourceSnapshot[],
  now = new Date()
): BackupSimulation {
  const missingResources = plan.resources.filter(
    (resource) => !snapshots.some((snapshot) => snapshot.resource === resource)
  );

  return {
    id: createId("backup_simulation"),
    planId: plan.id,
    generatedAt: now.toISOString(),
    status: missingResources.length > 0 ? "blocked" : "simulated",
    dryRun: true,
    sideEffects: "none",
    snapshots,
    warnings: missingResources.map((resource) => `Missing snapshot count for ${resource}.`),
    plan
  };
}

function uniqueResources(resources: BackupResource[]): BackupResource[] {
  return [...new Set(resources)];
}
