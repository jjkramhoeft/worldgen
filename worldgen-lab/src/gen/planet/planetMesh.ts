/**
 * Cube-sphere quadtree node meshes for planets (runs in a worker).
 * Each cube face is a quadtree; a node is an (N+1)² grid projected onto the
 * sphere with the "spherified cube" mapping, displaced by the elevation, with
 * a skirt against LOD cracks and an optional ocean surface grid.
 */
import { hexToRgb, mixRgb, smoothstep, srgbToLinear, type RGB } from '../../core/color';
import { emptyPlanetSample, type PlanetGenerator } from './planetGen';
import type { PlanetSettings } from '../settings';

/** n, u, v per face with u × v = n (outward), so grid triangles wind counter-clockwise. */
export const FACE_BASIS: [number[], number[], number[]][] = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];

/** Maps face coordinates a, b ∈ [-1, 1] to a unit vector (spherified cube, more uniform than normalising). */
export function cubeToSphere(face: number, a: number, b: number, out: Float64Array | number[]): void {
  const [n, u, v] = FACE_BASIS[face];
  const x = n[0] + a * u[0] + b * v[0];
  const y = n[1] + a * u[1] + b * v[1];
  const z = n[2] + a * u[2] + b * v[2];
  const x2 = x * x, y2 = y * y, z2 = z * z;
  let sx = x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3));
  let sy = y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3));
  let sz = z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3));
  const len = Math.hypot(sx, sy, sz);
  sx /= len;
  sy /= len;
  sz /= len;
  out[0] = sx;
  out[1] = sy;
  out[2] = sz;
}

export interface PlanetNodeRequest {
  face: number;
  level: number;
  x: number;
  y: number;
  res: number;
}

export interface PlanetNodeResult {
  center: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  ocean: { positions: Float32Array; colors: Float32Array } | null;
  minE: number;
  maxE: number;
  ms: number;
}

const LOD_COLORS = ['#e4572e', '#f3a712', '#a8c256', '#29bf12', '#00a5cf', '#4f5bd5', '#962fbf', '#d62976', '#ffffff'].map(hexToRgb);

