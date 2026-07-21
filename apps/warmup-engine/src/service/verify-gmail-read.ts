// Verificación de CONECTIVIDAD del seed inbox por OAuth (XOAUTH2) — SOLO lectura, CERO envío.
//
// Qué hace: mintea un access token (vía AccessTokenProvider), conecta al seed inbox real por IMAPS,
// lista las carpetas relevantes (INBOX / Spam / All Mail) y muestra un RESUMEN SEGURO (conteos por
// carpeta). Sirve para confirmar a mano que las credenciales OAuth permanentes funcionan contra el
// buzón real ANTES de encender la lectura en el daemon.
//
// SEGURIDAD (no negociable):
//   - NUNCA imprime el access token ni ningún valor del OAuth config. Sólo host/usuario (una dirección,
//     no un secreto) y conteos por carpeta.
//   - CERO correo enviado: sólo abre IMAP, lee `status()` y hace logout.
//   - `tokenProvider` / `ImapFlow` / `logger` inyectables ⇒ el test corre sin red ni archivo real.

import { ImapFlow } from "imapflow";

import { readWarmupGmailSeedConfig, type WarmupEnv } from "../runtime/config.ts";
import {
  createGoogleOAuthTokenProvider,
  type AccessTokenProvider
} from "../live/google-oauth-token-provider.ts";

const IMAPS_PORT = 993;

/** Marcadores de carpeta relevantes para el resumen (INBOX + spam-like + All Mail de Gmail). */
const RELEVANT_FOLDER_MARKERS: readonly string[] = ["inbox", "spam", "junk", "bulk", "all mail"];

/** Subconjunto de ImapFlow que usa la verificación (list + status). Inyectable para tests. */
export interface VerifyImapFlowLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<Array<{ path: string }>>;
  status(
    path: string,
    query: { messages?: boolean; unseen?: boolean }
  ): Promise<{ messages?: number; unseen?: number }>;
}

/** Constructor de ImapFlow compatible (default = imapflow real). */
export type VerifyImapFlowCtor = new (config: unknown) => VerifyImapFlowLike;

export interface VerifyGmailReadDeps {
  /** Proveedor del access token; default = createGoogleOAuthTokenProvider sobre el config del seed. */
  tokenProvider?: AccessTokenProvider;
  /** Constructor ImapFlow; default = imapflow real. */
  ImapFlow?: VerifyImapFlowCtor;
  /** Logger de líneas seguras; default = console.log con prefijo. */
  logger?: { info(msg: string): void };
}

export interface VerifyFolderSummary {
  path: string;
  messages: number;
  unseen: number;
}

export interface VerifyGmailReadResult {
  connected: boolean;
  folders: VerifyFolderSummary[];
}

function isRelevantFolder(path: string): boolean {
  const p = path.toLowerCase();
  return RELEVANT_FOLDER_MARKERS.some((m) => p.includes(m));
}

/**
 * Conecta al seed inbox por OAuth XOAUTH2 y devuelve/loguea un resumen seguro (conteos por carpeta).
 * NUNCA imprime el token ni secretos. Envía CERO correo. Fail-closed: cualquier problema de config/token
 * se propaga como error tipado (por código) SIN exponer valores.
 */
export async function verifyGmailRead(
  env: WarmupEnv = process.env,
  deps: VerifyGmailReadDeps = {}
): Promise<VerifyGmailReadResult> {
  const seed = readWarmupGmailSeedConfig(env);
  const logger = deps.logger ?? { info: (m: string) => console.log(`[verify-gmail-read] ${m}`) };
  const tokenProvider =
    deps.tokenProvider ??
    createGoogleOAuthTokenProvider(seed.configPath ? { configPath: seed.configPath } : {});
  const Ctor: VerifyImapFlowCtor = deps.ImapFlow ?? (ImapFlow as unknown as VerifyImapFlowCtor);

  // Mintea el token (prueba que el refresh_token permanente sirve). NUNCA se imprime.
  const accessToken = await tokenProvider.getAccessToken();

  const client = new Ctor({
    host: seed.host,
    port: IMAPS_PORT,
    secure: true,
    auth: { user: seed.user, accessToken },
    logger: false
  });

  const folders: VerifyFolderSummary[] = [];
  await client.connect();
  logger.info(`conectado a ${seed.host} como ${seed.user} (OAuth XOAUTH2).`);
  try {
    const boxes = await client.list();
    const relevant = boxes.filter((b) => isRelevantFolder(b.path));
    for (const box of relevant) {
      let messages = 0;
      let unseen = 0;
      try {
        const st = await client.status(box.path, { messages: true, unseen: true });
        messages = typeof st.messages === "number" ? st.messages : 0;
        unseen = typeof st.unseen === "number" ? st.unseen : 0;
      } catch {
        // status best-effort: una carpeta sin permiso no invalida la verificación de conectividad.
      }
      folders.push({ path: box.path, messages, unseen });
      logger.info(`  ${box.path}: ${messages} mensajes (${unseen} sin leer).`);
    }
    if (relevant.length === 0) {
      logger.info("no se hallaron carpetas relevantes (INBOX/Spam/All Mail).");
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // best-effort.
    }
  }
  logger.info(
    `OK: lectura del seed inbox verificada. carpetas_revisadas=${folders.length}. CERO correo enviado.`
  );
  return { connected: true, folders };
}
