/**
 * Compliance status — contrato GET-only para la fila "Compliance row" del
 * panel de Seguridad. Devuelve 3 controles canónicos (privacy, operational,
 * sin acciones reales) con su estado actual en formato literal.
 */

export type ComplianceControlState = "ok" | "warning" | "info" | "critical";

export interface ComplianceControl {
  id: string;
  title: string;
  state: ComplianceControlState;
  lines: string[];
  runbookRef?: string;
}

export interface ComplianceStatusContract {
  controls: ComplianceControl[];
}

const CONTROLS: readonly ComplianceControl[] = Object.freeze([
  {
    id: "gdpr",
    title: "GDPR · Privacidad",
    state: "ok" as ComplianceControlState,
    lines: [
      "Sin envíos reales · no hay datos PII fluyendo",
      "Cookies del panel: solo sesión local, no analítica",
      "Audit log encriptado en reposo · SHA-256 encadenado"
    ],
    runbookRef: "privacy-runbook.md"
  },
  {
    id: "operational",
    title: "Cumplimiento operativo",
    state: "warning" as ComplianceControlState,
    lines: [
      "31 gates del MVP · 7 requieren revisión humana",
      "Dry-run obligatorio antes de cualquier escritura real",
      "Kill switch global probado en simulación"
    ],
    runbookRef: "operating-north-runbook.md"
  },
  {
    id: "anti-abuse",
    title: "Sin acciones reales",
    state: "info" as ComplianceControlState,
    lines: [
      "Panel GET-only · 0 mutaciones expuestas en el bundle",
      "SMTP, SSH, DNS, NFC y Proxmox bloqueados por norte",
      "Promoción de habilidades requiere panel humano de 4 firmas"
    ],
    runbookRef: "north-operativo.md"
  }
] as const);

export function buildComplianceStatus(): ComplianceStatusContract {
  return { controls: CONTROLS.map((c) => ({ ...c, lines: [...c.lines] })) };
}
