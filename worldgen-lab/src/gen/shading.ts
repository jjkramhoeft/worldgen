/**
 * Terrain coloring shared by the 3D meshes and the 2D map. Returns sRGB.
 * "natural" blends biome ground, rock on steep slopes, snow above a
 * temperature-dependent snow line and Minecraft-style terracotta bands in badlands.
 */
import { hexToRgb, mixRgb, sampleRamp, smoothstep, type RGB } from '../core/color';
import { B, BIOME_GROUND_RGB, BIOME_RGB, BIOME_ROCK_RGB } from './biomes';
import type { ColorMode, TerrainViewSettings } from './settings';
import type { TerrainSample } from './terrain';

/** The settings the shader reads (Terrain and Watershed settings both provide them). */
export interface ShaderParams {
  seaLevel: number;
  verticalScale: number;
  biomes: { snowLine: number };
}

const SNOW = hexToRgb('#f3f6f9');
const UNDERWATER = hexToRgb('#28474f');
const BANDS = ['#a65a36', '#c27a45', '#d8a46c', '#8e4b37', '#e3c8a8', '#b8653a', '#9a6a52', '#cf8f5a', '#7d4a3a'].map(hexToRgb);
export const LOD_COLORS = ['#e4572e', '#f3a712', '#a8c256', '#29bf12', '#00a5cf', '#4f5bd5', '#962fbf', '#d62976', '#ffffff'].map(hexToRgb);

function bandIndex(h: number): number {
  let x = Math.floor(h / 4) | 0;
  x = Math.imul(x ^ (x >>> 7), 0x2c1b3c6d);
  x ^= x >>> 12;
  return ((x % BANDS.length) + BANDS.length) % BANDS.length;
}

export class TerrainShader {
  private readonly hue: number[] | null;
  private readonly saturation: number;
  private readonly tmp: RGB = [0, 0, 0];

  constructor(
    private readonly t: ShaderParams,
    private readonly mode: ColorMode,
    view: Pick<TerrainViewSettings, 'hueShift' | 'saturation'>,
  ) {
    this.saturation = view.saturation;
    if (view.hueShift % 360 !== 0) {
      const a = (view.hueShift * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const k = (1 - c) / 3;
      const q = Math.sqrt(1 / 3) * s;
      this.hue = [c + k, k - q, k + q, k + q, c + k, k - q, k - q, k + q, c + k];
    } else {
      this.hue = null;
    }
  }

  /** Writes the sRGB color for a terrain sample with surface normal y-component `ny`. */
  color(s: TerrainSample, ny: number, out: RGB, lodLevel = 0): RGB {
    switch (this.mode) {
      case 'biome':
        return copy(out, BIOME_RGB[s.biome]);
      case 'height':
        return sampleRamp('viridis', (s.height + 80) / 420, out);
      case 'slope':
        return sampleRamp('slope', (1 - ny) * 2.2, out);
      case 'continentalness':
        return sampleRamp('diverging', (s.continentalness + 1) / 2, out);
      case 'erosion':
        return sampleRamp('diverging', (s.erosion + 1) / 2, out);
      case 'weirdness':
        return sampleRamp('diverging', (s.weirdness + 1) / 2, out);
      case 'pv':
        return sampleRamp('diverging', (s.pv + 1) / 2, out);
      case 'temperature':
        return sampleRamp('diverging', (s.temperature + 1) / 2, out);
      case 'humidity':
        return sampleRamp('humidity', (s.humidity + 1) / 2, out);
      case 'river':
        return sampleRamp('water', s.river, out);
      case 'lod':
        return copy(out, LOD_COLORS[Math.min(LOD_COLORS.length - 1, lodLevel)]);
      default:
        return this.natural(s, ny, out);
    }
  }

  private natural(s: TerrainSample, ny: number, out: RGB): RGB {
    const t = this.t;
    const above = s.height - t.seaLevel;
    copy(out, BIOME_GROUND_RGB[s.biome]);

    const badlands = s.biome === B.BADLANDS;
    const rock = badlands ? BANDS[bandIndex(s.height)] : BIOME_ROCK_RGB[s.biome];
    const rockT = badlands ? smoothstep(0.97, 0.82, ny) : smoothstep(0.86, 0.7, ny);
    mixRgb(out, out, rock, rockT);

    if (above > 0) {
      // Warmer climates push the snow line up (T = −1 → ~snowLine − 120 m, T = +1 → +120 m).
      const snowLine = (t.biomes.snowLine + s.temperature * 120) * t.verticalScale;
      const snow = smoothstep(snowLine, snowLine + 35, above) * smoothstep(0.62, 0.82, ny);
      if (snow > 0) mixRgb(out, out, SNOW, snow);
      if (above < 0.9) {
        const wet = 1 - 0.18 * (1 - above / 0.9);
        out[0] *= wet;
        out[1] *= wet;
        out[2] *= wet;
      }
    } else {
      mixRgb(out, out, UNDERWATER, smoothstep(0, 30, -above) * 0.65);
    }
    return this.grade(out);
  }

  /** Applies the hue shift / saturation grading (used for alien palettes). */
  grade(out: RGB): RGB {
    if (this.hue) {
      const m = this.hue;
      const r = out[0], g = out[1], b = out[2];
      out[0] = m[0] * r + m[1] * g + m[2] * b;
      out[1] = m[3] * r + m[4] * g + m[5] * b;
      out[2] = m[6] * r + m[7] * g + m[8] * b;
    }
    if (this.saturation !== 1) {
      const l = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
      out[0] = l + (out[0] - l) * this.saturation;
      out[1] = l + (out[1] - l) * this.saturation;
      out[2] = l + (out[2] - l) * this.saturation;
    }
    out[0] = Math.max(0, Math.min(1, out[0]));
    out[1] = Math.max(0, Math.min(1, out[1]));
    out[2] = Math.max(0, Math.min(1, out[2]));
    return out;
  }

  /** Scratch color for callers. */
  get scratch(): RGB {
    return this.tmp;
  }
}

function copy(out: RGB, c: RGB): RGB {
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  return out;
}
