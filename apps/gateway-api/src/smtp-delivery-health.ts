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
  /**
   * El nodo movió correo y NADA de eso es nuestro.
   *
   * No es `no_traffic` (el log no está vacío) ni `blocked_by_provider` (no medimos NUESTRA
   * entrega): es "no sé", y tiene que existir como estado propio o el "no sé" se disfraza del
   * estado equivocado.
   *
   * QUÉ PASABA SIN ESTE ESTADO, medido el 2026-08-06: al separar el tráfico de NFC, 63 de 64 nodos
   * quedan por debajo de los 20 intentos que exigen BLOCKED_MIN_ATTEMPTS y STALLED_MIN_ATTEMPTS.
   * Si esos 63 devolvieran `no_traffic`, se leerían como dominios recién comprados — y `no_traffic`
   * ENTRA al pool del warmup A PROPÓSITO (plan-diario.ts:200, "un nodo nuevo es el candidato
   * natural a arrancar"). El pool habría saltado de 6 a ~63 y las 14 vueltas del día se habrían
   * repartido entre nodos que NFC ya quemó. Filtrar el ruido sin este estado era peor que no
   * filtrarlo.
   */
  | "no_own_traffic"
  | "unreadable";

export interface DeliveryHealthVerdict {
  status: DeliveryHealthStatus;
  /** Qué periodo cubren los numeros, en los días que se leyeron de verdad. */
  window: string;
  /**
   * LO NUESTRO — o el nodo entero cuando `atribucion.modo === "todo"`. Es lo único que decide el
   * veredicto. No se renombra a propósito: `scripts/ops/deliverability-health.ts` y el panel lo
   * leen por este nombre, y una migración de nombre en el mismo commit que cambia la semántica
   * esconde el cambio que importa.
   */
  stats: NodeDeliveryStats;
  /**
   * Lo que movió el nodo y NO es nuestro (el otro inquilino). Se MUESTRA — es el contexto que
   * explica por qué un dominio está quemado — pero NUNCA entra al veredicto.
   */
  ajenos: NodeDeliveryStats;
  /** Cómo se separó, y cuánto libro había para separarlo. Sin esto nadie puede auditar el número. */
  atribucion: { modo: "nuestro" | "todo"; queueIds: number; descartados: number };
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
 * A QUIÉN se le atribuye el tráfico del log.
 *
 * `readonly string[]` = los queue-ids de NUESTROS envíos, sacados de `warmup_activity`. Todo lo que
 * no esté en esa lista es del otro inquilino.
 * `"todo"` = no se atribuye nada, los números son del nodo entero. Es lo correcto para un
 * diagnóstico de máquina (`scripts/ops/deliverability-health.ts`), y una mentira para un veredicto
 * de NUESTRA reputación.
 *
 * POR QUÉ EXISTE ESTA DECISIÓN, con el número: por los mismos 58 nodos SMTP pasa el correo de NFC,
 * otro producto con otros clientes, que inyecta por 587 con SASL. Medido el 2026-08-06 sobre el log
 * retenido de los 64 nodos: 791.300 mensajes de NFC contra 222 nuestros (0,028%). O sea que el
 * 99,97% de la evidencia con la que este módulo declaraba `healthy` / `blocked_by_provider` /
 * `stalled` era reputación que quemó otro producto, publicada como medición nuestra en
 * `sender-measurement.json`, en `GET /v1/sender-measurement`, en la tool `read_sender_measurement`
 * del agente y en el panel.
 *
 * Y OJO CON EL DISCRIMINANTE, porque el obvio NO funciona: no alcanza con mirar `sasl_username` ni
 * el remitente. Los dos inquilinos autentican con el MISMO buzón (`mailer@<dominio>`) — medido en
 * nationalfiling-infra.com: 22.597 mensajes de NFC y 2 nuestros, todos con
 * `sasl_username=mailer@nationalfiling-infra.com`. Tampoco sirve "el warmup entra por sendmail
 * local": ese es el camino VIEJO (30 mensajes en toda la flota, último uso 31/07); el daemon que
 * corre hoy entra por 587 con SASL igual que NFC. Y el `client=` (EC2 = NFC) es una observación de
 * hoy, no una garantía: si NFC muda su emisor, deja de discriminar en silencio y sin error.
 *
 * Lo único robusto es NUESTRO PROPIO LIBRO: la respuesta 250 de Postfix trae el queue-id
 * ("250 2.0.0 Ok: queued as B7CA03F69F") y el daemon ya la guarda. La identificación es POSITIVA
 * — nuestro = está en el libro; todo lo demás = no nuestro — así que no depende de ninguna decisión
 * de NFC, y lo que no se puede atribuir cae del lado seguro (sub-cuenta lo nuestro, nunca lo
 * infla).
 */
export type ModoAtribucion = readonly string[] | "todo";

/**
 * Techo de queue-ids que se mandan dentro del comando. Nuestro máximo real por nodo y ventana,
 * medido contra la base de producción el 2026-08-06, es 13. 500 es dos órdenes de margen.
 *
 * Arriba de eso NO se atribuye a ciegas: se devuelve `unreadable`. Un libro que creció 40x es un
 * cambio de régimen que nadie previó (¿el warmup se disparó? ¿alguien mezcló dominios?), y seguir
 * armando una línea de shell de 50 KB con datos que vienen de una columna JSON no es "degradarse
 * con gracia", es adivinar.
 */
export const MAX_QUEUE_IDS = 500;

/**
 * BORDE DE CONFIANZA. Estos ids salen de `warmup_activity.detail->>'smtp'`, una columna JSON de
 * Postgres, y terminan DENTRO de una línea de shell que corre por SSH en 58 nodos de producción.
 * Entre esos dos puntos no hay ninguna otra validación: esta es la única.
 *
 * `[A-Za-z0-9]{4,20}` es exactamente la forma de un queue-id de Postfix en la flota: hex corto
 * (`B7CA03F69F`) y base-52 de `enable_long_queue_ids` (`4bXyZ9Qm2Rz1kT`). Cualquier cosa con
 * comilla, `;`, `$(`, espacio o `|` no matchea y se DESCARTA — no se escapa, no se cita, se tira.
 * Escapar es una lista de casos que alguien olvida; una lista blanca de dos clases de caracteres no
 * tiene casos que olvidar.
 *
 * `descartados` se devuelve y viaja al veredicto a propósito: un id que se cae es correo nuestro
 * que vamos a contar como ajeno, y eso tiene que ser visible, no silencioso.
 */
export function sanearIds(ids: readonly string[]): { ok: string[]; descartados: number } {
  const ok = [...new Set(ids.filter((s) => /^[A-Za-z0-9]{4,20}$/.test(s)))];
  return { ok, descartados: ids.length - ok.length };
}

/**
 * Comando de lectura. Sale SIEMPRE 0 y marca el fin de la salida: un exit distinto de
 * cero lo convierte el runner en excepción, y ahí "no pude leer" se disfrazaría de
 * "no hay problemas". Misma regla que el probe de propiedad.
 *
 * `propios` va PRIMERO y sin default: la atribución es una decisión, no una opción. Un default
 * silencioso ("si no me decís, cuento todo") es exactamente la forma en que vuelve el bug que este
 * cambio arregla — nadie escribe `propios: "todo"` por error, pero todos se olvidan de un campo
 * opcional.
 *
 * `logDir` existe SOLO para que el test pueda correr este mismo comando de verdad contra un
 * directorio de fixtures: en producción nadie lo pasa. Es la lección del fixture de Bedrock — un
 * test escrito sobre mi suposición de cómo se ve la salida comparte el error con el código y no
 * salva de nada; este corre por el camino de producción.
 */
export function buildDeliveryStatsCommand(
  propios: ModoAtribucion,
  dias = DELIVERY_STATS_WINDOW_DAYS,
  logDir = "/var/log",
  ahora = new Date()
): string {
  // En modo "todo" no se manda ni un id: el awk cuenta el total y la sección OWN sale vacía, y es
  // TypeScript el que después iguala propio = total. Cero ramas nuevas dentro del shell, que es
  // donde no hay tipos ni tests unitarios que sostengan una bifurcación.
  const idsAwk = propios === "todo" ? "" : sanearIds(propios).ok.join(" ");
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
  //
  // LA MISMA PASADA CUENTA DOS VECES: total del nodo y lo NUESTRO. No se agrega ni un `zcat` más
  // (ya son cuatro pasadas sobre los .gz de un nodo que puede tener 60.000 mensajes retenidos); el
  // awk del final lleva dos acumuladores y emite él mismo el marcador de la sección propia.
  //
  // El `END` de awk corre AUNQUE NO ENTRE NI UNA LÍNEA, así que el marcador `## OWN_*` existe
  // siempre que el comando haya llegado a correr. Esa garantía es la que le permite al parser tratar
  // su AUSENCIA como "no entiendo esta salida" en vez de como "no hay nada nuestro" — la diferencia
  // entre `unreadable` y convertir la flota entera en `no_own_traffic` sin que nadie se entere.
  const pipeline = (status: string, seccionPropia: string): string =>
    `[ -n "$READ" ] && $READ $LOGS 2>/dev/null | ${enVentana} | grep "status=${status}"` +
    " | grep -oE '\\]: [^ :]+: to=<[^>]*@[^>]*>'" +
    // OJO: el separador del sed es un TABULADOR REAL (el `\t` de este literal de JS emite el
    // carácter). El sed de BSD — el de esta Mac, donde corre el test de integración — no interpreta
    // `\t` en el reemplazo y devolvería una `t` literal; el de GNU sí. Un tab real anda en los dos.
    ` | sed -E 's/^\\]: ([^ :]+): to=<[^>]*@([^>]*)>/\\1\t\\2/'` +
    " | sort -u" +
    ` | awk -F'\\t' -v ids='${idsAwk}' '` +
      'BEGIN{n=split(ids,a," ");for(i=1;i<=n;i++)m[a[i]]=1}' +
      "{p=tolower($2);t[p]++;if($1 in m)o[p]++}" +
      `END{for(p in t)printf "%d %s\\n",t[p],p;print "## ${seccionPropia}";for(p in o)printf "%d %s\\n",o[p],p}'` +
    " || true";

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
    pipeline("sent", "OWN_DELIVERED"),
    "echo '## BLOCKED'",
    pipeline("bounced", "OWN_BLOCKED"),
    "echo '## DEFERRED'",
    pipeline("deferred", "OWN_DEFERRED"),
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

function armar(
  delivered: Map<string, number>,
  blocked: Map<string, number>,
  deferred: Map<string, number>
): NodeDeliveryStats {
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
 * Parte la salida en las DOS lecturas: el nodo entero y lo nuestro.
 *
 * FAIL-HONEST DOBLE. Sin `## END` devuelve `null` como siempre (salida truncada). Y si falta
 * CUALQUIERA de los tres `## OWN_*` también devuelve `null`, aunque el resto esté perfecto: una
 * sección propia ausente no son cero mensajes nuestros, es una salida que no sabemos leer.
 *
 * Por qué esa rama vale su propio `return`: leerla como cero convertiría cada nodo de la flota en
 * `no_own_traffic` de una, en silencio y sin un solo error — y el archivo que publica el panel se
 * llenaría de "sin muestra propia" sin que nadie sospeche del parser. Este módulo ya se quemó TRES
 * veces con la misma forma exacta: "comando que devuelve vacío" leído como "no hay tráfico".
 */
export function parseDeliveryStats(
  stdout: string
): { total: NodeDeliveryStats; propio: NodeDeliveryStats } | null {
  if (!stdout.includes("## END")) return null; // salida truncada: no inventamos
  for (const s of ["OWN_DELIVERED", "OWN_BLOCKED", "OWN_DEFERRED"]) {
    if (!stdout.includes(`## ${s}`)) return null;
  }
  return {
    total: armar(
      counts(section(stdout, "DELIVERED")),
      counts(section(stdout, "BLOCKED")),
      counts(section(stdout, "DEFERRED"))
    ),
    propio: armar(
      counts(section(stdout, "OWN_DELIVERED")),
      counts(section(stdout, "OWN_BLOCKED")),
      counts(section(stdout, "OWN_DEFERRED"))
    )
  };
}

/**
 * `total - propio`, por receptor y en los totales. Nunca negativo: si el propio superara al total
 * (imposible por construcción — la sección OWN es un subconjunto de la misma pasada) el clamp evita
 * publicar un número que no significa nada.
 */
function restar(total: NodeDeliveryStats, propio: NodeDeliveryStats): NodeDeliveryStats {
  const mio = new Map(propio.byProvider.map((p) => [p.provider, p]));
  const menos = (a: number, b: number): number => Math.max(0, a - b);
  return {
    totals: {
      delivered: menos(total.totals.delivered, propio.totals.delivered),
      blocked: menos(total.totals.blocked, propio.totals.blocked),
      deferred: menos(total.totals.deferred, propio.totals.deferred)
    },
    byProvider: total.byProvider
      .map((p) => {
        const m = mio.get(p.provider);
        return {
          provider: p.provider,
          delivered: menos(p.delivered, m?.delivered ?? 0),
          blocked: menos(p.blocked, m?.blocked ?? 0),
          deferred: menos(p.deferred, m?.deferred ?? 0)
        };
      })
      .filter((p) => p.delivered + p.blocked + p.deferred > 0)
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
  extra?: {
    encolados?: number | null;
    ventana?: string;
    /**
     * Lo que movió el nodo ENTERO. Ausente = `stats` ya es el total (modo "todo"), que es lo
     * honesto para un llamador que no atribuyó nada.
     */
    total?: NodeDeliveryStats;
    modo?: "nuestro" | "todo";
    queueIds?: number;
    descartados?: number;
  }
): DeliveryHealthVerdict {
  const ventana = extra?.ventana ?? DELIVERY_STATS_WINDOW;
  const encolados = extra?.encolados ?? null;
  const total = extra?.total ?? stats;
  const ajenos = restar(total, stats);
  const atribucion = {
    modo: extra?.modo ?? "todo",
    queueIds: extra?.queueIds ?? 0,
    descartados: extra?.descartados ?? 0
  } as const;
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
  // UN SOLO armador para los siete veredictos, en vez de siete objetos literales.
  //
  // No es cosmético: el 2026-08-06, al agregar `encolados`, cinco de los seis `return` se quedaron
  // sin el campo nuevo. Como corremos con --experimental-strip-types no hay chequeo en tiempo de
  // ejecución, así que salía `undefined`, JSON.stringify borraba la clave, y sender-measurement.json
  // quedó sin el dato en 49 de 58 nodos. Este cambio agrega DOS campos más (`ajenos`, `atribucion`)
  // y multiplicaría por tres la misma trampa. Con un armador, olvidarse ya no es posible.
  const veredicto = (status: DeliveryHealthStatus, detail: string): DeliveryHealthVerdict => ({
    status, window: ventana, stats, ajenos, atribucion, encolados, blockedProviders, degradedProviders, detail
  });

  if (encolados !== null && encolados >= COLA_ATASCADA_MIN) {
    // Y ESTA RAMA NO SE ATRIBUYE NUNCA, ni cuando el modo es "nuestro". La cola de Postfix es FÍSICA
    // y COMPARTIDA: si el nodo tiene 15.693 mensajes trabados porque NFC los inyectó, nuestro correo
    // tampoco sale de ahí. Preguntar "¿de quién son los mensajes trabados?" es la pregunta
    // equivocada; la correcta es "¿sale correo de este nodo?", y la respuesta es no.
    return veredicto(
      "stalled",
      `${encolados} mensajes en la cola AHORA (postqueue): el correo no está saliendo del nodo`
    );
  }

  // El diferido cuenta. Sin esto, un nodo que no entrega NADA porque todo se difiere se leia
  // como "sin trafico" (si no hubo entregas) o como "sano" (si alguna paso), y en los dos casos
  // el operador no se enteraba de que la cola crecia.
  const totalAttempts = stats.totals.delivered + stats.totals.blocked + stats.totals.deferred;
  const deferredRatio = totalAttempts > 0 ? stats.totals.deferred / totalAttempts : 0;
  const attemptsDelNodo = total.totals.delivered + total.totals.blocked + total.totals.deferred;

  // El orden de estas dos ramas es el que separa "no sé" de "nodo nuevo", y no es intercambiable.
  if (totalAttempts === 0 && attemptsDelNodo > 0) {
    return veredicto(
      "no_own_traffic",
      `el nodo movió ${attemptsDelNodo} mensajes en la ventana y ninguno es nuestro ` +
        `(${atribucion.queueIds} envíos en nuestro libro): sin muestra propia no hay veredicto`
    );
  }
  if (totalAttempts === 0) {
    // Log genuinamente vacío. La semántica queda INTACTA: un dominio recién comprado no dejó huella
    // en ningún mail.log y tiene que poder recibir su primer correo de warmup. Es la trampa que
    // documenta plan-diario.ts:177-195 y este cambio no la reabre.
    return veredicto("no_traffic", "el log no registra ni entregas ni rechazos ni diferidos en la ventana leida");
  }
  if (
    stats.totals.deferred >= STALLED_MIN_ATTEMPTS &&
    deferredRatio >= STALLED_MIN_DEFERRED_RATIO
  ) {
    return veredicto(
      "stalled",
      `${stats.totals.deferred} diferidos de ${totalAttempts} (${Math.round(deferredRatio * 100)}%): ` +
        "el correo sale del nodo pero no llega; la cola se acumula"
    );
  }
  if (blockedProviders.length > 0) {
    const worst = stats.byProvider.find((p) => p.provider === blockedProviders[0])!;
    return veredicto(
      "blocked_by_provider",
      `cerrado en ${blockedProviders.join(", ")} (${worst.provider}: ${worst.blocked} rechazos sobre ${worst.delivered + worst.blocked} intentos)`
    );
  }
  if (degradedProviders.length > 0) {
    return veredicto("degraded", `rechazo parcial en ${degradedProviders.join(", ")}`);
  }
  return veredicto("healthy", `${stats.totals.delivered} entregados, ${stats.totals.blocked} rechazados`);
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
  /**
   * REQUERIDO, sin default. Los queue-ids de nuestros envíos a ESTE nodo en la ventana, o `"todo"`
   * para no atribuir. Es la decisión más consecuente del módulo — de qué reputación estamos
   * hablando — y un campo opcional es un campo que alguien no completa.
   */
  propios: ModoAtribucion;
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
  const modo = input.propios === "todo" ? "todo" : "nuestro";
  const saneados = input.propios === "todo" ? { ok: [] as string[], descartados: 0 } : sanearIds(input.propios);
  const atribucion = { modo, queueIds: saneados.ok.length, descartados: saneados.descartados } as const;
  const ilegible = (detail: string, encolados: number | null = null): DeliveryHealthVerdict => ({
    status: "unreadable",
    window: ventana,
    stats: EMPTY_STATS,
    ajenos: EMPTY_STATS,
    atribucion,
    encolados,
    blockedProviders: [],
    degradedProviders: [],
    detail
  });

  if (saneados.ok.length > MAX_QUEUE_IDS) {
    return ilegible(
      `${saneados.ok.length} queue-ids en la ventana (tope ${MAX_QUEUE_IDS}): el libro creció más de ` +
        "lo previsto, no atribuyo a ciegas"
    );
  }

  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: buildDeliveryStatsCommand(input.propios, dias),
      timeoutMs: input.timeoutMs ?? 60_000
    });
    if (deliveryStatsUnreadable(result.stdout)) {
      return ilegible("sin permiso para leer /var/log/mail.log (es syslog:adm; el usuario ops necesita sudo)");
    }
    const stats = parseDeliveryStats(result.stdout);
    if (!stats) {
      return ilegible("salida incompleta (falta ## END o alguna sección ## OWN_*)");
    }
    // Un nodo que escribe la fecha en un tercer formato queda fuera del corte por día y devuelve
    // cero de todo. Cero se lee `no_traffic`, y `no_traffic` limpio ENTRA al pool desde el arreglo
    // del onboarding: sin esta rama, un nodo ciego se calentaría creyendo que es nuevo.
    const sinFecha = parseLineasSinFecha(result.stdout);
    if (sinFecha !== null && sinFecha > 0) {
      return ilegible(
        `${sinFecha} líneas de entrega con una fecha que no es syslog ni ISO-8601: el corte por día no las ve, así que los totales no valen`,
        parseQueueSize(result.stdout)
      );
    }
    // En modo "todo" el propio ES el total: no hay nada que restar y `ajenos` queda en cero. Sin
    // este `?:` el mismo objeto viajaría dos veces y el veredicto diría "0 nuestros de N" sobre un
    // llamador que nunca pidió atribuir.
    return assessDeliveryHealth(modo === "todo" ? stats.total : stats.propio, input.selfDomain, {
      encolados: parseQueueSize(result.stdout),
      ventana,
      total: stats.total,
      ...atribucion
    });
  } catch (error) {
    return ilegible(`lectura fallida: ${error instanceof Error ? error.message : String(error)}`);
  }
}
