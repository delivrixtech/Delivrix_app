// La corrida de medicion de la flota: llena las franjas 1 y 2 del inventario.
//
// Junta las dos lecturas que ya existen y las persiste por bandeja:
//   - readNodeDeliveryHealth  -> entrega / bloqueo / cola atascada, por proveedor destino
//   - readNodeProviderVolume  -> mensajes unicos por dia contra el umbral permanente de Google
//
// Las dos leen /var/log/mail.log del nodo por SSH. Es el censo de lo que TODOS los receptores
// contestaron, no una muestra: es lo que un proveedor que revende buzones ajenos no puede hacer.
//
// Se persiste porque una medicion cuesta ~59 sesiones SSH. La pantalla lee lo ultimo medido y
// DECLARA cuando fue; nunca se queda esperando una corrida para poder mostrar algo.

import {
  BLOCKED_MIN_ATTEMPTS,
  readNodeDeliveryHealth,
  type DeliveryHealthSshRunner,
  type DeliveryHealthStatus
} from "./smtp-delivery-health.ts";
import {
  readNodeProviderVolume,
  type ProviderFamily,
  type ProviderVolumeSshRunner
} from "./smtp-provider-volume.ts";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

/** Donde vive la ultima medicion. Un archivo, no una tabla: no depende de Postgres. */
export const MEASUREMENT_FILE = "sender-measurement.json";

/**
 * Concurrencia de la medicion.
 *
 * Igual que el abanico de diagnostico y por la misma razon: cada lectura abre una sesion SSH
 * contra un nodo y no hay pool en ninguna capa de abajo. El limite lo pone la flota, no nosotros.
 */
export const MEASUREMENT_CONCURRENCY = 4;

export interface MedicionBandeja {
  domain: string;
  serverSlug: string;
  /** Nunca `healthy` por defecto: si no se pudo leer, el estado lo dice. */
  estado: DeliveryHealthStatus;
  detalle: string;
  /** Que ventana cubren los numeros de entrega, en los dias que se leyeron de verdad. */
  ventana: string;
  entregados: number | null;
  /**
   * Mensajes trabados en la cola del nodo AHORA (no en la ventana). `null` = no se pudo leer.
   *
   * Opcional a proposito: los fixtures de sender-quota, sender-alerts y la ruta de lectura arman
   * este objeto a mano, y obligarlos a declarar un campo que no les importa habria sido tocar tres
   * archivos ajenos para no ganar nada.
   */
  encolados?: number | null;
  rechazados: number | null;
  diferidos: number | null;
  /** Receptores donde el nodo esta efectivamente cerrado. */
  cerradoEn: string[];
  /**
   * Entregados/rechazados/diferidos POR RECEPTOR. Opcional, igual que `encolados` y por el mismo
   * motivo: hay fixtures que arman este objeto a mano.
   *
   * El clasificador YA calculaba esto (`NodeDeliveryStats.byProvider`) y el persistidor lo tiraba
   * entero: al archivo iban los totales globales y `cerradoEn`, o sea QUIEN cierra pero no CUANTO.
   * Dos consecuencias medidas el 2026-08-06, con 36 de 58 bandejas cerradas por el receptor:
   *
   *   1. Nadie podia decir cuanto correo seguia entregando cada una por las OTRAS puertas, que es
   *      justo el numero que decide si frenarla cuesta correo de cliente o no cuesta nada. La
   *      decision se tomaba a ciegas sobre 36 nodos.
   *   2. El punto ciego peor: el bloqueo se detecta SOLO por rebotes 5xx (`blocked/attempts >= 0,9`),
   *      y Yahoo tipicamente DIFIERE con 4xx. Un diferido no alimenta `cerradoEn`. Sin el diferido
   *      POR receptor, un bloqueo de Yahoo es literalmente invisible en este archivo — y asi fue
   *      como "Yahoo no aparece en ninguna de las 58" se leyo como "Yahoo no nos bloquea", que es
   *      ausencia de instrumento, no evidencia.
   *
   * NO se persiste `degradadoEn`: `degradedProviders` es `blocked/(delivered+blocked) >= 0,25`,
   * derivable de estas tres columnas por cualquier lector. Dos representaciones del mismo hecho es
   * la que se desincroniza.
   */
  porReceptor?: Array<{ receptor: string; entregados: number; rechazados: number; diferidos: number }>;
  /** Pico diario de mensajes UNICOS contra el umbral publicado, por familia de receptor. */
  picos: Array<{
    familia: ProviderFamily;
    dia: string;
    mensajes: number;
    umbral: number | null;
    ratio: number | null;
  }>;
  /** Familias que ya cruzaron el umbral. En Google es permanente. */
  cruzados: ProviderFamily[];
  /** Familias arriba del 40% del umbral. */
  cerca: ProviderFamily[];
}

