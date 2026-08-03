// El REGISTRO DE SEMILLAS del warmup: las bandejas nuestras en los proveedores grandes contra las
// que la fábrica calienta sus propios dominios.
//
// Por qué existe: el daemon live hoy manda a UNA dirección fija que viene de una env var
// (WARMUP_GMAIL_SEED_USER, default infradelivrixdemo@gmail.com). Con una sola semilla —y de un solo
// proveedor— no hay warmup posible: no se puede medir Outlook ni Yahoo, y el patrón "58 dominios
// escribiéndole siempre a la misma casilla" es exactamente la huella que hay que evitar.
//
// La regla del operador manda el diseño: LAS SEMILLAS SE AGREGAN A MANO, NO A CÓDIGO. Por eso esto
// es un archivo del inventario (como domains.json o smtp-credentials.json), no una constante ni una
// tabla que exija Postgres arriba — el resto de la fábrica ya vive así, y una semilla nueva tiene
// que ser un comando, no un deploy.
//
// La credencial de cada semilla (app password) se guarda CIFRADA con la misma llave y el mismo
// AES-256-GCM que las credenciales SMTP, con AAD atado a (address, provider): un payload robado no
// se puede reusar en otra semilla.

import {
  credentialEncryptionKey,
  decryptSecret,
  encryptSecret,
  type SmtpCredentialEncryptedPayload
} from "./smtp-credentials.ts";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

export const SEEDS_FILE = "warmup-seeds.json";

/**
 * Los proveedores que importan para reputación. El enum acompaña al de la migración v1
 * (warmup_seed_accounts): si algún día se migra a Postgres, el dato ya tiene la forma correcta.
 */
export type SeedProvider = "gmail" | "workspace" | "outlook" | "m365" | "yahoo" | "gmx" | "webde";

export const SEED_PROVIDERS: SeedProvider[] = ["gmail", "workspace", "outlook", "m365", "yahoo", "gmx", "webde"];

/**
 * Host IMAP por proveedor. El operador puede pisarlo al agregar la semilla; esto es solo para que
 * el caso normal sea un comando corto.
 *
 * IMAP y no la API del proveedor a propósito: el diseño v1 (§14) dice SMTP + IMAP para warmup, y
 * usar la API de Gmail/Graph para esto choca con sus términos de servicio.
 */
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
 * Una semilla cumple DOS papeles, y solo uno necesita credencial:
 *
 *  - **destino** (siempre): nuestro nodo le manda correo. Para eso no hace falta ninguna clave —
 *    alcanza con que la dirección exista. Sirve para generar tráfico y para leer el resultado en
 *    el `mail.log` del nodo (aceptado / diferido / rechazado).
 *  - **medición y señal** (solo con credencial): entrar al buzón para ver DÓNDE cayó (inbox,
 *    promociones, spam) y generar la señal que calienta — abrir, marcar importante, rescatar de
 *    spam. Sin clave esto es imposible, y el placement es lo que gatea toda la rampa en v1.
 *
 * Modelarlo así permite arrancar HOY con las direcciones que ya tenemos y sumarles credencial
 * después, en vez de bloquear las pruebas hasta tener todo el pool con app passwords.
 */
export type SeedAuth = "none" | "imap_password" | "gmail_oauth";

export interface WarmupSeed {
  address: string;
  provider: SeedProvider;
  /** Apagar una semilla NO la borra: se conserva el histórico y se puede reactivar. */
  enabled: boolean;
  imap: { host: string; port: number };
  /** Cómo se entra al buzón. `none` = solo sirve de destino, NO mide placement. */
  auth: SeedAuth;
  /** App password del buzón, cifrado. Ausente cuando `auth` es `none` o `gmail_oauth`. */
  secretEncrypted?: SmtpCredentialEncryptedPayload;
  /** Para que el operador sepa qué es cada casilla dentro de seis meses. */
  notes?: string;
  addedAt: string;
  /** Última vez que un probe la autenticó de verdad. `null` = nunca se verificó. */
  verifiedAt?: string | null;
}

