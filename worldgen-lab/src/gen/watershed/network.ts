/**
 * Builds the drainage network of one region (docs/WATERSHED-MODE.md §5.3–5.8).
 *
 *  1. Membership: a flood fill over the global node lattice (spacing g) keeps
 *     the nodes whose warped position belongs to the region.
 *  2. Outlets: land nodes with a sea neighbour.
 *  3. Growth: a shortest-path forest from the outlets (Dijkstra). Edge cost
 *     |ab|·U(b)·(1 ± jitter): basins grow fastest through low uplift, so rivers
 *     run in the structural lows. Every land node gets one receiver.
 *  4. Area: rain-weighted cell areas accumulated from the leaves down.
 *  5. Heights, rivers first: from the outlets upward,
 *       h(n) = h(receiver) + |n − receiver| · clamp(k·U·A^−θ)
 *     — the steady state of the stream power law. Every node is higher than
 *     its receiver, so the coarse surface has no pits.
 *  6. Lakes: a flat river node becomes a sill; the lake floods its upstream
 *     subtree below the sill + dam height, and a rim guard raises any lower
 *     neighbour so the lake can only spill over its sill.
 *  7. Rivers: Strahler order, reaches between junctions, smooth curves with
 *     meanders, and a bucket grid for nearest-segment queries.
 *
 * Everything depends only on (seed, settings, region), so every worker builds
 * the same network independently.
 */
import { smoothstep } from '../../core/color';
import { deriveSeed, hash2i, unit } from '../../core/rng';
import type { WatershedFields } from './fields';
import { emptyHit } from './regions';

export const KIND_SEA = 1;
export const KIND_LAND = 2;
export const KIND_OUTLET = 3;

/** River curve points: stride and field offsets. */
export const PT = 14;
export const P_X = 0;
export const P_Z = 1;
/** Arc length from the start of the reach (m). */
export const P_S = 2;
/** Water level (m). */
export const P_W = 3;
export const P_WIDTH = 4;
export const P_DEPTH = 5;
/** Channel slope. */
export const P_SLOPE = 6;
/** Upstream area (km²). */
export const P_AREA = 7;
/** Meander amplitude (m) and phase (radians). */
export const P_AMP = 8;
export const P_PH = 9;
/** Floodplain half-width (m), measured from the centreline. */
export const P_FLOOD = 10;
/** Reach of the valley terms (m): beyond it the river does not touch the terrain. */
export const P_RV = 11;
export const P_ORDER = 12;
export const P_FLAG = 13;

export const FLAG_RIVER = 0;
/** Enters or leaves a lake: no levees. */
export const FLAG_LAKE_EDGE = 1;
/** Inside a lake: not carved, not indexed. */
export const FLAG_IN_LAKE = 2;

/** Extra reach of the segment index for the LOD widening of far channels (m). */
export const LOD_MARGIN = 45;

export interface LakeInfo {
  id: number;
  /** Position of the sill node (m). */
  x: number;
  z: number;
  /** Water level (m). */
  level: number;
  sill: number;
  nodes: number;
}

export interface RegionStats {
  ms: number;
  nodes: number;
  land: number;
  outlets: number;
  riverNodes: number;
  reaches: number;
  maxOrder: number;
  lakes: number;
  riverKm: number;
  maxArea: number;
}

export interface RegionNetwork {
  readonly i: number;
  readonly j: number;
  readonly land: boolean;
  readonly g: number;
  /** Node bounding box in global lattice coordinates. */
  readonly a0: number;
  readonly b0: number;
  readonly bw: number;
  readonly bh: number;
  /** Bounding-box cell → node index, −1 = not in this region. */
  readonly index: Int32Array;
  readonly n: number;
  readonly ga: Int32Array;
  readonly gb: Int32Array;
  readonly kind: Uint8Array;
  /** Coast function at the node (m). */
  readonly L: Float32Array;
  readonly uplift: Float32Array;
  /** Ground height at the node (m); sea nodes hold the beach height. */
  readonly height: Float32Array;
  /** Water level of river and lake nodes, NaN elsewhere. */
  readonly water: Float32Array;
  /** Rain-weighted upstream area (km²). */
  readonly area: Float32Array;
  readonly slope: Float32Array;
  /** Downstream node, −1 for sea nodes and outlets. */
  readonly receiver: Int32Array;
  /** The outlet a node drains to, −1 for sea. */
  readonly basin: Int32Array;
  /** Strahler order of river nodes, 0 = not a river. */
  readonly strahler: Uint8Array;
  readonly lake: Int16Array;
  /** Distance to the nearest river node (m). */
  readonly dRiver: Float32Array;
  readonly lakes: LakeInfo[];
  readonly pts: Float32Array;
  /** Segment → index of its first point; the second point follows it. */
  readonly segs: Int32Array;
  readonly bucket: { x0: number; z0: number; size: number; nx: number; nz: number; start: Int32Array; items: Int32Array };
  readonly stats: RegionStats;
}

