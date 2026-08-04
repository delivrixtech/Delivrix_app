// LAS MANOS DEL AGENTE — lo único que puede HACER por sí solo.
//
// Hasta acá el agente miraba y opinaba: decía "RIESGO: bizreport-control.com cruzó el umbral" y
// ahí terminaba. Alguien tenía que leerlo y actuar. Eso no es un agente, es un termómetro caro.
//
// EL LÍMITE, y es duro: el agente solo puede ejecutar acciones que REDUCEN. Frenar, pausar,
// anotar. Nunca subir volumen, nunca mandar correo, nunca gastar plata, nunca aprovisionar. La
// razón no es desconfianza en el modelo: es que las acciones reductoras son reversibles y su peor
// caso es "calentamos de menos un rato", mientras que las expansivas tienen un peor caso
// irreversible (cruzar el umbral permanente de Google se pierde una sola vez).
//
// Por eso el catálogo NO es una lista de tools que el modelo elige libremente sobre parámetros
// libres. Cada acción:
//   1. está en una lista blanca cerrada — lo que no está, no existe;
//   2. valida sus parámetros contra el estado real (un dominio que no está en el inventario no se
//      puede tocar);
//   3. es idempotente — repetirla no acumula efecto;
//   4. deja rastro con antes/después, porque una acción automática sin registro es indefendible.
//
// Lo que el agente NO puede resolver solo (agregar una semilla, soltar cupo, comprar un dominio)
// no se queda dando vueltas en cada lectura: se ANOTA como pendiente del operador, una sola vez,
// con su motivo. Repetir "falta una semilla de Yahoo" cada 10 minutos durante una semana no es
// insistencia, es ruido que entrena a ignorar al agente.

export type NombreAccion = "frenar_dominio" | "pausar_warmup" | "anotar_pendiente" | "resolver_pendiente";

/** Lo que el agente pidió hacer. Sale del modelo, así que se trata como entrada no confiable. */
export interface AccionPedida {
  accion: string;
  dominio?: string;
  motivo?: string;
  id?: string;
}

export interface ResultadoAccion {
  accion: string;
  ejecutada: boolean;
  /** Qué pasó, en castellano. Va al registro y a la pantalla. */
  detalle: string;
  antes?: unknown;
  despues?: unknown;
}

/** Un pendiente que el agente no puede resolver solo. */
export interface Pendiente {
  id: string;
  que: string;
  porque: string;
  abiertoEn: string;
  /** Cuántas veces el agente lo volvió a detectar. No genera un pendiente nuevo: suma acá. */
  visto: number;
  resueltoEn?: string;
}

/**
 * El contexto que las acciones necesitan. Se inyecta ⇒ se testea sin tocar nada real, y el daemon
 * o la ruta deciden qué capacidades le dan al agente en cada entorno.
 */
export interface ContextoAcciones {
  /** Dominios que existen de verdad. Una acción sobre algo fuera de esta lista se rechaza. */
  dominiosConocidos: readonly string[];
  /** Pone cap 0 en el nodo del dominio. Reversible con un `--apply` normal. */
  frenarDominio?: (dominio: string, motivo: string) => Promise<{ antes: number | null; despues: number }>;
  /** Crea el kill-file: el daemon deja de mandar en la próxima vuelta. Reversible con `rm`. */
  pausarWarmup?: (motivo: string) => Promise<void>;
  /** ¿Ya está pausado? Para no reportar como acción algo que ya estaba hecho. */
  warmupPausado?: () => Promise<boolean>;
  pendientes: {
    listar: () => Promise<Pendiente[]>;
    guardar: (p: Pendiente[]) => Promise<void>;
  };
  ahora?: () => Date;
}

/** Palabras que no distinguen un pendiente de otro. */
const VACIAS = new Set(["y", "o", "de", "del", "la", "el", "los", "las", "en", "para", "un", "una", "semilla", "semillas"]);

/** Quita acentos, puntuación y palabras vacías; deja el conjunto de términos que sí distinguen. */
function terminos(texto: string): Set<string> {
  return new Set(
    texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9.]+/)
      .filter((t) => t.length > 1 && !VACIAS.has(t))
  );
}

