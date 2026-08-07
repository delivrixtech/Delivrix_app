// LOS OJOS DE REPUTACIÓN — la IP, el dominio y su autenticación, MEDIDOS.
//
// El operador lo pidió textual el 2026-08-06: "todo lo que tenga para medir la ip, dominio, smtp
// etc etc con buena reputación y no caiga a blacklist se tiene que hacer sin excusas". Hasta hoy el
// agente era ciego a la mitad de eso: sus `hechos` no tienen una sola clave de blacklist ni de
// SPF/DKIM/DMARC/PTR, y el escaneo diario de MXToolbox NUNCA corrió (`grep -c daily_scan
// gateway.log` = 0) aunque la llave está paga desde junio y el adapter existe. Un instrumento
// comprado y apagado.
//
// CUATRO REGLAS QUE ESTE MÓDULO NO NEGOCIA. Cada una la pagó el proyecto con un incidente:
//
//  1. TRES ESTADOS, y "no sé" es uno de ellos. No existe un cuarto estado implícito donde un
//     chequeo que no se pudo hacer termina leyéndose como un chequeo que pasó. El 2026-07-29 un
//     probe con `head -c` se colgó esperando un banner de 75 bytes, devolvió rc=124, y reportó 10
//     de 10 nodos bloqueados estando los 8 bien. Un chequeo colgado es "no sé", nunca un veredicto.
//
//  2. AUSENCIA DE RESPUESTA ≠ AUSENCIA DE REGISTRO. Un NXDOMAIN sobre `_dmarc.x.com` es un dato
//     ("no publica DMARC"); un SERVFAIL o un timeout NO lo es. Se distinguen por el `code` del
//     error de node:dns, porque colapsarlos fabrica las dos mentiras a la vez: "no publica DMARC"
//     cuando el DNS estaba caído, y "está todo bien" cuando nadie contestó.
//
//  3. LA CUOTA SE GASTA SOLO EN LO QUE NO SE PUEDE HACER GRATIS. SPF, DMARC y PTR salen de
//     node:dns, y DKIM del diagnóstico que ya vive en el repo (`diagnoseDkim`, que además nunca
//     devuelve un "absent" falso). La ÚNICA consulta que cuesta cuota es la de listas negras: UNA
//     por invocación, no cinco. Son 58 nodos — a cinco comandos por nodo la cuota se agota justo
//     el día que hace falta, y el chequeo queda mudo.
//
//  4. ESTE MÓDULO NO CONCLUYE NADA. Devuelve señales sueltas, no un semáforo. Una lista negra
//     limpia NO significa que estás entregando: el 2026-07-25, 38 de 64 nodos estaban cerrados en
//     Gmail con 550-5.7.1 "unsolicited" mientras el chequeo de blacklists decía 0 detecciones. Son
//     dos señales distintas. Quien las junta —y está obligado a juntarlas— es `revisar_reputacion`
//     en acciones-agente.ts, donde la regla de las dos señales está en código y no en convención.
//
// Todo el IO entra inyectado, así que se testea entero sin red y sin disco.

import { diagnoseDkim } from "../openclaw-dkim-diagnostic.ts";
import type { ChequeoReputacion, ReputacionLeida } from "./acciones-agente.ts";

export type { ChequeoReputacion, ReputacionLeida };

/**
 * El plazo que envuelve TODO el chequeo, no cada llamada suelta.
 *
 * Es el número que importa: al agente lo llama un tick cada 10 minutos y un chat donde el jefe
 * espera del otro lado. Un DNS que no contesta no puede comerse ese turno — vence, dice "no sé", y
 * el turno sigue.
 */
export const TIMEOUT_REPUTACION_MS = 15_000;

