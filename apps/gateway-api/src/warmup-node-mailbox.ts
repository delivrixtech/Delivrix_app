// Lee las RESPUESTAS que llegaron a nuestro nodo — el otro extremo de la conversación.
//
// Por qué existe: el hilo se veía a medias. Del lado de la semilla (IMAP) se ve lo que nosotros
// mandamos; pero lo que la semilla CONTESTA vuelve a `mailer@<dominio>` y entra al nodo. Verificado
// en el mail.log real:
//
//   to=<root@smtp.corpfiling-infra.com>, orig_to=<mailer@corpfiling-infra.com>,
//   relay=local, status=sent (delivered to mailbox)
//
// O sea: la respuesta LLEGA y se queda en el buzón local del nodo. Como los puertos IMAP están
// cerrados (143/993) nadie la leía, y la conversación moría ahí sin que se notara.
//
// La lectura va por SSH sobre el mbox, que es infraestructura que YA tenemos en los 58 nodos. No
// hace falta montar Dovecot ni abrir puertos para VER la respuesta — eso recién haría falta si el
// nodo tuviera que contestar por sí mismo.

/** Una respuesta que llegó al nodo. */
export interface RespuestaEnNodo {
  de: string;
  asunto: string;
  fecha: string;
  texto: string | null;
}

/** Dónde entrega Postfix el correo local. `mailer@` cae a root por alias. */
export const MBOX_NODO = "/var/mail/root";

/**
 * Comando de lectura. Sentinelas ancladas y tope de bytes, como el resto de las sondas: una salida
 * truncada se DECLARA en vez de servirse como completa.
 */
export function buildLeerBuzonCommand(maxBytes = 200_000): string {
  return [
    "set -u",
    `if [ ! -r ${MBOX_NODO} ]; then sudo -n test -r ${MBOX_NODO} 2>/dev/null || { echo "## NOACCESS"; echo "## END"; exit 0; }; fi`,
    'echo "## MBOX"',
    `(sudo -n tail -c ${maxBytes} ${MBOX_NODO} 2>/dev/null || tail -c ${maxBytes} ${MBOX_NODO} 2>/dev/null) || true`,
    'echo ""',
    'echo "## END"'
  ].join("\n");
}

/**
 * Decodifica encoded-words de MIME (`=?UTF-8?Q?...?=` y `?B?` base64), que es como viajan los
 * asuntos con acentos. Sin esto el operador lee `=?UTF-8?Q?Re=3A_Cambio...` en vez del asunto.
 */
export function decodificarAsunto(valor: string): string {
  return valor.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, charset: string, tipo: string, dato: string) => {
    try {
      if (tipo.toUpperCase() === "B") {
        return Buffer.from(dato, "base64").toString("utf8");
      }
      // Quoted-printable de encoded-word: `_` es espacio y `=XX` son bytes.
      const bytes: number[] = [];
      const crudo = dato.replace(/_/g, " ");
      for (let i = 0; i < crudo.length; i += 1) {
        const c = crudo[i]!;
        const hex = c === "=" ? crudo.slice(i + 1, i + 3) : null;
        if (hex && /^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(Number.parseInt(hex, 16));
          i += 2;
        } else {
          for (const b of Buffer.from(c, "utf8")) bytes.push(b);
        }
      }
      return Buffer.from(bytes).toString((charset.toLowerCase().includes("utf") ? "utf8" : "latin1") as BufferEncoding);
    } catch {
      return dato;
    }
  });
}

