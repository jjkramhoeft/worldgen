/**
 * Colours for the Watershed world. "Natural" reuses the Terrain shader and adds
 * an underwater tint for rivers and lakes above sea level; the other modes show
 * the drainage network's own data (basins, stream order, upstream area, uplift, rain).
 */
import { hexToRgb, mixRgb, sampleRamp, smoothstep, type RGB } from '../../core/color';
import { TerrainShader } from '../shading';
import type { ColorMode, TerrainViewSettings, WatershedColorMode, WatershedSettings } from '../settings';
import type { TerrainSample } from '../terrain';
import type { SurfaceShader } from '../terrainMesh';
import type { WatershedSample } from './watershedGen';

const UNDERWATER = hexToRgb('#28474f');
const SEA = hexToRgb('#1d3b6e');
const GREY = hexToRgb('#8b8f94');
const RIVER = hexToRgb('#2f7fd6');

const SHARED: Partial<Record<WatershedColorMode, ColorMode>> = {
  natural: 'natural',
  biome: 'biome',
  slope: 'slope',
  temperature: 'temperature',
  humidity: 'humidity',
  river: 'river',
  lod: 'lod',
};

/** A pastel colour for a basin key in [0, 1). */
export function basinColor(key: number, out: RGB): RGB {
  const hue = key * 6;
  const i = Math.floor(hue);
  const f = hue - i;
  const v = 0.86;
  const p = v * 0.45;
  const q = v * (1 - 0.55 * f);
  const t = v * (1 - 0.55 * (1 - f));
  const k = ((i % 6) + 6) % 6;
  const r = [v, q, p, p, t, v][k];
  const g = [t, v, v, q, p, p][k];
  const b = [p, p, t, v, v, q][k];
  out[0] = r;
  out[1] = g;
  out[2] = b;
  return out;
}

export class WatershedShader implements SurfaceShader {
  private readonly base: TerrainShader;

  constructor(
    private readonly s: WatershedSettings,
    private readonly mode: WatershedColorMode,
    view: Pick<TerrainViewSettings, 'hueShift' | 'saturation'>,
  ) {
    this.base = new TerrainShader(s, SHARED[mode] ?? 'natural', view);
  }

  color(smp: TerrainSample, ny: number, out: RGB, lodLevel = 0): RGB {
    const w = smp as WatershedSample;
    const under = !Number.isNaN(w.water) && w.height < w.water;
    switch (this.mode) {
      case 'height':
        sampleRamp('viridis', (w.height + 40) / (760 * this.s.verticalScale), out);
        if (under) mixRgb(out, out, SEA, 0.4);
        return out;
      case 'basins':
        if (w.basinKey < 0) return sea(out, w);
        basinColor(w.basinKey, out);
        if (under) mixRgb(out, out, RIVER, 0.7);
        return out;
      case 'order':
        if (!w.land) return sea(out, w);
        if (w.order > 0 && w.dRiver < w.riverW * 0.5 + 8) return sampleRamp('viridis', Math.min(1, w.order / 7), out);
        out[0] = GREY[0];
        out[1] = GREY[1];
        out[2] = GREY[2];
        return out;
      case 'discharge': {
        if (!w.land) return sea(out, w);
        // log10 of the upstream area: one cell (≈ 0.07 km²) … 1000 km².
        const t = (Math.log10(Math.max(1e-3, w.area)) + 1.2) / 4.2;
        return sampleRamp('viridis', t, out);
      }
      case 'uplift':
        if (!w.land) return sea(out, w);
        return sampleRamp('diverging', w.uplift, out);
      case 'rain':
        return sampleRamp('humidity', (w.rain - 0.4) / 1.2, out);
      case 'natural': {
        this.base.color(smp, ny, out, lodLevel);
        if (!Number.isNaN(w.water) && w.water > this.s.seaLevel + 0.01) {
          const depth = w.water - w.height;
          if (depth > 0) mixRgb(out, out, UNDERWATER, smoothstep(0, 8, depth) * 0.6);
          else if (depth > -0.9) {
            const k = 1 - 0.18 * (1 + depth / 0.9);
            out[0] *= k;
            out[1] *= k;
            out[2] *= k;
          }
        }
        return out;
      }
      default:
        return this.base.color(smp, ny, out, lodLevel);
    }
  }
}

function sea(out: RGB, w: WatershedSample): RGB {
  mixRgb(out, SEA, UNDERWATER, smoothstep(0, 30, Math.max(0, (w.water || 0) - w.height)));
  return out;
}
