// Inventario de bandejas: el producto que la fabrica vende, en una sola lectura.
//
// Lee SOLO JSON local del workspace. Sin SSH, sin Postgres, sin modelo. Es la parte del tablero
// que funciona hoy y que no se puede caer: hoy la pantalla de warmup queda entera en cero cuando
// Postgres se cae, y el cartel que lo explica miente.
//
// UNA REGLA, y es la que ordena todo el archivo: un dato que no se midio sale como `null` con el
// motivo al lado. NUNCA como cero. Esta semana aparecieron SEIS sensores que reportaban salud
// sin datos —la sonda del puerto 25, el escaneo de listas negras, el freno por rebotes, el panel
// de NFC, el panel propio y el veredicto de delivery-health— y todos compartian la misma forma:
// un cero que se lee como "todo bien". El tipo hace eso imposible aca.

import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

/** Por que una bandeja no tiene medicion. Se muestra pegado al guion, no se resume. */
export type SinMedicion =
  | "sin_binding"
  | "nunca_medida"
  | "conflicto_de_inventario";

export interface BandejaInventario {
  domain: string;
  /** Del binding. `null` = el dominio existe pero ningun sondeo lo alcanza. */
  serverSlug: string | null;
  serverIp: string | null;
  /** Dias desde que se creo la credencial. InfraForge muestra este dato como columna. */
  edadDias: number | null;
  /** Acceso SSH ops aprovisionado: sin esto no se puede medir el nodo. */
  tieneAccesoOps: boolean;
  /**
   * El inventario se contradice sobre que nodo sirve al dominio.
   *
   * Importa mas de lo que parece: el slug alimenta TODAS las sondas. Medir el nodo equivocado
   * devuelve un resultado correcto de otra maquina y se lo atribuye a este dominio. Un veredicto
   * confiado y falso es peor que un not-found, asi que estas filas salen sin datos.
   */
  conflicto: { enBindings: string; enCredencial: string } | null;
  /** Null con motivo. Nunca cero. */
  sinMedicion: SinMedicion | null;
}

export interface InventarioFabrica {
  /** El denominador de toda la pantalla. Son las credenciales configuradas, no los bindings. */
  totalBandejas: number;
  /** Cuantas puede alcanzar un sondeo. La diferencia con el total es el punto ciego. */
  medibles: number;
  /**
   * Dominios con credencial que NINGUN sondeo toca, porque todo itera `bindings`.
   *
   * Se listan por nombre a proposito: entre ellos estan los dos problematicos conocidos
   * (nfcfilings.com sin auth publicada, controlcorpfiling.com sin base SASL), o sea que el punto
   * ciego no es aleatorio — se come justo lo que hay que mirar.
   */
  sinBinding: string[];
  /** Dominios donde domains.json y la credencial discrepan sobre el nodo. */
  enConflicto: string[];
  bandejas: BandejaInventario[];
  /** true si algo no se pudo leer: la pantalla entera se rotula parcial. */
  parcial: boolean;
  motivosParcial: string[];
}

interface DomainsInventory {
  bindings?: Array<{ domain?: unknown; serverSlug?: unknown; serverIp?: unknown }>;
}

interface CredentialsInventory {
  smtpCredentials?: Array<{
    domain?: unknown;
    serverSlug?: unknown;
    status?: unknown;
    createdAt?: unknown;
    sshAccess?: unknown;
  }>;
}

export async function leerInventarioFabrica(input: {
  workspace: OpenClawWorkspace;
  now?: () => Date;
}): Promise<InventarioFabrica> {
  const now = input.now?.() ?? new Date();
  const motivosParcial: string[] = [];

  const domains = await input.workspace
    .readInventoryJson<DomainsInventory>("domains.json")
    .catch(() => null);
  if (!domains) motivosParcial.push("no se pudo leer domains.json");

  const creds = await input.workspace
    .readInventoryJson<CredentialsInventory>("smtp-credentials.json")
    .catch(() => null);
  if (!creds) motivosParcial.push("no se pudo leer smtp-credentials.json");

  const bindings = new Map<string, { serverSlug: string | null; serverIp: string | null }>();
  for (const b of domains?.bindings ?? []) {
    const domain = texto(b.domain)?.toLowerCase().replace(/\.$/, "");
    if (!domain) continue;
    bindings.set(domain, { serverSlug: texto(b.serverSlug), serverIp: texto(b.serverIp) });
  }

  const bandejas: BandejaInventario[] = [];
  const sinBinding: string[] = [];
  const enConflicto: string[] = [];

  for (const record of creds?.smtpCredentials ?? []) {
    const domain = texto(record.domain)?.toLowerCase().replace(/\.$/, "");
    // Solo las configuradas son producto: una credencial a medio aprovisionar no se vende.
    if (!domain || record.status !== "configured") continue;

    const binding = bindings.get(domain);
    const slugCredencial = texto(record.serverSlug);

    const conflicto =
      binding?.serverSlug && slugCredencial && binding.serverSlug !== slugCredencial
        ? { enBindings: binding.serverSlug, enCredencial: slugCredencial }
        : null;

    if (!binding) sinBinding.push(domain);
    if (conflicto) enConflicto.push(domain);

    bandejas.push({
      domain,
      serverSlug: binding?.serverSlug ?? null,
      serverIp: binding?.serverIp ?? null,
      edadDias: edadEnDias(record.createdAt, now),
      tieneAccesoOps: record.sshAccess !== undefined && record.sshAccess !== null,
      conflicto,
      // El motivo se resuelve una vez, aca, para que la pantalla no tenga que deducirlo.
      sinMedicion: !binding ? "sin_binding" : conflicto ? "conflicto_de_inventario" : "nunca_medida"
    });
  }

  // Riesgo primero: lo que no se puede medir arriba, no escondido al fondo.
  const orden: Record<string, number> = { sin_binding: 0, conflicto_de_inventario: 1, nunca_medida: 2 };
  bandejas.sort((a, b) => {
    const pa = orden[a.sinMedicion ?? "nunca_medida"] ?? 3;
    const pb = orden[b.sinMedicion ?? "nunca_medida"] ?? 3;
    return pa !== pb ? pa - pb : a.domain.localeCompare(b.domain);
  });

  return {
    totalBandejas: bandejas.length,
    medibles: bandejas.filter((b) => b.serverSlug !== null && b.serverIp !== null).length,
    sinBinding: sinBinding.sort(),
    enConflicto: enConflicto.sort(),
    bandejas,
    parcial: motivosParcial.length > 0,
    motivosParcial
  };
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** null si no hay fecha: la edad desconocida no es "recien creado". */
function edadEnDias(createdAt: unknown, now: Date): number | null {
  const raw = texto(createdAt);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed) / 86_400_000));
}
