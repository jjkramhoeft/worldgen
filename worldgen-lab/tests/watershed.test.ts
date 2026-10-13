import { describe, expect, it } from 'vitest';
import { defaultSettings, defaultWatershed, WATERSHED_PRESETS, type WatershedSettings } from '../src/gen/settings';
import { WatershedGenerator } from '../src/gen/watershed/watershedGen';
import {
  buildRegion,
  FLAG_IN_LAKE,
  FLAG_RIVER,
  KIND_OUTLET,
  KIND_SEA,
  PT,
  P_FLAG,
  P_FLOOD,
  P_S,
  P_W,
  P_WIDTH,
  P_X,
  P_Z,
  type RegionNetwork,
} from '../src/gen/watershed/network';
import { Rng } from '../src/core/rng';

/** The land region nearest the origin, for a seed and settings. */
function landRegion(seed: string, s: WatershedSettings = defaultWatershed()) {
  const gen = new WatershedGenerator(seed, s);
  const [sx, sz] = gen.nearestLand(0, 0);
  const R = gen.fields.lattice.R;
  const i = Math.floor(sx / R);
  const j = Math.floor(sz / R);
  return { gen, i, j, net: gen.region(i, j), sx, sz };
}

const base = landRegion(defaultSettings().seed);

/** Largest step between samples 5 cm apart along random lines, then bisected (as in terrain.test.ts). */
function continuity(height: (x: number, z: number) => number, cx: number, cz: number, span: number, lines = 30, steps = 400, dx = 0.05) {
  const rng = new Rng(7);
  let worst = 0;
  let at = [0, 0, 0, 0];
  for (let l = 0; l < lines; l++) {
    const x0 = cx + rng.range(-span, span);
    const z0 = cz + rng.range(-span, span);
    const a = rng.range(0, Math.PI * 2);
    const ca = Math.cos(a) * dx;
    const sa = Math.sin(a) * dx;
    let prev = height(x0, z0);
    for (let i = 1; i < steps; i++) {
      const h = height(x0 + ca * i, z0 + sa * i);
      if (Math.abs(h - prev) > worst) {
        worst = Math.abs(h - prev);
        at = [x0 + ca * (i - 1), z0 + sa * (i - 1), x0 + ca * i, z0 + sa * i];
      }
      prev = h;
    }
  }
  let [ax, az, bx, bz] = at;
  for (let d = 0; d < 24; d++) {
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const ha = height(ax, az);
    const hm = height(mx, mz);
    const hb = height(bx, bz);
    if (Math.abs(hm - ha) > Math.abs(hb - hm)) {
      bx = mx;
      bz = mz;
    } else {
      ax = mx;
      az = mz;
    }
  }
  return { worst, residual: Math.abs(height(bx, bz) - height(ax, az)) };
}

function segmentsOf(net: RegionNetwork, flag?: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < net.segs.length; k++) {
    const p = net.segs[k] * PT;
    if (flag === undefined || net.pts[p + P_FLAG] === flag) out.push(p);
  }
  return out;
}

