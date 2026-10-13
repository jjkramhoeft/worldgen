/**
 * Fractal noise layers built from the base noises.
 *
 *  - fbm      classic fractal Brownian motion (sum of octaves)
 *  - billow   |n| folded octaves → puffy hills, dunes
 *  - ridged   Musgrave ridged multifractal with weight feedback → mountain crests
 *  - erosion  Inigo Quilez's derivative fBm: detail is damped where the
 *             accumulated slope is high, imitating eroded terrain
 *  - uber     a No Man's Sky inspired "uber noise". Parameter names follow the
 *             game's TkNoiseUberData (SharpToRoundFeatures, AmplifyFeatures,
 *             PerturbFeatures, SlopeErosion, AltitudeErosion, RidgeErosion).
 *             The exact NMS formulas are not public; this is a reconstruction
 *             built from IQ's derivative damping and Swiss-turbulence ideas.
 *
 * Every sampler takes an optional `maxFreq` (cycles per unit). Octaves above
 * it are skipped and the ones near it fade out — level-of-detail meshes pass
 * 1 / (2 × vertex spacing) so coarse tiles never alias fine detail into spikes.
 */
import { Noise, type NoiseKind } from './noise';
import { deriveSeed } from './rng';

export type FractalKind = 'fbm' | 'billow' | 'ridged' | 'erosion' | 'uber';
export const FRACTAL_KINDS: FractalKind[] = ['fbm', 'billow', 'ridged', 'erosion', 'uber'];

export interface FractalSettings {
  noise: NoiseKind;
  fractal: FractalKind;
  /** Wavelength of the first octave, in world units. */
  scale: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  /** uber: -1 billow … 0 smooth … +1 ridged. */
  sharpness: number;
  /** erosion/uber: how strongly accumulated slope damps finer octaves. */
  slopeErosion: number;
  /** uber: how strongly low altitude damps finer octaves (smooth valleys, rough peaks). */
  altitudeErosion: number;
  /** uber: damps finer octaves on sharp crests, rounding ridgelines. */
  ridgeErosion: number;
  /** uber: domain perturbation driven by the noise derivative. */
  perturb: number;
  /** uber: amplify the next octave where the current one is high. */
  featureAmp: number;
}

export const DEFAULT_FRACTAL: FractalSettings = {
  noise: 'simplex',
  fractal: 'fbm',
  scale: 500,
  octaves: 5,
  lacunarity: 2,
  gain: 0.5,
  sharpness: 0,
  slopeErosion: 0,
  altitudeErosion: 0,
  ridgeErosion: 0,
  perturb: 0,
  featureAmp: 0,
};

const MAX_OCTAVES = 16;
// Rotating each octave (~36.9°, the 3-4-5 triangle used by IQ) hides lattice alignment.
const OCTAVE_ANGLE = Math.atan2(0.6, 0.8);

/** Weight of an octave of frequency f under the limit: 1 up to max/2, fading to 0 at max. */
function octaveFade(f: number, maxFreq: number): number {
  return f <= maxFreq * 0.5 ? 1 : 2 - (2 * f) / maxFreq;
}

/** 0 on rounded ground … 1 on sharp crests (crest = average of 1 - |n| over earlier octaves). */
function crestFade(c: number): number {
  const t = Math.max(0, Math.min(1, (c - 0.55) / 0.4));
  return t * t * (3 - 2 * t);
}

export class Fractal2 {
  private readonly noises: Noise[] = [];
  private readonly cos = new Float64Array(MAX_OCTAVES);
  private readonly sin = new Float64Array(MAX_OCTAVES);
  private readonly freq = new Float64Array(MAX_OCTAVES);
  private readonly amp = new Float64Array(MAX_OCTAVES);
  private readonly octaves: number;
  private readonly norm: number;
  private readonly kind: NoiseKind;
  private readonly d = new Float64Array(3);
  readonly sample: (x: number, z: number, maxFreq?: number) => number;

  constructor(
    seed: number,
    readonly s: FractalSettings,
  ) {
    this.octaves = Math.max(1, Math.min(MAX_OCTAVES, Math.round(s.octaves)));
    this.kind = s.noise;
    let f = 1 / Math.max(1e-6, s.scale);
    let a = 1;
    let norm = 0;
    for (let o = 0; o < this.octaves; o++) {
      this.noises.push(new Noise(deriveSeed(seed, o)));
      this.cos[o] = Math.cos(OCTAVE_ANGLE * o);
      this.sin[o] = Math.sin(OCTAVE_ANGLE * o);
      this.freq[o] = f;
      this.amp[o] = a;
      norm += a;
      f *= s.lacunarity;
      a *= s.gain;
    }
    this.norm = norm;
    switch (s.fractal) {
      case 'billow':
        this.sample = this.billow;
        break;
      case 'ridged':
        this.sample = this.ridged;
        break;
      case 'erosion':
        this.sample = this.erosion;
        break;
      case 'uber':
        this.sample = this.uber;
        break;
      default:
        this.sample = this.fbm;
    }
  }

