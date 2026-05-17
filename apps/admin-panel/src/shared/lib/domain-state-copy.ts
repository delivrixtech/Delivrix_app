/**
 * Domain-state copy: microcopy UI derivada de estados ya expuestos por contrato.
 *
 * Regla de propiedad:
 *  - `packages/domain` decide gates, permisos, severidad operacional y categoria.
 *  - `client.ts` tipa el contrato GET tal cual lo devuelve el Gateway.
 *  - `formatters.ts` ofrece helpers genericos (humanize, stateTone, fechas, numeros).
 *  - este archivo traduce booleanos / enums del contrato a copy de presentacion.
 *  - los componentes shared/ui no conocen dominio: solo renderizan.
 *
 * Cuando un microcopy aqui represente una decision operacional nueva (no la
 * presentacion de un estado ya existente), mover esa decision al contrato y dejar
 * este archivo solo con la traduccion.
 */

import type { Tone } from "./formatters.ts";

export interface StateCopy {
  copy: string;
  tone: Tone;
}

interface BinaryStateCopy {
  enabled: StateCopy;
  disabled: StateCopy;
}

const ON: Tone = "critical";
const OFF: Tone = "success";

export const safetyCopy = {
  liveInfrastructureWrites: {
    enabled: { copy: "Riesgo: writes en vivo", tone: ON },
    disabled: { copy: "Solo dry-run en MVP", tone: OFF }
  } satisfies BinaryStateCopy,
  delivrixSendsRealEmail: {
    enabled: { copy: "Esta enviando correo real", tone: ON },
    disabled: { copy: "Solo simulacion", tone: OFF }
  } satisfies BinaryStateCopy,
  nfcProductionWrites: {
    enabled: { copy: "Productivo — revisar contrato", tone: ON },
    disabled: { copy: "Bridge en mock", tone: OFF }
  } satisfies BinaryStateCopy,
  killSwitchActive: {
    enabled: { copy: "Detenido por intervencion humana", tone: ON },
    disabled: { copy: "Listo para activar si hace falta", tone: OFF }
  } satisfies BinaryStateCopy
};

export const learningCopy = {
  canSelfPromote: {
    enabled: { copy: "Riesgo: modelo se auto-asciende", tone: ON },
    disabled: { copy: "Modelo no se auto-asciende", tone: OFF }
  } satisfies BinaryStateCopy,
  requiresHumanApproval: {
    enabled: { copy: "Barandilla activa", tone: OFF },
    disabled: { copy: "Sin revisor humano", tone: ON }
  } satisfies BinaryStateCopy
};

export const hardwareCopy = {
  capacityField: {
    known: { copy: "Snapshot vigente", tone: "success" as Tone },
    unknown: { copy: "Esperando snapshot manual", tone: "warning" as Tone }
  }
};

export const collectorCopy = {
  panelWrites: {
    enabled: { copy: "UI puede mutar — revisar", tone: ON },
    disabled: { copy: "Read-only enforced", tone: OFF }
  } satisfies BinaryStateCopy
};

/**
 * Helpers que mapean un valor del contrato a su StateCopy.
 * Permiten que la UI escriba `pickBinary(safetyCopy.liveInfrastructureWrites, value)`
 * sin importar ON/OFF como literales.
 */
export function pickBinary(map: BinaryStateCopy, value: boolean): StateCopy {
  return value ? map.enabled : map.disabled;
}

export function pickCapacityCopy(value: number | null): StateCopy {
  return value === null ? hardwareCopy.capacityField.unknown : hardwareCopy.capacityField.known;
}
