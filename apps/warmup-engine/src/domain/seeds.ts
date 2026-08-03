// Las SEMILLAS del warmup — núcleo determinista puro (sin I/O), como el resto de `domain/`.
//
// Vive acá y no en el gateway por la regla de organización del proyecto: el warmup es un módulo
// propio y su lógica no se mezcla con el gateway. El gateway conserva SOLO el adaptador (leer y
// escribir el inventario, y la cripto de la credencial), que es I/O suyo; las reglas viven acá.
//
// Que esto faltara tuvo un costo concreto y visible: la rotación quedó escrita DOS veces —una en
// el gateway y otra en el daemon— con dos juegos de tests que podían divergir en silencio. Un
// arreglo en una mitad no llegaba a la otra. Esta es la única copia.

/** Los proveedores que importan para reputación. Acompaña al enum de la migración v1. */
export type SeedProvider = "gmail" | "workspace" | "outlook" | "m365" | "yahoo" | "gmx" | "webde";

export const SEED_PROVIDERS: SeedProvider[] = ["gmail", "workspace", "outlook", "m365", "yahoo", "gmx", "webde"];

/**
 * Una semilla cumple DOS papeles, y solo uno necesita credencial:
 *
 *  - **destino** (siempre): nuestro nodo le manda correo. No hace falta ninguna clave.
 *  - **medición y señal** (solo con credencial): entrar al buzón para ver DÓNDE cayó y generar la
 *    señal que calienta — abrir, marcar importante, rescatar de spam.
 */
export type SeedAuth = "none" | "imap_password" | "gmail_oauth";

/**
 * Lo mínimo que las reglas necesitan saber de una semilla. El registro del gateway guarda más
 * (IMAP, secreto cifrado, notas), pero nada de eso cambia a quién se le manda ni quién puede medir.
 */
export interface SeedBase {
  address: string;
  provider: string;
  enabled: boolean;
  auth: SeedAuth;
}

/** Host IMAP por proveedor. El operador puede pisarlo; esto hace corto el caso normal. */
export const IMAP_POR_PROVEEDOR: Record<SeedProvider, { host: string; port: number }> = {
  gmail: { host: "imap.gmail.com", port: 993 },
  workspace: { host: "imap.gmail.com", port: 993 },
  outlook: { host: "outlook.office365.com", port: 993 },
  m365: { host: "outlook.office365.com", port: 993 },
  yahoo: { host: "imap.mail.yahoo.com", port: 993 },
  gmx: { host: "imap.gmx.com", port: 993 },
  webde: { host: "imap.web.de", port: 993 }
};

/**
 * SMTP saliente por proveedor: la semilla no solo recibe, tambien RESPONDE — y una respuesta desde
 * el buzon del receptor es la senal bidireccional mas fuerte del warmup. Mismo app password.
 */
export const SMTP_POR_PROVEEDOR: Record<SeedProvider, { host: string; port: number }> = {
  gmail: { host: "smtp.gmail.com", port: 587 },
  workspace: { host: "smtp.gmail.com", port: 587 },
  outlook: { host: "smtp-mail.outlook.com", port: 587 },
  m365: { host: "smtp.office365.com", port: 587 },
  yahoo: { host: "smtp.mail.yahoo.com", port: 587 },
  gmx: { host: "mail.gmx.com", port: 587 },
  webde: { host: "smtp.web.de", port: 587 }
};

/** Las que sirven de DESTINO: alcanza con estar habilitadas. */
export function semillasActivas<T extends SeedBase>(seeds: T[]): T[] {
  return seeds.filter((s) => s.enabled);
}

/**
 * Las que además pueden MEDIR placement y generar señal.
 *
 * La diferencia no es cosmética: mandar a una semilla sin credencial genera tráfico pero no enseña
 * nada — no sabés si cayó en inbox o en spam, y no podés rescatarlo. Quien gatee una rampa por
 * placement tiene que mirar ESTA lista.
 */
export function semillasMedibles<T extends SeedBase>(seeds: T[]): T[] {
  return seeds.filter((s) => s.enabled && s.auth !== "none");
}

/**
 * Elige la semilla de una vuelta.
 *
 * Dos reglas, las dos aprendidas de corridas reales:
 *
 *  1. **Prioriza las que MIDEN.** Lo cazó la primera prueba real del daemon: con 3 de 4 semillas
 *     sin credencial, la rotación eligió una solo-destino y la vuelta no produjo placement — el
 *     dato que gatea toda la rampa. Una vuelta sin medición es media vuelta. Las solo-destino
 *     quedan de reserva para cuando no haya ninguna que mida.
 *  2. **Rota por (dominio, vuelta).** Un dominio recorre todas las semillas disponibles (si le
 *     pegara siempre a la misma, nunca mediría otros proveedores) y el desfase por dominio evita
 *     que todos los nodos golpeen la misma casilla en la misma vuelta — que es la huella a evitar.
 */
