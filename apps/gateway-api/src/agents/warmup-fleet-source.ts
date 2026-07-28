// Fuente de dominios del abanico.
//
// Hoy no existia ninguna: el daemon LIVE tiene 6 boxes hardcodeados
// (`warmup-engine/src/service/live-warmup-daemon.ts:37-44`) y el resto del sistema descubre
// dominios por otros caminos. El abanico necesita la lista real, con `serverSlug` y `serverIp`
// explicitos: `read_smtp_reachability` y `read_delivery_reason` los exigen en su schema, y un
// agente sin ellos no puede ejecutar ni su primera tool.
//
// Lee del MISMO inventario que usa la rampa (`domains.json` → `bindings[]`,
// `warmup-ramp.ts:979`). No inventa una segunda fuente de verdad.

import type { OpenClawWorkspace } from "../openclaw-workspace.ts";

export interface FleetDomain {
  domain: string;
  serverSlug: string;
  serverIp: string;
  /** true si el dominio tiene una credencial SMTP `configured` en el inventario. */
  hasCredential: boolean;
  /**
   * El `serverSlug` de `domains.json` NO coincide con el de la credencial SMTP.
   *
   * Medido: 5 de 59 dominios estan asi — `domains.json` quedo stale. Importa mucho mas de lo
   * que parece: el serverSlug y el serverIp alimentan LAS 5 tools, no solo una. Sondear el nodo
   * equivocado devuelve un resultado correcto DE OTRA MAQUINA y se lo atribuye a este dominio.
   * Un veredicto confiado y falso es peor que un not-found.
   *
   * Cuando hay conflicto no se adivina: se marca, se omite el messageId, y el prompt le pide al
   * agente cerrar en `indeterminado` declarando el conflicto.
   */
  bindingConflict?: { fromBindings: string; fromCredentials: string };
  /**
   * Message-id de un envio real reciente de este dominio, si lo hay.
   *
   * `read_delivery_reason` resuelve el queue-id DESDE el message-id: sin uno concreto, la tool
   * mas valiosa del diagnostico es inllamable. Se saca del audit log, que es el unico lugar
   * donde queda registrado (`oc.smtp.real_email_sent`).
   */
  recentMessageId?: string;
}

/** Fuente de message-ids: lo minimo que el abanico necesita del audit log. */
export interface AuditEventReader {
  list(): Promise<Array<{ action?: string; metadata?: Record<string, unknown> }>>;
}

export interface LoadFleetInput {
  workspace: OpenClawWorkspace;
  /** Si se pasa, filtra a estos dominios (normalizados). Vacio o ausente = toda la flota. */
  onlyDomains?: readonly string[];
  /**
   * Exigir credencial SMTP. Por defecto NO: el diagnostico es de lectura y un dominio sin
   * credencial es justamente uno de los casos que interesa diagnosticar.
   */
  requireCredential?: boolean;
  /**
   * Audit log del que sacar un message-id reciente por dominio. Opcional: sin el, los agentes
   * corren con 4 tools utiles en vez de 5.
   *
   * Se lee UNA vez por abanico, no una por agente: el archivo pesa megabytes y releerlo 59
   * veces es el cuello de botella que ya identificamos en el bus de eventos.
   */
  auditLog?: AuditEventReader;
}

export interface FleetSelection {
  domains: FleetDomain[];
  /** Dominios pedidos por `onlyDomains` que no estan en el inventario. */
  notFound: string[];
  /** Total de bindings leidos, antes de filtrar. Sirve para detectar un inventario vacio. */
  totalInInventory: number;
}

interface DomainsInventory {
  bindings?: Array<{
    domain?: unknown;
    serverSlug?: unknown;
    serverIp?: unknown;
    status?: unknown;
  }>;
}

interface SmtpCredentialsInventory {
  smtpCredentials?: Array<{ domain?: unknown; status?: unknown; serverSlug?: unknown }>;
}

/**
 * Carga la flota a diagnosticar.
 *
 * Descarta en silencio los bindings sin `serverSlug` o sin `serverIp` — no porque no importen,
 * sino porque un agente no puede hacer nada con ellos: sus tools no arrancan. Se reportan en
 * `notFound` solo si el operador los pidio explicitamente; si no, `totalInInventory` vs
 * `domains.length` deja ver el descarte sin que haya que confiar en un log.
 */
export async function loadWarmupFleet(input: LoadFleetInput): Promise<FleetSelection> {
  const inventory = await input.workspace
    .readInventoryJson<DomainsInventory>("domains.json")
    .catch(() => null);
  const bindings = inventory?.bindings ?? [];

  const credentialed = await loadCredentialedDomains(input.workspace);
  const messageIds = input.auditLog
    ? await loadRecentMessageIds(input.auditLog)
    : new Map<string, string>();

  const usable: FleetDomain[] = [];
  for (const binding of bindings) {
    const domain = normalizeDomain(binding.domain);
    const serverSlug = nonEmptyString(binding.serverSlug);
    const serverIp = nonEmptyString(binding.serverIp);
    // Sin slug o sin ip, las tools de lectura no pueden ni construir su request.
    if (!domain || !serverSlug || !serverIp) continue;
    const credential = credentialed.get(domain);
    // `domains.json` puede estar stale: si la credencial dice otro nodo, no adivinamos cual
    // de los dos es el bueno — se marca el conflicto y el agente cierra en indeterminado.
    const bindingConflict =
      credential?.serverSlug && credential.serverSlug !== serverSlug
        ? { fromBindings: serverSlug, fromCredentials: credential.serverSlug }
        : undefined;
    // Sin saber que nodo es, el messageId tampoco es atribuible: se omite a proposito.
    const recentMessageId = bindingConflict ? undefined : messageIds.get(domain);
    usable.push({
      domain,
      serverSlug,
      serverIp,
      hasCredential: credential !== undefined,
      ...(bindingConflict === undefined ? {} : { bindingConflict }),
      ...(recentMessageId === undefined ? {} : { recentMessageId })
    });
  }

  const requested = (input.onlyDomains ?? [])
    .map((entry) => normalizeDomain(entry))
    .filter((entry): entry is string => entry !== null);

  let domains = usable;
  const notFound: string[] = [];
  if (requested.length > 0) {
    const byDomain = new Map(usable.map((entry) => [entry.domain, entry]));
    domains = [];
    for (const wanted of requested) {
      const found = byDomain.get(wanted);
      if (found) domains.push(found);
      else notFound.push(wanted);
    }
  }

  if (input.requireCredential) {
    domains = domains.filter((entry) => entry.hasCredential);
  }

  return { domains, notFound, totalInInventory: bindings.length };
}

