import type { SkillParamSchema } from "./skill-schemas.ts";
import {
  bindDomainParamSchema,
  configureCompleteSmtpSkillParamSchema,
  emailAuthParamSchema,
  ionosUpsertParamSchema,
  route53RegisterParamSchema,
  route53UpsertParamSchema,
  smtpProvisionParamSchema,
  warmupSeedParamSchema,
  webdockCreateParamSchema
} from "./skill-schemas.ts";
import { canonicalSkillSlug } from "./skill-contracts.ts";
import { suggestSafeDomainParamSchema } from "./routes/domains-suggest.ts";
import { waitForDnsPropagationSkillParamSchema } from "./routes/dns-wait.ts";
import { bindWebdockMainDomainSkillParamSchema } from "./routes/webdock-bind-domain.ts";
import { sendRealEmailSkillParamSchema } from "./routes/send-email.ts";

export interface BedrockToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export type OpenClawToolName =
  | "register_domain_route53"
  | "suggest_safe_domain"
  | "wait_for_dns_propagation"
  | "upsert_dns_route53"
  | "upsert_dns_ionos"
  | "create_webdock_server"
  | "bind_webdock_main_domain"
  | "provision_smtp_postfix"
  | "configure_email_auth"
  | "bind_domain_to_server"
  | "seed_warmup_pool"
  | "send_real_email"
  | "configure_complete_smtp";

interface OpenClawToolDefinition {
  spec: BedrockToolSpec;
  paramSchema: SkillParamSchema;
  enabled(env: Record<string, string | undefined>): boolean;
  targetType: string;
  severity: "high" | "critical";
}

const domainPattern = "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$";
const ipv4Pattern = "^(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}$";
const taskIdPattern = "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$";
const slugPattern = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";
const selectorPattern = "^[a-z0-9][a-z0-9_-]{0,62}$";
const emailPattern = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";

const route53RecordSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["A", "MX", "TXT", "CNAME"] },
    ttl: { type: "integer", minimum: 30, maximum: 172800 },
    values: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", minLength: 1 }
    }
  },
  required: ["name", "type", "ttl", "values"],
  additionalProperties: false
};

const ionosRecordSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "CAA", "SRV"] },
    content: { type: "string", minLength: 1 },
    ttl: { type: "integer", minimum: 30, maximum: 604800 },
    prio: { type: "integer", minimum: 0, maximum: 65535 }
  },
  required: ["name", "type", "content"],
  additionalProperties: false
};

const optionalTaskId = {
  taskId: {
    type: "string",
    pattern: taskIdPattern,
    description: "ID de tarea Canvas opcional para correlacionar auditoría y eventos visuales."
  }
};

