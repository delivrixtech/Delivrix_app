// Composition root del I/O EN VIVO (§7/§8/§9). Único lugar que ata los adapters reales (DNS/RBL/TLS
// + SMTP/IMAP) a los checkers, al Inbox Reader y al transporte. TODO está guardado por el feature
// flag WARMUP_ENGINE_ENABLE: si el flag está OFF, estas funciones LANZAN (assertWarmupEngineEnabled)
// y nada real se construye ni se conecta. Por default el engine es inerte — no toca red en deploy.
//
// Construir los adapters NO abre conexiones (nodemailer/imapflow son perezosos); la red recién se
// toca cuando un checker/reader/transport se INVOCA. Aun así, el gate del flag vive aquí para que el
// cableado en vivo sea un acto explícito.

import {
  assertWarmupEngineEnabled,
  readWarmupSmtpConfig,
  warmupTransportKind,
  type WarmupEnv
} from "../runtime/config.ts";
import {
  createNodeDnsResolver,
  createNodeReverseDnsResolver,
  createDnsBlocklistResolver,
  createDomainBlocklistResolver,
  createTlsStarttlsProbe
} from "./dns-adapters.ts";
import {
  createNodemailerSmtpAuthProbe,
  createImapflowAuthProbe,
  createImapflowClient,
  createNodemailerSmtpClient,
  type SecretResolver,
  type ImapflowClientOptions,
  type SmtpClientOptions
} from "./mail-adapters.ts";
import { createDnsAuthChecker } from "../checks/dns-auth-checks.ts";
import { createIpNetworkCheckers, type DedicatedIpScheduleProvider } from "../checks/ip-network-checks.ts";
import { createLivenessCheckers, type UnsubCapabilityProvider } from "../checks/liveness-checks.ts";
import type { AuthChecker } from "../domain/auth-checks.ts";
import { MockTransport, PostfixTransport, type WarmupTransport } from "../runtime/transport.ts";
import type { ImapClient } from "../reader/imap-placement-reader.ts";

/**
 * Piezas que la composición necesita más allá de los adapters de red: cómo resolver secretos (por
 * referencia), y los dos providers que dependen de config/estado del nodo (rampa de IP dedicada y
 * capacidad one-click unsub). Se inyectan: el composition root no decide política ni guarda secretos.
 */
export interface LiveWarmupConfig {
  secretResolver: SecretResolver;
  scheduleProvider: DedicatedIpScheduleProvider;
  unsubProvider: UnsubCapabilityProvider;
  /** Overrides opcionales de zonas RBL/DBL y puertos TLS (default: los del §8). */
  blocklistZones?: readonly string[];
  domainBlocklistZones?: readonly string[];
  tlsPorts?: readonly number[];
}

/**
 * Ensambla los 13 checkers del §8 con adapters REALES. Guarded por el flag: OFF ⇒ lanza. Los
 * checkers son fail-closed (cualquier throw del adapter ⇒ `unknown`); el AuthReadinessContract se
 * arma con buildAuthReadinessContract(runtime/auth-contract-builder.ts) sobre este array.
 */
export function createLiveAuthCheckers(config: LiveWarmupConfig, env: WarmupEnv = process.env): AuthChecker[] {
  assertWarmupEngineEnabled(env);
  const dnsResolver = createNodeDnsResolver();
  const reverseDns = createNodeReverseDnsResolver();
  const rbl = createDnsBlocklistResolver();
  const domainBlocklist = createDomainBlocklistResolver();
  const tls = createTlsStarttlsProbe();

  return [
    createDnsAuthChecker(dnsResolver),
    ...createIpNetworkCheckers({
      dns: reverseDns,
      rbl,
      tls,
      scheduleProvider: config.scheduleProvider,
      ...(config.blocklistZones ? { blocklistZones: config.blocklistZones } : {}),
      ...(config.tlsPorts ? { tlsPorts: config.tlsPorts } : {})
    }),
    ...createLivenessCheckers({
      smtpProbe: createNodemailerSmtpAuthProbe(config.secretResolver),
      imapProbe: createImapflowAuthProbe(config.secretResolver),
      domainBlocklist,
      unsubProvider: config.unsubProvider,
      ...(config.domainBlocklistZones ? { domainBlocklistZones: config.domainBlocklistZones } : {})
    })
  ];
}

/** Cliente IMAP real para leer un seed inbox externo (Inbox Reader §9). Guarded por el flag. */
export function createLiveSeedInboxClient(
  config: LiveWarmupConfig,
  opts: ImapflowClientOptions,
  env: WarmupEnv = process.env
): ImapClient {
  assertWarmupEngineEnabled(env);
  return createImapflowClient(config.secretResolver, opts);
}

/** Transporte Postfix real (SMTP nodemailer) para el Send Worker. Guarded por el flag. */
export function createLivePostfixTransport(
  config: LiveWarmupConfig,
  opts: SmtpClientOptions,
  env: WarmupEnv = process.env
): WarmupTransport {
  assertWarmupEngineEnabled(env);
  return new PostfixTransport(createNodemailerSmtpClient(config.secretResolver, opts));
}

/**
 * Credenciales de submission del nodo emisor que el transporte postfix necesita más allá del
 * host/port (que vienen del env 5.1). NO son secreto: `secretRef` es una referencia opaca que el
 * SecretResolver canjea. Se inyectan; el selector no decide credenciales ni las guarda.
 */
export interface WarmupTransportCredentials {
  user: string;
  secretRef: string;
}

export interface CreateWarmupTransportOptions {
  /** Requerido solo cuando WARMUP_TRANSPORT=postfix (el mock no usa credenciales). */
  smtp?: WarmupTransportCredentials;
}

/**
 * SELECTOR de transporte por flag (§7, roadmap 5.1). Elige según WARMUP_TRANSPORT:
 *   - "mock"    ⇒ MockTransport (default fail-safe; nunca toca red).
 *   - "postfix" ⇒ createLivePostfixTransport contra WARMUP_SMTP_HOST/PORT (SMTP real, perezoso).
 * Todo gated por WARMUP_ENGINE_ENABLE: con el flag OFF LANZA (fail-closed) — nada se construye.
 * No abre conexiones: solo decide y arma el adapter (la red se toca recién al invocar `send`).
 */
export function createWarmupTransport(
  config: LiveWarmupConfig,
  opts: CreateWarmupTransportOptions = {},
  env: WarmupEnv = process.env
): WarmupTransport {
  assertWarmupEngineEnabled(env);
  const kind = warmupTransportKind(env);
  if (kind === "mock") {
    return new MockTransport();
  }
  // kind === "postfix": destino desde el env 5.1; credenciales del nodo inyectadas.
  const smtp = readWarmupSmtpConfig(env);
  if (!opts.smtp) {
    throw new Error(
      "warmup_transport_postfix_requires_credentials: WARMUP_TRANSPORT=postfix necesita " +
      "opts.smtp { user, secretRef } del nodo emisor."
    );
  }
  return createLivePostfixTransport(
    config,
    { host: smtp.host, port: smtp.port, user: opts.smtp.user, secretRef: opts.smtp.secretRef },
    env
  );
}
