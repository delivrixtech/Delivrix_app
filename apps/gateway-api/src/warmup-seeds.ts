// ADAPTADOR del registro de semillas: la parte de I/O que SÍ es del gateway — leer y escribir el
// inventario, y cifrar la credencial con la llave del gateway.
//
// Las REGLAS —qué semilla se elige, cuál mide, qué cobertura hay, qué es un alta válida— viven en
// el módulo del warmup (`apps/warmup-engine/src/domain/seeds.ts`), que es su dueño. Acá solo se
// guardan y se leen. Tenerlas acá las duplicó una vez (la rotación terminó escrita también en el
// daemon, con dos juegos de tests que podían divergir en silencio); no otra vez.
//
// La regla del operador manda el diseño: LAS SEMILLAS SE AGREGAN A MANO, NO A CÓDIGO. Por eso el
// registro es un archivo del inventario (como domains.json o smtp-credentials.json) y no una
// constante ni una tabla que exija Postgres arriba: una semilla nueva es un comando, no un deploy.
//
// La credencial (app password) se guarda CIFRADA con la misma llave y el mismo AES-256-GCM que las
// credenciales SMTP, con AAD atado a (address, provider): un payload robado no se puede reusar en
// otra semilla.

import {
  coberturaPorProveedor,
  elegirSemilla,
  IMAP_POR_PROVEEDOR,
  normalizarDireccion,
  puntoCiego,
  SEED_PROVIDERS,
  semillasActivas,
  semillasMedibles,
  validarSemillaNueva,
  WarmupSeedError,
  type SeedAuth,
  type SeedProvider
} from "../../warmup-engine/src/domain/seeds.ts";
import {
  credentialEncryptionKey,
  decryptSecret,
  encryptSecret,
  type SmtpCredentialEncryptedPayload
} from "./smtp-credentials.ts";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

// Re-export: los consumidores del gateway (rutas, script ops) importan de un solo lugar y no
// necesitan conocer la ruta interna del módulo.
export {
  coberturaPorProveedor,
  elegirSemilla,
  IMAP_POR_PROVEEDOR,
  normalizarDireccion,
  puntoCiego,
  SEED_PROVIDERS,
  semillasActivas,
  semillasMedibles,
  validarSemillaNueva,
  WarmupSeedError,
  type SeedAuth,
  type SeedProvider
};

export const SEEDS_FILE = "warmup-seeds.json";

/** La semilla como se PERSISTE: el núcleo puro + lo que solo le importa al almacenamiento. */
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

/** AAD: ata el secreto a ESTA semilla. Copiar el payload a otra dirección no descifra. */
function seedAad(address: string, provider: string): Record<string, string> {
  return { address, provider, kind: "warmup_seed_secret" };
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
  const ahoraTieneSecreto = Boolean(input.secret && input.secret.trim().length > 0);
  const { address, provider, imap } = validarSemillaNueva({
    ...input,
    auth: input.auth ?? (ahoraTieneSecreto ? "imap_password" : "none")
  });
  const ahora = (input.now ?? (() => new Date()))();
  const tieneSecreto = ahoraTieneSecreto;
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
