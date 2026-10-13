/**
 * Renders top-down map images (RGBA) of the terrain generator — used by the
 * minimap, the full-screen map and the heightmap export. Work is split into
 * row strips so several workers can render one image in parallel.
 */
import { hexToRgb, mixRgb, sampleRamp, smoothstep, type RGB } from '../core/color';
import { BIOME_RGB } from './biomes';
import { TerrainShader } from './shading';
import { emptySample, type TerrainGenerator } from './terrain';
import type { TerrainViewSettings } from './settings';

export type MapLayer =
  | 'shaded'
  | 'biome'
  | 'height'
  | 'continentalness'
  | 'erosion'
  | 'weirdness'
  | 'pv'
  | 'temperature'
  | 'humidity'
  | 'river'
  | 'heightmap'
  // Watershed mode only:
  | 'basins'
  | 'order'
  | 'discharge'
  | 'uplift'
  | 'rain';

/** Layers of the Watershed mode's map and minimap. */
export const WATERSHED_MAP_LAYERS: { value: MapLayer; label: string }[] = [
  { value: 'shaded', label: 'Shaded relief' },
  { value: 'biome', label: 'Biomes' },
  { value: 'height', label: 'Height' },
  { value: 'basins', label: 'Drainage basins' },
  { value: 'order', label: 'Stream order' },
  { value: 'discharge', label: 'Upstream area' },
  { value: 'uplift', label: 'Uplift' },
  { value: 'rain', label: 'Rain' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'humidity', label: 'Humidity' },
];

export const MAP_LAYERS: { value: MapLayer; label: string }[] = [
  { value: 'shaded', label: 'Shaded relief' },
  { value: 'biome', label: 'Biomes' },
  { value: 'height', label: 'Height' },
  { value: 'continentalness', label: 'Continentalness' },
  { value: 'erosion', label: 'Erosion' },
  { value: 'weirdness', label: 'Weirdness' },
  { value: 'pv', label: 'Peaks & valleys' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'humidity', label: 'Humidity' },
  { value: 'river', label: 'Rivers' },
];

export interface MapRequest {
  /** World coordinates of the image's top-left corner. */
  x0: number;
  z0: number;
  /** World units per pixel. */
  scale: number;
  width: number;
  height: number;
  rowStart: number;
  rowEnd: number;
  layer: MapLayer;
  histograms: boolean;
  /** For 'heightmap': world height mapped to black / white. */
  minH?: number;
  maxH?: number;
}

export const HIST_BINS = 48;

export interface MapResult {
  pixels: Uint8ClampedArray;
  rowStart: number;
  rowEnd: number;
  /** Histograms of continentalness, erosion and PV (HIST_BINS each), when requested. */
  hist: Uint32Array | null;
  /** Biome ids present in the strip (bitmask over 64 ids, as two 32-bit words). */
  biomes: [number, number];
}

const WATER_SHALLOW = hexToRgb('#4fa4c4');
const WATER_DEEP = hexToRgb('#13355a');

export function renderMapStrip(gen: TerrainGenerator, view: TerrainViewSettings, req: MapRequest): MapResult {
  const { width, rowStart, rowEnd, scale } = req;
  const rows = rowEnd - rowStart;
  const pixels = new Uint8ClampedArray(width * rows * 4);
  const hist = req.histograms ? new Uint32Array(HIST_BINS * 3) : null;
  const sea = gen.s.seaLevel;
  const shader = new TerrainShader(gen.s, 'natural', view);
  const smp = emptySample();
  const rgb: RGB = [0, 0, 0];
  let biomesLo = 0;
  let biomesHi = 0;

  // Heights with one extra row/column for hillshading.
  const W1 = width + 1;
  const heights = new Float64Array(W1 * (rows + 1));
  for (let r = 0; r <= rows; r++) {
    const z = req.z0 + (rowStart + r - 1 + 0.5) * scale;
    for (let c = 0; c <= width; c++) {
      const x = req.x0 + (c - 1 + 0.5) * scale;
      if (r > 0 && c > 0) continue; // filled by the full samples below
      heights[r * W1 + c] = gen.height(x, z, scale);
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

      if (hist) {
        hist[bin(smp.continentalness)]++;
        hist[HIST_BINS + bin(smp.erosion)]++;
        hist[HIST_BINS * 2 + bin(smp.pv)]++;
      }

      const dx = (h - heights[r * W1 + c - 1]) / scale;
      const dz = (h - heights[(r - 1) * W1 + c]) / scale;
      // Light from the north-west, 2× vertical exaggeration.
      const nx = -dx * 2;
      const nz = -dz * 2;
      const shade = Math.max(0.25, Math.min(1.35, 0.78 + (-nx * 0.55 - nz * 0.55) / Math.sqrt(1 + nx * nx + nz * nz)));
      const ny = 1 / Math.sqrt(1 + dx * dx + dz * dz);

      switch (req.layer) {
        case 'shaded':
          if (h < sea) {
            mixRgb(rgb, WATER_SHALLOW, WATER_DEEP, smoothstep(0, 40, sea - h));
            const k = 0.9 + 0.1 * shade;
            rgb[0] *= k;
            rgb[1] *= k;
            rgb[2] *= k;
          } else {
            shader.color(smp, ny, rgb);
            rgb[0] *= shade;
            rgb[1] *= shade;
            rgb[2] *= shade;
          }
          break;
        case 'biome':
          rgb[0] = BIOME_RGB[smp.biome][0] * (0.85 + 0.15 * shade);
          rgb[1] = BIOME_RGB[smp.biome][1] * (0.85 + 0.15 * shade);
          rgb[2] = BIOME_RGB[smp.biome][2] * (0.85 + 0.15 * shade);
          break;
        case 'height':
          sampleRamp('viridis', (h + 80) / 420, rgb);
          if (h < sea) mixRgb(rgb, rgb, WATER_DEEP, 0.35);
          break;
        case 'heightmap': {
          const v = ((h - (req.minH ?? -100)) / ((req.maxH ?? 400) - (req.minH ?? -100)));
          rgb[0] = rgb[1] = rgb[2] = Math.max(0, Math.min(1, v));
          break;
        }
        case 'continentalness':
          sampleRamp('diverging', (smp.continentalness + 1) / 2, rgb);
          break;
        case 'erosion':
          sampleRamp('diverging', (smp.erosion + 1) / 2, rgb);
          break;
        case 'weirdness':
          sampleRamp('diverging', (smp.weirdness + 1) / 2, rgb);
          break;
        case 'pv':
          sampleRamp('diverging', (smp.pv + 1) / 2, rgb);
          break;
        case 'temperature':
          sampleRamp('diverging', (smp.temperature + 1) / 2, rgb);
          break;
        case 'humidity':
          sampleRamp('humidity', (smp.humidity + 1) / 2, rgb);
          break;
        case 'river':
          sampleRamp('water', smp.river, rgb);
          if (h < sea) mixRgb(rgb, rgb, WATER_DEEP, 0.5);
          break;
      }

      const o = ((r - 1) * width + (c - 1)) * 4;
      pixels[o] = rgb[0] * 255;
      pixels[o + 1] = rgb[1] * 255;
      pixels[o + 2] = rgb[2] * 255;
      pixels[o + 3] = 255;
    }
  }
  return { pixels, rowStart, rowEnd, hist, biomes: [biomesLo >>> 0, biomesHi >>> 0] };
}

function bin(v: number): number {
  return Math.max(0, Math.min(HIST_BINS - 1, Math.floor(((v + 1) / 2) * HIST_BINS)));
}