const DA = [1, -1, 0, 0, 1, 1, -1, -1];
const DB = [0, 0, 1, -1, 1, -1, 1, -1];
const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
const BUCKET = 256;

/** Binary min-heap of (key, value) pairs in growable typed arrays. */
class Heap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    let i = this.size++;
    const keys = this.keys;
    const vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Removes the smallest entry; its key is left in `topKey`. */
  topKey = 0;
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const val = vals[0];
    this.topKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const k = keys[n];
      const v = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return val;
  }
}

function emptyRegion(i: number, j: number, g: number, t0: number): RegionNetwork {
  return {
    i,
    j,
    land: false,
    g,
    a0: 0,
    b0: 0,
    bw: 0,
    bh: 0,
    index: new Int32Array(0),
    n: 0,
    ga: new Int32Array(0),
    gb: new Int32Array(0),
    kind: new Uint8Array(0),
    L: new Float32Array(0),
    uplift: new Float32Array(0),
    height: new Float32Array(0),
    water: new Float32Array(0),
    area: new Float32Array(0),
    slope: new Float32Array(0),
    receiver: new Int32Array(0),
    basin: new Int32Array(0),
    strahler: new Uint8Array(0),
    lake: new Int16Array(0),
    dRiver: new Float32Array(0),
    lakes: [],
    pts: new Float32Array(0),
    segs: new Int32Array(0),
    bucket: { x0: 0, z0: 0, size: BUCKET, nx: 0, nz: 0, start: new Int32Array(1), items: new Int32Array(0) },
    stats: { ms: performance.now() - t0, nodes: 0, land: 0, outlets: 0, riverNodes: 0, reaches: 0, maxOrder: 0, lakes: 0, riverKm: 0, maxArea: 0 },
  };
}

/** Node index at global lattice coordinates (a, b), or −1. */
export function nodeAt(net: RegionNetwork, a: number, b: number): number {
  const x = a - net.a0;
  const y = b - net.b0;
  if (x < 0 || y < 0 || x >= net.bw || y >= net.bh) return -1;
  return net.index[y * net.bw + x];
}

/** Position of a river control point: the node, jittered by up to ±0.25 g (hashed, so every reach agrees). */
function jitter(a: number, b: number, seed: number): number {
  return 0.25 * (2 * unit(hash2i(a, b, seed)) - 1);
}

