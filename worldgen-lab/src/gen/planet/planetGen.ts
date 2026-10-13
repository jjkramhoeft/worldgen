/**
 * Planet elevation and coloring as a pure function of a point on the unit sphere.
 *
 *   continents  warped fBm, shifted by the sea level
 *   mountains   ridged multifractal, masked to inland areas
 *   detail      NMS-style uber noise; slope erosion uses the tangential part
 *               of the analytic 3D derivative so it works on a sphere
 *   craters     Worley-based bowls with raised rims (moons, barren worlds)
 *   terraces    optional stepped plateaus
 *
 * Elevation 0 is sea level; elevation 1 = radius × heightScale.
 */
import { DEFAULT_FRACTAL, Fractal3 } from '../../core/fractal';
import { Noise } from '../../core/noise';
import { deriveSeed, seedFromString } from '../../core/rng';
import { hexToRgb, mixRgb, sampleRamp, smoothstep, type RGB } from '../../core/color';
import type { PlanetPalette, PlanetSettings } from '../settings';

export interface PlanetSample {
  elevation: number;
  temperature: number;
  humidity: number;
  mountain: number;
}

export function emptyPlanetSample(): PlanetSample {
  return { elevation: 0, temperature: 0, humidity: 0, mountain: 0 };
}

/** galaxy seed → region → system → planet, exactly like a seed hierarchy. */
export function planetSeed(seedText: string, p: Pick<PlanetSettings, 'region' | 'system' | 'planet'>): number {
  return deriveSeed(seedFromString(seedText), 0x5eed, p.region.x, p.region.y, p.region.z, p.system, p.planet);
}

/**
 * Crater cross-section at t = distance / crater radius: a parabolic bowl
 * (−1 at the centre, 0 at the rim) plus a Gaussian rim; nothing beyond t = 1.8.
 */
export function craterProfile(t: number): number {
  if (t > 1.8) return 0;
  const bowl = t < 1 ? t * t - 1 : 0;
  const rim = Math.exp(-((t - 1) * (t - 1)) / 0.05) * 0.32;
  return bowl + rim;
}

type PaletteRGB = Record<keyof PlanetPalette, RGB>;

export class PlanetGenerator {
  readonly seed: number;
  private readonly cont: Fractal3;
  private readonly warp: Fractal3[];
  private readonly ridge: Fractal3;
  private readonly detail: Fractal3;
  private readonly temp: Fractal3;
  private readonly hum: Fractal3;
  private readonly craterNoise: Noise;
  private readonly cell = new Float64Array(3);
  readonly palette: PaletteRGB;

  constructor(
    seedText: string,
    readonly p: PlanetSettings,
  ) {
    const seed = (this.seed = planetSeed(seedText, p));
    this.cont = new Fractal3(deriveSeed(seed, 1), { ...p.continents, fractal: 'fbm' });
    const warpSettings = { ...DEFAULT_FRACTAL, scale: p.continents.scale * 1.3, octaves: 3 };
    this.warp = [0, 1, 2].map((k) => new Fractal3(deriveSeed(seed, 10 + k), warpSettings));
    this.ridge = new Fractal3(deriveSeed(seed, 2), {
      ...DEFAULT_FRACTAL,
      fractal: 'ridged',
      scale: p.mountains.scale,
      octaves: p.mountains.octaves,
      lacunarity: 2.05,
      gain: 0.5,
    });
    this.detail = new Fractal3(deriveSeed(seed, 3), p.detail);
    this.temp = new Fractal3(deriveSeed(seed, 4), { ...DEFAULT_FRACTAL, scale: 0.8, octaves: 3 });
    this.hum = new Fractal3(deriveSeed(seed, 5), { ...DEFAULT_FRACTAL, scale: 0.6, octaves: 4 });
    this.craterNoise = new Noise(deriveSeed(seed, 6));
    this.palette = Object.fromEntries(Object.entries(p.palette).map(([k, v]) => [k, hexToRgb(v)])) as PaletteRGB;
  }

