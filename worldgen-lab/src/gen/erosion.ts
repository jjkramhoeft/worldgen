/**
 * Erosion simulation on a finite heightmap.
 *
 * Hydraulic: particle ("droplet") erosion after Hans Theobald Beyer (2015) and
 * Sebastian Lague. Each droplet rolls downhill with inertia, picks up sediment
 * while its carrying capacity (∝ slope · speed · water) exceeds its load, and
 * deposits when it slows down or runs uphill. Droplets entering the sea
 * evaporate quickly and drop their load, building deltas.
 *
 * Thermal: material slides off slopes steeper than the talus angle.
 *
 * Heights are simulated normalised to [0, 1] so the classic default
 * parameters behave as published.
 */
import { hexToRgb, mixRgb, sampleRamp, smoothstep, srgbToLinear, type RGB } from '../core/color';
import { Rng } from '../core/rng';
import { BIOME_GROUND_RGB, BIOME_ROCK_RGB } from './biomes';
import { emptySample, type TerrainGenerator } from './terrain';
import type { ErosionSettings } from './settings';

export interface ErosionSnapshot {
  size: number;
  /** Heights in metres (size²). */
  heights: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  water: Float32Array;
  droplets: number;
  /** Mean absolute height change in metres. */
  meanChange: number;
}

const DEPOSIT = hexToRgb('#c9b48a');
const SNOW = hexToRgb('#f3f6f9');
const SHALLOW = hexToRgb('#3aa7b8');
const DEEP = hexToRgb('#0b3a5c');

export class ErosionSim {
  readonly size: number;
  readonly heights: Float32Array;
  readonly base: Float32Array;
  readonly flow: Float32Array;
  readonly biome: Uint8Array;
  readonly temperature: Float32Array;
  readonly minH: number;
  readonly range: number;
  readonly seaLevel: number;
  private readonly seaN: number;
  private readonly rng: Rng;
  droplets = 0;
  private brush: { dx: number; dy: number; w: number }[] = [];
  private brushRadius = -1;

