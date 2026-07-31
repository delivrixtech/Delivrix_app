// La cuota diaria por bandeja: el numero que la fabrica vende.
//
// El operador tiene UNA decision por bandeja: cuanto le dejo enviar hoy. Todo lo demas
// —blacklist, rebotes, edad, placement— existe solo para informar ese numero. Este modulo junta
// las tres piezas que ya existen (inventario, ultima medicion, cuota asignada) y produce la
// respuesta: `hoyPuede`, que es lo que NFC consume por GET /v1/sender-pool/quota.
//
// Dos reglas que no se negocian:
//
//   1. El semaforo se CALCULA, no se elige. Verde solo si se midio y entrega. Nunca verde por
//      defecto, nunca cuota por defecto: una bandeja sin numero asignado vende 0.
//   2. `hoyPuede` es fail-closed: solo una bandeja verde sirve su cuota asignada. Roja o gris
//      sirve 0 CON EL MOTIVO al lado. Hoy NFC se pone el numero solo, a mano — asi es como
//      controlcontrolledger.com llego a 3.964/dia asignados con 920 mensajes atascados.

import { leerInventarioFabrica, type BandejaInventario } from "./sender-inventory.ts";
import { leerUltimaMedicion, type MedicionBandeja } from "./sender-measurement.ts";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

/** Donde viven las cuotas asignadas. Un archivo, no una tabla: no depende de Postgres. */
export const QUOTA_FILE = "sender-quota.json";

/**
 * Techo diario por dominio. NO es tuning: cruzar ~5.000/dia hacia buzones personales de Google
 * clasifica el dominio como "bulk sender" PARA SIEMPRE (documentacion oficial, verificada
 * 2026-07-30), y los subdominios suman al mismo contador. 2.000 deja margen 2.5x contra el
 * umbral que no se puede deshacer. Subirlo por env es posible; el modulo nunca acepta mas de
 * TECHO_ABSOLUTO ni siquiera por env.
 */
export const TECHO_DIARIO_DEFAULT = 2000;
export const TECHO_ABSOLUTO = 4000;

export type SemaforoColor = "verde" | "rojo" | "gris";

export interface CuotaBandeja {
  domain: string;
  serverSlug: string | null;
  /** Calculado, nunca elegido. */
  color: SemaforoColor;
  /** La palabra que va en la columna ESTADO: "entrega", "cola atascada", "sin medir"… */
  estado: string;
  /** Por que no es verde. `null` solo cuando es verde. */
  motivo: string | null;
  /** Lo que el operador asigno. `null` = nunca se asigno, que NO es lo mismo que 0. */
  asignada: number | null;
  /** Lo que NFC consume. Solo una bandeja verde sirve su asignada; el resto sirve 0. */
  hoyPuede: number;
  /** Hay medicion detras: el numero tiene sobre que aplicarse. */
  editable: boolean;
  edadDias: number | null;
  /** Familias que ya cruzaron el umbral permanente. */
  cruzados: string[];
  /** Familias arriba del 40% del umbral: aviso, no freno. */
  cerca: string[];
}

export interface CuotaFlota {
  /** De la ultima corrida de medicion. `null` = nunca se midio (y la pantalla lo declara). */
  medidoEn: string | null;
  techoDiario: number;
  /** Filas de la lista: bandejas con nodo y sin conflicto. El resto va al pie, por nombre. */
  bandejas: CuotaBandeja[];
  totalBandejas: number;
  /** La suma que la fabrica vende hoy. */
  totalHoyPuede: number;
  /** El pie: "N fuera de medicion · M en conflicto". Nombres, no conteos. */
  fueraDeMedicion: string[];
  enConflicto: string[];
  parcial: boolean;
  motivosParcial: string[];
}

interface QuotaStore {
  cuotas?: Record<string, { asignada?: unknown; actualizadoEn?: unknown }>;
}

/** Resuelve el techo respetando el absoluto, venga de donde venga el valor. */
export function resolverTecho(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.SENDER_QUOTA_DAILY_MAX ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return TECHO_DIARIO_DEFAULT;
  return Math.min(raw, TECHO_ABSOLUTO);
}

/**
 * El semaforo de UNA bandeja. Funcion pura: inventario + ultima medicion + asignada → veredicto.
 *
 * El orden de los casos es el orden del riesgo: primero lo que impide medir (gris), despues lo
 * medido que esta mal (rojo), y verde solo al final, cuando no quedo nada que lo desmienta.
 */
