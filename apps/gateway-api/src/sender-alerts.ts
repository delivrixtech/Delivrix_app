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
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

export type AlertSeverity = "critical" | "high" | "warning";

export type AlertKind =
  | "umbral_cruzado"
  | "rampa_pausada"
  | "cola_atascada"
  | "bloqueada"
  | "rechazo_parcial"
  | "cerca_umbral";

export interface SenderAlert {
  domain: string;
  severity: AlertSeverity;
  kind: AlertKind;
  detail: string;
}

export interface AlertsFlota {
  medidoEn: string | null;
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

  const alerts = cuota.bandejas.flatMap(alertasDeBandeja);
  alerts.sort((a, b) =>
    ORDEN[a.severity] !== ORDEN[b.severity]
      ? ORDEN[a.severity] - ORDEN[b.severity]
      : a.domain.localeCompare(b.domain)
  );

  const conteos: Record<AlertSeverity, number> = { critical: 0, high: 0, warning: 0 };
  for (const a of alerts) conteos[a.severity] += 1;

  return {
    medidoEn: cuota.medidoEn,
    conteos,
    alerts,
    parcial: cuota.parcial
  };
}