export interface SeedRegistry {
  seeds: WarmupSeed[];
}

export class WarmupSeedError extends Error {}

/** AAD: ata el secreto a ESTA semilla. Copiar el payload a otra dirección no descifra. */
function seedAad(address: string, provider: string): Record<string, string> {
  return { address, provider, kind: "warmup_seed_secret" };
}

export function normalizarDireccion(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Lee el registro. Devuelve lista vacía cuando el archivo no existe — que NO es lo mismo que "hay
 * semillas y están todas apagadas"; quien consume tiene que distinguirlo y por eso está el flag.
 */
export async function leerSemillas(
  workspace: OpenClawWorkspace
): Promise<{ seeds: WarmupSeed[]; existeRegistro: boolean }> {
  const registro = await workspace.readInventoryJson<SeedRegistry>(SEEDS_FILE).catch(() => null);
  if (!registro || !Array.isArray(registro.seeds)) return { seeds: [], existeRegistro: false };
  return { seeds: registro.seeds, existeRegistro: true };
}

/** Las que sirven de DESTINO hoy: alcanza con estar habilitadas. */
export function semillasActivas(seeds: WarmupSeed[]): WarmupSeed[] {
  return seeds.filter((s) => s.enabled);
}

/**
 * Las que además pueden MEDIR placement y generar señal (tienen cómo entrar al buzón).
 *
 * La diferencia con `semillasActivas` no es cosmética: mandar correo a una semilla sin credencial
 * genera tráfico pero NO enseña nada — no sabés si cayó en inbox o en spam, y no podés rescatarlo.
 * Quien gatee una rampa por placement tiene que mirar ESTA lista, no la otra.
 */
export function semillasMedibles(seeds: WarmupSeed[]): WarmupSeed[] {
  return seeds.filter((s) => s.enabled && s.auth !== "none");
}

/**
 * Elige la semilla de una vuelta. Rota por (dominio, vuelta) en vez de tomar siempre la primera:
 * si los 58 dominios le escribieran siempre a la misma casilla, el patrón sería la huella que este
 * módulo existe para evitar. El desfase por dominio impide además que todos los nodos peguen a la
 * misma semilla en la misma vuelta.
 */
export function elegirSemilla(seeds: WarmupSeed[], domain: string, vuelta: number): WarmupSeed | null {
  // PRIORIDAD a las que miden. Lo cazó la primera prueba real: con 3 de 4 semillas sin credencial,
  // la rotación mandó el correo a una que no mide y la vuelta no produjo placement — y el placement
  // es lo que gatea toda la rampa. Una vuelta sin medición es media vuelta.
  // El reparto no se pierde: a medida que se agreguen semillas con credencial, la rotación se
  // abre sola entre ellas. Las solo-destino quedan de reserva por si no hay ninguna que mida.
  const medibles = semillasMedibles(seeds);
  const activas = medibles.length > 0 ? medibles : semillasActivas(seeds);
  if (activas.length === 0) return null;
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  const idx = Math.abs(hash + vuelta) % activas.length;
  return activas[idx] ?? null;
}

/**
 * Cobertura de MEDICIÓN por proveedor. Cuenta solo las que pueden medir: una semilla sin
 * credencial no da cobertura de nada, aunque reciba correo — reportarla como cobertura sería
 * exactamente el número falso que hace creer que estás midiendo Yahoo cuando no.
 */
export function coberturaPorProveedor(seeds: WarmupSeed[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of semillasMedibles(seeds)) out[s.provider] = (out[s.provider] ?? 0) + 1;
  return out;
}

export function validarSemillaNueva(input: {
  address: string;
  provider: string;
  imapHost?: string;
  imapPort?: number;
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
  const porDefecto = IMAP_POR_PROVEEDOR[provider];
  const port = input.imapPort ?? porDefecto.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new WarmupSeedError(`puerto IMAP invalido: ${input.imapPort}`);
  }
  return { address, provider, imap: { host: (input.imapHost ?? porDefecto.host).trim(), port } };
}

/**
 * Alta (o reemplazo) de una semilla. El secreto llega en claro SOLO acá dentro y sale cifrado: no
 * se escribe en el JSON, no se loguea y no se devuelve.
 */
export async function agregarSemilla(input: {
  workspace: OpenClawWorkspace;
  env?: Record<string, string | undefined>;
  address: string;
  provider: string;
  /** Ausente o vacío ⇒ semilla solo-destino (`auth: "none"`): no mide placement. */
  secret?: string;
  /** Para la semilla Gmail que ya tiene refresh token OAuth en config/warmup-oauth.local.json. */
  auth?: SeedAuth;
  imapHost?: string;
  imapPort?: number;
  notes?: string;
  now?: () => Date;
}): Promise<WarmupSeed> {
  const { address, provider, imap } = validarSemillaNueva(input);
  const ahora = (input.now ?? (() => new Date()))();
  const tieneSecreto = Boolean(input.secret && input.secret.trim().length > 0);
  const auth: SeedAuth = input.auth ?? (tieneSecreto ? "imap_password" : "none");

  if (auth === "imap_password" && !tieneSecreto) {
    throw new WarmupSeedError("auth imap_password exige el app password (se lee por stdin, nunca por argv)");
  }

  const seed: WarmupSeed = {
    address,
    provider,
    enabled: true,
    imap,
    auth,
    ...(tieneSecreto
      ? { secretEncrypted: encryptSecret(input.secret!, credentialEncryptionKey(input.env), seedAad(address, provider)) }
      : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    addedAt: ahora.toISOString(),
    verifiedAt: null
  };

  await input.workspace.updateInventoryJson<SeedRegistry>(SEEDS_FILE, (actual) => {
    const seeds = (actual?.seeds ?? []).filter((s) => normalizarDireccion(s.address) !== address);
    return { seeds: [...seeds, seed] };
  });
  return seed;
}

/** Prende/apaga sin borrar. Devuelve `false` si la dirección no está en el registro. */
export async function marcarSemilla(input: {
  workspace: OpenClawWorkspace;
  address: string;
  enabled: boolean;
}): Promise<boolean> {
  const address = normalizarDireccion(input.address);
  let encontrada = false;
  await input.workspace.updateInventoryJson<SeedRegistry>(SEEDS_FILE, (actual) => {
    const seeds = (actual?.seeds ?? []).map((s) => {
      if (normalizarDireccion(s.address) !== address) return s;
      encontrada = true;
      return { ...s, enabled: input.enabled };
    });
    return { seeds };
  });
  return encontrada;
}

/** Sella que un probe la autenticó de verdad. */
export async function marcarVerificada(input: {
  workspace: OpenClawWorkspace;
  address: string;
  now?: () => Date;
}): Promise<void> {
  const address = normalizarDireccion(input.address);
  const cuando = (input.now ?? (() => new Date()))().toISOString();
  await input.workspace.updateInventoryJson<SeedRegistry>(SEEDS_FILE, (actual) => ({
    seeds: (actual?.seeds ?? []).map((s) =>
      normalizarDireccion(s.address) === address ? { ...s, verifiedAt: cuando } : s
    )
  }));
}

/** Descifra el app password de una semilla. Solo para el momento de conectarse por IMAP. */
export function descifrarSemilla(seed: WarmupSeed, env?: Record<string, string | undefined>): string {
  if (!seed.secretEncrypted) {
    throw new WarmupSeedError(`${seed.address} no tiene app password guardado (auth: ${seed.auth})`);
  }
  return decryptSecret(seed.secretEncrypted, credentialEncryptionKey(env), seedAad(seed.address, seed.provider));
}
