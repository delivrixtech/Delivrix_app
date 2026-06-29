import { randomUUID } from "node:crypto";
import type {
  IonosDnsInventoryResult,
  IonosDomainItem,
  IonosDomainsInventoryResult
} from "../../../packages/adapters/src/index.ts";
import type { AuditEventInput } from "../../../packages/domain/src/index.ts";
import type { CanvasLiveEventService } from "./services/canvas-live-events.ts";
import type { ChatSendRequest, ChatSendResponse, OpenClawChatProxy } from "./openclaw-chat.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

interface InventoryAdapter<T> {
  listInventory(): Promise<T>;
}

export interface OpenClawDomainChatSkillDeps {
  body: ChatSendRequest;
  chatProxy: OpenClawChatProxy;
  canvasLiveEvents: CanvasLiveEventService;
  auditLog: AuditSink;
  ionosDomains: InventoryAdapter<IonosDomainsInventoryResult>;
  ionosDns: InventoryAdapter<IonosDnsInventoryResult>;
  now?: () => Date;
}

export async function maybeHandleOpenClawDomainChatSkill(
  deps: OpenClawDomainChatSkillDeps
): Promise<ChatSendResponse | null> {
  const message = extractMessage(deps.body);
  if (!message || !isDomainInventoryIntent(message)) {
    return null;
  }

  const now = deps.now ?? (() => new Date());
  const msgId = extractMsgId(deps.body) ?? randomUUID();
  const taskId = `domain-inventory-${msgId}`;
  const startedAt = now();

  await deps.auditLog.append({
    actorType: "operator",
    actorId: "admin-panel",
    action: "oc.chat.operator_message",
    targetType: "openclaw_chat_session",
    targetId: "agent:main:operator",
    riskLevel: "low",
    decision: "n/a",
    metadata: {
      msgId,
      sessionKey: "agent:main:operator",
      length: message.length,
      gatewaySkill: "delivrix.domain_inventory"
    }
  });

  await deps.canvasLiveEvents.emit({
    type: "oc.task.declare",
    taskId,
    title: "Inventario de dominios IONOS",
    status: "running",
    createdAt: startedAt.toISOString(),
    actorId: "openclaw/gateway-skill"
  });

  deps.chatProxy.broadcast({
    type: "ASSISTANT_TYPING",
    msgId,
    ts: now().toISOString()
  });

  const [domainsResult, dnsResult] = await Promise.all([
    deps.ionosDomains.listInventory(),
    deps.ionosDns.listInventory()
  ]);

  const summary = buildDomainInventoryAnswer(domainsResult, dnsResult, now());
  const artifactId = `domain-report-${msgId}`;

  await deps.canvasLiveEvents.emit({
    type: "oc.action.now",
    taskId,
    kind: "api",
    method: "GET",
    url: "/v1/infrastructure/inventory#ionos-domains",
    status: domainsResult.source.responseOk && dnsResult.source.responseOk ? 200 : 207,
    durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
    responseBytes: Buffer.byteLength(JSON.stringify({ domainsResult, dnsResult }), "utf8"),
    responseBody: {
      ionosDomains: {
        source: domainsResult.source.kind,
        responseOk: domainsResult.source.responseOk,
        count: domainsResult.domains.length,
        domains: domainsResult.domains.map((domain) => domain.name)
      },
      ionosDns: {
        source: dnsResult.source.kind,
        responseOk: dnsResult.source.responseOk,
        zoneCount: dnsResult.zones.length,
        zones: dnsResult.zones.map((zone) => ({
          name: zone.name,
          records: zone.records.length,
          aRecords: zone.records.filter((record) => record.type.toUpperCase() === "A").length,
          mxRecords: zone.records.filter((record) => record.type.toUpperCase() === "MX").length
        }))
      }
    },
    occurredAt: now().toISOString()
  });

  await deps.canvasLiveEvents.emit({
    type: "oc.artifact.declare",
    taskId,
    artifactId,
    kind: "report",
    title: "Reporte de dominios IONOS",
    editable: false,
    createdAt: now().toISOString()
  });

  for (const block of buildDomainInventoryReportBlocks(domainsResult, dnsResult, now())) {
    // Defensa en profundidad: el Canvas Live lanza "content is required." ante
    // content vacio. Nunca emitir un bloque sin texto.
    if (!block.content || block.content.trim().length === 0) {
      continue;
    }
    await deps.canvasLiveEvents.emit({
      type: "oc.artifact.block",
      artifactId,
      blockId: block.blockId,
      order: block.order,
      kind: block.kind,
      content: block.content,
      editable: false,
      status: "complete",
      occurredAt: now().toISOString()
    });
  }

  await deps.canvasLiveEvents.emit({
    type: "oc.task.update",
    taskId,
    status: "completed",
    updatedAt: now().toISOString()
  });

  deps.chatProxy.markCanvasMaterialized?.(msgId);
  await deps.chatProxy.handleAgentMessage({
    type: "ASSISTANT_DONE",
    msgId,
    content: summary,
    audit: {
      skillsInvoked: ["delivrix.domain_inventory"],
      durationMs: Math.max(0, now().getTime() - startedAt.getTime())
    }
  });

  return {
    msgId,
    queued: true,
    assistant: {
      content: summary,
      source: "delivrix.domain_inventory",
      skillsInvoked: ["delivrix.domain_inventory"],
      durationMs: Math.max(0, now().getTime() - startedAt.getTime())
    }
  };
}

