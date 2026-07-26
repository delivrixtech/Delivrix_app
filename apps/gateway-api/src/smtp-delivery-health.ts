// Salud de entrega por nodo, leída del propio mail.log — la señal que faltaba.
//
// El 2026-07-25 se midió con envíos reales que 38 de 64 nodos estaban bloqueados por
// Gmail con 550-5.7.1, mientras el chequeo de listas negras daba "0 blacklist" y el
// inventario decía `authComplete: true`. Las dos cosas eran ciertas y las dos eran
// ciegas: la reputación era interna de Google, no una lista pública.
//
// La evidencia estaba en cada máquina desde hacía semanas — `corp-delivery.com` tenía
// 3883 rechazos de Gmail acumulados en su mail.log — y nadie la leía. Este módulo la
// lee. Es PASIVO a propósito: no envía nada, no cuesta reputación, y se puede correr
// cuantas veces se quiera. Un probe que necesita enviar correo para medir salud no se
// corre seguido; uno que solo lee, sí.
//
// Corre por el mismo `SmtpSshRunner` que provisiona, así hereda usuario y sudo por
// provider (Contabo entra como root; Webdock como delivrixops + sudo).

/** Recuento de intentos hacia un proveedor de correo desde un nodo. */
export interface ProviderDeliveryStats {
  provider: string;
  delivered: number;
  blocked: number;
  deferred: number;
}

export interface NodeDeliveryStats {
  totals: { delivered: number; blocked: number; deferred: number };
  byProvider: ProviderDeliveryStats[];
}

export type DeliveryHealthStatus =
  | "healthy"
  | "degraded"
  | "blocked_by_provider"
  | "no_traffic"
  | "unreadable";

export interface DeliveryHealthVerdict {
  status: DeliveryHealthStatus;
  stats: NodeDeliveryStats;
  /** Proveedores donde el nodo está efectivamente cerrado. */
  blockedProviders: string[];
  /** Proveedores con rechazo parcial relevante. */
  degradedProviders: string[];
  detail: string;
}

export interface DeliveryHealthSshRunner {
  run(input: {
    serverSlug?: string | null;
    serverIp: string;
    command: string;
    timeoutMs?: number;
  }): Promise<{ stdout: string; exitCode: number | null }>;
}

/** Un proveedor cuenta como bloqueado si rechazó al menos esto y casi todo lo intentado. */
export const BLOCKED_MIN_ATTEMPTS = 20;
export const BLOCKED_MIN_RATIO = 0.9;
export const DEGRADED_MIN_RATIO = 0.25;

/**
 * Comando de lectura. Sale SIEMPRE 0 y marca el fin de la salida: un exit distinto de
 * cero lo convierte el runner en excepción, y ahí "no pude leer" se disfrazaría de
 * "no hay problemas". Misma regla que el probe de propiedad.
 */
export function buildDeliveryStatsCommand(): string {
  return [
    "set -u",
    "echo '## DELIVERED'",
    'zcat -f /var/log/mail.log* 2>/dev/null | grep "status=sent" | grep -oE "to=<[^>]*@[^>]*>" | sed -E "s/.*@([^>]*)>/\\1/" | tr "A-Z" "a-z" | sort | uniq -c | sort -rn || true',
    "echo '## BLOCKED'",
    'zcat -f /var/log/mail.log* 2>/dev/null | grep "status=bounced" | grep -oE "to=<[^>]*@[^>]*>" | sed -E "s/.*@([^>]*)>/\\1/" | tr "A-Z" "a-z" | sort | uniq -c | sort -rn || true',
    "echo '## DEFERRED'",
    'zcat -f /var/log/mail.log* 2>/dev/null | grep "status=deferred" | grep -oE "to=<[^>]*@[^>]*>" | sed -E "s/.*@([^>]*)>/\\1/" | tr "A-Z" "a-z" | sort | uniq -c | sort -rn || true',
    "echo '## END'"
  ].join("\n");
}

function section(text: string, name: string): string {
  const start = text.indexOf(`## ${name}`);
  if (start === -1) return "";
  const rest = text.slice(start + `## ${name}`.length);
  const next = rest.indexOf("## ");
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function counts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const provider = m[2]!.toLowerCase().replace(/\.$/, "");
    out.set(provider, (out.get(provider) ?? 0) + Number(m[1]));
  }
  return out;
}

