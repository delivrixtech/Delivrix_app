import type { SkillParamSchema } from "./skill-schemas.ts";
import {
  adoptWebdockServerParamSchema,
  bindDomainParamSchema,
  compactIntentParamSchema,
  configureCompleteSmtpSkillParamSchema,
  createSmtpEntryParamSchema,
  ensureServerSshAccessParamSchema,
  emailAuthParamSchema,
  enableSmtpAuthParamSchema,
  inspectSmtpInventoryParamSchema,
  ionosDnsReadParamSchema,
  ionosUpsertParamSchema,
  namecheapUpsertParamSchema,
  listConversationsParamSchema,
  mxtoolboxHealthParamSchema,
  readInfrastructureAccountHealthParamSchema,
  readConversationParamSchema,
  readEpisodicScratchParamSchema,
  semanticRememberParamSchema,
  semanticRecallParamSchema,
  readInfrastructureInventoryParamSchema,
  readWebdockServersParamSchema,
  reassignDomainServerParamSchema,
  reconcileDnsToLiveSmtpParamSchema,
  resolveAmbiguousDomainParamSchema,
  retireInfrastructureAccountParamSchema,
  retireSmtpEntryParamSchema,
  route53DomainDetailParamSchema,
  deliveryReasonParamSchema,
  smtpReachabilityParamSchema,
  dkimStatusParamSchema,
  runStateIntegrityParamSchema,
  route53NameserverUpdateParamSchema,
  route53RegisterParamSchema,
  namecheapRegisterParamSchema,
  route53ZoneRecordsParamSchema,
  route53UpsertParamSchema,
  smtpProvisionParamSchema,
  updateSmtpEntryParamSchema,
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
  | "register_domain_namecheap"
  | "suggest_safe_domain"
  | "read_episodic_scratch"
  | "wait_for_dns_propagation"
  | "read_route53_domain_detail"
  | "read_route53_zone_records"
  | "read_delivery_reason"
  | "read_smtp_reachability"
  | "read_dkim_status"
  | "read_run_state_integrity"
  | "update_domain_nameservers"
  | "read_dns_ionos"
  | "read_mxtoolbox_health"
  | "read_infrastructure_inventory"
  | "inspect_smtp_inventory"
  | "read_infrastructure_account_health"
  | "read_webdock_servers"
  | "list_conversations"
  | "read_conversation"
  | "upsert_dns_route53"
  | "upsert_dns_ionos"
  | "upsert_dns_namecheap"
  | "create_webdock_server"
  | "bind_webdock_main_domain"
  | "provision_smtp_postfix"
  | "configure_email_auth"
  | "reconcile_dns_to_live_smtp"
  | "enable_smtp_auth"
  | "resolve_ambiguous_domain"
  | "retire_smtp_entry"
  | "reassign_domain_server"
  | "create_smtp_entry"
  | "adopt_webdock_server"
  | "ensure_server_ssh_access"
  | "update_smtp_entry"
  | "bind_domain_to_server"
  | "seed_warmup_pool"
  | "send_real_email"
  | "compact_intent"
  | "configure_complete_smtp"
  | "retire_infrastructure_account";

interface OpenClawToolDefinition {
  spec: BedrockToolSpec;
  paramSchema: SkillParamSchema;
  enabled(env: Record<string, string | undefined>): boolean;
  targetType: string;
  severity: "high" | "critical";
}

const domainPattern = "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$";
const dnsRecordNamePattern = "^[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?(?:\\.[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?)*$";
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

const namecheapRecordSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["A", "MX", "TXT", "CNAME"] },
    content: { type: "string", minLength: 1 },
    ttl: { type: "integer", minimum: 60, maximum: 604800 },
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
  register_domain_namecheap: {
    spec: {
      name: "register_domain_namecheap",
      description: [
        "Registra un dominio nuevo vía Namecheap (registrador multicuenta).",
        "Riesgo crítico: compra irreversible o con costo externo; requiere ApprovalGate, audit chain íntegra y cap de presupuesto mensual (NAMECHEAP_DOMAINS_MONTHLY_CAP_USD).",
        "Opcional accountId para elegir cuenta Namecheap; por defecto la primera. La IP del gateway debe estar whitelisteada en la cuenta Namecheap."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          years: { type: "integer", minimum: 1, maximum: 10 },
          whoisPrivacy: { type: "boolean", default: true },
          accountId: { type: "string" },
          ...optionalRepairScope
        },
        required: ["domain", "years"]
      }
    },
    paramSchema: namecheapRegisterParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      anyFlagEnabled(env, ["NAMECHEAP_ENABLE_PURCHASE"]) &&
      hasNamecheapCredentials(env),
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
  semantic_remember: {
    spec: {
      name: "semantic_remember",
      description: [
        "Guarda un hallazgo, aprendizaje o hecho verificado en la memoria semántica de OpenClaw (vector + full-text en español).",
        "Escritura interna auditada, sin side effects externos ni ApprovalGate: sirve para recordar conocimiento entre turnos y recuperarlo luego por significado.",
        "Si los embeddings no están configurados, la memoria se guarda igual en modo full-text."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          memoryType: { type: "string", minLength: 1, maxLength: 64, description: "Categoría del recuerdo: finding, learning, fact, decision, etc." },
          content: { type: "string", minLength: 1, maxLength: 8000, description: "El conocimiento a recordar, en texto claro." },
          visibility: { type: "string", enum: ["private", "shared_family", "shared_global", "human_authored"], default: "private" },
          metadata: { type: "object", description: "Metadata estructurada opcional (dominio, IP, runId, etc.)." },
          taskId: { type: "string", minLength: 1, maxLength: 128 },
          sourcePath: { type: "string", minLength: 1, maxLength: 512 }
        },
        required: ["memoryType", "content"]
      }
    },
    paramSchema: semanticRememberParamSchema,
    enabled: (env) => hmacConfigured(env) && postgresConfigured(env),
    targetType: "openclaw_memory",
    severity: "high"
  },
  semantic_recall: {
    spec: {
      name: "semantic_recall",
      description: [
        "Recupera memoria relevante por significado con búsqueda híbrida (vector + full-text en español, fusión RRF).",
        "Read-only, sin ApprovalGate: úsalo al inicio de una decisión para traer hallazgos, aprendizajes y hechos verificados previos sin repetir trabajo.",
        "Si los embeddings no están configurados, degrada a búsqueda full-text."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 3, maxLength: 1000, description: "Pregunta o necesidad de decisión para buscar memoria relevante." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
          memoryType: { type: "string", minLength: 1, maxLength: 64 },
          visibilities: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: { type: "string", enum: ["private", "shared_family", "shared_global", "human_authored"] }
          }
        },
        required: ["query"]
      }
    },
    paramSchema: semanticRecallParamSchema,
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
          domain: {
            type: "string",
            pattern: dnsRecordNamePattern,
            description: "Nombre DNS objetivo del record a esperar. Acepta labels con underscore para DKIM/DMARC, por ejemplo s2026a._domainkey.example.com o _dmarc.example.com."
          },
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
  read_delivery_reason: {
    spec: {
      name: "read_delivery_reason",
      description: "Devuelve el motivo REAL de entrega/rebote de un correo en un servidor SMTP propio leyendo mail.log de Postfix por SSH del lado del gateway (el agente NO ejecuta SSH). Resuelve el queue-id desde el message-id y reporta status final (sent/bounced/deferred/expired), codigo SMTP (ej 550), codigo DSN (ej 5.7.1), destinatario, relay y motivo textual. Invocar para diagnosticar por que rebota un mensaje en vez de asumir 'puerto 25 bloqueado' u otras causas sin evidencia. Lectura auditada: no envia ni muta nada y no requiere ApprovalGate.",
      input_schema: {
        type: "object",
        required: ["serverSlug", "serverIp", "messageId"],
        properties: {
          serverSlug: {
            type: "string",
            pattern: slugPattern,
            description: "Slug del servidor SMTP (de read_webdock_servers / read_sender_nodes)."
          },
          serverIp: {
            type: "string",
            pattern: ipv4Pattern,
            description: "IP del servidor (de read_webdock_servers / read_sender_nodes)."
          },
          messageId: {
            type: "string",
            minLength: 1,
            maxLength: 255,
            description: "Message-ID del correo, ej <delivrix-abc123@dominio.com> (lo retorna send_real_email)."
          }
        }
      }
    },
    paramSchema: deliveryReasonParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      hasSshRunnerConfig(env),
    targetType: "webdock_server",
    severity: "high"
  },
  read_smtp_reachability: {
    spec: {
      name: "read_smtp_reachability",
      description: "Diagnostica si un servidor SMTP propio realmente puede ENTREGAR correo. Corre por SSH del lado gateway DOS chequeos separados: inbound (postfix activo y escuchando en :25 = puede recibir) y OUTBOUND (puede abrir TCP a un MX publico en :25 = puede enviar). Invocar para no confundir 'escucha en 25' con 'entrega', y para no declarar 'puerto 25 bloqueado' sin evidencia. Si el probe no corre devuelve outbound 'unknown' (nunca un 'blocked' falso). Lectura auditada: no envia ni muta nada.",
      input_schema: {
        type: "object",
        required: ["serverSlug", "serverIp"],
        properties: {
          serverSlug: {
            type: "string",
            pattern: slugPattern,
            description: "Slug del servidor SMTP (de read_webdock_servers / read_sender_nodes)."
          },
          serverIp: {
            type: "string",
            pattern: ipv4Pattern,
            description: "IP del servidor (de read_webdock_servers / read_sender_nodes)."
          }
        }
      }
    },
    paramSchema: smtpReachabilityParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      hasSshRunnerConfig(env),
    targetType: "webdock_server",
    severity: "high"
  },
  read_dkim_status: {
    spec: {
      name: "read_dkim_status",
      description: "Diagnostica DKIM de un dominio probando los selectores REALES (la convencion Delivrix s<anio>a, ej s2026a, + 'default' y comunes), no solo 'default'. Distingue valid / revoked (registro presente pero p= vacio) / absent / unknown. Invocar antes de declarar 'DKIM missing': el preflight puede pegar al selector equivocado y dar un falso negativo, o contar una clave revocada como OK. Si DNS no responde devuelve 'unknown' (nunca un 'absent' falso). Lectura auditada: no muta DNS.",
      input_schema: {
        type: "object",
        required: ["domain"],
        properties: {
          domain: {
            type: "string",
            pattern: domainPattern,
            description: "Dominio sin protocolo ni path. Ejemplo: bizreport-control.com"
          },
          expectedSelector: {
            type: "string",
            pattern: selectorPattern,
            description: "Selector esperado, opcional. Se prueba primero antes de la convencion Delivrix y los comunes."
          }
        }
      }
    },
    paramSchema: dkimStatusParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "domain",
    severity: "high"
  },
  read_run_state_integrity: {
    spec: {
      name: "read_run_state_integrity",
      description: "Audita la completitud del run-state de provisioning: cruza los dominios que ENVIARON correo real (de los eventos auditados) contra los runs registrados y reporta los dominios que envian SIN run (ej. annualcorpfilings 10/10 sin run) mas los runs en estado failed/cancelled. Invocar para detectar servers fuera del flujo auditado y runs colgados antes de declarar la flota sana. Sin parametros. Lectura auditada: no muta nada y no requiere ApprovalGate.",
      input_schema: {
        type: "object",
        required: [],
        properties: {}
      }
    },
    paramSchema: runStateIntegrityParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "openclaw_orchestrator",
    severity: "high"
  },
  read_route53_zone_records: {
    spec: {
      name: "read_route53_zone_records",
      description: "Lista registros DNS Route53 por domain. El Gateway descubre la hosted zone por nombre en runtime y, si hay duplicados, elige la autoritativa comparando NS del registrador. Si se envia zoneId junto con domain, se valida contra la zona autoritativa y se rechaza si es stale. Invocar SIEMPRE ANTES de proponer upsert_dns_route53 para no escribir sobre registros que ya coinciden con lo deseado, y ANTES de diagnosticar fallos de propagacion DNS. Lectura auditada: no muta DNS y no requiere ApprovalGate.",
      input_schema: {
        type: "object",
        required: ["domain"],
        properties: {
          domain: {
            type: "string",
            pattern: domainPattern,
            description: "Dominio apex para descubrir la hosted zone autoritativa en runtime. Ejemplo: controlcorpfiling.com"
          },
          zoneId: {
            type: "string",
            pattern: "^Z[A-Z0-9]{10,32}$",
            description: "ID opcional solo como evidencia; debe coincidir con la zona autoritativa descubierta por domain."
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
  read_mxtoolbox_health: {
    spec: {
      name: "read_mxtoolbox_health",
      description: [
        "Consulta MXToolbox en modo read-only para diagnosticar blacklist y salud SMTP/DNS de una IP o dominio autorizado.",
        "Usar antes de asumir reputacion: comandos permitidos blacklist, smtp, mx, spf, dkim, dmarc, ptr, a, txt, dns, bimi y mta-sts.",
        "No expone raw ni API key; devuelve status clean/warning/listed/error, checks fallidos y rawRef auditado."
      ].join(" "),
      input_schema: {
        type: "object",
        required: ["target"],
        properties: {
          target: {
            type: "string",
            minLength: 1,
            maxLength: 253,
            description: "IP o dominio a diagnosticar. Ejemplos: 8.8.8.8, mail.delivrix.com"
          },
          type: {
            type: "string",
            enum: ["blacklist", "smtp", "mx", "spf", "dkim", "dmarc", "ptr", "a", "txt", "dns", "bimi", "mta-sts"],
            description: "Tipo de lookup MXToolbox. Default: blacklist."
          },
          selector: {
            type: "string",
            pattern: selectorPattern,
            description: "Selector DKIM opcional cuando type=dkim."
          }
        }
      }
    },
    paramSchema: mxtoolboxHealthParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      hasMxtoolboxCredentials(env),
    targetType: "ip_or_domain_reputation",
    severity: "high"
  },
  read_webdock_servers: {
    spec: {
      name: "read_webdock_servers",
      description: [
        "Colector Webdock LEGACY single-account (drift + campos webdock-specific). NO es la fuente autoritativa de la flota.",
        "Usar SOLO para: (a) drift Webdock contra sender_node local, (b) inputs de create_webdock_server/bind_webdock_main_domain, (c) scope explicito provider=webdock.",
        "Para saber que servidores/cuentas EXISTEN o estan vivos usa SIEMPRE read_infrastructure_inventory primero (autoritativa multi-cuenta). Si source.kind es 'unavailable' o 'mock', NO hay datos reales aca: no actues sobre estas filas.",
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
  read_infrastructure_inventory: {
    spec: {
      name: "read_infrastructure_inventory",
      description: [
        "FUENTE AUTORITATIVA de la flota multi-cuenta: cuentas Webdock (incl. quinary/InfraVPS), proveedores VPS como Contabo, DNS, registrars y estados degradados por proveedor.",
        "Es la verdad sobre que servidores y cuentas EXISTEN y estan vivos. Invocala PRIMERO antes de afirmar que un VPS existe, adoptar/crear un server, bindear dominio o provisionar SMTP.",
        "Ante conflicto con read_webdock_servers (legacy), gana esta; la divergencia se audita como drift.",
        "Lectura auditada read-only: no muta infraestructura, no crea servidores y no requiere ApprovalGate."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {},
        required: []
      }
    },
    paramSchema: readInfrastructureInventoryParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "infrastructure_inventory",
    severity: "high"
  },
  inspect_smtp_inventory: {
    spec: {
      name: "inspect_smtp_inventory",
      description: [
        "Inspecciona el inventario SMTP local y lo cruza con la flota viva para detectar dominios ambiguos, entradas superseded/retired y servidores ausentes.",
        "Lectura sensible read-only: no muta infraestructura, no expone passwords ni credenciales cifradas y no requiere ApprovalGate."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          serverSlug: { type: "string", pattern: slugPattern },
          status: { type: "string", enum: ["configured", "superseded", "retired", "archived"] }
        },
        required: []
      }
    },
    paramSchema: inspectSmtpInventoryParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "smtp_inventory",
    severity: "high"
  },
  read_infrastructure_account_health: {
    spec: {
      name: "read_infrastructure_account_health",
      description: [
        "Lee el diagnostico read-only de salud de cuentas de infraestructura: cuentas Webdock degradadas, retiradas, ultimo conteo conocido, reporte de huerfanos y salud de memoria episodica.",
        "No muta infraestructura, no toca credenciales y no requiere ApprovalGate; usar antes de proponer retirar una cuenta."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {},
        required: []
      }
    },
    paramSchema: readInfrastructureAccountHealthParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "infrastructure_account_health",
    severity: "high"
  },
  list_conversations: {
    spec: {
      name: "list_conversations",
      description: [
        "Lista conversaciones persistidas de OpenClaw para que el agente pueda ubicar sesiones previas sin depender del historial recortado.",
        "Lectura read-only gateada por token de lectura; devuelve resúmenes paginados y no requiere ApprovalGate."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 0, maximum: 10000 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
        },
        required: []
      }
    },
    paramSchema: listConversationsParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "openclaw_chat_history",
    severity: "high"
  },
  read_conversation: {
    spec: {
      name: "read_conversation",
      description: [
        "Lee una conversación específica de OpenClaw con paginación y truncado por turno para recuperar contexto previo de forma estructurada.",
        "Lectura read-only gateada por token de lectura; no requiere ApprovalGate y no debe usarse para extraer secretos."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            pattern: taskIdPattern,
            description: "ID de conversación a leer."
          },
          offset: { type: "integer", minimum: 0, maximum: 10000 },
          limit: { type: "integer", minimum: 1, maximum: 8, default: 6 },
          maxCharsPerTurn: { type: "integer", minimum: 1, maximum: 800, default: 500 }
        },
        required: ["conversationId"]
      }
    },
    paramSchema: readConversationParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "openclaw_chat_history",
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
  upsert_dns_namecheap: {
    spec: {
      name: "upsert_dns_namecheap",
      description: [
        "Crea o actualiza registros DNS (A/MX/TXT/CNAME) en la zona propia de Namecheap (BasicDNS) del dominio.",
        "Namecheap es autoritativo e INDEPENDIENTE: no delega a Route53 ni a otro proveedor. La cuenta se direcciona por accountId (id/label), nunca por defecto.",
        "Riesgo alto: afecta resolución y autenticación de correo; requiere ApprovalGate, audit, NAMECHEAP_DNS_ENABLE_WRITES y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          records: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: namecheapRecordSchema
          },
          accountId: { type: "string", description: "Cuenta Namecheap destino (id/label). Omitir sólo si hay una única cuenta." },
          ...optionalRepairScope
        },
        required: ["domain", "records"]
      }
    },
    paramSchema: namecheapUpsertParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.NAMECHEAP_DNS_ENABLE_WRITES) &&
      hasNamecheapCredentials(env),
    targetType: "namecheap_dns_zone",
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
        "Alinea el Server Identity de Webdock a smtp.<dominio>, quita el alias default y verifica FCrDNS antes de declarar el VPS SMTP listo.",
        "Riesgo crítico: altera identidad SMTP/PTR; requiere ApprovalGate, audit, Webdock ops key, A record ya propagado, verificación FCrDNS y kill switch."
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
  reconcile_dns_to_live_smtp: {
    spec: {
      name: "reconcile_dns_to_live_smtp",
      description: [
        "Reconciliacion firmada DNS->SMTP vivo para dominios ya provisionados: descubre la hosted zone Route53 por domain en runtime, valida NS autoritativo, verifica que serverSlug exista vivo en inventario y alinea smtp A, apex SPF y MX al serverIp vivo.",
        "No crea VPS, no toca cuentas ops/quaternary y no regenera DKIM en silencio; si falta DKIM del selector, bloquea con dkim_regenerate_required para ejecutar el flujo DKIM/email-auth antes del cutover.",
        "Usar dryRun=true primero para presentar el plan; la ejecucion real requiere ApprovalGate, writes Route53, audit y kill switch."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          serverSlug: { type: "string", pattern: slugPattern },
          serverIp: {
            type: "string",
            pattern: ipv4Pattern,
            description: "IPv4 esperada del servidor vivo. Opcional: si se omite se toma del inventario live/server."
          },
          selector: {
            type: "string",
            pattern: selectorPattern,
            default: "s2026a",
            description: "Selector DKIM que debe existir antes de repuntar DNS. No se regenera en esta tool."
          },
          dryRun: { type: "boolean", default: true },
          ...optionalTaskId,
          ...optionalRepairScope
        },
        required: ["domain", "serverSlug"]
      }
    },
    paramSchema: reconcileDnsToLiveSmtpParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.OPENCLAW_RECONCILE_DNS_SMTP_ENABLE) &&
      anyFlagEnabled(env, ["AWS_ROUTE53_DNS_ENABLE_WRITES", "AWS_ROUTE53_ENABLE_DNS_WRITES"]) &&
      hasAwsRoute53DnsCredentials(env),
    targetType: "domain",
    severity: "critical"
  },
  enable_smtp_auth: {
    spec: {
      name: "enable_smtp_auth",
      description: [
        "Genera, recupera o rota una credencial SMTP AUTH para un solo dominio sender ya configurado, usando retrofit SASL single-target.",
        "Requiere ApprovalGate humano, SSH runner, audit y kill switch. No imprime password ni markdown: la credencial se descarga despues desde Sender Pool."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          serverSlug: {
            type: "string",
            pattern: slugPattern,
            description: "Servidor SMTP especifico para desambiguar dominios con historial duplicado. Opcional; si se omite y hay mas de un configured, la tool rechaza ambiguous_domain."
          },
          mode: {
            type: "string",
            enum: ["enable", "recover", "rotate"],
            description: "enable=default para dominios sin SMTP AUTH; recover=solo stuck smtpAuthStatus configured sin credencial; rotate=regenera passdb y reemplaza la credencial anterior."
          }
        },
        required: ["domain"]
      }
    },
    paramSchema: enableSmtpAuthParamSchema,
    enabled: (env) =>
      hmacConfigured(env) &&
      flagEnabled(env.SMTP_PROVISIONING_ENABLE_SSH) &&
      hasSshRunnerConfig(env),
    targetType: "domain",
    severity: "critical"
  },
  resolve_ambiguous_domain: {
    spec: {
      name: "resolve_ambiguous_domain",
      description: [
        "Resuelve un dominio ambiguo en inventory/smtp-provisioning.json eligiendo un servidor canonico vivo y marcando los otros configured como superseded.",
        "Mutacion local-state-only: no toca DNS, SSH ni proveedor; requiere ApprovalGate firmado, audit log y kill switch desarmado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          keepServerSlug: {
            type: "string",
            pattern: slugPattern,
            description: "Servidor canonico a conservar. Si se omite, OpenClaw desempata con flota viva + run SMTP completed; si la evidencia sigue ambigua, rechaza fail-closed."
          },
          reason: { type: "string", minLength: 10, maxLength: 500 },
          dryRun: { type: "boolean", default: false }
        },
        required: ["domain"]
      }
    },
    paramSchema: resolveAmbiguousDomainParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "domain",
    severity: "high"
  },
  retire_smtp_entry: {
    spec: {
      name: "retire_smtp_entry",
      description: [
        "Marca una entrada SMTP concreta como retired en el inventario local preservando historial.",
        "Mutacion local-state-only: no borra VPS, no toca DNS/SSH ni credenciales; requiere ApprovalGate firmado, audit log y kill switch desarmado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          serverSlug: { type: "string", pattern: slugPattern },
          reason: { type: "string", minLength: 10, maxLength: 500 },
          dryRun: { type: "boolean", default: false }
        },
        required: ["domain", "serverSlug", "reason"]
      }
    },
    paramSchema: retireSmtpEntryParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "smtp_inventory_entry",
    severity: "high"
  },
  reassign_domain_server: {
    spec: {
      name: "reassign_domain_server",
      description: [
        "Reasigna el servidor canonico de un dominio en el inventario SMTP local, verificando que el destino exista en la flota viva.",
        "Mutacion local-state-only: no cambia DNS/SSH/proveedor; requiere ApprovalGate firmado, audit log y kill switch desarmado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          fromServerSlug: { type: "string", pattern: slugPattern },
          toServerSlug: { type: "string", pattern: slugPattern },
          reason: { type: "string", minLength: 10, maxLength: 500 },
          dryRun: { type: "boolean", default: false }
        },
        required: ["domain", "fromServerSlug", "toServerSlug", "reason"]
      }
    },
    paramSchema: reassignDomainServerParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "smtp_inventory_entry",
    severity: "high"
  },
  create_smtp_entry: {
    spec: {
      name: "create_smtp_entry",
      description: [
        "Crea una entrada configured NUEVA en el inventario SMTP local para un dominio+server ya verificado en la flota viva multi-proveedor.",
        "Es create-only: si ya existe una entrada para ese dominio+server (en cualquier estado) devuelve conflicto entry_already_exists; para modificarla usar update_smtp_entry y para retirarla retire_smtp_entry.",
        "Antes de escribir valida serverSlug+serverIp contra el inventario vivo y exige que el server este running y la cuenta saludable.",
        "Mutacion local-state-only: no toca DNS, SSH, proveedor ni credenciales; requiere ApprovalGate firmado, audit log critical y kill switch desarmado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          serverSlug: { type: "string", pattern: slugPattern },
          serverIp: { type: "string", pattern: ipv4Pattern },
          selector: { type: "string", pattern: selectorPattern },
          status: {
            type: "string",
            enum: ["configured"],
            default: "configured",
            description: "Fijo en configured; cualquier otro estado se rechaza."
          },
          reason: { type: "string", minLength: 10, maxLength: 500 },
          dryRun: {
            type: "boolean",
            default: true,
            description: "Default seguro: si se omite, solo planifica. Para escribir debe venir dryRun:false en una propuesta firmada."
          }
        },
        required: ["domain", "serverSlug", "serverIp", "selector", "reason"]
      }
    },
    paramSchema: createSmtpEntryParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "smtp_inventory_entry",
    severity: "critical"
  },
  adopt_webdock_server: {
    spec: {
      name: "adopt_webdock_server",
      description: [
        "Adopta (registra) en el inventario local webdock-servers.json un VPS Webdock ya existente, verificado running en la flota viva multi-cuenta (p.ej. cuenta quinary/InfraVPS) y sin entrada previa.",
        "Es create-only: si el slug ya esta en el inventario devuelve conflicto server_already_adopted; valida serverSlug+serverIp+serverAccountId contra la flota viva y exige cuenta saludable y proveedor webdock.",
        "Es el paso previo para reusar un server huerfano con configure_complete_smtp (reuseServerSlug) y para habilitar SSH/send sobre el (el server ademas necesita la pubkey del operador instalada).",
        "Mutacion local-state-only: no toca DNS, SSH, proveedor ni credenciales; requiere ApprovalGate firmado, audit log critical y kill switch desarmado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          serverSlug: { type: "string", pattern: slugPattern },
          serverIp: { type: "string", pattern: ipv4Pattern },
          serverAccountId: {
            type: "string",
            pattern: slugPattern,
            description: "Cuenta Webdock duena del server en la flota viva (p.ej. quinary). Debe coincidir con el accountId live."
          },
          reason: { type: "string", minLength: 10, maxLength: 500 },
          dryRun: {
            type: "boolean",
            default: true,
            description: "Default seguro: si se omite, solo planifica. Para escribir debe venir dryRun:false en una propuesta firmada."
          }
        },
        required: ["serverSlug", "serverIp", "serverAccountId", "reason"]
      }
    },
    paramSchema: adoptWebdockServerParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "webdock_server",
    severity: "critical"
  },
  ensure_server_ssh_access: {
    spec: {
      name: "ensure_server_ssh_access",
      description: [
        "Instala/asegura la clave SSH del operador en un VPS Webdock ya conocido (creado o adoptado), via la API del proveedor — NO requiere acceso SSH previo al server.",
        "Crea o actualiza el shell user del operador, le adjunta la pubkey WEBDOCK_OPERATOR_SSH_PUBLIC_KEY y fija sshSettings (sin password, sudo passwordless, puerto 22). Escritura REAL en el proveedor.",
        "Es el eslabon que hace autonomo el rescate: tras adopt_webdock_server, llamar esta tool deja el server accesible por SSH para provision_smtp_postfix/enable_smtp_auth/send. Si el server no esta en el inventario devuelve server_not_in_inventory (adoptar primero).",
        "Requiere ApprovalGate firmado, audit log critical y kill switch desarmado. Rollback: quitar el shell user/key por la consola Webdock."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          serverSlug: { type: "string", pattern: slugPattern },
          serverAccountId: {
            type: "string",
            pattern: slugPattern,
            description: "Cuenta Webdock write-capable duena del server (p.ej. quinary). Un accountId desconocido se rechaza (unknown_server_account)."
          },
          reason: { type: "string", minLength: 10, maxLength: 500 },
          dryRun: {
            type: "boolean",
            default: true,
            description: "Default seguro: si se omite, solo planifica. Para escribir en el proveedor debe venir dryRun:false en una propuesta firmada."
          }
        },
        required: ["serverSlug", "serverAccountId", "reason"]
      }
    },
    paramSchema: ensureServerSshAccessParamSchema,
    enabled: (env) => hmacConfigured(env) && hasWebdockOpsCredentials(env) && Boolean(firstNonEmpty(env.WEBDOCK_OPERATOR_SSH_PUBLIC_KEY)),
    targetType: "webdock_server",
    severity: "critical"
  },
  update_smtp_entry: {
    spec: {
      name: "update_smtp_entry",
      description: [
        "Actualiza metadata controlada de una entrada SMTP local: selector, status, tlsStatus o smtpAuthStatus.",
        "Mutacion local-state-only: si status pasa a configured, aplica el invariante de un solo configured por dominio. Requiere ApprovalGate firmado, audit log y kill switch desarmado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: domainPattern },
          serverSlug: { type: "string", pattern: slugPattern },
          selector: { type: "string", pattern: selectorPattern },
          status: { type: "string", enum: ["configured", "superseded", "retired", "archived"] },
          tlsStatus: { type: "string", minLength: 3, maxLength: 120 },
          smtpAuthStatus: { type: "string", enum: ["configured"] },
          reason: { type: "string", minLength: 10, maxLength: 500 },
          dryRun: { type: "boolean", default: false }
        },
        required: ["domain", "serverSlug"]
      }
    },
    paramSchema: updateSmtpEntryParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "smtp_inventory_entry",
    severity: "high"
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
            minItems: 3,
            maxItems: 3,
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
          selector: { type: "string", pattern: selectorPattern, default: "default" },
          idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" },
          runId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" },
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
        "Orquesta SMTP completo desde cero: dominio seguro, compra Route53 (o adopción IONOS/Route53), VPS elegible (Webdock o Contabo via vpsProviderId), Main domain/PTR, DNS (Route53 o IONOS via dnsProviderId), Postfix/OpenDKIM, SPF/DKIM/DMARC, warmup mínimo y un correo real autorizado.",
        "Requiere ApprovalGate por cada acción real cuando OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE está OFF. Con el flag ON, una firma de plan puede cubrir solo el runId/domain/provider/budget/recipient explícitos. Audit/canvas events, kill switch, rollback proposal para VPS y presupuesto máximo siguen obligatorios. Tiempo estimado: 1-3 horas. Costo referencial: USD 15 dominio + USD 4.30/mes VPS prorrateado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            description: "OBLIGATORIO. Identificador único del run (p.ej. 'smtp-<dominio>-rescate-<n>'). La firma de plan del ApprovalGate valida el scope contra este runId; sin él la firma falla (plan_scope_missing). Generá uno estable por run y reusalo si reanudás."
          },
          domain: { type: "string", minLength: 1 },
          provider: { type: "string", minLength: 1, maxLength: 32 },
          dnsProviderId: {
            type: "string",
            enum: ["route53", "ionos"],
            description: "Proveedor DNS del run. Omitido/route53 conserva Route53; ionos requiere dominio owned en IONOS y escribe DNS en IONOS."
          },
          requireExistingDomain: {
            type: "boolean",
            description: "true para adopción estricta de un dominio ya owned (Route53 o IONOS); false/omitido permite compra fresca Route53 si no es owned."
          },
          vpsProviderId: {
            type: "string",
            enum: ["webdock", "contabo"],
            description: "Proveedor de VPS del run (elegible). Omitido/webdock = Webdock (default); contabo = crea el VPS en Contabo (cuenta propia; PTR/rDNS manual en el panel Contabo). El campo 'provider' NO rutea el VPS."
          },
          serverAccountId: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            description: "Cuenta destino del proveedor para el VPS. PR1 aplica a Webdock: usar accountId de inventory_accounts; omitido = el governor elige cuenta."
          },
          reuseServerSlug: {
            type: "string",
            pattern: slugPattern,
            description: "Reusa/adopta un VPS Webdock existente por slug en vez de crear uno nuevo. OBLIGATORIO en rescates de dominios existentes (mover un dominio a un server ya adoptado): pásalo SIEMPRE con el slug destino. Si lo omitís y smtp.<dominio> ya apunta a un server vivo de la flota, el orquestador lo deriva solo para no crear un VPS por accidente; pero no dependas de eso, pasalo explícito. DNS, auth y smoke se alinean a la IP viva de ese server; no aplica a Contabo."
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
        required: ["runId", "brand", "budgetUsdMax", "testEmailRecipient", "testEmailSubject", "testEmailBody"]
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
  },
  retire_infrastructure_account: {
    spec: {
      name: "retire_infrastructure_account",
      description: [
        "Soft-retira una cuenta de infraestructura localmente para excluirla de inventario operativo y seleccion de creacion.",
        "Es local-state-only, reversible manualmente por operador y NO borra VPS, credenciales ni recursos del proveedor.",
        "Requiere ApprovalGate firmado, audit log y kill switch desarmado."
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          providerId: { type: "string", enum: ["webdock"] },
          accountId: {
            type: "string",
            pattern: selectorPattern,
            description: "Cuenta o slot canonico. Ejemplos: ops, secondary, tertiary."
          },
          accountLabel: { type: "string", minLength: 2, maxLength: 120 },
          reason: { type: "string", minLength: 10, maxLength: 500 }
        },
        required: ["providerId", "accountId", "reason"]
      }
    },
    paramSchema: retireInfrastructureAccountParamSchema,
    enabled: (env) => hmacConfigured(env),
    targetType: "infrastructure_account",
    severity: "high"
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
    "register_domain_namecheap",
    "suggest_safe_domain",
    "read_episodic_scratch",
    "wait_for_dns_propagation",
    "read_route53_domain_detail",
    "read_route53_zone_records",
    "read_delivery_reason",
    "read_smtp_reachability",
    "read_dkim_status",
    "read_run_state_integrity",
    "update_domain_nameservers",
    "read_dns_ionos",
    "read_mxtoolbox_health",
    "read_infrastructure_inventory",
    "inspect_smtp_inventory",
    "read_infrastructure_account_health",
    "read_webdock_servers",
    "list_conversations",
    "read_conversation",
    "upsert_dns_route53",
    "upsert_dns_ionos",
    "upsert_dns_namecheap",
    "create_webdock_server",
    "bind_webdock_main_domain",
    "provision_smtp_postfix",
    "configure_email_auth",
    "reconcile_dns_to_live_smtp",
    "enable_smtp_auth",
    "resolve_ambiguous_domain",
    "retire_smtp_entry",
    "reassign_domain_server",
    "create_smtp_entry",
    "adopt_webdock_server",
    "ensure_server_ssh_access",
    "update_smtp_entry",
    "bind_domain_to_server",
    "seed_warmup_pool",
    "send_real_email",
    "compact_intent",
    "configure_complete_smtp",
    "retire_infrastructure_account"
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
  if (firstNonEmpty(env.WEBDOCK_API_KEY_OPS, env.WEBDOCK_API_KEY, env.WEBDOCK_API_KEY_PRIMARY)) {
    return true;
  }
  // Cuentas Webdock aisladas (secondary..quinary): cuentan como credencial utilizable solo si son
  // write-capable (par _WRITE + _ACCOUNT), espejo de canCreate() del adapter multi-cuenta. Sin esto,
  // retirar las keys de la cuenta-1 muerta apagaba create/bind/configure_complete_smtp aunque
  // quinary siguiera viva y escribible.
  return ["SECONDARY", "TERTIARY", "QUATERNARY", "QUINARY"].some((role) =>
    Boolean(firstNonEmpty(env[`WEBDOCK_API_KEY_${role}_WRITE`])) &&
    Boolean(firstNonEmpty(env[`WEBDOCK_API_KEY_${role}_ACCOUNT`]))
  );
}

function hasSshRunnerConfig(env: Record<string, string | undefined>): boolean {
  return Boolean(firstNonEmpty(env.SMTP_PROVISION_SSH_KEY_PATH, env.SMTP_SSH_KEY_PATH));
}

function hasPorkbunCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(firstNonEmpty(env.PORKBUN_API_KEY, env.PORKBUN_SECRET_API_KEY));
}

function hasNamecheapCredentials(env: Record<string, string | undefined>): boolean {
  // Cuentas indexadas NAMECHEAP_ACCOUNT_{n}_API_USER + _API_KEY (mismo escaneo
  // que createNamecheapAdaptersFromEnv). Basta una cuenta con ambas llaves.
  for (let index = 1; index <= 50; index += 1) {
    if (
      nonEmpty(env[`NAMECHEAP_ACCOUNT_${index}_API_USER`]) &&
      nonEmpty(env[`NAMECHEAP_ACCOUNT_${index}_API_KEY`])
    ) {
      return true;
    }
  }
  return false;
}

function hasMxtoolboxCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(firstNonEmpty(env.MXTOOLBOX_API_KEY));
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