function decodificarCuerpo(lineas: string[], encoding: string): string | null {
  const crudo = lineas.join("\n");
  if (!crudo.trim()) return null;
  if (encoding.toLowerCase().includes("base64")) {
    try {
      return Buffer.from(crudo.replace(/\s/g, ""), "base64").toString("utf8").trim();
    } catch {
      return crudo.trim();
    }
  }
  if (encoding.toLowerCase().includes("quoted-printable")) {
    const sinCortes = crudo.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < sinCortes.length; i += 1) {
      const c = sinCortes[i]!;
      const hex = c === "=" ? sinCortes.slice(i + 1, i + 3) : null;
      if (hex && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
      } else {
        for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString("utf8").trim();
  }
  return crudo.trim();
}

export interface BuzonNodo {
  respuestas: RespuestaEnNodo[];
  /** Cuántas respuestas hay en el buzón que NO son de este hilo. Se declara, no se esconde. */
  deOtrosHilos?: number;
  /** Por qué no hay nada, o qué faltó. `null` cuando salió todo bien. */
  motivo: string | null;
}

/**
 * Parsea el mbox. Formato: cada mensaje arranca con una línea `From ` (sin dos puntos) al principio
 * de línea. Se corta ahí, se separan headers de cuerpo por la primera línea vacía, y se toma solo
 * la primera parte del cuerpo (los correos de warmup son texto plano).
 */
/**
 * Filtra las respuestas de UN hilo.
 *
 * Cada envío lleva en el asunto un marcador `[xxxxxx]` (los últimos 6 del testId), y la respuesta
 * arrastra ese asunto con "Re:" adelante. Sin este filtro, la pantalla mostraba la última respuesta
 * del buzón junto a CUALQUIER ciclo — se veía el correo de un hilo con la respuesta de otro, que es
 * peor que no mostrar nada: sugiere una conversación que no ocurrió.
 */
export function respuestasDelHilo(buzon: BuzonNodo, testId: string, semilla?: string): BuzonNodo {
  const marca = testId.slice(-6);
  if (!marca) return { respuestas: [], deOtrosHilos: buzon.respuestas.length, motivo: "sin marca de hilo" };
  // Además de la marca, se exige que venga DE LA SEMILLA. La marca no es pública pero sí
  // predecible (son los últimos dígitos del epoch en ms: ~10⁴ combinaciones), así que cualquiera
  // que le escriba al 25 de nuestro nodo con ese asunto se mostraba en el panel como "la respuesta
  // de la semilla", con el From que quisiera. El daño es solo de pantalla —la conversación
  // multivuelta lee el hilo por IMAP del buzón semilla, no de acá— pero es la pantalla donde el
  // operador verifica que el calentamiento es real, y ahí una mentira vale doble.
  const deLaSemilla = (r: RespuestaEnNodo): boolean =>
    !semilla || r.de.toLowerCase().includes(semilla.toLowerCase());
  const propias = buzon.respuestas.filter((r) => r.asunto.includes(`[${marca}]`) && deLaSemilla(r));
  const otras = buzon.respuestas.length - propias.length;
  return {
    respuestas: propias,
    deOtrosHilos: otras,
    motivo:
      propias.length > 0
        ? null
        : otras > 0
          ? `todavía no volvió la respuesta de este hilo (hay ${otras} de otras vueltas en el buzón)`
          : (buzon.motivo ?? "el buzón del nodo está vacío: todavía no volvió ninguna respuesta")
  };
}

export function parsearBuzon(stdout: string): BuzonNodo {
  const lineas = stdout.split("\n");
  if (!lineas.some((l) => l.trim() === "## END")) {
    return { respuestas: [], motivo: "salida truncada: falta ## END" };
  }
  if (lineas.some((l) => l.trim() === "## NOACCESS")) {
    return { respuestas: [], motivo: "sin permiso para leer el buzón del nodo" };
  }
  const inicio = lineas.findIndex((l) => l.trim() === "## MBOX");
  if (inicio === -1) return { respuestas: [], motivo: "el nodo no devolvió el buzón" };

  const cuerpo = lineas.slice(inicio + 1, lineas.findIndex((l) => l.trim() === "## END"));

  // Cortar en mensajes por la línea "From " de mbox.
  const bloques: string[][] = [];
  let actual: string[] | null = null;
  for (const l of cuerpo) {
    if (/^From \S+/.test(l)) {
      if (actual) bloques.push(actual);
      actual = [];
      continue;
    }
    if (actual) actual.push(l);
  }
  if (actual && actual.length > 0) bloques.push(actual);

  const respuestas: RespuestaEnNodo[] = [];
  for (const bloque of bloques) {
    const corte = bloque.findIndex((l) => l.trim() === "");
    const headers = corte === -1 ? bloque : bloque.slice(0, corte);
    const texto = corte === -1 ? [] : bloque.slice(corte + 1);

    // Los headers pueden venir plegados (continúan con espacio al inicio): se despliegan.
    const desplegados: string[] = [];
    for (const h of headers) {
      if (/^[ \t]/.test(h) && desplegados.length > 0) desplegados[desplegados.length - 1] += h.trim();
      else desplegados.push(h);
    }
    const buscar = (nombre: string): string =>
      desplegados.find((h) => h.toLowerCase().startsWith(`${nombre}:`))?.slice(nombre.length + 1).trim() ?? "";

    const de = buscar("from");
    if (!de) continue;
    // El multipart se corta en el primer boundary: alcanza con la parte de texto.
    const hastaBoundary = texto.slice(0, texto.findIndex((l) => l.startsWith("--")) === -1 ? texto.length : texto.findIndex((l) => l.startsWith("--")));
    respuestas.push({
      de: decodificarAsunto(de),
      asunto: decodificarAsunto(buscar("subject")) || "(sin asunto)",
      fecha: buscar("date"),
      texto: decodificarCuerpo(hastaBoundary, buscar("content-transfer-encoding"))
    });
  }

  return {
    respuestas: respuestas.reverse(), // más nueva primero
    motivo: respuestas.length === 0 ? "el buzón del nodo está vacío: todavía no volvió ninguna respuesta" : null
  };
}