export function parseDeliveryStats(stdout: string): NodeDeliveryStats | null {
  if (!stdout.includes("## END")) return null; // salida truncada: no inventamos
  const delivered = counts(section(stdout, "DELIVERED"));
  const blocked = counts(section(stdout, "BLOCKED"));
  const deferred = counts(section(stdout, "DEFERRED"));

  const providers = new Set([...delivered.keys(), ...blocked.keys(), ...deferred.keys()]);
  const byProvider = [...providers]
    .map((provider) => ({
      provider,
      delivered: delivered.get(provider) ?? 0,
      blocked: blocked.get(provider) ?? 0,
      deferred: deferred.get(provider) ?? 0
    }))
    .sort((a, b) => (b.delivered + b.blocked) - (a.delivered + a.blocked));

  const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    totals: { delivered: sum(delivered), blocked: sum(blocked), deferred: sum(deferred) },
    byProvider
  };
}

/**
 * `selfDomain` se excluye del veredicto: los rebotes a la propia máquina (avisos a
 * postmaster, notificaciones de no-entrega que Postfix se manda a sí mismo) no son un
 * bloqueo de proveedor. Sin esta exclusión, los nodos MÁS sanos aparecían "cerrados"
 * en su propio dominio — un falso positivo que habría enterrado la señal en ruido.
 */
export function assessDeliveryHealth(stats: NodeDeliveryStats, selfDomain?: string): DeliveryHealthVerdict {
  const blockedProviders: string[] = [];
  const degradedProviders: string[] = [];
  const self = selfDomain?.trim().toLowerCase().replace(/\.$/, "");

  for (const p of stats.byProvider) {
    if (self && (p.provider === self || p.provider.endsWith(`.${self}`))) continue;
    const attempts = p.delivered + p.blocked;
    if (attempts < BLOCKED_MIN_ATTEMPTS) continue;
    const ratio = p.blocked / attempts;
    if (ratio >= BLOCKED_MIN_RATIO) blockedProviders.push(p.provider);
    else if (ratio >= DEGRADED_MIN_RATIO) degradedProviders.push(p.provider);
  }

  if (stats.totals.delivered + stats.totals.blocked === 0) {
    return { status: "no_traffic", stats, blockedProviders, degradedProviders, detail: "el nodo no registra trafico saliente" };
  }
  if (blockedProviders.length > 0) {
    const worst = stats.byProvider.find((p) => p.provider === blockedProviders[0])!;
    return {
      status: "blocked_by_provider",
      stats,
      blockedProviders,
      degradedProviders,
      detail: `cerrado en ${blockedProviders.join(", ")} (${worst.provider}: ${worst.blocked} rechazos sobre ${worst.delivered + worst.blocked} intentos)`
    };
  }
  if (degradedProviders.length > 0) {
    return { status: "degraded", stats, blockedProviders, degradedProviders, detail: `rechazo parcial en ${degradedProviders.join(", ")}` };
  }
  return { status: "healthy", stats, blockedProviders, degradedProviders, detail: `${stats.totals.delivered} entregados, ${stats.totals.blocked} rechazados` };
}

const EMPTY_STATS: NodeDeliveryStats = { totals: { delivered: 0, blocked: 0, deferred: 0 }, byProvider: [] };

/**
 * Lee la salud de entrega de un nodo. Best-effort: nunca tira. Si no se pudo leer, el
 * estado es `unreadable` — jamás `healthy`, que sería el falso negativo peligroso.
 */
export async function readNodeDeliveryHealth(input: {
  sshRunner: DeliveryHealthSshRunner;
  serverSlug: string;
  serverIp: string;
  /** Dominio del propio nodo: sus rebotes internos no cuentan como bloqueo. */
  selfDomain?: string;
  timeoutMs?: number;
}): Promise<DeliveryHealthVerdict> {
  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: buildDeliveryStatsCommand(),
      timeoutMs: input.timeoutMs ?? 60_000
    });
    const stats = parseDeliveryStats(result.stdout);
    if (!stats) {
      return { status: "unreadable", stats: EMPTY_STATS, blockedProviders: [], degradedProviders: [], detail: "salida incompleta (falta ## END)" };
    }
    return assessDeliveryHealth(stats, input.selfDomain);
  } catch (error) {
    return {
      status: "unreadable",
      stats: EMPTY_STATS,
      blockedProviders: [],
      degradedProviders: [],
      detail: `lectura fallida: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
