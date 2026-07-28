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
  smtpCredentials?: Array<{ domain?: unknown; status?: unknown }>;
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

  const usable: FleetDomain[] = [];
  for (const binding of bindings) {
    const domain = normalizeDomain(binding.domain);
    const serverSlug = nonEmptyString(binding.serverSlug);
    const serverIp = nonEmptyString(binding.serverIp);
    // Sin slug o sin ip, las tools de lectura no pueden ni construir su request.
    if (!domain || !serverSlug || !serverIp) continue;
    usable.push({
      domain,
      serverSlug,
      serverIp,
      hasCredential: credentialed.has(domain)
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

async function loadCredentialedDomains(workspace: OpenClawWorkspace): Promise<Set<string>> {
  const inventory = await workspace
    .readInventoryJson<SmtpCredentialsInventory>("smtp-credentials.json")
    .catch(() => null);
  const out = new Set<string>();
  for (const record of inventory?.smtpCredentials ?? []) {
    if (record.status !== "configured") continue;
    const domain = normalizeDomain(record.domain);
    if (domain) out.add(domain);
  }
  return out;
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
    "",
    "Objetivo: emitir un veredicto sobre por que este dominio entrega o no entrega, apoyado",
    "en el resultado de tus tools. Distingui explicitamente entre el nodo caido o incomunicado",
    "y el correo rechazado por el destino: son dos fallas distintas y se arreglan distinto.",
    "",
    "No envies correo, no arranques rampas y no modifiques nada: solo lees."
  ].join("\n");
}
