// Resuelve las carpetas del buzón por su FLAG, no por su nombre.
//
// El bug que motivó esto: la semilla `trazosvercel@gmail.com` tiene la cuenta en español, así que
// su carpeta de enviados se llama `[Gmail]/Enviados` — no `[Gmail]/Sent Mail`. La lista de nombres
// fijos no la encontraba, la apertura fallaba con "Command failed", y el hilo se leía SIEMPRE a
// medias: nunca aparecía la respuesta de la semilla aunque estuviera ahí. El daemon concluía "el
// último mensaje es nuestro, estamos esperando" y la conversación no avanzaba nunca.
//
// Agregar "Enviados" a la lista habría tapado este caso y dejado el siguiente (francés, alemán,
// portugués…). La raíz es que el nombre de la carpeta es texto de presentación y no un
// identificador. IMAP tiene el identificador: el atributo SPECIAL-USE (RFC 6154) — `\Sent`,
// `\Junk`, `\Trash` — que es el mismo en cualquier idioma. Verificado en la cuenta real:
//
//   \Sent      [Gmail]/Enviados
//   \Junk      [Gmail]/Spam
//
// Y esto importa más allá del hilo: la MEDICIÓN de placement busca en la carpeta de spam. Con un
// nombre que no abre, "no está en spam" y "no pude mirar en spam" se ven igual — y eso es
// fail-open sobre el dato que gatea toda la rampa.

/** Lo mínimo para preguntar por las carpetas. Inyectable ⇒ se testea sin red. */
export interface ImapConLista {
  list(): Promise<Array<{ path: string; specialUse?: string }>>;
}

/** Los usos que nos interesan, con los nombres históricos como respaldo. */
export const RESPALDOS: Record<string, string[]> = {
  "\\Sent": ["[Gmail]/Sent Mail", "Sent", "Sent Items", "Enviados", "Elementos enviados"],
  "\\Junk": ["[Gmail]/Spam", "Junk", "Junk Email", "Spam", "Bulk Mail", "Correo no deseado"],
  "\\Inbox": ["INBOX"]
};

/**
 * La carpeta que corresponde a un uso. `null` si el servidor no la declara y ningún respaldo
 * existe — null con motivo, nunca un nombre inventado que después falle al abrirse.
 *
 * `carpetas` es la salida de `LIST`: se pide UNA vez y se reusa.
 */
export function carpetaPorUso(
  carpetas: ReadonlyArray<{ path: string; specialUse?: string }>,
  uso: string
): string | null {
  const porFlag = carpetas.find((c) => (c.specialUse ?? "").toLowerCase() === uso.toLowerCase());
  if (porFlag) return porFlag.path;

  // Respaldo para servidores que no publican SPECIAL-USE. Se compara contra las carpetas que el
  // servidor DIJO tener: proponer un nombre que no está en la lista solo mueve el fallo más tarde.
  const existentes = new Set(carpetas.map((c) => c.path.toLowerCase()));
  for (const nombre of RESPALDOS[uso] ?? []) {
    const real = carpetas.find((c) => c.path.toLowerCase() === nombre.toLowerCase());
    if (real && existentes.has(nombre.toLowerCase())) return real.path;
  }
  return null;
}

/** Las tres carpetas que usa el warmup, resueltas de una sola pasada. */
export interface CarpetasDelBuzon {
  entrada: string;
  spam: string | null;
  enviados: string | null;
  /** Qué no se pudo resolver. Vacío = todo bien. Se DECLARA, no se asume. */
  faltantes: string[];
}

export async function resolverCarpetas(cliente: ImapConLista): Promise<CarpetasDelBuzon> {
  const carpetas = await cliente.list();
  const spam = carpetaPorUso(carpetas, "\\Junk");
  const enviados = carpetaPorUso(carpetas, "\\Sent");
  const faltantes: string[] = [];
  if (!spam) faltantes.push("spam");
  if (!enviados) faltantes.push("enviados");
  return {
    // INBOX es el único nombre que el estándar fija: no depende del idioma.
    entrada: carpetaPorUso(carpetas, "\\Inbox") ?? "INBOX",
    spam,
    enviados,
    faltantes
  };
}
