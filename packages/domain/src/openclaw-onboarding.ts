import { createId } from "./ids.ts";

export type OpenClawOnboardingCategory =
  | "server"
  | "network"
  | "proxmox"
  | "ip_pool"
  | "domains"
  | "dns"
  | "compliance"
  | "limits"
  | "security"
  | "autonomy";

export type OpenClawQuestionPriority = "critical" | "high" | "medium";
export type OpenClawOnboardingDecisionStatus = "go" | "needs_review" | "no_go";
export type OpenClawOnboardingRiskLevel = "low" | "medium" | "high" | "critical";
export type OpenClawAutonomyMode = "read_only" | "supervised" | "limited";
export type OpenClawProxmoxStatus = "installed" | "planned" | "unknown";
export type OpenClawIpPoolType = "leased" | "owned" | "provider" | "unknown";

export interface OpenClawOnboardingQuestion {
  id: string;
  category: OpenClawOnboardingCategory;
  priority: OpenClawQuestionPriority;
  fieldPath: string;
  prompt: string;
  reason: string;
}

export interface OpenClawOnboardingQuestionnaire {
  phase: "4.1-openclaw-intelligent-onboarding";
  generatedAt: string;
  dryRun: true;
  sideEffects: "none";
  questions: OpenClawOnboardingQuestion[];
  gates: string[];
}

export interface OpenClawOnboardingInput {
  actorId?: string;
  server?: {
    model?: string;
    location?: string;
    cpuCores?: number;
    ramGb?: number;
    storage?: {
      type?: "hdd" | "ssd" | "nvme" | "mixed";
      usableGb?: number;
      redundant?: boolean;
    };
    network?: {
      provider?: string;
      uplinkMbps?: number;
      staticIp?: boolean;
    };
    upsReady?: boolean;
    coolingMonitored?: boolean;
  };
  proxmox?: {
    status?: OpenClawProxmoxStatus;
    version?: string;
    apiReachable?: boolean;
  };
  ipPool?: {
    totalIps?: number;
    type?: OpenClawIpPoolType;
    cidrs?: string[];
    providerApproval?: boolean;
    reputationChecked?: boolean;
    ptrDelegation?: boolean;
  };
  domains?: Array<{
    domain?: string;
    dnsProvider?: string;
    ownershipVerified?: boolean;
    spfReady?: boolean;
    dkimReady?: boolean;
    dmarcReady?: boolean;
    ptrPlanReady?: boolean;
  }>;
  dns?: {
    provider?: string;
    apiAccess?: boolean;
    canManageSpfDkimDmarc?: boolean;
    canManagePtr?: boolean;
  };
  compliance?: {
    physicalAddressReady?: boolean;
    optOutReady?: boolean;
    suppressionListReady?: boolean;
    consentProofAvailable?: boolean;
    trafficAuthorizedByProvider?: boolean;
  };
  limits?: {
    targetDailyVolume?: number;
    initialSenderNodes?: number;
    maxSenderNodes?: number;
    dailyLimitPerNode?: number;
    warmupDays?: number;
  };
  security?: {
    secretsManagerReady?: boolean;
    sshKeyPolicyReady?: boolean;
    auditLogRequired?: boolean;
    killSwitchRequired?: boolean;
  };
  autonomy?: {
    mode?: OpenClawAutonomyMode;
    humanApprovalRequired?: boolean;
  };
  notes?: string;
}

export interface OpenClawOnboardingReadiness {
  infrastructure: number;
  network: number;
  dns: number;
  compliance: number;
  security: number;
  autonomy: number;
  total: number;
}

export interface OpenClawOnboardingDecision {
  status: OpenClawOnboardingDecisionStatus;
  canGenerateTopologyPlan: boolean;
  canRunProvisioningDryRun: false;
  nextRecommendedMilestone: "continue_onboarding" | "4.2_cluster_topology_planner";
  riskLevel: OpenClawOnboardingRiskLevel;
  reason: string;
}