describe('watershed regions', () => {
  it('builds a continent with a real river network', () => {
    const st = base.net.stats;
    console.log('region', base.i, base.j, JSON.stringify(st));
    expect(base.net.land).toBe(true);
    expect(st.land).toBeGreaterThan(5000);
    expect(st.riverNodes).toBeGreaterThan(200);
    expect(st.maxOrder).toBeGreaterThanOrEqual(3);
    expect(st.lakes).toBeGreaterThanOrEqual(1);
    let hmax = 0;
    for (let k = 0; k < base.net.n; k++) hmax = Math.max(hmax, base.net.height[k]);
    // Relief from the stream power profile: hills, not a plain and not the Himalaya.
    expect(hmax).toBeGreaterThan(150);
    expect(hmax).toBeLessThan(1500);
  });

  it('is deterministic, independent of build order, and seed dependent', () => {
    const a = buildRegion(base.gen.fields, base.i, base.j);
    const fresh = new WatershedGenerator(defaultSettings().seed, defaultWatershed());
    fresh.region(base.i + 1, base.j);
    fresh.region(base.i, base.j - 1);
    const b = fresh.region(base.i, base.j);
    expect(b.n).toBe(a.n);
    expect(Array.from(b.height)).toEqual(Array.from(a.height));
    expect(Array.from(b.receiver)).toEqual(Array.from(a.receiver));
    expect(Array.from(b.pts)).toEqual(Array.from(a.pts));
    const other = landRegion('another-seed');
    expect(other.net.n === a.n && other.net.stats.riverNodes === a.stats.riverNodes).toBe(false);
  });

  it('G1: every land node drains to an outlet without cycles', () => {
    const net = base.net;
    let unreached = 0;
    for (let m = 0; m < net.n; m++) {
      if (net.kind[m] === KIND_SEA) continue;
      let c = m;
      let steps = 0;
      while (net.receiver[c] >= 0 && steps <= net.n) {
        c = net.receiver[c];
        steps++;
      }
      if (net.kind[c] !== KIND_OUTLET) unreached++;
    }
    expect(unreached).toBe(0);
  });

  it('G2: every node is higher than its receiver; lake beds lie below their lake', () => {
    const net = base.net;
    const beach = defaultWatershed().coast.beach;
    let bad = 0;
    for (let m = 0; m < net.n; m++) {
      const r = net.receiver[m];
      if (net.kind[m] === KIND_SEA || r < 0) continue;
      if (net.lake[m] >= 0) {
        if (!(net.height[m] < net.lakes[net.lake[m]].level + beach)) bad++;
      } else if (!(net.height[m] > net.height[r])) bad++;
    }
    expect(bad).toBe(0);
    for (const l of net.lakes) {
      expect(net.lake[l.sill]).toBe(-1);
      expect(net.height[l.sill]).toBeGreaterThan(net.height[net.receiver[l.sill]]);
    }
  });

  it('G3: water never rises downstream and strictly falls along rivers', () => {
    const net = base.net;
    const sea = defaultWatershed().seaLevel;
    let rising = 0;
    let flat = 0;
    for (const p of segmentsOf(net)) {
      const w0 = net.pts[p + P_W];
      const w1 = net.pts[p + PT + P_W];
      if (w1 > w0 + 1e-4) rising++;
      if (net.pts[p + P_FLAG] === FLAG_RIVER && w0 > sea + 0.01 && !(w1 < w0)) flat++;
    }
    expect(rising).toBe(0);
    expect(flat).toBe(0);
    expect(segmentsOf(net, FLAG_IN_LAKE).length).toBe(0);
  });

  it('G4: rivers never cross (no two diagonal tree edges in one grid cell)', () => {
    const net = base.net;
    let crossings = 0;
    for (let m = 0; m < net.n; m++) {
      const r = net.receiver[m];
      if (r < 0 || net.ga[m] === net.ga[r] || net.gb[m] === net.gb[r]) continue;
      const idx = (a: number, b: number) => {
        const x = a - net.a0;
        const y = b - net.b0;
        return x < 0 || y < 0 || x >= net.bw || y >= net.bh ? -1 : net.index[y * net.bw + x];
      };
      const q1 = idx(net.ga[m], net.gb[r]);
      const q2 = idx(net.ga[r], net.gb[m]);
      if (q1 >= 0 && q2 >= 0 && (net.receiver[q1] === q2 || net.receiver[q2] === q1)) crossings++;
    }
    expect(crossings).toBe(0);
  });

  it('every preset builds a consistent network', () => {
    for (const preset of WATERSHED_PRESETS) {
      const s = defaultSettings();
      preset.apply(s);
      const { net } = landRegion(s.seed, s.watershed);
      let bad = 0;
      for (let m = 0; m < net.n; m++) {
        const r = net.receiver[m];
        if (r >= 0 && net.lake[m] < 0 && !(net.height[m] > net.height[r])) bad++;
      }
      expect(bad, preset.name).toBe(0);
      expect(net.stats.riverNodes, preset.name).toBeGreaterThan(0);
    }
  });
});

