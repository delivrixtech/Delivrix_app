// Pre-flight de entorno del gateway Delivrix.
//
// Valida -- en frio, al boot o via scripts/delivrix-env-doctor.sh -- que todas las
// variables criticas esten presentes y no en placeholder, agrupadas por feature.
//
// Nace del incidente del 2026-06-09 (Vercel CLI piso .env.local): el .env.example
// estaba incompleto, asi que cada reinicio destapaba OTRA var faltante a mitad de un
// run. Este check las reporta TODAS de una sola vez, antes de que el gateway levante
// degradado en silencio. El catalogo refleja exactamente lo que el codigo lee
// (openclaw-tools-builder.ts enabled(), main.ts, domains-purchase.ts).

export type EnvSeverity = "fatal" | "warn";
export type EnvKind =
  | "secret"
  | "secret-32-byte"
  | "token"
  | "flag"
  | "money"
  | "json-contact"
  | "csv-email"
  | "url";

export interface EnvVarSpec {
  /** Nombre canonico de la variable. */
  name: string;
  /** Grupo de feature al que pertenece (para el reporte). */
  group: string;
  /** fatal = el gateway no debe arrancar; warn = una feature no andara. */
  severity: EnvSeverity;
  kind: EnvKind;
  /** Nombres alternativos: la var se satisface con cualquiera (flags/creds con alias). */
  anyOf?: string[];
  /** Solo para flags: exige valor "true" (replica flagEnabled del codigo). */
  mustBeTrue?: boolean;
  /** Que se rompe si falta -- se imprime en el reporte. */
  breaks: string;
}

export type EnvIssueReason = "missing" | "placeholder" | "invalid";

export interface EnvIssue {
  name: string;
  group: string;
  severity: EnvSeverity;
  reason: EnvIssueReason;
  breaks: string;
  detail?: string;
}

export interface EnvPreflightResult {
  /** true si no hay issues fatales. */
  ok: boolean;
  fatal: EnvIssue[];
  warnings: EnvIssue[];
  okCount: number;
  checkedCount: number;
  report: string;
}

type EnvLike = Record<string, string | undefined>;