export interface OpenClawOnboardingSnapshot {
  id: string;
  createdAt: string;
  phase: "4.1-openclaw-intelligent-onboarding";
  actorId: string;
  dryRun: true;
  sideEffects: "none";
  inputSummary: {
    serverModel?: string;
    proxmoxStatus?: OpenClawProxmoxStatus;
    totalIps?: number;
    domainsCount: number;
    targetDailyVolume?: number;
    autonomyMode?: OpenClawAutonomyMode;
  };
  readiness: OpenClawOnboardingReadiness;
  decision: OpenClawOnboardingDecision;
  blockers: string[];
  warnings: string[];
  missingCriticalFields: string[];
  recommendedNextQuestions: OpenClawOnboardingQuestion[];
  requiredApprovals: string[];
  blockedActions: string[];
  safety: {
    liveInfrastructureWritesEnabled: false;
    sshEnabled: false;
    smtpEnabled: false;
    dnsLiveChangesEnabled: false;
    nfcWritesEnabled: false;
  };
}

const questions: OpenClawOnboardingQuestion[] = [
  question("server.model", "server", "critical", "server.model", "Cual es el modelo exacto del servidor fisico?", "OpenClaw necesita entender la base fisica antes de proponer clusters."),
  question("server.cpu_cores", "server", "critical", "server.cpuCores", "Cuantos cores/hilos utiles tiene el servidor?", "La cantidad de VPS/LXC depende del CPU disponible."),
  question("server.ram_gb", "server", "critical", "server.ramGb", "Cuanta RAM util tiene el servidor despues del upgrade?", "La RAM limita la densidad real de sender nodes."),
  question("server.storage_usable_gb", "server", "critical", "server.storage.usableGb", "Cuanto almacenamiento util queda para Proxmox, logs y contenedores?", "Postfix, logs y backups necesitan margen de disco."),
  question("server.network_uplink", "network", "critical", "server.network.uplinkMbps", "Cual es el uplink real de internet empresarial?", "La red condiciona capacidad, warming y estabilidad."),
  question("proxmox.status", "proxmox", "critical", "proxmox.status", "Proxmox esta instalado, planeado o aun desconocido?", "El planner necesita saber si debe operar contra Proxmox real o mock."),
  question("ip_pool.total_ips", "ip_pool", "critical", "ipPool.totalIps", "Cuantas IPs disponibles hay para el piloto?", "No se puede planear sender nodes sin pool de IPs."),
  question("ip_pool.type", "ip_pool", "critical", "ipPool.type", "Las IPs son leased, propias, del proveedor o desconocidas?", "El origen de IP define riesgos, permisos y PTR."),
  question("ip_pool.provider_approval", "ip_pool", "critical", "ipPool.providerApproval", "El proveedor/ISP aprobo por escrito el tipo de trafico autorizado?", "Sin permiso operativo no se debe preparar envio a escala."),
  question("ip_pool.ptr_delegation", "ip_pool", "critical", "ipPool.ptrDelegation", "Existe control o delegacion PTR para las IPs?", "El PTR es obligatorio para infraestructura SMTP seria."),
  question("domains.verified", "domains", "critical", "domains[].ownershipVerified", "Que dominios estan verificados para operar sender nodes?", "No se debe planear DNS ni DKIM sobre dominios no verificados."),
  question("dns.provider", "dns", "critical", "dns.provider", "Que proveedor DNS se usara para SPF, DKIM, DMARC y subdominios?", "OpenClaw debe saber donde preparar cambios DNS."),
  question("dns.api_access", "dns", "high", "dns.apiAccess", "Existe acceso API o proceso controlado para cambios DNS?", "Sin acceso controlado, los cambios quedan manuales y supervisados."),
  question("compliance.physical_address", "compliance", "critical", "compliance.physicalAddressReady", "La direccion fisica valida ya esta definida?", "El correo autorizado requiere datos legales correctos."),
  question("compliance.opt_out", "compliance", "critical", "compliance.optOutReady", "El opt-out esta listo y probado?", "Sin bajas funcionales no se debe avanzar."),
  question("compliance.suppression_list", "compliance", "critical", "compliance.suppressionListReady", "La suppression list global esta lista?", "Los contactos dados de baja deben bloquearse siempre."),
  question("compliance.consent_proof", "compliance", "critical", "compliance.consentProofAvailable", "Existe prueba de autorizacion/consentimiento de destinatarios?", "La reputacion y legalidad dependen de trafico autorizado."),
  question("compliance.provider_authorization", "compliance", "critical", "compliance.trafficAuthorizedByProvider", "El proveedor autoriza este trafico?", "No se debe usar infraestructura sin autorizacion clara."),
  question("limits.target_daily_volume", "limits", "critical", "limits.targetDailyVolume", "Cual es la meta diaria inicial y la meta maxima?", "El planner no debe prometer volumen sin limites claros."),
  question("limits.initial_sender_nodes", "limits", "critical", "limits.initialSenderNodes", "Con cuantos sender nodes debe iniciar el piloto?", "La fase inicial debe ser pequena, medible y gradual."),
  question("limits.daily_per_node", "limits", "critical", "limits.dailyLimitPerNode", "Cual es el limite diario inicial por sender node?", "El warming necesita limites conservadores por nodo."),
  question("limits.warmup_days", "limits", "critical", "limits.warmupDays", "Cuantos dias de warming se aplicaran antes de subir volumen?", "No hay aumento sano sin calentamiento progresivo."),
  question("security.secrets_manager", "security", "critical", "security.secretsManagerReady", "Donde se guardaran llaves, tokens y credenciales?", "OpenClaw no debe manejar secretos en texto plano."),
  question("security.audit_log", "security", "critical", "security.auditLogRequired", "La auditoria append-only esta exigida para cada decision?", "Cada accion humana o autonoma debe quedar trazada."),
  question("security.kill_switch", "security", "critical", "security.killSwitchRequired", "El kill switch bloquea acciones nuevas y procesamiento?", "La operacion debe poder detenerse en segundos."),
  question("autonomy.mode", "autonomy", "critical", "autonomy.mode", "OpenClaw inicia en read_only o supervised?", "La IA no debe iniciar con autonomia real."),
  question("autonomy.human_approval", "autonomy", "critical", "autonomy.humanApprovalRequired", "Que acciones requieren aprobacion humana?", "Toda accion real debe pasar por aprobacion.")
];

