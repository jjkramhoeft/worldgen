/**
 * Heightmap terrain generator — a pure function of (seed, x, z).
 *
 * Pipeline (modelled on Minecraft 1.18+, with NMS-style detail noise):
 *   1. optional domain warp of the input coordinates
 *   2. climate noises: continentalness, erosion, weirdness, temperature, humidity
 *   3. peaks & valleys = 1 - |3·|weirdness| - 2|  (Minecraft's folding)
 *   4. splines: continentalness → base height, erosion → mountain factor,
 *      PV → peak multiplier; mountains only rise inland
 *   5. uber/erosion detail noise, weighted towards mountains
 *   6. rivers carved along weirdness ≈ 0 (the "valleys"), terraces, island mask
 *   7. biome classification from the climate sample
 */
import { DomainWarp2, Fractal2, DEFAULT_FRACTAL } from '../core/fractal';
import { MonotoneSpline } from '../core/spline';
import { deriveSeed, seedFromString } from '../core/rng';
import { clamp01, smoothstep } from '../core/color';
import { classifyBiome, type BiomeParams, type ClimateSample } from './biomes';
import type { ClimateNoise, TerrainSettings } from './settings';

export interface TerrainSample extends ClimateSample {
  biome: number;
  /** Mountain factor from the erosion spline (0 … 1). */
  mountain: number;
}

const SOFT = 0.08;
function softAbs(v: number): number {
  return Math.sqrt(v * v + SOFT * SOFT) - SOFT;
}

/**
 * Minecraft's peaks & valleys fold 1 - |3·|W| - 2|, with a slightly rounded |·|
 * so peaks and valley floors are sharp but not knife edges that alias into sawtooth crests.
 */
export function peaksAndValleys(weirdness: number): number {
  return 1 - softAbs(3 * softAbs(weirdness) - 2);
}

export function emptySample(): TerrainSample {
  return {
    height: 0,
    continentalness: 0,
    erosion: 0,
    weirdness: 0,
    pv: 0,
    temperature: 0,
    humidity: 0,
    river: 0,
    biome: 0,
    mountain: 0,
  };
}

class ClimateLayer {
  private readonly fractal: Fractal2;

  constructor(seed: number, private readonly s: ClimateNoise) {
    this.fractal = new Fractal2(seed, {
      ...DEFAULT_FRACTAL,
      noise: s.noise,
      scale: s.scale,
      octaves: s.octaves,
      lacunarity: s.lacunarity,
      gain: s.gain,
    });
  }

  sample(x: number, z: number, maxFreq = Infinity): number {
    const v = this.fractal.sample(x, z, maxFreq) * this.s.amplitude + this.s.offset;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }
}

export class TerrainGenerator {
  readonly seed: number;
  private readonly warp: DomainWarp2 | null;
  private readonly cont: ClimateLayer;
  private readonly ero: ClimateLayer;
  private readonly weird: ClimateLayer;
  private readonly temp: ClimateLayer;
  private readonly hum: ClimateLayer;
  private readonly detail: Fractal2;
  private readonly splineC: MonotoneSpline;
  private readonly splineE: MonotoneSpline;
  private readonly splinePV: MonotoneSpline;
  readonly biomeParams: BiomeParams;
  private readonly tmp = new Float64Array(2);
  private readonly scratch = emptySample();

  constructor(
    seedText: string,
    readonly s: TerrainSettings,
  ) {
    this.seed = seedFromString(seedText);
    const seed = this.seed;
    this.warp = s.warp.enabled && s.warp.strength > 0 ? new DomainWarp2(deriveSeed(seed, 7), s.warp) : null;
    this.cont = new ClimateLayer(deriveSeed(seed, 1), s.continentalness);
    this.ero = new ClimateLayer(deriveSeed(seed, 2), s.erosion);
    this.weird = new ClimateLayer(deriveSeed(seed, 3), s.weirdness);
    this.temp = new ClimateLayer(deriveSeed(seed, 4), s.temperature);
    this.hum = new ClimateLayer(deriveSeed(seed, 5), s.humidity);
    this.detail = new Fractal2(deriveSeed(seed, 6), s.detail);
    this.splineC = new MonotoneSpline(s.splines.continentalness);
    this.splineE = new MonotoneSpline(s.splines.erosion);
    this.splinePV = new MonotoneSpline(s.splines.peaks);
    this.biomeParams = {
      mode: s.biomes.mode,
      seaLevel: s.seaLevel,
      beachHeight: s.biomes.beachHeight,
      peakHeight: s.biomes.peakHeight,
    };
  }

