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
import { getActiveRamps, type OpenClawWorkspace } from "./openclaw-workspace.ts";

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

export type SemaforoColor = "verde" | "rojo" | "gris" | "calentando";

/**
 * El cable rampa → cuota: mientras una bandeja esta en warmup, el numero lo dicta la rampa,
 * no el operador. Es la vista que evaluarBandeja recibe de un WarmupRampRecord activo.
 */
export interface RampaCuota {
  estado: "running" | "paused" | "auto_paused";
  pauseReason?: string;
  /** emailCount del batch vigente (el ultimo cuyo scheduledAt ya paso). */
  cupoHoy: number;
  /** 1-based, para mostrar "dia 3/14". */
  dia: number;
  totalDias: number;
  schedule: string;
}

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
  /** Rampa de warmup activa sobre esta bandeja. `null` = no esta calentando. */
  rampa: RampaCuota | null;
  /**
   * La lectura de SALUD quedo ilegible (el "nodo vivo pero incomunicado"). Viaja aparte del
   * `estado` porque el estado es lo que GANA el semaforo (una rampa corriendo lo tapa), y un
   * nodo incomunicado tiene que alertar aunque este calentando — justo ahi es cuando mas
   * importa. `null` = la salud se leyo (o nunca se midio, que es "sin medir", no incomunicado).
   */
  sinLectura: { motivo: string } | null;
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
 * El semaforo de UNA bandeja. Funcion pura: inventario + medicion + rampa + asignada → veredicto.
 *
 * El orden de los casos es el orden del riesgo: primero lo que impide medir (gris), despues lo
 * medido que esta mal (ROJO GANA SIEMPRE, incluso a una rampa corriendo — calentar encima de una
 * cola atascada es echar gasolina), despues la rampa que dicta su cupo, y verde solo al final,
 * cuando no quedo nada que lo desmienta.
 */