export function buildRegion(f: WatershedFields, i: number, j: number): RegionNetwork {
  const t0 = performance.now();
  const s = f.s;
  const lat = f.lattice;
  const g = s.network.grid;
  const sea = s.seaLevel;
  const beach = s.coast.beach;
  if (!lat.isLand(i, j)) return emptyRegion(i, j, g, t0);

  // ───────────── 1. membership flood fill ─────────────
  const maxFreq = 1 / (2 * g);
  const hit = emptyHit();
  const half = Math.ceil((lat.R * 1.4 + s.regions.warp * 1.5) / g);
  const W0 = 2 * half + 1;
  const ca = Math.round(lat.siteX(i, j) / g);
  const cb = Math.round(lat.siteZ(i, j) / g);
  const oa = ca - half;
  const ob = cb - half;
  const visited = new Uint8Array(W0 * W0);
  const boxL = new Float32Array(W0 * W0);
  const queue = new Int32Array(W0 * W0);
  const test = (cell: number): boolean => {
    const a = oa + (cell % W0);
    const b = ob + ((cell / W0) | 0);
    lat.locate(a * g, b * g, hit, maxFreq);
    if (hit.i === i && hit.j === j) {
      visited[cell] = 1;
      boxL[cell] = hit.L;
      return true;
    }
    visited[cell] = 2;
    return false;
  };
  let seedCell = -1;
  for (let r = 0; r <= half && seedCell < 0; r += 2) {
    for (let db = -r; db <= r && seedCell < 0; db += Math.max(1, r)) {
      for (let da = -r; da <= r && seedCell < 0; da += Math.max(1, r)) {
        const cell = (half + db) * W0 + (half + da);
        if (!visited[cell] && test(cell)) seedCell = cell;
      }
    }
  }
  if (seedCell < 0) return emptyRegion(i, j, g, t0);
  let qt = 0;
  queue[qt++] = seedCell;
  for (let qh = 0; qh < qt; qh++) {
    const c = queue[qh];
    const x = c % W0;
    const y = (c / W0) | 0;
    if (x > 0 && !visited[c - 1] && test(c - 1)) queue[qt++] = c - 1;
    if (x < W0 - 1 && !visited[c + 1] && test(c + 1)) queue[qt++] = c + 1;
    if (y > 0 && !visited[c - W0] && test(c - W0)) queue[qt++] = c - W0;
    if (y < W0 - 1 && !visited[c + W0] && test(c + W0)) queue[qt++] = c + W0;
  }

  // ───────────── compact arrays over the members ─────────────
  let xmin = W0;
  let xmax = 0;
  let ymin = W0;
  let ymax = 0;
  for (let k = 0; k < qt; k++) {
    const x = queue[k] % W0;
    const y = (queue[k] / W0) | 0;
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  const n = qt;
  const a0 = oa + xmin;
  const b0 = ob + ymin;
  const bw = xmax - xmin + 1;
  const bh = ymax - ymin + 1;
  const index = new Int32Array(bw * bh).fill(-1);
  const ga = new Int32Array(n);
  const gb = new Int32Array(n);
  const L = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const x = queue[k] % W0;
    const y = (queue[k] / W0) | 0;
    ga[k] = oa + x;
    gb[k] = ob + y;
    L[k] = boxL[queue[k]];
    index[(y - ymin) * bw + (x - xmin)] = k;
  }
  const at = (a: number, b: number): number => {
    const x = a - a0;
    const y = b - b0;
    return x < 0 || y < 0 || x >= bw || y >= bh ? -1 : index[y * bw + x];
  };

  // ───────────── 2. land, outlets and the fields at the nodes ─────────────
  const kind = new Uint8Array(n);
  const uplift = new Float32Array(n);
  const rain = new Float32Array(n);
  const costF = new Float32Array(n);
  const seedJit = deriveSeed(f.seed, 4010);
  const jit = Math.max(0, Math.min(0.9, s.network.jitter));
  let landCount = 0;
  for (let k = 0; k < n; k++) kind[k] = L[k] > 0 ? KIND_LAND : KIND_SEA;
  for (let k = 0; k < n; k++) {
    if (kind[k] !== KIND_LAND) continue;
    landCount++;
    for (let d = 0; d < 8; d++) {
      const m = at(ga[k] + DA[d], gb[k] + DB[d]);
      if (m < 0 || kind[m] === KIND_SEA) {
        kind[k] = KIND_OUTLET;
        break;
      }
    }
    const x = ga[k] * g;
    const z = gb[k] * g;
    uplift[k] = f.uplift(x, z, L[k], maxFreq);
    rain[k] = f.rain(x, z, maxFreq);
    costF[k] = uplift[k] * (1 + jit * (2 * unit(hash2i(ga[k], gb[k], seedJit)) - 1));
  }

  // ───────────── 3. growth: shortest-path forest from the outlets ─────────────
  const cost = new Float64Array(n).fill(Infinity);
  const receiver = new Int32Array(n).fill(-1);
  const basin = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const settle = new Int32Array(landCount);
  let settleCount = 0;
  let outlets = 0;
  const heap = new Heap();
  for (let k = 0; k < n; k++) {
    if (kind[k] !== KIND_OUTLET) continue;
    outlets++;
    cost[k] = s.network.mouthBias * 10 * g * f.mouth(ga[k] * g, gb[k] * g);
    heap.push(cost[k], k);
  }
  const isLandNode = (m: number) => m >= 0 && kind[m] >= KIND_LAND;
  /** True if the diagonal edge m–p would cross the other diagonal of its 2×2 cell, already in the tree. */
  const crosses = (m: number, p: number): boolean => {
    const q1 = at(ga[m], gb[p]);
    const q2 = at(ga[p], gb[m]);
    if (q1 < 0 || q2 < 0) return false;
    return (settled[q1] && receiver[q1] === q2) || (settled[q2] && receiver[q2] === q1) ? true : false;
  };
  while (heap.size > 0) {
    const m = heap.pop();
    const c = heap.topKey;
    if (settled[m] || c > cost[m]) continue;
    const p = receiver[m];
    if (p >= 0 && ga[p] !== ga[m] && gb[p] !== gb[m] && crosses(m, p)) {
      // The cheapest parent would cross an existing river edge: take the best one that does not.
      let best = Infinity;
      let bp = -1;
      for (let d = 0; d < 8; d++) {
        const q = at(ga[m] + DA[d], gb[m] + DB[d]);
        if (!isLandNode(q) || !settled[q]) continue;
        if (d >= 4 && crosses(m, q)) continue;
        const cc = cost[q] + DL[d] * g * costF[m];
        if (cc < best) {
          best = cc;
          bp = q;
        }
      }
      cost[m] = best;
      receiver[m] = bp;
      if (bp >= 0) heap.push(best, m);
      continue;
    }
    settled[m] = 1;
    settle[settleCount++] = m;
    basin[m] = p >= 0 ? basin[p] : m;
    for (let d = 0; d < 8; d++) {
      const q = at(ga[m] + DA[d], gb[m] + DB[d]);
      if (!isLandNode(q) || settled[q] || kind[q] === KIND_OUTLET) continue;
      const cc = c + DL[d] * g * costF[q];
      if (cc < cost[q]) {
        cost[q] = cc;
        receiver[q] = m;
        heap.push(cc, q);
      }
    }
  }

  // Children in CSR form.
  const childStart = new Int32Array(n + 1);
  for (let k = 0; k < settleCount; k++) {
    const r = receiver[settle[k]];
    if (r >= 0) childStart[r + 1]++;
  }
  for (let k = 0; k < n; k++) childStart[k + 1] += childStart[k];
  const childList = new Int32Array(childStart[n]);
  const fillPos = childStart.slice(0, n);
  for (let k = 0; k < settleCount; k++) {
    const m = settle[k];
    const r = receiver[m];
    if (r >= 0) childList[fillPos[r]++] = m;
  }
  const dist = (m: number, r: number) => (ga[m] !== ga[r] && gb[m] !== gb[r] ? Math.SQRT2 : 1) * g;

  // ───────────── 4. area ─────────────
  const cellArea = (g / 1000) ** 2;
  const area = new Float32Array(n);
  for (let k = 0; k < settleCount; k++) area[settle[k]] = cellArea * rain[settle[k]];
  for (let k = settleCount - 1; k >= 0; k--) {
    const m = settle[k];
    const r = receiver[m];
    if (r >= 0) area[r] += area[m];
  }

  // ───────────── 5. heights, from the outlets upward ─────────────
  const rel = s.relief;
  const slope = new Float32Array(n);
  const height = new Float32Array(n).fill(beach);
  for (let k = 0; k < settleCount; k++) {
    const m = settle[k];
    const S = Math.max(rel.minSlope, Math.min(rel.maxSlope, rel.k * uplift[m] * Math.pow(area[m], -rel.concavity)));
    slope[m] = S;
    const r = receiver[m];
    height[m] = r >= 0 ? height[r] + dist(m, r) * S : beach;
  }
  const threshold = Math.max(cellArea * 1.5, s.rivers.threshold);
  const isRiver = (m: number) => kind[m] >= KIND_LAND && area[m] >= threshold;

  // ───────────── 6. lakes ─────────────
  const lake = new Int16Array(n).fill(-1);
  const sillOf = new Int16Array(n).fill(-1);
  const lakes: LakeInfo[] = [];
  if (s.lakes.enabled && s.lakes.chance > 0) {
    buildLakes();
  }

  function raiseUpstream(start: number): void {
    const climb = Math.max(rel.minSlope, 0.002);
    const stack = [start];
    while (stack.length) {
      const m = stack.pop()!;
      for (let c = childStart[m]; c < childStart[m + 1]; c++) {
        const ch = childList[c];
        if (lake[ch] >= 0) continue;
        const need = height[m] + dist(ch, m) * climb;
        if (height[ch] < need) {
          height[ch] = need;
          stack.push(ch);
        }
      }
    }
  }

  function buildLakes(): void {
    const seedLake = deriveSeed(f.seed, 4100);
    const radius = s.lakes.radius;
    const minSpacing = Math.max(2.5 * radius, 6 * g);
    const protect = new Uint8Array(n);
    const stamp = new Int32Array(n);
    const inFp = new Int32Array(n);
    let tag = 0;
    const fp: number[] = [];
    const rim: number[] = [];
    for (let k = 0; k < settleCount; k++) {
      const c = settle[k];
      if (!isRiver(c) || kind[c] === KIND_OUTLET || slope[c] >= 0.01 || L[c] < 3 * g) continue;
      if (lake[c] >= 0 || protect[c]) continue;
      if (unit(hash2i(ga[c], gb[c], seedLake)) >= s.lakes.chance) continue;
      const cx = ga[c] * g;
      const cz = gb[c] * g;
      if (lakes.some((l) => Math.hypot(l.x - cx, l.z - cz) < minSpacing)) continue;
      const Hg = height[c] + 3 + 9 * unit(hash2i(ga[c], gb[c], seedLake + 1));
      tag++;
      // The sill's downstream chain may neither flood nor be raised.
      for (let r = receiver[c]; r >= 0; r = receiver[r]) stamp[r] = tag;
      // Footprint: the sill's upstream subtree below the lake level.
      fp.length = 0;
      const stack: number[] = [];
      for (let q = childStart[c]; q < childStart[c + 1]; q++) stack.push(childList[q]);
      while (stack.length) {
        const m = stack.pop()!;
        if (lake[m] >= 0 || protect[m] || height[m] >= Hg) continue;
        if (Math.hypot(ga[m] * g - cx, gb[m] * g - cz) > radius) continue;
        let touchesChain = false;
        for (let d = 0; d < 8 && !touchesChain; d++) {
          const q = at(ga[m] + DA[d], gb[m] + DB[d]);
          if (q >= 0 && stamp[q] === tag) touchesChain = true;
        }
        if (touchesChain) continue;
        fp.push(m);
        inFp[m] = tag;
        for (let q = childStart[m]; q < childStart[m + 1]; q++) stack.push(childList[q]);
      }
      if (fp.length < 4) continue;
      // Rim: every other neighbour must stand at least 1 m above the lake.
      rim.length = 0;
      let ok = true;
      for (const m of fp) {
        for (let d = 0; d < 8 && ok; d++) {
          const q = at(ga[m] + DA[d], gb[m] + DB[d]);
          if (q < 0 || q === c || inFp[q] === tag) continue;
          if (kind[q] === KIND_SEA) ok = false;
          else if (height[q] < Hg + 1) {
            if (protect[q] || lake[q] >= 0 || stamp[q] === tag || kind[q] === KIND_OUTLET) ok = false;
            else rim.push(q);
          }
        }
        if (!ok) break;
      }
      if (!ok) continue;
      const id = lakes.length;
      for (const m of fp) lake[m] = id;
      height[c] = Hg;
      sillOf[c] = id;
      raiseUpstream(c);
      for (const q of rim) {
        if (height[q] < Hg + 1) {
          height[q] = Hg + 1;
          raiseUpstream(q);
        }
      }
      protect[c] = 1;
      for (const m of fp) protect[m] = 1;
      for (let r = receiver[c]; r >= 0; r = receiver[r]) protect[r] = 1;
      lakes.push({ id, x: cx, z: cz, level: Hg - beach + sea, sill: c, nodes: fp.length });
    }
  }

  // ───────────── water levels and stream order ─────────────
  const water = new Float32Array(n).fill(NaN);
  const strahler = new Uint8Array(n);
  const riverKids = new Uint8Array(n);
  const maxKid = new Uint8Array(n);
  const maxCount = new Uint8Array(n);
  let riverNodes = 0;
  let maxArea = 0;
  for (let k = 0; k < settleCount; k++) {
    const m = settle[k];
    if (lake[m] >= 0) water[m] = lakes[lake[m]].level;
    if (!isRiver(m)) continue;
    riverNodes++;
    if (lake[m] < 0) water[m] = height[m] - beach + sea;
    if (area[m] > maxArea) maxArea = area[m];
    const r = receiver[m];
    if (r >= 0) riverKids[r] = Math.min(255, riverKids[r] + 1);
  }
  let maxOrder = 0;
  for (let k = settleCount - 1; k >= 0; k--) {
    const m = settle[k];
    if (!isRiver(m)) continue;
    const o = riverKids[m] === 0 ? 1 : maxCount[m] >= 2 ? maxKid[m] + 1 : maxKid[m];
    strahler[m] = o;
    if (o > maxOrder) maxOrder = o;
    const r = receiver[m];
    if (r < 0) continue;
    if (o > maxKid[r]) {
      maxKid[r] = o;
      maxCount[r] = 1;
    } else if (o === maxKid[r]) maxCount[r] = Math.min(255, maxCount[r] + 1);
  }

  // ───────────── distance to the nearest river node (chamfer transform) ─────────────
  const dRiver = new Float32Array(n).fill(Infinity);
  for (let k = 0; k < n; k++) if (strahler[k] > 0) dRiver[k] = 0;
  const diag = g * Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    const fwd = pass === 0;
    for (let yy = 0; yy < bh; yy++) {
      const y = fwd ? yy : bh - 1 - yy;
      for (let xx = 0; xx < bw; xx++) {
        const x = fwd ? xx : bw - 1 - xx;
        const m = index[y * bw + x];
        if (m < 0) continue;
        let d = dRiver[m];
        const sy = fwd ? -1 : 1;
        const sx = fwd ? -1 : 1;
        const q1 = at(a0 + x + sx, b0 + y);
        const q2 = at(a0 + x, b0 + y + sy);
        const q3 = at(a0 + x + sx, b0 + y + sy);
        const q4 = at(a0 + x - sx, b0 + y + sy);
        if (q1 >= 0 && dRiver[q1] + g < d) d = dRiver[q1] + g;
        if (q2 >= 0 && dRiver[q2] + g < d) d = dRiver[q2] + g;
        if (q3 >= 0 && dRiver[q3] + diag < d) d = dRiver[q3] + diag;
        if (q4 >= 0 && dRiver[q4] + diag < d) d = dRiver[q4] + diag;
        dRiver[m] = d;
      }
    }
  }

  // ───────────── 7. reaches and river curves ─────────────
  const seedCp = deriveSeed(f.seed, 4020);
  const seedPh = deriveSeed(f.seed, 4030);
  const pts: number[] = [];
  const segList: number[] = [];
  let reaches = 0;
  let riverKm = 0;
  const rv = s.rivers;
  const cx: number[] = [];
  const cz: number[] = [];
  const cw: number[] = [];
  const cA: number[] = [];
  const cS: number[] = [];
  const cNode: number[] = [];
  const nodesOfReach: number[] = [];
  const nodeFlag = (m: number) => (m < 0 ? 0 : lake[m] >= 0 ? 2 : sillOf[m] >= 0 ? 1 : 0);
  const intervalFlag = (p: number, q: number): number => {
    const fp = nodeFlag(p);
    const fq = nodeFlag(q);
    if (fp === 2 && fq >= 1) return FLAG_IN_LAKE;
    return fp || fq ? FLAG_LAKE_EDGE : FLAG_RIVER;
  };
  for (let k = 0; k < settleCount; k++) {
    const start = settle[k];
    if (!isRiver(start) || riverKids[start] === 1) continue;
    // Walk downstream to the next junction or the sea.
    nodesOfReach.length = 0;
    nodesOfReach.push(start);
    let cur = start;
    for (;;) {
      const r = receiver[cur];
      if (r < 0) break;
      nodesOfReach.push(r);
      if (riverKids[r] >= 2) break;
      cur = r;
    }
    const last = nodesOfReach[nodesOfReach.length - 1];
    if (nodesOfReach.length < 2 && receiver[last] >= 0) continue;
    reaches++;
    cx.length = cz.length = cw.length = cA.length = cS.length = cNode.length = 0;
    for (const m of nodesOfReach) {
      cx.push((ga[m] + jitter(ga[m], gb[m], seedCp)) * g);
      cz.push((gb[m] + jitter(ga[m], gb[m], seedCp + 1)) * g);
      cw.push(water[m]);
      cA.push(area[m]);
      cS.push(slope[m]);
      cNode.push(m);
    }
    if (receiver[last] < 0) {
      // Mouth: continue two grid steps out to sea, at sea level.
      let bestL = Infinity;
      let da = 0;
      let db = 0;
      for (let d = 0; d < 8; d++) {
        const q = at(ga[last] + DA[d], gb[last] + DB[d]);
        const lq = q < 0 ? -Infinity : kind[q] === KIND_SEA ? L[q] : Infinity;
        if (lq < bestL) {
          bestL = lq;
          da = DA[d];
          db = DB[d];
        }
      }
      const len = Math.hypot(da, db) || 1;
      const ex = cx[cx.length - 1];
      const ez = cz[cz.length - 1];
      for (let e = 1; e <= 2; e++) {
        cx.push(ex + (da / len) * g * e);
        cz.push(ez + (db / len) * g * e);
        cw.push(sea);
        cA.push(area[last]);
        cS.push(0.001);
        cNode.push(-1);
      }
    }
    riverKm += appendReach(start) / 1000;
  }

  /** Samples one reach's control points into curve points; returns its length (m). */
  function appendReach(startNode: number): number {
    const m = cx.length;
    const order = strahler[startNode];
    const first = pts.length / PT;
    const px: number[] = [];
    const pz: number[] = [];
    const pw: number[] = [];
    const pA: number[] = [];
    const pS: number[] = [];
    const pf: number[] = [];
    const step = g / 4;
    for (let k = 0; k < m - 1; k++) {
      const x0 = k > 0 ? cx[k - 1] : 2 * cx[0] - cx[1];
      const z0 = k > 0 ? cz[k - 1] : 2 * cz[0] - cz[1];
      const x3 = k + 2 < m ? cx[k + 2] : 2 * cx[m - 1] - cx[m - 2];
      const z3 = k + 2 < m ? cz[k + 2] : 2 * cz[m - 1] - cz[m - 2];
      const flag = intervalFlag(cNode[k], cNode[k + 1]);
      const sub = Math.max(2, Math.ceil(Math.hypot(cx[k + 1] - cx[k], cz[k + 1] - cz[k]) / step));
      for (let q = 0; q < sub; q++) {
        const t = q / sub;
        catmullRom(x0, z0, cx[k], cz[k], cx[k + 1], cz[k + 1], x3, z3, t, tmp2);
        px.push(tmp2[0]);
        pz.push(tmp2[1]);
        pw.push(cw[k] + (cw[k + 1] - cw[k]) * t);
        pA.push(cA[k] + (cA[k + 1] - cA[k]) * t);
        pS.push(cS[k] + (cS[k + 1] - cS[k]) * t);
        pf.push(flag);
      }
    }
    px.push(cx[m - 1]);
    pz.push(cz[m - 1]);
    pw.push(cw[m - 1]);
    pA.push(cA[m - 1]);
    pS.push(cS[m - 1]);
    pf.push(pf.length ? pf[pf.length - 1] : 0);
    const N = px.length;
    // Arc length.
    const sArr = new Float64Array(N);
    for (let q = 1; q < N; q++) sArr[q] = sArr[q - 1] + Math.hypot(px[q] - px[q - 1], pz[q] - pz[q - 1]);
    const total = sArr[N - 1];
    // Width, depth, meander amplitude limited by the curvature of the centreline.
    const W = new Float64Array(N);
    const D = new Float64Array(N);
    const lam = new Float64Array(N);
    const amp = new Float64Array(N);
    for (let q = 0; q < N; q++) {
      const a100 = Math.max(1e-6, pA[q] / 100);
      W[q] = rv.width100 * Math.sqrt(a100);
      D[q] = rv.depth100 * Math.pow(a100, 0.4);
      lam[q] = Math.max(11 * W[q], 80);
      let a = rv.meander * Math.min(2.7 * Math.pow(W[q], 1.1), 0.3 * g) * (1 - smoothstep(0.002, 0.02, pS[q]));
      if (q > 0 && q < N - 1) {
        const ax = px[q] - px[q - 1];
        const az = pz[q] - pz[q - 1];
        const bx = px[q + 1] - px[q];
        const bz = pz[q + 1] - pz[q];
        const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
        const len = 0.5 * (Math.hypot(ax, az) + Math.hypot(bx, bz));
        if (turn > 1e-6) a = Math.min(a, (0.35 * len) / turn);
      }
      if (pf[q] === FLAG_IN_LAKE) a = 0;
      amp[q] = a;
    }
    // Let the amplitude change by at most 0.25 m per metre, then fade it out at both ends.
    for (let q = 1; q < N; q++) amp[q] = Math.min(amp[q], amp[q - 1] + 0.25 * (sArr[q] - sArr[q - 1]));
    for (let q = N - 2; q >= 0; q--) amp[q] = Math.min(amp[q], amp[q + 1] + 0.25 * (sArr[q + 1] - sArr[q]));
    // Natural meanders are irregular: the wavelength wanders by ±30 % and the amplitude
    // by ±35 % along the river, with phases hashed per reach.
    let ph = 2 * Math.PI * unit(hash2i(ga[startNode], gb[startNode], seedPh));
    const ph2 = 2 * Math.PI * unit(hash2i(ga[startNode], gb[startNode], seedPh + 1));
    const ph3 = 2 * Math.PI * unit(hash2i(ga[startNode], gb[startNode], seedPh + 2));
    for (let q = 0; q < N; q++) {
      const sq = sArr[q];
      if (q > 0) {
        const lm = 0.5 * (lam[q] + lam[q - 1]);
        const wander = 1 + 0.3 * Math.sin((2 * Math.PI * sq) / (5.3 * lm) + ph2);
        ph += (2 * Math.PI * (sq - sArr[q - 1])) / (lm * wander);
      }
      const env = smoothstep(0, lam[q], sq) * smoothstep(0, lam[q], total - sq);
      const a = amp[q] * env * (0.65 + 0.35 * Math.sin((2 * Math.PI * sq) / (3.7 * lam[q]) + ph3));
      const F = Math.max(rv.floodplain * W[q], a + W[q]);
      pts.push(px[q], pz[q], sArr[q], pw[q], W[q], D[q], pS[q], pA[q], a, ph, F, F + 6 * W[q] + 120, order, pf[q]);
    }
    for (let q = 0; q < N - 1; q++) if (pf[q] !== FLAG_IN_LAKE) segList.push(first + q);
    return total;
  }

  const ptsArr = new Float32Array(pts);
  const segs = new Int32Array(segList);

  // ───────────── bucket index of the segments ─────────────
  const bx0 = a0 * g - 2 * g;
  const bz0 = b0 * g - 2 * g;
  const nx = Math.max(1, Math.ceil(((bw + 4) * g) / BUCKET));
  const nz = Math.max(1, Math.ceil(((bh + 4) * g) / BUCKET));
  const start = new Int32Array(nx * nz + 1);
  const range = (k: number, out: Int32Array): void => {
    const p = segs[k] * PT;
    const q = p + PT;
    const r = Math.max(ptsArr[p + P_RV], ptsArr[q + P_RV]) + LOD_MARGIN;
    out[0] = Math.max(0, Math.floor((Math.min(ptsArr[p], ptsArr[q]) - r - bx0) / BUCKET));
    out[1] = Math.min(nx - 1, Math.floor((Math.max(ptsArr[p], ptsArr[q]) + r - bx0) / BUCKET));
    out[2] = Math.max(0, Math.floor((Math.min(ptsArr[p + 1], ptsArr[q + 1]) - r - bz0) / BUCKET));
    out[3] = Math.min(nz - 1, Math.floor((Math.max(ptsArr[p + 1], ptsArr[q + 1]) + r - bz0) / BUCKET));
  };
  const rr = new Int32Array(4);
  for (let k = 0; k < segs.length; k++) {
    range(k, rr);
    for (let y = rr[2]; y <= rr[3]; y++) for (let x = rr[0]; x <= rr[1]; x++) start[y * nx + x + 1]++;
  }
  for (let k = 0; k < nx * nz; k++) start[k + 1] += start[k];
  const items = new Int32Array(start[nx * nz]);
  const fill = start.slice(0, nx * nz);
  for (let k = 0; k < segs.length; k++) {
    range(k, rr);
    for (let y = rr[2]; y <= rr[3]; y++) for (let x = rr[0]; x <= rr[1]; x++) items[fill[y * nx + x]++] = k;
  }

  return {
    i,
    j,
    land: true,
    g,
    a0,
    b0,
    bw,
    bh,
    index,
    n,
    ga,
    gb,
    kind,
    L,
    uplift,
    height,
    water,
    area,
    slope,
    receiver,
    basin,
    strahler,
    lake,
    dRiver,
    lakes,
    pts: ptsArr,
    segs,
    bucket: { x0: bx0, z0: bz0, size: BUCKET, nx, nz, start, items },
    stats: {
      ms: performance.now() - t0,
      nodes: n,
      land: landCount,
      outlets,
      riverNodes,
      reaches,
      maxOrder,
      lakes: lakes.length,
      riverKm,
      maxArea,
    },
  };
}