  constructor(gen: TerrainGenerator, private s: ErosionSettings) {
    const N = (this.size = s.resolution);
    const meters = new Float32Array(N * N);
    this.biome = new Uint8Array(N * N);
    this.temperature = new Float32Array(N * N);
    this.flow = new Float32Array(N * N);
    this.seaLevel = gen.s.seaLevel;
    const smp = emptySample();
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        const v = j / (N - 1);
        const x = s.centerX + (u - 0.5) * s.extent;
        const z = s.centerZ + (v - 0.5) * s.extent;
        gen.sample(x, z, smp);
        let h = smp.height;
        if (s.island) {
          const edge = Math.max(Math.abs(u * 2 - 1), Math.abs(v * 2 - 1));
          const m = 1 - smoothstep(0.72, 1, edge);
          h = this.seaLevel - 25 + (h - (this.seaLevel - 25)) * m;
        }
        meters[j * N + i] = h;
        this.biome[j * N + i] = smp.biome;
        this.temperature[j * N + i] = smp.temperature;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    this.minH = lo;
    this.range = Math.max(1, hi - lo);
    this.seaN = (this.seaLevel - lo) / this.range;
    this.heights = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) this.heights[k] = (meters[k] - lo) / this.range;
    this.base = this.heights.slice();
    this.rng = new Rng(gen.seed ^ 0xe7051);
  }

  setSettings(s: ErosionSettings): void {
    this.s = s;
  }

  private ensureBrush(): void {
    const r = Math.max(1, Math.round(this.s.hydraulic.radius));
    if (r === this.brushRadius) return;
    this.brushRadius = r;
    this.brush = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < r) this.brush.push({ dx, dy, w: 1 - d / r });
      }
    }
  }

  /** Bilinear height and gradient at a fractional position. */
  private heightGrad(px: number, py: number, out: Float64Array): void {
    const N = this.size;
    const map = this.heights;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const x = px - cx;
    const y = py - cy;
    const i = cy * N + cx;
    const nw = map[i];
    const ne = map[i + 1];
    const sw = map[i + N];
    const se = map[i + N + 1];
    out[0] = nw * (1 - x) * (1 - y) + ne * x * (1 - y) + sw * (1 - x) * y + se * x * y;
    out[1] = (ne - nw) * (1 - y) + (se - sw) * y;
    out[2] = (sw - nw) * (1 - x) + (se - ne) * x;
  }

  erode(count: number): void {
    const p = this.s.hydraulic;
    this.ensureBrush();
    const N = this.size;
    const map = this.heights;
    const hg = new Float64Array(3);
    const brush = this.brush;

    for (let n = 0; n < count; n++) {
      let px = this.rng.next() * (N - 1);
      let py = this.rng.next() * (N - 1);
      let dirX = 0;
      let dirY = 0;
      let speed = p.initialSpeed;
      let water = p.initialWater;
      let sediment = 0;

      for (let life = 0; life < p.maxLifetime; life++) {
        const nodeX = Math.floor(px);
        const nodeY = Math.floor(py);
        const idx = nodeY * N + nodeX;
        const offX = px - nodeX;
        const offY = py - nodeY;
        this.heightGrad(px, py, hg);
        const height = hg[0];

        dirX = dirX * p.inertia - hg[1] * (1 - p.inertia);
        dirY = dirY * p.inertia - hg[2] * (1 - p.inertia);
        const len = Math.sqrt(dirX * dirX + dirY * dirY);
        if (len === 0) break;
        dirX /= len;
        dirY /= len;
        px += dirX;
        py += dirY;
        if (px < 0 || px >= N - 1 || py < 0 || py >= N - 1) break;

        this.flow[idx] += water;
        this.heightGrad(px, py, hg);
        const delta = hg[0] - height;
        const capacity = Math.max(-delta * speed * water * p.capacity, p.minCapacity);

        if (sediment > capacity || delta > 0) {
          const amount = delta > 0 ? Math.min(delta, sediment) : (sediment - capacity) * p.depositSpeed;
          sediment -= amount;
          map[idx] += amount * (1 - offX) * (1 - offY);
          map[idx + 1] += amount * offX * (1 - offY);
          map[idx + N] += amount * (1 - offX) * offY;
          map[idx + N + 1] += amount * offX * offY;
        } else {
          const amount = Math.min((capacity - sediment) * p.erodeSpeed, -delta);
          let wsum = 0;
          for (const b of brush) {
            const x = nodeX + b.dx;
            const y = nodeY + b.dy;
            if (x >= 0 && x < N && y >= 0 && y < N) wsum += b.w;
          }
          for (const b of brush) {
            const x = nodeX + b.dx;
            const y = nodeY + b.dy;
            if (x < 0 || x >= N || y < 0 || y >= N) continue;
            const k = y * N + x;
            const want = (amount * b.w) / wsum;
            const got = map[k] < want ? map[k] : want;
            map[k] -= got;
            sediment += got;
          }
        }

        // Physically: v² grows with the height drop (Beyer 2015).
        speed = Math.sqrt(Math.max(0, speed * speed - delta * p.gravity));
        water *= 1 - p.evaporateSpeed;
        if (hg[0] < this.seaN) water *= 0.7;
        if (water < 0.01) break;
      }
    }
    this.droplets += count;
  }

  thermal(): void {
    const t = this.s.thermal;
    const N = this.size;
    const map = this.heights;
    const cell = this.s.extent / (N - 1);
    const talus = (Math.tan((t.talusAngle * Math.PI) / 180) * cell) / this.range;
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        const h = map[i];
        let best = -1;
        let diff = 0;
        const n4 = [i - 1, i + 1, i - N, i + N];
        for (const k of n4) {
          const d = h - map[k];
          if (d > diff) {
            diff = d;
            best = k;
          }
        }
        if (best >= 0 && diff > talus) {
          const move = t.strength * (diff - talus) * 0.5;
          map[i] -= move;
          map[best] += move;
        }
      }
    }
  }

  snapshot(): ErosionSnapshot {
    const N = this.size;
    const s = this.s;
    const heights = new Float32Array(N * N);
    const normals = new Float32Array(N * N * 3);
    const colors = new Float32Array(N * N * 3);
    const water = new Float32Array(N * N * 4);
    const cell = s.extent / (N - 1);
    let maxFlow = 1e-6;
    let sumFlow = 0;
    let change = 0;
    for (let k = 0; k < N * N; k++) {
      heights[k] = this.minH + this.heights[k] * this.range;
      if (this.flow[k] > maxFlow) maxFlow = this.flow[k];
      sumFlow += this.flow[k];
      change += Math.abs(this.heights[k] - this.base[k]);
    }
    // Flow relative to the mean, log-scaled, so only real channels stand out.
    const meanFlow = Math.max(1e-6, sumFlow / (N * N));
    const logMax = Math.log(1 + maxFlow / meanFlow);
    const rgb: RGB = [0, 0, 0];
    const tmp: RGB = [0, 0, 0];

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const hl = heights[j * N + Math.max(0, i - 1)];
        const hr = heights[j * N + Math.min(N - 1, i + 1)];
        const hd = heights[Math.max(0, j - 1) * N + i];
        const hu = heights[Math.min(N - 1, j + 1) * N + i];
        const dx = (i === 0 || i === N - 1 ? 1 : 2) * cell;
        const dz = (j === 0 || j === N - 1 ? 1 : 2) * cell;
        let nx = (hl - hr) / dx;
        let ny = 1;
        let nz = (hd - hu) / dz;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        nz /= len;
        normals[k * 3] = nx;
        normals[k * 3 + 1] = ny;
        normals[k * 3 + 2] = nz;

        const h = heights[k];
        const delta = (this.heights[k] - this.base[k]) * this.range;
        const above = h - this.seaLevel;
        switch (s.colorMode) {
          case 'height':
            sampleRamp('viridis', (h + 80) / 420, rgb);
            break;
          case 'erosion':
            sampleRamp('diverging', 0.5 + Math.max(-0.5, Math.min(0.5, delta / 6)), rgb);
            break;
          case 'flow': {
            const f = Math.log(1 + this.flow[k] / meanFlow) / logMax;
            const g = 0.22 + 0.4 * ny * ny;
            rgb[0] = g;
            rgb[1] = g * 0.98;
            rgb[2] = g * 0.94;
            sampleRamp('water', 0.45 + 0.55 * f, tmp);
            mixRgb(rgb, rgb, tmp, smoothstep(0.3, 0.7, f));
            break;
          }
          default: {
            const b = this.biome[k];
            mixRgb(rgb, BIOME_GROUND_RGB[b], BIOME_ROCK_RGB[b], smoothstep(0.86, 0.68, ny));
            if (delta > 0) mixRgb(rgb, rgb, DEPOSIT, smoothstep(0.2, 3, delta) * 0.75);
            else mixRgb(rgb, rgb, BIOME_ROCK_RGB[b], smoothstep(0.3, 4, -delta) * 0.5);
            const snowLine = 150 + this.temperature[k] * 120;
            if (above > 0) mixRgb(rgb, rgb, SNOW, smoothstep(snowLine, snowLine + 35, above) * smoothstep(0.62, 0.82, ny));
          }
        }
        colors[k * 3] = srgbToLinear(rgb[0]);
        colors[k * 3 + 1] = srgbToLinear(rgb[1]);
        colors[k * 3 + 2] = srgbToLinear(rgb[2]);

        const depth = -above;
        mixRgb(tmp, SHALLOW, DEEP, smoothstep(0, 22, depth));
        water[k * 4] = srgbToLinear(tmp[0]);
        water[k * 4 + 1] = srgbToLinear(tmp[1]);
        water[k * 4 + 2] = srgbToLinear(tmp[2]);
        water[k * 4 + 3] = 0.3 + 0.55 * smoothstep(-0.5, 7, depth);
      }
    }
    return { size: N, heights, normals, colors, water, droplets: this.droplets, meanChange: (change / (N * N)) * this.range };
  }
}