  /**
   * Terrain height at (x, z) in metres. `spacing` is the distance between the
   * samples of the caller's grid: octaves too fine for it are faded out
   * (0 = full detail).
   */
  height(x: number, z: number, spacing = 0): number {
    return this.evaluate(x, z, null, spacing);
  }

  /** Full sample: height, climate values and biome. */
  sample(x: number, z: number, out: TerrainSample = emptySample(), spacing = 0): TerrainSample {
    this.evaluate(x, z, out, spacing);
    return out;
  }

  private evaluate(x: number, z: number, out: TerrainSample | null, spacing: number): number {
    const s = this.s;
    // Nyquist limit of the caller's sample grid, in noise-space cycles per unit.
    const maxFreq = spacing > 0 ? s.horizontalScale / (2 * spacing) : Infinity;
    let px = x / s.horizontalScale;
    let pz = z / s.horizontalScale;
    if (this.warp) {
      this.warp.apply(px, pz, this.tmp, maxFreq);
      px = this.tmp[0];
      pz = this.tmp[1];
    }

    let c = this.cont.sample(px, pz, maxFreq);
    if (s.island.enabled) {
      const nx = x / s.island.radius;
      const nz = z / s.island.radius;
      // Distance functions from Red Blob Games: euclidean, chebyshev and the "square bump".
      const d =
        s.island.shape === 'circle'
          ? Math.hypot(nx, nz)
          : s.island.shape === 'square'
            ? Math.max(Math.abs(nx), Math.abs(nz))
            : Math.sqrt(Math.max(0, 1 - (1 - Math.min(1, nx * nx)) * (1 - Math.min(1, nz * nz))));
      const m = 1 - smoothstep(1 - s.island.falloff, 1, d);
      c = -1 + (c + 1) * m;
    }
    const e = this.ero.sample(px, pz, maxFreq);
    const w = this.weird.sample(px, pz, maxFreq);
    const pv = peaksAndValleys(w);

    const base = this.splineC.eval(c);
    const mountain = clamp01(this.splineE.eval(e));
    const peaks = this.splinePV.eval(pv);
    // Mountains build up from the coast towards far inland, so coasts stay gentle.
    const inland = smoothstep(-0.15, 0.3, c);
    // Low erosion raises a broad massif; peaks & valleys carve ridges and valleys into it.
    let h = base + inland * mountain * s.mountainHeight * (1 - s.ridgeShare + s.ridgeShare * peaks);

    if (s.detail.amplitude !== 0) {
      const weight = 1 - s.detail.mountainBias + s.detail.mountainBias * mountain;
      h += this.detail.sample(px, pz, maxFreq) * s.detail.amplitude * weight;
    }

    if (s.redistribution !== 1 && h > s.seaLevel) {
      const ref = s.mountainHeight + 80;
      h = s.seaLevel + Math.pow((h - s.seaLevel) / ref, s.redistribution) * ref;
    }

    if (s.terraces.enabled && h > s.seaLevel) {
      const stepH = (s.mountainHeight + 60) / Math.max(1, s.terraces.steps);
      const k = (h - s.seaLevel) / stepH;
      const f = Math.floor(k);
      const sm = Math.max(0.001, s.terraces.smoothness);
      const terr = s.seaLevel + (f + smoothstep(0.5 - sm, 0.5 + sm, k - f)) * stepH;
      h += (terr - h) * s.terraces.strength;
    }

    let river = 0;
    if (s.rivers.enabled) {
      river = 1 - smoothstep(s.rivers.width, s.rivers.width + s.rivers.bankWidth, Math.abs(w));
      if (river > 0) {
        river *= smoothstep(-0.26, -0.12, c);
        const bed = s.seaLevel - s.rivers.depth;
        if (h > bed) h += (bed - h) * river;
      }
    }

    h *= s.verticalScale;

    if (out) {
      out.height = h;
      out.continentalness = c;
      out.erosion = e;
      out.weirdness = w;
      out.pv = pv;
      out.river = river;
      out.mountain = mountain;
      out.temperature = this.temp.sample(px, pz, maxFreq);
      out.humidity = this.hum.sample(px, pz, maxFreq);
      out.biome = classifyBiome(out, this.biomeParams);
    }
    return h;
  }

  /** Convenience for the HUD: biome at a point. */
  biomeAt(x: number, z: number): number {
    return this.sample(x, z, this.scratch).biome;
  }
}
