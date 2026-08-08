// Cuantos MENSAJES por dia le manda un nodo a cada familia de proveedor.
//
// Es la medicion del umbral irreversible. Google clasifica como bulk sender —de forma
// PERMANENTE, sin expiracion— al dominio que manda "close to 5,000 messages or more to personal
// Gmail accounts within a 24-hour period" (support.google.com/mail/answer/14229414, verificado
// 2026-07-30). Microsoft aplica el mismo umbral. Hoy nadie sabe en que numero estamos, y es el
// unico dato del sistema que no se puede deshacer.
//
// TRES COSAS QUE ESTE MODULO HACE DISTINTO A `smtp-delivery-health.ts`, y las tres importan:
//
// 1. Cuenta MENSAJES UNICOS, no intentos. Medido en un nodo real: 5.513 lineas `to=<...@gmail>`
//    en un dia contra 1.293 mensajes unicos — 4,3x de inflado por reintentos. Contar lineas
//    habria dicho "cruzaste el umbral hoy" cuando estabamos al 27%.
// 2. Agrupa por FAMILIA de proveedor. googlemail.com es Google; ymail.com y aol.com son Yahoo;
//    xfinity.com es Comcast. Contar por dominio destino reparte un mismo receptor en varias filas
//    y ninguna cruza el umbral que el receptor si ve sumado.
// 3. Corta POR DIA. El umbral es una ventana de 24h; un total acumulado no dice nada de el.

/** Familias de receptor que publican umbral propio o que pesan en nuestra flota. */
export type ProviderFamily =
  | "google"
  | "microsoft"
  | "yahoo_aol"
  | "comcast"
  | "charter_rr"
  | "apple"
  | "otros";

/**
 * QUÉ RECEPTOR PERTENECE A QUÉ FAMILIA. Se calibra AGREGANDO FILAS MEDIDAS, no adivinando.
 *
 * No es sólo el umbral de volumen: `smtp-delivery-health.ts` pregunta `providerFamilyFor(x) !==
 * "otros"` para decidir si un receptor que nos rechazó TODO bajo el piso de intentos vale un veto
 * (`insufficient_sample`). Ese filtro existe para que un typo (`gamil.com`, `yahoo.comm`) no congele
 * un dominio — y está bien —, pero con la tabla corta se llevaba puestos receptores REALES: un nodo
 * cuyo único receptor con rechazo del 100% sea `bellsouth.net` salía `healthy` con el texto
 * "0 entregados a terceros, 3 rechazados", que es la firma exacta de "no medido leído como sano".
 *
 * LAS FILAS DE ABAJO SON MEDICIÓN, con su volumen del barrido pasivo de la flota (5 días, 58 nodos,
 * 2026-08-08): bellsouth.net 671 entregas / 982 diferidos en 7 nodos · verizon.net 461/555 en 7 ·
 * att.net 388/490 en 7 · sbcglobal.net 112/93 en 6 · myyahoo.com 159/206 en 7 · yahoo.fr 44/64 en 4.
 * Son los buzones de NFC y ya aparecieron cerrados en producción (una fila vieja de
 * sender-measurement.json trae `cerradoEn: ['yahoo.com','aol.com','bellsouth.net']`). Hoy los salva
 * del hueco que TODAVÍA entregan; el día que caigan bajo el piso —que es el escenario que este lote
 * prepara, "el día que NFC deje de inyectar"— el veto se apagaba para ellos en silencio.
 *
 * bellsouth/att/sbcglobal/verizon van en `yahoo_aol` y no en una familia propia porque el correo de
 * esos dominios lo OPERA Yahoo: comparten infraestructura, política y el umbral de 5.000/día, que es
 * justo lo que la familia significa. Verificado que no mueve un solo `cruzados`: la cota superior
 * (todo el tráfico de la ventana sumado al pico de un solo día) da 4.475 en el peor nodo de la flota
 * —corpdocfiling-ledger.com— contra el umbral de 5.000, y ese nodo ya está cruzado en google igual.
 *
 * LO QUE QUEDA AFUERA A PROPÓSITO, con su volumen medido, para que el próximo lo agregue con dato y
 * no de memoria: protonmail.com 338/165, proton.me 262/144, mail.com 145/102, cox.net 106/116,
 * gmx.com 27/52, earthlink.net 62/13. Son receptores reales pero no pertenecen a ninguna de las seis
 * familias que esta tabla modela, y meterlos exigiría inventarles familia y umbral. Consecuencia
 * conocida: el veto de `insufficient_sample` sigue apagado para ellos.
 * ponytail: el techo es una lista a mano; si la cola de receptores importa, el reemplazo es sacarla
 * del log de la flota ordenada por volumen, no un match difuso por nombre.
 */
