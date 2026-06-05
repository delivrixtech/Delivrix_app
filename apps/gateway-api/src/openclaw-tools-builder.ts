import type { SkillParamSchema } from "./skill-schemas.ts";
import {
  bindDomainParamSchema,
  compactIntentParamSchema,
  configureCompleteSmtpSkillParamSchema,
  emailAuthParamSchema,
  ionosDnsReadParamSchema,
  ionosUpsertParamSchema,
  readEpisodicScratchParamSchema,
  readWebdockServersParamSchema,
  route53DomainDetailParamSchema,
  route53NameserverUpdateParamSchema,
  route53RegisterParamSchema,
  route53ZoneRecordsParamSchema,
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
  | "read_episodic_scratch"
  | "wait_for_dns_propagation"
  | "read_route53_domain_detail"
  | "read_route53_zone_records"
  | "update_domain_nameservers"
  | "read_dns_ionos"
  | "read_webdock_servers"
  | "upsert_dns_route53"
  | "upsert_dns_ionos"
  | "create_webdock_server"
  | "bind_webdock_main_domain"
  | "provision_smtp_postfix"
  | "configure_email_auth"
  | "bind_domain_to_server"
  | "seed_warmup_pool"
  | "send_real_email"
  | "compact_intent"
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

const optionalRepairScope = {
  repairReason: {
    type: "string",
    minLength: 10,
    maxLength: 500,
    description: "Motivo explícito de reparación puntual. No usar para flujos SMTP completos."
  },
  explicitRepairScope: {
    type: "string",
    minLength: 3,
    maxLength: 300,
    description: "Scope exacto de la reparación puntual autorizada, por ejemplo dominio, serverSlug o registro específico."
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
          autoRenew: { type: "boolean", default: false },
          ...optionalRepairScope
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
  read_episodic_scratch: {
    spec: {
      name: "read_episodic_scratch",
      description: [
        "Consulta la memoria episódica auditada de OpenClaw por intentId, inputHash, herramienta o query grounded.",
        "Es read-only: sirve para reutilizar evidencia, evitar repetir pasos ya completados y detectar intentos fallidos previos sin mutar infraestructura ni requerir ApprovalGate.",
        "Cuando recibe query/keywords usa retrieval grounded de decisión: solo verified_fact activo, salida tipada, score de relevancia/recencia/reliability y abstención si no hay memoria verificada relevante."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          intentId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$" },
          inputHash: { type: "string", pattern: "^[a-f0-9]{8,64}$" },
          tool: { type: "string", minLength: 1, maxLength: 128 },
          outcome: {
            type: "string",
            enum: ["success", "failed", "rolled_back", "rollback_failed", "cancelled_by_operator", "timeout", "partial"]
          },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          sinceDays: { type: "integer", minimum: 1, maximum: 3650 },
          weighted: { type: "boolean", default: false },
          grounded: {
            type: "boolean",
            default: false,
            description: "Usar retrieval de decisión grounded; query lo activa por defecto."
          },
          query: {
            type: "string",
            minLength: 3,
            maxLength: 512,
            description: "Pregunta o necesidad de decisión para buscar memoria verificada relevante."
          },
          keywords: {
            type: "array",
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 64 },
            description: "Términos controlados opcionales para reforzar la relevancia B1 sin embeddings."
          }
        },
        required: []
      }
    },
    paramSchema: readEpisodicScratchParamSchema,
    enabled: (env) => hmacConfigured(env) && postgresConfigured(env),
    targetType: "openclaw_memory",
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
  read_route53_domain_detail: {
    spec: {
      name: "read_route53_domain_detail",
      description: "Devuelve metadata autoritativa del registro de un dominio en Route53 Domains: registrar (AWS, IONOS, etc), nameservers asignados, fechas de registro y expiracion, autoRenew, transferLock, status del dominio. Invocar ANTES de asumir cualquier dato sobre el registrar de un dominio - el resultado es la unica fuente confiable. Reemplaza la necesidad de que el operador corra whois o aws cli desde terminal. Lectura auditada: no muta infraestructura y no requiere ApprovalGate.",
      input_schema: {
        type: "object",
        required: ["domain"],
        properties: {
          domain: {
            type: "string",
            pattern: domainPattern,
            description: "Dominio sin protocolo ni path. Ejemplo: controldelivrix.app"
          }
        }
      }
    },
    paramSchema: route53DomainDetailParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      hasAwsRoute53DomainCredentials(env),
    targetType: "domain",
    severity: "high"
  },
  read_route53_zone_records: {
    spec: {
      name: "read_route53_zone_records",
      description: "Lista todos los registros DNS dentro de una hosted zone Route53 (NS, SOA, A, AAAA, MX, TXT, CNAME, PTR, SRV, CAA). Invocar SIEMPRE ANTES de proponer upsert_dns_route53 para no escribir sobre registros que ya coinciden con lo deseado, y ANTES de diagnosticar fallos de propagacion DNS. Reemplaza dig. Lectura auditada: no muta DNS y no requiere ApprovalGate.",
      input_schema: {
        type: "object",
        required: ["zoneId"],
        properties: {
          zoneId: {
            type: "string",
            pattern: "^Z[A-Z0-9]{10,32}$",
            description: "ID de la hosted zone Route53. Formato Z seguido de 10-32 caracteres. Ejemplo: Z03595092JW2AXJBZGN4E"
          },
          recordType: {
            type: "string",
            enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"],
            description: "Filtrar por tipo de record. Opcional."
          },
          recordName: {
            type: "string",
            description: "Filtrar por nombre exacto del record. Opcional. Ejemplo: smtp.controldelivrix.app"
          }
        }
      }
    },
    paramSchema: route53ZoneRecordsParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      hasAwsRoute53DnsCredentials(env),
    targetType: "route53_hosted_zone",
    severity: "high"
  },
  update_domain_nameservers: {
    spec: {
      name: "update_domain_nameservers",
      description: [
        "Realinea los nameservers del registrar Route53 Domains hacia una hosted zone Route53 verificada en nuestra cuenta.",
        "Riesgo crítico/live wallet: requiere ApprovalGate HMAC, flag AWS_ROUTE53_DOMAINS_ENABLE_NAMESERVER_UPDATES, zona destino con A+MX existentes, audit, kill switch y operación idempotente. No delega a nameservers externos."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          zoneId: {
            type: "string",
            pattern: "^Z[A-Z0-9]{10,32}$",
            description: "Hosted zone Route53 destino opcional. Si se envía, el gateway verifica que pertenezca al dominio y cuenta AWS."
          },
          nameservers: {
            type: "array",
            minItems: 2,
            maxItems: 13,
            items: {
              type: "string",
              pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}\\.)+[a-z0-9-]{2,63}\\.?$"
            },
            description: "Opcional: debe coincidir exactamente con los NS de la hosted zone verificada."
          },
          ...optionalTaskId
        },
        required: ["domain"]
      }
    },
    paramSchema: route53NameserverUpdateParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      anyFlagEnabled(env, ["AWS_ROUTE53_DOMAINS_ENABLE_NAMESERVER_UPDATES", "AWS_ROUTE53_ENABLE_NAMESERVER_UPDATES"]) &&
      hasAwsRoute53DomainCredentials(env) &&
      hasAwsRoute53DnsCredentials(env),
    targetType: "domain",
    severity: "critical"
  },
  read_dns_ionos: {
    spec: {
      name: "read_dns_ionos",
      description: "Lista registros DNS en IONOS por domain o zoneId. Invocar SIEMPRE ANTES de upsert_dns_ionos para no escribir a ciegas ni pisar records existentes. Lectura sensible auditada: no requiere ApprovalGate, no muta DNS y no depende de IONOS_DNS_ENABLE_WRITES.",
      input_schema: {
        type: "object",
        required: [],
        properties: {
          domain: {
            type: "string",
            pattern: domainPattern,
            description: "Dominio o subdominio para resolver la zona IONOS. Ejemplo: nationalcorphub.app"
          },
          zoneId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "ID de zona IONOS opcional cuando ya se conoce."
          },
          recordType: {
            type: "string",
            enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"],
            description: "Filtrar por tipo de record. Opcional."
          },
          recordName: {
            type: "string",
            description: "Filtrar por nombre exacto del record. Opcional."
          }
        }
      }
    },
    paramSchema: ionosDnsReadParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      hasIonosDnsCredentials(env),
    targetType: "ionos_dns_zone",
    severity: "high"
  },
  read_webdock_servers: {
    spec: {
      name: "read_webdock_servers",
      description: [
        "Lee el inventario Webdock real vía Gateway Delivrix, incluyendo slug, status, IPv4, profileSlug, imageSlug, hostname/mainDomain cuando Webdock lo expone, y drift contra sender_node local.",
        "Invocar antes de asumir que un VPS existe, crear otro VPS, bindear dominio o provisionar SMTP en un server.",
        "Lectura auditada: no muta infraestructura, no crea servidores y no requiere ApprovalGate."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          serverSlug: {
            type: "string",
            pattern: slugPattern,
            description: "Filtrar por slug Webdock opcional. Ejemplo: server10."
          },
          ipv4: {
            type: "string",
            pattern: ipv4Pattern,
            description: "Filtrar por IPv4 opcional. Ejemplo: 45.136.70.47."
          }
        },
        required: []
      }
    },
    paramSchema: readWebdockServersParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "webdock_inventory",
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
          ...optionalTaskId,
          ...optionalRepairScope
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
          },
          ...optionalRepairScope
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
          runId: { type: "string", minLength: 1, maxLength: 64 },
          pollIntervalMs: { type: "integer", minimum: 0, maximum: 60000 },
          maxPolls: { type: "integer", minimum: 0, maximum: 60 },
          ...optionalTaskId,
          ...optionalRepairScope
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
          setPtr: { type: "boolean", default: true },
          ...optionalRepairScope
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
          ...optionalTaskId,
          ...optionalRepairScope
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
          ...optionalTaskId,
          ...optionalRepairScope
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
          ...optionalTaskId,
          ...optionalRepairScope
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
          ...optionalTaskId,
          ...optionalRepairScope
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
          serverSlug: { type: "string", pattern: slugPattern },
          ...optionalRepairScope
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
  compact_intent: {
    spec: {
      name: "compact_intent",
      description: [
        "Compacta el resultado final de un intent OpenClaw en memoria episódica.",
        "Uso interno y auditado: guardar resumen de pasos, hashes de inputs, outcomes y proveniencia para que futuras ejecuciones no repitan trabajo ni inventen estado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          intentId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$" },
          finalStatus: { type: "string", enum: ["completed", "failed", "cancelled", "rolled_back"] },
          decision: { type: "string", minLength: 1, maxLength: 280 },
          ttlDays: { type: "integer", minimum: 1, maximum: 365 },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                step: { type: "integer", minimum: 1, maximum: 10000 },
                tool: { type: "string", minLength: 1, maxLength: 128 },
                inputHash: { type: "string", pattern: "^[a-f0-9]{8,64}$" },
                outcome: {
                  type: "string",
                  enum: ["success", "failed", "rolled_back", "rollback_failed", "cancelled_by_operator", "timeout", "partial"]
                },
                outcomeData: { type: "object" },
                errorClass: { type: "string", minLength: 1, maxLength: 128 },
                errorMessage: { type: "string", minLength: 1, maxLength: 2000 },
                durationMs: { type: "integer", minimum: 0, maximum: 86400000 },
                proposalId: { type: "string", minLength: 1, maxLength: 128 },
                signatureId: { type: "string", minLength: 1, maxLength: 128 },
                toolUseId: { type: "string", minLength: 1, maxLength: 128 },
                toolCallId: { type: "string", minLength: 1, maxLength: 128 },
                auditEventId: { type: "string", minLength: 1, maxLength: 128 }
              },
              required: ["step", "tool", "inputHash", "outcome"],
              additionalProperties: false
            }
          }
        },
        required: ["intentId", "finalStatus", "decision", "steps"]
      }
    },
    paramSchema: compactIntentParamSchema,
    enabled: (env) => hmacConfigured(env) && postgresConfigured(env),
    targetType: "openclaw_memory",
    severity: "high"
  },
  configure_complete_smtp: {
    spec: {
      name: "configure_complete_smtp",
      description: [
        "Orquesta SMTP completo desde cero: dominio seguro, compra Route53, VPS Webdock, Main domain/PTR, DNS, Postfix/OpenDKIM, SPF/DKIM/DMARC, warmup mínimo y un correo real autorizado.",
        "Requiere ApprovalGate por cada acción real cuando OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE está OFF. Con el flag ON, una firma de plan puede cubrir solo el runId/domain/provider/budget/recipient explícitos. Audit/canvas events, kill switch, rollback proposal para VPS y presupuesto máximo siguen obligatorios. Tiempo estimado: 1-3 horas. Costo referencial: USD 15 dominio + USD 4.30/mes VPS prorrateado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1, maxLength: 64 },
          domain: { type: "string", minLength: 1 },
          provider: { type: "string", minLength: 1, maxLength: 32 },
          requireExistingDomain: {
            type: "boolean",
            description: "true solo para adopción estricta de un dominio Route53 ya owned; false/omitido permite compra fresca si no es owned."
          },
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
      isOpenClawToolEnabled("read_route53_domain_detail", env) &&
      isOpenClawToolEnabled("read_route53_zone_records", env) &&
      isOpenClawToolEnabled("read_webdock_servers", env) &&
      isOpenClawToolEnabled("create_webdock_server", env) &&
      isOpenClawToolEnabled("bind_webdock_main_domain", env) &&
      isOpenClawToolEnabled("upsert_dns_route53", env) &&
      isOpenClawToolEnabled("provision_smtp_postfix", env) &&
      isOpenClawToolEnabled("configure_email_auth", env) &&
      isOpenClawToolEnabled("seed_warmup_pool", env) &&
      isOpenClawToolEnabled("send_real_email", env) &&
      isOpenClawToolEnabled("read_episodic_scratch", env) &&
      isOpenClawToolEnabled("compact_intent", env),
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
    "read_episodic_scratch",
    "wait_for_dns_propagation",
    "read_route53_domain_detail",
    "read_route53_zone_records",
    "update_domain_nameservers",
    "read_dns_ionos",
    "read_webdock_servers",
    "upsert_dns_route53",
    "upsert_dns_ionos",
    "create_webdock_server",
    "bind_webdock_main_domain",
    "provision_smtp_postfix",
    "configure_email_auth",
    "bind_domain_to_server",
    "seed_warmup_pool",
    "send_real_email",
    "compact_intent",
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

function postgresConfigured(env: Record<string, string | undefined>): boolean {
  return env.OPENCLAW_EPISODIC_SCRATCH_ENABLE !== "false";
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
