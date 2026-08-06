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
 * Cuántos días de log mira el sensor.
 *
 * Antes leía `/var/log/mail.log*` — con asterisco, o sea TODO lo rotado, semanas enteras. Como los
 * contadores solo suman, un nodo que se destrabó hace días quedaba condenado a `stalled` para
 * siempre: medido el 2026-08-06, 29 de 58 nodos atascados y el pool del warmup en 6 de 58. El
 * sensor no medía "¿está atascado HOY?", medía "¿alguna vez lo estuvo?".
 *
 * Por qué 5 y no un número lindo: es el `maximal_queue_lifetime` real de 47 de los 58 nodos (los
 * otros 11 corren 2d y ahí sobran 3 días). Es la ventana más chica que contiene un ciclo de
 * reintento completo de Postfix — más corta y un diferido legítimo se leería como si el mensaje
 * hubiera desaparecido — y la más grande que no arrastra ninguno ya vencido.
 *
 * El tope de 28 no es capricho: la retención medida del log está entre 12 y 26 días, así que pedir
 * 90 devolvería exactamente lo mismo que pedir 26 con un rótulo que vuelve a mentir. Y el mínimo de
 * 1 porque una ventana de 0 días no mide nada y se leería como "no hay tráfico".
 *
 * Es LA perilla de calibración: se mueve por entorno, sin desplegar código, el día que la física de
 * la flota cambie (más nodos con queue lifetime de 2d, o rotación diaria en vez de semanal).
 */
export function resolverDiasDeVentana(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 28 ? n : 5;
}
export const DELIVERY_STATS_WINDOW_DAYS = resolverDiasDeVentana(process.env.DELIVERY_STATS_WINDOW_DAYS);

/**
 * La ventana que cubren los numeros, en texto, tal como la lee el operador y el agente.
 *
 * Este string NO se queda acá: viaja al campo `ventana` de sender-measurement.json, a
 * `GET /v1/sender-measurement` y a la tool `read_sender_measurement` del modelo. Un rótulo que
 * promete más de lo que el número contiene es un mock servido como medición, y el que estaba antes
 * prometía el log entero retenido. Ahora dice los días reales.
 *
 * Dice "por fecha de la línea" porque es literal, y ese rótulo costó un defecto: cuando la ventana
 * se acotaba por MTIME del archivo, decía "por archivo, el log corriente arrastra hasta un ciclo de
 * rotación más" — y el que arrastraba la semana entera era el ROTADO, no el corriente. El rótulo
 * describía mal el mismo número que promete describir.
 */
export function ventanaDeclarada(dias: number): string {
  return `últimos ${dias} días de mail.log (por fecha de la línea)`;
}
export const DELIVERY_STATS_WINDOW = ventanaDeclarada(DELIVERY_STATS_WINDOW_DAYS);

const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Los prefijos de fecha que SÍ entran en la ventana, uno por día y por formato.
 *
 * Por qué existe: acotar por `find -mtime` elige ARCHIVOS, no días. Un rotado que se toca hoy trae
 * adentro la semana entera que acumuló, así que la ventana real era N días MÁS un ciclo de rotación,
 * y oscilaba con el día de la semana. Medido contra el fixture: el MISMO nodo, con 100 rechazos de
 * Gmail y CERO entregas recientes, se leía `healthy` con el rotado a 1 y a 4 días, y
 * `blocked_by_provider` con el rotado a 6 — sin que nadie tocara nada, solo por el mtime. O sea que
 * un nodo genuinamente roto entraba al pool 5 de cada 7 días.
 *
 * Se compara por PREFIJO literal y no con un parser de fechas en awk a propósito: los dos formatos
 * de la flota (syslog `Aug  6` y el ISO-8601 de los 12 Webdock) se resuelven con la misma lista, y
 * el año fantasma del syslog —que no lleva año— lo sigue cerrando el `find -mtime`, que ni ABRE un
 * rotado viejo. Los dos filtros juntos: el archivo acota el año, la línea acota el día.
 *
 * Arranca en MAÑANA (i = -1) por el huso: la lista se genera en UTC acá, y el nodo escribe con su
 * reloj — Contabo en Alemania va hasta 2h adelante. Sin ese día de más, las líneas más nuevas del
 * nodo con más tráfico serían justo las que se descartan.
 */
