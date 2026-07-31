// El feed en vivo de la flota: los eventos de envío POR MENSAJE, leídos del mail.log de un nodo.
//
// La medición (sender-measurement) AGREGA el mail.log en conteos por proveedor — la foto. Esto es
// lo otro: el stream de eventos individuales (cada mensaje: a quién, con qué status, qué código),
// que es lo que Instantly/Postmark muestran como "activity feed". La fuente es la misma —
// /var/log/mail.log— pero acá NO se agrega: se emite el evento crudo normalizado, en orden.
//
// Es la capa "normalize" de la espina event-driven. Tres consumidores viven encima del mismo
// contrato: el feed en vivo (esta pantalla), los rollups (la medición ya existe), y las alertas.
//
// PASIVO: solo lee. NO envía nada. Pull por ahora (SSH por request); el push por SSE/WS sobre el
// stream que ya existe (/v1/canvas/live) es el slice siguiente.
//
// Regla del proyecto respetada: un dato que el log no trae sale `null`, nunca inventado. El
// timestamp del mail.log NO tiene año — no se fabrica uno; se preserva el string crudo del log y
// el orden lo da el propio log (append-only, cronológico).

/** Un evento de envío individual, normalizado. El contrato que comparten feed, rollups y alertas. */
export interface SenderActivityEvent {
  /** Timestamp crudo del mail.log ("Jul 30 14:23:01"). Sin año — el log no lo trae; no se inventa. */
  at: string;
  /** Queue-id de Postfix (ej "4Abc12"). `null` si la línea no lo trae. */
  queueId: string | null;
  /** Destinatario completo. */
  recipient: string;
  /** Dominio del receptor, en minúscula (gmail.com, yahoo.com…). El eje de agrupación. */
  provider: string;
  status: "sent" | "bounced" | "deferred";
  /** Código SMTP del receptor (ej "250", "550", "452"). `null` si no aparece. */
  code: string | null;
  /** Código DSN (ej "2.0.0", "5.7.1", "4.2.2"). `null` si no aparece. */
  dsn: string | null;
  /** Relay al que se entregó/intentó. `null` si no aparece. */
  relay: string | null;
}

/** Cuántos eventos recientes trae el feed por request. Tope duro: un feed no descarga el log entero. */
export const ACTIVITY_DEFAULT_LIMIT = 100;
export const ACTIVITY_MAX_LIMIT = 500;

export function resolveActivityLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(n) || n <= 0) return ACTIVITY_DEFAULT_LIMIT;
  return Math.min(n, ACTIVITY_MAX_LIMIT);
}

/**
 * Comando SSH que emite las últimas N líneas de entrega del mail.log ACTUAL (no el rotado: el feed
 * es "lo que está pasando", no la historia). Mismo patrón de sudo/lectura que delivery-health: si
 * no se puede leer, dice `## NOACCESS`, nunca vacío-que-parezca-silencio.
 */
export function buildActivityCommand(limit: number): string {
  const n = Math.min(Math.max(1, Math.trunc(limit)), ACTIVITY_MAX_LIMIT);
  return [
    "set -u",
    'if sudo -n test -r /var/log/mail.log 2>/dev/null; then READ="sudo -n cat";' +
      ' elif test -r /var/log/mail.log; then READ="cat";' +
      ' else echo "## NOACCESS"; READ=""; fi',
    "echo '## EVENTS'",
    // Solo el mail.log actual (sin *), solo líneas de entrega, las últimas N en orden cronológico.
    `[ -n "$READ" ] && $READ /var/log/mail.log 2>/dev/null | grep -E "status=(sent|bounced|deferred)" | tail -n ${n} || true`,
    "echo '## END'"
  ].join("\n");
}