const tmp2 = new Float64Array(2);

/** Centripetal Catmull–Rom (Barry–Goldman) between P1 and P2 at t ∈ [0, 1]. */
function catmullRom(x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, x3: number, z3: number, t: number, out: Float64Array): void {
  const k01 = Math.sqrt(Math.max(1e-9, Math.hypot(x1 - x0, z1 - z0)));
  const k12 = Math.sqrt(Math.max(1e-9, Math.hypot(x2 - x1, z2 - z1)));
  const k23 = Math.sqrt(Math.max(1e-9, Math.hypot(x3 - x2, z3 - z2)));
  const t0 = 0;
  const t1 = k01;
  const t2 = t1 + k12;
  const t3 = t2 + k23;
  const u = t1 + (t2 - t1) * t;
  const a1x = ((t1 - u) * x0 + (u - t0) * x1) / (t1 - t0);
  const a1z = ((t1 - u) * z0 + (u - t0) * z1) / (t1 - t0);
  const a2x = ((t2 - u) * x1 + (u - t1) * x2) / (t2 - t1);
  const a2z = ((t2 - u) * z1 + (u - t1) * z2) / (t2 - t1);
  const a3x = ((t3 - u) * x2 + (u - t2) * x3) / (t3 - t2);
  const a3z = ((t3 - u) * z2 + (u - t2) * z3) / (t3 - t2);
  const b1x = ((t2 - u) * a1x + (u - t0) * a2x) / (t2 - t0);
  const b1z = ((t2 - u) * a1z + (u - t0) * a2z) / (t2 - t0);
  const b2x = ((t3 - u) * a2x + (u - t1) * a3x) / (t3 - t1);
  const b2z = ((t3 - u) * a2z + (u - t1) * a3z) / (t3 - t1);
  out[0] = ((t2 - u) * b1x + (u - t1) * b2x) / (t2 - t1);
  out[1] = ((t2 - u) * b1z + (u - t1) * b2z) / (t2 - t1);
}