export function prefijosDeDias(dias: number, ahora: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = -1; i < dias; i++) {
    const d = new Date(ahora.getTime() - i * 86_400_000);
    const mes = MESES[d.getUTCMonth()]!;
    const dd = d.getUTCDate();
    // Las dos variantes del día en syslog: `Aug  6` (padding con espacio, lo que emite rsyslog) y
    // `Aug 06`. Del 10 en adelante son iguales y el Set las une.
    out.push(`${mes} ${String(dd).padStart(2, " ")}`, `${mes} ${String(dd).padStart(2, "0")}`, d.toISOString().slice(0, 10));
  }
  return [...new Set(out)];
}

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
  /** Qué periodo cubren los numeros, en los días que se leyeron de verdad. */
  window: string;
  stats: NodeDeliveryStats;
  /**
   * Mensajes en la cola de Postfix AHORA, no en la ventana. `null` = no se pudo leer, que NO es
   * cero: un cero inventado sobre un nodo con 15.693 mensajes trabados lo manda derecho al pool.
   */
  encolados: number | null;
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
 * Encolados AHORA a partir de los cuales el nodo está atascado, gane lo que gane el log.
 *
 * Calibrado sobre la foto de la flota del 2026-08-06: 9 nodos tenían entre 7.306 y 15.693 mensajes
 * en cola y 20 tenían 5 o menos. No hay UN solo nodo entre 50 y 300, así que el umbral no es
 * delicado — cae en un hueco enorme de la distribución. Igual es una perilla: si la distribución
 * cambia (nodos chicos con colas de cientos por diseño) hay que volver a mirarla.
 */
export const COLA_ATASCADA_MIN = 500;

/**
 * Comando de lectura. Sale SIEMPRE 0 y marca el fin de la salida: un exit distinto de
 * cero lo convierte el runner en excepción, y ahí "no pude leer" se disfrazaría de
 * "no hay problemas". Misma regla que el probe de propiedad.
 *
 * `logDir` existe SOLO para que el test pueda correr este mismo comando de verdad contra un
 * directorio de fixtures: en producción nadie lo pasa. Es la lección del fixture de Bedrock — un
 * test escrito sobre mi suposición de cómo se ve la salida comparte el error con el código y no
 * salva de nada; este corre por el camino de producción.
 */
