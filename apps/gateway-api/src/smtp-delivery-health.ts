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

/**
 * La ventana que cubren los numeros de arriba.
 *
 * El comando lee `/var/log/mail.log*` — CON asterisco, o sea todo el log rotado, incluidos los
 * .gz. Los totales son la acumulacion de semanas, no de hoy. Sin declarar esto, un nodo que se
 * bloqueo hace seis dias y ya se arreglo sigue leyendose `blocked_by_provider` para siempre, y
 * uno que se bloqueo HOY tras una semana sana se lee `healthy` porque el ratio queda diluido.
 *
 * Rotular estos numeros como "hoy" seria fabricar un mock el dia uno de la pantalla nueva.
 */
export const DELIVERY_STATS_WINDOW = "log completo retenido (no es de hoy)" as const;

export type DeliveryHealthStatus =
  | "healthy"
  | "degraded"
  | "blocked_by_provider"
  /**
   * El correo sale pero no llega: casi todo queda diferido.
   *
   * Faltaba, y su ausencia era el peor agujero del modulo. `attempts` era delivered+blocked, o
   * sea que `deferred` NO existia para el veredicto: un nodo con 920 mensajes atascados y cero
   * entregas caia en `no_traffic` — "el nodo no registra trafico saliente" — que es exactamente
   * lo contrario de lo que pasa. Medido en la flota el 2026-07-30: 2.193 diferidos contra 1.504
   * entregados en un solo dia hacia Gmail.
   */
  | "stalled"
  | "no_traffic"
  | "unreadable";

export interface DeliveryHealthVerdict {
  status: DeliveryHealthStatus;
  /** Que periodo cubren los numeros. Nunca es "hoy". */
  window: typeof DELIVERY_STATS_WINDOW;
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
/** Arriba de esto, el correo no esta saliendo: la cola se acumula. */
export const STALLED_MIN_DEFERRED_RATIO = 0.5;
export const STALLED_MIN_ATTEMPTS = 20;

/**
 * Comando de lectura. Sale SIEMPRE 0 y marca el fin de la salida: un exit distinto de
 * cero lo convierte el runner en excepción, y ahí "no pude leer" se disfrazaría de
 * "no hay problemas". Misma regla que el probe de propiedad.
 */
export function buildDeliveryStatsCommand(): string {
  return [
    "set -u",
    // El lector del log, resuelto en el nodo.
    //
    // /var/log/mail.log es `-rw-r----- syslog:adm`: el usuario ops NO lo lee sin sudo, y el
    // runner usa root en Contabo pero delivrixops en Webdock. Sin esto el comando salia con
    // exit 0 y CERO lineas, que el parser leia como "no hay trafico" — en un nodo que manda
    // 1.300 mensajes/dia. Es el mismo modo de falla que ya aparecio tres veces esta semana:
    // el sensor no fallaba, miraba donde no habia nada.
    //
    // Si no se puede leer de ninguna forma, se dice: ## NOACCESS. Nunca vacio.
    'if sudo -n test -r /var/log/mail.log 2>/dev/null; then READ="sudo -n zcat -f";' +
      ' elif test -r /var/log/mail.log; then READ="zcat -f";' +
      ' else echo "## NOACCESS"; READ=""; fi',
    "echo '## DELIVERED'",
    '[ -n "$READ" ] && $READ /var/log/mail.log* 2>/dev/null | grep "status=sent" | grep -oE "to=<[^>]*@[^>]*>" | sed -E "s/.*@([^>]*)>/\\1/" | tr "A-Z" "a-z" | sort | uniq -c | sort -rn || true',
    "echo '## BLOCKED'",
    '[ -n "$READ" ] && $READ /var/log/mail.log* 2>/dev/null | grep "status=bounced" | grep -oE "to=<[^>]*@[^>]*>" | sed -E "s/.*@([^>]*)>/\\1/" | tr "A-Z" "a-z" | sort | uniq -c | sort -rn || true',
    "echo '## DEFERRED'",
    '[ -n "$READ" ] && $READ /var/log/mail.log* 2>/dev/null | grep "status=deferred" | grep -oE "to=<[^>]*@[^>]*>" | sed -E "s/.*@([^>]*)>/\\1/" | tr "A-Z" "a-z" | sort | uniq -c | sort -rn || true',
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

/** NOACCESS = no se pudo leer el log. Distinto de "no hubo trafico". */
export function deliveryStatsUnreadable(stdout: string): boolean {
  return stdout.includes("## NOACCESS");
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

  // El diferido cuenta. Sin esto, un nodo que no entrega NADA porque todo se difiere se leia
  // como "sin trafico" (si no hubo entregas) o como "sano" (si alguna paso), y en los dos casos
  // el operador no se enteraba de que la cola crecia.
  const totalAttempts = stats.totals.delivered + stats.totals.blocked + stats.totals.deferred;
  const deferredRatio = totalAttempts > 0 ? stats.totals.deferred / totalAttempts : 0;

  if (totalAttempts === 0) {
    return {
      status: "no_traffic",
      window: DELIVERY_STATS_WINDOW,
      stats,
      blockedProviders,
      degradedProviders,
      detail: "el log no registra ni entregas ni rechazos ni diferidos en la ventana leida"
    };
  }
  if (
    stats.totals.deferred >= STALLED_MIN_ATTEMPTS &&
    deferredRatio >= STALLED_MIN_DEFERRED_RATIO
  ) {
    return {
      status: "stalled",
      window: DELIVERY_STATS_WINDOW,
      stats,
      blockedProviders,
      degradedProviders,
      detail:
        `${stats.totals.deferred} diferidos de ${totalAttempts} (${Math.round(deferredRatio * 100)}%): ` +
        "el correo sale del nodo pero no llega; la cola se acumula"
    };
  }
  if (blockedProviders.length > 0) {
    const worst = stats.byProvider.find((p) => p.provider === blockedProviders[0])!;
    return {
      status: "blocked_by_provider",
      window: DELIVERY_STATS_WINDOW,
      stats,
      blockedProviders,
      degradedProviders,
      detail: `cerrado en ${blockedProviders.join(", ")} (${worst.provider}: ${worst.blocked} rechazos sobre ${worst.delivered + worst.blocked} intentos)`
    };
  }
  if (degradedProviders.length > 0) {
    return { status: "degraded", window: DELIVERY_STATS_WINDOW, stats, blockedProviders, degradedProviders, detail: `rechazo parcial en ${degradedProviders.join(", ")}` };
  }
  return { status: "healthy", window: DELIVERY_STATS_WINDOW, stats, blockedProviders, degradedProviders, detail: `${stats.totals.delivered} entregados, ${stats.totals.blocked} rechazados` };
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
    if (deliveryStatsUnreadable(result.stdout)) {
      return {
        status: "unreadable",
        window: DELIVERY_STATS_WINDOW,
        stats: EMPTY_STATS,
        blockedProviders: [],
        degradedProviders: [],
        detail: "sin permiso para leer /var/log/mail.log (es syslog:adm; el usuario ops necesita sudo)"
      };
    }
    const stats = parseDeliveryStats(result.stdout);
    if (!stats) {
      return { status: "unreadable", window: DELIVERY_STATS_WINDOW, stats: EMPTY_STATS, blockedProviders: [], degradedProviders: [], detail: "salida incompleta (falta ## END)" };
    }
    return assessDeliveryHealth(stats, input.selfDomain);
  } catch (error) {
    return {
      status: "unreadable",
      window: DELIVERY_STATS_WINDOW,
      stats: EMPTY_STATS,
      blockedProviders: [],
      degradedProviders: [],
      detail: `lectura fallida: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