  private fbm = (x: number, z: number, maxFreq = Infinity): number => {
    let sum = 0;
    for (let o = 0; o < this.octaves; o++) {
      const f = this.freq[o];
      if (f >= maxFreq) break;
      const c = this.cos[o], s = this.sin[o];
      sum += this.noises[o].sample2(this.kind, (x * c - z * s) * f, (x * s + z * c) * f, this.d) * this.amp[o] * octaveFade(f, maxFreq);
    }
    return sum / this.norm;
  };

  private billow = (x: number, z: number, maxFreq = Infinity): number => {
    let sum = 0;
    for (let o = 0; o < this.octaves; o++) {
      const f = this.freq[o];
      if (f >= maxFreq) break;
      const c = this.cos[o], s = this.sin[o];
      const n = this.noises[o].sample2(this.kind, (x * c - z * s) * f, (x * s + z * c) * f, this.d);
      sum += (Math.abs(n) * 2 - 1) * this.amp[o] * octaveFade(f, maxFreq);
    }
    return sum / this.norm;
  };

  private ridged = (x: number, z: number, maxFreq = Infinity): number => {
    let sum = 0;
    let weight = 1;
    for (let o = 0; o < this.octaves; o++) {
      const f = this.freq[o];
      if (f >= maxFreq) break;
      const c = this.cos[o], s = this.sin[o];
      const n = this.noises[o].sample2(this.kind, (x * c - z * s) * f, (x * s + z * c) * f, this.d);
      let signal = 1 - Math.abs(n);
      signal *= signal * weight;
      weight = Math.min(1, Math.max(0, signal * 2));
      sum += signal * this.amp[o] * octaveFade(f, maxFreq);
    }
    return (sum / this.norm) * 2 - 1;
  };

  private erosion = (x: number, z: number, maxFreq = Infinity): number => {
    const d = this.d;
    const k = this.s.slopeErosion;
    let sum = 0;
    let dx = 0;
    let dz = 0;
    for (let o = 0; o < this.octaves; o++) {
      const f = this.freq[o];
      if (f >= maxFreq) break;
      const fade = octaveFade(f, maxFreq);
      const c = this.cos[o], s = this.sin[o];
      const n = this.noises[o].sample2(this.kind, (x * c - z * s) * f, (x * s + z * c) * f, d);
      // Rotate the octave-space derivative back into the world frame before accumulating.
      dx += (d[0] * c + d[1] * s) * fade;
      dz += (-d[0] * s + d[1] * c) * fade;
      sum += (this.amp[o] * n * fade) / (1 + k * (dx * dx + dz * dz));
    }
    return sum / this.norm;
  };

  private uber = (x: number, z: number, maxFreq = Infinity): number => {
    const d = this.d;
    const { sharpness, slopeErosion, altitudeErosion, ridgeErosion, perturb, featureAmp, gain } = this.s;
    const sharpAbs = Math.abs(sharpness);
    let px = x;
    let pz = z;
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let dx = 0;
    let dz = 0;
    let crest = 0;
    for (let o = 0; o < this.octaves; o++) {
      const f = this.freq[o];
      if (f >= maxFreq) {
        // Keep the normalisation of the full stack so coarse LODs keep the same overall height.
        for (let k = o; k < this.octaves; k++) {
          norm += amp;
          amp *= gain;
        }
        break;
      }
      const fade = octaveFade(f, maxFreq);
      const c = this.cos[o], s = this.sin[o];
      const n = this.noises[o].sample2(this.kind, (px * c - pz * s) * f, (px * s + pz * c) * f, d);
      const wdx = d[0] * c + d[1] * s;
      const wdz = -d[0] * s + d[1] * c;

      // Sharpness: blend the raw octave towards ridged (crests) or billow (rounded) shapes.
      let v = n;
      if (sharpness > 0) v = n + sharpness * (1 - 2 * Math.abs(n) - n);
      else if (sharpness < 0) v = n + sharpAbs * (2 * Math.abs(n) - 1 - n);

      // Slope erosion (accumulated derivative damps detail on steep ground). The raw,
      // continuous derivative is used: the shaped one flips sign at every crease,
      // which would make the damping jump and tear steps into the ridgelines.
      dx += wdx * fade;
      dz += wdz * fade;
      const slopeDamp = 1 / (1 + slopeErosion * (dx * dx + dz * dz));

      // Altitude erosion: finer octaves fade in low areas so valleys stay smooth.
      const altitude = norm > 0 ? sum / norm : 0;
      const altDamp = 1 - altitudeErosion * (0.5 - 0.5 * Math.max(-1, Math.min(1, altitude)));
      // Ridge erosion: finer octaves fade on the crests built by earlier octaves.
      const ridgeDamp = norm > 0 ? 1 - ridgeErosion * crestFade(crest / norm) : 1;

      sum += amp * v * slopeDamp * altDamp * ridgeDamp * fade;
      crest += (1 - Math.abs(n)) * amp;
      norm += amp;

      // Feature amplification: strong features breed stronger detail on top of them.
      amp *= gain * Math.max(0, 1 + featureAmp * v);

      // Perturb: shift the domain along the derivative by a fraction of this octave's wavelength.
      if (perturb !== 0) {
        const k = ((perturb * 0.25) / (f * (o + 1))) * fade;
        px += wdx * k;
        pz += wdz * k;
      }
    }
    return sum / Math.max(1e-6, norm);
  };
}