export function buildDeliveryStatsCommand(
  dias = DELIVERY_STATS_WINDOW_DAYS,
  logDir = "/var/log",
  ahora = new Date()
): string {
  // El corte por DÍA, aplicado a la línea. Va primero en el pipe porque es el que más descarta.
  const enVentana = `grep -E "^(${prefijosDeDias(dias, ahora).join("|")})"`;
  // Un mensaje cuenta UNA vez, no una por reintento.
  //
  // Contar líneas era el 16x de inflación que condenaba nodos sanos: Postfix escribe una línea
  // `status=deferred` por CADA reintento del MISMO queue-id, así que un puñado de mensajes trabados
  // producía cientos de "intentos" y el ratio de diferidos se iba arriba del 50% solo. Y se dedupean
  // los TRES estados, no solo el diferido: deduplicar únicamente el numerador dejaría el ratio
  // comparando mensajes contra intentos y aflojaría el clasificador al revés.
  //
  // El queue-id se saca con `[^ :]+` y NO con el `[0-9A-Fa-f]{6,}` del módulo de volumen: medido
  // contra el fixture, el patrón hex pierde `4bXyZ9Qm2Rz1kT`, que es la forma que tienen los nodos
  // con `enable_long_queue_ids` (base-52). Copiar el hex habría dejado el sensor en cero justo ahí.
  const pipeline = (status: string): string =>
    `[ -n "$READ" ] && $READ $LOGS 2>/dev/null | ${enVentana} | grep "status=${status}"` +
    " | grep -oE '\\]: [^ :]+: to=<[^>]*@[^>]*>'" +
    // OJO: el separador del sed es un TABULADOR REAL (el `\t` de este literal de JS emite el
    // carácter). El sed de BSD — el de esta Mac, donde corre el test de integración — no interpreta
    // `\t` en el reemplazo y devolvería una `t` literal; el de GNU sí. Un tab real anda en los dos.
    ` | sed -E 's/^\\]: ([^ :]+): to=<[^>]*@([^>]*)>/\\1\t\\2/'` +
    " | sort -u | awk -F'\\t' '{print tolower($2)}' | sort | uniq -c | sort -rn || true";

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
    `if sudo -n test -r ${logDir}/mail.log 2>/dev/null; then READ="sudo -n zcat -f";` +
      ` elif test -r ${logDir}/mail.log; then READ="zcat -f";` +
      ' else echo "## NOACCESS"; READ=""; fi',
    // El `find -mtime` elige QUÉ ARCHIVOS abrir, y nada más. Acotar la ventana con él era el
    // defecto: un rotado semanal que se toca hoy trae adentro los siete días que acumuló, así que
    // la ventana era N días más un ciclo de rotación y cambiaba con el día de la semana. Lo que
    // acota los DÍAS ahora es `enVentana`, sobre la fecha de cada línea.
    //
    // Lo que sí sigue haciendo, y por eso no se saca: cierra el año fantasma. El syslog no escribe
    // el año, así que un `Aug  6` de hace doce meses matchearía el prefijo de hoy — pero ese
    // archivo ni se ABRE, y el sistema de archivos resuelve gratis lo que en awk sería un parser.
    //
    // `dias + 1` y no `dias`: el filtro fino ya lo hace la línea, así que el archivo se elige con
    // margen. Al revés (elegir justo) un rotado del borde se perdería con líneas que sí entraban.
    //
    // `-mtime` y no `-newermt`: `-mtime` es POSIX y anda igual en el find de los nodos y en el de
    // esta Mac; `-newermt '-5 days'` acá falla con "Invalid timestamp" (bfs) y volvería imposible el
    // test de integración.
    //
    // El log corriente entra SIEMPRE, sin depender de find: el probe de arriba acaba de verificar
    // que existe. Si find no está o falla, se lee igual el de hoy — ventana más corta, jamás un cero
    // fantasma. Este módulo ya se quemó tres veces con "comando que devuelve vacío" leído como "no
    // hay tráfico".
    `LOGS="${logDir}/mail.log $(find ${logDir} -maxdepth 1 -name 'mail.log.*' -mtime -${dias + 1} 2>/dev/null | tr '\\n' ' ')"`,
    // El seguro del filtro por fecha: cuántas líneas de entrega NO empiezan con ninguno de los dos
    // formatos que la flota sabe escribir.
    //
    // Hace falta porque el filtro por prefijo es fail-OPEN hacia abajo: un tercer formato que no
    // conocemos no da error, da CERO — y cero se lee `no_traffic`, que desde el arreglo del onboarding
    // es un estado que ENTRA al pool. O sea que un nodo ciego se leería como nodo nuevo. Con esto,
    // ciego se lee `unreadable`, que es lo que es.
    //
    // Mira solo el log corriente y no `$LOGS`: para saber en qué formato escribe ESTE nodo alcanza
    // con un archivo, y así el seguro no cuesta una pasada más sobre los .gz.
    "echo '## SINFECHA'",
    `[ -n "$READ" ] && $READ ${logDir}/mail.log 2>/dev/null | grep 'status=' | grep -cvE '^([A-Z][a-z][a-z] [ 0-9][0-9] |[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T)' || true`,
    "echo '## DELIVERED'",
    pipeline("sent"),
    "echo '## BLOCKED'",
    pipeline("bounced"),
    "echo '## DEFERRED'",
    pipeline("deferred"),
    // La respuesta DIRECTA a "¿está atascado HOY?": una línea, sin fechas, sin parser, sin escanear
    // un solo log. El log dice qué pasó en la ventana; la cola dice qué está pasando ahora mismo.
    // Si postqueue no existe o no se puede correr no imprime nada, y eso se lee como "no sé" —
    // nunca como cola limpia.
    "echo '## QUEUE'",
    "{ sudo -n postqueue -p 2>/dev/null || postqueue -p 2>/dev/null || true; } | tail -1",
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

/**
 * Líneas de entrega escritas en un formato de fecha que el filtro de ventana no reconoce.
 *
 * `0` = el nodo escribe en syslog o en ISO-8601 y el corte por día lo lee entero. Cualquier otro
 * número = el sensor está CIEGO a parte del log de ese nodo, y sus totales no significan nada.
 * `null` = ni eso se pudo contar (salida vieja o truncada), que tampoco es cero.
 */
export function parseLineasSinFecha(stdout: string): number | null {
  const m = /^\s*(\d+)\s*$/m.exec(section(stdout, "SINFECHA"));
  return m ? Number(m[1]) : null;
}

/**
 * Cuántos mensajes hay trabados en la cola AHORA. `postqueue -p` tiene tres finales posibles y los
 * tres significan cosas distintas:
 *   · "Mail queue is empty"            → 0 de verdad, el nodo está limpio.
 *   · "-- 107250 Kbytes in 15710 Requests." → ese número.
 *   · nada / cualquier otra cosa       → NO SÉ, y eso es `null`, jamás 0.
 *
 * El tercero es el que importa: el 2026-07-29 un probe que se colgaba devolvió "bloqueado" falso en
 * 10 de 10 nodos, y la lección fue que un sensor que no puede leer dice "no sé". Un cero inventado
 * acá metería al pool un nodo con 15.693 mensajes atascados.
 */
export function parseQueueSize(stdout: string): number | null {
  const raw = section(stdout, "QUEUE");
  if (/Mail queue is empty/i.test(raw)) return 0;
  const m = /in\s+(\d+)\s+Request/i.exec(raw);
  return m ? Number(m[1]) : null;
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
export function assessDeliveryHealth(
  stats: NodeDeliveryStats,
  selfDomain?: string,
  extra?: { encolados?: number | null; ventana?: string }
): DeliveryHealthVerdict {
  const ventana = extra?.ventana ?? DELIVERY_STATS_WINDOW;
  const encolados = extra?.encolados ?? null;
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

  // La cola de AHORA manda sobre el log de la ventana, y va PRIMERA.
  //
  // El dedup por queue-id, solo, libera cuatro nodos con más de siete mil mensajes trabados
  // (nationalfiling-control 9.457, nationalfiling-infra 9.840, nationalfilingops 9.316,
  // corpdocfiling-ledger 7.306): su log deja de acusarlos porque los reintentos dejan de contar como
  // intentos distintos, pero el correo sigue sin salir del nodo. El dedup y este sensor van juntos o
  // no va ninguno.
  //
  // Va acá y no en el pool a propósito: así el veredicto viaja por los cables que YA existen — la
  // alerta `high` de sender-alerts.ts y el rojo de sender-quota.ts disparan por la etiqueta "cola
  // atascada", que sale de este `stalled`. Ponerlo en elegirPool habría sacado el nodo del warmup
  // dejándolo verde en la pantalla.
  //
  // Y es de UNA SOLA DIRECCIÓN: la cola solo puede EMPEORAR el veredicto. No existe la inversa
  // ("cola limpia veta el stalled del log"), que marcaría sano a un nodo cuyo diferido deduplicado
  // sigue arriba del 50%. Lo que libera nodos es el dedup, no la cola.
  if (encolados !== null && encolados >= COLA_ATASCADA_MIN) {
    return {
      status: "stalled",
      window: ventana,
      stats,
      encolados,
      blockedProviders,
      degradedProviders,
      detail: `${encolados} mensajes en la cola AHORA (postqueue): el correo no está saliendo del nodo`
    };
  }

  // El diferido cuenta. Sin esto, un nodo que no entrega NADA porque todo se difiere se leia
  // como "sin trafico" (si no hubo entregas) o como "sano" (si alguna paso), y en los dos casos
  // el operador no se enteraba de que la cola crecia.
  const totalAttempts = stats.totals.delivered + stats.totals.blocked + stats.totals.deferred;
  const deferredRatio = totalAttempts > 0 ? stats.totals.deferred / totalAttempts : 0;

  if (totalAttempts === 0) {
    return {
      status: "no_traffic",
      window: ventana,
      stats,
      encolados,
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
      window: ventana,
      stats,
      encolados,
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
      window: ventana,
      stats,
      encolados,
      blockedProviders,
      degradedProviders,
      detail: `cerrado en ${blockedProviders.join(", ")} (${worst.provider}: ${worst.blocked} rechazos sobre ${worst.delivered + worst.blocked} intentos)`
    };
  }
  if (degradedProviders.length > 0) {
    return { status: "degraded", window: ventana, stats, encolados, blockedProviders, degradedProviders, detail: `rechazo parcial en ${degradedProviders.join(", ")}` };
  }
  return { status: "healthy", window: ventana, stats, encolados, blockedProviders, degradedProviders, detail: `${stats.totals.delivered} entregados, ${stats.totals.blocked} rechazados` };
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
  /** Días de log a mirar. Por defecto la perilla del entorno. */
  dias?: number;
  timeoutMs?: number;
}): Promise<DeliveryHealthVerdict> {
  // La ventana se resuelve UNA vez, en el borde, y viaja por parámetro. Leer `process.env` acá
  // adentro haría imposible correr la tabla antes/después con dos ventanas distintas en el mismo
  // proceso, que es justo la medición que decide si este cambio se mergea.
  const dias = input.dias ?? DELIVERY_STATS_WINDOW_DAYS;
  const ventana = ventanaDeclarada(dias);
  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: buildDeliveryStatsCommand(dias),
      timeoutMs: input.timeoutMs ?? 60_000
    });
    if (deliveryStatsUnreadable(result.stdout)) {
      return {
        status: "unreadable",
        window: ventana,
        stats: EMPTY_STATS,
        encolados: null,
        blockedProviders: [],
        degradedProviders: [],
        detail: "sin permiso para leer /var/log/mail.log (es syslog:adm; el usuario ops necesita sudo)"
      };
    }
    const stats = parseDeliveryStats(result.stdout);
    if (!stats) {
      return { status: "unreadable", window: ventana, stats: EMPTY_STATS, encolados: null, blockedProviders: [], degradedProviders: [], detail: "salida incompleta (falta ## END)" };
    }
    // Un nodo que escribe la fecha en un tercer formato queda fuera del corte por día y devuelve
    // cero de todo. Cero se lee `no_traffic`, y `no_traffic` limpio ENTRA al pool desde el arreglo
    // del onboarding: sin esta rama, un nodo ciego se calentaría creyendo que es nuevo.
    const sinFecha = parseLineasSinFecha(result.stdout);
    if (sinFecha !== null && sinFecha > 0) {
      return {
        status: "unreadable",
        window: ventana,
        stats: EMPTY_STATS,
        encolados: parseQueueSize(result.stdout),
        blockedProviders: [],
        degradedProviders: [],
        detail: `${sinFecha} líneas de entrega con una fecha que no es syslog ni ISO-8601: el corte por día no las ve, así que los totales no valen`
      };
    }
    return assessDeliveryHealth(stats, input.selfDomain, { encolados: parseQueueSize(result.stdout), ventana });
  } catch (error) {
    return {
      status: "unreadable",
      window: ventana,
      stats: EMPTY_STATS,
      encolados: null,
      blockedProviders: [],
      degradedProviders: [],
      detail: `lectura fallida: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
