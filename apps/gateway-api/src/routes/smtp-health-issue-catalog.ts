/**
 * Catálogo versionado "error → solución sugerida" para la vista de salud SMTP (drill-down read-only).
 *
 * Fuente única de textos compartida por el panel y por OpenClaw: dado un `code` de issue detectado por
 * `buildAccountSmtpHealth`, devuelve severidad + mensaje + una `suggestedFix` puramente informativa
 * (NUNCA un botón de acción: la vista de salud es read-only, el agente no actúa desde ahí).
 *
 * Los mensajes admiten placeholders `{campo}` que se rellenan con `params` en `buildSmtpHealthIssue`.
 * Los 5 errores reales del incidente 2026-07-13 (I1–I5 + O8) están cubiertos; el resto es hardening.
 */

export type SmtpHealthIssueSeverity = "info" | "warning" | "error" | "critical";

export interface SmtpHealthSuggestedFix {
  /** Tipo de remediación sugerida (informativo; el panel NO ejecuta nada). */
  kind: string;
  /** Texto read-only que describe qué haría un operador. */
  text: string;
  /** Referencia a incidente/documento (I1..I9, O8, §…). */
  docRef?: string;
}

export interface SmtpHealthIssue {
  code: string;
  severity: SmtpHealthIssueSeverity;
  message: string;
  suggestedFix: SmtpHealthSuggestedFix;
}

interface SmtpHealthIssueTemplate {
  severity: SmtpHealthIssueSeverity;
  message: string;
  suggestedFix: SmtpHealthSuggestedFix;
}

export type SmtpHealthIssueCode =
  | "stale_run_lock"
  | "unknown_vps_provider"
  | "plan_scope_mismatch_require_existing_domain"
  | "domain_purchased_without_smtp"
  | "domain_registration_pending"
  | "resume_scope_drift_brand"
  | "webdock_account_alias"
  | "ambiguous_domain_multi_server"
  | "credential_without_server"
  | "server_without_domain"
  | "smtp_server_down";

/**
 * Mapa canónico code → template. Ordenado por relevancia operativa. Los placeholders `{x}` se
 * resuelven con `params` en `buildSmtpHealthIssue` (si falta un valor, el placeholder queda literal
 * pero legible, p. ej. `{runId}`).
 */
