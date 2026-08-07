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
    const [spf, dkim, dmarc, ptr, blacklist] = await Promise.all([
      chequearSpf(input, intentar),
      chequearDkim(input, intentar),
      chequearDmarc(input, intentar),
      chequearPtr(input, intentar),
      chequearBlacklist(input, intentar)
    ]);
    return { dominio: input.dominio, ip: input.ip, blacklist, spf, dkim, dmarc, ptr };
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
