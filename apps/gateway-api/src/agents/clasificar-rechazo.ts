// CLASIFICA UN RECHAZO SMTP: ¿nos frenamos nosotros, o nos frenó el receptor?
//
// Existe por un error concreto del agente, el 2026-08-04. Leyó esto en los hechos:
//
//   "450 4.7.1 <trazosvercel@gmail.com>: Recipient address rejected: daily send cap reached
//    on this node"
//
// y escribió: *"Está bloqueado por los límites diarios de Gmail"*, y de ahí concluyó *"hay que
// esperar a que se reseteen los caps diarios"*. Las dos cosas falsas: ese 450 lo emite NUESTRO
// policy service de Postfix, no Gmail, y no se resetea en nada útil porque el nodo está en cap 0
// por decisión del operador.
//
// El modelo no alucinó: el texto crudo dice "daily send cap" y menciona una dirección de Gmail, y
// sin más contexto esa lectura es razonable. El defecto era de los HECHOS, no del modelo — se le
// pasaba una cadena cruda esperando que dedujera de quién es el freno. Ahora se le da clasificado.
//
// La distinción no es cosmética: cambia la acción. Freno propio ⇒ lo soltamos nosotros cuando
// queramos. Rechazo del receptor ⇒ es reputación y no hay trámite, solo tiempo y buen tráfico.

export type OrigenRechazo = "freno_propio" | "receptor" | "infra" | "desconocido";

export interface RechazoClasificado {
  origen: OrigenRechazo;
  /** Una frase que el agente puede usar tal cual, ya desambiguada. */
  explicacion: string;
  /** El código SMTP, si se pudo leer. */
  codigo: string | null;
}

/** Nuestro policy service responde exactamente esto cuando el nodo agotó (o tiene en 0) su cupo. */
const MARCA_FRENO_PROPIO = /daily send cap reached on this node/i;

/** Rechazos de política del receptor: reputación, no dirección inválida. */
const MARCAS_RECEPTOR: Array<{ re: RegExp; que: string }> = [
  { re: /\b5\.7\.1\b/, que: "el receptor rechaza por política/reputación" },
  { re: /unsolicited mail|bulk mail|spam/i, que: "el receptor nos marca como correo no solicitado" },
  { re: /\b5\.1\.1\b/, que: "la dirección de destino no existe" },
  { re: /\b4\.2\.2\b|mailbox full|over quota/i, que: "el buzón de destino está lleno" },
  { re: /blocked using|blacklist|dnsbl|spamhaus/i, que: "la IP figura en una lista de bloqueo del receptor" },
  { re: /local policy/i, que: "el receptor rechaza por su política local" }
];

const MARCAS_INFRA: Array<{ re: RegExp; que: string }> = [
  { re: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i, que: "el nodo no respondió (red o servicio caído)" },
  { re: /certificate|TLS|SSL/i, que: "problema de TLS con el nodo" },
  { re: /authentication failed|535/i, que: "credencial SMTP rechazada por el nodo" }
];

function codigoDe(texto: string): string | null {
  return texto.match(/\b([45]\d\d)\s|\b([45]\.\d\.\d)\b/)?.[0]?.trim() ?? null;
}

/**
 * Clasifica el texto de un rechazo. Nunca adivina: lo que no matchea sale como `desconocido` con
 * el texto recortado, para que el agente pueda decir "no sé de quién es este freno" en vez de
 * inventar un culpable — que es exactamente el error que motivó este módulo.
 */
export function clasificarRechazo(texto: string | null | undefined): RechazoClasificado | null {
  const t = (texto ?? "").trim();
  if (!t) return null;
  const codigo = codigoDe(t);

  // El freno propio se chequea PRIMERO y gana: su texto menciona la dirección del destinatario, así
  // que cualquier regla que mire "hay un gmail.com acá" lo atribuiría al receptor. Ese fue el bug.
  if (MARCA_FRENO_PROPIO.test(t)) {
    return {
      origen: "freno_propio",
      explicacion:
        "es NUESTRO límite de Postfix (el cap diario que instalamos en el nodo), no un rechazo del receptor: lo soltamos nosotros cuando queramos",
      codigo
    };
  }
  for (const m of MARCAS_RECEPTOR) {
    if (m.re.test(t)) return { origen: "receptor", explicacion: m.que, codigo };
  }
  for (const m of MARCAS_INFRA) {
    if (m.re.test(t)) return { origen: "infra", explicacion: m.que, codigo };
  }
  return {
    origen: "desconocido",
    explicacion: "no se pudo clasificar de quién es este rechazo",
    codigo
  };
}

/** Agrupa rechazos por origen, con un ejemplo de cada uno. Es lo que se le pasa al agente. */
export function resumirRechazos(textos: Array<string | null | undefined>): Array<{
  origen: OrigenRechazo;
  cuantos: number;
  explicacion: string;
  ejemplo: string;
}> {
  const porOrigen = new Map<OrigenRechazo, { cuantos: number; explicacion: string; ejemplo: string }>();
  for (const t of textos) {
    const c = clasificarRechazo(t);
    if (!c) continue;
    const previo = porOrigen.get(c.origen);
    if (previo) previo.cuantos += 1;
    else porOrigen.set(c.origen, { cuantos: 1, explicacion: c.explicacion, ejemplo: (t ?? "").slice(0, 160) });
  }
  return [...porOrigen.entries()].map(([origen, v]) => ({ origen, ...v })).sort((a, b) => b.cuantos - a.cuantos);
}
