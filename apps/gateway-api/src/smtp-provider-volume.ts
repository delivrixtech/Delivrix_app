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

const FAMILY_DOMAINS: ReadonlyArray<readonly [ProviderFamily, readonly string[]]> = [
  ["google", ["gmail.com", "googlemail.com"]],
  ["microsoft", ["hotmail.com", "outlook.com", "live.com", "msn.com", "hotmail.co.uk", "outlook.es"]],
  ["yahoo_aol", ["yahoo.com", "ymail.com", "rocketmail.com", "aol.com", "yahoo.es", "yahoo.co.uk"]],
  ["comcast", ["comcast.net", "xfinity.com"]],
  ["charter_rr", ["rr.com", "charter.net", "spectrum.net", "twc.com"]],
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
    if (domains.includes(domain)) return family;
  }
  return "otros";
}

export interface ProviderDayVolume {
  /** `Jul 30`, tal como lo escribe syslog. El log no trae año. */
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
 * Comando que corre en el nodo.
 *
 * Dedup por (dia, queue-id, dominio) con `sort -u` ANTES de contar: ahi esta la diferencia entre
 * mensajes e intentos. El queue-id se extrae por patron y no por posicion de campo, porque el
 * prefijo de syslog cambia entre distribuciones y un `$5` se rompe en silencio.
 */
export function buildProviderVolumeCommand(): string {
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
    "echo '## VOLUME'",
    [
      '[ -n "$READ" ] && $READ /var/log/mail.log* 2>/dev/null',
      // Solo lineas de entrega con destinatario: cada una lleva dia, queue-id y dominio.
      "| grep -oE '^[A-Za-z]{3} +[0-9]+ .*\\]: [0-9A-Fa-f]{6,}: to=<[^>]*@[^>]*>'",
      "| sed -E 's/^([A-Za-z]{3} +[0-9]+).*\\]: ([0-9A-Fa-f]{6,}): to=<[^>]*@([^>]*)>/\\1\\t\\2\\t\\3/'",
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
    // `   42 Jul 30<TAB>gmail.com`
    const match = /^\s*(\d+)\s+([A-Za-z]{3}\s+\d+)\s+(\S+)\s*$/.exec(raw.replace(/\t/g, " "));
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