export function elegirSemilla<T extends SeedBase>(seeds: T[], domain: string, vuelta: number): T | null {
  const medibles = semillasMedibles(seeds);
  const candidatas = medibles.length > 0 ? medibles : semillasActivas(seeds);
  if (candidatas.length === 0) return null;
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return candidatas[Math.abs(hash + vuelta) % candidatas.length] ?? null;
}

/**
 * Cobertura de MEDICIÓN por proveedor. Cuenta solo las que miden: una semilla sin credencial no da
 * cobertura de nada aunque reciba correo, y reportarla haría creer que medís Yahoo cuando no.
 */
export function coberturaPorProveedor<T extends SeedBase>(seeds: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of semillasMedibles(seeds)) out[s.provider] = (out[s.provider] ?? 0) + 1;
  return out;
}

/** Proveedores clave sin semilla que mida: ahí no sabemos dónde cae el correo. */
export const PROVEEDORES_CLAVE = ["gmail", "outlook", "yahoo"];

export function puntoCiego<T extends SeedBase>(seeds: T[]): string[] {
  const cobertura = coberturaPorProveedor(seeds);
  return PROVEEDORES_CLAVE.filter((p) => !cobertura[p]);
}

export class WarmupSeedError extends Error {}

export function normalizarDireccion(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Proveedores donde un APP PASSWORD ya no sirve, verificado contra la documentación oficial
 * (2026-08-03):
 *
 *  - **Outlook.com personal**: Microsoft retiró Basic Auth el 16/09/2024. La página oficial de
 *    settings dice que IMAP, POP y SMTP requieren OAuth2. No hay flag para revivirlo.
 *  - **Microsoft 365**: Basic Auth para IMAP/POP está deshabilitado en TODOS los tenants y
 *    "nadie (ni vos ni el soporte de Microsoft) puede re-habilitarlo".
 *
 * Se rechaza en el alta en vez de dejar que el probe falle: el error de IMAP sería
 * `AUTHENTICATIONFAILED`, que manda a revisar la contraseña — y la contraseña no es el problema.
 * Esas semillas necesitan un adapter OAuth2 aparte (registro en Entra, consentimiento por buzón,
 * rotación de refresh tokens), que es otro trabajo, no un parámetro.
 */
export const SIN_APP_PASSWORD: Record<string, string> = {
  outlook:
    "Outlook.com personal ya no acepta app password: Microsoft retiró Basic Auth el 16/09/2024 y exige OAuth2 para IMAP, POP y SMTP",
  m365:
    "Microsoft 365 tiene Basic Auth deshabilitado para IMAP en todos los tenants, y no se puede re-habilitar ni con soporte"
};

export function validarSemillaNueva(input: {
  address: string;
  provider: string;
  imapHost?: string;
  imapPort?: number;
  /** Cómo se va a autenticar; sirve para rechazar combinaciones imposibles antes de guardarlas. */
  auth?: SeedAuth;
}): { address: string; provider: SeedProvider; imap: { host: string; port: number } } {
  const address = normalizarDireccion(input.address);
  // Validación deliberadamente simple: que tenga forma de dirección. El probe IMAP es la prueba
  // real de que la semilla sirve; una regex más estricta solo daría falsos rechazos.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new WarmupSeedError(`direccion invalida: ${input.address}`);
  }
  if (!SEED_PROVIDERS.includes(input.provider as SeedProvider)) {
    throw new WarmupSeedError(`proveedor invalido: ${input.provider} (validos: ${SEED_PROVIDERS.join(", ")})`);
  }
  const provider = input.provider as SeedProvider;
  if (input.auth === "imap_password" && SIN_APP_PASSWORD[provider]) {
    throw new WarmupSeedError(
      `${SIN_APP_PASSWORD[provider]}. Cargala como --solo-destino (recibe correo, no mide) hasta que exista el adapter OAuth2.`
    );
  }
  const porDefecto = IMAP_POR_PROVEEDOR[provider];
  const port = input.imapPort ?? porDefecto.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new WarmupSeedError(`puerto IMAP invalido: ${input.imapPort}`);
  }
  return { address, provider, imap: { host: (input.imapHost ?? porDefecto.host).trim(), port } };
}