const PLACEHOLDER_NEEDLES = [
  "replace_with",
  "replace-with",
  "changeme",
  "change_me",
  "your_",
  "your-",
  "placeholder",
  "cambiar",
  "tu_token",
  "tu-token",
  "xxxx",
  "<replace",
  "<your",
  "<tu"
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Los 9 campos que parseAdminContact (domains-purchase.ts) exige no-vacios.
const ADMIN_CONTACT_REQUIRED_FIELDS = [
  "FirstName",
  "LastName",
  "ContactType",
  "AddressLine1",
  "City",
  "CountryCode",
  "ZipCode",
  "PhoneNumber",
  "Email"
];

/**
 * Catalogo canonico de variables criticas. El orden define el orden del reporte.
 * Las severidades reflejan el impacto real verificado en el incidente:
 *   - fatal: sin esto el nucleo no autentica (tools:0, panel 401, chat roto).
 *   - warn:  sin esto una feature concreta (flujo SMTP, compra, warmup) no anda.
 */
export const ENV_PREFLIGHT_CATALOG: readonly EnvVarSpec[] = [
  // --- Auth core: sin esto NADA util funciona ---
  {
    name: "OPENCLAW_HMAC_SECRET",
    group: "auth-core",
    severity: "fatal",
    kind: "secret",
    breaks: "el catalogo de tools de OpenClaw queda vacio (tools:0) y el agente recita texto crudo"
  },
  {
    name: "OPENCLAW_OPERATOR_HMAC_SECRET",
    group: "auth-core",
    severity: "fatal",
    kind: "secret",
    breaks: "la firma del operador no valida"
  },
  {
    name: "OPENCLAW_GATEWAY_TOKEN",
    group: "auth-core",
    severity: "fatal",
    kind: "token",
    breaks: "auth core del gateway"
  },
  {
    // Deuda conocida: hoy funciona porque gateway y panel comparten el MISMO valor
    // (aunque sea placeholder) en 127.0.0.1, asi que la auth local pasa. WARN -- no
    // fatal -- para no romper un arranque que hoy funciona; si se pierde del todo,
    // el Canvas Live WS da 401 ("reconnecting" perpetuo).
    name: "DELIVRIX_READ_BOUNDARY_TOKEN",
    group: "auth-core",
    severity: "warn",
    kind: "token",
    breaks: "boundary gateway<->panel; si falta, el Canvas Live WS queda en reconnecting (401)"
  },
  {
    // Misma deuda compartida. Ademas debe COINCIDIR con el container Hostinger:
    // regenerarlo exige actualizar ambos lados, por eso no se fuerza en el boot.
    name: "DELIVRIX_OPENCLAW_TOKEN",
    group: "auth-core",
    severity: "warn",
    kind: "token",
    breaks: "bridge/chat OpenClaw; si falta, el chat no autentica (debe coincidir con Hostinger)"
  },

  // --- Panel local sin firma (modo dev 127.0.0.1) ---
  {
    name: "OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL",
    group: "local-panel",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "firmar una propuesta en el ApprovalGate da Sign 401"
  },
  {
    name: "OPENCLAW_COMPACT_INTENT_ALLOW_UNSIGNED_LOCAL",
    group: "local-panel",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "la memoria del operador (compact_intent) da 400/503"
  },

  // --- Orquestador SMTP autonomo (1-firma) ---
  {
    name: "OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE",
    group: "smtp-autonomy",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "el orquestador configure_complete_smtp no aparece; OpenClaw cae a pasos manuales"
  },
  {
    name: "OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE",
    group: "smtp-autonomy",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "se pierde el modo 1-firma; pide aprobacion por cada paso"
  },

  // --- Flags de escritura del flujo SMTP (cada uno habilita una sub-tool) ---
  {
    name: "AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    anyOf: ["AWS_ROUTE53_ENABLE_PURCHASE", "AWS_ROUTE53_DOMAINS_PURCHASE_ENABLED"],
    breaks: "register_domain_route53 queda fuera del catalogo"
  },
  {
    name: "AWS_ROUTE53_DNS_ENABLE_WRITES",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    anyOf: ["AWS_ROUTE53_ENABLE_DNS_WRITES"],
    breaks: "upsert_dns_route53 queda fuera del catalogo"
  },
  {
    name: "AWS_ROUTE53_DOMAINS_ENABLE_NAMESERVER_UPDATES",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    anyOf: ["AWS_ROUTE53_ENABLE_NAMESERVER_UPDATES"],
    breaks: "update_domain_nameservers queda fuera del catalogo"
  },
  {
    name: "DOMAIN_BIND_ENABLE",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    anyOf: ["WEBDOCK_MAIN_DOMAIN_BIND_ENABLE", "WEBDOCK_BIND_MAIN_DOMAIN_ENABLE"],
    breaks: "bind_webdock_main_domain queda fuera del catalogo"
  },
  {
    name: "WEBDOCK_SERVERS_ENABLE_CREATE",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "create_webdock_server queda fuera del catalogo"
  },
  {
    name: "SMTP_PROVISIONING_ENABLE_SSH",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "provision_smtp_postfix queda fuera del catalogo"
  },
  {
    name: "EMAIL_AUTH_ENABLE_WRITES",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "configure_email_auth (SPF/DKIM/DMARC) queda fuera del catalogo"
  },
  {
    name: "WARMUP_ENABLE_SEND",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "seed_warmup_pool queda fuera del catalogo"
  },
  {
    name: "WARMUP_RAMP_ENABLE",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    breaks: "seed_warmup_pool queda fuera del catalogo"
  },
  {
    name: "SMTP_SEND_REAL_EMAIL_ENABLE",
    group: "smtp-flow",
    severity: "warn",
    kind: "flag",
    mustBeTrue: true,
    anyOf: ["SEND_REAL_EMAIL_ENABLE"],
    breaks: "send_real_email (smoke final) queda fuera del catalogo"
  },

  // --- Config de compra / warmup ---
  {
    name: "AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD",
    group: "smtp-config",
    severity: "warn",
    kind: "money",
    breaks: "register_domain_route53 bloquea con monthly_cap_missing"
  },
  {
    name: "DELIVRIX_ADMIN_CONTACT_JSON",
    group: "smtp-config",
    severity: "warn",
    kind: "json-contact",
    breaks: "register_domain_route53 bloquea con admin_contact_missing"
  },
  {
    name: "WARMUP_DEFAULT_SEED_INBOXES",
    group: "smtp-config",
    severity: "warn",
    kind: "csv-email",
    breaks: "el warmup no tiene buzones seed"
  },
  {
    name: "CREDENTIAL_ENCRYPTION_KEY",
    group: "smtp-auth",
    severity: "warn",
    kind: "secret-32-byte",
    breaks: "generacion/descarga de credenciales SMTP AUTH cifradas falla cerrado"
  },

  // --- Credenciales de proveedores ---
  {
    name: "WEBDOCK_API_KEY_PRIMARY",
    group: "providers",
    severity: "warn",
    kind: "secret",
    anyOf: ["WEBDOCK_API_KEY"],
    breaks: "lecturas Webdock (inventario) fallan"
  },
  {
    name: "WEBDOCK_API_KEY_OPS",
    group: "providers",
    severity: "warn",
    kind: "secret",
    anyOf: ["WEBDOCK_API_KEY"],
    breaks: "creacion/escritura de VPS Webdock falla"
  },
  {
    name: "AWS_ROUTE53_DOMAINS_ACCESS_KEY_ID",
    group: "providers",
    severity: "warn",
    kind: "secret",
    anyOf: ["AWS_ROUTE53_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
    breaks: "compra de dominio sin credenciales AWS"
  },
  {
    name: "AWS_ROUTE53_DOMAINS_SECRET_ACCESS_KEY",
    group: "providers",
    severity: "warn",
    kind: "secret",
    anyOf: ["AWS_ROUTE53_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
    breaks: "compra de dominio sin credenciales AWS"
  },
  {
    name: "AWS_ROUTE53_DNS_ACCESS_KEY_ID",
    group: "providers",
    severity: "warn",
    kind: "secret",
    anyOf: ["AWS_ROUTE53_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
    breaks: "lectura/escritura DNS Route53 (zona, upsert, email-auth) sin credenciales"
  },
  {
    name: "AWS_ROUTE53_DNS_SECRET_ACCESS_KEY",
    group: "providers",
    severity: "warn",
    kind: "secret",
    anyOf: ["AWS_ROUTE53_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
    breaks: "lectura/escritura DNS Route53 (zona, upsert, email-auth) sin credenciales"
  },
  {
    name: "SMTP_PROVISION_SSH_KEY_PATH",
    group: "providers",
    severity: "warn",
    kind: "secret",
    anyOf: ["SMTP_SSH_KEY_PATH"],
    breaks: "provision/bind/warmup/send SSH al VPS sin clave (provision_smtp_postfix, send_real_email)"
  },
  {
    name: "MXTOOLBOX_API_KEY",
    group: "providers",
    severity: "warn",
    kind: "secret",
    breaks: "lecturas MXtoolbox fallan"
  },
  {
    name: "PROXMOX_API_URL",
    group: "providers",
    severity: "warn",
    kind: "url",
    breaks: "provider proxmox no puede leer ni crear LXCs"
  },
  {
    name: "PROXMOX_TOKEN_ID",
    group: "providers",
    severity: "warn",
    kind: "token",
    breaks: "provider proxmox no puede autenticar contra PVE"
  },
  {
    name: "PROXMOX_TOKEN_SECRET",
    group: "providers",
    severity: "warn",
    kind: "secret",
    breaks: "provider proxmox no puede autenticar contra PVE"
  },
  {
    name: "PROXMOX_HOST_SSH_TARGET",
    group: "providers",
    severity: "warn",
    kind: "token",
    breaks: "provider proxmox no puede resetear identidad ni inyectar la pubkey por pct exec"
  },
  {
    name: "PROXMOX_IP_POOL",
    group: "providers",
    severity: "warn",
    kind: "token",
    anyOf: ["PROXMOX_TEST_NET0"],
    breaks: "provider proxmox no puede crear LXCs con red (usa IP pool publico o TEST_NET0 de smoke)"
  }
];

function isPlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (lower.length === 0) return false; // vacio se trata como missing, no placeholder
  return PLACEHOLDER_NEEDLES.some((needle) => lower.includes(needle));
}

function firstPresentValue(env: EnvLike, names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const raw = env[name];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return { name, value: raw.trim() };
    }
  }
  return null;
}

function validateValue(spec: EnvVarSpec, value: string): EnvIssueReason | null {
  if (isPlaceholder(value)) return "placeholder";

  switch (spec.kind) {
    case "flag":
      if (spec.mustBeTrue && value.toLowerCase() !== "true") return "invalid";
      return null;
    case "money": {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? null : "invalid";
    }
    case "json-contact": {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const missing = ADMIN_CONTACT_REQUIRED_FIELDS.some(
          (field) => typeof parsed[field] !== "string" || (parsed[field] as string).trim().length === 0
        );
        return missing ? "invalid" : null;
      } catch {
        return "invalid";
      }
    }
    case "csv-email": {
      const emails = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
      return emails.length > 0 && emails.every((email) => EMAIL_RE.test(email)) ? null : "invalid";
    }
    case "url": {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? null : "invalid";
      } catch {
        return "invalid";
      }
    }
    case "secret-32-byte":
      return isValid32ByteSecret(value) ? null : "invalid";
    case "secret":
    case "token":
    default:
      return null;
  }
}