export function isDomainInventoryIntent(message: string): boolean {
  const normalized = normalizeForIntent(message);
  if (isOperationalOpenClawPrompt(normalized)) {
    return false;
  }
  if (isDiagnosticIntent(normalized)) {
    return false;
  }

  const mentionsDomain =
    /\bdominios?\b/.test(normalized) ||
    /\bdomain(s)?\b/.test(normalized) ||
    /\bionos\b/.test(normalized) ||
    /\bdns\b/.test(normalized);
  if (!mentionsDomain) {
    return false;
  }

  return (
    /\b(enlista|enlistar|enlistame|enlistarme|enlistes|lista|listar|muestra|mostrar|dime|cuales|cu[aá]les|inventario|registrados|comprados|revisa|revisar|verifica|verificar)\b/.test(normalized) ||
    /\b(list|show|inventory|owned|registered)\b/.test(normalized)
  );
}

function isOperationalOpenClawPrompt(normalized: string): boolean {
  return (
    /\b(configure_complete_smtp|provision_smtp_postfix|create_webdock_server|bind_webdock_main_domain|bind_domain_to_server|upsert_dns_route53|wait_for_dns_propagation|configure_email_auth|seed_warmup_pool|send_real_email)\b/.test(normalized) ||
    /\b(serverslug|serverip|smtphost|budgetusdmax|testemailrecipient|testemailsubject|testemailbody|imageslug|locationid)\s*=/.test(normalized) ||
    /\b(retoma|retomar|continu[aá]|continuar|sigue|seguir|ejecuta|ejecutar|propon[eé]|approvalgate|firma|side effect|post-dns|provisionar|smtp provisioning)\b/.test(normalized) ||
    /\b(blacklist|blocklist|mxtoolbox|spamhaus|spamcop|reputaci[oó]n|quemad[oa]|listad[oa])\b/.test(normalized) ||
    // Lenguaje natural de configuracion/creacion SMTP -> debe ir al modelo (Bedrock),
    // NO al skill local de inventario. Sin esto, "configura este dominio... revisa..."
    // secuestraba el turno y crasheaba con "content is required." (IONOS 0 dominios).
    // Ante la duda preferimos Bedrock: el skill local de inventario es solo un atajo
    // para preguntas de inventario PURAS.
    /\bsmtp\b/.test(normalized) ||
    /\b(configura\w*|configuremos|crea\w*|creemos|crear|monta\w*|montemos|arma\w*|armemos|aprovecha\w*|setup|provisiona\w*)\b/.test(normalized) ||
    /\b(presupuesto|budget|correo de prueba|smoke|message[ -]?id|destinatario|warmup)\b/.test(normalized)
  );
}

