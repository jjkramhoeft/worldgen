/**
 * Deterministic hashing and pseudo-random helpers.
 *
 * Every generator in the app is a pure function of (seed, position), so all
 * randomness flows through these integer hashes rather than Math.random().
 */

/**
 * Turns a user-facing seed into a 32-bit integer.
 * Like Minecraft: numeric text is used as a number, other text is hashed with
 * Java's String.hashCode so "Glacier" always gives the same world.
 */
export function seedFromString(text: string): number {
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const big = BigInt(trimmed);
    // Fold 64-bit seeds into 32 bits so long Minecraft-style seeds still differ.
    return Number(BigInt.asUintN(32, big ^ (big >> 32n)));
  }
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) h = (Math.imul(31, h) + trimmed.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** "lowbias32" integer finalizer by Chris Wellons — fast and well mixed. */
export function mix32(x: number): number {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash of an integer lattice point (2D). Returns an unsigned 32-bit int. */
export function hash2i(x: number, y: number, seed: number): number {
  return mix32(Math.imul(x | 0, 0x27d4eb2d) ^ mix32(Math.imul(y | 0, 0x165667b1) ^ seed));
}

/** Hash of an integer lattice point (3D). Returns an unsigned 32-bit int. */
export function hash3i(x: number, y: number, z: number, seed: number): number {
  return mix32(
    Math.imul(x | 0, 0x27d4eb2d) ^ mix32(Math.imul(y | 0, 0x165667b1) ^ mix32(Math.imul(z | 0, 0x9e3779b1) ^ seed)),
  );
}

/** Maps an unsigned 32-bit hash to [0, 1). */
export function unit(h: number): number {
  return (h >>> 0) / 4294967296;
}

/** Derives a child seed, e.g. galaxy → region → system → planet. */
export function deriveSeed(seed: number, ...parts: number[]): number {
  let h = seed >>> 0;
  for (const p of parts) h = mix32(h ^ mix32((p | 0) + 0x9e3779b9));
  return h;
}

/** Small, fast seeded PRNG (mulberry32) with convenience helpers. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  weighted<T>(items: readonly { value: T; weight: number }[]): T {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = this.next() * total;
    for (const item of items) {
      r -= item.weight;
      if (r <= 0) return item.value;
    }
    return items[items.length - 1].value;
  }
}
