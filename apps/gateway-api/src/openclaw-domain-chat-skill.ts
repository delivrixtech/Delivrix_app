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
      kind: "code",
      content: rows.join("\n")
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
