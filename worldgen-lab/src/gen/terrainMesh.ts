/**
 * Builds the mesh data for one terrain quadtree node (runs in a worker).
 * Heights are sampled with a one-sample border so normals are seamless across
 * nodes; a skirt hides cracks between neighbouring LOD levels.
 */
import { hash2i, unit, deriveSeed } from '../core/rng';
import { Noise } from '../core/noise';
import { hexToRgb, mixRgb, smoothstep, srgbToLinear, type RGB } from '../core/color';
import { BIOMES, TREE_TYPES } from './biomes';
import { emptySample, type TerrainSample } from './terrain';
import type { TerrainViewSettings } from './settings';

/**
 * Anything that can be meshed as a heightfield: the Terrain generator, and the
 * Watershed generator with its own water levels.
 */
export interface HeightfieldSource {
  readonly seed: number;
  readonly s: { seaLevel: number; verticalScale: number; biomes: { snowLine: number } };
  /** True if samples carry their own water level in `water` (NaN = dry) instead of the sea plane. */
  readonly waterField?: boolean;
  /** True if samples carry a flow vector (`flowX`, `flowZ`) for the water surface. */
  readonly flowField?: boolean;
  createSample?(): TerrainSample;
  sample(x: number, z: number, out: TerrainSample, spacing?: number): TerrainSample;
  height(x: number, z: number, spacing?: number): number;
  /** Extra per-vertex fields the shader needs, packed as `extraStride` floats per vertex. */
  readonly extraStride?: number;
  packExtra?(s: TerrainSample, out: Float32Array, offset: number): void;
  unpackExtra?(src: Float32Array, offset: number, s: TerrainSample): void;
}

/** Colours a sample with surface normal y-component `ny`; returns sRGB. */
export interface SurfaceShader {
  color(s: TerrainSample, ny: number, out: RGB, lodLevel?: number): RGB;
}

export interface TerrainNodeRequest {
  x0: number;
  z0: number;
  size: number;
  res: number;
  level: number;
  vegetation: boolean;
}

export interface TerrainNodeResult {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  minY: number;
  maxY: number;
  water: { positions: Float32Array; colors: Float32Array; maxY: number; flow?: Float32Array } | null;
  /** Stride 6: x, y, z, tree type index, scale, rotation. */
  veg: Float32Array | null;
  ms: number;
}

export const VEG_STRIDE = 6;

const jitterNoise = new Noise(911);

