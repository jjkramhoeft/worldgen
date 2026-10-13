/**
 * Seeded gradient/value/cellular noise in 2D and 3D.
 *
 * Lattice points are hashed with large primes (the approach used by
 * FastNoiseLite) instead of a 256-entry permutation table, so the noise never
 * repeats and the seed is applied directly. Simplex and Perlin variants can
 * return analytic derivatives — the building block for derivative-based
 * "erosion" fBm (Inigo Quilez) and No Man's Sky style slope erosion.
 *
 * All outputs are scaled to roughly [-1, 1].
 */

const PX = 501125321;
const PY = 1136930381;
const PZ = 1720413743;

// Empirically calibrated so the outputs span roughly [-1, 1] (see tests/noise.test.ts).
const SIMPLEX2_SCALE = 99.2;
const SIMPLEX3_SCALE = 75.2;
const PERLIN2_SCALE = 1.49;
const PERLIN3_SCALE = 1.04;

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

/** 16 unit gradients evenly spread around the circle (offset to avoid axis bias). */
const GRAD2 = new Float64Array(32);
for (let k = 0; k < 16; k++) {
  const a = ((k + 0.5) / 16) * Math.PI * 2;
  GRAD2[k * 2] = Math.cos(a);
  GRAD2[k * 2 + 1] = Math.sin(a);
}

/** The 12 cube-edge gradients padded to 16 entries (Perlin's improved noise). */
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1,
  -1, 1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
]);

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function dfade(t: number): number {
  return 30 * t * t * (t * (t - 2) + 1);
}

function g2(seed: number, xp: number, yp: number): number {
  let h = Math.imul(seed ^ xp ^ yp, 0x27d4eb2d);
  h ^= h >>> 15;
  return (h & 15) << 1;
}

function g3(seed: number, xp: number, yp: number, zp: number): number {
  let h = Math.imul(seed ^ xp ^ yp ^ zp, 0x27d4eb2d);
  h ^= h >>> 15;
  return (h & 15) * 3;
}

function val2(seed: number, xp: number, yp: number): number {
  let h = Math.imul(seed ^ xp ^ yp, 0x27d4eb2d);
  h = Math.imul(h, h);
  h ^= h << 19;
  return h / 2147483648;
}

function val3(seed: number, xp: number, yp: number, zp: number): number {
  let h = Math.imul(seed ^ xp ^ yp ^ zp, 0x27d4eb2d);
  h = Math.imul(h, h);
  h ^= h << 19;
  return h / 2147483648;
}

