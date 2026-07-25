// Verificación de propiedad de un nodo SMTP — el antídoto del falso negativo
// "17 nodos ya no son tuyos".
//
// El backfill del acceso ops se corrió una vez desde un script suelto que traía su
// propia verificación con `root@<ip>` hardcodeado. El runner de producción no se
// conecta así: `resolveSmtpSshTarget` elige `root` en Contabo y `delivrixops` + sudo
// en el resto. Resultado: los 15 nodos Webdock devolvieron `Permission denied
// (publickey)`, el script lo leyó como "no es tuyo", y 14 nodos vivos quedaron sin
// acceso — reportados como IPs ajenas.
//
// Dos reglas salen de ahí, y son la razón de existir de este módulo:
//   1. La verificación corre por el MISMO `SmtpSshRunner` que provisiona, así hereda
//      usuario y sudo por provider y no puede volver a divergir.
//   2. El comando sale SIEMPRE 0 y comunica el veredicto por marcadores en stdout.
//      `runSshCommand` rechaza con Error ante cualquier exit != 0 (un `Permission
//      denied` es 255), así que si el veredicto viajara en el exit code, "no pude
//      llegar" volvería a colapsar en "no es tuyo". Un probe que no pudo correr es
//      `undetermined` — NUNCA un falso `not_owned`.

/** `owned` habilita provisionar. `not_owned` y `undetermined` NO. */
export type NodeOwnershipStatus = "owned" | "not_owned" | "undetermined";

export interface NodeOwnershipVerdict {
  status: NodeOwnershipStatus;
  /** `smtp.<dominio>`: lo que el nodo tiene que declarar para ser suyo. */
  expectedHostname: string;
  /** `postconf -h myhostname`. null = no se pudo leer. */
  hostname: string | null;
  /** `/etc/mailname`, señal secundaria que escribe el propio provisioning. null = ausente. */
  mailname: string | null;
  /** Existe `/etc/opendkim/keys/<dominio>`. null = no se pudo determinar. */
  dkimKeysPresent: boolean | null;
  /** Evidencia legible, o el error de SSH cuando el probe no corrió. */
  detail: string;
  /** Pista accionable cuando el fallo huele a usuario/llave equivocados. */
  hint?: string;
}

/**
 * Interfaz angosta a propósito: `SmtpSshRunner` es asignable sin importarlo (evita el
 * ciclo con routes/smtp-provisioning.ts). `serverSlug` es obligatorio porque es lo que
 * hace que el runner resuelva root vs delivrixops+sudo — el dato cuya ausencia causó el bug.
 */
