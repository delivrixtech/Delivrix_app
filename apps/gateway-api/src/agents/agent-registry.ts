/**
 * Registry estático de los 5 agentes seniors de la Fase 2.
 *
 * Cada agente es una sesión lógica del gateway (single daemon), con su system
 * prompt, su tool set acotado (matriz de packages/domain/src/multi-agent.ts) y
 * sus flags de autoridad:
 * - Solo el orquestador puede delegar (canDelegate).
 * - QA/Security es read-only: audita, no ejecuta infraestructura.
 *
 * Spec: DOCUMENTACION/ARQUITECTURA_MULTI_AGENT_RUNTIME_2026_05_29.md
 */

import { join } from "node:path";
import type { AgentRole } from "../../../../packages/domain/src/index.ts";
import {
  AGENT_ROLES,
  DNS_SENIOR_TOOL_NAMES,
  ORCHESTRATOR_TOOL_NAMES,
  QA_SECURITY_TOOL_NAMES,
  SMTP_SENIOR_TOOL_NAMES,
  WARMUP_SENIOR_TOOL_NAMES
} from "../../../../packages/domain/src/index.ts";

/** Hard cap de la spec: sesión > 50K tokens → pausa automática + alerta. */
export const DEFAULT_MAX_SESSION_TOKENS = 50_000;

export interface AgentDefinition {
  role: AgentRole;
  displayName: string;
  description: string;
  /** Ruta del system prompt versionado en DOCUMENTACION (día 5). */
  systemPromptPath: string;
  /** Prompt mínimo embebido mientras el doc del día 5 no exista. */
  fallbackSystemPrompt: string;
  toolNames: readonly string[];
  /** Solo el orquestador puede invocar especialistas. */
  canDelegate: boolean;
  /** QA/Security: lee resultados de otros agentes pero no ejecuta escrituras. */
  readOnly: boolean;
  maxSessionTokens: number;
}

function promptPath(fileName: string): string {
  return join(process.cwd(), "DOCUMENTACION", fileName);
}

export const AGENT_DEFINITIONS: Record<AgentRole, AgentDefinition> = {
  orchestrator: {
    role: "orchestrator",
    displayName: "OpenClaw Orquestador",
    description: "Tech lead: planifica, delega en los seniors y habla con el operador.",
    systemPromptPath: promptPath("OPENCLAW_ORCHESTRATOR_DELEGATION_PROTOCOL.md"),
    fallbackSystemPrompt:
      "Eres el orquestador de Delivrix. Divides la tarea del operador en delegaciones " +
      "acotadas a los seniors (dns, smtp, warmup, qa-security). Nunca ejecutas " +
      "infraestructura directamente: delegas, consolidas y pides firma al operador.",
    toolNames: ORCHESTRATOR_TOOL_NAMES,
    canDelegate: true,
    readOnly: false,
    maxSessionTokens: DEFAULT_MAX_SESSION_TOKENS
  },
  dns: {
    role: "dns",
    displayName: "DNS Senior",
    description: "DNS engineer senior: Route53/IONOS, SPF/DKIM/DMARC, TTL y propagación.",
    systemPromptPath: promptPath("OPENCLAW_AGENT_DNS_SENIOR.md"),
    fallbackSystemPrompt:
      "Eres el DNS Senior de Delivrix. Trabajas solo dentro de tu scope DNS " +
      "(registro de dominios, zonas, records, propagación, PTR). Toda escritura " +
      "pasa por dry-run + firma del operador vía gateway.",
    toolNames: DNS_SENIOR_TOOL_NAMES,
    canDelegate: false,
    readOnly: false,
    maxSessionTokens: DEFAULT_MAX_SESSION_TOKENS
  },
  smtp: {
    role: "smtp",
    displayName: "SMTP Senior",
    description: "Email infra engineer: Postfix, OpenDKIM, Dovecot, TLS, colas y logs.",
    systemPromptPath: promptPath("OPENCLAW_AGENT_SMTP_SENIOR.md"),
    fallbackSystemPrompt:
      "Eres el SMTP Senior de Delivrix. Instalas y verificas el stack SMTP " +
      "(Postfix/OpenDKIM/Dovecot/TLS) en sender nodes. Paranoico con milter y " +
      "con la evidencia: cada cambio deja audit trail y es reversible.",
    toolNames: SMTP_SENIOR_TOOL_NAMES,
    canDelegate: false,
    readOnly: false,
    maxSessionTokens: DEFAULT_MAX_SESSION_TOKENS
  },
  warmup: {
    role: "warmup",
    displayName: "Warmup Senior",
    description: "Deliverability specialist: ramps graduales, bounce/complaint, placement.",
    systemPromptPath: promptPath("OPENCLAW_AGENT_WARMUP_SENIOR.md"),
    fallbackSystemPrompt:
      "Eres el Warmup Senior de Delivrix. Aplicas ramps graduales, monitoreas " +
      "bounce/complaint y pausas automáticamente si se superan los umbrales.",
    toolNames: WARMUP_SENIOR_TOOL_NAMES,
    canDelegate: false,
    readOnly: false,
    maxSessionTokens: DEFAULT_MAX_SESSION_TOKENS
  },
  "qa-security": {
    role: "qa-security",
    displayName: "QA + Security Senior",
    description: "Senior QA/AppSec: audita dry-runs, gates, secrets y audit chain. Read-only.",
    systemPromptPath: promptPath("OPENCLAW_AGENT_QA_SECURITY_SENIOR.md"),
    fallbackSystemPrompt:
      "Eres el QA + Security Senior de Delivrix. Auditas TODO antes de que se pida " +
      "firma: dry-runs, cobertura de gates, secrets, integridad de la audit chain. " +
      "No ejecutas acciones de infraestructura; solo lees, verificas y reportas.",
    toolNames: QA_SECURITY_TOOL_NAMES,
    canDelegate: false,
    readOnly: true,
    maxSessionTokens: DEFAULT_MAX_SESSION_TOKENS
  }
};

export function getAgentDefinition(role: AgentRole): AgentDefinition {
  return AGENT_DEFINITIONS[role];
}

export function listAgentDefinitions(): AgentDefinition[] {
  return AGENT_ROLES.map((role) => AGENT_DEFINITIONS[role]);
}

/**
 * Invariantes del registry. Se ejecuta en el arranque del runtime multi-agente
 * para que un refactor descuidado no rompa la matriz de permisos en silencio.
 */
export function assertAgentRegistryIntegrity(): void {
  const definitions = listAgentDefinitions();
  if (definitions.length !== 5) {
    throw new Error(`agent_registry_invalid: se esperaban 5 agentes, hay ${definitions.length}.`);
  }
  const expectedToolCounts: Record<AgentRole, number> = {
    orchestrator: 16,
    dns: 9,
    smtp: 10,
    warmup: 8,
    "qa-security": 12
  };
  for (const definition of definitions) {
    const expected = expectedToolCounts[definition.role];
    if (definition.toolNames.length !== expected) {
      throw new Error(
        `agent_registry_invalid: ${definition.role} declara ${definition.toolNames.length} tools, se esperaban ${expected}.`
      );
    }
    if (definition.canDelegate && definition.role !== "orchestrator") {
      throw new Error(`agent_registry_invalid: solo el orquestador puede delegar (${definition.role}).`);
    }
  }
  if (!AGENT_DEFINITIONS.orchestrator.canDelegate) {
    throw new Error("agent_registry_invalid: el orquestador debe poder delegar.");
  }
  if (!AGENT_DEFINITIONS["qa-security"].readOnly) {
    throw new Error("agent_registry_invalid: qa-security debe ser read-only.");
  }
}