export interface MedicionFlota {
  medidoEn: string;
  duracionMs: number;
  /** Bandejas pedidas vs leidas: delata la cobertura sin depender de un log. */
  pedidas: number;
  leidas: number;
  bandejas: MedicionBandeja[];
}

export interface RunnerMedicion extends DeliveryHealthSshRunner, ProviderVolumeSshRunner {}

/**
 * Mide UNA bandeja. Fail-honest de punta a punta: cualquier problema termina en `unreadable`
 * con el motivo, nunca en ceros que se lean como salud.
 */
export async function medirBandeja(input: {
  sshRunner: RunnerMedicion;
  domain: string;
  serverSlug: string;
  serverIp: string;
}): Promise<MedicionBandeja> {
  const [salud, volumen] = await Promise.all([
    readNodeDeliveryHealth({
      sshRunner: input.sshRunner,
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      // Los rebotes del propio dominio son bounce processing, no un bloqueo del receptor.
      selfDomain: input.domain
    }),
    readNodeProviderVolume({
      sshRunner: input.sshRunner,
      serverSlug: input.serverSlug,
      serverIp: input.serverIp
    })
  ]);

  const leyoSalud = salud.status !== "unreadable";

  return {
    domain: input.domain,
    serverSlug: input.serverSlug,
    estado: salud.status,
    detalle: salud.detail,
    ventana: salud.window,
    // null y no 0 cuando no se pudo leer: es la regla de toda la pantalla.
    entregados: leyoSalud ? salud.stats.totals.delivered : null,
    // La cola viaja al archivo porque es la unica senal de "esta atascado AHORA": los totales de la
    // ventana dicen que paso, no que esta pasando. Sin esto el operador solo veia el veredicto.
    encolados: leyoSalud ? salud.encolados : null,
    rechazados: leyoSalud ? salud.stats.totals.blocked : null,
    diferidos: leyoSalud ? salud.stats.totals.deferred : null,
    cerradoEn: salud.blockedProviders,
    // El filtro por BLOCKED_MIN_ATTEMPTS no es cosmetico: acota el TAMANO del archivo. `byProvider`
    // trae una fila por dominio receptor visto, sin techo — 58 bandejas por cientos de receptores
    // inflarian el JSON que el panel sirve entero. 20 es exactamente el minimo de intentos que el
    // propio clasificador exige para emitir un veredicto, asi que abajo de eso no hay decision que
    // tomar. Se reusa la constante en vez de inventar un numero, para que no se puedan separar.
    //
    // Y suma los DIFERIDOS al conteo del filtro, aunque el clasificador no los cuente para su
    // `attempts`: si no, el receptor que solo difiere —el caso Yahoo, el que este campo existe para
    // destapar— quedaria filtrado por el mismo punto ciego que vino a arreglar.
    porReceptor: leyoSalud
      ? salud.stats.byProvider
          .filter((p) => p.delivered + p.blocked + p.deferred >= BLOCKED_MIN_ATTEMPTS)
          .map((p) => ({
            receptor: p.provider,
            entregados: p.delivered,
            rechazados: p.blocked,
            diferidos: p.deferred
          }))
      : [],
    picos: volumen.status === "ok"
      ? volumen.peakByFamily.map((p) => ({
          familia: p.family,
          dia: p.day,
          mensajes: p.messages,
          umbral: p.threshold,
          ratio: p.ratio
        }))
      : [],
    cruzados: volumen.status === "ok" ? volumen.overThreshold : [],
    cerca: volumen.status === "ok" ? volumen.nearThreshold : []
  };
}