function isValid32ByteSecret(value: string): boolean {
  const trimmed = value.trim();
  const candidates = [
    safeBufferFrom(trimmed, "base64url"),
    safeBufferFrom(trimmed, "base64"),
    /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.alloc(0),
    Buffer.from(trimmed, "utf8")
  ];
  return candidates.some((candidate) => candidate.length === 32);
}

function safeBufferFrom(value: string, encoding: BufferEncoding): Buffer {
  try {
    return Buffer.from(value, encoding);
  } catch {
    return Buffer.alloc(0);
  }
}

function evaluateSpec(spec: EnvVarSpec, env: EnvLike): EnvIssue | null {
  const names = [spec.name, ...(spec.anyOf ?? [])];
  const present = firstPresentValue(env, names);

  if (!present) {
    return { name: spec.name, group: spec.group, severity: spec.severity, reason: "missing", breaks: spec.breaks };
  }

  const reason = validateValue(spec, present.value);
  if (reason === null) return null;

  const detail =
    reason === "invalid" && spec.kind === "flag"
      ? `presente pero no es "true"`
      : reason === "placeholder"
        ? `${present.name} tiene un valor placeholder`
        : reason === "invalid"
          ? `${present.name} presente pero invalido (${spec.kind})`
          : undefined;

  return { name: spec.name, group: spec.group, severity: spec.severity, reason, breaks: spec.breaks, detail };
}