const FAMILY_DOMAINS: ReadonlyArray<readonly [ProviderFamily, readonly string[]]> = [
  ["google", ["gmail.com", "googlemail.com"]],
  ["microsoft", [
    "hotmail.com", "outlook.com", "live.com", "msn.com", "hotmail.co.uk", "outlook.es",
    "hotmail.fr", "hotmail.es", "hotmail.de", "hotmail.it", "outlook.fr", "outlook.de", "outlook.com.br",
    "live.co.uk", "live.fr", "passport.com"
  ]],
  ["yahoo_aol", [
    "yahoo.com", "ymail.com", "rocketmail.com", "aol.com", "yahoo.es", "yahoo.co.uk",
    // Los de AT&T/Verizon: buzones distintos, MX y política de Yahoo.
    "bellsouth.net", "sbcglobal.net", "att.net", "verizon.net", "ameritech.net", "pacbell.net",
    "swbell.net", "flash.net", "prodigy.net", "nvbell.net", "snet.net",
    "myyahoo.com", "yahoo.fr", "yahoo.de", "yahoo.it", "yahoo.ca", "yahoo.com.mx", "yahoo.com.br",
    "yahoo.com.ar", "yahoo.in", "yahoo.co.jp", "aol.co.uk", "aim.com", "netscape.net", "love.com"
  ]],
  ["comcast", ["comcast.net", "xfinity.com"]],
  ["charter_rr", ["rr.com", "charter.net", "spectrum.net", "twc.com", "roadrunner.com"]],
  ["apple", ["icloud.com", "me.com", "mac.com"]]
];

/**
 * Umbral diario declarado por el receptor, por dominio primario del remitente.
 *
 * Solo estan los que lo PUBLICAN. Comcast no publica umbral y por eso vale `null`: no es que no
 * importe —es el segundo destino de la flota y el que ya nos rechaza con 554— es que no hay un
 * numero oficial contra el cual medirse, y poner uno inventado seria justo lo que venimos
 * arreglando todo el dia.
 */
export const PROVIDER_DAILY_THRESHOLD: Readonly<Record<ProviderFamily, number | null>> = {
  google: 5_000,
  microsoft: 5_000,
  yahoo_aol: 5_000,
  comcast: null,
  charter_rr: null,
  apple: null,
  otros: null
};

/**
 * Fraccion del umbral a partir de la cual avisamos.
 *
 * 0,4 y no 0,9: el umbral de Google dice "close to 5,000", o sea que el borde real es difuso, y
 * cruzarlo no se deshace. Se avisa con margen porque no hay segunda oportunidad.
 */
export const THRESHOLD_WARN_RATIO = 0.4;