export function buildTerrainNode(
  gen: HeightfieldSource,
  shader: SurfaceShader,
  view: TerrainViewSettings,
  req: TerrainNodeRequest,
): TerrainNodeResult {
  const start = performance.now();
  const N = req.res;
  const step = req.size / N;
  const G = N + 3;
  const V = (N + 1) * (N + 1);
  const heights = new Float64Array(G * G);
  const sea = gen.s.seaLevel;

  // Per-vertex sample fields needed for coloring.
  const biome = new Uint8Array(V);
  const fields = {
    continentalness: new Float32Array(V),
    erosion: new Float32Array(V),
    weirdness: new Float32Array(V),
    pv: new Float32Array(V),
    temperature: new Float32Array(V),
    humidity: new Float32Array(V),
    river: new Float32Array(V),
  };
  const waterY = gen.waterField ? new Float32Array(V) : null;
  const flow = gen.flowField ? new Float32Array(V * 2) : null;
  const stride = gen.extraStride ?? 0;
  const extra = stride > 0 ? new Float32Array(V * stride) : null;

  const smp = gen.createSample?.() ?? emptySample();
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < G; j++) {
    const z = req.z0 + (j - 1) * step;
    for (let i = 0; i < G; i++) {
      const x = req.x0 + (i - 1) * step;
      const interior = i >= 1 && i <= N + 1 && j >= 1 && j <= N + 1;
      let h: number;
      if (interior) {
        gen.sample(x, z, smp, step);
        h = smp.height;
        const v = (j - 1) * (N + 1) + (i - 1);
        biome[v] = smp.biome;
        fields.continentalness[v] = smp.continentalness;
        fields.erosion[v] = smp.erosion;
        fields.weirdness[v] = smp.weirdness;
        fields.pv[v] = smp.pv;
        fields.temperature[v] = smp.temperature;
        fields.humidity[v] = smp.humidity;
        fields.river[v] = smp.river;
        if (waterY) waterY[v] = smp.water ?? NaN;
        if (flow) {
          flow[v * 2] = smp.flowX ?? 0;
          flow[v * 2 + 1] = smp.flowZ ?? 0;
        }
        if (extra) gen.packExtra!(smp, extra, v * stride);
        if (h < minY) minY = h;
        if (h > maxY) maxY = h;
      } else {
        h = gen.height(x, z, step);
      }
      heights[j * G + i] = h;
    }
  }

  const skirtCount = 4 * N;
  const total = V + skirtCount;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const rgb: RGB = [0, 0, 0];
  const natural = view.colorMode === 'natural';

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const v = j * (N + 1) + i;
      const gi = (j + 1) * G + (i + 1);
      const h = heights[gi];
      let nx = heights[gi - 1] - heights[gi + 1];
      let ny = 2 * step;
      let nz = heights[gi - G] - heights[gi + G];
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      positions[v * 3] = i * step;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = j * step;
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;

      smp.height = h;
      smp.biome = biome[v];
      smp.continentalness = fields.continentalness[v];
      smp.erosion = fields.erosion[v];
      smp.weirdness = fields.weirdness[v];
      smp.pv = fields.pv[v];
      smp.temperature = fields.temperature[v];
      smp.humidity = fields.humidity[v];
      smp.river = fields.river[v];
      if (extra) gen.unpackExtra!(extra, v * stride, smp);
      shader.color(smp, ny, rgb, req.level);
      if (natural) {
        const wx = req.x0 + i * step;
        const wz = req.z0 + j * step;
        const k = 1 + 0.07 * jitterNoise.value2(wx / 23, wz / 23) + 0.035 * jitterNoise.value2(wx / 4.7, wz / 4.7);
        rgb[0] *= k;
        rgb[1] *= k;
        rgb[2] *= k;
      }
      colors[v * 3] = srgbToLinear(Math.min(1, rgb[0]));
      colors[v * 3 + 1] = srgbToLinear(Math.min(1, rgb[1]));
      colors[v * 3 + 2] = srgbToLinear(Math.min(1, rgb[2]));
    }
  }

  // Skirt: duplicate the perimeter, pushed down.
  const skirtDepth = step * 3 + 1;
  const perimeter = perimeterIndices(N);
  for (let k = 0; k < skirtCount; k++) {
    const src = perimeter[k];
    const dst = V + k;
    positions[dst * 3] = positions[src * 3];
    positions[dst * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
    positions[dst * 3 + 2] = positions[src * 3 + 2];
    for (let c = 0; c < 3; c++) {
      normals[dst * 3 + c] = normals[src * 3 + c];
      colors[dst * 3 + c] = colors[src * 3 + c];
    }
  }

  let water: TerrainNodeResult['water'] = null;
  let wet = false;
  if (waterY) for (let v = 0; v < V && !wet; v++) wet = !Number.isNaN(waterY[v]);
  if (view.water.enabled && (waterY ? wet : minY < sea + 0.5)) {
    const wp = new Float32Array(V * 3);
    const wc = new Float32Array(V * 4);
    const shallow = linear(hexToRgb(view.water.shallowColor));
    const deep = linear(hexToRgb(view.water.deepColor));
    const c: RGB = [0, 0, 0];
    let top = sea;
    for (let v = 0; v < V; v++) {
      const ground = positions[v * 3 + 1];
      // Rivers and lakes have their own level. Dry vertices sit at the sea plane,
      // below their ground, so water triangles at the edges slide under the banks.
      const level = waterY ? (Number.isNaN(waterY[v]) ? Math.min(sea, ground - 1) : waterY[v]) : sea;
      if (level > top) top = level;
      wp[v * 3] = positions[v * 3];
      wp[v * 3 + 1] = level;
      wp[v * 3 + 2] = positions[v * 3 + 2];
      const depth = level - ground;
      mixRgb(c, shallow, deep, smoothstep(0, 22, depth));
      wc[v * 4] = c[0];
      wc[v * 4 + 1] = c[1];
      wc[v * 4 + 2] = c[2];
      wc[v * 4 + 3] = 0.3 + (view.water.opacity - 0.3) * smoothstep(-0.5, 7, depth);
    }
    water = { positions: wp, colors: wc, maxY: top };
    if (flow) water.flow = flow;
  }

  const veg = req.vegetation && view.vegetation.enabled ? placeVegetation(gen, req, biome, normals, view.vegetation.density) : null;

  return { positions, normals, colors, minY, maxY, water, veg, ms: performance.now() - start };
}