const requiredApprovals = [
  "operator_approval_before_live_infrastructure",
  "dns_change_approval",
  "ssh_access_approval",
  "smtp_activation_approval",
  "volume_increase_approval"
];

const blockedActions = [
  "proxmox-live-create",
  "ssh-connect",
  "dns-live-change",
  "postfix-apply-live",
  "smtp-send",
  "nfc-production-write",
  "increase-volume"
];

export function getOpenClawOnboardingQuestionnaire(now = new Date()): OpenClawOnboardingQuestionnaire {
  return {
    phase: "4.1-openclaw-intelligent-onboarding",
    generatedAt: now.toISOString(),
    dryRun: true,
    sideEffects: "none",
    questions,
    gates: [
      "no_topology_plan_without_critical_onboarding_data",
      "no_live_infrastructure_write",
      "no_ssh_without_human_approval",
      "no_dns_live_change",
      "no_smtp_activation",
      "no_external_bridge_dependency"
    ]
  };
}

export function evaluateOpenClawOnboarding(
  input: OpenClawOnboardingInput = {},
  now = new Date()
): OpenClawOnboardingSnapshot {
  const actorId = input.actorId?.trim() || "operator_local";
  const blockers: string[] = [];
  const warnings: string[] = [];
  const missingCriticalFields: string[] = [];

  requireCritical(hasText(input.server?.model), "server.model", "missing_server_model", blockers, missingCriticalFields);
  requireCritical(isPositive(input.server?.cpuCores), "server.cpu_cores", "missing_or_invalid_cpu_cores", blockers, missingCriticalFields);
  requireCritical(isPositive(input.server?.ramGb), "server.ram_gb", "missing_or_invalid_ram_gb", blockers, missingCriticalFields);
  requireCritical(isPositive(input.server?.storage?.usableGb), "server.storage_usable_gb", "missing_or_invalid_storage_usable_gb", blockers, missingCriticalFields);
  requireCritical(isPositive(input.server?.network?.uplinkMbps), "server.network_uplink", "missing_or_invalid_network_uplink", blockers, missingCriticalFields);
  requireCritical(isKnownProxmoxStatus(input.proxmox?.status), "proxmox.status", "missing_or_unknown_proxmox_status", blockers, missingCriticalFields);
  requireCritical(isPositive(input.ipPool?.totalIps), "ip_pool.total_ips", "missing_or_invalid_ip_pool_total", blockers, missingCriticalFields);
  requireCritical(isKnownIpPoolType(input.ipPool?.type), "ip_pool.type", "missing_or_unknown_ip_pool_type", blockers, missingCriticalFields);
  requireCritical(input.ipPool?.providerApproval === true, "ip_pool.provider_approval", "missing_provider_or_isp_approval", blockers, missingCriticalFields);
  requireCritical(input.ipPool?.ptrDelegation === true, "ip_pool.ptr_delegation", "missing_ptr_delegation_or_control", blockers, missingCriticalFields);
  requireCritical(hasVerifiedDomain(input.domains), "domains.verified", "missing_verified_domain", blockers, missingCriticalFields);
  requireCritical(hasText(input.dns?.provider), "dns.provider", "missing_dns_provider", blockers, missingCriticalFields);
  requireCritical(input.compliance?.physicalAddressReady === true, "compliance.physical_address", "missing_physical_address", blockers, missingCriticalFields);
  requireCritical(input.compliance?.optOutReady === true, "compliance.opt_out", "missing_opt_out", blockers, missingCriticalFields);
  requireCritical(input.compliance?.suppressionListReady === true, "compliance.suppression_list", "missing_suppression_list", blockers, missingCriticalFields);
  requireCritical(input.compliance?.consentProofAvailable === true, "compliance.consent_proof", "missing_consent_proof", blockers, missingCriticalFields);
  requireCritical(input.compliance?.trafficAuthorizedByProvider === true, "compliance.provider_authorization", "missing_provider_traffic_authorization", blockers, missingCriticalFields);
  requireCritical(isPositive(input.limits?.targetDailyVolume), "limits.target_daily_volume", "missing_or_invalid_target_daily_volume", blockers, missingCriticalFields);
  requireCritical(isPositive(input.limits?.initialSenderNodes), "limits.initial_sender_nodes", "missing_or_invalid_initial_sender_nodes", blockers, missingCriticalFields);
  requireCritical(isPositive(input.limits?.dailyLimitPerNode), "limits.daily_per_node", "missing_or_invalid_daily_limit_per_node", blockers, missingCriticalFields);
  requireCritical(isPositive(input.limits?.warmupDays), "limits.warmup_days", "missing_or_invalid_warmup_days", blockers, missingCriticalFields);
  requireCritical(input.security?.secretsManagerReady === true, "security.secrets_manager", "missing_secret_management", blockers, missingCriticalFields);
  requireCritical(input.security?.auditLogRequired === true, "security.audit_log", "missing_audit_log_requirement", blockers, missingCriticalFields);
  requireCritical(input.security?.killSwitchRequired === true, "security.kill_switch", "missing_kill_switch_requirement", blockers, missingCriticalFields);
  requireCritical(isSafeAutonomyMode(input.autonomy?.mode), "autonomy.mode", "missing_or_unsafe_autonomy_mode", blockers, missingCriticalFields);
  requireCritical(input.autonomy?.humanApprovalRequired === true, "autonomy.human_approval", "missing_human_approval_gate", blockers, missingCriticalFields);

  addWarnings(input, warnings, blockers);

  const decision = buildDecision(blockers, warnings);

  return {
    id: createId("openclaw_onboarding"),
    createdAt: now.toISOString(),
    phase: "4.1-openclaw-intelligent-onboarding",
    actorId,
    dryRun: true,
    sideEffects: "none",
    inputSummary: {
      serverModel: input.server?.model?.trim() || undefined,
      proxmoxStatus: input.proxmox?.status,
      totalIps: input.ipPool?.totalIps,
      domainsCount: (input.domains ?? []).filter((domain) => hasText(domain.domain)).length,
      targetDailyVolume: input.limits?.targetDailyVolume,
      autonomyMode: input.autonomy?.mode
    },
    readiness: buildReadiness(input),
    decision,
    blockers,
    warnings,
    missingCriticalFields,
    recommendedNextQuestions: recommendedQuestions(missingCriticalFields),
    requiredApprovals,
    blockedActions,
    safety: {
      liveInfrastructureWritesEnabled: false,
      sshEnabled: false,
      smtpEnabled: false,
      dnsLiveChangesEnabled: false,
      nfcWritesEnabled: false
    }
  };
}