// Intenciones de DIAGNÓSTICO deben ir al modelo (Bedrock), donde viven los tools
// read_dkim_status / read_smtp_reachability / read_run_state_integrity /
// read_delivery_reason. Sin esto, el atajo local de inventario IONOS las secuestra
// solo porque mencionan "dominio" + un verbo como "revisa" — y el tool de
// diagnóstico nunca se llega a invocar (auditado en vivo 2026-06-29).
function isDiagnosticIntent(normalized: string): boolean {
  return (
    /\bdkim\b/.test(normalized) ||
    /\bselector(es)?\b/.test(normalized) ||
    /\b(spf|dmarc)\b/.test(normalized) ||
    /\b(outbound|egress|reachability)\b/.test(normalized) ||
    /\b(puerto|port)\s*25\b/.test(normalized) ||
    /:25\b/.test(normalized) ||
    /\b(run[- ]?state|huerfan\w*|integridad)\b/.test(normalized) ||
    /\bsin\s+(un\s+)?run\b/.test(normalized) ||
    /\bruns?\b[\s\S]*\b(fallid\w*|failed|cancelad\w*|en estado)\b/.test(normalized) ||
    /\b(rebot\w*|bounce|deferred|deferid\w*|mail\.?log|message[- ]?id)\b/.test(normalized) ||
    /\bmotivo de (entrega|rebote)\b/.test(normalized) ||
    /\bread_(dkim_status|smtp_reachability|run_state_integrity|delivery_reason)\b/.test(normalized)
  );
}

export function buildDomainInventoryAnswer(
  domainsResult: IonosDomainsInventoryResult,
  dnsResult: IonosDnsInventoryResult,
  now: Date
): string {
  if (!domainsResult.source.responseOk) {
    return [
      "No puedo listar los dominios desde IONOS en este momento porque la API devolvio error.",
      "",
      `Error tecnico: ${domainsResult.source.errorMessage ?? "ionos_domains_unavailable"}`,
      "",
      "No voy a inventar una lista. Revisa la credencial IONOS Domains o el tenant y vuelvo a consultar."
    ].join("\n");
  }

  if (domainsResult.domains.length === 0) {
    return [
      "IONOS respondio correctamente, pero no devolvio dominios registrados para esta credencial.",
      "",
      `Fuente: ${domainsResult.source.kind} · fetchedAt ${domainsResult.source.fetchedAt}`
    ].join("\n");
  }

  const zonesByName = new Map(dnsResult.zones.map((zone) => [zone.name.toLowerCase(), zone]));
  const lines = domainsResult.domains
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((domain, index) => {
      const zone = zonesByName.get(domain.name.toLowerCase());
      const aRecords = zone?.records.filter((record) => record.type.toUpperCase() === "A") ?? [];
      const mxRecords = zone?.records.filter((record) => record.type.toUpperCase() === "MX") ?? [];
      const status = domainStatus(domain);
      const dnsBits = zone
        ? `DNS: ${aRecords.length} A, ${mxRecords.length} MX`
        : "DNS: sin zona visible en IONOS Cloud DNS";
      const renewal = domain.autoRenew === true
        ? "auto-renew on"
        : domain.autoRenew === false
          ? "auto-renew off"
          : "auto-renew desconocido";
      const expiry = domain.expiresAt ? `vence ${domain.expiresAt}` : "vencimiento no expuesto";
      return `${index + 1}. ${domain.name} — ${status}; ${dnsBits}; ${renewal}; ${expiry}`;
    });

  const completeDns = domainsResult.domains.filter((domain) => {
    const zone = zonesByName.get(domain.name.toLowerCase());
    if (!zone) return false;
    return zone.records.some((record) => record.type.toUpperCase() === "A") &&
      zone.records.some((record) => record.type.toUpperCase() === "MX");
  }).length;

  const partialDns = domainsResult.domains.length - completeDns;
  const sourceLine = [
    `Fuente IONOS Domains: ${domainsResult.source.kind}, ${domainsResult.domains.length} dominios`,
    `Fuente IONOS DNS: ${dnsResult.source.kind}, ${dnsResult.zones.length} zonas`,
    `consultado ${now.toISOString()}`
  ].join(" · ");

  return [
    `Si, puedo enlistarlos desde el gateway Delivrix. Encontré ${domainsResult.domains.length} dominios registrados en IONOS:`,
    "",
    ...lines,
    "",
    "Resumen operativo:",
    `- ${completeDns} dominios tienen al menos A + MX visibles en IONOS DNS.`,
    `- ${partialDns} dominios necesitan revision DNS o no tienen zona visible en esta credencial.`,
    "- No hice compras, no cambie DNS y no toque infraestructura.",
    "",
    sourceLine
  ].join("\n");
}