export interface EntradaReputacion {
  dominio: string;
  /**
   * La IP del nodo. La resuelve el LLAMADOR (con `serverIp` de leerInventarioFabrica), no este
   * módulo: acá adentro no se lee un solo archivo.
   *
   * `null` no es un caso raro — hay dominios con credencial y sin binding — y no se disfraza: sin
   * IP no hay listas negras ni PTR que consultar, y eso sale como "no sé", jamás como "limpio".
   */
  ip: string | null;
  resolveTxt: (fqdn: string) => Promise<string[][]>;
  reverse: (ip: string) => Promise<string[]>;
  resolve4: (host: string) => Promise<string[]>;
  /** La única llamada que cuesta cuota. Se invoca 0 o 1 vez por invocación, nunca más. */
  blacklist: (ip: string) => Promise<{ estado: "clean" | "warning" | "listed" | "error"; listas: string[] }>;
  /**
   * El certificado del propio nodo por el 587 (STARTTLS). Sin cuota y sin terceros: es nuestra
   * máquina. Devuelve el CN/nombre presentado y cuándo vence; `null` = handshake sin certificado.
   *
   * Opcional para no romper a los llamadores existentes, y su ausencia sale como "no sé" — jamás
   * como un cert vigente. filing-ops.com se quedó sin cert y ninguna de las otras cuatro señales
   * lo mostró.
   */
  tls?: (host: string) => Promise<{ vence: string | null; nombre: string | null } | null>;
  timeoutMs?: number;
  now?: () => Date;
}

const VENCIDO = Symbol("vencido");

type Intento<T> =
  | { ok: true; valor: T }
  /** `sinRegistro` = el DNS contestó "acá no hay nada". Es un DATO, no una falta de medición. */
  | { ok: false; motivo: string; sinRegistro: boolean };

type Intentar = <T>(hacer: () => Promise<T>) => Promise<Intento<T>>;

export async function revisarReputacionDe(input: EntradaReputacion): Promise<ReputacionLeida> {
  const ms = input.timeoutMs ?? TIMEOUT_REPUTACION_MS;

  // UN solo plazo compartido por los cinco chequeos, que corren en paralelo. Con un timeout por
  // chequeo, cinco chequeos colgados tardarían 5×15s y el turno se perdería igual.
  let cancelar = () => {};
  const plazo = new Promise<typeof VENCIDO>((listo) => {
    const t = setTimeout(() => listo(VENCIDO), ms);
    cancelar = () => clearTimeout(t);
  });

  const intentar: Intentar = async <T>(hacer: () => Promise<T>): Promise<Intento<T>> => {
    try {
      const r = await Promise.race([hacer(), plazo]);
      if (r === VENCIDO) return { ok: false, motivo: `no respondió en ${ms} ms`, sinRegistro: false };
      return { ok: true, valor: r as T };
    } catch (e) {
      return { ok: false, motivo: e instanceof Error ? e.message : String(e), sinRegistro: esSinRegistro(e) };
    }
  };

  try {
    const [spf, dkim, dmarc, ptr, blacklist, tls] = await Promise.all([
      chequearSpf(input, intentar),
      chequearDkim(input, intentar),
      chequearDmarc(input, intentar),
      chequearPtr(input, intentar),
      chequearBlacklist(input, intentar),
      chequearTls(input, intentar)
    ]);
    return { dominio: input.dominio, ip: input.ip, blacklist, spf, dkim, dmarc, ptr, tls };
  } finally {
    // Sin esto el proceso se queda con el timer colgado hasta que venza, y un tick cada 10 minutos
    // acumula timers vivos toda la noche.
    cancelar();
  }
}

