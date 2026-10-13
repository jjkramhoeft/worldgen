/**
 * The region lattice of the Watershed world (docs/WATERSHED-MODE.md §5.1–5.2).
 *
 * One jittered site per R × R lattice cell; the region of a point is the site
 * nearest to its domain-warped position. Every land region holds exactly one
 * continent, kept away from the region border by the coast function
 *
 *   L(p) = f·b(p) − margin − setback·n(p)      (land where L > 0)
 *
 * with b the exact distance to the Voronoi border, f a per-region size factor
 * and n a coast noise in [0, 1]. Ocean regions use −b instead of f·b, so L is
 * continuous across every border, and it is roughly a signed distance to the
 * coast in metres.
 */
import { DEFAULT_FRACTAL, DomainWarp2, Fractal2 } from '../../core/fractal';
import { deriveSeed, hash2i, unit } from '../../core/rng';
import type { WatershedSettings } from '../settings';

export interface RegionHit {
  /** Lattice cell of the region's site. */
  i: number;
  j: number;
  /** The site, in warped coordinates. */
  sx: number;
  sz: number;
  /** The warped sample position. */
  wx: number;
  wz: number;
  /** Distance to the region border (m, warped space). */
  b: number;
  /** Coast function: > 0 on land, ≈ signed distance to the coast (m). */
  L: number;
  /** Whether the region holds a continent. */
  land: boolean;
}

export function emptyHit(): RegionHit {
  return { i: 0, j: 0, sx: 0, sz: 0, wx: 0, wz: 0, b: 0, L: 0, land: false };
}

export class RegionLattice {
  readonly R: number;
  private readonly J: number;
  private readonly seedSites: number;
  private readonly seedLand: number;
  private readonly warp: DomainWarp2 | null;
  private readonly coast: Fractal2;
  private readonly tmp = new Float64Array(2);
  private readonly kx = new Float64Array(25);
  private readonly kz = new Float64Array(25);

  constructor(
    seed: number,
    private readonly s: WatershedSettings,
  ) {
    this.R = Math.max(1000, s.regions.size);
    this.J = Math.max(0, Math.min(1, s.regions.jitter));
    this.seedSites = deriveSeed(seed, 41);
    this.seedLand = deriveSeed(seed, 42);
    this.warp =
      s.regions.warp > 0
        ? new DomainWarp2(deriveSeed(seed, 43), { enabled: true, strength: s.regions.warp, scale: s.regions.warpScale, octaves: 3, iterations: 1 })
        : null;
    this.coast = new Fractal2(deriveSeed(seed, 44), { ...DEFAULT_FRACTAL, scale: s.coast.scale, octaves: s.coast.octaves });
  }

  siteX(i: number, j: number): number {
    return (i + 0.5 + this.J * (unit(hash2i(i, j, this.seedSites)) - 0.5)) * this.R;
  }

  siteZ(i: number, j: number): number {
    return (j + 0.5 + this.J * (unit(hash2i(i, j, this.seedSites + 1)) - 0.5)) * this.R;
  }

  isLand(i: number, j: number): boolean {
    return unit(hash2i(i, j, this.seedLand)) < this.s.regions.landChance;
  }

  /** Per-region size factor f ∈ [1 − sizeVariation, 1]. */
  sizeFactor(i: number, j: number): number {
    return 1 - Math.max(0, Math.min(1, this.s.coast.sizeVariation)) * unit(hash2i(i, j, this.seedLand + 1));
  }

  /** Coast noise n(p) ∈ [0, 1] at a warped position. */
  coastNoise(wx: number, wz: number, maxFreq = Infinity): number {
    const v = 0.5 + 0.8 * this.coast.sample(wx, wz, maxFreq);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * Region, border distance and coast function at (x, z). The warp is always
   * evaluated in full, so region membership never depends on the level of detail;
   * `maxFreq` only fades the finest coast octaves.
   */
  locate(x: number, z: number, out: RegionHit, maxFreq = Infinity): RegionHit {
    let wx = x;
    let wz = z;
    if (this.warp) {
      this.warp.apply(x, z, this.tmp);
      wx = this.tmp[0];
      wz = this.tmp[1];
    }
    const R = this.R;
    const ci = Math.floor(wx / R);
    const cj = Math.floor(wz / R);
    // One site per cell, jitter ≤ 1: the nearest site lies in the 5×5 block of cells.
    let best = Infinity;
    let bi = 0;
    let bj = 0;
    let bk = 0;
    let k = 0;
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        const i = ci + di;
        const j = cj + dj;
        const px = this.siteX(i, j);
        const pz = this.siteZ(i, j);
        this.kx[k] = px;
        this.kz[k] = pz;
        const d = (px - wx) * (px - wx) + (pz - wz) * (pz - wz);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
          bk = k;
        }
        k++;
      }
    }
    // Exact distance to the Voronoi border: the nearest bisector with any other site.
    const bx = this.kx[bk];
    const bz = this.kz[bk];
    let b = Infinity;
    for (k = 0; k < 25; k++) {
      if (k === bk) continue;
      const px = this.kx[k];
      const pz = this.kz[k];
      const len = Math.hypot(px - bx, pz - bz);
      const dk = ((px - wx) * (px - wx) + (pz - wz) * (pz - wz) - best) / (2 * len);
      if (dk < b) b = dk;
    }
    const land = this.isLand(bi, bj);
    const c = this.s.coast;
    const n = this.coastNoise(wx, wz, maxFreq);
    out.i = bi;
    out.j = bj;
    out.sx = bx;
    out.sz = bz;
    out.wx = wx;
    out.wz = wz;
    out.b = b;
    out.land = land;
    out.L = (land ? this.sizeFactor(bi, bj) * b : -b) - c.margin - c.setback * n;
    return out;
  }
}