export function buildDomainInventoryReportBlocks(
  domainsResult: IonosDomainsInventoryResult,
  dnsResult: IonosDnsInventoryResult,
  now: Date
): Array<{
  blockId: string;
  order: number;
  kind: "paragraph" | "code";
  content: string;
}> {
  if (!domainsResult.source.responseOk) {
    return [
      {
        blockId: "domain-report-summary",
        order: 1,
        kind: "paragraph",
        content: `IONOS Domains devolvio error: ${domainsResult.source.errorMessage ?? "ionos_domains_unavailable"}. No se inventaron datos.`
      }
    ];
  }

  const zonesByName = new Map(dnsResult.zones.map((zone) => [zone.name.toLowerCase(), zone]));
  const rows = domainsResult.domains
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((domain) => {
      const zone = zonesByName.get(domain.name.toLowerCase());
      const aRecords = zone?.records.filter((record) => record.type.toUpperCase() === "A").length ?? 0;
      const mxRecords = zone?.records.filter((record) => record.type.toUpperCase() === "MX").length ?? 0;
      return `${domain.name} | ${domainStatus(domain)} | A:${aRecords} | MX:${mxRecords}`;
    });

  return [
    {
      blockId: "domain-report-summary",
      order: 1,
      kind: "paragraph",
      content: `${domainsResult.domains.length} dominios IONOS consultados en modo read-only. Fuente dominios: ${domainsResult.source.kind}. Fuente DNS: ${dnsResult.source.kind}. ${now.toISOString()}`
    },
    {
      blockId: "domain-report-list",
      order: 2,
      kind: rows.length > 0 ? "code" : "paragraph",
      // Nunca emitir content vacio: el Canvas Live rechaza content="" con
      // "content is required." Si IONOS no devuelve dominios (p.ej. estan en
      // Route53, no en IONOS), se informa en texto en vez de un bloque vacio.
      content: rows.length > 0
        ? rows.join("\n")
        : "IONOS respondio sin dominios para esta credencial. Es esperable si los dominios estan registrados en Route53 y no en IONOS."
    },
    {
      blockId: "domain-report-guardrails",
      order: 3,
      kind: "paragraph",
      content: "Guardrail: no se hicieron compras, cambios DNS ni writes de infraestructura. Cualquier accion futura requiere propuesta explicita y aprobacion humana."
    }
  ];
}

function extractMessage(body: ChatSendRequest): string {
  const raw =
    typeof body.message === "string"
      ? body.message
      : typeof body.text === "string"
        ? body.text
        : "";
  return raw.trim();
}

function extractMsgId(body: ChatSendRequest): string | null {
  return typeof body.msgId === "string" && /^[a-zA-Z0-9._:-]{3,120}$/.test(body.msgId)
    ? body.msgId
    : null;
}

function normalizeForIntent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function domainStatus(domain: IonosDomainItem): string {
  const status = domain.status ?? domain.statusGroup ?? domain.provisioningStatus ?? domain.type;
  if (!status) return "registrado";
  return String(status).toLowerCase().replace(/_/g, " ");
}