export function providerFamilyFor(recipientDomain: string): ProviderFamily {
  const domain = recipientDomain.trim().toLowerCase().replace(/\.$/, "");
  for (const [family, domains] of FAMILY_DOMAINS) {
    // Exacto O SUBDOMINIO, y el punto no es cosmético: `rr.com` tiene decenas de variantes
    // regionales (wi.rr.com, tampabay.rr.com, cfl.rr.com — las tres con volumen medido en la flota) y
    // listarlas a mano es una lista que nunca termina. El sufijo se compara sobre el LABEL (`.rr.com`)
    // y no sobre el string pelado: `"askherr.com".endsWith("rr.com")` da `true`, y así un dominio de
    // cliente cualquiera se clasificaría charter_rr y arrastraría su umbral.
    if (domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return family;
  }
  return "otros";
}

export interface ProviderDayVolume {
  /**
   * El día tal como lo escribe el nodo: `Jul 30` en los 46 Contabo (syslog, sin año) y `2026-08-06`
   * en los 12 Webdock (ISO-8601). Es un rótulo de pantalla, no una clave que se compare entre nodos.
   *
   * No se normaliza a propósito: unificar pediría inventarle el año al syslog, que es exactamente el
   * parser que `smtp-delivery-health.ts:87` decidió no escribir (ahí el año lo cierra el `find
   * -mtime`, o sea el sistema de archivos). Dos formatos honestos antes que uno adivinado.
   */
  day: string;
  family: ProviderFamily;
  /** Mensajes UNICOS, deduplicados por queue-id. */
  messages: number;
}

export interface NodeVolumeReport {
  perDay: ProviderDayVolume[];
  /** El dia de mayor volumen por familia: contra esto se compara el umbral. */
  peakByFamily: Array<{ family: ProviderFamily; day: string; messages: number; threshold: number | null; ratio: number | null }>;
  /** Familias que superaron THRESHOLD_WARN_RATIO en su pico. */
  nearThreshold: ProviderFamily[];
  /** Familias que YA cruzaron el umbral publicado. Irreversible en Google. */
  overThreshold: ProviderFamily[];
}

/**
 * El prefijo de fecha de una linea de entrega, en los DOS formatos que escribe la flota.
 *
 * `Aug  6` (syslog, los 46 nodos Contabo) y `2026-08-06` (ISO-8601, los 12 Webdock). Vive suelto
 * porque el grep y el sed de abajo tienen que usar EXACTAMENTE el mismo: si divergen, uno filtra
 * lineas que el otro no sabe partir y el resultado es cero sin error.
 */
const PREFIJO_DIA = "([A-Za-z]{3} +[0-9]+|[0-9]{4}-[0-9]{2}-[0-9]{2})";

/**
 * Comando que corre en el nodo.
 *
 * Dedup por (dia, queue-id, dominio) con `sort -u` ANTES de contar: ahi esta la diferencia entre
 * mensajes e intentos. El queue-id se extrae por patron y no por posicion de campo, porque el
 * prefijo de syslog cambia entre distribuciones y un `$5` se rompe en silencio.
 *
 * ESTE SENSOR ESTUVO CIEGO EN 12 DE 58 NODOS, y era el sensor del unico dano que no se deshace.
 * Medido en produccion el 2026-08-06 (sender-measurement.json, medidoEn 19:24:16.459Z, 58/58
 * leidas): exactamente 12 bandejas con `picos: []`, y son exactamente las 12 con slug `serverNN`,
 * o sea los 12 Webdock. Entre ellas `corpdocfiling-ledger.com` (server68) con 20.425 entregados en
 * 5 dias, cap 15000 y `cruzados: []` — que el panel y el agente leian como "no cruzo". Y dos de las
 * 12, `annualfilings-control.com` y `corpfiling-infra.com`, estaban `healthy`: dentro del pool del
 * warmup, calentandose sin que nadie pudiera saber si ya estaban quemadas.
 *
 * Los dos filtros que lo dejaban en cero, cada uno suficiente por si solo:
 *   1. Exigia fecha syslog (`^[A-Za-z]{3} +[0-9]+`) y los 12 Webdock escriben ISO-8601.
 *   2. Exigia queue-id hexadecimal (`[0-9A-Fa-f]{6,}`) y los nodos con `enable_long_queue_ids`
 *      escriben base-52 (`4bXyZ9Qm2Rz1kT`). El modulo hermano ya lo habia arreglado y lo dejo por
 *      escrito senalando a ESTE archivo: ver `smtp-delivery-health.ts:194-196`.
 *
 * `logDir` existe SOLO para que el test corra este mismo string con bash contra un directorio de
 * fixtures; en produccion nadie lo pasa. Es el mismo mecanismo (y la misma leccion del fixture de
 * Bedrock) que `buildDeliveryStatsCommand`: una pipeline de shell solo se prueba corriendola.
 *
 * ── ESTE SENSOR NO SE ATRIBUYE. ES EL ÚNICO. ────────────────────────────────────────────────────
 *
 * El 2026-08-06 el módulo hermano (`smtp-delivery-health.ts`) aprendió a separar NUESTRO correo del
 * de NFC —el otro producto que inyecta por los mismos 58 nodos— porque estaba midiendo reputación
 * ajena y llamándola nuestra: 791.300 mensajes de ellos contra 222 nuestros. La orden del operador
 * fue "aislar y olvidar esos datos". ACÁ NO SE AÍSLA NADA, y es a propósito.
 *
 * El receptor no clasifica por quién inyectó: Google y Yahoo cuentan por DOMINIO y por IP. Los
 * ~15.000 mensajes/día que NFC saca por NUESTROS dominios cuentan ENTEROS contra el umbral de
 * 5.000/día, y cruzarlo clasifica el dominio como bulk sender de forma PERMANENTE, sin apelación.
 * Filtrar por queue-id o por `sasl_username` acá dejaría todos los picos en cero y todos los
 * dominios "limpios" — apagaría el único sensor del único daño del sistema que no se deshace,
 * justo mientras el daño sigue ocurriendo. `bizreport-control.com` ya cruzó ese umbral y no hay
 * forma de volver atrás.
 *
 * O sea: si alguien vuelve con "aislá y olvidá los datos de NFC", esto es lo que NO se aísla. Hay un
 * test que lo fija por el string del comando, para que el filtro no se pueda agregar por descuido.
 */
export function buildProviderVolumeCommand(logDir = "/var/log"): string {
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
    "echo '## VOLUME'",
    [
      // El asterisco (todo lo rotado) es CORRECTO aca, y a proposito distinto del modulo de salud,
      // que se acoto a 5 dias. La salud pregunta "¿esta atascado HOY?"; esto pregunta "¿alguna vez
      // cruzo el umbral?", y cruzarlo es permanente. Una ventana corta convertiria un dominio
      // quemado en un dominio limpio con solo esperar.
      `[ -n "$READ" ] && $READ ${logDir}/mail.log* 2>/dev/null`,
      // Solo lineas de entrega con destinatario: cada una lleva dia, queue-id y dominio.
      `| grep -oE '^${PREFIJO_DIA}[^ ]* .*\\]: [^ :]+: to=<[^>]*@[^>]*>'`,
      // DOS DETALLES QUE NO SE PUEDEN EQUIVOCAR EN ESTE sed:
      //
      // 1. El `[^ ]*` va DESPUES del parentesis de la fecha, o sea que `T19:24:16.459123+00:00`
      //    queda FUERA del grupo capturado. Si el timestamp entrara al grupo, la clave del
      //    `sort -u` llevaria microsegundos, cada linea seria unica, el dedup moriria y
      //    contariamos INTENTOS en vez de MENSAJES: 4,3x de inflado medido (ver cabecera). En el
      //    nodo de 20.425 entregas eso reportaria "cruzo el umbral" estando al 23% — el peor error
      //    posible, porque miente hacia el lado que dispara acciones irreversibles.
      // 2. Los separadores del reemplazo son TABULADORES REALES (el `\t` de este template literal
      //    emite el caracter). GNU sed —el de los nodos— interpreta un `\t` de dos caracteres;
      //    BSD sed —el de esta Mac, donde corre el gate— NO, y devolveria una `t` literal. Un tab
      //    real anda en los dos. Misma trampa documentada en `smtp-delivery-health.ts:200-203`.
      `| sed -E 's/^${PREFIJO_DIA}[^ ]* .*\\]: ([^ :]+): to=<[^>]*@([^>]*)>/\\1\t\\2\t\\3/'`,
      // Un mensaje a un destino cuenta UNA vez por dia, sin importar cuantas veces se reintento.
      "| sort -u",
      "| awk -F'\\t' '{print $1 \"\\t\" tolower($3)}'",
      "| sort | uniq -c",
      "|| true"
    ].join(" "),
    "echo '## END'"
  ].join("\n");
}