/** Inigo Quilez style domain warping: p + strength · fbm(p) (optionally iterated twice). */
export interface WarpSettings {
  enabled: boolean;
  /** Displacement in world units. */
  strength: number;
  scale: number;
  octaves: number;
  iterations: number;
}

export class DomainWarp2 {
  private readonly ax: Fractal2;
  private readonly az: Fractal2;
  private readonly bx: Fractal2;
  private readonly bz: Fractal2;

  constructor(
    seed: number,
    readonly s: WarpSettings,
  ) {
    const base = { ...DEFAULT_FRACTAL, scale: s.scale, octaves: s.octaves };
    this.ax = new Fractal2(deriveSeed(seed, 1), base);
    this.az = new Fractal2(deriveSeed(seed, 2), base);
    this.bx = new Fractal2(deriveSeed(seed, 3), base);
    this.bz = new Fractal2(deriveSeed(seed, 4), base);
  }

  /** Writes the warped coordinates into out[0], out[1]. */
  apply(x: number, z: number, out: Float64Array, maxFreq = Infinity): void {
    const k = this.s.strength;
    let qx = this.ax.sample(x, z, maxFreq);
    let qz = this.az.sample(x + 5.2 * this.s.scale, z + 1.3 * this.s.scale, maxFreq);
    if (this.s.iterations >= 2) {
      const wx = x + k * qx;
      const wz = z + k * qz;
      qx = this.bx.sample(wx + 1.7 * this.s.scale, wz + 9.2 * this.s.scale, maxFreq);
      qz = this.bz.sample(wx + 8.3 * this.s.scale, wz + 2.8 * this.s.scale, maxFreq);
    }
    out[0] = x + k * qx;
    out[1] = z + k * qz;
  }
}

// IQ's 3D octave rotation matrix (orthonormal).
const M3 = [0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64];

/** 3D fractal noise, used for planets, voxel overhangs and caves. */
export class Fractal3 {
  private readonly noises: Noise[] = [];
  /** Per-octave rotation matrices (row-major 3×3). */
  private readonly rot: Float64Array;
  private readonly freq = new Float64Array(MAX_OCTAVES);
  private readonly amp = new Float64Array(MAX_OCTAVES);
  private readonly octaves: number;
  private readonly norm: number;
  private readonly d = new Float64Array(3);

  constructor(
    seed: number,
    readonly s: FractalSettings,
  ) {
    this.octaves = Math.max(1, Math.min(MAX_OCTAVES, Math.round(s.octaves)));
    this.rot = new Float64Array(this.octaves * 9);
    let m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let f = 1 / Math.max(1e-6, s.scale);
    let a = 1;
    let norm = 0;
    for (let o = 0; o < this.octaves; o++) {
      this.noises.push(new Noise(deriveSeed(seed, 100 + o)));
      this.rot.set(m, o * 9);
      this.freq[o] = f;
      this.amp[o] = a;
      norm += a;
      f *= s.lacunarity;
      a *= s.gain;
      m = mul3(M3, m);
    }
    this.norm = norm;
  }

  /**
   * Samples the layer. When (nx, ny, nz) is given (a unit surface normal, e.g.
   * on a planet), slope erosion only considers the tangential gradient.
   */
  sample(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0, maxFreq = Infinity): number {
    const s = this.s;
    switch (s.fractal) {
      case 'fbm':
      case 'billow':
      case 'ridged':
        return this.simple(x, y, z, maxFreq);
      default:
        return this.uber(x, y, z, nx, ny, nz, s.fractal === 'erosion', maxFreq);
    }
  }

