// Las alertas de la flota: el tercer consumidor de la espina event-driven (feed · rollups · ALERTAS).
//
// No es un sensor nuevo: es una LECTURA de lo ya medido. Toma la cuota (que ya fusiona inventario +
// última medición + rampas) y destila lo que necesita acción del operador AHORA, rankeado. Barato
// y siempre disponible: JSON local, sin SSH, no se cae — igual que la cuota y el inventario.
//
// La severidad se CALCULA, no se elige (misma disciplina que el semáforo). Y el orden es el del
// riesgo: primero lo irreversible (el umbral permanente de Google), después lo que frena hoy, al
// final lo que solo avisa.

import { armarCuotaFlota, resolverTecho, type CuotaBandeja } from "./sender-quota.ts";
import { CAP_MEASUREMENT_FILE, CERCA_DEL_CAP, type CapFlota, type CapNodo } from "./node-daily-cap.ts";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

export type AlertSeverity = "critical" | "high" | "warning";

export type AlertKind =
  | "umbral_cruzado"
  | "rampa_pausada"
  | "cola_atascada"
  | "bloqueada"
  | "sin_lectura"
  | "rechazo_parcial"
  | "cerca_umbral"
  | "cap_alcanzado"
  | "cerca_del_cap"
  | "sin_limite_fisico";

export interface SenderAlert {
  domain: string;
  severity: AlertSeverity;
  kind: AlertKind;
  detail: string;
}

export interface AlertsFlota {
  medidoEn: string | null;
  /** Cuándo se leyó el límite físico de la flota. `null` = nunca se corrió (la pantalla lo dice). */
  capMedidoEn: string | null;
  /** Conteo por severidad: el titular ("2 críticas, 5 altas"). */
  conteos: Record<AlertSeverity, number>;
  alerts: SenderAlert[];
  /** true si la lectura de base fue parcial: la pantalla lo rotula. */
  parcial: boolean;
}

const ORDEN: Record<AlertSeverity, number> = { critical: 0, high: 1, warning: 2 };

/**
 * Destila las alertas de UNA bandeja ya evaluada. Función pura. Una bandeja puede disparar más de
 * una alerta (cruzó el umbral EN google Y está cerca en yahoo): se emiten todas, cada una con su
 * severidad. El cruce del umbral permanente es siempre `critical` — es lo único irreversible.
 */
export function alertasDeBandeja(b: CuotaBandeja): SenderAlert[] {
  const out: SenderAlert[] = [];

  if (b.cruzados.length > 0) {
    out.push({
      domain: b.domain,
      severity: "critical",
      kind: "umbral_cruzado",
      detail: `cruzó el umbral permanente en ${b.cruzados.join(", ")} — irreversible`
    });
  }
  // La rampa auto-pausada por un freno (rebote/placement) es acción urgente, no un aviso.
  if (b.rampa?.estado === "auto_paused") {
    out.push({
      domain: b.domain,
      severity: "high",
      kind: "rampa_pausada",
      detail: `warmup auto-pausado: ${b.rampa.pauseReason ?? "sin motivo registrado"}`
    });
  }
  // `|| fallback`, no `?? fallback`: un `motivo` vacío ("") es tan inútil como null para el operador
  // — se cae al texto genérico igual, nunca se muestra un detail en blanco.
  if (b.estado === "cola atascada") {
    out.push({ domain: b.domain, severity: "high", kind: "cola_atascada", detail: b.motivo || "la cola se acumula" });
  }
  if (b.estado === "bloqueada") {
    out.push({ domain: b.domain, severity: "high", kind: "bloqueada", detail: b.motivo || "cerrada en el receptor" });
  }
  // La medición corrió pero el nodo no se pudo leer: la firma del modo de falla real "nodo vivo
  // pero incomunicado" (el proveedor lo da running y solo un chequeo externo lo ve caído). Se
  // mira el flag `sinLectura`, NO el estado: una rampa corriendo tapa el estado "sin lectura" en
  // el semáforo, y un nodo incomunicado que está calentando es justo el que más urge mirar.
  if (b.sinLectura) {
    out.push({ domain: b.domain, severity: "high", kind: "sin_lectura", detail: b.sinLectura.motivo || "la medición no pudo leer el nodo" });
  }
  if (b.estado === "rechazo parcial") {
    out.push({ domain: b.domain, severity: "warning", kind: "rechazo_parcial", detail: b.motivo || "rechazo parcial" });
  }
  // Cerca del umbral: aviso, no freno — pero SOLO si no cruzó ya (si cruzó, la crítica lo cubre).
  if (b.cruzados.length === 0 && b.cerca.length > 0) {
    out.push({
      domain: b.domain,
      severity: "warning",
      kind: "cerca_umbral",
      detail: `arriba del 40% del umbral en ${b.cerca.join(", ")}`
    });
  }

  return out;
}