export function buildPlanetNode(gen: PlanetGenerator, p: PlanetSettings, req: PlanetNodeRequest): PlanetNodeResult {
  const start = performance.now();
  const N = req.res;
  const G = N + 3;
  const span = 1 / 2 ** req.level;
  const s0 = req.x * span;
  const t0 = req.y * span;
  const ds = span / N;
  const R = p.radius;
  const hs = p.heightScale;

  const unitV = new Float64Array(G * G * 3);
  const world = new Float64Array(G * G * 3);
  const V = (N + 1) * (N + 1);
  const elev = new Float32Array(V);
  const temp = new Float32Array(V);
  const hum = new Float32Array(V);
  const smp = emptyPlanetSample();
  const u = new Float64Array(3);
  // Grid spacing on the unit sphere (cube face span 2 → roughly 1.6 of arc).
  const spacing = (1.6 * span) / N;
  let minE = Infinity;
  let maxE = -Infinity;

  for (let j = 0; j < G; j++) {
    const b = (t0 + (j - 1) * ds) * 2 - 1;
    for (let i = 0; i < G; i++) {
      const a = (s0 + (i - 1) * ds) * 2 - 1;
      cubeToSphere(req.face, a, b, u);
      const e = gen.sample(u[0], u[1], u[2], smp, spacing);
      const r = R * (1 + e * hs);
      const g = (j * G + i) * 3;
      unitV[g] = u[0];
      unitV[g + 1] = u[1];
      unitV[g + 2] = u[2];
      world[g] = u[0] * r;
      world[g + 1] = u[1] * r;
      world[g + 2] = u[2] * r;
      if (i >= 1 && i <= N + 1 && j >= 1 && j <= N + 1) {
        const v = (j - 1) * (N + 1) + (i - 1);
        elev[v] = e;
        temp[v] = smp.temperature;
        hum[v] = smp.humidity;
        if (e < minE) minE = e;
        if (e > maxE) maxE = e;
      }
    }
  }

  const c = new Float64Array(3);
  cubeToSphere(req.face, (s0 + span / 2) * 2 - 1, (t0 + span / 2) * 2 - 1, c);
  const center: [number, number, number] = [c[0] * R, c[1] * R, c[2] * R];

  const skirtCount = 4 * N;
  const positions = new Float32Array((V + skirtCount) * 3);
  const normals = new Float32Array((V + skirtCount) * 3);
  const colors = new Float32Array((V + skirtCount) * 3);
  const rgb: RGB = [0, 0, 0];
  const mode = p.view.colorMode;

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const v = j * (N + 1) + i;
      const g = ((j + 1) * G + (i + 1)) * 3;
      const gl = g - 3, gr = g + 3, gd = g - G * 3, gu = g + G * 3;
      const dux = world[gr] - world[gl], duy = world[gr + 1] - world[gl + 1], duz = world[gr + 2] - world[gl + 2];
      const dvx = world[gu] - world[gd], dvy = world[gu + 1] - world[gd + 1], dvz = world[gu + 2] - world[gd + 2];
      let nx = duy * dvz - duz * dvy;
      let ny = duz * dvx - dux * dvz;
      let nz = dux * dvy - duy * dvx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      positions[v * 3] = world[g] - center[0];
      positions[v * 3 + 1] = world[g + 1] - center[1];
      positions[v * 3 + 2] = world[g + 2] - center[2];
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;

      const slope = nx * unitV[g] + ny * unitV[g + 1] + nz * unitV[g + 2];
      smp.elevation = elev[v];
      smp.temperature = temp[v];
      smp.humidity = hum[v];
      if (mode === 'lod') {
        const lc = LOD_COLORS[Math.min(LOD_COLORS.length - 1, Math.floor(req.level / 1.5))];
        rgb[0] = lc[0];
        rgb[1] = lc[1];
        rgb[2] = lc[2];
      } else {
        gen.color(smp, slope, mode, rgb);
      }
      colors[v * 3] = srgbToLinear(rgb[0]);
      colors[v * 3 + 1] = srgbToLinear(rgb[1]);
      colors[v * 3 + 2] = srgbToLinear(rgb[2]);
    }
  }

  // Skirt pulled towards the planet centre.
  const skirtDepth = ((R * 1.6) / (2 ** req.level * N)) * 3 + R * hs * 0.02;
  const perim = planetPerimeter(N);
  for (let k = 0; k < skirtCount; k++) {
    const src = perim[k];
    const dst = V + k;
    const i = src % (N + 1);
    const j = Math.floor(src / (N + 1));
    const g = ((j + 1) * G + (i + 1)) * 3;
    positions[dst * 3] = positions[src * 3] - unitV[g] * skirtDepth;
    positions[dst * 3 + 1] = positions[src * 3 + 1] - unitV[g + 1] * skirtDepth;
    positions[dst * 3 + 2] = positions[src * 3 + 2] - unitV[g + 2] * skirtDepth;
    for (let k2 = 0; k2 < 3; k2++) {
      normals[dst * 3 + k2] = normals[src * 3 + k2];
      colors[dst * 3 + k2] = colors[src * 3 + k2];
    }
  }

  let ocean: PlanetNodeResult['ocean'] = null;
  if (p.ocean.enabled && minE < 0.02) {
    const op = new Float32Array(V * 3);
    const oc = new Float32Array(V * 4);
    const shallow = hexToRgb(p.ocean.color);
    const deep = hexToRgb(p.ocean.deepColor);
    const col: RGB = [0, 0, 0];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const v = j * (N + 1) + i;
        const g = ((j + 1) * G + (i + 1)) * 3;
        op[v * 3] = unitV[g] * R - center[0];
        op[v * 3 + 1] = unitV[g + 1] * R - center[1];
        op[v * 3 + 2] = unitV[g + 2] * R - center[2];
        const depth = -elev[v];
        if (p.ocean.lava) {
          mixRgb(col, shallow, deep, smoothstep(0, 0.4, depth) * 0.5);
        } else {
          mixRgb(col, shallow, deep, smoothstep(0, 0.45, depth));
        }
        oc[v * 4] = srgbToLinear(col[0]);
        oc[v * 4 + 1] = srgbToLinear(col[1]);
        oc[v * 4 + 2] = srgbToLinear(col[2]);
        oc[v * 4 + 3] = p.ocean.lava ? 1 : 0.5 + (p.ocean.opacity - 0.5) * smoothstep(0, 0.12, depth);
      }
    }
    ocean = { positions: op, colors: oc };
  }

  return { center, positions, normals, colors, ocean, minE, maxE, ms: performance.now() - start };
}