/** Devuelve null si la salida esta incompleta: mejor "no se" que un cero que se lee como "nada". */
export function parseProviderVolume(stdout: string): ProviderDayVolume[] | null {
  // Sin permiso de lectura no hay medicion. Devolver [] seria decir "no manda nada".
  if (stdout.includes("## NOACCESS")) return null;
  if (!stdout.includes("## END")) return null;
  const start = stdout.indexOf("## VOLUME");
  if (start === -1) return null;
  const body = stdout.slice(start + "## VOLUME".length, stdout.indexOf("## END"));

  const acc = new Map<string, number>();
  for (const raw of body.split("\n")) {
    // `   42 Jul 30<TAB>gmail.com` (Contabo) o `   42 2026-08-06<TAB>gmail.com` (Webdock).
    //
    // La alternativa ISO no es cosmetica: sin ella el nodo mandaba bien las lineas y el HOST las
    // descartaba igual, o sea que arreglar el comando y olvidarse de aca dejaba los 12 Webdock
    // exactamente igual de ciegos.
    const match = /^\s*(\d+)\s+([A-Za-z]{3}\s+\d+|\d{4}-\d{2}-\d{2})\s+(\S+)\s*$/.exec(raw.replace(/\t/g, " "));
    if (!match) continue;
    const [, count, day, domain] = match;
    const family = providerFamilyFor(domain!);
    const key = `${day!.replace(/\s+/g, " ")}|${family}`;
    acc.set(key, (acc.get(key) ?? 0) + Number(count));
  }

  return [...acc.entries()].map(([key, messages]) => {
    const [day, family] = key.split("|");
    return { day: day!, family: family as ProviderFamily, messages };
  });
}