// El queue-id de Postfix NO es solo hex: los ids largos (default en Postfix moderno) usan
// [0-9A-Za-z] (ej "6Ghi56", "4Wxy1z2Ab"). Restringirlo a hex descartaba líneas reales enteras.
const LINE = /^(?<at>[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+\S+\s+postfix\/\S+\[\d+\]:\s+(?<qid>[0-9A-Za-z]+):\s+(?<rest>.*)$/;
const TO = /to=<([^>]*)>/;
const RELAY = /relay=([^,\s]+)/;
const DSN = /dsn=(\d\.\d+\.\d+)/;
const STATUS = /status=(sent|bounced|deferred)/;
// El código SMTP del receptor: en un rebote/diferido va tras "said:" ("... said: 550 5.7.1 ...")
// y el patrón fiable es el de 3 dígitos que precede al DSN enhanced (CODE D.S.N). Pero un `sent` de
// un server sin enhanced-codes es solo "(250 OK)" — ahí el código va pegado al paréntesis. Se
// prueban ambos, enhanced primero (no confunde un número del cuerpo con el código).
const SMTP_CODE_ENHANCED = /\b(\d{3})\s+\d\.\d+\.\d+/;
const SMTP_CODE_PAREN = /\((\d{3})[\s)]/;

export interface ParseActivityResult {
  events: SenderActivityEvent[];
  /** true si el nodo no dejó leer el log (## NOACCESS): la pantalla lo dice, no muestra "sin actividad". */
  noAccess: boolean;
  /** true si la salida se cortó antes de ## END: una lectura parcial NO se sirve como completa. */
  truncated: boolean;
}

/**
 * Parser puro: del stdout del comando a eventos normalizados. Sin I/O, 100% testeable.
 *
 * Las sentinelas (## NOACCESS / ## EVENTS / ## END) se matchean por LÍNEA EXACTA, no por substring:
 * el texto de respuesta del receptor (dentro del paréntesis de la línea de entrega) es del MTA
 * remoto y podría contener "## END" o "## NOACCESS" — buscarlo como substring dejaba que el log
 * ajeno tumbara el feed o lo truncara. Y si falta ## END, la salida se cortó: se declara
 * `truncated`, nunca se sirve lo parcial como completo (igual que smtp-delivery-health).
 *
 * Una línea de entrega que no matchea el formato se SALTA (no se inventa un evento a medias); el
 * orden del log se preserva (append-only, cronológico).
 */
export function parseSenderActivity(stdout: string): ParseActivityResult {
  const lines = stdout.split("\n").map((l) => l.replace(/\s+$/, ""));
  if (lines.some((l) => l.trim() === "## NOACCESS")) {
    return { events: [], noAccess: true, truncated: false };
  }
  const endIdx = lines.findIndex((l) => l.trim() === "## END");
  if (endIdx === -1) {
    // Sin la sentinela de cierre, el comando no terminó de escribir: lectura incompleta.
    return { events: [], noAccess: false, truncated: true };
  }
  const eventsIdx = lines.findIndex((l) => l.trim() === "## EVENTS");
  const region = lines.slice(eventsIdx === -1 ? 0 : eventsIdx + 1, endIdx);

  const events: SenderActivityEvent[] = [];
  for (const rawLine of region) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (!m?.groups) continue;
    const rest = m.groups.rest ?? "";
    const to = TO.exec(rest)?.[1];
    const status = STATUS.exec(rest)?.[1] as SenderActivityEvent["status"] | undefined;
    // Sin destinatario o sin status la línea no es un evento de entrega utilizable: se salta.
    if (!to || !status) continue;
    const atIndex = to.lastIndexOf("@");
    const provider = atIndex >= 0 ? to.slice(atIndex + 1).toLowerCase() : "";
    if (!provider) continue;

    events.push({
      at: m.groups.at ?? "",
      queueId: m.groups.qid ?? null,
      recipient: to,
      provider,
      status,
      code: SMTP_CODE_ENHANCED.exec(rest)?.[1] ?? SMTP_CODE_PAREN.exec(rest)?.[1] ?? null,
      dsn: DSN.exec(rest)?.[1] ?? null,
      relay: RELAY.exec(rest)?.[1] ?? null
    });
  }
  return { events, noAccess: false, truncated: false };
}