const toolDefinitions: Record<OpenClawToolName, OpenClawToolDefinition> = {
  register_domain_route53: {
    spec: {
      name: "register_domain_route53",
      description: [
        "Registra un dominio nuevo en AWS Route53 Domains.",
        "Riesgo crítico: compra irreversible o con costo externo; requiere ApprovalGate, audit chain íntegra, presupuesto y contacto administrativo configurado.",
        "Costo típico referencial: .com ~USD 15/año y .co ~USD 38/año; el handler verifica precio/cap antes de comprar."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          years: { type: "integer", minimum: 1, maximum: 10 },
          autoRenew: { type: "boolean", default: false }
        },
        required: ["domain", "years"]
      }
    },
    paramSchema: route53RegisterParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      anyFlagEnabled(env, ["AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE", "AWS_ROUTE53_ENABLE_PURCHASE", "AWS_ROUTE53_DOMAINS_PURCHASE_ENABLED"]) &&
      hasAwsRoute53DomainCredentials(env),
    targetType: "domain",
    severity: "critical"
  },
  suggest_safe_domain: {
    spec: {
      name: "suggest_safe_domain",
      description: [
        "Sugiere dominios seguros para SMTP autorizado con filtros de naming y reputación.",
        "Lectura/propuesta sin compra directa; cualquier compra posterior requiere ApprovalGate, presupuesto, audit y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          brand: { type: "string", minLength: 1 },
          intent: { type: "string", enum: ["smtp", "reporting", "filing", "saas", "ops", "general"], default: "ops" },
          tlds: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", pattern: "^[a-z]{2,24}$" }
          },
          count: { type: "integer", minimum: 1, maximum: 25 }
        },
        required: ["brand"]
      }
    },
    paramSchema: suggestSafeDomainParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      (hasAwsRoute53DomainCredentials(env) || hasPorkbunCredentials(env)),
    targetType: "domain_naming",
    severity: "high"
  },
  wait_for_dns_propagation: {
    spec: {
      name: "wait_for_dns_propagation",
      description: [
        "Espera propagación DNS para registros A, NS, MX o TXT antes de continuar una operación SMTP.",
        "Lectura auditada de bajo riesgo: no muta infraestructura, no compra recursos y no requiere ApprovalGate; si no propaga, reporta el blocker exacto."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          expectedRecord: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["A", "NS", "MX", "TXT"] },
              value: { type: "string", minLength: 1, maxLength: 253 }
            },
            required: ["type", "value"],
            additionalProperties: false
          },
          maxWaitMs: { type: "integer", minimum: 30000, maximum: 1800000 },
          pollIntervalMs: { type: "integer", minimum: 30000, maximum: 120000 }
        },
        required: ["domain", "expectedRecord"]
      }
    },
    paramSchema: waitForDnsPropagationSkillParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "dns_record",
    severity: "high"
  },
  upsert_dns_route53: {
    spec: {
      name: "upsert_dns_route53",
      description: [
        "Crea o actualiza registros DNS en AWS Route53 para un dominio autorizado.",
        "Riesgo alto/crítico: puede afectar entregabilidad, SPF/DKIM/DMARC, MX y continuidad; requiere ApprovalGate, rollback DNS cuando esté disponible, audit y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          records: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: route53RecordSchema
          },
          ...optionalTaskId
        },
        required: ["domain", "records"]
      }
    },
    paramSchema: route53UpsertParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      anyFlagEnabled(env, ["AWS_ROUTE53_DNS_ENABLE_WRITES", "AWS_ROUTE53_ENABLE_DNS_WRITES"]) &&
      hasAwsRoute53DnsCredentials(env),
    targetType: "domain",
    severity: "high"
  },
  upsert_dns_ionos: {
    spec: {
      name: "upsert_dns_ionos",
      description: [
        "Crea o actualiza registros DNS en IONOS para dominios existentes.",
        "Riesgo alto: puede afectar resolución, autenticación de correo y continuidad; requiere ApprovalGate, audit, proveedor habilitado y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          zone: { type: "string", pattern: domainPattern },
          records: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: ionosRecordSchema
          }
        },
        required: ["zone", "records"]
      }
    },
    paramSchema: ionosUpsertParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.IONOS_DNS_ENABLE_WRITES) &&
      hasIonosDnsCredentials(env),
    targetType: "ionos_dns_zone",
    severity: "high"
  },
  create_webdock_server: {
    spec: {
      name: "create_webdock_server",
      description: [
        "Crea un VPS Webdock para sender-node o infraestructura de transición.",
        "Riesgo crítico: genera costo y recursos externos; requiere ApprovalGate, audit, llave ops, kill switch y verificación posterior."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          profile: { type: "string", enum: ["bit", "nibble", "byte", "kilobyte"] },
          locationId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" },
          hostname: { type: "string", pattern: domainPattern },
          imageSlug: { type: "string", enum: ["ubuntu-2404", "debian-12"] },
          publicKey: { type: "string", minLength: 1 },
          callbackUrl: { type: "string", format: "uri" },
          pollIntervalMs: { type: "integer", minimum: 0, maximum: 60000 },
          maxPolls: { type: "integer", minimum: 0, maximum: 60 },
          ...optionalTaskId
        },
        required: ["profile", "locationId", "hostname", "imageSlug"]
      }
    },
    paramSchema: webdockCreateParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.WEBDOCK_SERVERS_ENABLE_CREATE) &&
      hasWebdockOpsCredentials(env),
    targetType: "webdock_server",
    severity: "critical"
  },
  bind_webdock_main_domain: {
    spec: {
      name: "bind_webdock_main_domain",
      description: [
        "Configura el Main domain de Webdock y PTR asociado para un VPS autorizado.",
        "Riesgo crítico: altera identidad SMTP/PTR; requiere ApprovalGate, audit, Webdock ops key, verificación SSH y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          serverSlug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$" },
          domain: { type: "string", pattern: domainPattern },
          setPtr: { type: "boolean", default: true }
        },
        required: ["serverSlug", "domain"]
      }
    },
    paramSchema: bindWebdockMainDomainSkillParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      anyFlagEnabled(env, ["WEBDOCK_MAIN_DOMAIN_BIND_ENABLE", "WEBDOCK_BIND_MAIN_DOMAIN_ENABLE", "DOMAIN_BIND_ENABLE"]) &&
      hasWebdockOpsCredentials(env) &&
      hasSshRunnerConfig(env),
    targetType: "webdock_server",
    severity: "critical"
  },
  provision_smtp_postfix: {
    spec: {
      name: "provision_smtp_postfix",
      description: [
        "Instala o reintenta provisioning de Postfix/OpenDKIM/TLS en un VPS autorizado.",
        "Riesgo crítico: acción SSH de alto impacto sobre infraestructura de correo; requiere ApprovalGate, audit, runner SSH configurado, verificación y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          serverSlug: { type: "string", pattern: slugPattern },
          domain: { type: "string", pattern: domainPattern },
          serverIp: { type: "string", pattern: ipv4Pattern },
          dkimPrivateKeyPath: {
            type: "string",
            pattern: "^/?inventory/dkim-keys/[a-z0-9.-]+/[a-z0-9_-]+\\.private$"
          },
          selector: { type: "string", pattern: selectorPattern },
          ...optionalTaskId
        },
        required: ["serverSlug", "domain"]
      }
    },
    paramSchema: smtpProvisionParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.SMTP_PROVISIONING_ENABLE_SSH) &&
      hasSshRunnerConfig(env),
    targetType: "webdock_server",
    severity: "critical"
  },
  configure_email_auth: {
    spec: {
      name: "configure_email_auth",
      description: [
        "Configura registros SPF/DKIM/DMARC/MX para un dominio autorizado usando Route53.",
        "Riesgo crítico para reputación y cumplimiento de correo; requiere ApprovalGate, audit, DNS write gate y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          mxServerIp: { type: "string", pattern: ipv4Pattern },
          zoneId: { type: "string", minLength: 1 },
          selector: { type: "string", pattern: selectorPattern },
          dmarcPolicy: { type: "string", enum: ["none", "quarantine", "reject"] },
          ...optionalTaskId
        },
        required: ["domain", "mxServerIp"]
      }
    },
    paramSchema: emailAuthParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.EMAIL_AUTH_ENABLE_WRITES) &&
      anyFlagEnabled(env, ["AWS_ROUTE53_DNS_ENABLE_WRITES", "AWS_ROUTE53_ENABLE_DNS_WRITES"]) &&
      hasAwsRoute53DnsCredentials(env),
    targetType: "domain",
    severity: "critical"
  },
  bind_domain_to_server: {
    spec: {
      name: "bind_domain_to_server",
      description: [
        "Vincula un dominio con un servidor Webdock creando/actualizando registros DNS necesarios.",
        "Riesgo alto: cambia routing operacional; requiere ApprovalGate, audit, DNS write gate, rollback cuando aplique y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          serverSlug: { type: "string", pattern: slugPattern },
          serverIp: { type: "string", pattern: ipv4Pattern },
          zoneId: { type: "string", minLength: 1 },
          ...optionalTaskId
        },
        required: ["domain"]
      }
    },
    paramSchema: bindDomainParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.DOMAIN_BIND_ENABLE) &&
      anyFlagEnabled(env, ["AWS_ROUTE53_DNS_ENABLE_WRITES", "AWS_ROUTE53_ENABLE_DNS_WRITES"]) &&
      hasAwsRoute53DnsCredentials(env),
    targetType: "domain",
    severity: "high"
  },
  seed_warmup_pool: {
    spec: {
      name: "seed_warmup_pool",
      description: [
        "Ejecuta warmup seed controlado contra inboxes semilla autorizados.",
        "Riesgo crítico de envío real limitado: solo mailing autorizado, requiere ApprovalGate, audit, rate limits, suppression/opt-out del flujo superior, runner SSH y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          serverSlug: { type: "string", pattern: slugPattern },
          serverIp: { type: "string", pattern: ipv4Pattern },
          seedInboxes: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { type: "string", format: "email" }
          },
          ...optionalTaskId
        },
        required: ["domain", "seedInboxes"]
      }
    },
    paramSchema: warmupSeedParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.WARMUP_ENABLE_SEND) &&
      flagEnabled(env.WARMUP_RAMP_ENABLE) &&
      hasSshRunnerConfig(env),
    targetType: "domain",
    severity: "critical"
  },
  send_real_email: {
    spec: {
      name: "send_real_email",
      description: [
        "Envía un primer correo real autorizado desde el SMTP ya configurado.",
        "Riesgo crítico: envío real a destinatario confirmado; requiere ApprovalGate, SPF/DKIM/DMARC, rate limits, audit, SSH runner y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          fromAddress: { type: "string", pattern: emailPattern },
          toAddress: { type: "string", pattern: emailPattern },
          subject: { type: "string", minLength: 1, maxLength: 160 },
          body: { type: "string", minLength: 1, maxLength: 10000 },
          serverSlug: { type: "string", pattern: slugPattern }
        },
        required: ["fromAddress", "toAddress", "subject", "body", "serverSlug"]
      }
    },
    paramSchema: sendRealEmailSkillParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      anyFlagEnabled(env, ["SMTP_SEND_REAL_EMAIL_ENABLE", "SEND_REAL_EMAIL_ENABLE"]) &&
      hasSshRunnerConfig(env),
    targetType: "webdock_server",
    severity: "critical"
  },
  configure_complete_smtp: {
    spec: {
      name: "configure_complete_smtp",
      description: [
        "Orquesta SMTP completo desde cero: dominio seguro, compra Route53, VPS Webdock, Main domain/PTR, DNS, Postfix/OpenDKIM, SPF/DKIM/DMARC, warmup mínimo y un correo real autorizado.",
        "Requiere ApprovalGate por cada acción real, audit/canvas events, kill switch, rollback proposal para VPS y presupuesto máximo. Tiempo estimado: 1-3 horas. Costo referencial: USD 15 dominio + USD 4.30/mes VPS prorrateado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          brand: { type: "string", minLength: 1 },
          intent: { type: "string", minLength: 1 },
          budgetUsdMax: { type: "integer", minimum: 1, maximum: 10000, default: 25 },
          testEmailRecipient: { type: "string", pattern: emailPattern },
          testEmailSubject: { type: "string", minLength: 1, maxLength: 160 },
          testEmailBody: { type: "string", minLength: 1, maxLength: 10000 },
          seedInboxes: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { type: "string", pattern: emailPattern }
          }
        },
        required: ["brand", "budgetUsdMax", "testEmailRecipient", "testEmailSubject", "testEmailBody"]
      }
    },
    paramSchema: configureCompleteSmtpSkillParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE) &&
      isOpenClawToolEnabled("suggest_safe_domain", env) &&
      isOpenClawToolEnabled("register_domain_route53", env) &&
      isOpenClawToolEnabled("wait_for_dns_propagation", env) &&
      isOpenClawToolEnabled("create_webdock_server", env) &&
      isOpenClawToolEnabled("bind_webdock_main_domain", env) &&
      isOpenClawToolEnabled("upsert_dns_route53", env) &&
      isOpenClawToolEnabled("provision_smtp_postfix", env) &&
      isOpenClawToolEnabled("configure_email_auth", env) &&
      isOpenClawToolEnabled("seed_warmup_pool", env) &&
      isOpenClawToolEnabled("send_real_email", env),
    targetType: "openclaw_orchestrator",
    severity: "critical"
  }
};