/** Del volumen diario saca el pico por familia y lo compara con el umbral publicado. */
export function assessProviderVolume(perDay: ProviderDayVolume[]): NodeVolumeReport {
  const peaks = new Map<ProviderFamily, { day: string; messages: number }>();
  for (const entry of perDay) {
    const current = peaks.get(entry.family);
    if (!current || entry.messages > current.messages) {
      peaks.set(entry.family, { day: entry.day, messages: entry.messages });
    }
  }

  const peakByFamily = [...peaks.entries()].map(([family, peak]) => {
    const threshold = PROVIDER_DAILY_THRESHOLD[family];
    return {
      family,
      day: peak.day,
      messages: peak.messages,
      threshold,
      ratio: threshold === null ? null : Number((peak.messages / threshold).toFixed(3))
    };
  }).sort((left, right) => right.messages - left.messages);

  return {
    perDay,
    peakByFamily,
    nearThreshold: peakByFamily
      .filter((p) => p.ratio !== null && p.ratio >= THRESHOLD_WARN_RATIO && p.ratio < 1)
      .map((p) => p.family),
    overThreshold: peakByFamily.filter((p) => p.ratio !== null && p.ratio >= 1).map((p) => p.family)
  };
}

export interface ProviderVolumeSshRunner {
  run(input: {
    serverSlug?: string | null;
    serverIp: string;
    command: string;
    timeoutMs?: number;
  }): Promise<{ stdout: string; exitCode: number | null }>;
}

export type ProviderVolumeResult =
  | ({ status: "ok" } & NodeVolumeReport)
  | { status: "unreadable"; detail: string };

/** Lee el volumen por proveedor de UN nodo. Fail-honest: no leer nunca se reporta como cero. */
export async function readNodeProviderVolume(input: {
  sshRunner: ProviderVolumeSshRunner;
  serverSlug: string;
  serverIp: string;
  timeoutMs?: number;
}): Promise<ProviderVolumeResult> {
  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: buildProviderVolumeCommand(),
      timeoutMs: input.timeoutMs ?? 90_000
    });
    const perDay = parseProviderVolume(result.stdout);
    if (!perDay) {
      return { status: "unreadable", detail: "salida incompleta (falta ## END)" };
    }
    return { status: "ok", ...assessProviderVolume(perDay) };
  } catch (error) {
    return {
      status: "unreadable",
      detail: `lectura fallida: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