function linear(c: RGB): RGB {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

const perimeterCache = new Map<number, Uint32Array>();

/** Grid vertex indices around the border, in the winding order the skirt expects. */
export function perimeterIndices(N: number): Uint32Array {
  let p = perimeterCache.get(N);
  if (p) return p;
  p = new Uint32Array(4 * N);
  let k = 0;
  const idx = (i: number, j: number) => j * (N + 1) + i;
  for (let i = 0; i < N; i++) p[k++] = idx(i, 0);
  for (let j = 0; j < N; j++) p[k++] = idx(N, j);
  for (let i = N; i > 0; i--) p[k++] = idx(i, N);
  for (let j = N; j > 0; j--) p[k++] = idx(0, j);
  perimeterCache.set(N, p);
  return p;
}

/** Index buffer for an (N+1)² grid, optionally with the skirt ring appended. */
export function gridIndex(N: number, skirt: boolean): Uint16Array | Uint32Array {
  const V = (N + 1) * (N + 1);
  const triCount = N * N * 2 + (skirt ? 8 * N : 0);
  const total = V + (skirt ? 4 * N : 0);
  const index = total > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let o = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + N + 1;
      const d = c + 1;
      index[o++] = a;
      index[o++] = c;
      index[o++] = b;
      index[o++] = b;
      index[o++] = c;
      index[o++] = d;
    }
  }
  if (skirt) {
    const p = perimeterIndices(N);
    const n = 4 * N;
    for (let k = 0; k < n; k++) {
      const a = p[k];
      const b = p[(k + 1) % n];
      const sa = V + k;
      const sb = V + ((k + 1) % n);
      index[o++] = a;
      index[o++] = b;
      index[o++] = sa;
      index[o++] = b;
      index[o++] = sb;
      index[o++] = sa;
    }
  }
  return index;
}

const VEG_CELL = 6;

function placeVegetation(
  gen: HeightfieldSource,
  req: TerrainNodeRequest,
  biome: Uint8Array,
  normals: Float32Array,
  density: number,
): Float32Array | null {
  const out: number[] = [];
  const seed = deriveSeed(gen.seed, 77);
  const N = req.res;
  const step = req.size / N;
  const sea = gen.s.seaLevel;
  const snowLine = gen.s.biomes.snowLine;
  const vs = gen.s.verticalScale;
  const smp = gen.createSample?.() ?? emptySample();
  const gx0 = Math.floor(req.x0 / VEG_CELL);
  const gz0 = Math.floor(req.z0 / VEG_CELL);
  const gx1 = Math.floor((req.x0 + req.size) / VEG_CELL);
  const gz1 = Math.floor((req.z0 + req.size) / VEG_CELL);
  const area = (VEG_CELL * VEG_CELL) / 100;

  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const px = (gx + unit(hash2i(gx, gz, seed))) * VEG_CELL;
      const pz = (gz + unit(hash2i(gx, gz, seed + 1))) * VEG_CELL;
      if (px < req.x0 || px >= req.x0 + req.size || pz < req.z0 || pz >= req.z0 + req.size) continue;
      const vi = Math.round((pz - req.z0) / step) * (N + 1) + Math.round((px - req.x0) / step);
      const roll = unit(hash2i(gx, gz, seed + 2));
      if (roll >= BIOMES[biome[vi]].treeDensity * area * density * 1.6) continue;

      gen.sample(px, pz, smp);
      const def = BIOMES[smp.biome];
      if (roll >= def.treeDensity * area * density || def.trees.length === 0) continue;
      const above = smp.height - sea;
      if (above < 0.4 || above > (snowLine + smp.temperature * 120) * vs + 10) continue;
      // Keep plants out of rivers and lakes above sea level.
      if (smp.water !== undefined && !Number.isNaN(smp.water) && smp.height < smp.water + 0.4) continue;

      let r = unit(hash2i(gx, gz, seed + 3)) * def.trees.reduce((s, t) => s + t.weight, 0);
      let type = def.trees[0].type;
      for (const t of def.trees) {
        r -= t.weight;
        if (r <= 0) {
          type = t.type;
          break;
        }
      }
      const ny = normals[vi * 3 + 1];
      if (ny < (type === 'boulder' ? 0.6 : 0.8)) continue;

      out.push(
        px,
        smp.height,
        pz,
        TREE_TYPES.indexOf(type),
        0.7 + unit(hash2i(gx, gz, seed + 4)) * 0.7,
        unit(hash2i(gx, gz, seed + 5)) * Math.PI * 2,
      );
    }
  }
  return out.length ? new Float32Array(out) : null;
}