  /**
   * Samples the planet at the unit vector (x, y, z). Returns the elevation.
   * `spacing` (on the unit sphere) fades out octaves too fine for the caller's grid.
   */
  sample(x: number, y: number, z: number, out: PlanetSample, spacing = 0): number {
    const p = this.p;
    const mf = spacing > 0 ? 1 / (2 * spacing) : Infinity;
    let px = x, py = y, pz = z;
    if (p.continents.warp > 0) {
      const w = p.continents.warp;
      px += this.warp[0].sample(x, y, z, 0, 0, 0, mf) * w;
      py += this.warp[1].sample(x + 3.1, y, z, 0, 0, 0, mf) * w;
      pz += this.warp[2].sample(x, y + 7.7, z, 0, 0, 0, mf) * w;
    }

    const c = this.cont.sample(px, py, pz, 0, 0, 0, mf);
    const base = c * 2.2 - p.seaLevel;
    let e = base >= 0 ? base * 0.55 : Math.max(-1.3, base * 1.1);

    const mask = smoothstep(p.mountains.coverage, p.mountains.coverage + 0.35, base);
    if (mask > 0 && p.mountains.amplitude > 0) {
      const m = (this.ridge.sample(px, py, pz, 0, 0, 0, mf) + 1) * 0.5;
      e += m * m * p.mountains.amplitude * mask;
    }
    if (p.detail.amplitude > 0) {
      e += this.detail.sample(px, py, pz, x, y, z, mf) * p.detail.amplitude * (0.35 + 0.65 * mask);
    }
    if (p.craters.enabled) e += this.craters(x, y, z) * p.craters.depth;

    if (p.terraces.enabled && e > 0) {
      const stepH = 1.6 / Math.max(1, p.terraces.steps);
      const k = e / stepH;
      const f = Math.floor(k);
      const sm = Math.max(0.001, p.terraces.smoothness);
      const terr = (f + smoothstep(0.5 - sm, 0.5 + sm, k - f)) * stepH;
      e += (terr - e) * p.terraces.strength;
    }

    out.elevation = e;
    out.mountain = mask;
    const lat = Math.abs(y);
    out.temperature =
      0.85 - lat * 1.5 * (0.35 + 0.65 * p.climate.polarCaps) - Math.max(0, e) * 0.3 + this.temp.sample(x, y, z) * 0.35 + p.climate.temperature;
    out.humidity = this.hum.sample(x, y, z) * 1.6 + p.climate.humidity;
    return e;
  }

  private craters(x: number, y: number, z: number): number {
    const p = this.p.craters;
    let total = 0;
    for (let k = 0; k < 3; k++) {
      const f = (3.2 / Math.max(0.2, p.size)) * (1 + k * 1.9);
      this.craterNoise.worley3(x * f + k * 17.3, y * f, z * f, this.cell, 0.85);
      const id = this.cell[2];
      if (id > Math.min(0.95, 0.35 * p.density * (1 + k * 0.5))) continue;
      const r = 0.16 + 0.26 * ((id * 7.31) % 1);
      total += craterProfile(this.cell[0] / r) * r * (4.5 / (1 + k * 1.2));
    }
    return total;
  }

  /**
   * sRGB color for a sample. `slope` is dot(surface normal, radial direction):
   * 1 on flat ground, smaller on cliffs.
   */
  color(s: PlanetSample, slope: number, mode: PlanetSettings['view']['colorMode'], out: RGB): RGB {
    switch (mode) {
      case 'height':
        return sampleRamp('viridis', (s.elevation + 1) / 3, out);
      case 'slope':
        return sampleRamp('slope', (1 - slope) * 6, out);
      case 'temperature':
        return sampleRamp('diverging', (s.temperature + 1) / 2, out);
      case 'humidity':
        return sampleRamp('humidity', (s.humidity + 1) / 2, out);
      default:
        break;
    }
    const P = this.palette;
    const e = s.elevation;
    const hasOcean = this.p.ocean.enabled;
    if (e < 0 && hasOcean) {
      return mixRgb(out, P.shallow, P.deep, smoothstep(0, 0.6, -e));
    }
    const low = mixRgb(out, P.lowDry, P.lowWet, smoothstep(-0.4, 0.4, s.humidity));
    mixRgb(out, low, P.high, smoothstep(0.2, 0.95, e));
    if (hasOcean && e < 0.035) mixRgb(out, P.beach, out, smoothstep(0.004, 0.035, e));
    const rockT = Math.max(smoothstep(0.95, 0.82, slope), smoothstep(1.0, 1.7, e) * 0.6);
    mixRgb(out, out, P.rock, rockT);
    const snow = Math.min(1, smoothstep(-0.25, -0.6, s.temperature) + smoothstep(1.3, 1.9, e));
    if (snow > 0) mixRgb(out, out, P.snow, snow * (1 - rockT * 0.6));
    return out;
  }
}