/** Corre la medicion sobre la flota con concurrencia acotada y la persiste. */
export async function medirFlota(input: {
  workspace: OpenClawWorkspace;
  sshRunner: RunnerMedicion;
  bandejas: ReadonlyArray<{ domain: string; serverSlug: string; serverIp: string }>;
  concurrency?: number;
  now?: () => Date;
}): Promise<MedicionFlota> {
  const now = input.now ?? (() => new Date());
  const inicio = now().getTime();
  const concurrency = Math.max(1, input.concurrency ?? MEASUREMENT_CONCURRENCY);

  const resultados = new Array<MedicionBandeja>(input.bandejas.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= input.bandejas.length) return;
      const target = input.bandejas[index]!;
      try {
        resultados[index] = await medirBandeja({ sshRunner: input.sshRunner, ...target });
      } catch (error) {
        // Una bandeja que revienta no tumba la corrida, y NO se cuenta como sana.
        resultados[index] = {
          domain: target.domain,
          serverSlug: target.serverSlug,
          estado: "unreadable",
          detalle: error instanceof Error ? error.message : "fallo la medicion",
          ventana: "sin lectura",
          entregados: null,
          encolados: null,
          rechazados: null,
          diferidos: null,
          cerradoEn: [],
          picos: [],
          cruzados: [],
          cerca: []
        };
      }
    }
  };

  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, input.bandejas.length) }, () => worker())
  );

  const bandejas = resultados.filter(Boolean);

  // CRUCE PEGAJOSO. Cruzar el umbral permanente de Google es irreversible; olvidarlo NUNCA es
  // correcto. Pero `cruzados` viene de la lectura de VOLUMEN, que puede fallar (grep sin `## END`)
  // y entonces se persiste `[]` — indistinguible de "midio y no cruzo". Como cada corrida
  // sobreescribe el archivo entero, una lectura de volumen fallida borraria un cruce conocido y la
  // fabrica venderia verde un dominio quemado para siempre. Unimos con la corrida anterior: un
  // cruce solo se AGREGA (cuando el volumen lo lee sobre el umbral), nunca se quita.
  const previa = await leerUltimaMedicion(input.workspace);
  if (previa) {
    const cruzadosPrevios = new Map<string, ProviderFamily[]>();
    for (const b of previa.bandejas) {
      if (b.cruzados.length > 0) cruzadosPrevios.set(b.domain, b.cruzados);
    }
    for (const b of bandejas) {
      const antes = cruzadosPrevios.get(b.domain);
      if (antes) b.cruzados = [...new Set([...b.cruzados, ...antes])];
    }
  }

  const medicion: MedicionFlota = {
    medidoEn: now().toISOString(),
    duracionMs: now().getTime() - inicio,
    pedidas: input.bandejas.length,
    leidas: bandejas.filter((r) => r.estado !== "unreadable").length,
    bandejas
  };

  await input.workspace.updateInventoryJson<MedicionFlota>(MEASUREMENT_FILE, () => medicion);
  return medicion;
}

/** Lee la ultima medicion. `null` = nunca se midio, que NO es lo mismo que todo en cero. */
export async function leerUltimaMedicion(
  workspace: OpenClawWorkspace
): Promise<MedicionFlota | null> {
  const stored = await workspace
    .readInventoryJson<MedicionFlota>(MEASUREMENT_FILE)
    .catch(() => null);
  return stored && typeof stored.medidoEn === "string" ? stored : null;
}