function question(
  id: string,
  category: OpenClawOnboardingCategory,
  priority: OpenClawQuestionPriority,
  fieldPath: string,
  prompt: string,
  reason: string
): OpenClawOnboardingQuestion {
  return {
    id,
    category,
    priority,
    fieldPath,
    prompt,
    reason
  };
}

function requireCritical(
  condition: boolean,
  questionId: string,
  blocker: string,
  blockers: string[],
  missingCriticalFields: string[]
): void {
  if (condition) {
    return;
  }

  blockers.push(blocker);
  missingCriticalFields.push(questionId);
}

function addWarnings(input: OpenClawOnboardingInput, warnings: string[], blockers: string[]): void {
  if (input.proxmox?.status === "planned") {
    warnings.push("proxmox_planned_not_installed");
  }

  if (input.proxmox?.status === "installed" && input.proxmox.apiReachable !== true) {
    warnings.push("proxmox_api_not_confirmed");
  }

  if (isPositive(input.server?.ramGb) && Number(input.server?.ramGb) < 32) {
    warnings.push("server_ram_low_for_cluster_density");
  }

  if (isPositive(input.server?.storage?.usableGb) && Number(input.server?.storage?.usableGb) < 500) {
    warnings.push("storage_margin_low_for_logs_and_backups");
  }

  if (input.server?.storage?.redundant === false) {
    warnings.push("storage_redundancy_not_confirmed");
  }

  if (input.server?.upsReady === false) {
    warnings.push("ups_not_ready");
  }

  if (input.server?.coolingMonitored === false) {
    warnings.push("cooling_monitoring_not_ready");
  }

  if (input.ipPool?.reputationChecked !== true && isPositive(input.ipPool?.totalIps)) {
    warnings.push("ip_reputation_not_checked");
  }

  if (input.dns?.apiAccess !== true && hasText(input.dns?.provider)) {
    warnings.push("dns_api_access_not_ready");
  }

  if (input.dns?.canManageSpfDkimDmarc !== true && hasText(input.dns?.provider)) {
    warnings.push("dns_spf_dkim_dmarc_management_not_confirmed");
  }

  if (input.dns?.canManagePtr !== true && input.ipPool?.ptrDelegation === true) {
    warnings.push("ptr_management_process_not_confirmed");
  }

  if (input.security?.sshKeyPolicyReady !== true && input.security?.secretsManagerReady === true) {
    warnings.push("ssh_key_policy_not_confirmed");
  }

  if (isPositive(input.limits?.warmupDays) && Number(input.limits?.warmupDays) < 14) {
    warnings.push("warmup_window_short");
  }

  const limits = input.limits;
  if (limits?.maxSenderNodes !== undefined && limits.initialSenderNodes !== undefined) {
    if (limits.maxSenderNodes < limits.initialSenderNodes) {
      blockers.push("max_sender_nodes_below_initial_sender_nodes");
    }
  }

  if (input.limits?.targetDailyVolume && input.ipPool?.totalIps && input.limits.targetDailyVolume > input.ipPool.totalIps * 5000) {
    warnings.push("target_volume_exceeds_conservative_ip_capacity");
  }
}