export const SMTP_HEALTH_ISSUE_CATALOG: Record<SmtpHealthIssueCode, SmtpHealthIssueTemplate> = {
  stale_run_lock: {
    severity: "warning",
    message:
      "Lock huérfano de run interrumpido ({runId}): el proceso que lo tomó ya no corre pero el lock sigue en disco.",
    suggestedFix: {
      kind: "clear_stale_lock",
      text:
        "Lock huérfano de run interrumpido: eliminar `.locks/run-{runId}.lock` tras verificar que el pid no corre; luego retomar el run {runId}. El barrido de arranque ya limpia estos locks al reiniciar el gateway.",
      docRef: "I1"
    }
  },
  unknown_vps_provider: {
    severity: "error",
    message: "El provider {provider} no tiene adapter/credenciales cargadas en el gateway.",
    suggestedFix: {
      kind: "complete_provider_credentials",
      text:
        "El provider {provider} no tiene credenciales cargadas en config/gateway.env (drift con .env.local). Agregar las vars del provider al env canónico y reiniciar; el preflight de firma ya rechaza firmar un plan con este provider ANTES de comprar dominio.",
      docRef: "I3"
    }
  },
  plan_scope_mismatch_require_existing_domain: {
    severity: "warning",
    message:
      "Plan firmado con requireExistingDomain distinto al estado del run {runId} (post-compra).",
    suggestedFix: {
      kind: "resume_reconciles",
      text:
        "Run interrumpido post-compra: el resume ya reconcilia requireExistingDomain con el estado cuando el paso de compra está `done` (no re-firmar). Si el paso 2 aún no corrió, corregir el flag del plan a coincidir con el estado.",
      docRef: "I4"
    }
  },
  domain_purchased_without_smtp: {
    severity: "error",
    message:
      "Dominio {domain} comprado (${costUsd}) pero el run {runId} no terminó el SMTP (último paso {lastCompletedStep}).",
    suggestedFix: {
      kind: "resume_run",
      text:
        "Dominio pagado sin SMTP terminado. Retomar el run {runId} (último paso completado: {lastCompletedStep}) en vez de comprar otro dominio; el guard de compras huérfanas ya frena repetir la sangría.",
      docRef: "I2"
    }
  },
  domain_registration_pending: {
    severity: "warning",
    message: "Registración del dominio {domain} pendiente en el registrar (Route53).",
    suggestedFix: {
      kind: "wait_and_verify",
      text:
        "Registración Route53 pendiente; el ownership check dará resultados inconsistentes. Esperar confirmación del registrar y reverificar antes de firmar planes nuevos sobre {domain}.",
      docRef: "O8"
    }
  },
  resume_scope_drift_brand: {
    severity: "warning",
    message: "Resume del run {runId} con brand/intent distinto al estado persistido ({brand}).",
    suggestedFix: {
      kind: "resume_with_persisted_scope",
      text:
        "Reintentar el resume con brand/intent EXACTOS del estado del run ({brand}); no cambiar de marca ante un bloqueo. El resume ya pisa brand/intent desde el estado.",
      docRef: "I5"
    }
  },
  webdock_account_alias: {
    severity: "info",
    message: "Alias de credencial detectado: {role} = {canonicalRole} (misma cuenta física).",
    suggestedFix: {
      kind: "clean_env_alias",
      text:
        "Alias de credencial detectado ({role} = {canonicalRole}): limpiar las vars legacy del env; el inventario ya deduplicó por fingerprint automáticamente.",
      docRef: "I7"
    }
  },
  ambiguous_domain_multi_server: {
    severity: "error",
    message: "El dominio {domain} tiene más de un server SMTP configured a la vez.",
    suggestedFix: {
      kind: "resolve_ambiguous_domain",
      text:
        "Dominio con >1 server configured: resolver con resolve_ambiguous_smtp_domain (marca superseded al perdedor) para dejar un único SMTP canónico.",
      docRef: "§3.5"
    }
  },
  credential_without_server: {
    severity: "warning",
    message: "La credencial SMTP de {domain} apunta a un server inexistente ({serverSlug}).",
    suggestedFix: {
      kind: "retire_or_reprovision",
      text:
        "Credencial SMTP apunta a un server inexistente ({serverSlug}): retirar la entrada o re-provisionar el server antes de volver a usarla.",
      docRef: "§3.5"
    }
  },
  server_without_domain: {
    severity: "warning",
    message: "El server {serverSlug} está vivo pero sin dominio ni SMTP asociado.",
    suggestedFix: {
      kind: "bind_or_retire",
      text:
        "Server vivo sin dominio bound ni entry SMTP: adoptarlo para un dominio nuevo o darlo de baja si quedó huérfano de un run interrumpido.",
      docRef: "§3.2"
    }
  },
  smtp_server_down: {
    severity: "error",
    message: "El server {serverSlug} con SMTP configured no está `running` en la flota viva.",
    suggestedFix: {
      kind: "check_server_liveness",
      text:
        "Server con SMTP configured caído o ausente de la flota viva: verificar el estado del VPS en el provider; si fue retirado, retirar también el SMTP del inventario.",
      docRef: "§3.2"
    }
  }
};

export function isKnownSmtpHealthIssueCode(code: string): code is SmtpHealthIssueCode {
  return Object.prototype.hasOwnProperty.call(SMTP_HEALTH_ISSUE_CATALOG, code);
}

/**
 * Resuelve un issue del catálogo rellenando placeholders `{x}` con `params`. Puro y determinista:
 * el mismo `code` + `params` produce siempre el mismo issue, para que panel y OpenClaw compartan
 * textos idénticos.
 */
export function buildSmtpHealthIssue(
  code: SmtpHealthIssueCode,
  params: Record<string, string | number | undefined> = {}
): SmtpHealthIssue {
  const template = SMTP_HEALTH_ISSUE_CATALOG[code];
  return {
    code,
    severity: template.severity,
    message: fillTemplate(template.message, params),
    suggestedFix: {
      kind: template.suggestedFix.kind,
      text: fillTemplate(template.suggestedFix.text, params),
      ...(template.suggestedFix.docRef ? { docRef: template.suggestedFix.docRef } : {})
    }
  };
}

function fillTemplate(text: string, params: Record<string, string | number | undefined>): string {
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined || value === null || value === "" ? match : String(value);
  });
}
