// Agrupar las bandejas cerradas por QUIÉN las cierra.
//
// Existe porque "35 nodos bloqueados" sugiere una causa y una solución, y son varios problemas con
// arreglos distintos: Yahoo bloquea la IP y tiene formulario de delisting, Google castiga la
// reputación del DOMINIO y no hay trámite —solo tiempo y warmup—, Apple rechaza por local policy.
//
// El bug que arregla (medido 2026-08-06): la lista de familias tenía tres entradas y lo que no
// caía en ninguna DESAPARECÍA en silencio. De 35 bandejas cerradas, infranationalreport.com
// ("cerrada en hotmail.com, outlook.com, live.com, msn.com") no entraba en ningún grupo: los
// grupos sumaban 34 bajo un encabezado que decía 35. Justo Microsoft, que la tarjeta de semillas
// de la misma pantalla declara punto ciego.
//
// Ahora: Microsoft es una familia más, y lo que no reconoce ninguna cae en "otros receptores",
// visible y contado. La suma de los grupos SIEMPRE es el total.
//
// El corte se sigue haciendo por substring sobre el texto del `detail` porque es lo único que el
// endpoint manda: `cerradoEn` es un array de familias en sender-measurement.ts pero /v1/sender-
// pool/alerts solo publica {domain, severity, kind, detail}. Cuando el payload lo traiga, esta
// función pasa a leer el array y deja de adivinar.

export interface AlertaCerrada {
  domain: string;
  detail: string;
}

export interface GrupoReceptor {
  nombre: string;
  accion: string;
  recuperable: boolean;
  afectados: string[];
}

const FAMILIAS: Array<{ nombre: string; dominios: string[]; accion: string; recuperable: boolean }> = [
  {
    nombre: "Yahoo (yahoo · aol · bellsouth · att)",
    dominios: ["yahoo.com", "aol.com", "bellsouth.net", "att.net", "sbcglobal.net", "ymail.com"],
    accion: "Bloqueo por IP. Reintentar NO sirve — hay formulario de delisting en el postmaster de Yahoo.",
    recuperable: true
  },
  {
    nombre: "Google (gmail)",
    dominios: ["gmail.com", "googlemail.com"],
    accion: "Reputación del DOMINIO, no de la IP ni de la autenticación. No hay trámite: baja el volumen y calentá.",
    recuperable: false
  },
  {
    nombre: "Microsoft (outlook · hotmail · live · msn)",
    dominios: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    accion:
      "Microsoft filtra por reputación de IP y tiene formulario de mitigación en el SNDS/postmaster. OJO: no tenemos semilla que mida acá — es punto ciego.",
    recuperable: true
  },
  {
    nombre: "Apple (icloud · me)",
    dominios: ["icloud.com", "me.com", "mac.com"],
    accion: "Rechazo por local policy. La vía es el soporte de Apple (HT204137).",
    recuperable: false
  }
];

/**
 * Devuelve un grupo por familia con al menos un afectado, más un grupo "otros receptores" con lo
 * que no reconoce ninguna. Invariante: TODA bandeja de entrada aparece en al menos un grupo —
 * ninguna desaparece. (Una cerrada en dos familias aparece en las dos, a propósito: cada familia
 * se arregla distinto y el operador necesita verla en ambas listas.)
 */
export function agruparBloqueos(alertas: AlertaCerrada[]): GrupoReceptor[] {
  const grupos: GrupoReceptor[] = [];
  const reconocidas = new Set<string>();

  for (const familia of FAMILIAS) {
    const afectados = alertas
      .filter((a) => familia.dominios.some((d) => a.detail.includes(d)))
      .map((a) => a.domain);
    for (const d of afectados) reconocidas.add(d);
    if (afectados.length > 0) {
      grupos.push({
        nombre: familia.nombre,
        accion: familia.accion,
        recuperable: familia.recuperable,
        afectados
      });
    }
  }

  const sinFamilia = alertas.filter((a) => !reconocidas.has(a.domain)).map((a) => a.domain);
  if (sinFamilia.length > 0) {
    grupos.push({
      nombre: "Otros receptores",
      accion:
        "El receptor que cierra no cae en ninguna familia conocida. Abrí el detalle de la alerta para ver quién es antes de decidir el arreglo.",
      recuperable: false,
      afectados: sinFamilia
    });
  }

  return grupos;
}
