/**
 * Top-down map strips of the Watershed world (minimap, world map, heightmap
 * export). Rivers are drawn on top of every layer, at least about a pixel wide,
 * and only the larger ones when zoomed far out.
 */
import { hexToRgb, mixRgb, sampleRamp, smoothstep, type RGB } from '../../core/color';
import { BIOME_RGB } from '../biomes';
import type { MapRequest, MapResult } from '../map';
import type { TerrainViewSettings } from '../settings';
import { basinColor, WatershedShader } from './shading';
import { emptyWatershedSample, type WatershedGenerator } from './watershedGen';

const WATER_SHALLOW = hexToRgb('#4fa4c4');
const WATER_DEEP = hexToRgb('#13355a');
const RIVER = hexToRgb('#3a86d8');
const LAND_GREY = hexToRgb('#9a9c99');

/** The smallest Strahler order drawn at a given map scale (metres per pixel). */
export function minOrderAt(scale: number): number {
  return scale < 40 ? 1 : scale < 120 ? 2 : scale < 300 ? 3 : 4;
}

export function renderWatershedMapStrip(gen: WatershedGenerator, view: TerrainViewSettings, req: MapRequest): MapResult {
  const { width, rowStart, rowEnd, scale } = req;
  const rows = rowEnd - rowStart;
  const pixels = new Uint8ClampedArray(width * rows * 4);
  const shader = new WatershedShader(gen.s, 'natural', view);
  const smp = emptyWatershedSample();
  const rgb: RGB = [0, 0, 0];
  const minOrder = minOrderAt(scale);
  let biomesLo = 0;
  let biomesHi = 0;

  const W1 = width + 1;
  const heights = new Float64Array(W1 * (rows + 1));
  for (let r = 0; r <= rows; r++) {
    const z = req.z0 + (rowStart + r - 1 + 0.5) * scale;
    for (let c = 0; c <= width; c++) {
      if (r > 0 && c > 0) continue;
      heights[r * W1 + c] = gen.height(req.x0 + (c - 1 + 0.5) * scale, z, scale);
    }
  }

  for (let r = 1; r <= rows; r++) {
    const z = req.z0 + (rowStart + r - 1 + 0.5) * scale;
    for (let c = 1; c <= width; c++) {
      const x = req.x0 + (c - 1 + 0.5) * scale;
      gen.sample(x, z, smp, scale);
      const h = smp.height;
      heights[r * W1 + c] = h;
      if (smp.biome < 32) biomesLo |= 1 << smp.biome;
      else biomesHi |= 1 << (smp.biome - 32);

      const dx = (h - heights[r * W1 + c - 1]) / scale;
      const dz = (h - heights[(r - 1) * W1 + c]) / scale;
      const nx = -dx * 2;
      const nz = -dz * 2;
      const shade = Math.max(0.25, Math.min(1.35, 0.78 + (-nx * 0.55 - nz * 0.55) / Math.sqrt(1 + nx * nx + nz * nz)));
      const ny = 1 / Math.sqrt(1 + dx * dx + dz * dz);
      const under = !Number.isNaN(smp.water) && h < smp.water;
      const depth = under ? smp.water - h : 0;
      let rivers = true;

      switch (req.layer) {
        case 'heightmap': {
          const v = (h - (req.minH ?? -100)) / ((req.maxH ?? 400) - (req.minH ?? -100));
          rgb[0] = rgb[1] = rgb[2] = Math.max(0, Math.min(1, v));
          rivers = false;
          break;
        }
        case 'biome':
          rgb[0] = BIOME_RGB[smp.biome][0] * (0.85 + 0.15 * shade);
          rgb[1] = BIOME_RGB[smp.biome][1] * (0.85 + 0.15 * shade);
          rgb[2] = BIOME_RGB[smp.biome][2] * (0.85 + 0.15 * shade);
          break;
        case 'height':
          sampleRamp('viridis', (h + 40) / (760 * gen.s.verticalScale), rgb);
          if (under) mixRgb(rgb, rgb, WATER_DEEP, 0.35);
          break;
        case 'basins':
          if (smp.basinKey < 0) mixRgb(rgb, WATER_SHALLOW, WATER_DEEP, smoothstep(0, 40, depth));
          else {
            basinColor(smp.basinKey, rgb);
            scaleRgb(rgb, 0.8 + 0.2 * shade);
          }
          break;
        case 'order':
          if (!smp.land) mixRgb(rgb, WATER_SHALLOW, WATER_DEEP, smoothstep(0, 40, depth));
          else {
            rgb[0] = LAND_GREY[0] * shade;
            rgb[1] = LAND_GREY[1] * shade;
            rgb[2] = LAND_GREY[2] * shade;
            if (smp.order >= minOrder && smp.dRiver < Math.max(smp.riverW / 2, 0.7 * scale)) sampleRamp('viridis', Math.min(1, smp.order / 7), rgb);
          }
          rivers = false;
          break;
        case 'discharge':
          if (!smp.land) mixRgb(rgb, WATER_SHALLOW, WATER_DEEP, smoothstep(0, 40, depth));
          else sampleRamp('viridis', (Math.log10(Math.max(1e-3, smp.area)) + 1.2) / 4.2, rgb);
          rivers = false;
          break;
        case 'uplift':
          sampleRamp('diverging', smp.uplift, rgb);
          if (!smp.land) mixRgb(rgb, rgb, WATER_DEEP, 0.6);
          break;
        case 'rain':
          sampleRamp('humidity', (smp.rain - 0.4) / 1.2, rgb);
          if (!smp.land) mixRgb(rgb, rgb, WATER_DEEP, 0.5);
          break;
        case 'temperature':
          sampleRamp('diverging', (smp.temperature + 1) / 2, rgb);
          if (!smp.land) mixRgb(rgb, rgb, WATER_DEEP, 0.5);
          break;
        case 'humidity':
          sampleRamp('humidity', (smp.humidity + 1) / 2, rgb);
          if (!smp.land) mixRgb(rgb, rgb, WATER_DEEP, 0.5);
          break;
        default:
          if (under) {
            mixRgb(rgb, WATER_SHALLOW, WATER_DEEP, smoothstep(0, 40, depth));
            scaleRgb(rgb, 0.9 + 0.1 * shade);
          } else {
            shader.color(smp, ny, rgb);
            scaleRgb(rgb, shade);
          }
      }
      if (rivers && smp.land && smp.order >= minOrder && smp.dRiver < Math.max(smp.riverW / 2, 0.55 * scale)) {
        mixRgb(rgb, rgb, RIVER, 0.85);
      }

      const o = ((r - 1) * width + (c - 1)) * 4;
      pixels[o] = rgb[0] * 255;
      pixels[o + 1] = rgb[1] * 255;
      pixels[o + 2] = rgb[2] * 255;
      pixels[o + 3] = 255;
    }
  }
  return { pixels, rowStart, rowEnd, hist: null, biomes: [biomesLo >>> 0, biomesHi >>> 0] };
}

function scaleRgb(c: RGB, k: number): void {
  c[0] *= k;
  c[1] *= k;
  c[2] *= k;
}