export function buildToolsForOpenClaw(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): BedrockToolSpec[] {
  return openClawToolNames()
    .map((name) => toolDefinitions[name])
    .filter((definition) => definition.enabled(env))
    .map((definition) => definition.spec);
}

export function openClawToolNames(): OpenClawToolName[] {
  return [
    "register_domain_route53",
    "suggest_safe_domain",
    "wait_for_dns_propagation",
    "upsert_dns_route53",
    "upsert_dns_ionos",
    "create_webdock_server",
    "bind_webdock_main_domain",
    "provision_smtp_postfix",
    "configure_email_auth",
    "bind_domain_to_server",
    "seed_warmup_pool",
    "send_real_email",
    "configure_complete_smtp"
  ];
}

export function getOpenClawToolDefinition(toolName: string): OpenClawToolDefinition | null {
  const canonical = canonicalSkillSlug(toolName) as OpenClawToolName;
  return Object.prototype.hasOwnProperty.call(toolDefinitions, canonical)
    ? toolDefinitions[canonical]
    : null;
}

export function isOpenClawToolEnabled(
  toolName: string,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): boolean {
  return getOpenClawToolDefinition(toolName)?.enabled(env) ?? false;
}

export function openClawToolMetadata(toolName: string): {
  targetType: string;
  severity: "high" | "critical";
} | null {
  const definition = getOpenClawToolDefinition(toolName);
  return definition
    ? { targetType: definition.targetType, severity: definition.severity }
    : null;
}

