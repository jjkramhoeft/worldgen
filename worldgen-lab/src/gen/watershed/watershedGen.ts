/**
 * The Watershed generator: a pure function of (seed, settings, x, z), like the
 * Terrain generator, but built river-first (docs/WATERSHED-MODE.md §5.9–5.11).
 *
 * Per sample: find the region and the coast function L; outside the coast the
 * ground is an analytic ocean floor. On land the base surface interpolates the
 * region network's node heights (Catmull–Rom), plus detail noise that fades out
 * near rivers. Every river within reach then shapes the ground:
 *
 *   valley = w + bank + s·max(0, d − F)          rises away from the river
 *   levee  = w + bank − s·max(0, d − F)          falls away from the river
 *   chan   = w + bank − (D + bank)(1 − (2d/W)²)  inside the channel
 *   h = min( max( min(g₀, min valley), max levee ), min chan )
 *
 * so the river sits in a valley with a flat floodplain, its banks are above
 * the water, and its bed is a parabola. Everything is a min or max of
 * continuous functions, so the surface stays continuous.
 */
import { clamp01, smoothstep } from '../../core/color';
import { hash3i, unit } from '../../core/rng';
import { B, LEVELS, WHITTAKER, classifyBiome, level, type BiomeParams } from '../biomes';
import type { WatershedSettings } from '../settings';
import { emptySample, type TerrainSample } from '../terrain';
import type { HeightfieldSource } from '../terrainMesh';
import { U_MAX, WatershedFields } from './fields';
import {
  FLAG_RIVER,
  KIND_SEA,
  PT,
  P_AMP,
  P_DEPTH,
  P_SLOPE,
  P_FLAG,
  P_FLOOD,
  P_ORDER,
  P_PH,
  P_RV,
  P_W,
  P_WIDTH,
  buildRegion,
  nodeAt,
  type RegionNetwork,
  type RegionStats,
} from './network';
import { emptyHit } from './regions';

export interface WatershedSample extends TerrainSample {
  /** Water level (NaN = dry): river, lake or sea. */
  water: number;
  land: boolean;
  regionI: number;
  regionJ: number;
  /** Coast function (m): > 0 on land. */
  L: number;
  /** A colour key of the drainage basin in [0, 1), −1 = none. */
  basinKey: number;
  /** Upstream area at the nearest network node (km²). */
  area: number;
  /** Strahler order of the river here (0 = none). */
  order: number;
  /** Distance to the nearest river centreline (m), Infinity if none is near. */
  dRiver: number;
  /** Width of that river (m). */
  riverW: number;
  /** Normalised uplift Û ∈ [0, 1]. */
  uplift: number;
  rain: number;
  lake: number;
}

export function emptyWatershedSample(): WatershedSample {
  return {
    ...emptySample(),
    water: NaN,
    flowX: 0,
    flowZ: 0,
    land: false,
    regionI: 0,
    regionJ: 0,
    L: 0,
    basinKey: -1,
    area: 0,
    order: 0,
    dRiver: Infinity,
    riverW: 0,
    uplift: 0,
    rain: 1,
    lake: -1,
  };
}

const CACHE = 4;
/** Fields packed per vertex for the tile shader. */
const EXTRA = 8;
/** River segments that can shape one sample (the bucket lists are far shorter). */
const MAX_TERMS = 256;

/** Catmull–Rom weights of the 4 samples around t ∈ [0, 1). */
function crWeights(t: number, out: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
}

export class WatershedGenerator implements HeightfieldSource {
  readonly seed: number;
  readonly fields: WatershedFields;
  readonly waterField = true;
  readonly flowField = true;
  readonly extraStride = EXTRA;
  private readonly cache = new Map<string, RegionNetwork>();
  private lastNet: RegionNetwork | null = null;
  private readonly hit = emptyHit();
  private readonly wx = new Float64Array(4);
  private readonly wz = new Float64Array(4);
  /** Per-river valley, levee and edge terms of the current sample. */
  private readonly tV = new Float64Array(MAX_TERMS);
  private readonly tL = new Float64Array(MAX_TERMS);
  private readonly tE = new Float64Array(MAX_TERMS);
  private readonly biomeParams: BiomeParams;
  /** Statistics of the most recent region build. */
  lastBuild: RegionStats | null = null;

  constructor(
    seedText: string,
    readonly s: WatershedSettings,
  ) {
    this.fields = new WatershedFields(seedText, s);
    this.seed = this.fields.seed;
    this.biomeParams = { mode: s.biomes.mode, seaLevel: s.seaLevel, beachHeight: s.biomes.beachHeight, peakHeight: s.biomes.peakHeight };
  }