const REASON_TAG: Record<EnvIssueReason, string> = {
  missing: "FALTA",
  placeholder: "PLACEHOLDER",
  invalid: "INVALIDO"
};

/** Corre el catalogo completo contra un env y devuelve issues + reporte ASCII. */
export function checkEnvPreflight(
  env: EnvLike,
  catalog: readonly EnvVarSpec[] = ENV_PREFLIGHT_CATALOG
): EnvPreflightResult {
  const fatal: EnvIssue[] = [];
  const warnings: EnvIssue[] = [];

  for (const spec of catalog) {
    const issue = evaluateSpec(spec, env);
    if (!issue) continue;
    if (issue.severity === "fatal") fatal.push(issue);
    else warnings.push(issue);
  }

  const checkedCount = catalog.length;
  const okCount = checkedCount - fatal.length - warnings.length;
  const ok = fatal.length === 0;
  const report = formatPreflightReport({ ok, fatal, warnings, okCount, checkedCount, report: "" });

  return { ok, fatal, warnings, okCount, checkedCount, report };
}

/** Reporte ASCII (sin emojis) agrupado por feature. */
export function formatPreflightReport(result: Omit<EnvPreflightResult, "report">): string {
  const lines: string[] = [];
  lines.push("=== Delivrix gateway env pre-flight ===");
  lines.push(
    `${result.okCount}/${result.checkedCount} OK` +
      `  |  ${result.fatal.length} fatal  |  ${result.warnings.length} warning`
  );

  const renderIssue = (issue: EnvIssue): string => {
    const tag = REASON_TAG[issue.reason];
    const extra = issue.detail ? ` (${issue.detail})` : "";
    return `  [${tag}] ${issue.name}${extra} -> ${issue.breaks}`;
  };

  if (result.fatal.length > 0) {
    lines.push("");
    lines.push("FATAL (el gateway no debe arrancar sin esto):");
    for (const issue of result.fatal) lines.push(renderIssue(issue));
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("WARN (una feature no andara hasta resolver):");
    const byGroup = new Map<string, EnvIssue[]>();
    for (const issue of result.warnings) {
      const list = byGroup.get(issue.group) ?? [];
      list.push(issue);
      byGroup.set(issue.group, list);
    }
    for (const [group, issues] of byGroup) {
      lines.push(`  - ${group}:`);
      for (const issue of issues) lines.push(`  ${renderIssue(issue)}`);
    }
  }

  if (result.fatal.length === 0 && result.warnings.length === 0) {
    lines.push("");
    lines.push("Todo el entorno critico esta presente y valido.");
  }

  return lines.join("\n");
}