export function evaluarBandeja(
  inv: BandejaInventario,
  med: MedicionBandeja | null,
  asignada: number | null,
  techo: number
): CuotaBandeja {
  const base = {
    domain: inv.domain,
    serverSlug: inv.serverSlug,
    asignada,
    edadDias: inv.edadDias,
    cruzados: med?.cruzados ?? [],
    cerca: med?.cerca ?? []
  };
  // La asignada nunca sale del techo vigente, aunque se haya guardado con un techo anterior.
  const tope = asignada === null ? null : Math.min(asignada, techo);

  const gris = (estado: string, motivo: string): CuotaBandeja => ({
    ...base, color: "gris", estado, motivo, hoyPuede: 0, editable: false
  });
  const rojo = (estado: string, motivo: string): CuotaBandeja => ({
    ...base, color: "rojo", estado, motivo, hoyPuede: 0, editable: true
  });

  if (inv.sinMedicion === "sin_binding") {
    return gris("invisible", "ningún sondeo la alcanza");
  }
  if (inv.conflicto) {
    return gris(
      "en conflicto",
      `el inventario se contradice: ${inv.conflicto.enBindings} ≠ ${inv.conflicto.enCredencial}`
    );
  }
  if (!med) return gris("sin medir", "nunca se midió");
  if (med.estado === "unreadable") return gris("sin lectura", med.detalle);

  if (med.cruzados.length > 0) {
    return rojo("umbral cruzado", `cruzó el umbral permanente en ${med.cruzados.join(", ")}`);
  }
  if (med.estado === "stalled") {
    return rojo("cola atascada", med.detalle || `${med.diferidos ?? "?"} mensajes diferidos`);
  }
  if (med.estado === "blocked_by_provider") {
    return rojo("bloqueada", `cerrada en ${med.cerradoEn.join(", ") || "receptores"}`);
  }
  if (med.estado === "degraded") {
    return rojo("rechazo parcial", med.detalle);
  }
  if (med.estado === "no_traffic") {
    // Medida y legible, pero sin evidencia de entrega. Verde solo si midio Y entrega: esto es
    // gris con el numero guardado (editable) para cuando arranque.
    return { ...base, color: "gris", estado: "sin tráfico", motivo: "no registró envíos en la ventana", hoyPuede: 0, editable: true };
  }

  // healthy. Sin cuota asignada la bandeja verde vende 0: nunca un numero por defecto.
  return {
    ...base,
    color: "verde",
    estado: "entrega",
    motivo: tope === null ? "sin cuota asignada" : null,
    hoyPuede: tope ?? 0,
    editable: true
  };
}

/** La respuesta completa: la lista, el pie y la suma. Todo JSON local; no se puede caer. */
export async function armarCuotaFlota(input: {
  workspace: OpenClawWorkspace;
  techo?: number;
  now?: () => Date;
}): Promise<CuotaFlota> {
  const techo = input.techo ?? resolverTecho();
  const inventario = await leerInventarioFabrica({
    workspace: input.workspace,
    ...(input.now ? { now: input.now } : {})
  });
  const medicion = await leerUltimaMedicion(input.workspace);
  const store = await input.workspace
    .readInventoryJson<QuotaStore>(QUOTA_FILE)
    .catch(() => null);

  const porDominio = new Map<string, MedicionBandeja>();
  for (const b of medicion?.bandejas ?? []) porDominio.set(b.domain, b);

  const bandejas: CuotaBandeja[] = [];
  for (const inv of inventario.bandejas) {
    // Invisibles y conflictos no son filas: van al pie por nombre (ya vienen del inventario).
    if (inv.sinMedicion === "sin_binding" || inv.conflicto) continue;
    bandejas.push(
      evaluarBandeja(inv, porDominio.get(inv.domain) ?? null, leerAsignada(store, inv.domain), techo)
    );
  }

  // Riesgo primero: lo rojo pide accion, lo verde es el producto, lo gris espera medicion.
  const orden: Record<SemaforoColor, number> = { rojo: 0, verde: 1, gris: 2 };
  bandejas.sort((a, b) =>
    orden[a.color] !== orden[b.color] ? orden[a.color] - orden[b.color] : a.domain.localeCompare(b.domain)
  );

  return {
    medidoEn: medicion?.medidoEn ?? null,
    techoDiario: techo,
    bandejas,
    totalBandejas: inventario.totalBandejas,
    totalHoyPuede: bandejas.reduce((sum, b) => sum + b.hoyPuede, 0),
    fueraDeMedicion: inventario.sinBinding,
    enConflicto: inventario.enConflicto,
    parcial: inventario.parcial,
    motivosParcial: inventario.motivosParcial
  };
}

export type GuardarCuotaResultado =
  | { ok: true; domain: string; antes: number | null; asignada: number; actualizadoEn: string }
  | { ok: false; error: "cuota_invalida" | "cuota_supera_techo" | "dominio_desconocido"; techo?: number };

/**
 * Persiste la cuota asignada de un dominio. Rechaza —no clampa— lo que supere el techo: un
 * numero recortado en silencio le miente al operador sobre lo que acaba de guardar.
 */
export async function guardarCuota(input: {
  workspace: OpenClawWorkspace;
  domain: string;
  hoyPuede: unknown;
  techo?: number;
  now?: () => Date;
}): Promise<GuardarCuotaResultado> {
  const techo = input.techo ?? resolverTecho();
  const valor = input.hoyPuede;
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 0) {
    return { ok: false, error: "cuota_invalida" };
  }
  if (valor > techo) {
    return { ok: false, error: "cuota_supera_techo", techo };
  }

  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  const inventario = await leerInventarioFabrica({
    workspace: input.workspace,
    ...(input.now ? { now: input.now } : {})
  });
  if (!inventario.bandejas.some((b) => b.domain === domain)) {
    return { ok: false, error: "dominio_desconocido" };
  }

  const actualizadoEn = (input.now?.() ?? new Date()).toISOString();
  let antes: number | null = null;
  await input.workspace.updateInventoryJson<QuotaStore>(QUOTA_FILE, (current) => {
    const cuotas = { ...(current?.cuotas ?? {}) };
    antes = leerAsignada(current ?? null, domain);
    cuotas[domain] = { asignada: valor, actualizadoEn };
    return { cuotas };
  });

  return { ok: true, domain, antes, asignada: valor, actualizadoEn };
}

function leerAsignada(store: QuotaStore | null, domain: string): number | null {
  const raw = store?.cuotas?.[domain]?.asignada;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}
