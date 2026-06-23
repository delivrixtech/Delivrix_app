export function buildEnableSmtpAuthIntent(domain: string): { prompt: string; source: string } {
  const normalizedDomain = domain.trim().toLowerCase().replace(/\.$/, "");
  return {
    prompt: `Genera la credencial SMTP AUTH para el dominio ${normalizedDomain} (un solo dominio). Propone la accion para mi aprobacion; no la ejecutes sin mi visto bueno.`,
    source: `sender-pool:enable-smtp-auth:${normalizedDomain}`
  };
}