  get cachedRegions(): number {
    return this.cache.size;
  }

  /** The network of region (i, j), built on first use and kept in a small LRU cache. */
  region(i: number, j: number): RegionNetwork {
    const last = this.lastNet;
    if (last && last.i === i && last.j === j) return last;
    const key = `${i},${j}`;
    let net = this.cache.get(key);
    if (net) {
      this.cache.delete(key);
    } else {
      net = buildRegion(this.fields, i, j);
      this.lastBuild = net.stats;
      while (this.cache.size >= CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, net);
    this.lastNet = net;
    return net;
  }

  createSample(): WatershedSample {
    return emptyWatershedSample();
  }

  height(x: number, z: number, spacing = 0): number {
    return this.evaluate(x, z, spacing, null);
  }

  sample(x: number, z: number, out: TerrainSample = emptyWatershedSample(), spacing = 0): WatershedSample {
    this.evaluate(x, z, spacing, out as WatershedSample);
    return out as WatershedSample;
  }

  packExtra(s: TerrainSample, out: Float32Array, o: number): void {
    const w = s as WatershedSample;
    out[o] = w.water;
    out[o + 1] = w.basinKey;
    out[o + 2] = w.order;
    out[o + 3] = w.dRiver;
    out[o + 4] = w.riverW;
    out[o + 5] = w.area;
    out[o + 6] = w.uplift;
    out[o + 7] = w.rain;
  }

  unpackExtra(src: Float32Array, o: number, s: TerrainSample): void {
    const w = s as WatershedSample;
    w.water = src[o];
    w.basinKey = src[o + 1];
    w.order = src[o + 2];
    w.dRiver = src[o + 3];
    w.riverW = src[o + 4];
    w.area = src[o + 5];
    w.uplift = src[o + 6];
    w.rain = src[o + 7];
  }

  /** Catmull–Rom interpolation of the node heights; nodes outside the region count as beach. */
  private base(net: RegionNetwork, x: number, z: number): number {
    const g = net.g;
    const u = x / g;
    const v = z / g;
    const a = Math.floor(u);
    const b = Math.floor(v);
    crWeights(u - a, this.wx);
    crWeights(v - b, this.wz);
    const beach = this.s.coast.beach;
    let sum = 0;
    for (let jj = 0; jj < 4; jj++) {
      let row = 0;
      for (let ii = 0; ii < 4; ii++) {
        const k = nodeAt(net, a - 1 + ii, b - 1 + jj);
        row += this.wx[ii] * (k >= 0 ? net.height[k] : beach);
      }
      sum += this.wz[jj] * row;
    }
    return sum;
  }

  private evaluate(x: number, z: number, spacing: number, out: WatershedSample | null): number {
    const s = this.s;
    const f = this.fields;
    const sea = s.seaLevel;
    const g = s.network.grid;
    const maxFreq = spacing > 0 ? 1 / (2 * spacing) : Infinity;
    const hit = f.lattice.locate(x, z, this.hit, maxFreq);
    const L = hit.L;
    const net = hit.land && L > -(2 * g + 150) ? this.region(hit.i, hit.j) : null;
    const U = f.uplift(x, z, L, maxFreq);
    const Uh = clamp01(U / U_MAX);

    // ── rivers within reach ──
    let nTerms = 0;
    let minChan = Infinity;
    let fade = 1;
    let bestC = Infinity;
    let bestZone = Infinity;
    let wRiver = NaN;
    let flowX = 0;
    let flowZ = 0;
    let riverField = 0;
    let order = 0;
    let riverW = 0;
    if (net && net.segs.length) {
      const bk = net.bucket;
      const bx = Math.floor((x - bk.x0) / bk.size);
      const bz = Math.floor((z - bk.z0) / bk.size);
      if (bx >= 0 && bz >= 0 && bx < bk.nx && bz < bk.nz) {
        const cell = bz * bk.nx + bx;
        const sw = 1.3 * f.hillSlope(U);
        const cL = smoothstep(0, 150, L);
        // Far tiles: big rivers are drawn wider so they stay visible (up to 80 m); channels the
        // grid cannot resolve are not cut at all, so they never break up into stray water patches.
        const widen = spacing > 0 ? Math.min(2.5 * spacing, 80) : 0;
        const bank = s.rivers.bank;
        const pts = net.pts;
        for (let k = bk.start[cell]; k < bk.start[cell + 1]; k++) {
          const p = net.segs[bk.items[k]] * PT;
          const q = p + PT;
          const x0 = pts[p];
          const z0 = pts[p + 1];
          const dx = pts[q] - x0;
          const dz = pts[q + 1] - z0;
          const len = Math.sqrt(dx * dx + dz * dz);
          if (len < 1e-6) continue;
          const ux = dx / len;
          const uz = dz / len;
          const rx = x - x0;
          const rz = z - z0;
          const along = rx * ux + rz * uz;
          const lat = rz * ux - rx * uz;
          const tau = along <= 0 ? 0 : along >= len ? 1 : along / len;
          const over = along < 0 ? -along : along > len ? along - len : 0;
          const dc = Math.sqrt(over * over + lat * lat);
          const reach = pts[p + P_RV] + (pts[q + P_RV] - pts[p + P_RV]) * tau;
          if (dc > reach + widen) continue;
          const w = pts[p + P_W] + (pts[q + P_W] - pts[p + P_W]) * tau;
          const W = pts[p + P_WIDTH] + (pts[q + P_WIDTH] - pts[p + P_WIDTH]) * tau;
          const D = pts[p + P_DEPTH] + (pts[q + P_DEPTH] - pts[p + P_DEPTH]) * tau;
          const F = pts[p + P_FLOOD] + (pts[q + P_FLOOD] - pts[p + P_FLOOD]) * tau;
          // Meanders fade out on grids too coarse to resolve their wavelength (λ = max(11 W, 80 m)).
          const lam = Math.max(11 * W, 80);
          const a = (pts[p + P_AMP] + (pts[q + P_AMP] - pts[p + P_AMP]) * tau) * (1 - smoothstep(lam / 16, lam / 8, spacing));
          const Weff = Math.max(W, Math.min(widen, 6 * W));
          // Meander: the channel runs at lateral offset m(σ) = a·sin(φ₀ + kσ) along the
          // segment. Outside the meander belt it cannot be near; inside, a few Newton
          // steps find the closest point (σ, m(σ)) of the curve.
          const ph0 = pts[p + P_PH];
          const kp = (pts[q + P_PH] - ph0) / len;
          let dch: number;
          let mp = 0;
          if (Math.abs(lat) > a + Weff / 2 + 1) {
            dch = Math.sqrt(over * over + (Math.abs(lat) - a) ** 2);
          } else {
            let sg = tau * len;
            for (let it = 0; it < 3; it++) {
              const phs = ph0 + kp * sg;
              const sn = Math.sin(phs);
              const r = lat - a * sn;
              const m1 = a * kp * Math.cos(phs);
              const g2 = 1 + m1 * m1 + r * a * kp * kp * sn;
              if (g2 < 0.05) break;
              sg -= (sg - along - r * m1) / g2;
              sg = sg < 0 ? 0 : sg > len ? len : sg;
            }
            const phs = ph0 + kp * sg;
            mp = a * kp * Math.cos(phs);
            const du = along - sg;
            const dv = lat - a * Math.sin(phs);
            dch = Math.sqrt(du * du + dv * dv);
          }
          const resolved = spacing > 0 ? smoothstep(0.8 * spacing, 1.6 * spacing, Weff) : 1;
          // Valley and levee profiles; beyond the floodplain they blend into the
          // surrounding ground over the outer band (see the combination below).
          if (nTerms < MAX_TERMS) {
            const wall = Math.max(0, dc - F) * sw;
            this.tV[nTerms] = w + bank + wall;
            this.tL[nTerms] = pts[p + P_FLAG] === FLAG_RIVER ? w + bank - wall - 50 * (1 - cL) : -Infinity;
            this.tE[nTerms] = smoothstep(F + W, reach, dc);
            nTerms++;
          }
          if (dch < Weff / 2 && resolved > 0) {
            const t = (2 * dch) / Weff;
            const chan = w + bank - (D + bank) * resolved * (1 - t * t);
            if (chan < minChan) minChan = chan;
          }
          const fr = smoothstep(F, F + 2 * W + 30, dc);
          if (fr < fade) fade = fr;
          const rf = 1 - smoothstep(Weff * 0.35, Weff * 0.5 + 1.5, dch);
          if (rf > riverField) riverField = rf;
          if (dc < bestC) {
            bestC = dc;
            riverW = W;
            order = pts[p + P_ORDER];
          }
          if (dc < F + Weff / 2 + 2 * spacing && dc < bestZone) {
            bestZone = dc;
            wRiver = w;
            // Downstream along the meandering channel: u + m′·ν, with speed from the slope.
            const S = pts[p + P_SLOPE] + (pts[q + P_SLOPE] - pts[p + P_SLOPE]) * tau;
            const sp = Math.min(1.5, 0.3 + 12 * Math.sqrt(Math.max(0, S))) / Math.sqrt(1 + mp * mp);
            flowX = (ux - uz * mp) * sp;
            flowZ = (uz + ux * mp) * sp;
          }
        }
      }
    }

    // ── ground before the rivers ──
    let g0: number;
    if (L <= 0 || !net) {
      const d = -L;
      g0 = sea - 12 * smoothstep(0, 1500, d) - 18 * smoothstep(1500, 6000, d);
    } else {
      const det = s.relief.detail;
      const detail =
        det.amplitude !== 0 && fade > 0
          ? f.detail.sample(x, z, maxFreq) * det.amplitude * (1 - det.mountainBias + det.mountainBias * Uh) * fade * smoothstep(0, 300, L)
          : 0;
      g0 = sea + (this.base(net, x, z) + detail - sea) * smoothstep(0, 150, L);
    }
    // Each valley lowers the ground towards its profile and each levee raises it;
    // with the edge factor e they hand over to g₀ smoothly, so no cliff marks their reach.
    let minValley = Infinity;
    let maxLevee = -Infinity;
    for (let k = 0; k < nTerms; k++) {
      const e = this.tE[k];
      const v = this.tV[k];
      const ve = v < g0 ? v + (g0 - v) * e : v;
      if (ve < minValley) minValley = ve;
      const l = this.tL[k];
      if (l > -Infinity) {
        const le = l > g0 ? l + (g0 - l) * e : l;
        if (le > maxLevee) maxLevee = le;
      }
    }
    let h = Math.min(Math.max(Math.min(g0, minValley), maxLevee), minChan);

    // ── lakes: water at the lake level in every grid cell that touches a lake node ──
    let lakeId = -1;
    if (net && net.lakes.length && L > 0) {
      const a = Math.floor(x / g);
      const b = Math.floor(z / g);
      for (let k = 0; k < 4 && lakeId < 0; k++) {
        const idx = nodeAt(net, a + (k & 1), b + (k >> 1));
        if (idx >= 0 && net.lake[idx] >= 0) lakeId = net.lake[idx];
      }
    }
    let water = NaN;
    if (lakeId >= 0) water = net!.lakes[lakeId].level;
    else if (!Number.isNaN(wRiver)) water = wRiver;
    else if (h < sea) water = sea;

    const vs = s.verticalScale;
    if (vs !== 1) {
      h = sea + (h - sea) * vs;
      if (!Number.isNaN(water)) water = sea + (water - sea) * vs;
    }
    if (!out) return h;

    out.height = h;
    out.water = water;
    const flowing = lakeId < 0 && !Number.isNaN(wRiver);
    out.flowX = flowing ? flowX : 0;
    out.flowZ = flowing ? flowZ : 0;
    out.land = L > 0;
    out.L = L;
    out.regionI = hit.i;
    out.regionJ = hit.j;
    out.continentalness = Math.max(-1, Math.min(1, L / 5000));
    out.erosion = 1 - 2 * Uh;
    out.weirdness = 0;
    out.pv = 0;
    out.mountain = Uh;
    out.uplift = Uh;
    out.temperature = f.temperature(x, z, maxFreq);
    const rain = f.rain(x, z, maxFreq);
    out.rain = rain;
    out.river = riverField;
    out.order = bestC < riverW * 2 + 40 ? order : 0;
    out.dRiver = bestC;
    out.riverW = riverW;
    out.lake = lakeId;
    out.basinKey = -1;
    out.area = 0;
    let near = Infinity;
    if (net && L > 0) {
      const a = Math.round(x / g);
      const b = Math.round(z / g);
      const idx = nodeAt(net, a, b);
      if (idx >= 0 && net.kind[idx] !== KIND_SEA) {
        const basin = net.basin[idx];
        out.basinKey = basin >= 0 ? unit(hash3i(basin, net.i, net.j, 977)) : -1;
        out.area = net.area[idx];
      }
      // Distance to the river network for the humidity, interpolated bilinearly.
      const u = x / g - Math.floor(x / g);
      const v = z / g - Math.floor(z / g);
      const a0 = Math.floor(x / g);
      const b0 = Math.floor(z / g);
      let acc = 0;
      let wsum = 0;
      for (let k = 0; k < 4; k++) {
        const idk = nodeAt(net, a0 + (k & 1), b0 + (k >> 1));
        if (idk < 0 || !Number.isFinite(net.dRiver[idk])) continue;
        const wk = (k & 1 ? u : 1 - u) * (k >> 1 ? v : 1 - v);
        acc += wk * net.dRiver[idk];
        wsum += wk;
      }
      if (wsum > 0) near = acc / wsum;
    }
    out.humidity = Math.max(-1, Math.min(1, 1.2 * (rain - 1) + 0.45 * (1 - smoothstep(0, 900, near)) + 0.05));
    out.biome = this.classify(out);
    return h;
  }

  /** Biome: water bodies, river banks and wetlands first, then Whittaker with altitude cooling. */
  private classify(w: WatershedSample): number {
    const p = this.s.biomes;
    const sea = this.s.seaLevel;
    const above = w.height - sea;
    const tl = level(w.temperature, LEVELS.temperature);
    const wet = !Number.isNaN(w.water) && w.height < w.water;
    if (wet) {
      if (w.lake >= 0 || w.river > 0.3 || w.water > sea + 0.5) return tl === 0 ? B.FROZEN_RIVER : B.RIVER;
      if (tl === 0) return B.FROZEN_OCEAN;
      if (tl === 4) return B.WARM_OCEAN;
      if (above < -24) return B.DEEP_OCEAN;
      if (tl === 1) return B.COLD_OCEAN;
      if (tl === 3) return B.LUKEWARM_OCEAN;
      return B.OCEAN;
    }
    if (w.river > 0.6 && !Number.isNaN(w.water) && w.height < w.water + 0.5) return tl === 0 ? B.FROZEN_RIVER : B.RIVER;
    if (p.mode !== 'whittaker') return classifyBiome(w, this.biomeParams);
    if (above < p.beachHeight && w.L < 400) return tl === 0 ? B.SNOWY_BEACH : B.BEACH;
    const t = w.temperature - Math.max(0, above) / Math.max(1, p.lapse);
    // Wetlands on the floodplains of larger rivers.
    if (w.order >= 2 && !Number.isNaN(w.water) && w.height < w.water + 1.6 && w.humidity > 0.05 && t > -0.15) {
      return t > 0.5 ? B.MANGROVE_SWAMP : B.SWAMP;
    }
    if (above > p.peakHeight) return t < -0.45 ? (w.humidity > 0.2 ? B.FROZEN_PEAKS : B.JAGGED_PEAKS) : B.STONY_PEAKS;
    const row = t < -0.5 ? 0 : t < -0.1 ? 1 : t < 0.35 ? 2 : 3;
    const col = Math.min(4, Math.max(0, Math.floor((w.humidity + 1) * 2.5)));
    return WHITTAKER[row][col];
  }

  /** The nearest land region's site to (x, z), for placing the camera. */
  nearestLand(x: number, z: number): [number, number] {
    const lat = this.fields.lattice;
    const ci = Math.floor(x / lat.R);
    const cj = Math.floor(z / lat.R);
    let best: [number, number] = [x, z];
    let bestD = Infinity;
    for (let r = 0; r < 6 && bestD === Infinity; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !lat.isLand(ci + di, cj + dj)) continue;
          const sx = lat.siteX(ci + di, cj + dj);
          const sz = lat.siteZ(ci + di, cj + dj);
          const d = Math.hypot(sx - x, sz - z);
          if (d < bestD) {
            bestD = d;
            best = [sx, sz];
          }
        }
      }
    }
    return best;
  }

  /** Details for the HUD probe and the map readout. */
  describe(x: number, z: number): { sample: WatershedSample; mouth: [number, number] | null; discharge: number; region: RegionStats | null } {
    const sample = this.sample(x, z, emptyWatershedSample());
    let mouth: [number, number] | null = null;
    let region: RegionStats | null = null;
    if (sample.land) {
      const net = this.region(sample.regionI, sample.regionJ);
      region = net.stats;
      const idx = nodeAt(net, Math.round(x / net.g), Math.round(z / net.g));
      if (idx >= 0 && net.basin[idx] >= 0) {
        const o = net.basin[idx];
        mouth = [net.ga[o] * net.g, net.gb[o] * net.g];
      }
    }
    // Runoff in mm/yr over 1 km² gives m³/s: mm·1e-3 m·1e6 m² / 31 557 600 s.
    const discharge = sample.area * this.s.climate.runoff * 3.1688e-5;
    return { sample, mouth, discharge, region };
  }
}