/**
 * ¿Son el mismo pendiente aunque estén escritos distinto?
 *
 * Comparar texto exacto no alcanza, y se vio en producción a los diez minutos: el agente anotó
 * "outlook y yahoo", "semillas para outlook y yahoo" y "outlook,yahoo" como TRES pendientes. Es la
 * misma cosa dicha de tres formas — el modelo reformula, es lo que hacen los modelos. Con dedup
 * exacto, la promesa de "anotalo una sola vez" se rompe el primer día.
 *
 * Se comparan los términos que distinguen (sin acentos, sin puntuación, sin palabras vacías): si
 * uno está contenido en el otro, o comparten la mayoría, es el mismo pendiente.
 */
export function mismoPendiente(a: string, b: string): boolean {
  const A = terminos(a);
  const B = terminos(b);
  if (A.size === 0 || B.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const comunes = [...A].filter((t) => B.has(t)).length;
  // Contenido, pero NO trivial. Con `min(A,B) === 1` bastaba UN término compartido para fundir
  // pendientes distintos: "semilla de yahoo" y "cupo de yahoo" comparten {yahoo} y se hubieran
  // tomado por el mismo. Con dos términos mínimos, el contenido es señal; con uno, se pasa a
  // Jaccard, que exige mayoría.
  if (Math.min(A.size, B.size) >= 2 && comunes === Math.min(A.size, B.size)) return true;
  // O mayoría compartida, para reformulaciones que agregan y quitan a la vez.
  return comunes / new Set([...A, ...B]).size >= 0.5;
}

/** Máximo de acciones por lectura. Un agente que hace veinte cosas de golpe no se puede auditar. */
export const MAX_ACCIONES_POR_VUELTA = 3;

/**
 * Ejecuta lo que el agente pidió, filtrando todo lo que no esté explícitamente permitido.
 *
 * Todo lo que llega acá viene del modelo, así que se valida como entrada hostil: nombre de acción
 * contra lista blanca, dominio contra el inventario real, motivo obligatorio. Lo rechazado se
 * devuelve con su razón — no se ignora en silencio, porque un agente que "no hizo nada" sin
 * explicación es indistinguible de uno roto.
 */
export async function ejecutarAcciones(
  pedidas: readonly AccionPedida[],
  ctx: ContextoAcciones
): Promise<ResultadoAccion[]> {
  const ahora = (ctx.ahora ?? (() => new Date()))();
  const out: ResultadoAccion[] = [];

  for (const p of pedidas.slice(0, MAX_ACCIONES_POR_VUELTA)) {
    const nombre = (p.accion ?? "").trim();
    const motivo = (p.motivo ?? "").trim();

    if (!motivo) {
      out.push({ accion: nombre, ejecutada: false, detalle: "rechazada: toda acción exige un motivo" });
      continue;
    }

    switch (nombre) {
      case "frenar_dominio": {
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        // El dominio tiene que EXISTIR. Sin esto, un nombre alucinado por el modelo se convertiría
        // en una llamada SSH contra vaya a saber qué.
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, ejecutada: false, detalle: `rechazada: "${p.dominio}" no está en el inventario` });
          break;
        }
        if (!ctx.frenarDominio) {
          out.push({ accion: nombre, ejecutada: false, detalle: "rechazada: frenar no está habilitado en este entorno" });
          break;
        }
        const r = await ctx.frenarDominio(dominio, motivo);
        if (r.antes === 0) {
          // Ya estaba frenado: reportarlo como acción NUEVA hace creer que pasó algo que no pasó,
          // y en el registro queda un "frené X" por vuelta sobre un nodo que no cambió nunca.
          out.push({ accion: nombre, ejecutada: false, detalle: `${dominio} ya estaba en cap 0: no hacía falta` });
          break;
        }
        out.push({
          accion: nombre,
          ejecutada: true,
          detalle: `${dominio} frenado (cap ${r.antes ?? "?"} → ${r.despues}) — ${motivo}`,
          antes: r.antes,
          despues: r.despues
        });
        break;
      }

      case "pausar_warmup": {
        if (!ctx.pausarWarmup) {
          out.push({ accion: nombre, ejecutada: false, detalle: "rechazada: pausar no está habilitado en este entorno" });
          break;
        }
        // Idempotente: si ya estaba pausado no se reporta como una acción nueva. Un registro que
        // dice "pausé el warmup" tres veces seguidas hace creer que pasó algo tres veces.
        if (await ctx.warmupPausado?.()) {
          out.push({ accion: nombre, ejecutada: false, detalle: "el warmup ya estaba pausado: no hacía falta" });
          break;
        }
        await ctx.pausarWarmup(motivo);
        out.push({ accion: nombre, ejecutada: true, detalle: `warmup pausado — ${motivo}` });
        break;
      }

      case "anotar_pendiente": {
        const que = (p.dominio ?? "").trim() || motivo;
        const lista = await ctx.pendientes.listar();
        // Mismo pendiente ⇒ se suma al contador, NO se crea otro. Sin esto, "falta una semilla de
        // Yahoo" generaría un pendiente nuevo cada 10 minutos y la lista sería inservible en un día.
        const previo = lista.find((x) => !x.resueltoEn && mismoPendiente(x.que, que));
        if (previo) {
          previo.visto += 1;
          // Copia, nunca el mismo array que devolvió `listar`. Si el almacén hace
          // `lista.length = 0; push(...p)` y `p === lista`, vacía todo antes de guardar. Es un
          // aliasing fácil de escribir sin darse cuenta, y el resultado sería perder la lista
          // entera de pendientes en silencio.
          await ctx.pendientes.guardar([...lista]);
          out.push({ accion: nombre, ejecutada: false, detalle: `ya estaba anotado (visto ${previo.visto} veces): ${que}` });
          break;
        }
        const nuevo: Pendiente = {
          id: `p-${lista.length + 1}-${que.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
          que,
          porque: motivo,
          abiertoEn: ahora.toISOString(),
          visto: 1
        };
        await ctx.pendientes.guardar([...lista, nuevo]);
        out.push({ accion: nombre, ejecutada: true, detalle: `pendiente anotado: ${que}`, despues: nuevo.id });
        break;
      }

      case "resolver_pendiente": {
        const id = (p.id ?? "").trim();
        const lista = await ctx.pendientes.listar();
        const item = lista.find((x) => x.id === id && !x.resueltoEn);
        if (!item) {
          out.push({ accion: nombre, ejecutada: false, detalle: `rechazada: no hay pendiente abierto con id "${id}"` });
          break;
        }
        item.resueltoEn = ahora.toISOString();
        await ctx.pendientes.guardar([...lista]);
        out.push({ accion: nombre, ejecutada: true, detalle: `pendiente resuelto: ${item.que} — ${motivo}` });
        break;
      }

      default:
        // Lista blanca cerrada: lo que no está, no existe. Y se DICE, para que se vea si el modelo
        // está pidiendo cosas que no puede hacer (señal de que el prompt necesita trabajo).
        out.push({ accion: nombre, ejecutada: false, detalle: `rechazada: "${nombre}" no es una acción permitida` });
    }
  }

  if (pedidas.length > MAX_ACCIONES_POR_VUELTA) {
    out.push({
      accion: "(tope)",
      ejecutada: false,
      detalle: `se ignoraron ${pedidas.length - MAX_ACCIONES_POR_VUELTA} acciones: el tope es ${MAX_ACCIONES_POR_VUELTA} por lectura`
    });
  }
  return out;
}

/**
 * Extrae las acciones del texto del modelo.
 *
 * Formato: una línea `ACCION: nombre | dominio=... | motivo=...`. Se eligió una línea de texto y
 * no JSON porque este modelo razona en prosa y devolver JSON válido le sale peor; una línea con
 * separadores la acierta siempre. Lo que no matchea se ignora — no se intenta adivinar qué quiso
 * decir, porque adivinar sobre una acción que toca producción es exactamente lo que no queremos.
 */
export function extraerAcciones(texto: string): AccionPedida[] {
  const out: AccionPedida[] = [];
  for (const linea of texto.split("\n")) {
    // Los dos puntos son OBLIGATORIOS y tiene que haber algo después. Sin exigirlo, la línea
    // "ACCION:" pelada capturaba los propios dos puntos como nombre de acción.
    const m = linea.match(/^\s*ACCION\s*:\s*(\S.*)$/i);
    if (!m) continue;
    const partes = m[1]!.split("|").map((s) => s.trim());
    const accion = partes[0]?.toLowerCase().replace(/\s+/g, "_") ?? "";
    if (!accion) continue;
    const campo = (nombre: string): string | undefined =>
      partes.slice(1).find((p) => p.toLowerCase().startsWith(`${nombre}=`))?.slice(nombre.length + 1).trim();
    out.push({ accion, dominio: campo("dominio"), motivo: campo("motivo"), id: campo("id") });
  }
  return out;
}
