export const C2_PERMISSION_CATEGORIES = [
  "allowed_read_only",
  "allowed_dry_run",
  "supervised_local_state",
  "future_live_requires_new_phase",
  "prohibited"
];

export const C2_MATRIX_ACTIONS = [
  "read_health",
  "read_admin_clusters",
  "read_admin_overview",
  "read_admin_workflow",
  "read_collector_snapshot_ingestion",
  "read_collector_status",
  "read_collector_supervised_plan",
  "read_hardware_physical_host",
  "read_hardware_telemetry_history",
  "read_hardware_telemetry_latest",
  "read_openclaw_learning_plan",
  "read_openclaw_live_canvas",
  "read_openclaw_onboarding_state",
  "read_openclaw_provisioning_state",
  "read_openclaw_readiness_signals",
  "read_operating_north",
  "read_kill_switch",
  "read_audit_events",
  "read_sender_nodes",
  "read_ip_reputation_reports",
  "read_send_results",
  "read_delivery_reason",
  "read_stuck_jobs",
  "read_operational_summary",
  "read_iam_roles",
  "read_iam_sessions",
  "read_compliance_status",
  "read_openclaw_skills_audit",
  "read_openclaw_evidence",
  "read_infrastructure_inventory",
  "read_webdock_inventory",
  "read_webdock_servers",
  "list_conversations",
  "read_conversation",
  "propose_warming_step",
  "propose_pause_ip",
  "propose_quarantine",
  "propose_rotate_dns",
  "propose_register_sender_node",
  "propose_postfix_config",
  "propose_topology_plan",
  "propose_provisioning_plan",
  "generate_daily_report",
  "evaluate_webdock_drift",
  "register_sender_node_local",
  "update_sender_node_metadata",
  "mark_evidence_curated",
  "snooze_proposal",
  "record_human_decision",
  "proxmox_live_create_vps",
  "proxmox_live_destroy_vps",
  "webdock_create_server",
  "webdock_destroy_server",
  "webdock_snapshot_restore",
  "dns_live_change",
  "dns_record_delete",
  "smtp_send_real_email",
  "postfix_apply_live_config",
  "tls_cert_renew_live",
  "ssh_root_access",
  "ssh_exec_command",
  "smtp_send_to_unconfirmed_recipient",
  "nfc_production_write",
  "nfc_activate_bridge",
  "ip_rotation_to_sustain_volume_after_reputation_event",
  "plaintext_smtp_credentials_in_production",
  "write_secrets_to_repo",
  "bypass_kill_switch",
  "export_pii_outside_audit",
  "auto_self_promote_ml_model",
  "purge_remote_queue"
];

const C2_CANONICAL_TOKENS = [...C2_PERMISSION_CATEGORIES, ...C2_MATRIX_ACTIONS];
const C2_CANONICAL_TOKEN_SET = new Set(C2_CANONICAL_TOKENS);

export type C2NorteGateCheck = {
  label: string;
  test: (text: string) => boolean;
};

export function includesC2PermissionCategory(text: string, category: string): boolean {
  const normalized = normalizeC2Text(text);
  if (normalized.includes(category)) {
    return true;
  }
  return normalized.includes(category.replace(/_/g, " "));
}

export function detectC2HallucinationsByPattern(
  response: string,
  options: { norteGateChecks?: C2NorteGateCheck[] } = {}
): string[] {
  const candidates: string[] = [];
  const lines = response.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    for (const token of normalizeC2Text(trimmed).match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g) ?? []) {
      if (!isKnownCanonicalToken(token) && looksLikePermissionToken(token)) {
        candidates.push(`line ${index + 1}: unknown permission/category token "${token}"`);
      }
    }

    if (!options.norteGateChecks?.length) {
      continue;
    }

    const normalizedLine = normalizeC2Text(trimmed);
    const isGateLike = /^[-*]|\d+\./.test(trimmed) &&
      /\b(no hay|no se|nunca|prohibid|bloquead|gate|debe bloquear|requiere aprobacion|sin aprobacion)\b/.test(normalizedLine);
    if (!isGateLike) {
      continue;
    }

    const matchesNorte = options.norteGateChecks.some((check) => check.test(normalizedLine));
    const matchesCategory = C2_PERMISSION_CATEGORIES.some((category) => includesC2PermissionCategory(normalizedLine, category));
    const matchesMatrixAction = C2_MATRIX_ACTIONS.some((action) => normalizedLine.includes(action) || normalizedLine.includes(action.replace(/_/g, " ")));
    const isSourceCitation = /norte_operativo|openclaw_permissions_matrix|permissions matrix|matriz de permisos/.test(normalizedLine);

    if (!matchesNorte && !matchesCategory && !matchesMatrixAction && !isSourceCitation) {
      candidates.push(`line ${index + 1}: possible invented gate "${trimmed.slice(0, 220)}"`);
    }
  }

  return [...new Set(candidates)];
}

export function normalizeC2Text(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function isKnownCanonicalToken(token: string): boolean {
  if (C2_CANONICAL_TOKEN_SET.has(token)) {
    return true;
  }
  return C2_CANONICAL_TOKENS.some((canonical) => containsCanonicalToken(canonical, token));
}

function containsCanonicalToken(canonical: string, token: string): boolean {
  const canonicalParts = canonical.split("_");
  const tokenParts = token.split("_");
  if (tokenParts.length > canonicalParts.length) {
    return false;
  }

  return canonicalParts.some((_, start) => {
    const candidate = canonicalParts.slice(start, start + tokenParts.length);
    return candidate.length === tokenParts.length &&
      candidate.every((part, index) => part === tokenParts[index]);
  });
}

function looksLikePermissionToken(token: string): boolean {
  return /^(allowed|supervised|future|prohibited|read|write|live|dry|local|requires|blocked|admin)_/.test(token) ||
    /_(permission|approval|state|live|phase|run|only|category)$/.test(token);
}