function cellHash(seed: number, xp: number, yp: number, zp: number): number {
  let h = Math.imul(seed ^ xp ^ yp ^ zp, 0x27d4eb2d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Scratch array for callers that do not need derivatives. */
const SCRATCH = new Float64Array(3);

export type NoiseKind = 'simplex' | 'perlin' | 'value' | 'worley' | 'cells';

export const NOISE_KINDS: NoiseKind[] = ['simplex', 'perlin', 'value', 'worley', 'cells'];

export class Noise {
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed | 0;
  }

  // ───────────────────────────── 2D ─────────────────────────────

  /** 2D simplex noise; writes d/dx, d/dy into `d`. */
  simplex2(x: number, y: number, d: Float64Array = SCRATCH): number {
    const seed = this.seed;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - i + t;
    const y0 = y - j + t;
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ip = Math.imul(i, PX);
    const jp = Math.imul(j, PY);

    let n = 0;
    let dx = 0;
    let dy = 0;

    let a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) {
      const g = g2(seed, ip, jp);
      const gx = GRAD2[g];
      const gy = GRAD2[g + 1];
      const gd = gx * x0 + gy * y0;
      const a2 = a * a;
      const a4 = a2 * a2;
      const k = -8 * a2 * a * gd;
      n += a4 * gd;
      dx += k * x0 + a4 * gx;
      dy += k * y0 + a4 * gy;
    }
    a = 0.5 - x1 * x1 - y1 * y1;
    if (a > 0) {
      const g = g2(seed, i1 ? (ip + PX) | 0 : ip, j1 ? (jp + PY) | 0 : jp);
      const gx = GRAD2[g];
      const gy = GRAD2[g + 1];
      const gd = gx * x1 + gy * y1;
      const a2 = a * a;
      const a4 = a2 * a2;
      const k = -8 * a2 * a * gd;
      n += a4 * gd;
      dx += k * x1 + a4 * gx;
      dy += k * y1 + a4 * gy;
    }
    a = 0.5 - x2 * x2 - y2 * y2;
    if (a > 0) {
      const g = g2(seed, (ip + PX) | 0, (jp + PY) | 0);
      const gx = GRAD2[g];
      const gy = GRAD2[g + 1];
      const gd = gx * x2 + gy * y2;
      const a2 = a * a;
      const a4 = a2 * a2;
      const k = -8 * a2 * a * gd;
      n += a4 * gd;
      dx += k * x2 + a4 * gx;
      dy += k * y2 + a4 * gy;
    }
    d[0] = dx * SIMPLEX2_SCALE;
    d[1] = dy * SIMPLEX2_SCALE;
    return n * SIMPLEX2_SCALE;
  }

  /** 2D gradient (Perlin) noise with quintic fade; writes derivatives into `d`. */
  perlin2(x: number, y: number, d: Float64Array = SCRATCH): number {
    const seed = this.seed;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    const u = fade(fx);
    const v = fade(fy);
    const du = dfade(fx);
    const dv = dfade(fy);
    const x0 = Math.imul(xf, PX);
    const y0 = Math.imul(yf, PY);
    const x1 = (x0 + PX) | 0;
    const y1 = (y0 + PY) | 0;

    const a = g2(seed, x0, y0);
    const b = g2(seed, x1, y0);
    const c = g2(seed, x0, y1);
    const e = g2(seed, x1, y1);
    const ax = GRAD2[a], ay = GRAD2[a + 1];
    const bx = GRAD2[b], by = GRAD2[b + 1];
    const cx = GRAD2[c], cy = GRAD2[c + 1];
    const ex = GRAD2[e], ey = GRAD2[e + 1];

    const n00 = ax * fx + ay * fy;
    const n10 = bx * (fx - 1) + by * fy;
    const n01 = cx * fx + cy * (fy - 1);
    const n11 = ex * (fx - 1) + ey * (fy - 1);

    const k1 = n10 - n00;
    const k2 = n01 - n00;
    const k3 = n00 - n10 - n01 + n11;
    const uv = u * v;

    d[0] = (ax + u * (bx - ax) + v * (cx - ax) + uv * (ax - bx - cx + ex) + du * (k1 + k3 * v)) * PERLIN2_SCALE;
    d[1] = (ay + u * (by - ay) + v * (cy - ay) + uv * (ay - by - cy + ey) + dv * (k2 + k3 * u)) * PERLIN2_SCALE;
    return (n00 + k1 * u + k2 * v + k3 * uv) * PERLIN2_SCALE;
  }

  /** 2D value noise with quintic interpolation; writes derivatives into `d`. */
  value2(x: number, y: number, d: Float64Array = SCRATCH): number {
    const seed = this.seed;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    const u = fade(fx);
    const v = fade(fy);
    const x0 = Math.imul(xf, PX);
    const y0 = Math.imul(yf, PY);
    const x1 = (x0 + PX) | 0;
    const y1 = (y0 + PY) | 0;
    const a = val2(seed, x0, y0);
    const b = val2(seed, x1, y0);
    const c = val2(seed, x0, y1);
    const e = val2(seed, x1, y1);
    const k3 = a - b - c + e;
    d[0] = dfade(fx) * (b - a + k3 * v);
    d[1] = dfade(fy) * (c - a + k3 * u);
    return a + (b - a) * u + (c - a) * v + k3 * u * v;
  }

  /**
   * 2D cellular (Worley) noise. Writes F1 into d[0] and F2 into d[1]
   * (distances to the nearest and second-nearest feature point).
   */
  worley2(x: number, y: number, d: Float64Array = SCRATCH, jitter = 1): number {
    const seed = this.seed;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let f1 = 9;
    let f2 = 9;
    for (let oy = -1; oy <= 1; oy++) {
      const cy = yi + oy;
      const yp = Math.imul(cy, PY);
      for (let ox = -1; ox <= 1; ox++) {
        const cx = xi + ox;
        const h = cellHash(seed, Math.imul(cx, PX), yp, 0);
        const px = cx + 0.5 + ((h & 0xffff) / 65535 - 0.5) * jitter;
        const py = cy + 0.5 + ((h >>> 16) / 65535 - 0.5) * jitter;
        const dx = px - x;
        const dy = py - y;
        const dist = dx * dx + dy * dy;
        if (dist < f1) {
          f2 = f1;
          f1 = dist;
        } else if (dist < f2) {
          f2 = dist;
        }
      }
    }
    d[0] = Math.sqrt(f1);
    d[1] = Math.sqrt(f2);
    return d[0];
  }

  /** Generic 2D sampler used by fractal layers. Derivatives are analytic where available. */
  sample2(kind: NoiseKind, x: number, y: number, d: Float64Array = SCRATCH): number {
    switch (kind) {
      case 'simplex':
        return this.simplex2(x, y, d);
      case 'perlin':
        return this.perlin2(x, y, d);
      case 'value':
        return this.value2(x, y, d);
      case 'worley':
      case 'cells': {
        const n = this.cellular2(kind, x, y);
        // Cellular noise has no cheap analytic derivative; use central differences.
        const e = 0.01;
        d[0] = (this.cellular2(kind, x + e, y) - this.cellular2(kind, x - e, y)) / (2 * e);
        d[1] = (this.cellular2(kind, x, y + e) - this.cellular2(kind, x, y - e)) / (2 * e);
        return n;
      }
    }
  }

  /** Cellular noise remapped to roughly [-1, 1]: bumps ("worley") or cell walls ("cells"). */
  cellular2(kind: 'worley' | 'cells', x: number, y: number): number {
    this.worley2(x, y, CELL_SCRATCH);
    if (kind === 'worley') return Math.max(-1, 1 - CELL_SCRATCH[0] * 1.8);
    // Ridges along cell borders (where F2 - F1 → 0); sqrt balances the skewed distribution.
    return 1 - 2 * Math.sqrt(Math.min((CELL_SCRATCH[1] - CELL_SCRATCH[0]) / 1.25, 1));
  }

  // ───────────────────────────── 3D ─────────────────────────────

  /** 3D simplex noise (r² = 0.5 kernel, continuous); writes derivatives into `d`. */
  simplex3(x: number, y: number, z: number, d: Float64Array = SCRATCH): number {
    const seed = this.seed;
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - i + t;
    const y0 = y - j + t;
    const z0 = z - k + t;

    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    const ip = Math.imul(i, PX);
    const jp = Math.imul(j, PY);
    const kp = Math.imul(k, PZ);

    let n = 0, dx = 0, dy = 0, dz = 0;

    let a = 0.5 - x0 * x0 - y0 * y0 - z0 * z0;
    if (a > 0) {
      const g = g3(seed, ip, jp, kp);
      const gx = GRAD3[g], gy = GRAD3[g + 1], gz = GRAD3[g + 2];
      const gd = gx * x0 + gy * y0 + gz * z0;
      const a2 = a * a, a4 = a2 * a2, m = -8 * a2 * a * gd;
      n += a4 * gd;
      dx += m * x0 + a4 * gx; dy += m * y0 + a4 * gy; dz += m * z0 + a4 * gz;
    }
    a = 0.5 - x1 * x1 - y1 * y1 - z1 * z1;
    if (a > 0) {
      const g = g3(seed, i1 ? (ip + PX) | 0 : ip, j1 ? (jp + PY) | 0 : jp, k1 ? (kp + PZ) | 0 : kp);
      const gx = GRAD3[g], gy = GRAD3[g + 1], gz = GRAD3[g + 2];
      const gd = gx * x1 + gy * y1 + gz * z1;
      const a2 = a * a, a4 = a2 * a2, m = -8 * a2 * a * gd;
      n += a4 * gd;
      dx += m * x1 + a4 * gx; dy += m * y1 + a4 * gy; dz += m * z1 + a4 * gz;
    }
    a = 0.5 - x2 * x2 - y2 * y2 - z2 * z2;
    if (a > 0) {
      const g = g3(seed, i2 ? (ip + PX) | 0 : ip, j2 ? (jp + PY) | 0 : jp, k2 ? (kp + PZ) | 0 : kp);
      const gx = GRAD3[g], gy = GRAD3[g + 1], gz = GRAD3[g + 2];
      const gd = gx * x2 + gy * y2 + gz * z2;
      const a2 = a * a, a4 = a2 * a2, m = -8 * a2 * a * gd;
      n += a4 * gd;
      dx += m * x2 + a4 * gx; dy += m * y2 + a4 * gy; dz += m * z2 + a4 * gz;
    }
    a = 0.5 - x3 * x3 - y3 * y3 - z3 * z3;
    if (a > 0) {
      const g = g3(seed, (ip + PX) | 0, (jp + PY) | 0, (kp + PZ) | 0);
      const gx = GRAD3[g], gy = GRAD3[g + 1], gz = GRAD3[g + 2];
      const gd = gx * x3 + gy * y3 + gz * z3;
      const a2 = a * a, a4 = a2 * a2, m = -8 * a2 * a * gd;
      n += a4 * gd;
      dx += m * x3 + a4 * gx; dy += m * y3 + a4 * gy; dz += m * z3 + a4 * gz;
    }
    d[0] = dx * SIMPLEX3_SCALE;
    d[1] = dy * SIMPLEX3_SCALE;
    d[2] = dz * SIMPLEX3_SCALE;
    return n * SIMPLEX3_SCALE;
  }

  /** 3D gradient (Perlin) noise, no derivatives. */
  perlin3(x: number, y: number, z: number): number {
    const seed = this.seed;
    const xf = Math.floor(x), yf = Math.floor(y), zf = Math.floor(z);
    const fx = x - xf, fy = y - yf, fz = z - zf;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    const x0 = Math.imul(xf, PX), y0 = Math.imul(yf, PY), z0 = Math.imul(zf, PZ);
    const x1 = (x0 + PX) | 0, y1 = (y0 + PY) | 0, z1 = (z0 + PZ) | 0;

    const dot = (g: number, ax: number, ay: number, az: number) => GRAD3[g] * ax + GRAD3[g + 1] * ay + GRAD3[g + 2] * az;
    const n000 = dot(g3(seed, x0, y0, z0), fx, fy, fz);
    const n100 = dot(g3(seed, x1, y0, z0), fx - 1, fy, fz);
    const n010 = dot(g3(seed, x0, y1, z0), fx, fy - 1, fz);
    const n110 = dot(g3(seed, x1, y1, z0), fx - 1, fy - 1, fz);
    const n001 = dot(g3(seed, x0, y0, z1), fx, fy, fz - 1);
    const n101 = dot(g3(seed, x1, y0, z1), fx - 1, fy, fz - 1);
    const n011 = dot(g3(seed, x0, y1, z1), fx, fy - 1, fz - 1);
    const n111 = dot(g3(seed, x1, y1, z1), fx - 1, fy - 1, fz - 1);

    const nx00 = n000 + u * (n100 - n000);
    const nx10 = n010 + u * (n110 - n010);
    const nx01 = n001 + u * (n101 - n001);
    const nx11 = n011 + u * (n111 - n011);
    const nxy0 = nx00 + v * (nx10 - nx00);
    const nxy1 = nx01 + v * (nx11 - nx01);
    return (nxy0 + w * (nxy1 - nxy0)) * PERLIN3_SCALE;
  }

  /** 3D value noise. */
  value3(x: number, y: number, z: number): number {
    const seed = this.seed;
    const xf = Math.floor(x), yf = Math.floor(y), zf = Math.floor(z);
    const u = fade(x - xf), v = fade(y - yf), w = fade(z - zf);
    const x0 = Math.imul(xf, PX), y0 = Math.imul(yf, PY), z0 = Math.imul(zf, PZ);
    const x1 = (x0 + PX) | 0, y1 = (y0 + PY) | 0, z1 = (z0 + PZ) | 0;
    const a = val3(seed, x0, y0, z0) + u * (val3(seed, x1, y0, z0) - val3(seed, x0, y0, z0));
    const b = val3(seed, x0, y1, z0) + u * (val3(seed, x1, y1, z0) - val3(seed, x0, y1, z0));
    const c = val3(seed, x0, y0, z1) + u * (val3(seed, x1, y0, z1) - val3(seed, x0, y0, z1));
    const e = val3(seed, x0, y1, z1) + u * (val3(seed, x1, y1, z1) - val3(seed, x0, y1, z1));
    const ab = a + v * (b - a);
    const ce = c + v * (e - c);
    return ab + w * (ce - ab);
  }

  /**
   * 3D cellular noise. Writes F1/F2 distances into d[0]/d[1] and the nearest
   * feature point's hash (0..1) into d[2]. Returns F1.
   */
  worley3(x: number, y: number, z: number, d: Float64Array = SCRATCH, jitter = 1): number {
    const seed = this.seed;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let f1 = 9, f2 = 9, id = 0;
    for (let oz = -1; oz <= 1; oz++) {
      const cz = zi + oz;
      const zp = Math.imul(cz, PZ);
      for (let oy = -1; oy <= 1; oy++) {
        const cy = yi + oy;
        const yp = Math.imul(cy, PY);
        for (let ox = -1; ox <= 1; ox++) {
          const cx = xi + ox;
          const h = cellHash(seed, Math.imul(cx, PX), yp, zp);
          const h2 = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
          const px = cx + 0.5 + ((h & 0x3ff) / 1023 - 0.5) * jitter;
          const py = cy + 0.5 + (((h >>> 10) & 0x3ff) / 1023 - 0.5) * jitter;
          const pz = cz + 0.5 + (((h >>> 20) & 0x3ff) / 1023 - 0.5) * jitter;
          const dx = px - x, dy = py - y, dz = pz - z;
          const dist = dx * dx + dy * dy + dz * dz;
          if (dist < f1) {
            f2 = f1;
            f1 = dist;
            id = h2 / 4294967296;
          } else if (dist < f2) {
            f2 = dist;
          }
        }
      }
    }
    d[0] = Math.sqrt(f1);
    d[1] = Math.sqrt(f2);
    d[2] = id;
    return d[0];
  }

  /** Generic 3D sampler (value only). */
  sample3(kind: NoiseKind, x: number, y: number, z: number): number {
    switch (kind) {
      case 'simplex':
        return this.simplex3(x, y, z);
      case 'perlin':
        return this.perlin3(x, y, z);
      case 'value':
        return this.value3(x, y, z);
      case 'worley':
        this.worley3(x, y, z, CELL_SCRATCH);
        return Math.max(-1, 1 - CELL_SCRATCH[0] * 1.74);
      case 'cells':
        this.worley3(x, y, z, CELL_SCRATCH);
        return 1 - 2 * Math.sqrt(Math.min((CELL_SCRATCH[1] - CELL_SCRATCH[0]) / 1.06, 1));
    }
  }
}

const CELL_SCRATCH = new Float64Array(3);
