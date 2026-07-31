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
  /** Que ventana cubren los numeros de entrega. Nunca es "hoy". */
  ventana: string;
  entregados: number | null;
  rechazados: number | null;
  diferidos: number | null;
  /** Receptores donde el nodo esta efectivamente cerrado. */
  cerradoEn: string[];
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
    rechazados: leyoSalud ? salud.stats.totals.blocked : null,
    diferidos: leyoSalud ? salud.stats.totals.deferred : null,
    cerradoEn: salud.blockedProviders,
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