function buildDecision(blockers: string[], warnings: string[]): OpenClawOnboardingDecision {
  if (blockers.length > 0) {
    return {
      status: "no_go",
      canGenerateTopologyPlan: false,
      canRunProvisioningDryRun: false,
      nextRecommendedMilestone: "continue_onboarding",
      riskLevel: blockers.some((blocker) => blocker.includes("compliance") || blocker.includes("authorization") || blocker.includes("approval")) ? "critical" : "high",
      reason: "Critical onboarding data is missing or unsafe. Do not generate a topology plan yet."
    };
  }

  if (warnings.length > 0) {
    return {
      status: "needs_review",
      canGenerateTopologyPlan: true,
      canRunProvisioningDryRun: false,
      nextRecommendedMilestone: "4.2_cluster_topology_planner",
      riskLevel: warnings.length >= 4 ? "high" : "medium",
      reason: "Critical onboarding data is complete, but operator review is required before the topology planner."
    };
  }

  return {
    status: "go",
    canGenerateTopologyPlan: true,
    canRunProvisioningDryRun: false,
    nextRecommendedMilestone: "4.2_cluster_topology_planner",
    riskLevel: "low",
    reason: "Critical onboarding data is complete. The next safe step is the topology planner."
  };
}

function buildReadiness(input: OpenClawOnboardingInput): OpenClawOnboardingReadiness {
  const infrastructure = score([
    hasText(input.server?.model),
    isPositive(input.server?.cpuCores),
    isPositive(input.server?.ramGb),
    isPositive(input.server?.storage?.usableGb),
    isKnownProxmoxStatus(input.proxmox?.status)
  ]);
  const network = score([
    isPositive(input.server?.network?.uplinkMbps),
    isPositive(input.ipPool?.totalIps),
    isKnownIpPoolType(input.ipPool?.type),
    input.ipPool?.providerApproval === true,
    input.ipPool?.ptrDelegation === true
  ]);
  const dns = score([
    hasVerifiedDomain(input.domains),
    hasText(input.dns?.provider),
    input.dns?.apiAccess === true,
    input.dns?.canManageSpfDkimDmarc === true,
    input.dns?.canManagePtr === true
  ]);
  const compliance = score([
    input.compliance?.physicalAddressReady === true,
    input.compliance?.optOutReady === true,
    input.compliance?.suppressionListReady === true,
    input.compliance?.consentProofAvailable === true,
    input.compliance?.trafficAuthorizedByProvider === true
  ]);
  const security = score([
    input.security?.secretsManagerReady === true,
    input.security?.sshKeyPolicyReady === true,
    input.security?.auditLogRequired === true,
    input.security?.killSwitchRequired === true
  ]);
  const autonomy = score([
    isSafeAutonomyMode(input.autonomy?.mode),
    input.autonomy?.humanApprovalRequired === true
  ]);
  const total = Math.round((infrastructure + network + dns + compliance + security + autonomy) / 6);

  return {
    infrastructure,
    network,
    dns,
    compliance,
    security,
    autonomy,
    total
  };
}

function recommendedQuestions(missingCriticalFields: string[]): OpenClawOnboardingQuestion[] {
  const missing = new Set(missingCriticalFields);

  return questions.filter((candidate) => missing.has(candidate.id));
}

function score(values: boolean[]): number {
  const total = values.length;
  const passed = values.filter(Boolean).length;

  return Math.round((passed / total) * 100);
}

function hasText(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function isPositive(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isKnownProxmoxStatus(value: OpenClawProxmoxStatus | undefined): boolean {
  return value === "installed" || value === "planned";
}

function isKnownIpPoolType(value: OpenClawIpPoolType | undefined): boolean {
  return value === "leased" || value === "owned" || value === "provider";
}

function isSafeAutonomyMode(value: OpenClawAutonomyMode | undefined): boolean {
  return value === "read_only" || value === "supervised";
}

function hasVerifiedDomain(domains: OpenClawOnboardingInput["domains"]): boolean {
  return Boolean(domains?.some((domain) => hasText(domain.domain) && domain.ownershipVerified === true));
}