/**
 * Alertas del LÍMITE FÍSICO de un nodo. Función pura.
 *
 * Son otra familia que las de arriba: aquellas miran la ENTREGA (lo que el receptor hace con el
 * correo), estas miran la PUERTA (cuánto entró al nodo y si la puerta sigue puesta). Un nodo puede
 * estar entregando perfecto y aun así haber agotado su cupo del día.
 */
export function alertasDeCap(nodo: CapNodo, opciones: { contadorDelDia?: boolean } = {}): SenderAlert[] {
  // El contador se reinicia a medianoche UTC. Una lectura de OTRO día no está "vieja": está MAL —
  // diría "tocó el techo" sobre un contador que hoy arranca en cero, y callaría los que sí lo
  // tocaron hoy. Lo que NO depende del día es si el límite está puesto: eso se sigue evaluando.
  const delDia = opciones.contadorDelDia ?? true;
  // Un nodo que perdió el límite es urgente aunque no esté enviando: es una regresión de config
  // que lo deja otra vez sin techo, y quedarse callado es cómo se vuelve al estado anterior.
  if (!nodo.cableado) {
    return [
      {
        domain: nodo.domain,
        severity: "high",
        kind: "sin_limite_fisico",
        detail: nodo.motivo || "el nodo no tiene el límite físico puesto"
      }
    ];
  }
  // Cableado PERO con el cap ilegible es el peor estado que sabe reportar el status: el policy
  // service lee cap 0 y difiere el 100% del correo. No se puede calcular un porcentaje, pero el
  // silencio sería la peor respuesta — el nodo está frenado del todo y nadie se entera.
  if (nodo.cap === null) {
    return [
      {
        domain: nodo.domain,
        severity: "high",
        kind: "sin_limite_fisico",
        detail: "cap ilegible en el nodo: el policy service está difiriendo TODO el correo"
      }
    ];
  }
  // Sin contador no se inventa un porcentaje (y "sin contador" NO es "no envió nada").
  if (nodo.consumidoHoy === null) return [];
  // Lectura de otro día: el límite está puesto (ya se verificó arriba), pero el consumo no se
  // puede afirmar. Callar el número es lo honesto; la pantalla declara la fecha de la corrida.
  if (!delDia) return [];

  if (nodo.consumidoHoy >= nodo.cap) {
    return [
      {
        domain: nodo.domain,
        severity: "high",
        kind: "cap_alcanzado",
        detail: `tocó el techo del día: ${nodo.consumidoHoy}/${nodo.cap} — lo que llegue se difiere`
      }
    ];
  }
  if (nodo.consumidoHoy >= nodo.cap * CERCA_DEL_CAP) {
    return [
      {
        domain: nodo.domain,
        severity: "warning",
        kind: "cerca_del_cap",
        detail: `${nodo.consumidoHoy}/${nodo.cap} del cupo diario`
      }
    ];
  }
  return [];
}

/** Arma las alertas de toda la flota desde la cuota (JSON local). No dispara medición ni SSH. */
export async function armarAlertasFlota(input: {
  workspace: OpenClawWorkspace;
  techo?: number;
  now?: () => Date;
}): Promise<AlertsFlota> {
  const cuota = await armarCuotaFlota({
    workspace: input.workspace,
    techo: input.techo ?? resolverTecho(),
    ...(input.now ? { now: input.now } : {})
  });

  // El cap vive en su propio JSON (lo persiste la corrida de límite-físico). Si nunca se corrió,
  // no hay alertas de cap — y eso NO se disfraza de "todo bien": la pantalla muestra la fecha.
  const cap = await input.workspace.readInventoryJson<CapFlota>(CAP_MEASUREMENT_FILE).catch(() => null);

  // El contador vive por día UTC: una lectura de otro día no sirve para afirmar consumo.
  const ahora = (input.now ?? (() => new Date()))();
  const contadorDelDia =
    typeof cap?.medidoEn === "string" && cap.medidoEn.slice(0, 10) === ahora.toISOString().slice(0, 10);

  const alerts = [
    ...cuota.bandejas.flatMap(alertasDeBandeja),
    ...(Array.isArray(cap?.nodos) ? cap.nodos : []).flatMap((n) => alertasDeCap(n, { contadorDelDia }))
  ];
  alerts.sort((a, b) =>
    ORDEN[a.severity] !== ORDEN[b.severity]
      ? ORDEN[a.severity] - ORDEN[b.severity]
      : a.domain.localeCompare(b.domain)
  );

  const conteos: Record<AlertSeverity, number> = { critical: 0, high: 0, warning: 0 };
  for (const a of alerts) conteos[a.severity] += 1;

  return {
    medidoEn: cuota.medidoEn,
    capMedidoEn: cap?.medidoEn ?? null,
    conteos,
    alerts,
    parcial: cuota.parcial
  };
}
