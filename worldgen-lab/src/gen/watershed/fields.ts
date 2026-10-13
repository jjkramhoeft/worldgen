/**
 * The smooth fields the Watershed world is built from: uplift (where mountains
 * rise), rain, temperature, the outlet start cost and the detail noise. Both the
 * per-region network build and the per-sample surface read them, so they live in
 * one place and give identical values everywhere.
 */
import { DEFAULT_FRACTAL, Fractal2 } from '../../core/fractal';
import { deriveSeed, seedFromString } from '../../core/rng';
import { smoothstep } from '../../core/color';
import type { ClimateNoise, WatershedSettings } from '../settings';
import { RegionLattice } from './regions';

/** Uplift range: plains get U_MIN, the crest of a mountain belt U_MAX. */
export const U_MIN = 0.3;
export const U_MAX = 1.8;

class Layer {
  private readonly f: Fractal2;
  constructor(
    seed: number,
    private readonly n: ClimateNoise,
  ) {
    this.f = new Fractal2(seed, { ...DEFAULT_FRACTAL, noise: n.noise, scale: n.scale, octaves: n.octaves, lacunarity: n.lacunarity, gain: n.gain });
  }

  /** Noise × contrast + offset, clamped to [−1, 1]. */
  sample(x: number, z: number, maxFreq = Infinity): number {
    const v = this.f.sample(x, z, maxFreq) * this.n.amplitude + this.n.offset;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }
}

export class WatershedFields {
  readonly seed: number;
  readonly lattice: RegionLattice;
  readonly detail: Fractal2;
  private readonly upliftNoise: Layer;
  private readonly rainNoise: Layer;
  private readonly tempNoise: Layer;
  private readonly mouthNoise: Fractal2;

  constructor(
    seedText: string,
    readonly s: WatershedSettings,
  ) {
    this.seed = seedFromString(seedText);
    const seed = deriveSeed(this.seed, 4000);
    this.lattice = new RegionLattice(seed, s);
    this.upliftNoise = new Layer(deriveSeed(seed, 1), s.relief.uplift);
    this.rainNoise = new Layer(deriveSeed(seed, 2), s.climate.rain);
    this.tempNoise = new Layer(deriveSeed(seed, 3), s.climate.temperature);
    this.mouthNoise = new Fractal2(deriveSeed(seed, 4), { ...DEFAULT_FRACTAL, scale: 9000, octaves: 2 });
    this.detail = new Fractal2(deriveSeed(seed, 5), s.relief.detail);
  }

  /**
   * Uplift U(p) ∈ [U_MIN, U_MAX]: the zero lines of a noise become mountain
   * belts, and U halves towards the coast (L in metres) so coasts stay gentle.
   */
  uplift(x: number, z: number, L: number, maxFreq = Infinity): number {
    const r = 1 - Math.abs(this.upliftNoise.sample(x, z, maxFreq));
    return (U_MIN + (U_MAX - U_MIN) * r * r * r) * (0.5 + 0.5 * smoothstep(0, 3000, L));
  }

  /** Rain multiplier, 0.4 … 1.6. */
  rain(x: number, z: number, maxFreq = Infinity): number {
    return 1 + 0.6 * this.rainNoise.sample(x, z, maxFreq);
  }

  /** Climate temperature in [−1, 1] (altitude cooling is applied by the biome rules). */
  temperature(x: number, z: number, maxFreq = Infinity): number {
    return this.tempNoise.sample(x, z, maxFreq);
  }

  /** Start-cost noise of the outlets, in [0, 1]. */
  mouth(x: number, z: number): number {
    const v = 0.5 + 0.9 * this.mouthNoise.sample(x, z);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * Hillslope S_hill = clamp(k·U·A_cell^−θ): the slope a single headwater cell of
   * the network grid gets. Valley walls use it.
   */
  hillSlope(U: number): number {
    const s = this.s;
    const cell = (s.network.grid / 1000) ** 2;
    const v = s.relief.k * U * Math.pow(cell, -s.relief.concavity);
    return Math.max(s.relief.minSlope, Math.min(s.relief.maxSlope, v));
  }
}
