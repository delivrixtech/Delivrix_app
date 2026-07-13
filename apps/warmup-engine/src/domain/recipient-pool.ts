// Fuente de destinatarios engaged del warmup v1 (gap §5 + §9). Estrategia A+B:
//  - SEEDS: buzones propios controlados (uno por proveedor) para MEDIR placement. Cap ≤10% del
//    volumen del día (§9) — son ruido de medición, no volumen real.
//  - CURATED: lista curada de destinatarios reales que abren/responden (§5) — el grueso del tráfico.
//
// `pick(nodeId, index)` es DETERMINISTA por (nodeId, index): mismo input ⇒ mismo destinatario, sin
// RNG (hash puro). Así el scheduler puede reencolar el mismo día sin cambiar a quién le escribe y los
// tests son exhaustivos. Función pura sobre los conjuntos ya leídos de las stores.
//
// Source of truth: Delivrix-Warmup-Diseno-v1.md §5 (engaged) y §9 (placement / cap de seeds).

import type { SeedProvider } from "./types.ts";
import type { EngagedRecipient, RecipientPool } from "./trends.ts";

/** Fracción máxima del volumen del día que pueden ser seeds (§9: ≤10%). */
export const DEFAULT_SEED_FRACTION = 0.1;

export interface RecipientPoolOptions {
  /** Fracción de cap de seeds (default 0.1 = 10%, §9). */
  seedFraction?: number;
  /**
   * Volumen total del día del nodo. Si se conoce, los PRIMEROS `seedQuota(dailyVolume)` slots son
   * seeds (rotando entre ellos) y el resto es curated ponderado — garantiza el cap ≤10% de forma
   * estricta. Si se omite, se cae a un reparto por `stride` (1/seedFraction) como mejor esfuerzo.
   */
  dailyVolume?: number;
}

/** Hash FNV-1a de 32 bits (determinista, sin RNG) para derivar la selección de (nodeId, index). */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Unidad determinista en [0, 1) derivada de (nodeId, index). */
function unitFor(nodeId: string, index: number): number {
  return hash32(`${nodeId}:${index}`) / 0x100000000;
}

/** Peso saneado: solo positivos finitos cuentan; el resto = 0 (no participa del reparto). */
function safeWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

/**
 * Elige un curated ponderado por `weight` de forma determinista con `unit` ∈ [0,1). Reparto
 * proporcional al peso (cumulative walk). Si ningún peso es válido, cae a uniforme por hash.
 */
function pickWeighted(curated: EngagedRecipient[], unit: number): EngagedRecipient {
  let total = 0;
  for (const r of curated) total += safeWeight(r.weight);

  if (total <= 0) {
    return curated[Math.floor(unit * curated.length) % curated.length];
  }

  const target = unit * total;
  let acc = 0;
  for (const r of curated) {
    acc += safeWeight(r.weight);
    if (target < acc) return r;
  }
  return curated[curated.length - 1]; // fallback numérico (target≈total)
}

/**
 * Crea el pool A+B. `seeds` y `engaged` (curated) ya vienen leídos de sus stores.
 *
 * Política de `pick(nodeId, index)`:
 *  1. Vacío total (sin seeds ni curated) ⇒ `undefined`.
 *  2. Los primeros `seedQuota(dailyVolume)` slots del día son SEEDS, rotando en round-robin
 *     (`seeds[index % seeds.length]`), marcados `source:"seed"`. Si `dailyVolume` no se pasa, un slot
 *     es seed cuando `index % stride === 0` con `stride = round(1/seedFraction)`.
 *  3. El resto son CURATED, elegidos con rotación PONDERADA por `weight`, marcados `source:"curated"`.
 *  4. Si no hay curated, un slot curated cae a seed; si no hay seeds, un slot seed cae a curated.
 */
export function createRecipientPool(
  seeds: Array<{ address: string; provider: SeedProvider }>,
  engaged: EngagedRecipient[],
  opts: RecipientPoolOptions = {}
): RecipientPool {
  const seedFraction = Number.isFinite(opts.seedFraction) && (opts.seedFraction as number) > 0
    ? (opts.seedFraction as number)
    : DEFAULT_SEED_FRACTION;

  // Seeds normalizados a EngagedRecipient (source:"seed"): el weight no se usa (round-robin) pero se
  // deja en 1 por consistencia del tipo.
  const seedRecipients: EngagedRecipient[] = seeds.map((s) => ({
    address: s.address,
    source: "seed",
    weight: 1
  }));
  const curatedRecipients: EngagedRecipient[] = engaged.map((e) => ({
    address: e.address,
    source: "curated",
    weight: e.weight
  }));

  const hasSeeds = seedRecipients.length > 0;
  const hasCurated = curatedRecipients.length > 0;
  const stride = Math.max(1, Math.round(1 / seedFraction));

  function seedQuota(count: number): number {
    if (!hasSeeds) return 0; // sin seeds no hay cupo de seeds posible
    if (!Number.isFinite(count) || count <= 0) return 0;
    return Math.min(Math.floor(count), Math.floor(count * seedFraction));
  }

  /** ¿El slot `index` es un slot de seed (antes de aplicar fallbacks por disponibilidad)? */
  function isSeedSlot(index: number): boolean {
    if (!hasSeeds) return false;
    if (opts.dailyVolume !== undefined) {
      return index < seedQuota(opts.dailyVolume);
    }
    return index % stride === 0; // mejor esfuerzo sin volumen conocido: ~1 de cada `stride`
  }

  function pick(nodeId: string, index: number): EngagedRecipient | undefined {
    if (!hasSeeds && !hasCurated) return undefined;

    const wantsSeed = isSeedSlot(index);

    // Slot de seed (o curated agotado ⇒ cae a seed): round-robin determinista sobre los seeds.
    if ((wantsSeed && hasSeeds) || !hasCurated) {
      if (!hasSeeds) return undefined; // no debería ocurrir (cubierto arriba)
      return seedRecipients[index % seedRecipients.length];
    }

    // Slot de curated: rotación ponderada determinista por (nodeId, index).
    return pickWeighted(curatedRecipients, unitFor(nodeId, index));
  }

  return { pick, seedQuota };
}