export function evaluarBandeja(
  inv: BandejaInventario,
  med: MedicionBandeja | null,
  asignada: number | null,
  techo: number,
  rampa: RampaCuota | null = null
): CuotaBandeja {
  const base = {
    domain: inv.domain,
    serverSlug: inv.serverSlug,
    asignada,
    edadDias: inv.edadDias,
    cruzados: med?.cruzados ?? [],
    cerca: med?.cerca ?? [],
    rampa,
    sinLectura: med?.estado === "unreadable" ? { motivo: med.detalle } : null
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

  // El umbral permanente cruzado gana ANTES que nada y NO depende de la lectura de salud:
  // `cruzados` viene de la lectura de VOLUMEN, `estado` de la de SALUD, y son dos SSH
  // independientes (medirBandeja). Si la salud queda `unreadable` pero el volumen alcanzo a leer
  // que el dominio cruzo Google, sigue siendo rojo irreversible: gatearlo tras `!== unreadable`
  // lo dejaba caer a la rampa y vender cupo sobre un dominio quemado para siempre.
  if (med && med.cruzados.length > 0) {
    return rojo("umbral cruzado", `cruzó el umbral permanente en ${med.cruzados.join(", ")}`);
  }

  // El resto del veredicto rojo SI depende de una lectura de salud legible.
  if (med && med.estado !== "unreadable") {
    if (med.estado === "stalled") {
      return rojo("cola atascada", med.detalle || `${med.diferidos ?? "?"} mensajes diferidos`);
    }
    if (med.estado === "blocked_by_provider") {
      return rojo("bloqueada", `cerrada en ${med.cerradoEn.join(", ") || "receptores"}`);
    }
    if (med.estado === "degraded") {
      return rojo("rechazo parcial", med.detalle);
    }
  }

  // El cable rampa → cuota: mientras calienta, el numero lo dicta la rampa, no el operador.
  // Vale incluso sin medicion de la fabrica: una bandeja fresca todavia no dejo huella en el
  // mail.log, y la rampa trae su propio freno (breaker por rebote + placement).
  if (rampa) {
    if (rampa.estado === "auto_paused") {
      return rojo("rampa pausada", `auto-pausada: ${rampa.pauseReason ?? "sin motivo registrado"}`);
    }
    if (rampa.estado === "paused") {
      return gris("rampa pausada", "pausada a mano");
    }
    // running. hoyPuede para NFC es 0 mientras calienta, y es CRÍTICO que asi sea: la rampa YA
    // envia su cupo diario ella misma (runBatch -> sendmail, warmup-ramp.ts). Si ademas NFC
    // consumiera este numero, el dominio recibiria el volumen de la rampa MAS el de NFC — en la
    // curva production-14d eso cruza el umbral permanente de Google, justo lo que este modulo
    // existe para impedir. El dominio no esta warm: la produccion espera al verde. `cupoHoy`
    // queda en `rampa` solo para que la pantalla muestre "dia X/N · la rampa envia N".
    return {
      ...base,
      color: "calentando",
      estado: `rampa día ${rampa.dia}/${rampa.totalDias}`,
      motivo: "la rampa envía el volumen; NFC espera a que esté warm",
      hoyPuede: 0,
      editable: false
    };
  }

  if (!med) return gris("sin medir", "nunca se midió");
  if (med.estado === "unreadable") return gris("sin lectura", med.detalle);
  // El nodo movió correo y NADA de eso es nuestro: no hay muestra propia, así que no hay veredicto.
  //
  // Sin esta rama el estado caía al `return` verde de abajo, o sea que el estado que significa
  // "no tengo con qué opinar" salía "entrega" con la cuota entera servida. Medido el 2026-08-06
  // contra la medición de producción (58 bandejas) y el libro real (7 dominios con envío nuestro en
  // 7 días): al cablear `leerLibroPropio` en medir-flota, 36 bandejas quedan `no_own_traffic` — y
  // son EXACTAMENTE las 36 que hoy están rojas "bloqueada", las que NFC quemó
  // (annualcorp-control.com, annualfiling-relay.com, infranationalreport.com…). Todas pasaban de
  // roja a verde con una sola línea de cambio en el script.
  //
  // Gris y NO editable, a diferencia de `no_traffic`: sobre un dominio del que no medimos ni un
  // mensaje propio no hay número que el operador pueda asignar con fundamento, y dejarlo editable
  // es cargar el cupo que se sirve solo el día que una muestra de un mensaje lo ponga verde.
  if (med.estado === "no_own_traffic") {
    return gris("sin muestra propia", med.detalle);
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
  // Rampas de warmup activas: el cable rampa → cuota. Mismo workspace, misma regla: si no se
  // puede leer, no hay rampa — la bandeja cae al camino normal, nunca a un cupo inventado.
  const rampas = await getActiveRamps(input.workspace).catch(() => []);
  const rampaPorDominio = new Map<string, RampaCuota>();
  const ahora = input.now?.() ?? new Date();
  for (const r of rampas) {
    rampaPorDominio.set(r.domain.toLowerCase(), rampaParaCuota(r, ahora));
  }

  const porDominio = new Map<string, MedicionBandeja>();
  for (const b of medicion?.bandejas ?? []) porDominio.set(b.domain, b);

  const bandejas: CuotaBandeja[] = [];
  for (const inv of inventario.bandejas) {
    // Invisibles y conflictos no son filas: van al pie por nombre (ya vienen del inventario).
    if (inv.sinMedicion === "sin_binding" || inv.conflicto) continue;
    bandejas.push(
      evaluarBandeja(
        inv,
        porDominio.get(inv.domain) ?? null,
        leerAsignada(store, inv.domain),
        techo,
        rampaPorDominio.get(inv.domain) ?? null
      )
    );
  }

  // Riesgo primero: lo rojo pide accion, lo que calienta se mira a diario, lo verde es el
  // producto, lo gris espera medicion.
  const orden: Record<SemaforoColor, number> = { rojo: 0, calentando: 1, verde: 2, gris: 3 };
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

/**
 * Proyeccion compacta para el modelo. El JSON crudo de armarCuotaFlota (58 bandejas) supera los
 * 4096 chars del limite de resultado de tool (maxToolResultJsonChars) y se truncaba a la mitad de
 * un objeto: el modelo veia solo las primeras filas (rojas, por el orden) y PERDIA medidoEn,
 * techo, el total y las verdes. Esto entrega lo esencial —conteos, totales, la foto— en filas
 * minimas que caben enteras, para que el modelo responda "como esta la flota" con datos completos.
 */
export function resumirCuotaFlota(flota: CuotaFlota): {
  medidoEn: string | null;
  techoDiario: number;
  totalHoyPuede: number;
  conteos: Record<SemaforoColor, number>;
  /** Verdes con cupo > 0: exactamente lo que NFC puede usar hoy. */
  vendibles: Array<{ dom: string; hoyPuede: number }>;
  /** Rojas: accionable, con el estado corto. El detalle por receptor va en read_sender_measurement. */
  problemas: Array<{ dom: string; estado: string }>;
  /** En rampa (NFC vende 0 en ellas mientras calientan). */
  calentando: string[];
  /** Filas no enumeradas por el tope de tamaño. NUNCA se ocultan en silencio: se cuentan. */
  vendiblesOmitidas: number;
  problemasOmitidas: number;
  fueraDeMedicion: string[];
  enConflicto: string[];
  parcial: boolean;
} {
  const conteos: Record<SemaforoColor, number> = { rojo: 0, calentando: 0, verde: 0, gris: 0 };
  for (const b of flota.bandejas) conteos[b.color] += 1;

  // Tope por lista para caber en los 4096 chars del límite de resultado de tool aun con una flota
  // entera roja de nombres largos. Lo omitido se cuenta (nunca se trunca en silencio); los totales
  // completos ya están en `conteos`.
  const MAX_FILAS = 25;
  const verdes = flota.bandejas.filter((b) => b.color === "verde" && b.hoyPuede > 0);
  const rojas = flota.bandejas.filter((b) => b.color === "rojo");
  return {
    medidoEn: flota.medidoEn,
    techoDiario: flota.techoDiario,
    totalHoyPuede: flota.totalHoyPuede,
    conteos,
    vendibles: verdes.slice(0, MAX_FILAS).map((b) => ({ dom: b.domain, hoyPuede: b.hoyPuede })),
    problemas: rojas.slice(0, MAX_FILAS).map((b) => ({ dom: b.domain, estado: b.estado })),
    calentando: flota.bandejas.filter((b) => b.color === "calentando").map((b) => b.domain),
    vendiblesOmitidas: Math.max(0, verdes.length - MAX_FILAS),
    problemasOmitidas: Math.max(0, rojas.length - MAX_FILAS),
    fueraDeMedicion: flota.fueraDeMedicion,
    enConflicto: flota.enConflicto,
    parcial: flota.parcial
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

/**
 * Proyecta un WarmupRampRecord a lo que la cuota necesita: el cupo del batch VIGENTE (el ultimo
 * cuyo scheduledAt ya paso; si la rampa arranca en el futuro, el primero). Exportada para que el
 * test la ejercite con la curva real.
 */
export function rampaParaCuota(
  record: {
    schedule: string;
    state: "running" | "paused" | "auto_paused" | string;
    pauseReason?: string;
    batches: Array<{ batchIndex: number; scheduledAt: string; emailCount: number }>;
  },
  ahora: Date
): RampaCuota {
  const pasados = record.batches.filter((b) => Date.parse(b.scheduledAt) <= ahora.getTime());
  const vigente = pasados.length > 0 ? pasados[pasados.length - 1]! : record.batches[0];
  const estado =
    record.state === "paused" || record.state === "auto_paused" ? record.state : "running";
  return {
    estado,
    ...(record.pauseReason ? { pauseReason: record.pauseReason } : {}),
    cupoHoy: vigente?.emailCount ?? 0,
    dia: (vigente?.batchIndex ?? 0) + 1,
    totalDias: record.batches.length,
    schedule: record.schedule
  };
}