/** ¿El DNS dijo "no existe" (dato) o falló (no dato)? Es la regla 2, en una línea. */
function esSinRegistro(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

/** Los TXT largos vienen partidos en trozos de 255 bytes: se pegan antes de mirarlos. */
function aplanar(registros: string[][]): string[] {
  return registros.map((trozos) => trozos.join("").trim());
}

async function chequearSpf(input: EntradaReputacion, intentar: Intentar): Promise<ChequeoReputacion> {
  const r = await intentar(() => input.resolveTxt(input.dominio));
  if (!r.ok) {
    return r.sinRegistro
      ? { estado: "mal", detalle: "el dominio no publica SPF" }
      : { estado: "no-se", detalle: `no pude consultar SPF: ${r.motivo}` };
  }
  const spf = aplanar(r.valor).filter((t) => /^v=spf1(\s|$)/i.test(t));
  if (spf.length === 0) return { estado: "mal", detalle: "el dominio no publica SPF" };
  // DOS registros SPF no es "el doble de SPF": es permerror, y el receptor descarta la política
  // entera. Falla más silencioso que no tener ninguno, porque el registro se ve bien de a uno.
  if (spf.length > 1) return { estado: "mal", detalle: `${spf.length} registros SPF: el receptor lo trata como permerror y descarta los dos` };
  // El último `all` es el que manda: antes hay includes que también terminan en palabras.
  const marcas = [...spf[0]!.matchAll(/([-~+?])all(?![\w.-])/gi)];
  const q = marcas.at(-1)?.[1];
  if (!q) return { estado: "mal", detalle: "SPF sin mecanismo all: no dice qué hacer con lo que no autoriza" };
  if (q === "-" || q === "~") return { estado: "ok", detalle: `SPF con ${q}all` };
  return { estado: "mal", detalle: `SPF con ${q}all: no rechaza a nadie` };
}

async function chequearDmarc(input: EntradaReputacion, intentar: Intentar): Promise<ChequeoReputacion> {
  const r = await intentar(() => input.resolveTxt(`_dmarc.${input.dominio}`));
  if (!r.ok) {
    return r.sinRegistro
      ? { estado: "mal", detalle: "el dominio no publica DMARC" }
      : { estado: "no-se", detalle: `no pude consultar DMARC: ${r.motivo}` };
  }
  const rec = aplanar(r.valor).find((t) => /^v=dmarc1(\s*;|$)/i.test(t));
  if (!rec) return { estado: "mal", detalle: "el dominio no publica DMARC" };
  const p = /(^|;)\s*p\s*=\s*([a-z]+)/i.exec(rec)?.[2]?.toLowerCase();
  if (p === "reject" || p === "quarantine") return { estado: "ok", detalle: `DMARC p=${p}` };
  // p=none NO es un error: es exactamente el mínimo que Gmail y Yahoo exigen desde 2024. Decirle
  // "mal" haría que el agente pida arreglar algo que ya cumple. Pero tampoco es protección, y eso
  // se dice en el texto en vez de esconderlo detrás de un "ok" pelado.
  if (p === "none") return { estado: "ok", detalle: "DMARC p=none: cumple el mínimo que exigen Gmail y Yahoo, pero no protege" };
  return { estado: "mal", detalle: `DMARC sin política usable (p=${p ?? "ausente"})` };
}

async function chequearDkim(input: EntradaReputacion, intentar: Intentar): Promise<ChequeoReputacion> {
  // Se REUSA el diagnóstico que ya existe en vez de mirar un selector: acá se firma con s2026a y no
  // con "default", y consultar el selector equivocado reporta un "DKIM missing" falso. Además
  // distingue una clave REVOCADA (p= vacío) de la ausencia, y cuando ningún selector resolvió dice
  // "unknown" en vez de "absent" — que es la misma regla 1 de este archivo, ya implementada allá.
  const r = await intentar(() =>
    diagnoseDkim({
      resolveTxt: input.resolveTxt,
      domain: input.dominio,
      ...(input.now ? { now: input.now } : {})
    })
  );
  if (!r.ok) return { estado: "no-se", detalle: `no pude consultar DKIM: ${r.motivo}` };
  const d = r.valor;
  if (d.status === "valid") return { estado: "ok", detalle: `DKIM válido en ${d.validSelectors.join(", ")}` };
  if (d.status === "unknown") return { estado: "no-se", detalle: "ningún selector resolvió: puede ser el DNS y no la firma" };
  if (d.status === "revoked") return { estado: "mal", detalle: "DKIM presente pero REVOCADO (p= vacío)" };
  return { estado: "mal", detalle: `sin DKIM en los ${d.checked.length} selectores probados (incluido s2026a)` };
}

async function chequearPtr(input: EntradaReputacion, intentar: Intentar): Promise<ChequeoReputacion> {
  const ip = input.ip;
  if (!ip) return { estado: "no-se", detalle: SIN_IP };
  const r = await intentar(() => input.reverse(ip));
  if (!r.ok) {
    return r.sinRegistro
      ? { estado: "mal", detalle: `${ip} no tiene PTR` }
      : { estado: "no-se", detalle: `no pude consultar el PTR: ${r.motivo}` };
  }
  const nombre = r.valor[0];
  if (!nombre) return { estado: "mal", detalle: `${ip} no tiene PTR` };
  // CONFIRMACIÓN HACIA ADELANTE. Un PTR que no vuelve a la misma IP no vale nada: el receptor hace
  // FCrDNS y lo trata como si no existiera. Sin este segundo paso, un PTR apuntando a un nombre
  // muerto se reportaría como "ok" y el dominio quedaría con un problema invisible.
  const f = await intentar(() => input.resolve4(nombre));
  if (!f.ok) {
    return f.sinRegistro
      ? { estado: "mal", detalle: `PTR ${nombre} no resuelve a ninguna IP (FCrDNS roto)` }
      : { estado: "no-se", detalle: `PTR ${nombre}, pero no pude confirmarlo hacia adelante: ${f.motivo}` };
  }
  return f.valor.includes(ip)
    ? { estado: "ok", detalle: `PTR ${nombre} confirmado` }
    : { estado: "mal", detalle: `PTR ${nombre} no vuelve a ${ip} (resuelve a ${f.valor.join(", ") || "nada"})` };
}

const SIN_IP = "no sé de qué IP hablamos: el dominio no tiene nodo asignado en el inventario";

/** Un cert que vence dentro de esta ventana ya es un problema: hay que renovarlo antes. */
export const TLS_POR_VENCER_DIAS = 14;

async function chequearTls(input: EntradaReputacion, intentar: Intentar): Promise<ChequeoReputacion> {
  // Sin sonda inyectada NO se inventa un veredicto. Es la regla 1 del encabezado: el cuarto estado
  // implícito ("no lo chequeé, debe estar bien") es el que fabrica las mentiras caras.
  if (!input.tls) return { estado: "no-se", detalle: "no tengo con qué mirar el certificado en este entorno" };
  const r = await intentar(() => input.tls!(`mail.${input.dominio}`));
  if (!r.ok) return { estado: "no-se", detalle: `no pude mirar el certificado del 587: ${r.motivo}` };
  if (!r.valor) return { estado: "mal", detalle: "el 587 responde pero no presenta certificado: STARTTLS no está sirviendo" };
  const vence = Date.parse(r.valor.vence ?? "");
  if (!Number.isFinite(vence)) return { estado: "no-se", detalle: "el certificado no dice cuándo vence" };
  const dias = Math.floor((vence - (input.now?.() ?? new Date()).getTime()) / 86_400_000);
  if (dias < 0) return { estado: "mal", detalle: `el certificado venció hace ${-dias} día(s)` };
  if (dias <= TLS_POR_VENCER_DIAS) return { estado: "mal", detalle: `el certificado vence en ${dias} día(s)` };
  return { estado: "ok", detalle: `certificado vigente ${dias} día(s) más${r.valor.nombre ? ` (${r.valor.nombre})` : ""}` };
}

async function chequearBlacklist(input: EntradaReputacion, intentar: Intentar): Promise<ChequeoReputacion> {
  const ip = input.ip;
  // Sin IP NO se llama a la API. No es una optimización: es no gastar cuota en una pregunta que no
  // se puede formular, y no dejar que un "error" de la API se confunda con el problema real, que es
  // que falta el binding.
  if (!ip) return { estado: "no-se", detalle: SIN_IP };
  const r = await intentar(() => input.blacklist(ip));
  if (!r.ok) return { estado: "no-se", detalle: `no pude consultar las listas negras: ${r.motivo}` };
  const listas = r.valor.listas.filter((l) => l.trim());
  switch (r.valor.estado) {
    case "clean":
      return { estado: "ok", detalle: "sin detecciones" };
    case "listed":
      return { estado: "mal", detalle: `listado en ${listas.length || "?"}: ${listas.join(", ") || "sin detalle"}` };
    case "warning":
      // Un aviso no es una detección, pero tampoco es limpio, y hacia el verde no se falla nunca.
      return { estado: "mal", detalle: `con avisos: ${listas.join(", ") || "sin detalle"}` };
    default:
      return { estado: "no-se", detalle: "la API de listas negras respondió con error" };
  }
}

// ── EL BARRIDO DIARIO ───────────────────────────────────────────────────────────────────────────
//
// El instrumento estaba comprado y apagado: `grep -c daily_scan runtime/logs/gateway.log` en
// producción da 0, con la llave de MXToolbox en gateway.env desde junio. Y peor que apagado —
// arbitrario: `revisar_reputacion` la pulsa el MODELO cuando se le ocurre, dos veces en un día y
// contra dominios al azar. El 2026-08-07T09:23Z corrió sobre annualfiling-infra.com, devolvió "no
// pude consultar las listas negras… No sé si está listado", y ese resultado no llegó a Slack ni
// quedó en ningún archivo: `ls runtime/openclaw-workspace/inventory/` no tiene un reputacion.json.
// Un instrumento cuyo resultado no se guarda no vigila nada, porque no se puede diffear ni hoy ni
// mañana.
//
// Esto es lo contrario: recorre la flota entera, siempre, en un orden fijo, y deja el archivo.
// READ-ONLY por construcción — la única forma de tocar algo desde acá sería que `revisar` mandara
// correo, y `revisar` es `revisarReputacionDe`, que sólo consulta DNS y una API de lectura.

/** Dónde queda la última foto de reputación de la flota. Lo lee `elegirPool` y lo diffea el canal. */
export const REPUTACION_FILE = "warmup-reputacion.json";

/**
 * Cuántas consultas de listas negras gasta UN barrido. EN CÓDIGO, no en env, y esto no es un
 * detalle: un tope que se sube con una variable de entorno a las 3 de la mañana dejó de ser un
 * tope. La cuota de MXToolbox se comparte con la pestaña Reputación del panel, así que un barrido
 * glotón deja al operador sin poder consultar justo el día que hace falta.
 *
 * 25 sobre 58 nodos: alcanza de sobra para los ~6 que hoy calientan más los que están cerca del
 * umbral, que son los dos grupos donde la respuesta cambia una decisión. El resto sale medido en
 * todo lo que es gratis (DNS y TLS) y con las listas en "no-se", que es la verdad.
 */
export const PRESUPUESTO_LISTAS_POR_BARRIDO = 25;

/** Una fila del archivo. `listas: "no-se"` es un estado de primera clase, no un array vacío. */
export interface FilaReputacion {
  dominio: string;
  ip: string | null;
  /** Las listas que lo detectaron. `[]` = consultado y limpio. `"no-se"` = NO consultado o falló. */
  listas: string[] | "no-se";
  /**
   * POR QUÉ no hay veredicto de listas. Solo cuando `listas === "no-se"` y se preguntó de verdad.
   *
   * Medido en el barrido real: de 25 consultas, 13 se gastaron y volvieron SIN veredicto, y el
   * motivo se descartaba. O sea que la cobertura real era 12 de 66 (18%) y el archivo la mostraba
   * como 25 de 66 — y entre las 13 perdidas estaban 4 de los 6 dominios que HOY calientan, que son
   * prioridad 0 del orden. Sin el motivo nadie puede decidir si conviene reintentar: no es lo mismo
   * "la API no está configurada" que "esa IP no la conoce".
   */
  listasMotivo?: string;
  /**
   * Cómo trata el receptor a ese nodo HOY: `"cerrado"`, `"atascado"`, `"sano"`… Sale de
   * sender-measurement, no de este módulo.
   *
   * Existe porque la regla d4 del canal —"listas limpias PERO el receptor cerrado", el modo de falla
   * exacto del 2026-07-25 con 38 nodos cerrados en Gmail y cero detecciones de blacklist— LEE este
   * campo y nadie lo escribía: media regla en código muerto, con 36 bandejas cerradas hoy para
   * reproducirla. Ausente = "no se sabe", nunca "sano".
   */
  receptor?: string | null;
  /**
   * `true` cuando el "no sé" es PORQUE NOSOTROS NO PREGUNTAMOS: se acabó el presupuesto del barrido.
   *
   * Los dos "no sé" son distintos y el archivo tiene que poder distinguirlos. Con 25 consultas sobre
   * 58 dominios, 33 filas salen en "no-se" TODOS LOS DÍAS por diseño; la regla del canal que avisa
   * "no pude consultar las listas negras" las contaba a todas y quedaba permanentemente verdadera,
   * o sea ~4 mensajes diarios para siempre sobre una ceguera que elegimos nosotros. El archivo sigue
   * sin mentir —ninguno de los dos estados es "limpio"—, pero sólo el que es una ceguera de verdad
   * interrumpe al jefe.
   */
  porPresupuesto?: true;
  spf: ChequeoReputacion;
  dkim: ChequeoReputacion;
  dmarc: ChequeoReputacion;
  ptr: ChequeoReputacion;
  tls: ChequeoReputacion;
  medidoEn: string;
}

export interface ArchivoReputacion {
  medidoEn: string;
  /** Cuántas consultas de listas se gastaron, y cuántos dominios quedaron sin ellas por el tope. */
  cuota: { gastadas: number; presupuesto: number; sinConsultar: number };
  dominios: FilaReputacion[];
}

/**
 * EL ORDEN, que es la mitad del valor. Primero los que HOY calientan (ahí una lista negra cambia lo
 * que sale esta tarde), después los que están cerca del umbral permanente (ahí cambia algo
 * irreversible), y al final el resto. Con la cuota agotada, los últimos quedan con las listas en
 * "no-se" — nunca en "limpio", que es la confusión que costó el mes de julio.
 *
 * Pura y exportada porque el orden es una regla de negocio, no un detalle del loop.
 */
export function ordenDelBarrido(input: {
  todos: readonly string[];
  calientanHoy: readonly string[];
  cerca: readonly string[];
}): string[] {
  const prioridad = (d: string): number => {
    const bajo = d.toLowerCase();
    if (input.calientanHoy.some((x) => x.toLowerCase() === bajo)) return 0;
    if (input.cerca.some((x) => x.toLowerCase() === bajo)) return 1;
    return 2;
  };
  // Estable dentro de cada grupo: un orden que cambia entre corridas hace que el diff del canal
  // grite por cosas que no se movieron.
  return [...input.todos].sort((a, b) => prioridad(a) - prioridad(b) || a.localeCompare(b));
}

/**
 * El barrido. Todo el IO entra inyectado (una sola función: `revisar`), así que se corre entero sin
 * red y sin disco. NO escribe el archivo: devuelve su contenido y el llamador lo persiste con
 * `updateInventoryJson`. Esa separación es la que hace que "read-only" sea verificable en test en
 * vez de prometido en un comentario.
 */
export async function barridoDeReputacion(input: {
  orden: readonly string[];
  /** `revisarReputacionDe` cableado con sus adapters. `conListas:false` ⇒ no gasta cuota. */
  revisar: (dominio: string, conListas: boolean) => Promise<ReputacionLeida>;
  /**
   * Cómo está el receptor para ese dominio, de sender-measurement. `null`/ausente = no se sabe.
   *
   * Entra inyectado como todo lo demás: este módulo no lee un solo archivo. Es la mitad que le
   * faltaba a la regla d4 del canal, que cruza "listas limpias" con "receptor cerrado".
   */
  receptorDe?: (dominio: string) => string | null;
  presupuesto?: number;
  now?: () => Date;
  log?: (linea: string) => void;
}): Promise<ArchivoReputacion> {
  const presupuesto = input.presupuesto ?? PRESUPUESTO_LISTAS_POR_BARRIDO;
  const ahora = (input.now ?? (() => new Date()))();
  const dominios: FilaReputacion[] = [];
  let gastadas = 0;
  let sinConsultar = 0;

  for (const dominio of input.orden) {
    const conListas = gastadas < presupuesto;
    if (!conListas) sinConsultar += 1;
    let r: ReputacionLeida;
    try {
      r = await input.revisar(dominio, conListas);
    } catch (e) {
      // UN NODO NO PUEDE COLGAR EL BARRIDO NI VACIARLO. `revisarReputacionDe` ya trae su propio
      // TIMEOUT_REPUTACION_MS por dominio; esto ataja lo que ni siquiera llegó a él (un adapter que
      // lanza al construirse). Sale como "no sé" en las cinco señales, que es exactamente lo que
      // es. Es la lección del probe con `head -c` del 2026-07-29: un chequeo que se cuelga devuelve
      // "no sé", nunca un veredicto.
      const noSe: ChequeoReputacion = { estado: "no-se", detalle: e instanceof Error ? e.message : String(e) };
      dominios.push({
        dominio, ip: null, listas: "no-se", listasMotivo: noSe.detalle,
        receptor: input.receptorDe?.(dominio) ?? null,
        spf: noSe, dkim: noSe, dmarc: noSe, ptr: noSe, tls: noSe,
        medidoEn: ahora.toISOString()
      });
      input.log?.(`barrido-reputacion ${dominio}: no pude medirlo — ${noSe.detalle}`);
      continue;
    }
    // LA CUOTA SE GASTA CUANDO SE PREGUNTA, no cuando se intenta. Un dominio sin IP no produce
    // ninguna consulta —`chequearBlacklist` sale antes de llamar a la API— y sin embargo se le
    // descontaba una unidad del presupuesto: medido, hasta 7 de las 25 (28%) se iban en preguntas
    // que nunca se formularon, y los dominios del final de la lista se quedaban sin medir por una
    // cuota que nadie gastó.
    const pregunto = conListas && r.ip !== null;
    if (pregunto) gastadas += 1;
    const listas = listasDe(r.blacklist, pregunto);
    dominios.push({
      dominio,
      ip: r.ip,
      listas,
      // EL MOTIVO DEL "NO SÉ", cuando preguntamos y no hubo veredicto. Es lo único que permite
      // decidir si conviene reintentar; sin él, 13 de 25 consultas del barrido real se gastaron y
      // no dejaron rastro de por qué.
      ...(listas === "no-se" && pregunto ? { listasMotivo: r.blacklist.detalle } : {}),
      // La marca va sólo cuando el "no sé" lo decidimos nosotros. Si se consultó y falló, la fila
      // sale sin marca y ESA sí es una ceguera que interrumpe.
      ...(conListas ? {} : { porPresupuesto: true as const }),
      receptor: input.receptorDe?.(dominio) ?? null,
      spf: r.spf, dkim: r.dkim, dmarc: r.dmarc, ptr: r.ptr, tls: r.tls,
      medidoEn: ahora.toISOString()
    });
  }

  input.log?.(
    `barrido-reputacion: ${dominios.length} dominios · ${gastadas}/${presupuesto} consultas de listas` +
      (sinConsultar > 0 ? ` · ${sinConsultar} sin consultar por el tope (quedan en "no sé")` : "")
  );
  return { medidoEn: ahora.toISOString(), cuota: { gastadas, presupuesto, sinConsultar }, dominios };
}

/**
 * De la señal al dato del archivo. Es la línea donde se decide si un "no medido" se disfraza de
 * "limpio", y por eso está sola y con nombre: `ok` es la ÚNICA entrada que produce un array vacío,
 * y sólo cuando de verdad se consultó.
 */
/**
 * LA SONDA DEL CERTIFICADO — el único IO de este archivo, y no lo usa nadie de acá adentro.
 *
 * Existe porque `chequearTls` estaba escrito, testeado y CIEGO en los 66 dominios: el llamador
 * nunca le pasaba `input.tls`, así que la señal salía "no sé" siempre. Y duele el doble porque
 * `authRota` (plan-diario.ts) ya excluye del pool por `tls === "mal"` — o sea una válvula conectada
 * a un dato que no podía valer "mal" ni cuando el certificado estaba caído. filing-ops.com, uno de
 * los 7 candidatos a soltar, es justamente el dominio cuyo cert vencido motivó escribir el chequeo.
 *
 * Va acá y no en el orquestador para que cablearla sea UNA línea (`tls: sondaTlsDelNodo()`), y con
 * `await import` para que el módulo siga sin traer red al importarse: los tests lo cargan entero sin
 * abrir un socket.
 *
 * No cuesta cuota: es nuestra propia máquina por el 587, sin terceros. `rejectUnauthorized: false`
 * es deliberado — se quiere LEER el certificado aunque esté vencido o mal firmado, que es
 * exactamente el caso que hay que detectar; rechazar el handshake nos dejaría sin la fecha.
 */
export function sondaTlsDelNodo(timeoutMs = 8_000): (host: string) => Promise<{ vence: string | null; nombre: string | null } | null> {
  return async (host: string) => {
    const net = await import("node:net");
    const tls = await import("node:tls");
    const plano = net.connect(587, host);
    // Un socket que nunca contesta cuelga la vuelta entera del agente. El plazo es propio y corta
    // por las dos puntas: el `destroy` desata el `error` que rechaza la promesa de abajo.
    const reloj = setTimeout(() => plano.destroy(new Error(`el 587 de ${host} no contestó en ${timeoutMs} ms`)), timeoutMs);
    const leer = (s: NodeJS.ReadWriteStream): Promise<string> =>
      new Promise((ok, mal) => {
        let buf = "";
        const onData = (c: Buffer | string): void => {
          buf += c.toString();
          const ultima = buf.split("\r\n").filter(Boolean).at(-1) ?? "";
          if (/^\d{3} /.test(ultima)) {
            s.removeListener("data", onData);
            ok(ultima);
          }
        };
        s.on("data", onData);
        s.once("error", mal);
      });
    const decir = async (s: NodeJS.ReadWriteStream, linea: string): Promise<string> => {
      s.write(`${linea}\r\n`);
      return leer(s);
    };
    try {
      await new Promise((ok, mal) => {
        plano.once("connect", ok);
        plano.once("error", mal);
      });
      await leer(plano);
      await decir(plano, "EHLO sonda.delivrix");
      const r = await decir(plano, "STARTTLS");
      // El 587 contesta pero no ofrece TLS: eso NO es "no sé", es un problema real, y quien lo
      // traduce a "mal" es `chequearTls` con su propia frase.
      if (!r.startsWith("220")) return null;
      const seguro = tls.connect({ socket: plano, servername: host, rejectUnauthorized: false });
      await new Promise((ok, mal) => {
        seguro.once("secure", ok);
        seguro.once("error", mal);
      });
      const cert = seguro.getPeerCertificate();
      seguro.destroy();
      if (!cert || Object.keys(cert).length === 0) return null;
      return { vence: cert.valid_to ?? null, nombre: cert.subject?.CN ?? null };
    } finally {
      clearTimeout(reloj);
      plano.destroy();
    }
  };
}

function listasDe(c: ChequeoReputacion, conListas: boolean): string[] | "no-se" {
  if (!conListas || c.estado === "no-se") return "no-se";
  if (c.estado === "ok") return [];
  // "listado en 3: spamhaus, sorbs" / "con avisos: x" → los nombres, sin el prefijo.
  const nombres = c.detalle.split(":").slice(1).join(":").split(",").map((s) => s.trim()).filter(Boolean);
  return nombres.length > 0 ? nombres : [c.detalle];
}