  private simple(x: number, y: number, z: number, maxFreq: number): number {
    const kind = this.s.noise;
    const fr = this.s.fractal;
    let sum = 0;
    let weight = 1;
    for (let o = 0; o < this.octaves; o++) {
      const f = this.freq[o];
      if (f >= maxFreq) break;
      const fade = octaveFade(f, maxFreq);
      const r = this.rot, i = o * 9;
      const rx = (r[i] * x + r[i + 1] * y + r[i + 2] * z) * f;
      const ry = (r[i + 3] * x + r[i + 4] * y + r[i + 5] * z) * f;
      const rz = (r[i + 6] * x + r[i + 7] * y + r[i + 8] * z) * f;
      const n = this.noises[o].sample3(kind, rx, ry, rz);
      if (fr === 'billow') {
        sum += (Math.abs(n) * 2 - 1) * this.amp[o] * fade;
      } else if (fr === 'ridged') {
        let signal = 1 - Math.abs(n);
        signal *= signal * weight;
        weight = Math.min(1, Math.max(0, signal * 2));
        sum += signal * this.amp[o] * fade;
      } else {
        sum += n * this.amp[o] * fade;
      }
    }
    const v = sum / this.norm;
    return fr === 'ridged' ? v * 2 - 1 : v;
  }

  private uber(x: number, y: number, z: number, nx: number, ny: number, nz: number, iqOnly: boolean, maxFreq: number): number {
    const d = this.d;
    const s = this.s;
    const sharpness = iqOnly ? 0 : s.sharpness;
    const sharpAbs = Math.abs(sharpness);
    const altitudeErosion = iqOnly ? 0 : s.altitudeErosion;
    const ridgeErosion = iqOnly ? 0 : s.ridgeErosion;
    const featureAmp = iqOnly ? 0 : s.featureAmp;
    const perturb = iqOnly ? 0 : s.perturb;
    const hasNormal = nx !== 0 || ny !== 0 || nz !== 0;
    let px = x, py = y, pz = z;
    let sum = 0, norm = 0, amp = 1, crest = 0;
    let gx = 0, gy = 0, gz = 0;
    for (let o = 0; o < this.octaves; o++) {
      const f = this.freq[o];
      if (f >= maxFreq) {
        for (let k = o; k < this.octaves; k++) {
          norm += amp;
          amp *= s.gain;
        }
        break;
      }
      const fade = octaveFade(f, maxFreq);
      const r = this.rot, i = o * 9;
      const rx = (r[i] * px + r[i + 1] * py + r[i + 2] * pz) * f;
      const ry = (r[i + 3] * px + r[i + 4] * py + r[i + 5] * pz) * f;
      const rz = (r[i + 6] * px + r[i + 7] * py + r[i + 8] * pz) * f;
      const n = this.noises[o].simplex3(rx, ry, rz, d);
      // World-frame derivative = Rᵀ · d (rotation only; frequency scaling left out like IQ).
      let wx = r[i] * d[0] + r[i + 3] * d[1] + r[i + 6] * d[2];
      let wy = r[i + 1] * d[0] + r[i + 4] * d[1] + r[i + 7] * d[2];
      let wz = r[i + 2] * d[0] + r[i + 5] * d[1] + r[i + 8] * d[2];
      if (hasNormal) {
        const dn = wx * nx + wy * ny + wz * nz;
        wx -= dn * nx;
        wy -= dn * ny;
        wz -= dn * nz;
      }

      let v = n;
      if (sharpness > 0) v = n + sharpness * (1 - 2 * Math.abs(n) - n);
      else if (sharpness < 0) v = n + sharpAbs * (2 * Math.abs(n) - 1 - n);

      gx += wx * fade;
      gy += wy * fade;
      gz += wz * fade;
      const slopeDamp = 1 / (1 + s.slopeErosion * (gx * gx + gy * gy + gz * gz));
      const altitude = norm > 0 ? sum / norm : 0;
      const altDamp = 1 - altitudeErosion * (0.5 - 0.5 * Math.max(-1, Math.min(1, altitude)));
      const ridgeDamp = norm > 0 ? 1 - ridgeErosion * crestFade(crest / norm) : 1;

      sum += amp * v * slopeDamp * altDamp * ridgeDamp * fade;
      crest += (1 - Math.abs(n)) * amp;
      norm += amp;
      amp *= s.gain * Math.max(0, 1 + featureAmp * v);

      if (perturb !== 0) {
        const k = ((perturb * 0.25) / (f * Math.max(1, o + 1))) * fade;
        px += wx * k;
        py += wy * k;
        pz += wz * k;
      }
    }
    return sum / Math.max(1e-6, norm);
  }
}

function mul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}