const perimCache = new Map<number, Uint32Array>();

/** Border vertices counter-clockwise (seen from outside): +u, +v, −u, −v. */
export function planetPerimeter(N: number): Uint32Array {
  let p = perimCache.get(N);
  if (p) return p;
  p = new Uint32Array(4 * N);
  const idx = (i: number, j: number) => j * (N + 1) + i;
  let k = 0;
  for (let i = 0; i < N; i++) p[k++] = idx(i, 0);
  for (let j = 0; j < N; j++) p[k++] = idx(N, j);
  for (let i = N; i > 0; i--) p[k++] = idx(i, N);
  for (let j = N; j > 0; j--) p[k++] = idx(0, j);
  perimCache.set(N, p);
  return p;
}

/** Index buffer for a planet node grid (u × v = outward), optionally with skirts. */
export function planetGridIndex(N: number, skirt: boolean): Uint16Array | Uint32Array {
  const V = (N + 1) * (N + 1);
  const tris = N * N * 2 + (skirt ? 8 * N : 0);
  const index = V + 4 * N > 65535 ? new Uint32Array(tris * 3) : new Uint16Array(tris * 3);
  let o = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + N + 1;
      const d = c + 1;
      index[o++] = a;
      index[o++] = b;
      index[o++] = c;
      index[o++] = b;
      index[o++] = d;
      index[o++] = c;
    }
  }
  if (skirt) {
    const p = planetPerimeter(N);
    const n = 4 * N;
    for (let k = 0; k < n; k++) {
      const a = p[k];
      const b = p[(k + 1) % n];
      const sa = V + k;
      const sb = V + ((k + 1) % n);
      index[o++] = a;
      index[o++] = sa;
      index[o++] = b;
      index[o++] = b;
      index[o++] = sa;
      index[o++] = sb;
    }
  }
  return index;
}

/** Equirectangular planet map strip (for the map overlay). */
export function renderPlanetMapStrip(
  gen: PlanetGenerator,
  p: PlanetSettings,
  width: number,
  height: number,
  rowStart: number,
  rowEnd: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * (rowEnd - rowStart) * 4);
  const smp = emptyPlanetSample();
  const rgb: RGB = [0, 0, 0];
  const shallow = hexToRgb(p.ocean.color);
  const deep = hexToRgb(p.ocean.deepColor);
  let prevRow: Float32Array | null = null;
  for (let py = rowStart; py < rowEnd; py++) {
    const lat = Math.PI / 2 - ((py + 0.5) / height) * Math.PI;
    const row = new Float32Array(width);
    for (let px = 0; px < width; px++) {
      const lon = ((px + 0.5) / width) * Math.PI * 2 - Math.PI;
      const x = Math.cos(lat) * Math.cos(lon);
      const y = Math.sin(lat);
      const z = Math.cos(lat) * Math.sin(lon);
      const e = gen.sample(x, y, z, smp);
      row[px] = e;
      if (e < 0 && p.ocean.enabled) {
        mixRgb(rgb, shallow, deep, smoothstep(0, 0.5, -e));
      } else {
        gen.color(smp, 1, 'natural', rgb);
        const left = px > 0 ? row[px - 1] : e;
        const up = prevRow ? prevRow[px] : e;
        const shade = Math.max(0.55, Math.min(1.3, 1 + ((e - left) + (e - up)) * 6));
        rgb[0] *= shade;
        rgb[1] *= shade;
        rgb[2] *= shade;
      }
      const o = ((py - rowStart) * width + px) * 4;
      out[o] = rgb[0] * 255;
      out[o + 1] = rgb[1] * 255;
      out[o + 2] = rgb[2] * 255;
      out[o + 3] = 255;
    }
    prevRow = row;
  }
  return out;
}