describe('watershed surface', () => {
  const gen = base.gen;
  const net = base.net;
  const s = defaultWatershed();

  it('G5: river banks stand above the water', () => {
    // Sample both floodplain edges at the middle of ordinary river segments.
    const rng = new Rng(3);
    const segs = segmentsOf(net, FLAG_RIVER);
    let checked = 0;
    let low = 0;
    for (let k = 0; k < 400; k++) {
      const p = segs[Math.floor(rng.next() * segs.length)];
      const x0 = net.pts[p + P_X];
      const z0 = net.pts[p + P_Z];
      const x1 = net.pts[p + PT + P_X];
      const z1 = net.pts[p + PT + P_Z];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1 || net.pts[p + P_S] < 300) continue;
      const nx = -(z1 - z0) / len;
      const nz = (x1 - x0) / len;
      // Floodplain half-width and water level at the segment's midpoint (they vary along the river).
      const F = (net.pts[p + P_FLOOD] + net.pts[p + PT + P_FLOOD]) / 2;
      const w = (net.pts[p + P_W] + net.pts[p + PT + P_W]) / 2;
      for (const side of [-1, 1]) {
        const x = (x0 + x1) / 2 + nx * F * side;
        const z = (z0 + z1) / 2 + nz * F * side;
        const smp = gen.sample(x, z, gen.createSample());
        if (!smp.land || smp.L < 400 || smp.lake >= 0) continue;
        // Another river's channel may cut here; only judge points this river owns.
        if (Math.abs(smp.dRiver - F) > 2) continue;
        checked++;
        if (smp.height < w + 0.9 * s.rivers.bank) low++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(low / checked).toBeLessThan(0.02);
  });

  it('G6: the surface is continuous, across rivers, coasts and region borders', () => {
    const h = (x: number, z: number) => gen.height(x, z);
    // Around the continent's centre (rivers, lakes) …
    const inner = continuity(h, base.sx, base.sz, 15000);
    expect(inner.residual).toBeLessThan(1e-3);
    // … and across the coast and the region border to the east.
    const lat = gen.fields.lattice;
    const ex = lat.siteX(base.i + 1, base.j);
    const ez = lat.siteZ(base.i + 1, base.j);
    const outer = continuity(h, (base.sx + ex) / 2, (base.sz + ez) / 2, 8000);
    expect(outer.residual).toBeLessThan(1e-3);
  });

  it('G7: water levels and the river network do not depend on the level of detail', () => {
    const rng = new Rng(11);
    const segs = segmentsOf(net, FLAG_RIVER);
    let compared = 0;
    for (let k = 0; k < 300; k++) {
      const p = segs[Math.floor(rng.next() * segs.length)];
      const x = (net.pts[p + P_X] + net.pts[p + PT + P_X]) / 2;
      const z = (net.pts[p + P_Z] + net.pts[p + PT + P_Z]) / 2;
      const fine = gen.sample(x, z, gen.createSample(), 0);
      const coarse = gen.sample(x, z, gen.createSample(), 8);
      if (Number.isNaN(fine.water) || Number.isNaN(coarse.water)) continue;
      compared++;
      expect(coarse.water).toBeCloseTo(fine.water, 6);
    }
    expect(compared).toBeGreaterThan(200);
  });

  it('keeps every continent inside its region, with open sea at the borders', () => {
    const lat = gen.fields.lattice;
    const rng = new Rng(5);
    const hit = { i: 0, j: 0, sx: 0, sz: 0, wx: 0, wz: 0, b: 0, L: 0, land: false };
    let nearBorder = 0;
    for (let k = 0; k < 20000; k++) {
      lat.locate(base.sx + rng.range(-60000, 60000), base.sz + rng.range(-60000, 60000), hit);
      if (hit.b < s.coast.margin) {
        nearBorder++;
        expect(hit.L).toBeLessThan(0);
      }
    }
    expect(nearBorder).toBeGreaterThan(100);
  });

  it('rivers and lakes have their own water above sea level', () => {
    let river = 0;
    let lake = 0;
    for (const p of segmentsOf(net, FLAG_RIVER)) {
      if (net.pts[p + P_W] > 20 && net.pts[p + P_WIDTH] > 3 && river < 50) {
        const smp = gen.sample(net.pts[p + P_X], net.pts[p + P_Z], gen.createSample());
        if (!Number.isNaN(smp.water) && smp.water > 20) river++;
      }
    }
    for (const l of net.lakes) {
      const smp = gen.sample(l.x, l.z, gen.createSample());
      if (Math.abs(smp.water - l.level) < 1e-6 || smp.lake >= 0) lake++;
    }
    expect(river).toBeGreaterThan(30);
    expect(lake).toBeGreaterThan(0);
  });

  it('logs the build and sampling speed', () => {
    const t0 = performance.now();
    buildRegion(gen.fields, base.i, base.j);
    const build = performance.now() - t0;
    const smp = gen.createSample();
    const t1 = performance.now();
    for (let k = 0; k < 20000; k++) gen.sample(base.sx + (k % 141) * 31, base.sz + Math.floor(k / 141) * 31, smp, 1);
    console.log(`region build ${build.toFixed(0)} ms · ${(((performance.now() - t1) * 1000) / 20000).toFixed(2)} µs per sample`);
  });
});
