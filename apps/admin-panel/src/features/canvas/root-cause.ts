/**
 * Root-cause copy del Canvas.
 *
 * La decision operacional de categoria/severidad vive en
 * `OpenClawCanvasPayload.blockedBy[*]`. Este modulo solo redacta el banner
 * visual cuando los bloqueos categorizados por el contrato apuntan a hardware.
 */

export interface RootCauseNotice {
  title: string;
  description: string;
}

export function describeHardwareRootCause(
  totalBlockers: number,
  hardwareBlockerCount: number
): RootCauseNotice {
  return {
    title: "Causa raiz: snapshot de hardware pendiente",
    description: `Ingestar un snapshot via POST /v1/devops/collector/manual-snapshots/ingest libera la mayoria de los ${totalBlockers} bloqueos (${hardwareBlockerCount} estan en hardware).`
  };
}