export interface NodeOwnershipSshRunner {
  run(input: {
    serverSlug?: string | null;
    serverIp: string;
    command: string;
    timeoutMs?: number;
  }): Promise<{ stdout: string; exitCode: number | null }>;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const POSTCONF_UNAVAILABLE = "__POSTCONF_UNAVAILABLE__";
const NO_MAILNAME = "__NO_MAILNAME__";
const DKIM_PRESENT = "__DKIM_PRESENT__";
const DKIM_ABSENT = "__DKIM_ABSENT__";

export function smtpHostnameForDomain(domain: string): string {
  return `smtp.${domain.trim().toLowerCase().replace(/\.$/, "")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Comando del probe. Sin `set -e` y con `|| echo <marcador>` en cada lectura: tiene que
 * terminar en 0 aunque falte postfix, falte opendkim o no exista el directorio. El
 * marcador `## END` es la prueba de que la salida llegó completa.
 */
export function buildNodeOwnershipCommand(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(normalized)) {
    throw new Error(`invalid domain for ownership probe: ${domain}`);
  }
  const keyDir = `/etc/opendkim/keys/${normalized}`;
  return [
    "set -u",
    "echo '## HOSTNAME'",
    `postconf -h myhostname 2>/dev/null || /usr/sbin/postconf -h myhostname 2>/dev/null || echo '${POSTCONF_UNAVAILABLE}'`,
    "echo '## MAILNAME'",
    `cat /etc/mailname 2>/dev/null || echo '${NO_MAILNAME}'`,
    "echo '## DKIM'",
    `if [ -d ${shellQuote(keyDir)} ]; then echo '${DKIM_PRESENT}'; else echo '${DKIM_ABSENT}'; fi`,
    "echo '## END'"
  ].join("\n");
}

function section(text: string, name: string): string {
  const start = text.indexOf(`## ${name}`);
  if (start === -1) return "";
  const rest = text.slice(start + `## ${name}`.length);
  const nextMarker = rest.indexOf("## ");
  return (nextMarker === -1 ? rest : rest.slice(0, nextMarker)).trim();
}

function normalizeHost(value: string): string | null {
  const first = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
  if (!first) return null;
  if (first === POSTCONF_UNAVAILABLE || first === NO_MAILNAME) return null;
  return first.toLowerCase().replace(/\.$/, "");
}

export function parseNodeOwnership(stdout: string, domain: string): NodeOwnershipVerdict {
  const expectedHostname = smtpHostnameForDomain(domain);

  // Sin `## END` la salida se truncó (timeout, kill, buffer): no alcanza para acusar.
  if (!stdout.includes("## END")) {
    return {
      status: "undetermined",
      expectedHostname,
      hostname: null,
      mailname: null,
      dkimKeysPresent: null,
      detail: "salida del probe incompleta (falta el marcador ## END)"
    };
  }

  const hostname = normalizeHost(section(stdout, "HOSTNAME"));
  const mailname = normalizeHost(section(stdout, "MAILNAME"));
  const dkimText = section(stdout, "DKIM");
  const dkimKeysPresent = dkimText.includes(DKIM_PRESENT)
    ? true
    : dkimText.includes(DKIM_ABSENT)
      ? false
      : null;

  const base = { expectedHostname, hostname, mailname, dkimKeysPresent };

  // El probe corrió pero no devolvió señal utilizable: tampoco alcanza.
  if (hostname === null && mailname === null) {
    return {
      ...base,
      status: "undetermined",
      detail: "el nodo no reportó ni myhostname ni /etc/mailname"
    };
  }
  if (dkimKeysPresent === null) {
    return {
      ...base,
      status: "undetermined",
      detail: "no se pudo determinar si existen las claves DKIM del dominio"
    };
  }

  // /etc/mailname vale como respaldo: lo escribe el mismo provisioning con el mismo
  // valor, así que cubre el caso de un main.cf reescrito a mano sin debilitar el gate
  // (el directorio DKIM del dominio sigue siendo obligatorio).
  const hostnameMatches = hostname === expectedHostname || mailname === expectedHostname;

  if (hostnameMatches && dkimKeysPresent) {
    return {
      ...base,
      status: "owned",
      detail: `myhostname=${hostname ?? "—"} mailname=${mailname ?? "—"} dkim=present`
    };
  }

  return {
    ...base,
    status: "not_owned",
    detail: !hostnameMatches
      ? `el nodo se declara ${hostname ?? mailname ?? "—"}, no ${expectedHostname}`
      : `no existe /etc/opendkim/keys/${domain} en el nodo`
  };
}

/**
 * Corre el probe de propiedad por el runner de provisioning. Best-effort: nunca tira.
 * Un SSH que falla es `undetermined` (jamás `not_owned`), que es exactamente la
 * distinción que el script viejo perdía.
 */
export async function verifyNodeOwnership(input: {
  sshRunner: NodeOwnershipSshRunner;
  domain: string;
  serverSlug: string;
  serverIp: string;
  timeoutMs?: number;
}): Promise<NodeOwnershipVerdict> {
  const expectedHostname = smtpHostnameForDomain(input.domain);
  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: buildNodeOwnershipCommand(input.domain),
      timeoutMs: input.timeoutMs ?? 30_000
    });
    return parseNodeOwnership(result.stdout, input.domain);
  } catch (error) {
    const message = errorMessage(error);
    return {
      status: "undetermined",
      expectedHostname,
      hostname: null,
      mailname: null,
      dkimKeysPresent: null,
      detail: `ownership_probe_failed: ${message}`,
      hint: ownershipFailureHint(message)
    };
  }
}

/** Reconciliación de la IP del inventario contra el DNS de `smtp.<dominio>`. */
export interface NodeIpReconciliation {
  inventoryIp: string;
  dnsIps: string[];
  dnsIp: string | null;
  status: "match" | "mismatch" | "dns_unresolved";
}

export async function reconcileNodeIp(input: {
  domain: string;
  inventoryIp: string;
  resolve4: (host: string) => Promise<string[]>;
}): Promise<NodeIpReconciliation> {
  const host = smtpHostnameForDomain(input.domain);
  let dnsIps: string[] = [];
  try {
    dnsIps = (await input.resolve4(host)).filter((ip) => typeof ip === "string" && ip.trim());
  } catch {
    dnsIps = [];
  }
  if (dnsIps.length === 0) {
    return { inventoryIp: input.inventoryIp, dnsIps, dnsIp: null, status: "dns_unresolved" };
  }
  const status = dnsIps.includes(input.inventoryIp) ? "match" : "mismatch";
  return { inventoryIp: input.inventoryIp, dnsIps, dnsIp: dnsIps[0] ?? null, status };
}

function ownershipFailureHint(message: string): string | undefined {
  if (/permission denied/i.test(message)) {
    return "SSH rechazó la llave: revisá SMTP_PROVISION_SSH_USER y la llave del provider (Contabo entra como root; Webdock como delivrixops + sudo). NO es evidencia de que el nodo no sea tuyo.";
  }
  if (/timed out|timeout/i.test(message)) {
    return "el nodo no respondió a tiempo: puede estar apagado o filtrado. NO es evidencia de que no sea tuyo.";
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