function hmacConfigured(env: Record<string, string | undefined>): boolean {
  return nonEmpty(env.OPENCLAW_HMAC_SECRET);
}

function hasAwsRoute53DomainCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(
    firstNonEmpty(env.AWS_ROUTE53_DOMAINS_ACCESS_KEY_ID, env.AWS_ROUTE53_ACCESS_KEY_ID, env.AWS_ACCESS_KEY_ID) &&
    firstNonEmpty(env.AWS_ROUTE53_DOMAINS_SECRET_ACCESS_KEY, env.AWS_ROUTE53_SECRET_ACCESS_KEY, env.AWS_SECRET_ACCESS_KEY)
  );
}

function hasAwsRoute53DnsCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(
    firstNonEmpty(env.AWS_ROUTE53_DNS_ACCESS_KEY_ID, env.AWS_ROUTE53_ACCESS_KEY_ID, env.AWS_ACCESS_KEY_ID) &&
    firstNonEmpty(env.AWS_ROUTE53_DNS_SECRET_ACCESS_KEY, env.AWS_ROUTE53_SECRET_ACCESS_KEY, env.AWS_SECRET_ACCESS_KEY)
  );
}

function hasIonosDnsCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(firstNonEmpty(
    env.IONOS_API_TOKEN,
    env.IONOS_CLOUD_DNS_TOKEN,
    env.IONOS_DNS_API_KEY,
    env.IONOS_DOMAINS_API_KEY,
    env.IONOS_HOSTING_API_KEY,
    env.IONOS_DEVELOPER_API_KEY
  ));
}

function hasWebdockOpsCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(firstNonEmpty(env.WEBDOCK_API_KEY_OPS, env.WEBDOCK_API_KEY, env.WEBDOCK_API_KEY_PRIMARY));
}

function hasSshRunnerConfig(env: Record<string, string | undefined>): boolean {
  return Boolean(firstNonEmpty(env.SMTP_PROVISION_SSH_KEY_PATH, env.SMTP_SSH_KEY_PATH));
}

function hasPorkbunCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(firstNonEmpty(env.PORKBUN_API_KEY, env.PORKBUN_SECRET_API_KEY));
}

function anyFlagEnabled(env: Record<string, string | undefined>, keys: string[]): boolean {
  return keys.some((key) => flagEnabled(env[key]));
}

function flagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find(nonEmpty);
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