async function loadCredentialedDomains(
  workspace: OpenClawWorkspace
): Promise<Map<string, { serverSlug: string | null }>> {
  const inventory = await workspace
    .readInventoryJson<SmtpCredentialsInventory>("smtp-credentials.json")
    .catch(() => null);
  const out = new Map<string, { serverSlug: string | null }>();
  for (const record of inventory?.smtpCredentials ?? []) {
    if (record.status !== "configured") continue;
    const domain = normalizeDomain(record.domain);
    // El serverSlug de la credencial es la segunda fuente: es lo que permite detectar que
    // `domains.json` quedo desactualizado en vez de confiar en el a ciegas.
    if (domain) out.set(domain, { serverSlug: nonEmptyString(record.serverSlug) });
  }
  return out;
}

/**
 * Message-id mas reciente por dominio, desde los `oc.smtp.real_email_sent` del audit log.
 *
 * El dominio se saca del propio message-id (`<delivrix-xxxx@dominio.com>`), que es la unica
 * forma de asociarlos: el evento no lleva el dominio en un campo aparte.
 */
export async function loadRecentMessageIds(auditLog: AuditEventReader): Promise<Map<string, string>> {
  const events = await auditLog.list().catch(() => []);
  const byDomain = new Map<string, string>();
  for (const event of events) {
    if (event.action !== "oc.smtp.real_email_sent") continue;
    const messageId = event.metadata?.messageId;
    if (typeof messageId !== "string" || !messageId.includes("@")) continue;
    const domain = normalizeDomain(messageId.slice(messageId.lastIndexOf("@") + 1).replace(/>$/, ""));
    // El audit log esta en orden cronologico: el ultimo que se ve gana.
    if (domain) byDomain.set(domain, messageId);
  }
  return byDomain;
}

/** Mismo criterio que el resto del gateway: minusculas y sin punto final. */
function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  return normalized.length > 0 ? normalized : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Instrucciones del agente para UN dominio.
 *
 * El `serverSlug` y el `serverIp` van en el texto a proposito: el modelo los necesita para
 * construir los params de sus tools, y ponerlos en el prompt es mas barato y mas confiable que
 * hacerle adivinar una tool de descubrimiento.
 */
export function buildDiagnosticInstructions(target: FleetDomain): string {
  return [
    `Diagnostica la entregabilidad del dominio ${target.domain}.`,
    "",
    "Datos del nodo (usalos tal cual en los parametros de tus tools):",
    `  domain: ${target.domain}`,
    `  serverSlug: ${target.serverSlug}`,
    `  serverIp: ${target.serverIp}`,
    `  credencial SMTP en inventario: ${target.hasCredential ? "si, configured" : "NO"}`,
    target.recentMessageId
      ? `  messageId de un envio reciente: ${target.recentMessageId}`
      : "  messageId de un envio reciente: NO HAY",
    "",
    "Objetivo: emitir un veredicto sobre por que este dominio entrega o no entrega, apoyado",
    "en el resultado de tus tools. Distingui explicitamente entre el nodo caido o incomunicado",
    "y el correo rechazado por el destino: son dos fallas distintas y se arreglan distinto.",
    "",
    ...(target.bindingConflict
      ? [
          "ATENCION — EL INVENTARIO SE CONTRADICE SOBRE QUE NODO SIRVE A ESTE DOMINIO:",
          `  domains.json dice:      ${target.bindingConflict.fromBindings}`,
          `  la credencial SMTP dice: ${target.bindingConflict.fromCredentials}`,
          "",
          "No sabemos cual es el correcto, asi que NO podes atribuirle a este dominio lo que",
          "midas en ninguno de los dos: un resultado correcto de la maquina equivocada es peor",
          "que no tener dato. Cerra en 'indeterminado' declarando el conflicto de inventario",
          "como causa, y recomenda reconciliarlo antes de volver a diagnosticar.",
          ""
        ]
      : []),
    target.recentMessageId
      ? "Usa el messageId de arriba con read_delivery_reason: es el motivo REAL del ultimo envio."
      : [
          "Sin messageId no podes usar read_delivery_reason: esa tool resuelve el queue-id",
          "desde el message-id. Diagnostica con las otras cuatro y deci en el veredicto que",
          "no hay evidencia de entrega reciente para este dominio."
        ].join("\n"),
    "",
    "No envies correo, no arranques rampas y no modifiques nada: solo lees."
  ].join("\n");
}
